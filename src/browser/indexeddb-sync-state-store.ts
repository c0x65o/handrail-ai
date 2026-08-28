import type { ConversationId } from "../conversation/events.js";
import {
  ConversationSyncStateStoreConflictError,
  ConversationSyncStateStoreUnavailableError,
  type ConversationSyncStateRecord,
  type ConversationSyncStateRecordData,
  type ConversationSyncStateStore,
  type ConversationSyncStateStoreOperation,
  type SaveConversationSyncStateInput,
} from "../sync/persistence.js";

export const INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_SCHEMA_VERSION = 1;
export const DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_DATABASE_NAME =
  "handrail-ai";
export const DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_NAME =
  "conversation-sync-states";
export const DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_NAMESPACE = "default";

export interface IndexedDBConversationSyncStateStoreOptions {
  /** IndexedDB database name. Use a tenant/environment-specific value when needed. */
  readonly databaseName?: string;
  /** Logical partition within the shared sync-state object store. */
  readonly namespace?: string;
  /** Optional factory injection for non-window runtimes and tests. */
  readonly indexedDB?: IDBFactory;
}

interface StoredSyncStateRow extends ConversationSyncStateRecord {
  readonly namespace: string;
}

/**
 * Durable, opt-in browser implementation of ConversationSyncStateStore.
 *
 * Browser globals are resolved lazily when an operation first opens the
 * database. Every save compares and replaces one complete conversation record
 * in a single read/write transaction. close() releases this instance's
 * connection without deleting durable data.
 */
export class IndexedDBConversationSyncStateStore
  implements ConversationSyncStateStore
{
  private readonly databaseName: string;
  private readonly namespace: string;
  private readonly configuredFactory: IDBFactory | undefined;
  private databasePromise: Promise<IDBDatabase> | undefined;
  private closed = false;

  constructor(options: IndexedDBConversationSyncStateStoreOptions = {}) {
    this.databaseName =
      options.databaseName ??
      DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_DATABASE_NAME;
    this.namespace =
      options.namespace ?? DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_NAMESPACE;
    this.configuredFactory = options.indexedDB;

    if (this.databaseName.length === 0) {
      throw new TypeError("IndexedDB databaseName must not be empty.");
    }
    if (this.namespace.length === 0) {
      throw new TypeError("IndexedDB namespace must not be empty.");
    }
  }

  async load(
    conversationId: ConversationId,
  ): Promise<ConversationSyncStateRecord | null> {
    return this.runTransaction("load", "readonly", async (transaction) => {
      const row = await requestResult<StoredSyncStateRow | undefined>(
        transaction
          .objectStore(DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_NAME)
          .get([this.namespace, conversationId]),
      );
      return row === undefined ? null : recordFromRow(row);
    });
  }

  async save(
    input: SaveConversationSyncStateInput,
  ): Promise<ConversationSyncStateRecord> {
    const record = cloneRecordData(input.record);

    return this.runTransaction("save", "readwrite", async (transaction) => {
      const store = transaction.objectStore(
        DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_NAME,
      );
      const key: IDBValidKey = [this.namespace, record.conversationId];
      const current = await requestResult<StoredSyncStateRow | undefined>(
        store.get(key),
      );
      const actualGeneration = current?.generation ?? null;

      if (input.expectedGeneration !== actualGeneration) {
        throw new ConversationSyncStateStoreConflictError(
          "The expected generation does not match the latest stored generation.",
          {
            code: "generation_conflict",
            conversationId: record.conversationId,
            expectedGeneration: input.expectedGeneration,
            actualGeneration,
          },
        );
      }

      const generation = (actualGeneration ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new RangeError("Conversation sync state generation is exhausted.");
      }

      const row: StoredSyncStateRow = {
        namespace: this.namespace,
        ...record,
        generation,
      };
      await requestResult(store.put(row));
      return recordFromRow(row);
    });
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

  private async runTransaction<T>(
    operation: ConversationSyncStateStoreOperation,
    mode: IDBTransactionMode,
    run: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const database = await this.getDatabase(operation);
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(
        DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_NAME,
        mode,
      );
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
    operation: ConversationSyncStateStoreOperation,
  ): Promise<IDBDatabase> {
    if (this.closed) {
      throw new ConversationSyncStateStoreUnavailableError(
        operation,
        "The IndexedDB conversation sync state store is closed.",
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
      const current = await openRequest(factory, this.databaseName, undefined);
      if (this.hasSchema(current)) return this.prepareDatabase(current);

      const nextVersion = current.version + 1;
      current.close();
      try {
        const upgraded = await openRequest(
          factory,
          this.databaseName,
          nextVersion,
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

  private hasSchema(database: IDBDatabase): boolean {
    return database.objectStoreNames.contains(
      DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_NAME,
    );
  }

  private prepareDatabase(database: IDBDatabase): IDBDatabase {
    database.onversionchange = () => {
      database.close();
      this.databasePromise = undefined;
    };
    return database;
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
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request =
      version === undefined
        ? factory.open(databaseName)
        : factory.open(databaseName, version);
    let settled = false;

    request.onupgradeneeded = () => {
      try {
        if (
          !request.result.objectStoreNames.contains(
            DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_NAME,
          )
        ) {
          request.result.createObjectStore(
            DEFAULT_INDEXEDDB_CONVERSATION_SYNC_STATE_STORE_NAME,
            { keyPath: ["namespace", "conversationId"] },
          );
        }
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

function cloneRecordData(
  record: ConversationSyncStateRecordData,
): ConversationSyncStateRecordData {
  return JSON.parse(JSON.stringify(record)) as ConversationSyncStateRecordData;
}

function recordFromRow(row: StoredSyncStateRow): ConversationSyncStateRecord {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: row.schemaVersion,
      conversationId: row.conversationId,
      generation: row.generation,
      authoritativeState: row.authoritativeState,
      authoritativeRevision: row.authoritativeRevision,
      pendingMutations: row.pendingMutations,
    }),
  ) as ConversationSyncStateRecord;
}

function unavailable(
  operation: ConversationSyncStateStoreOperation,
  error: unknown,
): ConversationSyncStateStoreUnavailableError {
  if (error instanceof ConversationSyncStateStoreUnavailableError) return error;

  const name = errorName(error);
  const retryable =
    error instanceof IndexedDBSetupError
      ? error.retryable
      : ![
          "ConstraintError",
          "DataCloneError",
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
      : "IndexedDB conversation sync state storage is unavailable.";
  return new ConversationSyncStateStoreUnavailableError(
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
    error instanceof ConversationSyncStateStoreConflictError ||
    error instanceof ConversationSyncStateStoreUnavailableError ||
    error instanceof RangeError ||
    error instanceof TypeError
  );
}
