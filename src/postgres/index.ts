import { parseConversationEvent, type ConversationEvent, type ConversationId, type ConversationRevision } from "../conversation/events.js";
import {
  ConversationEventStoreConflictError,
  type AppendConversationEventsInput, type AppendConversationEventsResult,
  type ConversationEventCheckpoint, type ConversationEventCursor, type ConversationEventStore,
  type ReadConversationEventsInput, type ReadConversationEventsResult,
  type StoredConversationEvent, type WriteConversationEventCheckpointResult,
} from "../conversation/event-store.js";
import {
  ManagedRuntimeTurnStateStoreConflictError,
  parseManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateStore,
} from "../transports/managed-runtime-state.js";
import {
  CONVERSATION_SYNC_STATE_SCHEMA_VERSION,
  ConversationSyncStateStoreConflictError,
  type ConversationSyncStateRecord,
  type ConversationSyncStateStore,
  type SaveConversationSyncStateInput,
} from "../sync/persistence.js";
import type { ApplicationToolResult } from "../protocol.js";
import type { ToolExecutionLedger } from "../tools/executor.js";
import {
  ConversationCatalogError, createConversationCatalogCursor,
  parseArchiveConversationInput, parseClearConversationInput, parseCreateConversationInput,
  parseGetConversationInput, parseListConversationsInput, parsePermanentlyDeleteConversationInput,
  parseRenameConversationInput, parseRestoreConversationInput,
  type ActiveConversationCatalogDescriptor, type ArchiveConversationResult,
  type ArchivedConversationCatalogDescriptor, type ClearConversationResult,
  type ConversationCatalog, type ConversationCatalogAuthorizer, type ConversationCatalogDescriptor,
  type ConversationCatalogVersion, type CreateConversationResult, type GetConversationResult,
  type ListConversationsResult, type PermanentlyDeleteConversationResult,
  type RenameConversationResult, type RestoreConversationResult,
} from "../conversation/catalog.js";
import type { ConversationTimestamp } from "../conversation/events.js";

export const POSTGRES_PERSISTENCE_SCHEMA_VERSION = 1 as const;

export interface PostgresQueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly TRow[];
  readonly rowCount: number;
}

/** Compatible with pg and other drivers through a tiny application-owned wrapper. */
export interface PostgresSqlClient {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PostgresQueryResult<TRow>>;
  transaction<T>(operation: (client: PostgresSqlClient) => Promise<T>): Promise<T>;
}

