import { describe, expect, it } from "vitest";

import {
  CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
  CONVERSATION_EVENT_VERSION,
  ConversationReplayFailure,
  InMemoryConversationEventStore,
  createInitialConversationState,
  parseConversationEvent,
  reduceConversationEvent,
  replayConversation,
  shouldWriteConversationCheckpoint,
  type ConversationEvent,
  type ConversationEventCheckpoint,
  type ConversationEventCursor,
  type ConversationEventStore,
  type ConversationId,
  type ConversationJsonValue,
  type ConversationState,
  type StoredConversationEvent,
} from "../src/index.js";

const conversationId = "conversation-replay" as ConversationId;

interface EventOptions {
  readonly revision: number;
  readonly eventId?: string;
  readonly mutationId?: string;
  readonly payload?: Record<string, unknown>;
}

function event(options: EventOptions): ConversationEvent {
  return parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: options.eventId ?? `event-${options.revision}`,
    conversation_id: conversationId,
    revision: options.revision,
    occurred_at: `2026-08-27T12:00:${String(options.revision).padStart(2, "0")}Z`,
    actor: { type: options.mutationId === undefined ? "assistant" : "user" },
    source: options.mutationId === undefined
      ? { type: "runtime" }
      : { type: "client", client_id: "client-replay" },
    ...(options.mutationId === undefined ? {} : { mutation_id: options.mutationId }),
    payload: options.payload ?? {
      type: "conversation.metadata_updated",
      metadata: { revision: options.revision },
    },
  });
}

const history = [
  event({
    revision: 1,
    mutationId: "mutation-message",
    payload: {
      type: "message.created",
      message_id: "message-user",
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    },
  }),
  event({
    revision: 2,
    payload: {
      type: "turn.started",
      turn_id: "turn-replay",
      input_message_ids: ["message-user"],
    },
  }),
  event({
    revision: 3,
    payload: {
      type: "turn.status_changed",
      turn_id: "turn-replay",
      status: "running",
    },
  }),
  event({
    revision: 4,
    payload: {
      type: "message.created",
      message_id: "message-assistant",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
    },
  }),
  event({
    revision: 5,
    payload: {
      type: "turn.completed",
      turn_id: "turn-replay",
      outcome: "stop",
      output_message_ids: ["message-assistant"],
    },
  }),
] as const;

function reduce(events: readonly ConversationEvent[]): ConversationState {
  return events.reduce(
    reduceConversationEvent,
    createInitialConversationState(conversationId),
  );
}

async function append(
  store: InMemoryConversationEventStore,
  events: readonly ConversationEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await store.append({ conversationId, expectedRevision: null, events });
}

function checkpoint(
  state: ConversationState,
  overrides: Partial<ConversationEventCheckpoint> = {},
): ConversationEventCheckpoint {
  return {
    conversationId,
    schemaVersion: CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
    revision: state.revision!,
    state: JSON.parse(JSON.stringify(state)) as ConversationJsonValue,
    ...overrides,
  };
}

function cursor(value: string): ConversationEventCursor {
  return value as ConversationEventCursor;
}

function entry(
  durableEvent: ConversationEvent,
  durableCursor = cursor(`cursor-${durableEvent.revision}`),
): StoredConversationEvent {
  return { cursor: durableCursor, event: durableEvent };
}

