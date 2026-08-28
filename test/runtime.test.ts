import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  InMemoryConversationEventStore,
  createRetryPolicy,
  createConversationRuntime,
  type AppendConversationEventsInput,
  type AppendConversationEventsResult,
  type AuthoritativeAttribution,
  type ConversationClientId,
  type ConversationEventStore,
  type ConversationId,
  type ConversationRevision,
  type ConversationTransport,
  type ReadConversationEventsInput,
  type ReadConversationEventsResult,
  type ResumeTurnInput,
  type StartTurnInput,
  type StreamEvent,
  type TransportResult,
  type TransportError,
  type TurnHandle,
  type TurnObservation,
  type TurnObservationResult,
  type TurnResumePoint,
} from "../src/index.js";

interface FakeRequest {
  readonly prompt: string;
}

const conversationId = "conversation_runtime" as ConversationId;
const clientId = "client_runtime" as ConversationClientId;

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_runtime", source: "server_derived", trust: "authoritative" },
  project: { id: "project_runtime", source: "server_derived", trust: "authoritative" },
  service_environment: {
    id: "test",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

function frame(
  type: StreamEvent["type"],
  sequence: number,
  fields: Record<string, unknown> = {},
): unknown {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: "remote-turn-1",
    trace_id: "trace-runtime-1",
    sequence,
    ...fields,
  };
}

const startedFrame = () => frame("response.started", 0, { attribution });
const deltaFrame = (sequence: number, delta: string) =>
  frame("response.text.delta", sequence, { delta });
const completedFrame = (sequence: number, outcome = "stop") =>
  frame("response.completed", sequence, { outcome });

function checkpointFor(raw: unknown): TurnResumePoint {
  const event = raw as { request_id: string; sequence: number };
  const id = `${event.request_id}:${event.sequence}`;
  return {
    lastAppliedEventId: id,
    lastAppliedCursor: id,
    lastAppliedRevision: event.sequence,
  };
}

function observation(
  frames: readonly unknown[],
  status: TurnObservationResult["status"],
): TurnObservation<unknown> {
  let disconnected = false;
  let settled = false;
  let resolveResult!: (result: TurnObservationResult) => void;
  let checkpoint: TurnResumePoint = {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  };
  const result = new Promise<TurnObservationResult>((resolve) => {
    resolveResult = resolve;
  });
  const settle = (next: TurnObservationResult): void => {
    if (settled) return;
    settled = true;
    resolveResult(next);
  };
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const value of frames) {
          if (disconnected) return;
          const candidate = value as { request_id?: unknown; sequence?: unknown };
          if (
            typeof candidate.request_id === "string" &&
            typeof candidate.sequence === "number"
          ) {
            checkpoint = checkpointFor(value);
          }
          yield value;
        }
        if (status === "failed") {
          settle({
            status: "failed",
            checkpoint,
            error: { code: "internal_error", message: "failed", retryable: false },
          });
        } else {
          settle({ status, checkpoint } as TurnObservationResult);
        }
      },
    },
    result,
    disconnect() {
      disconnected = true;
      settle({ status: "disconnected", checkpoint });
    },
  };
}

function pausableObservation(
  framesBeforePause: readonly unknown[],
  framesAfterPause: readonly unknown[],
  status: TurnObservationResult["status"],
): {
  readonly observation: TurnObservation<unknown>;
  readonly paused: Promise<void>;
  readonly release: () => void;
} {
  let disconnected = false;
  let settled = false;
  let resolveResult!: (result: TurnObservationResult) => void;
  let markPaused!: () => void;
  let releasePause!: () => void;
  let checkpoint: TurnResumePoint = {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  };
  const result = new Promise<TurnObservationResult>((resolve) => {
    resolveResult = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  const settle = (next: TurnObservationResult): void => {
    if (settled) return;
    settled = true;
    resolveResult(next);
  };
  const rememberCheckpoint = (value: unknown): void => {
    const candidate = value as { request_id?: unknown; sequence?: unknown };
    if (
      typeof candidate.request_id === "string" &&
      typeof candidate.sequence === "number"
    ) {
      checkpoint = checkpointFor(value);
    }
  };

  return {
    observation: {
      events: {
        async *[Symbol.asyncIterator]() {
          for (const value of framesBeforePause) {
            if (disconnected) return;
            rememberCheckpoint(value);
            yield value;
          }
          markPaused();
          await released;
          for (const value of framesAfterPause) {
            if (disconnected) return;
            rememberCheckpoint(value);
            yield value;
          }
          settle({ status, checkpoint } as TurnObservationResult);
        },
      },
      result,
      disconnect() {
        disconnected = true;
        releasePause();
        settle({ status: "disconnected", checkpoint });
      },
    },
    paused,
    release: releasePause,
  };
}

function pendingObservation(onDisconnect: () => void): TurnObservation<unknown> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resolveResult!: (result: TurnObservationResult) => void;
  const result = new Promise<TurnObservationResult>((resolve) => {
    resolveResult = resolve;
  });
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        yield startedFrame();
        await released;
      },
    },
    result,
    disconnect() {
      onDisconnect();
      release();
      resolveResult({
        status: "disconnected",
        checkpoint: checkpointFor(startedFrame()),
      });
    },
  };
}

