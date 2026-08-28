import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseConversationEvent,
  parsePresenceRecord,
  type AppendMutationsInput,
  type AppendMutationsResult,
  type ConversationEvent,
  type ConversationId,
  type ConversationPresenceStreamUpdate,
  type ConversationPresenceSubscription,
  type ConversationRevision,
  type ConversationSyncAdapter,
  type ConversationSyncEvents,
  type ConversationSyncMutation,
  type ConversationSyncOperationFailure,
  type ConversationSyncSubscription,
  type ConversationSyncMutationEvent,
  type ConversationSyncUpdate,
  type PresenceRecord,
  type PublishPresenceInput,
  type PublishPresenceResult,
  type PullSnapshotInput,
  type PullSnapshotResult,
  type ReadSinceInput,
  type ReadSinceResult,
  type SubscribePresenceInput,
  type SubscribePresenceResult,
  type SubscribeSinceInput,
  type SubscribeSinceResult,
} from "../src/index.js";

type SnapshotState = { event_count: number };

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const reader = this.readers.shift();
    if (reader === undefined) this.values.push(value);
    else reader({ done: false, value });
  }

  close(): void {
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

class FakeConversationSyncAdapter
  implements ConversationSyncAdapter<SnapshotState>
{
  private readonly events: ConversationEvent[];
  private readonly mutations = new Map<string, readonly ConversationEvent[]>();
  private readonly eventSubscribers = new Set<AsyncQueue<ConversationSyncUpdate>>();
  private readonly presenceSubscribers = new Set<
    AsyncQueue<ConversationPresenceStreamUpdate>
  >();
  private compactedThrough: ConversationRevision | null = null;

  constructor(initialEvent: ConversationEvent) {
    this.events = [initialEvent];
    this.mutations.set(initialEvent.mutation_id!, [initialEvent]);
  }

  compactThrough(revision: ConversationRevision): void {
    this.compactedThrough = revision;
  }

  async pullSnapshot(
    input: PullSnapshotInput,
  ): Promise<PullSnapshotResult<SnapshotState>> {
    return {
      status: "snapshot",
      snapshot: {
        conversationId: input.conversationId,
        revision: this.latestRevision(),
        state: { event_count: this.events.length },
      },
    };
  }

  async readSince(input: ReadSinceInput): Promise<ReadSinceResult> {
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

    const actualRevision = this.latestRevision();
    if (input.expectedRevision !== actualRevision) {
      return {
        status: "conflict",
        expectedRevision: input.expectedRevision,
        actualRevision,
      };
    }

    const acknowledgements = input.mutations.map((mutation) => {
      this.events.push(...mutation.events);
      this.mutations.set(mutation.mutationId, mutation.events);
      return {
        status: "accepted" as const,
        mutationId: mutation.mutationId,
        events: mutation.events,
      };
    });
    const update = this.eventsSince(actualRevision);
    for (const subscriber of this.eventSubscribers) subscriber.push(update);
    return {
      status: "mutations",
      acknowledgements,
      latestRevision: this.latestRevision()!,
    };
  }

  async subscribeSince(
    input: SubscribeSinceInput,
  ): Promise<SubscribeSinceResult> {
    const initial = await this.readSince(input);
    if (initial.status !== "events") return initial;

    const queue = new AsyncQueue<ConversationSyncUpdate>();
    if (initial.events.length > 0) queue.push(initial);
    this.eventSubscribers.add(queue);
    const subscription: ConversationSyncSubscription = {
      updates: queue,
      close: () => {
        this.eventSubscribers.delete(queue);
        queue.close();
      },
    };
    return { status: "subscribed", subscription };
  }

  async publishPresence(
    input: PublishPresenceInput,
  ): Promise<PublishPresenceResult> {
    for (const subscriber of this.presenceSubscribers) {
      subscriber.push({ status: "presence", record: input.record });
    }
    return { status: "published", record: input.record };
  }

  async subscribePresence(
    input: SubscribePresenceInput,
  ): Promise<SubscribePresenceResult> {
    expect(input.conversationId).toBe(this.events[0]?.conversation_id);
    const queue = new AsyncQueue<ConversationPresenceStreamUpdate>();
    this.presenceSubscribers.add(queue);
    const subscription: ConversationPresenceSubscription = {
      updates: queue,
      close: () => {
        this.presenceSubscribers.delete(queue);
        queue.close();
      },
    };
    return { status: "subscribed", subscription };
  }

  durableEvents(): readonly ConversationEvent[] {
    return this.events;
  }

  private latestRevision(): ConversationRevision | null {
    return this.events.at(-1)?.revision ?? null;
  }

  private eventsSince(
    afterRevision: ConversationRevision | null,
  ): ConversationSyncEvents {
    const events = this.events.filter(
      (event) => event.revision > (afterRevision ?? 0),
    );
    return {
      status: "events",
      events,
      revision: events.at(-1)?.revision ?? afterRevision,
      latestRevision: this.latestRevision(),
      hasMore: false,
    };
  }
}

function event(
  revision: number,
  mutationId: string,
): ConversationSyncMutationEvent {
  return parseConversationEvent({
    version: 1,
    event_id: `event-${revision}`,
    conversation_id: "conversation-sync",
    revision,
    occurred_at: `2026-08-27T12:00:0${revision}.000Z`,
    actor: { type: "user", id: "user-1" },
    source: { type: "client", client_id: "client-1", device_id: "device-1" },
    mutation_id: mutationId,
    payload: {
      type: "conversation.metadata_updated",
      metadata: { step: revision },
    },
  }) as ConversationSyncMutationEvent;
}

function presence(): PresenceRecord {
  return parsePresenceRecord({
    participant_id: "user-1",
    device_id: "device-1",
    session_id: "session-1",
    participant_kind: "human",
    state: "active",
    typing: true,
    updated_at: "2026-08-27T12:01:00.000Z",
    expires_at: "2026-08-27T12:02:00.000Z",
    typing_expires_at: "2026-08-27T12:01:05.000Z",
  });
}

function expectJsonData(value: unknown): void {
  expect(() => JSON.stringify(value)).not.toThrow();
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
  expect(JSON.stringify(value)).not.toMatch(
    /authorization|billing|database|handrail_attribution|http|metering|request_headers|server_context|sse|websocket/i,
  );
}

describe("ConversationSyncAdapter contract", () => {
  it("supports snapshot, catch-up, idempotency, conflict, compaction, and live updates", async () => {
    const initial = event(1, "mutation-1");
    const adapter: ConversationSyncAdapter<SnapshotState> =
      new FakeConversationSyncAdapter(initial);
    const conversationId: ConversationId = initial.conversation_id;

    const snapshot = await adapter.pullSnapshot({ conversationId });
    expect(snapshot).toEqual({
      status: "snapshot",
      snapshot: {
        conversationId,
        revision: 1,
        state: { event_count: 1 },
      },
    });

    const second = event(2, "mutation-2");
    const accepted = await adapter.appendMutations({
      conversationId,
      expectedRevision: initial.revision,
      mutations: [{ mutationId: second.mutation_id!, events: [second] }],
    });
    expect(accepted).toMatchObject({
      status: "mutations",
      acknowledgements: [{ status: "accepted", mutationId: "mutation-2" }],
      latestRevision: 2,
    });

    const caughtUp = await adapter.readSince({
      conversationId,
      afterRevision: initial.revision,
    });
    expect(caughtUp).toEqual({
      status: "events",
      events: [second],
      revision: 2,
      latestRevision: 2,
      hasMore: false,
    });

    const duplicate = await adapter.appendMutations({
      conversationId,
      expectedRevision: initial.revision,
      mutations: [{ mutationId: second.mutation_id!, events: [second] }],
    });
    expect(duplicate).toMatchObject({
      status: "mutations",
      acknowledgements: [{ status: "duplicate", mutationId: "mutation-2" }],
      latestRevision: 2,
    });

    const third = event(3, "mutation-3");
    const conflict = await adapter.appendMutations({
      conversationId,
      expectedRevision: initial.revision,
      mutations: [{ mutationId: third.mutation_id!, events: [third] }],
    });
    expect(conflict).toEqual({
      status: "conflict",
      expectedRevision: 1,
      actualRevision: 2,
    });

    const fake = adapter as FakeConversationSyncAdapter;
    fake.compactThrough(initial.revision);
    const gap = await adapter.readSince({ conversationId, afterRevision: null });
    expect(gap).toEqual({
      status: "snapshot_required",
      reason: "compacted",
      latestRevision: 2,
    });
    const resnapshot = await adapter.pullSnapshot({ conversationId });
    expect(resnapshot).toMatchObject({
      status: "snapshot",
      snapshot: { revision: 2, state: { event_count: 2 } },
    });

    const subscribed = await adapter.subscribeSince({
      conversationId,
      afterRevision: second.revision,
    });
    expect(subscribed.status).toBe("subscribed");
    if (subscribed.status !== "subscribed") return;
    const nextDurable = subscribed.subscription.updates[Symbol.asyncIterator]().next();
    await adapter.appendMutations({
      conversationId,
      expectedRevision: second.revision,
      mutations: [{ mutationId: third.mutation_id!, events: [third] }],
    });
    await expect(nextDurable).resolves.toMatchObject({
      done: false,
      value: { status: "events", events: [third], latestRevision: 3 },
    });
    subscribed.subscription.close();

    for (const dto of [snapshot, accepted, caughtUp, duplicate, conflict, gap, resnapshot]) {
      expectJsonData(dto);
    }
  });

  it("keeps presence and typing on an ephemeral channel", async () => {
    const initial = event(1, "mutation-1");
    const adapter = new FakeConversationSyncAdapter(initial);
    const subscribed = await adapter.subscribePresence({
      conversationId: initial.conversation_id,
    });
    expect(subscribed.status).toBe("subscribed");
    if (subscribed.status !== "subscribed") return;

    const nextPresence =
      subscribed.subscription.updates[Symbol.asyncIterator]().next();
    const record = presence();
    const published = await adapter.publishPresence({
      conversationId: initial.conversation_id,
      record,
    });

    expect(published).toEqual({ status: "published", record });
    await expect(nextPresence).resolves.toEqual({
      done: false,
      value: { status: "presence", record },
    });
    expect(adapter.durableEvents()).toEqual([initial]);
    expect(adapter.durableEvents()).not.toContainEqual(
      expect.objectContaining({ typing: true }),
    );
    expectJsonData(published);
    subscribed.subscription.close();
  });

  it("requires exactly one event per mutation", () => {
    const proposed = event(2, "mutation-2");
    const mutation = {
      mutationId: proposed.mutation_id!,
      events: [proposed],
    } satisfies ConversationSyncMutation;

    const zeroEventMutation = {
      mutationId: proposed.mutation_id!,
      // @ts-expect-error A mutation must identify exactly one event/fact.
      events: [],
    } satisfies ConversationSyncMutation;
    const twoEventMutation = {
      mutationId: proposed.mutation_id!,
      // @ts-expect-error A mutation must not identify more than one event/fact.
      events: [proposed, proposed],
    } satisfies ConversationSyncMutation;

    expect(mutation.events).toEqual([proposed]);
    void zeroEventMutation;
    void twoEventMutation;
  });

  it("exports implementable interfaces and every explicit failure outcome", () => {
    const adapter: ConversationSyncAdapter<SnapshotState> =
      new FakeConversationSyncAdapter(event(1, "mutation-1"));
    expectTypeOf(adapter.pullSnapshot).toBeFunction();
    expectTypeOf(adapter.readSince).toBeFunction();
    expectTypeOf(adapter.appendMutations).toBeFunction();
    expectTypeOf(adapter.subscribeSince).toBeFunction();
    expectTypeOf(adapter.publishPresence).toBeFunction();
    expectTypeOf(adapter.subscribePresence).toBeFunction();

    const failures = [
      { status: "unauthorized", message: "denied" },
      {
        status: "temporarily_unavailable",
        message: "retry later",
        retryAfterMilliseconds: 1_000,
      },
    ] satisfies readonly ConversationSyncOperationFailure[];
    for (const failure of failures) expectJsonData(failure);
  });
});
