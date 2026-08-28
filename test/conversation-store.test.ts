import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  CONVERSATION_EVENT_VERSION,
  ConversationStoreDestroyedError,
  createConversationStore,
  parseConversationEvent,
  type ConversationEvent,
  type ConversationState,
} from "../src/index.js";

interface EventOptions {
  readonly revision: number;
  readonly title: string | null;
  readonly conversationId?: string;
  readonly eventId?: string;
  readonly mutationId?: string;
}

function titleEvent(options: EventOptions): ConversationEvent {
  return parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: options.eventId ?? `event_${options.revision}`,
    conversation_id: options.conversationId ?? "conversation_01",
    revision: options.revision,
    occurred_at: `2026-08-27T12:00:${String(options.revision).padStart(2, "0")}.000Z`,
    actor: { type: options.mutationId === undefined ? "assistant" : "user" },
    source:
      options.mutationId === undefined
        ? { type: "runtime" }
        : { type: "client", client_id: "client_01" },
    ...(options.mutationId === undefined
      ? {}
      : { mutation_id: options.mutationId }),
    payload: { type: "conversation.title_updated", title: options.title },
  });
}

describe("createConversationStore", () => {
  it("serializes concurrent asynchronous application calls in invocation order", async () => {
    const store = createConversationStore();

    const first = store.applyEvent(titleEvent({ revision: 1, title: "One" }));
    const second = store.applyEvent(titleEvent({ revision: 2, title: "Two" }));
    const third = store.applyEvent(titleEvent({ revision: 3, title: "Three" }));

    expect(store.getSnapshot().revision).toBeNull();
    const snapshots = await Promise.all([first, second, third]);

    expect(snapshots.map((snapshot) => snapshot.revision)).toEqual([1, 2, 3]);
    expect(store.getSnapshot()).toBe(snapshots[2]);
    expect(store.getSnapshot()).toMatchObject({
      revision: 3,
      title: "Three",
      processed_event_ids: ["event_1", "event_2", "event_3"],
      replay_error: null,
    });
  });

  it("reduces an ordered batch through a single notification boundary", async () => {
    const store = createConversationStore();
    const listener = vi.fn();
    store.subscribe(listener);

    const snapshot = await store.applyEvents([
      titleEvent({ revision: 1, title: "One" }),
      titleEvent({ revision: 2, title: "Two" }),
      titleEvent({ revision: 3, title: "Three" }),
    ]);

    expect(snapshot.processed_event_ids).toEqual([
      "event_1",
      "event_2",
      "event_3",
    ]);
    expect(snapshot.title).toBe("Three");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not notify for duplicate event or mutation identities", async () => {
    const store = createConversationStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const original = titleEvent({
      revision: 1,
      title: "Original",
      eventId: "event_original",
      mutationId: "mutation_stable",
    });

    const accepted = await store.applyEvent(original);
    const duplicateEvent = await store.applyEvent(original);
    const duplicateMutation = await store.applyEvent(
      titleEvent({
        revision: 2,
        title: "Must not apply",
        eventId: "event_regenerated",
        mutationId: "mutation_stable",
      }),
    );

    expect(duplicateEvent).toBe(accepted);
    expect(duplicateMutation).toBe(accepted);
    expect(store.getSnapshot().title).toBe("Original");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("supports ordinary and equality-aware selector notifications", async () => {
    const store = createConversationStore();
    const ordinary = vi.fn();
    const selected = vi.fn();
    const caseInsensitive = vi.fn();
    store.subscribe(ordinary);
    store.select((snapshot) => snapshot.title, selected);
    store.select(
      (snapshot) => snapshot.title,
      caseInsensitive,
      (left, right) => left?.toLowerCase() === right?.toLowerCase(),
    );

    expect(store.select((snapshot) => snapshot.title)).toBeNull();
    await store.applyEvent(titleEvent({ revision: 1, title: "Hello" }));
    await store.applyEvent(titleEvent({ revision: 2, title: "hello" }));

    expect(ordinary).toHaveBeenCalledTimes(2);
    expect(selected).toHaveBeenNthCalledWith(1, "Hello", null);
    expect(selected).toHaveBeenNthCalledWith(2, "hello", "Hello");
    expect(caseInsensitive).toHaveBeenCalledOnce();
    expect(caseInsensitive).toHaveBeenCalledWith("Hello", null);
  });

  it("makes ordinary and selector unsubscribe cleanup idempotent", async () => {
    const store = createConversationStore();
    const ordinary = vi.fn();
    const selected = vi.fn();
    const unsubscribe = store.subscribe(ordinary);
    const unsubscribeSelected = store.select(
      (snapshot) => snapshot.revision,
      selected,
    );

    unsubscribe();
    unsubscribe();
    unsubscribeSelected();
    unsubscribeSelected();
    await store.applyEvent(titleEvent({ revision: 1, title: "Silent" }));

    expect(ordinary).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
  });

  it("destroys idempotently, clears observers, and rejects queued or later work", async () => {
    const store = createConversationStore();
    const ordinary = vi.fn();
    const selected = vi.fn();
    store.subscribe(ordinary);
    store.select((snapshot) => snapshot.title, selected);

    const queuedFirst = store.applyEvent(
      titleEvent({ revision: 1, title: "Queued one" }),
    );
    const queuedSecond = store.applyEvent(
      titleEvent({ revision: 2, title: "Queued two" }),
    );
    store.destroy();
    store.destroy();

    await expect(queuedFirst).rejects.toBeInstanceOf(
      ConversationStoreDestroyedError,
    );
    await expect(queuedSecond).rejects.toBeInstanceOf(
      ConversationStoreDestroyedError,
    );
    await expect(
      store.applyEvent(titleEvent({ revision: 1, title: "Late" })),
    ).rejects.toBeInstanceOf(ConversationStoreDestroyedError);
    expect(() => store.subscribe(() => undefined)).toThrow(
      ConversationStoreDestroyedError,
    );
    expect(() =>
      store.select((snapshot) => snapshot.title, () => undefined),
    ).toThrow(ConversationStoreDestroyedError);
    expect(store.getSnapshot().revision).toBeNull();
    expect(ordinary).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
  });

  it("exposes stable deeply immutable readonly snapshots", async () => {
    const store = createConversationStore();
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    expectTypeOf(initial).toEqualTypeOf<ConversationState>();

    const snapshot = await store.applyEvent(
      titleEvent({ revision: 1, title: "Immutable" }),
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.processed_event_ids)).toBe(true);
    expect(Object.isFrozen(snapshot.metadata)).toBe(true);
    const selectedMessages = store.select((current) => current.messages);
    expectTypeOf(selectedMessages).toEqualTypeOf<ConversationState["messages"]>();
    expect(Object.isFrozen(selectedMessages)).toBe(true);
    expect(() => {
      Object.defineProperty(snapshot.processed_event_ids, "0", {
        value: "event_mutation",
      });
    }).toThrow(TypeError);
    expect(store.getSnapshot()).toBe(snapshot);
  });

  it("keeps stores for different conversations completely isolated", async () => {
    const first = createConversationStore();
    const second = createConversationStore();
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.subscribe(firstListener);
    second.subscribe(secondListener);

    await Promise.all([
      first.applyEvent(
        titleEvent({
          revision: 1,
          title: "First",
          conversationId: "conversation_first",
        }),
      ),
      second.applyEvent(
        titleEvent({
          revision: 1,
          title: "Second",
          conversationId: "conversation_second",
        }),
      ),
    ]);

    expect(first.getSnapshot()).toMatchObject({
      conversation_id: "conversation_first",
      title: "First",
    });
    expect(second.getSnapshot()).toMatchObject({
      conversation_id: "conversation_second",
      title: "Second",
    });
    expect(first.getSnapshot()).not.toBe(second.getSnapshot());
    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).toHaveBeenCalledOnce();
  });
});
