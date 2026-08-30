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
  `CREATE TABLE IF NOT EXISTS handrail_ai_documents (tenant_id text NOT NULL, kind text NOT NULL, scope_id text NOT NULL, record_id text NOT NULL, version bigint NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, kind, scope_id, record_id))`,
  `CREATE INDEX IF NOT EXISTS handrail_ai_documents_scope ON handrail_ai_documents (tenant_id, kind, scope_id, updated_at DESC, record_id)`,
  `CREATE TABLE IF NOT EXISTS handrail_ai_tool_ledger (tenant_id text NOT NULL, tool_call_id text NOT NULL, status text NOT NULL CHECK (status IN ('completed')), result jsonb NOT NULL, completed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, tool_call_id))`,
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
}
