import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  InMemoryConversationEventStore,
  createConversationRuntime,
  createDirectProviderTransport,
  createRetryPolicy,
  type AuthoritativeAttribution,
  type AuthoritativeCancelTurnResult,
  type CancelTurnInput,
  type ChatRequest,
  type ConversationClientId,
  type ConversationId,
  type ConversationTransport,
  type ProviderAdapter,
  type ProviderAdapterInvocation,
  type StreamEvent,
  type TransportResult,
  type TurnHandle,
  type TurnObservation,
  type TurnObservationResult,
  type TurnResumePoint,
} from "../src/index.js";
import { createManagedRuntimeTransport } from "../src/server/managed.js";

const conversationId = "conversation_cancellation" as ConversationId;
const clientId = "client_cancellation" as ConversationClientId;
const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

const request: ChatRequest = {
  protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
  continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Cancel me" }] }],
  tools: [],
  tool_results: [],
  generation: { max_output_tokens: 64, temperature: 0 },
  correlation_hints: {},
};

function frame(type: StreamEvent["type"], sequence: number, fields = {}) {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: "remote-turn",
    trace_id: "trace-cancel",
    sequence,
    ...fields,
  };
}

const started = () => frame("response.started", 0, { attribution });
const completed = () => frame("response.completed", 1, { outcome: "stop" });
const cancelled = () => frame("response.cancelled", 1, { reason: "runtime_shutdown" });
const failed = () => frame("response.error", 1, {
  error: {
    category: "upstream",
    code: "upstream_unavailable",
    message: "Unavailable",
    retryable: true,
  },
});

function checkpoint(raw: unknown): TurnResumePoint {
  const event = raw as { request_id: string; sequence: number };
  return {
    lastAppliedEventId: `${event.request_id}:${event.sequence}`,
    lastAppliedCursor: `${event.request_id}:${event.sequence}`,
    lastAppliedRevision: event.sequence,
  };
}

class ControlledObservation implements TurnObservation<unknown> {
  readonly #queue: unknown[] = [];
  readonly #waiters: Array<() => void> = [];
  #closed = false;
  #checkpoint: TurnResumePoint = {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  };
  #settled = false;
  readonly result: Promise<TurnObservationResult>;
  #settle!: (result: TurnObservationResult) => void;

  constructor(initial: readonly unknown[] = []) {
    this.#queue.push(...initial);
    this.result = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  readonly events: AsyncIterable<unknown> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<unknown>> => {
        while (this.#queue.length === 0 && !this.#closed) {
          await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
        const value = this.#queue.shift();
        if (value === undefined) return { done: true, value: undefined };
        this.#checkpoint = checkpoint(value);
        return { done: false, value };
      },
    }),
  };

  finish(terminal: unknown, result: TurnObservationResult): void {
    this.#queue.push(terminal);
    this.#closed = true;
    this.#resolveWaiters();
    this.#resolveResult(result);
  }

  disconnect(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#resolveWaiters();
    this.#resolveResult({ status: "disconnected", checkpoint: this.#checkpoint });
  }

  #resolveResult(result: TurnObservationResult): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#settle(result);
  }

  #resolveWaiters(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}

type CancelHandler = (
  input: CancelTurnInput,
) => Promise<TransportResult<AuthoritativeCancelTurnResult>>;

class TestTransport implements ConversationTransport<unknown, ChatRequest> {
  readonly starts: ControlledObservation[] = [];
  readonly resumes: ControlledObservation[] = [];
  readonly cancellationInputs: CancelTurnInput[] = [];
  readonly capabilities: ConversationTransport["capabilities"];

  constructor(cancel?: CancelHandler) {
    this.capabilities = cancel === undefined
      ? {
          authoritativeCancellation: { supported: false },
          attachmentUpload: { supported: false },
          presence: { supported: false },
          synchronization: { supported: false },
        }
      : {
          authoritativeCancellation: {
            supported: true,
            capability: {
              cancelTurn: async (input) => {
                this.cancellationInputs.push(input);
                return cancel(input);
              },
            },
          },
          attachmentUpload: { supported: false },
          presence: { supported: false },
          synchronization: { supported: false },
        };
  }

  async startTurn(input: Parameters<ConversationTransport<unknown, ChatRequest>["startTurn"]>[0]) {
    const observation = this.starts.shift();
    if (observation === undefined) throw new Error("No start observation queued");
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        turnId: "remote-turn",
        mutationId: input.mutationId,
        observation,
      },
    } satisfies TransportResult<TurnHandle<unknown>>;
  }

  async resumeTurn() {
    const observation = this.resumes.shift();
    if (observation === undefined) throw new Error("No resume observation queued");
    return { ok: true, value: observation } as const;
  }
}

