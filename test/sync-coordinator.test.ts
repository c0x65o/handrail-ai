import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_EVENT_VERSION,
  ConversationSyncCoordinatorDestroyedError,
  InMemoryConversationEventStore,
  createConversationSyncCoordinator,
  createInitialConversationState,
  parseConversationEvent,
  reduceConversationEvent,
  type AppendMutationsInput,
  type AppendMutationsResult,
  type ConversationClientMutationId,
  type ConversationEvent,
  type ConversationEventPayload,
  type ConversationId,
  type ConversationJsonValue,
  type ConversationPresenceSubscription,
  type ConversationRevision,
  type ConversationState,
  type ConversationSyncAdapter,
  type ConversationSyncClock,
  type ConversationSyncEvents,
  type ConversationSyncMutation,
  type ConversationSyncSubscription,
  type ConversationSyncUpdate,
  type PublishPresenceInput,
  type PublishPresenceResult,
  type PullSnapshotInput,
  type PullSnapshotResult,
  type ReadSinceInput,
  type ReadSinceResult,
  type SubscribePresenceResult,
  type SubscribeSinceInput,
  type SubscribeSinceResult,
} from "../src/index.js";

const conversationId = "conversation-coordinator" as ConversationId;

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const reader = this.readers.shift();
    if (reader === undefined) this.values.push(value);
    else reader({ done: false, value });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise<IteratorResult<T>>((resolve) => {
          this.readers.push(resolve);
        });
      },
    };
  }
}

class ManualClock implements ConversationSyncClock {
  private readonly waits: Array<{
    readonly signal: AbortSignal;
    readonly resolve: () => void;
    readonly reject: (reason: unknown) => void;
  }> = [];

  wait(_milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const wait = { signal, resolve, reject };
      this.waits.push(wait);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }

  advanceAll(): void {
    for (const wait of this.waits.splice(0)) {
      if (!wait.signal.aborted) wait.resolve();
    }
  }
}