export const handrailPostgresSchemaV1 = Object.freeze([
  `CREATE TABLE IF NOT EXISTS handrail_ai_events (tenant_id text NOT NULL, conversation_id text NOT NULL, revision bigint NOT NULL, event_id text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, conversation_id, revision), UNIQUE (tenant_id, event_id))`,
  `ALTER TABLE handrail_ai_events ADD COLUMN IF NOT EXISTS mutation_id text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS handrail_ai_events_mutation ON handrail_ai_events (tenant_id, mutation_id) WHERE mutation_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_documents (tenant_id text NOT NULL, kind text NOT NULL, scope_id text NOT NULL, record_id text NOT NULL, version bigint NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, kind, scope_id, record_id))`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_documents_scope ON handrail_ai_documents (tenant_id, kind, scope_id, updated_at DESC, record_id)`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_tool_ledger (tenant_id text NOT NULL, tool_call_id text NOT NULL, status text NOT NULL CHECK (status IN ('completed')), result jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, tool_call_id))`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_idempotency (tenant_id text NOT NULL, domain text NOT NULL, scope_id text NOT NULL, idempotency_key text NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, domain, scope_id, idempotency_key))`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_conversations (tenant_id text NOT NULL, scope_id text NOT NULL, conversation_id text NOT NULL, lifecycle text NOT NULL CHECK (lifecycle IN ('active','archived')), title text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, archived_at timestamptz, version bigint NOT NULL, metadata jsonb NOT NULL, PRIMARY KEY (tenant_id, scope_id, conversation_id))`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_conversations_updated ON handrail_ai_conversations (tenant_id, scope_id, lifecycle, updated_at DESC, conversation_id)`,
] as const);

export type PostgresDocumentKind = "checkpoint" | "catalog" | "approval" | "turn_state" | "sync_state";

export interface PostgresVersionedDocument<T = unknown> {
  readonly tenantId: string;
  readonly kind: PostgresDocumentKind;
  readonly scopeId: string;
  readonly recordId: string;
  readonly version: number;
  readonly value: T;
}

export class PostgresPersistenceConflictError extends Error {
  readonly code = "version_conflict" as const;
  constructor() { super("The durable record version conflicts with current state."); this.name = "PostgresPersistenceConflictError"; }
}

export interface AppendPostgresEventsInput<TEvent extends { readonly event_id: string; readonly revision: number }> {
  readonly tenantId: string;
  readonly conversationId: string;
  readonly expectedRevision: number | null;
  readonly events: readonly TEvent[];
}

function id(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.includes("\0")) throw new TypeError(`${field} is invalid`);
  return value;
}

function version(value: number | null, field: string): number | null {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new TypeError(`${field} is invalid`);
  return value;
}

function jsonClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/**
 * Reference Postgres persistence used to build existing high-level store
 * contracts. Tenant scope is mandatory in every key and query. Atomic CAS,
 * append, and tool-ledger methods preserve authorization/idempotency seams.
 */
export class PostgresAiPersistence {
  constructor(readonly client: PostgresSqlClient) {}

  async migrate(): Promise<void> { for (const statement of handrailPostgresSchemaV1) await this.client.query(statement); }

  async appendEvents<TEvent extends { readonly event_id: string; readonly revision: number }>(input: AppendPostgresEventsInput<TEvent>): Promise<readonly TEvent[]> {
    if (input.events.length === 0) throw new TypeError("events must not be empty");
    const tenant = id(input.tenantId, "tenantId"), conversation = id(input.conversationId, "conversationId");
    const expected = version(input.expectedRevision, "expectedRevision");
    return this.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenant}\0${conversation}`]);
      const latest = await tx.query<{ revision: string }>("SELECT revision::text AS revision FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY revision DESC LIMIT 1", [tenant, conversation]);
      const actual = latest.rows[0] ? Number(latest.rows[0].revision) : null;
      if (actual !== expected) throw new PostgresPersistenceConflictError();
      let next = (expected ?? 0) + 1;
      for (const event of input.events) {
        if (event.revision !== next++) throw new TypeError("event revisions must be contiguous");
        await tx.query("INSERT INTO handrail_ai_events (tenant_id,conversation_id,revision,event_id,payload) VALUES ($1,$2,$3,$4,$5::jsonb)", [tenant, conversation, event.revision, id(event.event_id, "event_id"), JSON.stringify(event)]);
      }
      return Object.freeze(input.events.map(jsonClone));
    });
  }

  async readEvents<TEvent>(tenantId: string, conversationId: string, afterRevision = 0, limit = 100): Promise<readonly TEvent[]> {
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("event read bounds are invalid");
    const result = await this.client.query<{ payload: TEvent }>("SELECT payload FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2 AND revision>$3 ORDER BY revision LIMIT $4", [id(tenantId, "tenantId"), id(conversationId, "conversationId"), afterRevision, limit]);
    return Object.freeze(result.rows.map((row) => jsonClone(row.payload)));
  }

  async getDocument<T>(tenantId: string, kind: PostgresDocumentKind, scopeId: string, recordId: string): Promise<PostgresVersionedDocument<T> | null> {
    const result = await this.client.query<{ version: string; payload: T }>("SELECT version::text AS version,payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind=$2 AND scope_id=$3 AND record_id=$4", [id(tenantId, "tenantId"), kind, id(scopeId, "scopeId"), id(recordId, "recordId")]);
    const row = result.rows[0];
    return row ? Object.freeze({ tenantId, kind, scopeId, recordId, version: Number(row.version), value: jsonClone(row.payload) }) : null;
  }

  readCheckpoint<T>(tenantId: string, conversationId: string) {
    return this.getDocument<T>(tenantId, "checkpoint", conversationId, "latest");
  }

  writeCheckpoint<T>(tenantId: string, conversationId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "checkpoint", scopeId: conversationId, recordId: "latest", expectedVersion, value });
  }

  readCatalogDescriptor<T>(tenantId: string, ownerScopeId: string, conversationId: string) {
    return this.getDocument<T>(tenantId, "catalog", ownerScopeId, conversationId);
  }

  writeCatalogDescriptor<T>(tenantId: string, ownerScopeId: string, conversationId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "catalog", scopeId: ownerScopeId, recordId: conversationId, expectedVersion, value });
  }

  readApprovalProposal<T>(tenantId: string, conversationId: string, proposalId: string) {
    return this.getDocument<T>(tenantId, "approval", conversationId, proposalId);
  }

  writeApprovalProposal<T>(tenantId: string, conversationId: string, proposalId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "approval", scopeId: conversationId, recordId: proposalId, expectedVersion, value });
  }

  readTurnState<T>(tenantId: string, conversationId: string, turnId: string) {
    return this.getDocument<T>(tenantId, "turn_state", conversationId, turnId);
  }

  writeTurnState<T>(tenantId: string, conversationId: string, turnId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "turn_state", scopeId: conversationId, recordId: turnId, expectedVersion, value });
  }

  readSyncState<T>(tenantId: string, conversationId: string, deviceId: string) {
    return this.getDocument<T>(tenantId, "sync_state", conversationId, deviceId);
  }

  writeSyncState<T>(tenantId: string, conversationId: string, deviceId: string, expectedVersion: number | null, value: T) {
    return this.compareAndSetDocument({ tenantId, kind: "sync_state", scopeId: conversationId, recordId: deviceId, expectedVersion, value });
  }

  async compareAndSetDocument<T>(input: Omit<PostgresVersionedDocument<T>, "version"> & { readonly expectedVersion: number | null }): Promise<PostgresVersionedDocument<T>> {
    const tenant = id(input.tenantId, "tenantId"), scope = id(input.scopeId, "scopeId"), record = id(input.recordId, "recordId");
    const expected = version(input.expectedVersion, "expectedVersion");
    return this.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenant}\0${input.kind}\0${scope}\0${record}`]);
      const current = await tx.query<{ version: string }>("SELECT version::text AS version FROM handrail_ai_documents WHERE tenant_id=$1 AND kind=$2 AND scope_id=$3 AND record_id=$4", [tenant, input.kind, scope, record]);
      const actual = current.rows[0] ? Number(current.rows[0].version) : null;
      if (actual !== expected) throw new PostgresPersistenceConflictError();
      const next = (actual ?? 0) + 1;
      await tx.query("INSERT INTO handrail_ai_documents (tenant_id,kind,scope_id,record_id,version,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (tenant_id,kind,scope_id,record_id) DO UPDATE SET version=EXCLUDED.version,payload=EXCLUDED.payload,updated_at=now()", [tenant, input.kind, scope, record, next, JSON.stringify(input.value)]);
      return Object.freeze({ tenantId: tenant, kind: input.kind, scopeId: scope, recordId: record, version: next, value: jsonClone(input.value) });
    });
  }

  async listDocuments<T>(tenantId: string, kind: PostgresDocumentKind, scopeId: string, limit = 100): Promise<readonly PostgresVersionedDocument<T>[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit is invalid");
    const tenant = id(tenantId, "tenantId"), scope = id(scopeId, "scopeId");
    const result = await this.client.query<{ record_id: string; version: string; payload: T }>("SELECT record_id,version::text AS version,payload FROM handrail_ai_documents WHERE tenant_id=$1 AND kind=$2 AND scope_id=$3 ORDER BY updated_at DESC,record_id LIMIT $4", [tenant, kind, scope, limit]);
    return Object.freeze(result.rows.map((row) => Object.freeze({ tenantId: tenant, kind, scopeId: scope, recordId: row.record_id, version: Number(row.version), value: jsonClone(row.payload) })));
  }

  async getOrExecuteTool<T>(tenantId: string, toolCallId: string, execute: () => Promise<T>): Promise<T> {
    const tenant = id(tenantId, "tenantId"), call = id(toolCallId, "toolCallId");
    return this.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenant}\0tool\0${call}`]);
      const existing = await tx.query<{ result: T }>("SELECT result FROM handrail_ai_tool_ledger WHERE tenant_id=$1 AND tool_call_id=$2", [tenant, call]);
      if (existing.rows[0]) return jsonClone(existing.rows[0].result);
      const result = await execute();
      await tx.query("INSERT INTO handrail_ai_tool_ledger (tenant_id,tool_call_id,status,result) VALUES ($1,$2,'completed',$3::jsonb)", [tenant, call, JSON.stringify(result)]);
      return jsonClone(result);
    });
  }

  async getToolResult<T>(tenantId: string, toolCallId: string): Promise<T | null> {
    const result = await this.client.query<{ result: T }>(
      "SELECT result FROM handrail_ai_tool_ledger WHERE tenant_id=$1 AND tool_call_id=$2",
      [id(tenantId, "tenantId"), id(toolCallId, "toolCallId")],
    );
    return result.rows[0] ? jsonClone(result.rows[0].result) : null;
  }

  async getOrCreateIdempotent<T>(input: { readonly tenantId: string; readonly domain: string; readonly scopeId: string;
    readonly idempotencyKey: string; readonly fingerprint: string; readonly execute: (client: PostgresSqlClient) => Promise<T> }): Promise<{ readonly status: "created" | "idempotent"; readonly value: T }> {
    const tenant = id(input.tenantId, "tenantId"), domain = id(input.domain, "domain"), scope = id(input.scopeId, "scopeId");
    const key = id(input.idempotencyKey, "idempotencyKey"), fingerprint = id(input.fingerprint, "fingerprint");
    return this.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${tenant}\0idempotency\0${domain}\0${scope}\0${key}`]);
      const existing = await tx.query<{ fingerprint: string; result: T }>(
        "SELECT fingerprint,result FROM handrail_ai_idempotency WHERE tenant_id=$1 AND domain=$2 AND scope_id=$3 AND idempotency_key=$4",
        [tenant, domain, scope, key],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== fingerprint) throw new PostgresPersistenceConflictError();
        return { status: "idempotent" as const, value: jsonClone(existing.rows[0].result) };
      }
      const value = await input.execute(tx);
      await tx.query("INSERT INTO handrail_ai_idempotency (tenant_id,domain,scope_id,idempotency_key,fingerprint,result) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
        [tenant, domain, scope, key, fingerprint, JSON.stringify(value)]);
      return { status: "created" as const, value: jsonClone(value) };
    });
  }

  async deleteDocument(input: { readonly tenantId: string; readonly kind: PostgresDocumentKind; readonly scopeId: string;
    readonly recordId: string; readonly expectedVersion: number }): Promise<boolean> {
    const result = await this.client.query(
      "DELETE FROM handrail_ai_documents WHERE tenant_id=$1 AND kind=$2 AND scope_id=$3 AND record_id=$4 AND version=$5",
      [id(input.tenantId, "tenantId"), input.kind, id(input.scopeId, "scopeId"), id(input.recordId, "recordId"), input.expectedVersion],
    );
    return result.rowCount === 1;
  }
}

/** Durable high-level replay store scoped to one already-authorized tenant. */
export class PostgresManagedRuntimeTurnStateStore implements ManagedRuntimeTurnStateStore {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string) {
    id(tenantId, "tenantId");
  }

  async load(conversationId: string, turnId: string): Promise<ManagedRuntimeTurnStateRecord | null> {
    const document = await this.persistence.readTurnState<ManagedRuntimeTurnStateRecord>(this.tenantId, conversationId, turnId);
    return document ? parseManagedRuntimeTurnStateRecord(document.value) : null;
  }

  async save(value: ManagedRuntimeTurnStateRecord): Promise<ManagedRuntimeTurnStateRecord> {
    const record = parseManagedRuntimeTurnStateRecord(value);
    const existing = await this.persistence.readTurnState<ManagedRuntimeTurnStateRecord>(this.tenantId, record.conversationId, record.turnId);
    if (existing) {
      const stored = parseManagedRuntimeTurnStateRecord(existing.value);
      if (JSON.stringify(stored) === JSON.stringify(record)) return stored;
      throw new ManagedRuntimeTurnStateStoreConflictError("The replay identity conflicts with durable state.", {
        code: "replay_identity_conflict", conversationId: record.conversationId, turnId: record.turnId,
      });
    }
    try {
      const saved = await this.persistence.writeTurnState(this.tenantId, record.conversationId, record.turnId, null, record);
      return parseManagedRuntimeTurnStateRecord(saved.value);
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const winner = await this.load(record.conversationId, record.turnId);
      if (winner && JSON.stringify(winner) === JSON.stringify(record)) return winner;
      throw new ManagedRuntimeTurnStateStoreConflictError("The replay identity conflicts with durable state.", {
        code: "replay_identity_conflict", conversationId: record.conversationId, turnId: record.turnId,
      });
    }
  }
}

/** Atomic Postgres implementation of the cross-device sync baseline contract. */
export class PostgresConversationSyncStateStore implements ConversationSyncStateStore {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string) {
    id(tenantId, "tenantId");
  }

  async load(conversationId: ConversationId): Promise<ConversationSyncStateRecord | null> {
    const document = await this.persistence.readSyncState<ConversationSyncStateRecord>(this.tenantId, conversationId, "latest");
    if (!document) return null;
    const record = jsonClone(document.value);
    if (record.schemaVersion !== CONVERSATION_SYNC_STATE_SCHEMA_VERSION || record.conversationId !== conversationId ||
      record.generation !== document.version) throw new TypeError("Postgres sync state is invalid");
    return record;
  }

  async save(input: SaveConversationSyncStateInput): Promise<ConversationSyncStateRecord> {
    const generation = (input.expectedGeneration ?? 0) + 1;
    const record: ConversationSyncStateRecord = jsonClone({ ...input.record, generation });
    try {
      const saved = await this.persistence.writeSyncState(
        this.tenantId, record.conversationId, "latest", input.expectedGeneration, record,
      );
      return jsonClone(saved.value);
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      const actual = await this.persistence.readSyncState<ConversationSyncStateRecord>(this.tenantId, record.conversationId, "latest");
      throw new ConversationSyncStateStoreConflictError("The sync generation conflicts with durable state.", {
        code: "generation_conflict", conversationId: record.conversationId,
        expectedGeneration: input.expectedGeneration, actualGeneration: actual?.version ?? null,
      });
    }
  }
}

/** Postgres-backed exactly-once result ledger for bounded tool execution. */
export class PostgresToolExecutionLedger implements ToolExecutionLedger {
  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string) {
    id(tenantId, "tenantId");
  }

  getOrCreate(toolCallId: string, execute: () => Promise<ApplicationToolResult>): Promise<ApplicationToolResult> {
    return this.persistence.getOrExecuteTool(this.tenantId, toolCallId, execute);
  }
}

function eventCursor(conversationId: string, revision: number): ConversationEventCursor {
  return `handrail.pg-event.v1:${encodeURIComponent(conversationId)}:${revision}` as ConversationEventCursor;
}

function revisionFromCursor(cursor: ConversationEventCursor, conversationId: ConversationId): number {
  const match = /^handrail\.pg-event\.v1:([^:]+):(\d+)$/u.exec(cursor);
  if (!match || decodeURIComponent(match[1]!) !== conversationId) throw new ConversationEventStoreConflictError(
    "The event cursor does not belong to this conversation.", {
      code: "cursor_not_found", conversationId, expectedRevision: null,
      actualRevision: null, identifier: cursor,
    });
  return Number(match[2]);
}

function storedEvent(event: ConversationEvent): StoredConversationEvent {
  return Object.freeze({ cursor: eventCursor(event.conversation_id, event.revision), event: jsonClone(event) });
}

/** Tenant-scoped atomic event log and compact-checkpoint implementation. */
export class PostgresConversationEventStore implements ConversationEventStore {
  readonly checkpoints = {
    read: (conversationId: ConversationId) => this.readCheckpoint(conversationId),
    write: (checkpoint: ConversationEventCheckpoint) => this.writeCheckpoint(checkpoint),
  };

  constructor(readonly persistence: PostgresAiPersistence, readonly tenantId: string) { id(tenantId, "tenantId"); }

  async append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    if (input.events.length === 0) return this.appendConflict("invalid_append", input, null, null);
    const events = input.events.map((event) => parseConversationEvent(event));
    let expected = (input.expectedRevision ?? 0) + 1;
    if (events.some((event) => event.conversation_id !== input.conversationId || event.revision !== expected++)) {
      return this.appendConflict("invalid_append", input, null, null);
    }
    return this.persistence.client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${this.tenantId}\0${input.conversationId}`]);
      const identifiers = events.flatMap((event) => [event.event_id, ...(event.mutation_id ? [event.mutation_id] : [])]);
      const duplicates = await tx.query<{ payload: ConversationEvent }>(
        "SELECT payload FROM handrail_ai_events WHERE tenant_id=$1 AND (event_id=ANY($2::text[]) OR mutation_id=ANY($2::text[]))",
        [this.tenantId, identifiers],
      );
      if (duplicates.rows.length > 0) {
        const durable = duplicates.rows.map((row) => parseConversationEvent(row.payload));
        const complete = events.every((event) => durable.some((candidate) => JSON.stringify(candidate) === JSON.stringify(event)));
        if (complete && durable.length === events.length) {
          const latest = await this.latest(tx, input.conversationId);
          return Object.freeze({ status: "idempotent" as const, entries: Object.freeze(events.map(storedEvent)), latestRevision: latest! });
        }
        return this.appendConflict("idempotency_conflict", input,
          await this.latest(tx, input.conversationId), identifiers[0] ?? null);
      }
      const actual = await this.latest(tx, input.conversationId);
      if (actual !== input.expectedRevision) return this.appendConflict("revision_conflict", input, actual, null);
      for (const event of events) await tx.query(
        "INSERT INTO handrail_ai_events (tenant_id,conversation_id,revision,event_id,mutation_id,payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
        [this.tenantId, input.conversationId, event.revision, event.event_id, event.mutation_id ?? null, JSON.stringify(event)],
      );
      return Object.freeze({ status: "appended" as const, entries: Object.freeze(events.map(storedEvent)),
        latestRevision: events.at(-1)!.revision });
    });
  }

  async read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    const after = input.after?.cursor ? revisionFromCursor(input.after.cursor, input.conversationId)
      : input.after?.revision ?? 0;
    const limit = input.limit ?? 1_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError("Event read limit is invalid");
    return this.persistence.client.transaction(async (tx) => {
      const result = await tx.query<{ payload: ConversationEvent }>(
        "SELECT payload FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2 AND revision>$3 ORDER BY revision LIMIT $4",
        [this.tenantId, input.conversationId, after, limit + 1],
      );
      const entries = Object.freeze(result.rows.slice(0, limit).map((row) => storedEvent(parseConversationEvent(row.payload))));
      return Object.freeze({ entries, nextCursor: entries.at(-1)?.cursor ?? null,
        latestRevision: await this.latest(tx, input.conversationId), hasMore: result.rows.length > limit });
    });
  }

  getLatestRevision(conversationId: ConversationId): Promise<ConversationRevision | null> {
    return this.latest(this.persistence.client, conversationId);
  }

  private async latest(client: PostgresSqlClient, conversationId: ConversationId): Promise<ConversationRevision | null> {
    const result = await client.query<{ revision: string }>(
      "SELECT revision::text AS revision FROM handrail_ai_events WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY revision DESC LIMIT 1",
      [this.tenantId, conversationId],
    );
    return result.rows[0] ? Number(result.rows[0].revision) as ConversationRevision : null;
  }

  private appendConflict(code: "invalid_append" | "revision_conflict" | "idempotency_conflict",
    input: AppendConversationEventsInput, actualRevision: ConversationRevision | null, identifier: string | null): never {
    throw new ConversationEventStoreConflictError("The event append conflicts with durable state.", {
      code, conversationId: input.conversationId, expectedRevision: input.expectedRevision, actualRevision, identifier,
    });
  }

  private async readCheckpoint(conversationId: ConversationId): Promise<ConversationEventCheckpoint | null> {
    return (await this.persistence.readCheckpoint<ConversationEventCheckpoint>(this.tenantId, conversationId))?.value ?? null;
  }

  private async writeCheckpoint(checkpoint: ConversationEventCheckpoint): Promise<WriteConversationEventCheckpointResult> {
    const current = await this.persistence.readCheckpoint<ConversationEventCheckpoint>(this.tenantId, checkpoint.conversationId);
    if (current && JSON.stringify(current.value) === JSON.stringify(checkpoint)) return { status: "idempotent", checkpoint: jsonClone(checkpoint) };
    if (current && current.value.revision >= checkpoint.revision) throw new ConversationEventStoreConflictError(
      "The checkpoint conflicts with durable state.", { code: "checkpoint_conflict", conversationId: checkpoint.conversationId,
        expectedRevision: checkpoint.revision, actualRevision: current.value.revision, identifier: null });
    try {
      const saved = await this.persistence.writeCheckpoint(this.tenantId, checkpoint.conversationId, current?.version ?? null, checkpoint);
      return { status: "written", checkpoint: jsonClone(saved.value) };
    } catch (error) {
      if (!(error instanceof PostgresPersistenceConflictError)) throw error;
      throw new ConversationEventStoreConflictError("The checkpoint conflicts with durable state.", {
        code: "checkpoint_conflict", conversationId: checkpoint.conversationId,
        expectedRevision: checkpoint.revision, actualRevision: null, identifier: null,
      });
    }
  }
}
