import {
  ConversationEventStoreConflictError,
  ConversationEventStoreUnavailableError,
  type AppendConversationEventsInput,
  type AppendConversationEventsResult,
  type ConversationEventCheckpoint,
  type ConversationEventCheckpointStore,
  type ConversationEventCursor,
  type ConversationEventStore,
  type ConversationEventStoreConflictCode,
  type ConversationEventStoreOperation,
  type ReadConversationEventsInput,
  type ReadConversationEventsResult,
  type StoredConversationEvent,
  type WriteConversationEventCheckpointResult,
} from "../conversation/event-store.js";
import {
  parseConversationEvent,
  type ConversationClientMutationId,
  type ConversationEvent,
  type ConversationEventId,
  type ConversationId,
  type ConversationRevision,
} from "../conversation/events.js";

export const INDEXEDDB_CONVERSATION_EVENT_STORE_SCHEMA_VERSION = 1;
export const DEFAULT_INDEXEDDB_CONVERSATION_EVENT_STORE_DATABASE_NAME =
  "handrail-ai";
export const DEFAULT_INDEXEDDB_CONVERSATION_EVENT_STORE_PREFIX =
  "conversation-";

export interface IndexedDBConversationEventStoreOptions {
  /** IndexedDB database name. Use a tenant/environment-specific value when needed. */
  readonly databaseName?: string;
  /** Prefix applied to this adapter's object stores within the database. */
  readonly storePrefix?: string;
  /** Optional factory injection for non-window runtimes and tests. */
  readonly indexedDB?: IDBFactory;
  /** Key-range constructor paired with an injected IndexedDB implementation. */
  readonly keyRange?: typeof IDBKeyRange;
}

interface StoredEventRow {
  readonly conversationId: ConversationId;
  readonly revision: ConversationRevision;
  readonly eventId: ConversationEventId;
  readonly mutationId?: ConversationClientMutationId;
  readonly cursor: ConversationEventCursor;
  readonly event: ConversationEvent;
}

interface StoredCheckpointRow extends ConversationEventCheckpoint {
  readonly conversationId: ConversationId;
}

interface ObjectStoreNames {
  readonly events: string;
  readonly checkpoints: string;
}

const EVENT_ID_INDEX = "eventId";
const MUTATION_ID_INDEX = "mutationId";
const CURSOR_INDEX = "cursor";

/**
 * Durable, opt-in browser implementation of ConversationEventStore.
 *
 * Browser globals are resolved lazily when an operation first opens the
 * database. Importing this module, or the core package, never reads window or
 * indexedDB. close() only releases this instance's connection; it never deletes
 * durable data.
 */
export class IndexedDBConversationEventStore implements ConversationEventStore {
  readonly checkpoints: ConversationEventCheckpointStore = {
    read: async (conversationId) => this.readCheckpoint(conversationId),
    write: async (checkpoint) => this.writeCheckpoint(checkpoint),
  };

  private readonly databaseName: string;
  private readonly storeNames: ObjectStoreNames;
  private readonly configuredFactory: IDBFactory | undefined;
  private readonly configuredKeyRange: typeof IDBKeyRange | undefined;
  private readonly cursorNamespace: string;
  private databasePromise: Promise<IDBDatabase> | undefined;
  private closed = false;

  constructor(options: IndexedDBConversationEventStoreOptions = {}) {
    this.databaseName =
      options.databaseName ??
      DEFAULT_INDEXEDDB_CONVERSATION_EVENT_STORE_DATABASE_NAME;
    const storePrefix =
      options.storePrefix ?? DEFAULT_INDEXEDDB_CONVERSATION_EVENT_STORE_PREFIX;

    if (this.databaseName.length === 0) {
      throw new TypeError("IndexedDB databaseName must not be empty.");
    }
    if (storePrefix.length === 0) {
      throw new TypeError("IndexedDB storePrefix must not be empty.");
    }

    this.storeNames = {
      events: `${storePrefix}events`,
      checkpoints: `${storePrefix}checkpoints`,
    };
    this.configuredFactory = options.indexedDB;
    this.configuredKeyRange = options.keyRange;
    this.cursorNamespace = `indexeddb:${encodeURIComponent(this.databaseName)}:${encodeURIComponent(storePrefix)}`;
  }

