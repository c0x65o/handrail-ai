import {
  ConversationEventStoreConflictError,
  parseConversationEvent,
  type ConversationEvent,
  type ConversationEventStore,
} from "../src/index.js";

export type ConversationEventStoreFactory = () =>
  | ConversationEventStore
  | Promise<ConversationEventStore>;

export interface ConversationEventStoreConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/**
 * Framework-neutral conformance cases for ConversationEventStore adapters.
 *
 * Adapter packages can register these cases with their test runner without
 * adding Vitest (or any other runner) to the runtime package.
 */
export function conversationEventStoreConformanceCases(
  createStore: ConversationEventStoreFactory,
): readonly ConversationEventStoreConformanceCase[] {
  return [
    {
      name: "appends and reads contiguous events in revision order",
      run: async () => {
        const store = await createStore();
        const first = event({ eventId: "evt-order-1", revision: 1 });
        const second = event({ eventId: "evt-order-2", revision: 2 });
        const result = await store.append({
          conversationId: first.conversation_id,
          expectedRevision: null,
          events: [first, second],
        });

        equal(result.status, "appended");
        equal(result.latestRevision, 2);
        deepEqual(
          result.entries.map(({ event: stored }) => stored.revision),
          [1, 2],
        );
        const read = await store.read({ conversationId: first.conversation_id });
        deepEqual(
          read.entries.map(({ event: stored }) => stored.event_id),
          ["evt-order-1", "evt-order-2"],
        );
      },
    },
    {
      name: "treats an identical event ID retry as idempotent",
      run: async () => {
        const store = await createStore();
        const storedEvent = event({ eventId: "evt-idempotent-event", revision: 1 });
        const input = {
          conversationId: storedEvent.conversation_id,
          expectedRevision: null,
          events: [storedEvent],
        } as const;

        await store.append(input);
        const newerEvent = event({
          eventId: "evt-after-idempotent-event",
          revision: 2,
        });
        await store.append({
          conversationId: storedEvent.conversation_id,
          expectedRevision: storedEvent.revision,
          events: [newerEvent],
        });
        const retry = await store.append(input);

        equal(retry.status, "idempotent");
        equal(retry.entries[0]?.event.event_id, storedEvent.event_id);
        equal(retry.latestRevision, 2);
        equal(await store.getLatestRevision(storedEvent.conversation_id), 2);
      },
    },
    {
      name: "deduplicates an equivalent client mutation with a regenerated envelope",
      run: async () => {
        const store = await createStore();
        const original = event({
          eventId: "evt-mutation-original",
          mutationId: "mutation-stable",
          revision: 1,
          occurredAt: "2026-08-27T12:00:00Z",
        });
        const regenerated = event({
          eventId: "evt-mutation-regenerated",
          mutationId: "mutation-stable",
          revision: 1,
          occurredAt: "2026-08-27T12:00:01Z",
        });

        await store.append({
          conversationId: original.conversation_id,
          expectedRevision: null,
          events: [original],
        });
        const retry = await store.append({
          conversationId: regenerated.conversation_id,
          expectedRevision: null,
          events: [regenerated],
        });

        equal(retry.status, "idempotent");
        equal(retry.entries[0]?.event.event_id, original.event_id);
        equal(await store.getLatestRevision(original.conversation_id), 1);
      },
    },
    {
      name: "rejects a stale expected revision without a partial write",
      run: async () => {
        const store = await createStore();
        const existing = event({ eventId: "evt-existing", revision: 1 });
        await store.append({
          conversationId: existing.conversation_id,
          expectedRevision: null,
          events: [existing],
        });

        const staleBatch = [
          event({ eventId: "evt-stale-1", revision: 1 }),
          event({ eventId: "evt-stale-2", revision: 2 }),
        ];
        await rejectsWithCode(
          store.append({
            conversationId: existing.conversation_id,
            expectedRevision: null,
            events: staleBatch,
          }),
          "revision_conflict",
        );

        const read = await store.read({ conversationId: existing.conversation_id });
        deepEqual(
          read.entries.map(({ event: stored }) => stored.event_id),
          ["evt-existing"],
        );
      },
    },
    {
      name: "reads strictly after either a revision or cursor",
      run: async () => {
        const store = await createStore();
        const events = [1, 2, 3].map((revision) =>
          event({ eventId: `evt-read-${revision}`, revision }),
        );
        await store.append({
          conversationId: events[0]!.conversation_id,
          expectedRevision: null,
          events,
        });

        const afterRevision = await store.read({
          conversationId: events[0]!.conversation_id,
          after: { revision: events[0]!.revision },
          limit: 1,
        });
        deepEqual(
          afterRevision.entries.map(({ event: stored }) => stored.revision),
          [2],
        );
        equal(afterRevision.hasMore, true);

        const firstPage = await store.read({
          conversationId: events[0]!.conversation_id,
          limit: 1,
        });
        const cursor = firstPage.nextCursor;
        assert(cursor !== null, "A non-empty read must return a next cursor.");
        const afterCursor = await store.read({
          conversationId: events[0]!.conversation_id,
          after: { cursor },
        });
        deepEqual(
          afterCursor.entries.map(({ event: stored }) => stored.revision),
          [2, 3],
        );
      },
    },
    {
      name: "isolates conversations and reports each latest revision",
      run: async () => {
        const store = await createStore();
        const firstA = event({
          conversationId: "conversation-a",
          eventId: "evt-a-1",
          revision: 1,
        });
        const secondA = event({
          conversationId: "conversation-a",
          eventId: "evt-a-2",
          revision: 2,
        });
        const firstB = event({
          conversationId: "conversation-b",
          eventId: "evt-b-1",
          revision: 1,
        });

        await store.append({
          conversationId: firstA.conversation_id,
          expectedRevision: null,
          events: [firstA, secondA],
        });
        await store.append({
          conversationId: firstB.conversation_id,
          expectedRevision: null,
          events: [firstB],
        });

        equal(await store.getLatestRevision(firstA.conversation_id), 2);
        equal(await store.getLatestRevision(firstB.conversation_id), 1);
        const readB = await store.read({ conversationId: firstB.conversation_id });
        deepEqual(
          readB.entries.map(({ event: stored }) => stored.event_id),
          ["evt-b-1"],
        );
      },
    },
    {
      name: "round-trips a compact checkpoint without exposing mutable state",
      run: async () => {
        const store = await createStore();
        const storedEvent = event({ eventId: "evt-checkpoint", revision: 1 });
        await store.append({
          conversationId: storedEvent.conversation_id,
          expectedRevision: null,
          events: [storedEvent],
        });
        const checkpoints = store.checkpoints;
        assert(checkpoints !== undefined, "This conformance case requires checkpoints.");

        const state = { title: "original", applied: ["evt-checkpoint"] };
        const written = await checkpoints.write({
          conversationId: storedEvent.conversation_id,
          revision: storedEvent.revision,
          state,
        });
        equal(written.status, "written");
        state.title = "caller mutation";

        const read = await checkpoints.read(storedEvent.conversation_id);
        assert(read !== null, "The checkpoint must round-trip.");
        deepEqual(read.state, {
          title: "original",
          applied: ["evt-checkpoint"],
        });

        const retry = await checkpoints.write(read);
        equal(retry.status, "idempotent");
      },
    },
  ];
}

interface EventOptions {
  readonly conversationId?: string;
  readonly eventId: string;
  readonly mutationId?: string;
  readonly revision: number;
  readonly occurredAt?: string;
  readonly marker?: string;
}

export function conformanceEvent(options: EventOptions): ConversationEvent {
  return event(options);
}

function event(options: EventOptions): ConversationEvent {
  return parseConversationEvent({
    version: 1,
    event_id: options.eventId,
    conversation_id: options.conversationId ?? "conversation-conformance",
    revision: options.revision,
    occurred_at: options.occurredAt ?? "2026-08-27T12:00:00Z",
    actor: { type: "user", id: "user-conformance" },
    source: { type: "client", client_id: "client-conformance" },
    ...(options.mutationId === undefined
      ? {}
      : { mutation_id: options.mutationId }),
    payload: {
      type: "conversation.metadata_updated",
      metadata: { marker: options.marker ?? "same-mutation" },
    },
  });
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

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: ConversationEventStoreConflictError["code"],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assert(
      error instanceof ConversationEventStoreConflictError,
      "Expected a ConversationEventStoreConflictError.",
    );
    equal(error.code, code);
    return;
  }
  throw new Error(`Expected append to reject with ${code}.`);
}