class FakeTransport implements ConversationTransport<unknown, FakeRequest> {
  readonly capabilities = {
    authoritativeCancellation: { supported: false },
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  } as const;

  readonly starts: StartTurnInput<FakeRequest>[] = [];
  readonly resumes: ResumeTurnInput[] = [];
  readonly startObservations: TurnObservation<unknown>[] = [];
  readonly startFailures: TransportError[] = [];
  readonly resumeObservations: TurnObservation<unknown>[] = [];
  beforeStart: (() => void | Promise<void>) | null = null;

  async startTurn(
    input: StartTurnInput<FakeRequest>,
  ): Promise<TransportResult<TurnHandle<unknown>>> {
    this.starts.push(input);
    await this.beforeStart?.();
    const failure = this.startFailures.shift();
    if (failure !== undefined) return { ok: false, error: failure };
    const next = this.startObservations.shift();
    if (next === undefined) throw new Error("No fake start observation queued");
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        turnId: "remote-turn-1",
        mutationId: input.mutationId,
        observation: next,
      },
    };
  }

  async resumeTurn(
    input: ResumeTurnInput,
  ): Promise<TransportResult<TurnObservation<unknown>>> {
    this.resumes.push(input);
    const next = this.resumeObservations.shift();
    if (next === undefined) throw new Error("No fake resume observation queued");
    return { ok: true, value: next };
  }
}

class TrackingEventStore implements ConversationEventStore {
  readonly inner = new InMemoryConversationEventStore();
  readonly durableEventIds = new Set<string>();

  async append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    const result = await this.inner.append(input);
    for (const entry of result.entries) this.durableEventIds.add(entry.event.event_id);
    return result;
  }

  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    return this.inner.read(input);
  }

  getLatestRevision(id: ConversationId): Promise<ConversationRevision | null> {
    return this.inner.getLatestRevision(id);
  }
}