  async append(
    input: AppendConversationEventsInput,
  ): Promise<AppendConversationEventsResult> {
    return this.runTransaction(
      "append",
      [this.storeNames.events],
      "readwrite",
      async (transaction) => {
        const store = transaction.objectStore(this.storeNames.events);
        const actualRevision = await latestRevision(
          store,
          input.conversationId,
          this.getKeyRange("append"),
        );
        validateAppend(input, actualRevision);

        const matches: Array<StoredEventRow | null> = [];
        for (const event of input.events) {
          matches.push(await findIdempotentMatch(store, event));
        }

        const matchedCount = matches.filter((match) => match !== null).length;
        if (matchedCount > 0) {
          if (matchedCount !== input.events.length) {
            throw appendConflict(
              "idempotency_conflict",
              input,
              actualRevision,
              "Only part of the atomic batch is already stored.",
            );
          }

          const matchedRows = matches as StoredEventRow[];
          validateCompleteRetry(input, matchedRows, actualRevision);
          return appendResult(
            "idempotent",
            matchedRows.map(rowToEntry),
            actualRevision!,
          );
        }

        if (input.expectedRevision !== actualRevision) {
          throw appendConflict(
            "revision_conflict",
            input,
            actualRevision,
            "The expected revision does not match the latest stored revision.",
          );
        }

        const rows = input.events.map((event) => {
          const storedEvent = cloneJson(event);
          return {
            conversationId: input.conversationId,
            revision: storedEvent.revision,
            eventId: storedEvent.event_id,
            ...(storedEvent.mutation_id === undefined
              ? {}
              : { mutationId: storedEvent.mutation_id }),
            cursor: this.cursor(input.conversationId, storedEvent.revision),
            event: storedEvent,
          } satisfies StoredEventRow;
        });

        for (const row of rows) {
          await requestResult(store.add(row));
        }

        return appendResult(
          "appended",
          rows.map(rowToEntry),
          rows.at(-1)!.revision,
        );
      },
    );
  }