function deterministicSources() {
  let id = 0;
  let tick = 0;
  return {
    createId(kind: string) {
      id += 1;
      return `${kind}.cancellation-${id}`;
    },
    now() {
      tick += 1;
      return `2026-08-27T12:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
}

async function runtimeFor(transport: ConversationTransport<unknown, ChatRequest>) {
  const eventStore = new InMemoryConversationEventStore();
  const runtime = await createConversationRuntime({
    conversationId,
    clientId,
    transport,
    eventStore,
    retryPolicy: createRetryPolicy({ maximumAttempts: 3, initialDelayMs: 0 }),
    ...deterministicSources(),
  });
  return { runtime, eventStore };
}

async function activeTurnId(runtime: Awaited<ReturnType<typeof runtimeFor>>["runtime"]) {
  await vi.waitFor(() => expect(runtime.getSnapshot().active_turn_id).not.toBeNull());
  return runtime.getSnapshot().active_turn_id!;
}

describe("ConversationRuntime cancellation", () => {
  it("stops only local observation and permits a later explicit resume", async () => {
    const transport = new TestTransport();
    transport.starts.push(new ControlledObservation([started()]));
    const resumed = new ControlledObservation();
    resumed.finish(completed(), { status: "completed", checkpoint: checkpoint(completed()) });
    transport.resumes.push(resumed);
    const { runtime, eventStore } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Stop", request });
    const turnId = await activeTurnId(runtime);
    await vi.waitFor(() => expect(runtime.getSnapshot().turns[0]?.status).toBe("running"));

    expect(runtime.stopObserving(turnId)).toBe(true);
    await expect(sending).resolves.toMatchObject({ status: "disconnected" });
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "running",
      cancellation_status: null,
      remote_may_still_be_running: true,
    });

    await expect(runtime.resumeTurn(turnId)).resolves.toMatchObject({ status: "completed" });
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.map(({ event }) => event.payload.type)).not.toContain(
      "turn.cancelled",
    );
    expect(JSON.stringify(history.entries)).not.toContain("response.cancelled");
  });

  it("authoritatively cancels a direct-provider turn", async () => {
    let invocation: ProviderAdapterInvocation | null = null;
    const adapter: ProviderAdapter = {
      metadata: {
        provider_id: "fake",
        model_id: "fake-v1",
        capabilities: {
          streaming: true,
          text: true,
          tool_calls: false,
          parallel_tool_calls: false,
          reasoning: false,
          context_window_tokens: 8_192,
          max_output_tokens: 1_024,
        },
      },
      async *invoke(current) {
        invocation = current;
        yield { ...started(), request_id: current.context.request_id, trace_id: current.context.trace_id } as StreamEvent;
        if (!current.signal.aborted) {
          await new Promise<void>((resolve) =>
            current.signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        }
        yield {
          ...cancelled(),
          request_id: current.context.request_id,
          trace_id: current.context.trace_id,
          reason: current.signal.reason,
        } as StreamEvent;
        return { status: "cancelled", reason: current.signal.reason, usage: null };
      },
    };
    const transport = createDirectProviderTransport({
      adapter,
      createContext: () => ({
        request_id: "remote-turn",
        trace_id: "trace-cancel",
        turn_id: "remote-turn",
        attribution,
        correlation_hints: {},
        metadata: {},
        usage: {
          usage_receipt_id: "usage-cancel",
          logical_request_id: "logical-cancel",
          attempt: { id: "attempt-cancel", index: 0 },
          continuation: { id: "continuation-cancel", index: 0 },
          source: "provider",
          quality: "reported",
        },
      }),
    });
    const { runtime } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Cancel", request });
    const turnId = await activeTurnId(runtime);
    await vi.waitFor(() => expect(invocation).not.toBeNull());

    await expect(runtime.cancelTurn(turnId, "user")).resolves.toMatchObject({
      status: "cancellation_requested",
      remoteMayStillBeRunning: true,
    });
    await expect(sending).resolves.toMatchObject({ status: "cancelled" });
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "cancelled",
      cancellation_status: "cancelled",
      cancellation_reason: "user",
      cancellation_requested_reason: "user",
      remote_may_still_be_running: false,
    });
  });

  it("reports unsupported managed cancellation and stops only local observation", async () => {
    const encoder = new TextEncoder();
    const managed = createManagedRuntimeTransport({
      baseUrl: "https://runtime.example.test",
      getHeaders: async () => ({}),
      fetch: async (_url, init = {}) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: response.started\nid: remote-turn:0\ndata: ${JSON.stringify(started())}\n\n`,
          ));
          init.signal?.addEventListener("abort", () => controller.close(), { once: true });
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const { runtime, eventStore } = await runtimeFor(managed);
    const sending = runtime.sendMessage({ content: "Unsupported", request });
    const turnId = await activeTurnId(runtime);
    await vi.waitFor(() => expect(runtime.getSnapshot().turns[0]?.status).toBe("running"));

    await expect(runtime.cancelTurn(turnId, "user")).resolves.toMatchObject({
      status: "unsupported",
      remoteMayStillBeRunning: true,
    });
    await expect(sending).resolves.toMatchObject({ status: "disconnected" });
    expect(runtime.getSnapshot().turns[0]).toMatchObject({
      status: "running",
      cancellation_status: "unsupported",
      remote_may_still_be_running: true,
    });
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.map(({ event }) => event.payload.type)).toContain(
      "turn.cancellation_unsupported",
    );
    expect(history.entries.map(({ event }) => event.payload.type)).not.toContain(
      "turn.cancelled",
    );
  });

  it("shares one stable cancellation operation across repeated calls", async () => {
    let resolveCancel!: (result: TransportResult<AuthoritativeCancelTurnResult>) => void;
    const transport = new TestTransport(() => new Promise((resolve) => {
      resolveCancel = resolve;
    }));
    const observation = new ControlledObservation([started()]);
    transport.starts.push(observation);
    const { runtime } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Repeat", request });
    const turnId = await activeTurnId(runtime);

    const first = runtime.cancelTurn(turnId, "user");
    const second = runtime.cancelTurn(turnId, "timeout");
    expect(second).toBe(first);
    await vi.waitFor(() => expect(transport.cancellationInputs).toHaveLength(1));
    resolveCancel({ ok: true, value: { status: "cancellation_requested" } });
    await expect(first).resolves.toMatchObject({ reason: "user" });
    expect(transport.cancellationInputs[0]).toMatchObject({ reason: "user" });

    observation.finish(cancelled(), {
      status: "cancelled",
      checkpoint: checkpoint(cancelled()),
    });
    await sending;
  });

  for (const terminal of ["completed", "failed"] as const) {
    it(`keeps a racing ${terminal} terminal event authoritative`, async () => {
      let resolveCancel!: (result: TransportResult<AuthoritativeCancelTurnResult>) => void;
      const transport = new TestTransport(() => new Promise((resolve) => {
        resolveCancel = resolve;
      }));
      const observation = new ControlledObservation([started()]);
      transport.starts.push(observation);
      const { runtime } = await runtimeFor(transport);
      const sending = runtime.sendMessage({ content: "Race", request });
      const turnId = await activeTurnId(runtime);
      const cancelling = runtime.cancelTurn(turnId, "user");
      await vi.waitFor(() => expect(transport.cancellationInputs).toHaveLength(1));

      if (terminal === "completed") {
        observation.finish(completed(), {
          status: "completed",
          checkpoint: checkpoint(completed()),
        });
      } else {
        observation.finish(failed(), {
          status: "failed",
          checkpoint: checkpoint(failed()),
          error: { code: "unavailable", message: "Unavailable", retryable: true },
        });
      }
      await expect(sending).resolves.toMatchObject({ status: terminal });
      resolveCancel({ ok: true, value: { status: "cancellation_requested" } });
      await cancelling;
      expect(runtime.getSnapshot().turns[0]).toMatchObject({
        status: terminal,
        cancellation_status: "requested",
        remote_may_still_be_running: false,
      });
    });
  }

  it("settles cancellation bookkeeping when destroyed during a pending request", async () => {
    const transport = new TestTransport(() => new Promise(() => undefined));
    transport.starts.push(new ControlledObservation([started()]));
    const { runtime } = await runtimeFor(transport);
    const sending = runtime.sendMessage({ content: "Destroy", request });
    void sending.catch(() => undefined);
    const turnId = await activeTurnId(runtime);
    const cancelling = runtime.cancelTurn(turnId, "runtime_shutdown");
    await vi.waitFor(() => expect(transport.cancellationInputs).toHaveLength(1));

    runtime.destroy();

    await expect(cancelling).rejects.toThrow("destroyed");
    await expect(sending).rejects.toThrow("destroyed");
  });
});