class FakeAuthoritativeAdapter
  implements ConversationSyncAdapter<ConversationJsonValue>
{
  readonly events: ConversationEvent[] = [];
  snapshotPulls = 0;
  online = true;
  rejectAppends = false;
  compactedThrough: ConversationRevision | null = null;
  private readonly mutations = new Map<string, readonly ConversationEvent[]>();
  private readonly subscribers = new Set<AsyncQueue<ConversationSyncUpdate>>();

  constructor(events: readonly ConversationEvent[] = []) {
    for (const event of events) this.store(event);
  }

  get activeSubscriptions(): number {
    return this.subscribers.size;
  }

  async pullSnapshot(
    input: PullSnapshotInput,
  ): Promise<PullSnapshotResult<ConversationJsonValue>> {
    if (!this.online) return unavailable();
    this.snapshotPulls += 1;
    return {
      status: "snapshot",
      snapshot: {
        conversationId: input.conversationId,
        revision: this.latestRevision(),
        state: cloneJson(project(this.events)),
      },
    };
  }

  async readSince(input: ReadSinceInput): Promise<ReadSinceResult> {
    if (!this.online) return unavailable();
    if (
      this.compactedThrough !== null &&
      (input.afterRevision ?? 0) < this.compactedThrough
    ) {
      return {
        status: "snapshot_required",
        reason: "compacted",
        latestRevision: this.latestRevision(),
      };
    }
    return this.eventsSince(input.afterRevision);
  }

  async appendMutations(
    input: AppendMutationsInput,
  ): Promise<AppendMutationsResult> {
    if (!this.online) return unavailable();
    if (this.rejectAppends) return { status: "unauthorized", message: "denied" };
    const known = input.mutations.map((mutation) =>
      this.mutations.get(mutation.mutationId),
    );
    if (known.every((events) => events !== undefined)) {
      return {
        status: "mutations",
        acknowledgements: input.mutations.map((mutation, index) => ({
          status: "duplicate",
          mutationId: mutation.mutationId,
          events: known[index]!,
        })),
        latestRevision: this.latestRevision()!,
      };
    }
    if (input.expectedRevision !== this.latestRevision()) {
      return {
        status: "conflict",
        expectedRevision: input.expectedRevision,
        actualRevision: this.latestRevision(),
      };
    }

    const previousRevision = this.latestRevision();
    const acknowledgements = input.mutations.map((mutation) => {
      const accepted = mutation.events.map((event) =>
        parseConversationEvent({
          ...event,
          revision: (this.events.length + 1) as ConversationRevision,
        }),
      );
      for (const event of accepted) this.store(event);
      this.mutations.set(mutation.mutationId, accepted);
      return {
        status: "accepted" as const,
        mutationId: mutation.mutationId,
        events: accepted,
      };
    });
    this.broadcast(this.eventsSince(previousRevision));
    return {
      status: "mutations",
      acknowledgements,
      latestRevision: this.latestRevision()!,
    };
  }

  async subscribeSince(
    input: SubscribeSinceInput,
  ): Promise<SubscribeSinceResult> {
    if (!this.online) return unavailable();
    const initial = await this.readSince(input);
    if (initial.status !== "events") return initial;
    const queue = new AsyncQueue<ConversationSyncUpdate>();
    if (initial.events.length > 0) queue.push(initial);
    this.subscribers.add(queue);
    const subscription: ConversationSyncSubscription = {
      updates: queue,
      close: () => {
        this.subscribers.delete(queue);
        queue.close();
      },
    };
    return { status: "subscribed", subscription };
  }

  async publishPresence(
    input: PublishPresenceInput,
  ): Promise<PublishPresenceResult> {
    return { status: "published", record: input.record };
  }

  async subscribePresence(): Promise<SubscribePresenceResult> {
    const queue = new AsyncQueue<never>();
    const subscription: ConversationPresenceSubscription = {
      updates: queue,
      close: () => queue.close(),
    };
    return { status: "subscribed", subscription };
  }

  appendAuthoritative(payload: ConversationEventPayload, broadcast = true): ConversationEvent {
    const revision = (this.events.length + 1) as ConversationRevision;
    const event = parseConversationEvent({
      version: CONVERSATION_EVENT_VERSION,
      event_id: `authority-${revision}`,
      conversation_id: conversationId,
      revision,
      occurred_at: `2026-08-27T13:00:${String(revision).padStart(2, "0")}.000Z`,
      actor: { type: "assistant" },
      source: { type: "runtime" },
      payload,
    });
    const previous = this.latestRevision();
    this.store(event);
    if (broadcast) this.broadcast(this.eventsSince(previous));
    return event;
  }

  broadcastDuplicate(): void {
    this.broadcast(this.eventsSince(null));
  }

  broadcastOnly(event: ConversationEvent): void {
    this.broadcast({
      status: "events",
      events: [event],
      revision: event.revision,
      latestRevision: this.latestRevision(),
      hasMore: false,
    });
  }

  requireSnapshot(reason: "compacted" | "revision_gap" = "compacted"): void {
    this.broadcast({
      status: "snapshot_required",
      reason,
      latestRevision: this.latestRevision(),
    });
  }

  disconnect(): void {
    this.online = false;
    this.broadcast(unavailable());
  }

  private store(event: ConversationEvent): void {
    this.events.push(event);
    if (event.mutation_id !== undefined) {
      this.mutations.set(event.mutation_id, [event]);
    }
  }

  private latestRevision(): ConversationRevision | null {
    return this.events.at(-1)?.revision ?? null;
  }

  private eventsSince(
    revision: ConversationRevision | null,
  ): ConversationSyncEvents {
    const events = this.events.filter((event) => event.revision > (revision ?? 0));
    return {
      status: "events",
      events,
      revision: events.at(-1)?.revision ?? revision,
      latestRevision: this.latestRevision(),
      hasMore: false,
    };
  }

  private broadcast(update: ConversationSyncUpdate): void {
    for (const subscriber of this.subscribers) subscriber.push(update);
  }
}

function unavailable() {
  return {
    status: "temporarily_unavailable" as const,
    message: "offline",
    retryAfterMilliseconds: 1,
  };
}

function cloneJson(value: unknown): ConversationJsonValue {
  return JSON.parse(JSON.stringify(value)) as ConversationJsonValue;
}

function project(events: readonly ConversationEvent[]): ConversationState {
  return events.reduce(
    reduceConversationEvent,
    createInitialConversationState(conversationId),
  );
}