  async read(
    input: ReadConversationEventsInput,
  ): Promise<ReadConversationEventsResult> {
    if (
      input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) || input.limit <= 0)
    ) {
      throw new RangeError(
        "Conversation event read limit must be a positive safe integer.",
      );
    }

    return this.runTransaction(
      "read",
      [this.storeNames.events],
      "readonly",
      async (transaction) => {
        const store = transaction.objectStore(this.storeNames.events);
        const keyRange = this.getKeyRange("read");
        const currentRevision = await latestRevision(
          store,
          input.conversationId,
          keyRange,
        );

        let afterRevision: ConversationRevision | null = null;
        if (input.after !== undefined && "cursor" in input.after) {
          const row = await requestResult<StoredEventRow | undefined>(
            store.index(CURSOR_INDEX).get(input.after.cursor),
          );
          if (row === undefined || row.conversationId !== input.conversationId) {
            throw new ConversationEventStoreConflictError(
              "The cursor was not issued for this conversation or is no longer available.",
              {
                code: "cursor_not_found",
                conversationId: input.conversationId,
                expectedRevision: null,
                actualRevision: currentRevision,
                identifier: input.after.cursor,
              },
            );
          }
          afterRevision = row.revision;
        } else if (input.after !== undefined && "revision" in input.after) {
          afterRevision = input.after.revision;
        }

        const range = conversationRange(
          keyRange,
          input.conversationId,
          afterRevision,
        );
        const requestedCount = input.limit ?? Number.POSITIVE_INFINITY;
        const rows = await readRows(store, range, requestedCount + 1);
        const hasMore = rows.length > requestedCount;
        const selected = hasMore ? rows.slice(0, requestedCount) : rows;
        const entries = cloneEntries(selected.map(rowToEntry));

        return {
          entries,
          nextCursor: entries.at(-1)?.cursor ?? null,
          latestRevision: currentRevision,
          hasMore,
        };
      },
    );
  }

  async getLatestRevision(
    conversationId: ConversationId,
  ): Promise<ConversationRevision | null> {
    return this.runTransaction(
      "latest_revision",
      [this.storeNames.events],
      "readonly",
      async (transaction) =>
        latestRevision(
          transaction.objectStore(this.storeNames.events),
          conversationId,
          this.getKeyRange("latest_revision"),
        ),
    );
  }

  /** Release this adapter's connection without deleting any stored data. */
  async close(): Promise<void> {
    this.closed = true;
    const pending = this.databasePromise;
    this.databasePromise = undefined;
    if (pending === undefined) return;

    try {
      const database = await pending;
      database.close();
    } catch {
      // A failed open has no live connection to release.
    }
  }

  private async readCheckpoint(
    conversationId: ConversationId,
  ): Promise<ConversationEventCheckpoint | null> {
    return this.runTransaction(
      "checkpoint_read",
      [this.storeNames.checkpoints],
      "readonly",
      async (transaction) => {
        const checkpoint = await requestResult<StoredCheckpointRow | undefined>(
          transaction.objectStore(this.storeNames.checkpoints).get(conversationId),
        );
        return checkpoint === undefined ? null : cloneJson(checkpoint);
      },
    );
  }

  private async writeCheckpoint(
    checkpoint: ConversationEventCheckpoint,
  ): Promise<WriteConversationEventCheckpointResult> {
    return this.runTransaction(
      "checkpoint_write",
      [this.storeNames.events, this.storeNames.checkpoints],
      "readwrite",
      async (transaction) => {
        const actualRevision = await latestRevision(
          transaction.objectStore(this.storeNames.events),
          checkpoint.conversationId,
          this.getKeyRange("checkpoint_write"),
        );
        if (
          actualRevision === null ||
          checkpoint.revision > actualRevision ||
          checkpoint.revision < 1 ||
          !Number.isSafeInteger(checkpoint.revision)
        ) {
          throw checkpointConflict(
            checkpoint,
            actualRevision,
            "A checkpoint must reference an existing conversation revision.",
          );
        }

        const store = transaction.objectStore(this.storeNames.checkpoints);
        const current = await requestResult<StoredCheckpointRow | undefined>(
          store.get(checkpoint.conversationId),
        );
        if (current !== undefined) {
          if (checkpoint.revision < current.revision) {
            throw checkpointConflict(
              checkpoint,
              current.revision,
              "A checkpoint cannot replace a newer checkpoint.",
            );
          }
          if (checkpoint.revision === current.revision) {
            if (!jsonEqual(checkpoint.state, current.state)) {
              throw checkpointConflict(
                checkpoint,
                current.revision,
                "A checkpoint revision cannot be reused with different state.",
              );
            }
            if (checkpoint.schemaVersion === current.schemaVersion) {
              return { status: "idempotent", checkpoint: cloneJson(current) };
            }
          }
        }

        const stored = cloneJson(checkpoint) as StoredCheckpointRow;
        await requestResult(store.put(stored));
        return { status: "written", checkpoint: cloneJson(stored) };
      },
    );
  }

  private async runTransaction<T>(
    operation: ConversationEventStoreOperation,
    storeNames: readonly string[],
    mode: IDBTransactionMode,
    run: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const database = await this.getDatabase(operation);
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction([...storeNames], mode);
    } catch (error) {
      throw unavailable(operation, error);
    }

    const completion = transactionCompletion(transaction);
    try {
      const result = await run(transaction);
      await completion;
      return result;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // The transaction may already have aborted or committed.
      }
      await completion.catch(() => undefined);
      if (isContractError(error)) throw error;
      throw unavailable(operation, error);
    }
  }

  private async getDatabase(
    operation: ConversationEventStoreOperation,
  ): Promise<IDBDatabase> {
    if (this.closed) {
      throw new ConversationEventStoreUnavailableError(
        operation,
        "The IndexedDB conversation event store is closed.",
        false,
      );
    }

    if (this.databasePromise === undefined) {
      const promise = this.openDatabase();
      this.databasePromise = promise;
      void promise.catch(() => {
        if (this.databasePromise === promise) this.databasePromise = undefined;
      });
    }

    try {
      return await this.databasePromise;
    } catch (error) {
      throw unavailable(operation, error);
    }
  }

  private async openDatabase(): Promise<IDBDatabase> {
    const factory =
      this.configuredFactory ??
      (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
    if (factory === undefined) {
      throw new IndexedDBSetupError(
        "IndexedDB is not available in this runtime.",
        false,
      );
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await openRequest(
        factory,
        this.databaseName,
        undefined,
        (database, transaction) => this.createSchema(database, transaction),
      );
      if (this.hasSchema(current)) return this.prepareDatabase(current);

      const nextVersion = current.version + 1;
      current.close();
      try {
        const upgraded = await openRequest(
          factory,
          this.databaseName,
          nextVersion,
          (database, transaction) => this.createSchema(database, transaction),
        );
        return this.prepareDatabase(upgraded);
      } catch (error) {
        if (errorName(error) !== "VersionError" || attempt === 2) throw error;
      }
    }

    throw new IndexedDBSetupError(
      "IndexedDB schema could not be opened after concurrent upgrades.",
      true,
    );
  }

  private createSchema(
    database: IDBDatabase,
    transaction: IDBTransaction,
  ): void {
    let events: IDBObjectStore;
    if (database.objectStoreNames.contains(this.storeNames.events)) {
      events = transaction.objectStore(this.storeNames.events);
    } else {
      events = database.createObjectStore(this.storeNames.events, {
        keyPath: ["conversationId", "revision"],
      });
    }
    if (!events.indexNames.contains(EVENT_ID_INDEX)) {
      events.createIndex(EVENT_ID_INDEX, "eventId", { unique: true });
    }
    if (!events.indexNames.contains(MUTATION_ID_INDEX)) {
      events.createIndex(MUTATION_ID_INDEX, "mutationId", { unique: true });
    }
    if (!events.indexNames.contains(CURSOR_INDEX)) {
      events.createIndex(CURSOR_INDEX, "cursor", { unique: true });
    }

    if (!database.objectStoreNames.contains(this.storeNames.checkpoints)) {
      database.createObjectStore(this.storeNames.checkpoints, {
        keyPath: "conversationId",
      });
    }
  }

  private hasSchema(database: IDBDatabase): boolean {
    return (
      database.objectStoreNames.contains(this.storeNames.events) &&
      database.objectStoreNames.contains(this.storeNames.checkpoints)
    );
  }

  private prepareDatabase(database: IDBDatabase): IDBDatabase {
    database.onversionchange = () => {
      database.close();
      this.databasePromise = undefined;
    };
    return database;
  }

  private getKeyRange(
    operation: ConversationEventStoreOperation,
  ): typeof IDBKeyRange {
    const keyRange =
      this.configuredKeyRange ??
      (globalThis as typeof globalThis & { IDBKeyRange?: typeof IDBKeyRange })
        .IDBKeyRange;
    if (keyRange === undefined) {
      throw new ConversationEventStoreUnavailableError(
        operation,
        "IDBKeyRange is not available in this runtime.",
        false,
      );
    }
    return keyRange;
  }

  private cursor(
    conversationId: ConversationId,
    revision: ConversationRevision,
  ): ConversationEventCursor {
    return `${this.cursorNamespace}:${encodeURIComponent(conversationId)}:${revision}` as ConversationEventCursor;
  }
}

