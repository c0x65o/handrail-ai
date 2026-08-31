import {
  ConversationEventStoreConflictError,
  ConversationEventStoreUnavailableError,
  type AppendConversationEventsInput,
  type AppendConversationEventsResult,
  type ConversationEventCursor,
  type ConversationEventStore,
  type ReadConversationEventsInput,
  type ReadConversationEventsResult,
  type StoredConversationEvent,
} from "../conversation/event-store.js";
import {
  parseConversationEvent,
  type ConversationClientMutationId,
  type ConversationEvent,
  type ConversationId,
  type ConversationRevision,
} from "../conversation/events.js";
import type {
  AppendMutationsResult,
  ConversationSyncAdapter,
  ConversationSyncMutation,
  ConversationSyncOperationFailure,
  ConversationSyncSnapshotRequired,
  ReadSinceResult,
} from "./types.js";

export interface SynchronizedConversationEventStoreOptions {
  readonly adapter: Pick<ConversationSyncAdapter, "appendMutations" | "readSince">;
}

/**
 * ConversationEventStore facade over a server-authoritative sync adapter.
 *
 * Runtime envelopes are proposals only: the remote adapter assigns canonical
 * event identity, revision, time, actor/source attribution and may reject or
 * rewrite every field. Hosts must retain the sync adapter's safe default or
 * explicitly verify runtime/usage proposals against durable server records.
 */