function mutation(
  id: string,
  device: string,
  message: string,
): ConversationSyncMutation {
  const mutationId = id as ConversationClientMutationId;
  const event = parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: `event-${id}`,
    conversation_id: conversationId,
    revision: 1,
    occurred_at: "2026-08-27T12:00:00.000Z",
    actor: { type: "user" },
    source: { type: "client", client_id: `client-${device}`, device_id: device },
    mutation_id: mutationId,
    payload: {
      type: "message.created",
      message_id: `message-${id}`,
      role: "user",
      content: [{ type: "text", text: message }],
    },
  });
  return { mutationId, events: [event] } as ConversationSyncMutation;
}

function coordinator(
  adapter: FakeAuthoritativeAdapter,
  eventStore = new InMemoryConversationEventStore(),
  clock = new ManualClock(),
) {
  return {
    clock,
    eventStore,
    coordinator: createConversationSyncCoordinator({
      conversationId,
      adapter,
      eventStore,
      clock,
      backoff: () => 1,
    }),
  };
}

describe("createConversationSyncCoordinator", () => {
  it("hydrates local durable state before catch-up and subscription", async () => {
    const initial = parseConversationEvent({
      version: 1,
      event_id: "local-title",
      conversation_id: conversationId,
      revision: 1,
      occurred_at: "2026-08-27T12:00:00.000Z",
      actor: { type: "assistant" },
      source: { type: "runtime" },
      payload: { type: "conversation.title_updated", title: "Hydrated" },
    });
    const eventStore = new InMemoryConversationEventStore();
    await eventStore.append({ conversationId, expectedRevision: null, events: [initial] });
    const adapter = new FakeAuthoritativeAdapter([initial]);
    const sync = coordinator(adapter, eventStore).coordinator;

    await sync.start();

    expect(sync.getState()).toMatchObject({ status: "online", revision: 1 });
    expect(sync.store.getSnapshot()).toMatchObject({ title: "Hydrated", revision: 1 });
    expect(adapter.activeSubscriptions).toBe(1);
    await sync.destroy();
  });

  it("converges two independently stored devices after concurrent sends", async () => {
    const adapter = new FakeAuthoritativeAdapter();
    const first = coordinator(adapter).coordinator;
    const second = coordinator(adapter).coordinator;
    await Promise.all([first.start(), second.start()]);

    await Promise.all([
      first.queueMutation(mutation("one", "a", "First")),
      second.queueMutation(mutation("two", "b", "Second")),
    ]);

    await vi.waitFor(() => {
      expect(first.store.getSnapshot().revision).toBe(2);
      expect(second.store.getSnapshot().revision).toBe(2);
    });
    const expected = project(adapter.events);
    expect(first.store.getSnapshot()).toEqual(expected);
    expect(second.store.getSnapshot()).toEqual(expected);
    expect(adapter.events.map((event) => event.event_id)).toEqual([
      "event-one",
      "event-two",
    ]);
    expect(first.store.getSnapshot().messages).toHaveLength(2);
    await Promise.all([first.destroy(), second.destroy()]);
  });

  it("retains optimistic mutations across disconnect and deterministic reconnect", async () => {
    const adapter = new FakeAuthoritativeAdapter();
    const setup = coordinator(adapter);
    await setup.coordinator.start();
    adapter.disconnect();
    await vi.waitFor(() => {
      expect(setup.coordinator.getState().status).toBe("reconnecting");
    });

    await setup.coordinator.queueMutation(mutation("offline", "a", "Queued"));
    expect(setup.coordinator.getState().pendingMutationCount).toBe(1);
    expect(setup.coordinator.store.getSnapshot().messages).toHaveLength(1);

    adapter.online = true;
    setup.clock.advanceAll();
    await vi.waitFor(() => {
      expect(setup.coordinator.getState()).toMatchObject({
        status: "online",
        pendingMutationCount: 0,
        revision: 1,
      });
    });
    expect(adapter.events).toHaveLength(1);
    await setup.coordinator.destroy();
  });

  it("ignores duplicated remote delivery without duplicating rich projections", async () => {
    const adapter = new FakeAuthoritativeAdapter();
    const setup = coordinator(adapter);
    await setup.coordinator.start();
    adapter.appendAuthoritative({
      type: "turn.started",
      turn_id: "turn-1" as never,
      input_message_ids: ["message-user" as never],
    });
    adapter.appendAuthoritative({
      type: "tool_call.requested",
      turn_id: "turn-1" as never,
      tool_call_id: "tool-1" as never,
      name: "lookup",
      arguments: { value: 1 },
    });
    adapter.appendAuthoritative({
      type: "tool_call.result_recorded",
      turn_id: "turn-1" as never,
      tool_call_id: "tool-1" as never,
      content: [{ type: "json", value: { answer: 42 } }],
      is_error: false,
    });
    adapter.appendAuthoritative({
      type: "usage.receipt_linked",
      turn_id: "turn-1" as never,
      usage_receipt_id: "receipt-1" as never,
    });
    await vi.waitFor(() => expect(setup.coordinator.store.getSnapshot().revision).toBe(4));

    adapter.broadcastDuplicate();
    adapter.broadcastDuplicate();
    await setup.coordinator.flush();

    const state = setup.coordinator.store.getSnapshot();
    expect(state.processed_event_ids).toHaveLength(4);
    expect(state.tool_calls).toHaveLength(1);
    expect(state.tool_calls[0]?.result).not.toBeNull();
    expect(state.usage_receipt_links).toHaveLength(1);
    await setup.coordinator.destroy();
  });

  it("resnapshots on an out-of-order revision gap and on compaction", async () => {
    const adapter = new FakeAuthoritativeAdapter();
    const setup = coordinator(adapter);
    await setup.coordinator.start();
    adapter.appendAuthoritative({
      type: "conversation.title_updated",
      title: "First",
    }, false);
    const second = adapter.appendAuthoritative({
      type: "conversation.metadata_updated",
      metadata: { caught_up: true },
    }, false);
    adapter.broadcastOnly(second);
    await vi.waitFor(() => expect(setup.coordinator.store.getSnapshot().revision).toBe(2));
    expect(adapter.snapshotPulls).toBe(1);

    adapter.appendAuthoritative({
      type: "conversation.title_updated",
      title: "After compaction",
    }, false);
    adapter.compactedThrough = 3 as ConversationRevision;
    adapter.requireSnapshot();
    await vi.waitFor(() => expect(setup.coordinator.store.getSnapshot().revision).toBe(3));
    expect(adapter.snapshotPulls).toBe(2);
    expect(setup.coordinator.store.getSnapshot().title).toBe("After compaction");
    await setup.coordinator.destroy();
  });

  it("drops non-retryable rejected mutations and reports the rejection", async () => {
    const adapter = new FakeAuthoritativeAdapter();
    adapter.rejectAppends = true;
    const rejected = vi.fn();
    const sync = createConversationSyncCoordinator({
      conversationId,
      adapter,
      eventStore: new InMemoryConversationEventStore(),
      onMutationRejected: rejected,
    });
    await sync.start();

    await sync.queueMutation(mutation("rejected", "a", "No"));

    expect(sync.getState()).toMatchObject({
      status: "error",
      pendingMutationCount: 0,
      revision: null,
    });
    expect(sync.store.getSnapshot().messages).toHaveLength(0);
    expect(rejected).toHaveBeenCalledOnce();
    expect(rejected.mock.calls[0]?.[0]).toMatchObject({
      mutation: { mutationId: "rejected" },
      failure: { status: "unauthorized" },
    });
    await sync.destroy();
  });

  it("stops and destroys idempotently without post-shutdown updates", async () => {
    const adapter = new FakeAuthoritativeAdapter();
    const setup = coordinator(adapter);
    const statusListener = vi.fn();
    setup.coordinator.subscribe(statusListener);
    await setup.coordinator.start();

    await setup.coordinator.stop();
    await setup.coordinator.stop();
    expect(setup.coordinator.getState().status).toBe("offline");
    expect(adapter.activeSubscriptions).toBe(0);
    const snapshot = setup.coordinator.store.getSnapshot();
    adapter.appendAuthoritative({
      type: "conversation.title_updated",
      title: "Too late",
    });
    await Promise.resolve();
    expect(setup.coordinator.store.getSnapshot()).toBe(snapshot);

    await setup.coordinator.destroy();
    await setup.coordinator.destroy();
    await expect(
      setup.coordinator.queueMutation(mutation("late", "a", "Late")),
    ).rejects.toBeInstanceOf(ConversationSyncCoordinatorDestroyedError);
  });
});