class IndexedDBSetupError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "IndexedDBSetupError";
  }
}

function openRequest(
  factory: IDBFactory,
  databaseName: string,
  version: number | undefined,
  upgrade: (database: IDBDatabase, transaction: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? factory.open(databaseName)
        : factory.open(databaseName, version);
    let settled = false;

    request.onupgradeneeded = () => {
      try {
        const transaction = request.transaction;
        if (transaction === null) {
          throw new Error("IndexedDB upgrade transaction is unavailable.");
        }
        upgrade(request.result, transaction);
      } catch (error) {
        settled = true;
        reject(error);
        try {
          request.transaction?.abort();
        } catch {
          // Upgrade has already failed.
        }
      }
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(
        new IndexedDBSetupError(
          `Opening IndexedDB database ${JSON.stringify(databaseName)} was blocked by another connection.`,
          true,
        ),
      );
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("IndexedDB open request failed."));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
  });
}

async function latestRevision(
  store: IDBObjectStore,
  conversationId: ConversationId,
  keyRangeConstructor: typeof IDBKeyRange,
): Promise<ConversationRevision | null> {
  const range = conversationRange(keyRangeConstructor, conversationId, null);
  return new Promise((resolve, reject) => {
    const request = store.openCursor(range, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      resolve(cursor === null ? null : (cursor.value as StoredEventRow).revision);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB revision read failed."));
  });
}

function conversationRange(
  keyRangeConstructor: typeof IDBKeyRange,
  conversationId: ConversationId,
  afterRevision: ConversationRevision | null,
): IDBKeyRange {
  const lowerRevision = afterRevision ?? 0;
  return keyRangeConstructor.bound(
    [conversationId, lowerRevision],
    [conversationId, Number.MAX_SAFE_INTEGER],
    afterRevision !== null,
    false,
  );
}

function readRows(
  store: IDBObjectStore,
  range: IDBKeyRange,
  maximum: number,
): Promise<StoredEventRow[]> {
  return new Promise((resolve, reject) => {
    const rows: StoredEventRow[] = [];
    const request = store.openCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null || rows.length >= maximum) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value as StoredEventRow);
      cursor.continue();
    };
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB event read failed."));
  });
}