export function createSynchronizedConversationEventStore(
  options: SynchronizedConversationEventStoreOptions,
): ConversationEventStore {
  const read = async (input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> => {
    const afterRevision = input.after === undefined
      ? null
      : "revision" in input.after && input.after.revision !== undefined
        ? input.after.revision
        : parseCursor(input.conversationId, input.after.cursor);
    const result = await options.adapter.readSince({
      conversationId: input.conversationId,
      afterRevision,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return readResult(input.conversationId, afterRevision, result);
  };

  return Object.freeze({
    append: async (input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> => {
      const events = validateProposedAppend(input);
      const mutations = events.map((event): ConversationSyncMutation => {
        const mutationId = event.mutation_id ??
          (`sync-event:${event.event_id}` as ConversationClientMutationId);
        return Object.freeze({
          mutationId,
          events: Object.freeze([{ ...event, mutation_id: mutationId }]) as ConversationSyncMutation["events"],
        });
      });
      const result = await options.adapter.appendMutations({
        conversationId: input.conversationId,
        expectedRevision: input.expectedRevision,
        mutations,
      });
      return appendResult(input, mutations, result);
    },
    read,
    getLatestRevision: async (conversationId: ConversationId): Promise<ConversationRevision | null> => {
      const result = await options.adapter.readSince({ conversationId, afterRevision: null, limit: 1 });
      if (result.status === "events") return result.latestRevision;
      throwReadFailure(conversationId, null, result);
    },
  });
}

function validateProposedAppend(input: AppendConversationEventsInput): readonly ConversationEvent[] {
  if (!Array.isArray(input.events) || input.events.length === 0) {
    throw conflict("invalid_append", input.conversationId, input.expectedRevision, input.expectedRevision, null,
      "A synchronized append requires at least one event");
  }
  const events = input.events.map(parseConversationEvent);
  const seenMutations = new Set<string>();
  for (const [index, event] of events.entries()) {
    const expected = (input.expectedRevision ?? 0) + index + 1;
    if (event.conversation_id !== input.conversationId || event.revision !== expected) {
      throw conflict("invalid_append", input.conversationId, input.expectedRevision, null, event.event_id,
        "A synchronized append must be contiguous and conversation-scoped");
    }
    const mutation = event.mutation_id ?? `sync-event:${event.event_id}`;
    if (seenMutations.has(mutation)) {
      throw conflict("idempotency_conflict", input.conversationId, input.expectedRevision, null, mutation,
        "A synchronized append reused one mutation identity within a batch");
    }
    seenMutations.add(mutation);
  }
  return events;
}

function appendResult(
  input: AppendConversationEventsInput,
  mutations: readonly ConversationSyncMutation[],
  result: AppendMutationsResult,
): AppendConversationEventsResult {
  if (result.status === "conflict") {
    throw conflict("revision_conflict", input.conversationId, result.expectedRevision, result.actualRevision, null,
      "The synchronized conversation revision changed");
  }
  if (result.status === "snapshot_required") {
    throw snapshotConflict(input.conversationId, input.expectedRevision, result);
  }
  if (result.status !== "mutations") {
    throwOperationFailure("append", result);
  }
  if (result.acknowledgements.length !== mutations.length) {
    throw new ConversationEventStoreUnavailableError("append", "Synchronization returned an invalid acknowledgement", false);
  }
  const entries: StoredConversationEvent[] = [];
  let allDuplicate = true;
  for (const [index, acknowledgement] of result.acknowledgements.entries()) {
    if (acknowledgement.mutationId !== mutations[index]!.mutationId || acknowledgement.events.length !== 1) {
      throw new ConversationEventStoreUnavailableError("append", "Synchronization returned conflicting mutation identity", false);
    }
    const event = parseConversationEvent(acknowledgement.events[0]);
    if (event.conversation_id !== input.conversationId || event.mutation_id !== acknowledgement.mutationId) {
      throw new ConversationEventStoreUnavailableError("append", "Synchronization returned an invalid canonical event", false);
    }
    allDuplicate &&= acknowledgement.status === "duplicate";
    entries.push(stored(input.conversationId, event));
  }
  if (entries.at(-1)?.event.revision !== result.latestRevision) {
    throw new ConversationEventStoreUnavailableError("append", "Synchronization returned a non-contiguous revision", false);
  }
  return Object.freeze({
    status: allDuplicate ? "idempotent" as const : "appended" as const,
    entries: Object.freeze(entries),
    latestRevision: result.latestRevision,
  });
}

function readResult(
  conversationId: ConversationId,
  afterRevision: ConversationRevision | null,
  result: ReadSinceResult,
): ReadConversationEventsResult {
  if (result.status !== "events") throwReadFailure(conversationId, afterRevision, result);
  const events = result.events.map(parseConversationEvent);
  let expected = (afterRevision ?? 0) + 1;
  for (const event of events) {
    if (event.conversation_id !== conversationId || event.revision !== expected) {
      throw new ConversationEventStoreUnavailableError("read", "Synchronization returned non-contiguous history", false);
    }
    expected += 1;
  }
  if (result.revision !== (events.at(-1)?.revision ?? afterRevision)) {
    throw new ConversationEventStoreUnavailableError("read", "Synchronization returned a conflicting read revision", false);
  }
  const entries = Object.freeze(events.map((event) => stored(conversationId, event)));
  return Object.freeze({
    entries,
    nextCursor: entries.at(-1)?.cursor ?? null,
    latestRevision: result.latestRevision,
    hasMore: result.hasMore,
  });
}

function throwReadFailure(
  conversationId: ConversationId,
  expectedRevision: ConversationRevision | null,
  result: Exclude<ReadSinceResult, { readonly status: "events" }>,
): never {
  if (result.status === "snapshot_required") {
    throw snapshotConflict(conversationId, expectedRevision, result);
  }
  throwOperationFailure("read", result);
}

function throwOperationFailure(
  operation: "append" | "read",
  failure: ConversationSyncOperationFailure,
): never {
  throw new ConversationEventStoreUnavailableError(
    operation,
    failure.message ?? "Conversation synchronization is unavailable",
    failure.status === "temporarily_unavailable",
  );
}

function snapshotConflict(
  conversationId: ConversationId,
  expectedRevision: ConversationRevision | null,
  result: ConversationSyncSnapshotRequired,
): ConversationEventStoreConflictError {
  return conflict("cursor_not_found", conversationId, expectedRevision, result.latestRevision, null,
    "Incremental synchronized history is no longer available");
}

function conflict(
  code: ConstructorParameters<typeof ConversationEventStoreConflictError>[1]["code"],
  conversationId: ConversationId,
  expectedRevision: ConversationRevision | null,
  actualRevision: ConversationRevision | null,
  identifier: string | null,
  message: string,
): ConversationEventStoreConflictError {
  return new ConversationEventStoreConflictError(message, {
    code, conversationId, expectedRevision, actualRevision, identifier,
  });
}

function stored(conversationId: ConversationId, event: ConversationEvent): StoredConversationEvent {
  return Object.freeze({ cursor: cursor(conversationId, event.revision), event });
}

function cursor(conversationId: ConversationId, revision: ConversationRevision): ConversationEventCursor {
  return JSON.stringify([conversationId, revision]) as ConversationEventCursor;
}

function parseCursor(conversationId: ConversationId, value: ConversationEventCursor): ConversationRevision {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== conversationId ||
      !Number.isSafeInteger(parsed[1]) || (parsed[1] as number) < 1) throw new Error("invalid");
    return parsed[1] as ConversationRevision;
  } catch {
    throw conflict("cursor_not_found", conversationId, null, null, value,
      "The synchronized event cursor is invalid for this conversation");
  }
}
