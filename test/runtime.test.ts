import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  InMemoryConversationEventStore,
  createRetryPolicy,
  createConversationRuntime,
  parseNormalizedUsageReceipt,
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

function usageReceipt(options: {
  readonly usageReceiptId?: string;
  readonly receiptConversationId?: string;
  readonly turnId?: string;
  readonly attemptIndex?: number;
  readonly terminalStatus?: "completed" | "cancelled" | "failed";
} = {}) {
  return parseNormalizedUsageReceipt({
    version: 1,
    usage_receipt_id: options.usageReceiptId ?? "usage_runtime_1",
    conversation_id: options.receiptConversationId ?? conversationId,
    turn_id: options.turnId ?? "turn_2",
    logical_request_id: "logical_runtime_1",
    trace_id: "trace-runtime-1",
    attempt: {
      id: `attempt_runtime_${options.attemptIndex ?? 0}`,
      index: options.attemptIndex ?? 0,
    },
    continuation: { id: "continuation_runtime_0", index: 0 },
    provider_id: "generic-direct",
    model_id: "generic-model-v1",
    attribution,
    source: "provider",
    terminal_status: options.terminalStatus ?? "completed",
    tokens: {
      input_tokens: { status: "reported", value: 4 },
      cached_input_tokens: { status: "reported", value: 1 },
      output_tokens: { status: "reported", value: 2 },
      reasoning_tokens: { status: "reported", value: 0 },
      total_tokens: { status: "reported", value: 6 },
    },
    provider_cost: { status: "unavailable" },
  });
}

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
const cancelledFrame = (sequence: number) =>
  frame("response.cancelled", sequence, { reason: "runtime_shutdown" });
const failedFrame = (sequence: number) => frame("response.error", sequence, {
  error: {
    category: "upstream",
    code: "upstream_unavailable",
    message: "Unavailable",
    retryable: false,
  },
});

function checkpointFor(raw: unknown): TurnResumePoint {
  const event = raw as { request_id: string; sequence: number };
  const id = `${event.request_id}:${event.sequence}`;
  return {
    lastAppliedEventId: id,
    lastAppliedCursor: id,
    lastAppliedRevision: event.sequence,
  };
}

function opaqueCheckpoint(revision: number, label = `opaque-${revision}`): TurnResumePoint {
  return {
    lastAppliedEventId: `event/${label}`,
    lastAppliedCursor: `cursor:${label}:not-derived-from-the-request`,
    lastAppliedRevision: revision,
  };
}

