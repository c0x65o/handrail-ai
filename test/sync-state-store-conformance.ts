import {
  CONVERSATION_SYNC_STATE_SCHEMA_VERSION,
  ConversationSyncStateStoreConflictError,
  createInitialConversationState,
  parseConversationEvent,
  reduceConversationEvent,
  type ConversationSyncMutation,
  type ConversationSyncMutationEvent,
  type ConversationSyncStateRecordData,
  type ConversationSyncStateStore,
} from "../src/index.js";

export type ConversationSyncStateStoreFactory = () =>
  | ConversationSyncStateStore
  | Promise<ConversationSyncStateStore>;

export interface ConversationSyncStateStoreConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/** Framework-neutral conformance cases for durable sync-state adapters. */
export function conversationSyncStateStoreConformanceCases(
  createStore: ConversationSyncStateStoreFactory,
): readonly ConversationSyncStateStoreConformanceCase[] {
  return [
    {
      name: "loads an absent record and round-trips a complete save",
      run: async () => {
        const store = await createStore();
        const record = syncStateRecord("conversation-round-trip", [
          "mutation-round-trip",
        ]);

        equal(await store.load(record.conversationId), null);
        const saved = await store.save({ expectedGeneration: null, record });
        equal(saved.generation, 1);
        deepEqual(await store.load(record.conversationId), saved);
      },
    },
    {
      name: "rejects a stale generation without changing the record",
      run: async () => {
        const store = await createStore();
        const original = syncStateRecord("conversation-stale", [
          "mutation-original",
        ]);
        const saved = await store.save({
          expectedGeneration: null,
          record: original,
        });

        const stale = syncStateRecord("conversation-stale", ["mutation-stale"]);
        await rejectsGenerationConflict(
          store.save({ expectedGeneration: null, record: stale }),
          null,
          saved.generation,
        );
        deepEqual(await store.load(original.conversationId), saved);
      },
    },
    {
      name: "isolates records and generations by conversation",
      run: async () => {
        const store = await createStore();
        const first = syncStateRecord("conversation-isolated-a", ["mutation-a"]);
        const second = syncStateRecord("conversation-isolated-b", ["mutation-b"]);

        const savedFirst = await store.save({
          expectedGeneration: null,
          record: first,
        });
        const savedSecond = await store.save({
          expectedGeneration: null,
          record: second,
        });
        const updatedFirst = await store.save({
          expectedGeneration: savedFirst.generation,
          record: syncStateRecord("conversation-isolated-a", ["mutation-a-2"]),
        });

        equal(updatedFirst.generation, 2);
        equal(savedSecond.generation, 1);
        deepEqual(await store.load(second.conversationId), savedSecond);
      },
    },
    {
      name: "preserves every pending mutation in submission order",
      run: async () => {
        const store = await createStore();
        const record = syncStateRecord("conversation-pending", [
          "mutation-first",
          "mutation-second",
          "mutation-third",
        ]);
        await store.save({ expectedGeneration: null, record });

        const loaded = await store.load(record.conversationId);
        assert(loaded !== null, "The saved sync state must be loadable.");
        deepEqual(
          loaded.pendingMutations.map(({ mutationId }) => mutationId),
          ["mutation-first", "mutation-second", "mutation-third"],
        );
        deepEqual(loaded.pendingMutations, record.pendingMutations);
      },
    },
    {
      name: "does not retain inputs or expose mutable internal data",
      run: async () => {
        const store = await createStore();
        const record = syncStateRecord("conversation-cloning", [
          "mutation-cloning",
        ]);
        const saved = await store.save({ expectedGeneration: null, record });

        setMarker(record, "mutated input");
        setMarker(saved, "mutated save result");
        const loaded = await store.load(record.conversationId);
        assert(loaded !== null, "The saved sync state must be loadable.");
        equal(
          loaded.authoritativeState.metadata.marker,
          "mutation-authoritative",
        );
        equal(pendingMarker(loaded), "mutation-cloning");

        setMarker(loaded, "mutated load result");
        const reloaded = await store.load(record.conversationId);
        assert(reloaded !== null, "The saved sync state must remain loadable.");
        equal(
          reloaded.authoritativeState.metadata.marker,
          "mutation-authoritative",
        );
        equal(pendingMarker(reloaded), "mutation-cloning");
      },
    },
  ];
}

export function syncStateRecord(
  conversationId: string,
  mutationIds: readonly string[],
): ConversationSyncStateRecordData {
  const authoritativeEvent = event(
    conversationId,
    "mutation-authoritative",
    1,
  );
  const state = reduceConversationEvent(
    createInitialConversationState(authoritativeEvent.conversation_id),
    authoritativeEvent,
  );
  const record: ConversationSyncStateRecordData = {
    schemaVersion: CONVERSATION_SYNC_STATE_SCHEMA_VERSION,
    conversationId: authoritativeEvent.conversation_id,
    authoritativeState: state,
    authoritativeRevision: authoritativeEvent.revision,
    pendingMutations: mutationIds.map((mutationId, index) =>
      mutation(conversationId, mutationId, index + 2),
    ),
  };
  return JSON.parse(JSON.stringify(record)) as ConversationSyncStateRecordData;
}

function mutation(
  conversationId: string,
  mutationId: string,
  revision: number,
): ConversationSyncMutation {
  const proposed = event(conversationId, mutationId, revision);
  return {
    mutationId: proposed.mutation_id!,
    events: [proposed as ConversationSyncMutationEvent],
  };
}

function event(
  conversationId: string,
  marker: string,
  revision: number,
) {
  return parseConversationEvent({
    version: 1,
    event_id: `event-${conversationId}-${marker}`,
    conversation_id: conversationId,
    revision,
    occurred_at: "2026-08-28T12:00:00.000Z",
    actor: { type: "user", id: "user-conformance" },
    source: { type: "client", client_id: "client-conformance" },
    mutation_id: marker,
    payload: {
      type: "conversation.metadata_updated",
      metadata: { marker },
    },
  });
}

function setMarker(
  record: Pick<
    ConversationSyncStateRecordData,
    "authoritativeState" | "pendingMutations"
  >,
  marker: string,
): void {
  (record.authoritativeState.metadata as { marker: string }).marker = marker;
  const payload = record.pendingMutations[0]?.events[0]?.payload;
  if (payload?.type === "conversation.metadata_updated") {
    payload.metadata.marker = marker;
  }
}

function pendingMarker(
  record: Pick<ConversationSyncStateRecordData, "pendingMutations">,
): unknown {
  const payload = record.pendingMutations[0]?.events[0]?.payload;
  return payload?.type === "conversation.metadata_updated"
    ? payload.metadata.marker
    : undefined;
}

async function rejectsGenerationConflict(
  promise: Promise<unknown>,
  expectedGeneration: number | null,
  actualGeneration: number | null,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(
      error instanceof ConversationSyncStateStoreConflictError,
      "Expected a ConversationSyncStateStoreConflictError.",
    );
    equal(error.code, "generation_conflict");
    equal(error.expectedGeneration, expectedGeneration);
    equal(error.actualGeneration, actualGeneration);
    return;
  }
  throw new Error("Expected save to reject with a generation conflict.");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown): void {
  assert(
    Object.is(actual, expected),
    `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`,
  );
}

function deepEqual(actual: unknown, expected: unknown): void {
  equal(JSON.stringify(actual), JSON.stringify(expected));
}