async function findIdempotentMatch(
  store: IDBObjectStore,
  event: ConversationEvent,
): Promise<StoredEventRow | null> {
  const eventMatch = await requestResult<StoredEventRow | undefined>(
    store.index(EVENT_ID_INDEX).get(event.event_id),
  );
  const mutationMatch =
    event.mutation_id === undefined
      ? undefined
      : await requestResult<StoredEventRow | undefined>(
          store.index(MUTATION_ID_INDEX).get(event.mutation_id),
        );

  if (
    eventMatch !== undefined &&
    mutationMatch !== undefined &&
    !sameRow(eventMatch, mutationMatch)
  ) {
    throw idempotencyConflict(event, event.event_id);
  }
  if (eventMatch !== undefined && !jsonEqual(eventMatch.event, event)) {
    throw idempotencyConflict(event, event.event_id);
  }
  if (
    mutationMatch !== undefined &&
    !sameClientMutation(mutationMatch.event, event)
  ) {
    throw idempotencyConflict(event, event.mutation_id ?? null);
  }
  return eventMatch ?? mutationMatch ?? null;
}

function validateAppend(
  input: AppendConversationEventsInput,
  actualRevision: ConversationRevision | null,
): void {
  if (input.events.length === 0) {
    throw appendConflict(
      "invalid_append",
      input,
      actualRevision,
      "An append batch must contain at least one event.",
    );
  }

  const expectedNumber = input.expectedRevision ?? 0;
  const eventIds = new Set<string>();
  const mutationIds = new Set<string>();
  input.events.forEach((event, index) => {
    parseConversationEvent(event);
    const requiredRevision = expectedNumber + index + 1;
    if (event.conversation_id !== input.conversationId) {
      throw appendConflict(
        "invalid_append",
        input,
        actualRevision,
        "Every event in a batch must belong to the requested conversation.",
        event.conversation_id,
      );
    }
    if (event.revision !== requiredRevision) {
      throw appendConflict(
        "invalid_append",
        input,
        actualRevision,
        `Expected contiguous event revision ${requiredRevision}.`,
        event.event_id,
      );
    }
    if (eventIds.has(event.event_id)) {
      throw appendConflict(
        "invalid_append",
        input,
        actualRevision,
        "An append batch cannot repeat an event ID.",
        event.event_id,
      );
    }
    eventIds.add(event.event_id);

    if (event.mutation_id !== undefined) {
      if (mutationIds.has(event.mutation_id)) {
        throw appendConflict(
          "invalid_append",
          input,
          actualRevision,
          "An append batch cannot repeat a client mutation ID.",
          event.mutation_id,
        );
      }
      mutationIds.add(event.mutation_id);
    }
  });
}