function observation(
  frames: readonly unknown[],
  status: TurnObservationResult["status"],
  options: {
    readonly usageReceipt?: unknown;
    readonly error?: TransportError;
    readonly checkpoint?: unknown;
  } = {},
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
        const resultCheckpoint = Object.hasOwn(options, "checkpoint")
          ? options.checkpoint
          : checkpoint;
        if (status === "failed") {
          settle({
            status: "failed",
            checkpoint: resultCheckpoint,
            error: options.error ?? {
              code: "internal_error",
              message: "failed",
              retryable: false,
            },
            ...(options.usageReceipt === undefined
              ? {}
              : { usageReceipt: options.usageReceipt }),
          } as TurnObservationResult);
        } else if (status === "disconnected") {
          settle({ status, checkpoint: resultCheckpoint } as TurnObservationResult);
        } else {
          settle({
            status,
            checkpoint: resultCheckpoint,
            ...(options.usageReceipt === undefined
              ? {}
              : { usageReceipt: options.usageReceipt }),
          } as TurnObservationResult);
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

class CheckpointFailingEventStore implements ConversationEventStore {
  readonly inner = new InMemoryConversationEventStore();
  failCheckpointWrites = false;

  append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    if (
      this.failCheckpointWrites &&
      input.events.some((event) => {
        const runtime = event.metadata?.handrail_runtime;
        return runtime !== null && typeof runtime === "object" &&
          !Array.isArray(runtime) && Object.hasOwn(runtime, "checkpoint");
      })
    ) {
      return Promise.reject(new Error("checkpoint persistence failed"));
    }
    return this.inner.append(input);
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

  it("returns a validated generic observation receipt in a frozen result array", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const receipt = usageReceipt();
    transport.startObservations.push(observation([
      startedFrame(),
      completedFrame(1),
    ], "completed", { usageReceipt: receipt }));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Measure this turn",
      request: { prompt: "Measure this turn" },
    });

    expect(outcome).toMatchObject({ status: "completed" });
    expect(outcome.usageReceipts).toEqual([receipt]);
    expect(Object.isFrozen(outcome.usageReceipts)).toBe(true);
    expect(runtime.getSnapshot().usage_receipt_links).toMatchObject([{
      turn_id: outcome.turnId,
      usage_receipt_id: receipt.usage_receipt_id,
    }]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    const linkedEvents = history.entries.filter(
      ({ event }) => event.payload.type === "usage.receipt_linked",
    );
    expect(linkedEvents.map(({ event }) => event.payload)).toEqual([{
      type: "usage.receipt_linked",
      turn_id: outcome.turnId,
      usage_receipt_id: receipt.usage_receipt_id,
    }]);
    const durableReceiptJson = JSON.stringify(linkedEvents);
    expect(durableReceiptJson).not.toContain("input_tokens");
    expect(durableReceiptJson).not.toContain("provider_cost");
    expect(durableReceiptJson).not.toContain("generic-direct");
    expect(durableReceiptJson).not.toContain("generic-model-v1");
    expect(durableReceiptJson).not.toContain("prompt_tokens");
  });

  it("deduplicates receipt IDs while retaining distinct receipts across observation retries", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const first = usageReceipt({
      usageReceiptId: "usage_retry_first",
      terminalStatus: "failed",
    });
    const repeated = usageReceipt({
      usageReceiptId: "usage_retry_first",
      attemptIndex: 1,
      terminalStatus: "failed",
    });
    const second = usageReceipt({
      usageReceiptId: "usage_retry_second",
      attemptIndex: 2,
    });
    const retryableError: TransportError = {
      code: "unavailable",
      message: "Retry observation",
      retryable: true,
    };
    transport.startObservations.push(observation([
      startedFrame(),
    ], "failed", { usageReceipt: first, error: retryableError }));
    transport.resumeObservations.push(
      observation([], "failed", {
        usageReceipt: repeated,
        error: retryableError,
      }),
      observation([completedFrame(1)], "completed", { usageReceipt: second }),
    );
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({
        maximumAttempts: 3,
        initialDelayMs: 0,
        jitterRatio: 0,
        sleep: async (_delayMs, signal) => signal.throwIfAborted(),
      }),
      ...deterministicSources(),
    });

    const outcome = await runtime.sendMessage({
      content: "Retry with receipts",
      request: { prompt: "Retry with receipts" },
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.usageReceipts).toEqual([first, second]);
    expect(outcome.usageReceipts.map((receipt) => receipt.usage_receipt_id)).toEqual([
      "usage_retry_first",
      "usage_retry_second",
    ]);
    expect(transport.resumes).toHaveLength(2);
    expect(runtime.getSnapshot().usage_receipt_links.map(
      (link) => link.usage_receipt_id,
    )).toEqual(["usage_retry_first", "usage_retry_second"]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) =>
        event.payload.type === "usage.receipt_linked" &&
        event.payload.usage_receipt_id === first.usage_receipt_id,
    )).toHaveLength(1);
  });

  it("replays a durable receipt link and does not append it when redelivered after restart", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const sources = deterministicSources();
    const receipt = usageReceipt({ usageReceiptId: "usage_restart" });
    transport.startObservations.push(observation([
      startedFrame(),
    ], "completed", { usageReceipt: receipt }));
    const runtimeBeforeRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...sources,
    });

    const interrupted = await runtimeBeforeRestart.sendMessage({
      content: "Resume receipt link",
      request: { prompt: "Resume receipt link" },
    });
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.usageReceipts).toEqual([receipt]);
    expect(runtimeBeforeRestart.getSnapshot().usage_receipt_links).toHaveLength(1);
    runtimeBeforeRestart.destroy();

    transport.resumeObservations.push(observation([
      completedFrame(1),
    ], "completed", { usageReceipt: receipt }));
    const runtimeAfterRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...sources,
    });
    expect(runtimeAfterRestart.getSnapshot().usage_receipt_links).toMatchObject([{
      turn_id: receipt.turn_id,
      usage_receipt_id: receipt.usage_receipt_id,
    }]);

    const resumed = await runtimeAfterRestart.restoreActiveTurn();

    expect(resumed?.status).toBe("completed");
    expect(resumed?.usageReceipts).toEqual([receipt]);
    expect(runtimeAfterRestart.getSnapshot().usage_receipt_links).toHaveLength(1);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "usage.receipt_linked",
    )).toHaveLength(1);
  });

  it("omits malformed and conversation/turn-mismatched observation receipts", async () => {
    const valid = usageReceipt();
    const invalidReceipts: readonly unknown[] = [
      { ...valid, provider_native_usage: { prompt_tokens: 4 } },
      usageReceipt({ receiptConversationId: "conversation_other" }),
      usageReceipt({ turnId: "turn_other" }),
    ];

    for (const invalid of invalidReceipts) {
      const eventStore = new InMemoryConversationEventStore();
      const transport = new FakeTransport();
      transport.startObservations.push(observation([
        startedFrame(),
        completedFrame(1),
      ], "completed", { usageReceipt: invalid }));
      const runtime = await createConversationRuntime({
        conversationId,
        clientId,
        transport,
        eventStore,
        ...deterministicSources(),
      });

      const outcome = await runtime.sendMessage({
        content: "Reject invalid receipt",
        request: { prompt: "Reject invalid receipt" },
      });

      expect(outcome.status).toBe("completed");
      expect(outcome.usageReceipts).toEqual([]);
      expect(Object.isFrozen(outcome.usageReceipts)).toBe(true);
      expect(runtime.getSnapshot().usage_receipt_links).toEqual([]);
      const history = await eventStore.read({ conversationId, limit: 100 });
      expect(history.entries.some(
        ({ event }) => event.payload.type === "usage.receipt_linked",
      )).toBe(false);
    }
  });

  it("retains valid receipts from cancelled and failed terminal observations", async () => {
    const cases = [
      {
        status: "cancelled" as const,
        terminal: cancelledFrame(1),
        receipt: usageReceipt({
          usageReceiptId: "usage_cancelled",
          terminalStatus: "cancelled",
        }),
      },
      {
        status: "failed" as const,
        terminal: failedFrame(1),
        receipt: usageReceipt({
          usageReceiptId: "usage_failed",
          terminalStatus: "failed",
        }),
      },
    ];

    for (const current of cases) {
      const transport = new FakeTransport();
      transport.startObservations.push(observation([
        startedFrame(),
        current.terminal,
      ], current.status, { usageReceipt: current.receipt }));
      const runtime = await createConversationRuntime({
        conversationId,
        clientId,
        transport,
        eventStore: new InMemoryConversationEventStore(),
        ...deterministicSources(),
      });

      const outcome = await runtime.sendMessage({
        content: `Observe ${current.status}`,
        request: { prompt: `Observe ${current.status}` },
      });

      expect(outcome.status).toBe(current.status);
      expect(outcome.usageReceipts).toEqual([current.receipt]);
      expect(Object.isFrozen(outcome.usageReceipts)).toBe(true);
    }
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
    ], "disconnected", { checkpoint: checkpointFor(deltaFrame(2, "Recovered once")) }));
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
    expect(outcome.usageReceipts).toEqual([]);
    expect(Object.isFrozen(outcome.usageReceipts)).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("input_tokens");
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

  it("passes an acknowledged opaque checkpoint unchanged to an automatic retry", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const firstCheckpoint = opaqueCheckpoint(1, "automatic-first");
    const finalCheckpoint = opaqueCheckpoint(2, "automatic-final");
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Opaque"),
    ], "disconnected", { checkpoint: firstCheckpoint }));
    transport.resumeObservations.push(observation([
      deltaFrame(1, "Opaque"),
      completedFrame(2),
    ], "completed", { checkpoint: finalCheckpoint }));
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
      content: "Resume from an opaque point",
      request: { prompt: "Resume from an opaque point" },
    });

    expect(transport.resumes[0]?.resumeFrom).toEqual(firstCheckpoint);
    expect(transport.resumes[0]?.resumeFrom).not.toBe(firstCheckpoint);
    expect(outcome.checkpoint).toEqual(finalCheckpoint);
  });

  it("hydrates an acknowledged opaque checkpoint for restoreActiveTurn", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const durableCheckpoint = opaqueCheckpoint(1, "restart-durable");
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Before restart"),
    ], "disconnected", { checkpoint: durableCheckpoint }));
    const sources = deterministicSources();
    const runtimeBeforeRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...sources,
    });
    const disconnected = await runtimeBeforeRestart.sendMessage({
      content: "Persist the cursor",
      request: { prompt: "Persist the cursor" },
    });
    expect(disconnected.checkpoint).toEqual(durableCheckpoint);
    runtimeBeforeRestart.destroy();

    transport.resumeObservations.push(observation([
      deltaFrame(1, "Before restart"),
      completedFrame(2),
    ], "completed", { checkpoint: opaqueCheckpoint(2, "restart-final") }));
    const runtimeAfterRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      ...sources,
    });

    expect((await runtimeAfterRestart.restoreActiveTurn())?.status).toBe("completed");
    expect(transport.resumes[0]?.resumeFrom).toEqual(durableCheckpoint);
  });

  it("does not advance the prior checkpoint when checkpoint persistence fails", async () => {
    const eventStore = new CheckpointFailingEventStore();
    const transport = new FakeTransport();
    const priorCheckpoint = opaqueCheckpoint(1, "prior-safe");
    transport.startObservations.push(observation([
      startedFrame(),
      deltaFrame(1, "Durable"),
    ], "disconnected", { checkpoint: priorCheckpoint }));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });
    const disconnected = await runtime.sendMessage({
      content: "Keep the prior point",
      request: { prompt: "Keep the prior point" },
    });

    eventStore.failCheckpointWrites = true;
    transport.resumeObservations.push(observation([
      completedFrame(2),
    ], "completed", { checkpoint: opaqueCheckpoint(2, "failed-write") }));
    await expect(runtime.resumeTurn(disconnected.turnId)).rejects.toThrow(
      "checkpoint persistence failed",
    );

    eventStore.failCheckpointWrites = false;
    transport.resumeObservations.push(observation([
      completedFrame(2),
    ], "completed", { checkpoint: opaqueCheckpoint(2, "after-recovery") }));
    expect((await runtime.resumeTurn(disconnected.turnId)).status).toBe("completed");
    expect(transport.resumes.map(({ resumeFrom }) => resumeFrom)).toEqual([
      priorCheckpoint,
      priorCheckpoint,
    ]);
  });

  it("rejects malformed or observation-ahead checkpoints without advancing the prior point", async () => {
    const invalidCheckpoints: readonly unknown[] = [
      {
        lastAppliedEventId: "event/partial",
        lastAppliedCursor: "cursor:partial",
      },
      opaqueCheckpoint(99, "ahead-of-observation"),
    ];

    for (const invalidCheckpoint of invalidCheckpoints) {
      const eventStore = new InMemoryConversationEventStore();
      const transport = new FakeTransport();
      const priorCheckpoint = opaqueCheckpoint(1, "valid-prior");
      transport.startObservations.push(observation([
        startedFrame(),
        deltaFrame(1, "Prior"),
      ], "disconnected", { checkpoint: priorCheckpoint }));
      const runtime = await createConversationRuntime({
        conversationId,
        clientId,
        transport,
        eventStore,
        retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
        ...deterministicSources(),
      });
      const first = await runtime.sendMessage({
        content: "Reject unsafe checkpoint",
        request: { prompt: "Reject unsafe checkpoint" },
      });

      transport.resumeObservations.push(observation([
        deltaFrame(2, " effect"),
      ], "disconnected", { checkpoint: invalidCheckpoint }));
      const invalid = await runtime.resumeTurn(first.turnId);
      expect(invalid).toMatchObject({
        status: "interrupted",
        checkpoint: priorCheckpoint,
        error: { code: "invalid_protocol" },
      });

      transport.resumeObservations.push(observation([
        deltaFrame(2, " effect"),
        completedFrame(3),
      ], "completed", { checkpoint: opaqueCheckpoint(3, "valid-final") }));
      expect((await runtime.resumeTurn(first.turnId)).status).toBe("completed");
      expect(transport.resumes.map(({ resumeFrom }) => resumeFrom)).toEqual([
        priorCheckpoint,
        priorCheckpoint,
      ]);
    }
  });

  it("keeps the all-null checkpoint until the transport acknowledges a point", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const emptyCheckpoint: TurnResumePoint = {
      lastAppliedEventId: null,
      lastAppliedCursor: null,
      lastAppliedRevision: null,
    };
    transport.startObservations.push(observation([
      startedFrame(),
    ], "disconnected", { checkpoint: emptyCheckpoint }));
    const runtime = await createConversationRuntime({
      conversationId,
      clientId,
      transport,
      eventStore,
      retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
      ...deterministicSources(),
    });
    const disconnected = await runtime.sendMessage({
      content: "No checkpoint yet",
      request: { prompt: "No checkpoint yet" },
    });
    expect(disconnected.checkpoint).toEqual(emptyCheckpoint);

    transport.resumeObservations.push(observation([
      completedFrame(1),
    ], "completed", { checkpoint: emptyCheckpoint }));
    const completed = await runtime.resumeTurn(disconnected.turnId);

    expect(transport.resumes[0]?.resumeFrom).toEqual(emptyCheckpoint);
    expect(completed.checkpoint).toEqual(emptyCheckpoint);
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
    expect(malformed.usageReceipts).toEqual([]);
    expect(Object.isFrozen(malformed.usageReceipts)).toBe(true);
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
    expect(disconnected.usageReceipts).toEqual([]);
    expect(Object.isFrozen(disconnected.usageReceipts)).toBe(true);
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
