import type {
  ConversationId,
  ConversationRevision,
} from "../conversation/events.js";
import type { ConversationState } from "../conversation/state.js";
import type { ConversationSyncMutation } from "./types.js";

/** Schema version for the durable sync-state record. */
export const CONVERSATION_SYNC_STATE_SCHEMA_VERSION = 1 as const;

/**
 * One atomic durable baseline for reconstructing a conversation coordinator.
 *
 * `authoritativeState` is the projection after `authoritativeRevision` and
 * `pendingMutations` is the complete queue in submission order. Implementations
 * must persist the projection, revision, and queue as one indivisible record.
 */
export interface ConversationSyncStateRecord {
  readonly schemaVersion: typeof CONVERSATION_SYNC_STATE_SCHEMA_VERSION;
  readonly conversationId: ConversationId;
  /** Monotonically increases after every successful save. */
  readonly generation: number;
  readonly authoritativeState: ConversationState;
  readonly authoritativeRevision: ConversationRevision | null;
  readonly pendingMutations: readonly ConversationSyncMutation[];
}

/** The record contents supplied by a caller; the store assigns generation. */
export type ConversationSyncStateRecordData = Omit<
  ConversationSyncStateRecord,
  "generation"
>;

export interface SaveConversationSyncStateInput {
  /** `null` means the caller expects no record to exist. */
  readonly expectedGeneration: number | null;
  readonly record: ConversationSyncStateRecordData;
}

export interface ConversationSyncStateStoreConflictDetails {
  readonly code: "generation_conflict";
  readonly conversationId: ConversationId;
  readonly expectedGeneration: number | null;
  readonly actualGeneration: number | null;
}

/** A deterministic stale-write conflict; the attempted save was not applied. */
export class ConversationSyncStateStoreConflictError extends Error {
  readonly code = "generation_conflict" as const;
  readonly conversationId: ConversationId;
  readonly expectedGeneration: number | null;
  readonly actualGeneration: number | null;

  constructor(
    message: string,
    details: ConversationSyncStateStoreConflictDetails,
  ) {
    super(message);
    this.name = "ConversationSyncStateStoreConflictError";
    this.conversationId = details.conversationId;
    this.expectedGeneration = details.expectedGeneration;
    this.actualGeneration = details.actualGeneration;
  }
}

export type ConversationSyncStateStoreOperation = "load" | "save";

/** A storage availability failure that may be safe for the caller to retry. */
export class ConversationSyncStateStoreUnavailableError extends Error {
  readonly operation: ConversationSyncStateStoreOperation;
  readonly retryable: boolean;

  constructor(
    operation: ConversationSyncStateStoreOperation,
    message: string,
    retryable = true,
  ) {
    super(message);
    this.name = "ConversationSyncStateStoreUnavailableError";
    this.operation = operation;
    this.retryable = retryable;
  }
}

/**
 * Platform-, transport-, and database-neutral persistence for sync baselines.
 *
 * `load` observes one complete record. `save` atomically compares the current
 * generation and replaces the complete record. A mismatch throws
 * ConversationSyncStateStoreConflictError and leaves durable state unchanged.
 * The first successful save has generation 1.
 */
export interface ConversationSyncStateStore {
  load(
    conversationId: ConversationId,
  ): Promise<ConversationSyncStateRecord | null>;
  save(
    input: SaveConversationSyncStateInput,
  ): Promise<ConversationSyncStateRecord>;
}

/**
 * Process-local reference adapter for tests and development.
 *
 * This adapter is not durable storage. It deep-clones every input and output so
 * callers cannot mutate a saved record through retained references.
 */
export class InMemoryConversationSyncStateStore
  implements ConversationSyncStateStore
{
  private readonly conversations = new Map<
    string,
    ConversationSyncStateRecord
  >();

  async load(
    conversationId: ConversationId,
  ): Promise<ConversationSyncStateRecord | null> {
    const record = this.conversations.get(conversationId);
    return record === undefined ? null : cloneRecord(record);
  }

  async save(
    input: SaveConversationSyncStateInput,
  ): Promise<ConversationSyncStateRecord> {
    const current = this.conversations.get(input.record.conversationId);
    const actualGeneration = current?.generation ?? null;

    if (input.expectedGeneration !== actualGeneration) {
      throw new ConversationSyncStateStoreConflictError(
        "The expected generation does not match the latest stored generation.",
        {
          code: "generation_conflict",
          conversationId: input.record.conversationId,
          expectedGeneration: input.expectedGeneration,
          actualGeneration,
        },
      );
    }

    const generation = (actualGeneration ?? 0) + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new RangeError("Conversation sync state generation is exhausted.");
    }

    const stored = cloneRecord({
      ...input.record,
      generation,
    });
    this.conversations.set(stored.conversationId, stored);
    return cloneRecord(stored);
  }
}

function cloneRecord(
  record: ConversationSyncStateRecord,
): ConversationSyncStateRecord {
  return JSON.parse(JSON.stringify(record)) as ConversationSyncStateRecord;
}