function validateCompleteRetry(
  input: AppendConversationEventsInput,
  rows: readonly StoredEventRow[],
  actualRevision: ConversationRevision | null,
): void {
  const expectedFirstRevision = (input.expectedRevision ?? 0) + 1;
  for (const [index, row] of rows.entries()) {
    if (
      row.conversationId !== input.conversationId ||
      row.revision !== expectedFirstRevision + index
    ) {
      throw appendConflict(
        "idempotency_conflict",
        input,
        actualRevision,
        "The identifiers do not describe one previously stored atomic batch.",
        input.events[index]?.event_id ?? null,
      );
    }
  }
}

function appendResult(
  status: AppendConversationEventsResult["status"],
  entries: readonly StoredConversationEvent[],
  latestRevisionValue: ConversationRevision,
): AppendConversationEventsResult {
  return {
    status,
    entries: cloneEntries(entries),
    latestRevision: latestRevisionValue,
  };
}

function rowToEntry(row: StoredEventRow): StoredConversationEvent {
  return { cursor: row.cursor, event: row.event };
}

function cloneEntries(
  entries: readonly StoredConversationEvent[],
): readonly StoredConversationEvent[] {
  return Object.freeze(entries.map((entry) => cloneJson(entry)));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sameRow(left: StoredEventRow, right: StoredEventRow): boolean {
  return (
    left.conversationId === right.conversationId &&
    left.revision === right.revision
  );
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return (
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (typeof left !== "object" || typeof right !== "object") return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        jsonEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function sameClientMutation(
  stored: ConversationEvent,
  requested: ConversationEvent,
): boolean {
  return (
    stored.mutation_id !== undefined &&
    requested.mutation_id !== undefined &&
    stored.mutation_id === requested.mutation_id &&
    stored.version === requested.version &&
    stored.conversation_id === requested.conversation_id &&
    jsonEqual(stored.actor, requested.actor) &&
    jsonEqual(stored.source, requested.source) &&
    jsonEqual(stored.metadata, requested.metadata) &&
    jsonEqual(stored.payload, requested.payload)
  );
}

function appendConflict(
  code: ConversationEventStoreConflictCode,
  input: AppendConversationEventsInput,
  actualRevision: ConversationRevision | null,
  message: string,
  identifier: string | null = null,
): ConversationEventStoreConflictError {
  return new ConversationEventStoreConflictError(message, {
    code,
    conversationId: input.conversationId,
    expectedRevision: input.expectedRevision,
    actualRevision,
    identifier,
  });
}

function idempotencyConflict(
  event: ConversationEvent,
  identifier: ConversationEventId | ConversationClientMutationId | null,
): ConversationEventStoreConflictError {
  return new ConversationEventStoreConflictError(
    "An idempotency identifier is already stored for a different fact or mutation.",
    {
      code: "idempotency_conflict",
      conversationId: event.conversation_id,
      expectedRevision: null,
      actualRevision: null,
      identifier,
    },
  );
}

function checkpointConflict(
  checkpoint: ConversationEventCheckpoint,
  actualRevision: ConversationRevision | null,
  message: string,
): ConversationEventStoreConflictError {
  return new ConversationEventStoreConflictError(message, {
    code: "checkpoint_conflict",
    conversationId: checkpoint.conversationId,
    expectedRevision: checkpoint.revision,
    actualRevision,
    identifier: null,
  });
}

function unavailable(
  operation: ConversationEventStoreOperation,
  error: unknown,
): ConversationEventStoreUnavailableError {
  if (error instanceof ConversationEventStoreUnavailableError) return error;

  const name = errorName(error);
  const retryable =
    error instanceof IndexedDBSetupError
      ? error.retryable
      : ![
          "ConstraintError",
          "DataError",
          "InvalidAccessError",
          "NotFoundError",
          "NotSupportedError",
          "QuotaExceededError",
          "SecurityError",
        ].includes(name);
  const message =
    error instanceof Error
      ? error.message
      : "IndexedDB conversation event storage is unavailable.";
  return new ConversationEventStoreUnavailableError(
    operation,
    `IndexedDB ${operation} failed: ${message}`,
    retryable,
  );
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String(error.name)
    : "Error";
}

function isContractError(error: unknown): boolean {
  return (
    error instanceof ConversationEventStoreConflictError ||
    error instanceof ConversationEventStoreUnavailableError ||
    error instanceof RangeError ||
    error instanceof TypeError
  );
}