function deterministicSources() {
  let id = 0;
  let tick = 0;
  return {
    createId(kind: string) {
      id += 1;
      return `${kind}_${id}`;
    },
    now() {
      tick += 1;
      return `2026-08-27T12:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
}

describe("createConversationRuntime", () => {
  it("persists optimistic text and attachment facts before publishing, then durably finalizes streamed text", async () => {
    const eventStore = new TrackingEventStore();
    const transport = new FakeTransport();
    const controlled = pausableObservation(
      [startedFrame(), deltaFrame(1, "Hello ")],
      [deltaFrame(2, "there"), completedFrame(3)],
      "completed",
    );
    transport.startObservations.push(controlled.observation);
    transport.beforeStart = async () => {
      expect(await eventStore.getLatestRevision(conversationId)).toBe(4);
    };
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });
    const notifications: number[] = [];
    runtime.observe((snapshot) => {
      expect(snapshot.processed_event_ids.every((id) => eventStore.durableEventIds.has(id)))
        .toBe(true);
      notifications.push(snapshot.revision ?? 0);
    });

    const sending = runtime.sendMessage({
      content: "Describe this image",
      attachments: [{
        attachment_id: "attachment_runtime" as never,
        media_type: "image/png",
        filename: "runtime.png",
        size_bytes: 128,
      }],
      request: { prompt: "Describe this image" },
    });

    await controlled.paused;
    expect(runtime.getSnapshot().messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Hello " }],
    });
    expect(notifications.at(-1)).toBe(7);

    controlled.release();
    const outcome = await sending;

    expect(outcome).toMatchObject({ status: "completed", checkpoint: {
      lastAppliedEventId: "remote-turn-1:3",
      lastAppliedRevision: 3,
    } });
    expect(runtime.getSnapshot().messages).toMatchObject([
      {
        role: "user",
        content: [{ type: "text", text: "Describe this image" }],
        attachments: [{ attachment_id: "attachment_runtime" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello there" }],
      },
    ]);
    const assistantMessageId = runtime.getSnapshot().messages[1]?.message_id;
    expect(assistantMessageId).toBeDefined();
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "completed",
      outcome: "stop",
      output_message_ids: [assistantMessageId],
    });
    expect(notifications).toEqual([3, 4, 5, 6, 7, 8, 9]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "message.text_appended",
    )).toHaveLength(2);
    expect(history.entries.filter(
      ({ event }) =>
        event.payload.type === "message.created" && event.payload.role === "assistant",
    )).toHaveLength(0);
  });

  it("retries a normalized pre-start failure with the exact logical identities", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    transport.startFailures.push({
      code: "unavailable",
      message: "Normalized upstream unavailability",
      retryable: true,
      retryAfterMs: 5,
      native_status: 503,
      raw_headers: { "retry-after": "provider-native" },
    } as TransportError);
    transport.startObservations.push(observation([
      startedFrame(),
      completedFrame(1),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({
        maximumAttempts: 2,
        initialDelayMs: 0,
        jitterRatio: 0,
        sleep: async (_delayMs, signal) => signal.throwIfAborted(),
      }),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Retry safely",
      request: { prompt: "Retry safely" },
    });

    expect(outcome.status).toBe("completed");
    expect(transport.starts).toHaveLength(2);
    expect(transport.starts[0]).toBe(transport.starts[1]);
    expect(transport.starts[0]).toMatchObject({
      conversationId,
      conversationTurnId: transport.starts[1]?.conversationTurnId,
      mutationId: transport.starts[1]?.mutationId,
      idempotencyKey: transport.starts[1]?.idempotencyKey,
    });
    expect(runtime.getSnapshot().turns).toHaveLength(1);
    expect(runtime.getSnapshot().messages).toHaveLength(1);
    expect(runtime.getSnapshot().turns[0]?.output_message_ids).toEqual([]);
    expect(runtime.getSnapshot().turns[0]?.retry_history).toMatchObject([
      { type: "turn.attempt_started", attempt: 1, operation: "start" },
      {
        type: "turn.retry_scheduled",
        attempt: 1,
        reason_category: "unavailable",
        delay_ms: 5,
      },
      { type: "turn.attempt_started", attempt: 2, operation: "start" },
    ]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    const durableTurnId = history.entries.flatMap(({ event }) =>
      event.payload.type === "turn.started" ? [event.payload.turn_id] : []
    )[0];
    expect(durableTurnId).toBeDefined();
    expect(transport.starts.map((input) => input.conversationTurnId)).toEqual([
      durableTurnId,
      durableTurnId,
    ]);
    expect(transport.starts[0]?.conversationTurnId).not.toBe("remote-turn-1");
    expect(outcome.turnId).toBe(durableTurnId);
    const durableJson = JSON.stringify(history.entries.map((entry) => entry.event));
    expect(durableJson).not.toContain("native_status");
    expect(durableJson).not.toContain("raw_headers");
    expect(durableJson).not.toContain("provider-native");
  });

  it("automatically resumes partial output from the safe cursor without duplicating effects", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const tool = frame("response.tool_call", 1, {
      tool_call_id: "call_resume",
      name: "lookup",
      arguments: { query: "safe" },
    });
    const usage = frame("response.usage", 3, {
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    });
    transport.startObservations.push(observation([
      startedFrame(),
      tool,
      deltaFrame(2, "Recovered once"),
      usage,
    ], "disconnected"));
    transport.resumeObservations.push(observation([
      deltaFrame(2, "Recovered once"),
      structuredClone(usage),
      completedFrame(4),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({
        maximumAttempts: 2,
        initialDelayMs: 0,
        jitterRatio: 0,
        sleep: async (_delayMs, signal) => signal.throwIfAborted(),
      }),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Resume safely",
      request: { prompt: "Resume safely" },
    });

    expect(outcome.status).toBe("completed");
    expect(transport.starts).toHaveLength(1);
    expect(transport.resumes).toEqual([{
      conversationId,
      turnId: "remote-turn-1",
      resumeFrom: {
        lastAppliedEventId: "remote-turn-1:2",
        lastAppliedCursor: "remote-turn-1:2",
        lastAppliedRevision: 2,
      },
    }]);
    expect(runtime.getSnapshot().messages.filter((message) => message.role === "assistant"))
      .toMatchObject([{ content: [{ type: "text", text: "Recovered once" }] }]);
    expect(runtime.getSnapshot().tool_calls).toHaveLength(1);
    expect(runtime.getSnapshot().tool_calls[0]).toMatchObject({
      tool_call_id: "call_resume",
      name: "lookup",
    });
    expect(runtime.getSnapshot().usage_receipt_links).toHaveLength(0);
    const history = await eventStore.read({ conversationId, limit: 100 });
    const durableJson = JSON.stringify(history.entries.map((entry) => entry.event));
    expect(durableJson).not.toContain("input_tokens");
    expect(runtime.getSnapshot().turns[0]?.retry_history).toMatchObject([
      { type: "turn.attempt_started", attempt: 1, operation: "start" },
      {
        type: "turn.retry_scheduled",
        attempt: 1,
        reason_category: "disconnected",
      },
      { type: "turn.attempt_started", attempt: 2, operation: "resume" },
    ]);
  });

  it("projects a tool-call terminal without entering a tool loop", async () => {
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      startedFrame(),
      frame("response.tool_call", 1, {
        tool_call_id: "call_weather",
        name: "lookup_weather",
        arguments: { city: "Chicago" },
      }),
      completedFrame(2, "tool_calls"),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore: new InMemoryConversationEventStore(),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Weather?",
      request: { prompt: "Weather?" },
    });

    expect(outcome.status).toBe("completed");
    expect(runtime.getSnapshot().tool_calls[0]).toMatchObject({
      tool_call_id: "call_weather",
      name: "lookup_weather",
      arguments: { city: "Chicago" },
    });
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "completed",
      outcome: "tool_calls",
      output_message_ids: [],
    });
  });

  it("deduplicates request_id plus sequence replays while preserving text once", async () => {
    const transport = new FakeTransport();
    const eventStore = new InMemoryConversationEventStore();
    const delta = deltaFrame(1, "once");
    transport.startObservations.push(observation([
      startedFrame(),
      delta,
      structuredClone(delta),
      completedFrame(2),
    ], "completed"));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });

    expect((await runtime.sendMessage({
      content: "Repeat",
      request: { prompt: "Repeat" },
    })).status).toBe("completed");
    expect(runtime.getSnapshot().messages[1]?.content).toEqual([
      { type: "text", text: "once" },
    ]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "message.text_appended",
    )).toHaveLength(1);
  });

  it("leaves malformed and conflicting-terminal observations nonterminal", async () => {
    const malformedTransport = new FakeTransport();
    malformedTransport.startObservations.push(observation([
      startedFrame(),
      { type: "response.text.delta", sequence: 1, delta: "invalid" },
    ], "completed"));
    const malformedRuntime = await createConversationRuntime({
      conversationId,
      clientId,
      transport: malformedTransport,
      eventStore: new InMemoryConversationEventStore(),
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });

    const malformed = await malformedRuntime.sendMessage({
      content: "Malformed",
      request: { prompt: "Malformed" },
    });
    expect(malformed).toMatchObject({ status: "interrupted", error: {
      code: "invalid_protocol",
    } });
    expect(malformedRuntime.getSnapshot().turns[0]?.status).toBe("running");

    const conflictingTransport = new FakeTransport();
    conflictingTransport.startObservations.push(observation([
      startedFrame(),
      completedFrame(1),
      frame("response.error", 2, {
        error: {
          category: "internal",
          code: "internal_error",
          message: "late terminal",
          retryable: false,
        },
      }),
    ], "completed"));
    const conflictingRuntime = await createConversationRuntime({
      conversationId,
      clientId,
      transport: conflictingTransport,
      eventStore: new InMemoryConversationEventStore(),
      ...deterministicSources(),
    });
    expect((await conflictingRuntime.sendMessage({
      content: "Conflict",
      request: { prompt: "Conflict" },
    })).status).toBe("interrupted");
    expect(conflictingRuntime.getSnapshot().turns[0]?.status).toBe("running");
  });

  it("keeps abrupt EOF disconnected and resumes from the last safely persisted frame after restart", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Recovered"),
    ], "disconnected"));
    const runtimeBeforeRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });
    const disconnected = await runtimeBeforeRestart.sendMessage({
      content: "Resume me",
      request: { prompt: "Resume me" },
    });
    expect(disconnected.status).toBe("disconnected");
    expect(runtimeBeforeRestart.getSnapshot().turns[0]?.status).toBe("running");
    expect(runtimeBeforeRestart.getSnapshot().turns[0]?.retry_history).toMatchObject([
      { type: "turn.attempt_started", attempt: 1, operation: "start" },
      {
        type: "turn.retry_exhausted",
        attempt: 1,
        reason_category: "disconnected",
        exhaustion_reason: "maximum_attempts",
      },
    ]);
    expect(disconnected.checkpoint).toMatchObject({
      lastAppliedEventId: "remote-turn-1:1",
      lastAppliedRevision: 1,
    });
    expect(runtimeBeforeRestart.getSnapshot().messages[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Recovered" }],
    });
    const streamedMessageId = runtimeBeforeRestart.getSnapshot().messages[1]?.message_id;
    runtimeBeforeRestart.destroy();

    transport.resumeObservations.push(observation([
      deltaFrame(1, "Recovered"),
      deltaFrame(2, " once"),
      completedFrame(3),
    ], "completed"));
    const runtimeAfterRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });
    expect(runtimeAfterRestart.getSnapshot().messages[1]).toMatchObject({
      message_id: streamedMessageId,
      content: [{ type: "text", text: "Recovered" }],
    });
    expect(runtimeAfterRestart.getSnapshot().active_turn_id).not.toBeNull();

    const resumed = await runtimeAfterRestart.restoreActiveTurn();
    expect(resumed?.status).toBe("completed");
    expect(transport.resumes).toEqual([{
      conversationId,
      turnId: "remote-turn-1",
      resumeFrom: {
        lastAppliedEventId: "remote-turn-1:1",
        lastAppliedCursor: "remote-turn-1:1",
        lastAppliedRevision: 1,
      },
    }]);
    expect(runtimeAfterRestart.getSnapshot().messages[1]).toMatchObject({
      message_id: streamedMessageId,
      content: [{ type: "text", text: "Recovered once" }],
    });
    expect(runtimeAfterRestart.getSnapshot().turns[0]).toMatchObject({
      status: "completed",
      output_message_ids: [streamedMessageId],
    });
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "message.text_appended",
    )).toHaveLength(2);
  });

  it("disconnects local observers and clears subscriptions on destroy without deleting history", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const disconnected = vi.fn();
    transport.startObservations.push(pendingObservation(disconnected));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });
    const observer = vi.fn();
    runtime.observe(observer);
    const sending = runtime.sendMessage({
      content: "Stay active",
      request: { prompt: "Stay active" },
    });
    await vi.waitFor(() => expect(runtime.getSnapshot().turns[0]?.status).toBe("running"));
    const revisionBeforeDestroy = await eventStore.getLatestRevision(conversationId);

    runtime.destroy();
    runtime.destroy();

    await expect(sending).rejects.toThrow("destroyed");
    expect(disconnected).toHaveBeenCalledOnce();
    expect(await eventStore.getLatestRevision(conversationId)).toBe(revisionBeforeDestroy);
    const observerCalls = observer.mock.calls.length;
    await Promise.resolve();
    expect(observer).toHaveBeenCalledTimes(observerCalls);
  });

  it("aborts a pending runtime retry delay on destroy", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    transport.startFailures.push({
      code: "unavailable",
      message: "Temporarily unavailable",
      retryable: true,
    });
    let markSleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({
        maximumAttempts: 2,
        sleep: (_delayMs, signal) => {
          markSleepStarted();
          return new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        },
      }),
      ...deterministicSources(),
    });
    const sending = runtime.sendMessage({
      content: "Destroy during retry",
      request: { prompt: "Destroy during retry" },
    });
    await sleepStarted;

    runtime.destroy();

    await expect(sending).rejects.toThrow("destroyed");
    expect(transport.starts).toHaveLength(1);
  });
});