describe("replayConversation", () => {
  it("hydrates an empty history", async () => {
    const result = await replayConversation({
      conversationId,
      eventStore: new InMemoryConversationEventStore(),
    });

    expect(result.state).toEqual(createInitialConversationState(conversationId));
    expect(result.checkpointStatus).toBe("absent");
    expect(result.lastRevision).toBeNull();
    expect(result.replayedEventCount).toBe(0);
  });

  it("fully replays ordered history into the headless store", async () => {
    const eventStore = new InMemoryConversationEventStore();
    await append(eventStore, history);

    const result = await replayConversation({ conversationId, eventStore });

    expect(result.state).toEqual(reduce(history));
    expect(result.store.getSnapshot()).toBe(result.state);
    expect(result.replayedEventCount).toBe(history.length);
    expect(result.lastRevision).toBe(5);
  });

  it("loads a valid checkpoint and folds only its ordered tail", async () => {
    const eventStore = new InMemoryConversationEventStore();
    await append(eventStore, history);
    const checkpointState = reduce(history.slice(0, 3));
    await eventStore.checkpoints.write(checkpoint(checkpointState));

    const result = await replayConversation({ conversationId, eventStore });

    expect(result.checkpointStatus).toBe("used");
    expect(result.replayedEventCount).toBe(2);
    expect(result.state).toEqual(reduce(history));
  });

  it.each([
    {
      name: "legacy checkpoint without a schema version",
      alter: (valid: ConversationEventCheckpoint): ConversationEventCheckpoint => ({
        conversationId: valid.conversationId,
        revision: valid.revision,
        state: valid.state,
      }),
    },
    {
      name: "incompatible checkpoint schema",
      alter: (valid: ConversationEventCheckpoint): ConversationEventCheckpoint => ({
        ...valid,
        schemaVersion: 99,
      }),
    },
    {
      name: "stale checkpoint revision metadata",
      alter: (valid: ConversationEventCheckpoint): ConversationEventCheckpoint => ({
        ...valid,
        revision: 2 as ConversationEventCheckpoint["revision"],
      }),
    },
    {
      name: "malformed checkpoint state",
      alter: (valid: ConversationEventCheckpoint): ConversationEventCheckpoint => ({
        ...valid,
        state: { conversation_id: conversationId, revision: 3 },
      }),
    },
  ])("falls back to full replay for $name", async ({ alter }) => {
    const backing = new InMemoryConversationEventStore();
    await append(backing, history);
    const valid = checkpoint(reduce(history.slice(0, 3)));
    const eventStore: ConversationEventStore = {
      append: (input) => backing.append(input),
      read: (input) => backing.read(input),
      getLatestRevision: (id) => backing.getLatestRevision(id),
      checkpoints: {
        read: async () => alter(valid),
        write: (value) => backing.checkpoints.write(value),
      },
    };

    const result = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: false,
    });

    expect(result.checkpointStatus).toBe("invalid");
    expect(result.replayedEventCount).toBe(history.length);
    expect(result.state).toEqual(reduce(history));
  });

  it("ignores duplicate tail event and mutation identities", async () => {
    const first = history[0];
    const second = history[1];
    const checkpointState = reduce([first]);
    const duplicateMutation = event({
      revision: 1,
      eventId: "duplicate-event-id",
      mutationId: "mutation-message",
      payload: first.payload as unknown as Record<string, unknown>,
    });
    const eventStore: ConversationEventStore = {
      async append() { throw new Error("not used"); },
      async getLatestRevision() { return second.revision; },
      checkpoints: {
        async read() { return checkpoint(checkpointState); },
        async write(value) { return { status: "written", checkpoint: value }; },
      },
      async read() {
        return {
          entries: [entry(first, cursor("duplicate-event")), entry(duplicateMutation, cursor("duplicate-mutation")), entry(second)],
          nextCursor: cursor("cursor-2"),
          latestRevision: second.revision,
          hasMore: false,
        };
      },
    };

    const result = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: false,
    });

    expect(result.duplicateEventCount).toBe(2);
    expect(result.replayedEventCount).toBe(1);
    expect(result.state).toEqual(reduce([first, second]));
  });

  it("reports revision gaps with the last safe durable position", async () => {
    const first = event({ revision: 1 });
    const third = event({ revision: 3 });
    const eventStore = fixedReadStore([entry(first), entry(third)]);

    await expect(replayConversation({ conversationId, eventStore })).rejects.toMatchObject({
      name: "ConversationReplayFailure",
      code: "revision_gap",
      lastSafeCursor: cursor("cursor-1"),
      lastSafeRevision: 1,
      eventCursor: cursor("cursor-3"),
      expectedRevision: 2,
      receivedRevision: 3,
    });
  });

  it("reports corrupt events with the last safe durable position", async () => {
    const first = event({ revision: 1 });
    const corrupt = {
      ...event({ revision: 2 }),
      payload: { type: "unsupported.future_event" },
    } as unknown as ConversationEvent;
    const eventStore = fixedReadStore([entry(first), entry(corrupt)]);

    await expect(replayConversation({ conversationId, eventStore })).rejects.toEqual(
      expect.objectContaining({
        name: "ConversationReplayFailure",
        code: "corrupt_event",
        lastSafeCursor: cursor("cursor-1"),
        lastSafeRevision: 1,
        eventCursor: cursor("cursor-2"),
      }),
    );
  });

  it("retains an interrupted active turn when the durable log ends", async () => {
    const activeHistory = history.slice(0, 3);
    const eventStore = new InMemoryConversationEventStore();
    await append(eventStore, activeHistory);

    const result = await replayConversation({ conversationId, eventStore });

    expect(result.state.active_turn_id).toBe("turn-replay");
    expect(result.state.turns[0]?.status).toBe("running");
    expect(result.state.turns[0]?.terminal_at).toBeNull();
  });

  it("writes an eligible versioned checkpoint through the atomic store capability", async () => {
    const eventStore = new InMemoryConversationEventStore();
    await append(eventStore, history.slice(0, 2));

    const result = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: { eventCount: 2 },
    });
    const stored = await eventStore.checkpoints.read(conversationId);

    expect(result.checkpointWrite?.status).toBe("written");
    expect(stored).toMatchObject({
      conversationId,
      schemaVersion: CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
      revision: 2,
      state: result.state,
    });
    expect(
      shouldWriteConversationCheckpoint(
        { eventsSinceCheckpoint: 0, serializedBytes: 9 },
        { serializedBytes: 9 },
      ),
    ).toBe(true);
  });

  it("atomically upgrades current-revision legacy checkpoint metadata", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const events = history.slice(0, 2);
    await append(eventStore, events);
    const state = reduce(events);
    const legacy = checkpoint(state);
    await eventStore.checkpoints.write({
      conversationId: legacy.conversationId,
      revision: legacy.revision,
      state: legacy.state,
    });

    const result = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: { eventCount: 1 },
    });

    expect(result.checkpointStatus).toBe("invalid");
    expect(result.checkpointWrite?.status).toBe("written");
    expect(await eventStore.checkpoints.read(conversationId)).toMatchObject({
      schemaVersion: CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
      revision: 2,
    });
  });

  it("exposes replay failures as an Error subtype", () => {
    const failure = new ConversationReplayFailure("corrupt", {
      code: "corrupt_event",
      conversationId,
      lastSafeCursor: null,
      lastSafeRevision: null,
      eventCursor: null,
    });
    expect(failure).toBeInstanceOf(Error);
  });
});

function fixedReadStore(
  entries: readonly StoredConversationEvent[],
): ConversationEventStore {
  return {
    async append() { throw new Error("not used"); },
    async getLatestRevision() {
      return entries.at(-1)?.event.revision ?? null;
    },
    async read() {
      return {
        entries,
        nextCursor: entries.at(-1)?.cursor ?? null,
        latestRevision: entries.at(-1)?.event.revision ?? null,
        hasMore: false,
      };
    },
  };
}
