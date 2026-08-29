import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  BoundedToolExecutor,
  InMemoryConversationEventStore,
  ToolRegistry,
  createConversationRuntime,
  parseChatRequest,
  parseNormalizedUsageReceipt,
  runToolLoop,
  type ApplicationToolExecutor,
  type ApplicationToolPolicy,
  type AuthoritativeAttribution,
  type ChatRequest,
  type ConversationClientId,
  type ConversationId,
  type ConversationTransport,
  type NormalizedUsageReceipt,
  type StartTurnInput,
  type ToolDefinition,
  type TransportResult,
  type TurnHandle,
  type TurnObservation,
  type TurnObservationResult,
} from "../src/index.js";

const conversationId = "conversation_tool_loop" as ConversationId;
const clientId = "client_tool_loop" as ConversationClientId;
const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

interface ScriptedResponse {
  readonly requestId: string;
  readonly calls?: readonly { id: string; name?: string; arguments?: Record<string, unknown> }[];
  readonly outcome: "stop" | "length" | "tool_calls";
  readonly text?: string;
  readonly usageReceiptId?: string;
}

function usageReceipt(
  usageReceiptId: string,
  turnId: string,
  requestId: string,
): NormalizedUsageReceipt {
  return parseNormalizedUsageReceipt({
    version: 1,
    usage_receipt_id: usageReceiptId,
    conversation_id: conversationId,
    turn_id: turnId,
    logical_request_id: "logical_tool_loop",
    trace_id: `trace_${requestId}`,
    attempt: { id: `attempt_${requestId}`, index: 0 },
    continuation: { id: `continuation_${requestId}`, index: 0 },
    provider_id: "generic-direct",
    model_id: "generic-model-v1",
    attribution,
    source: "provider",
    terminal_status: "completed",
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

function observation(
  script: ScriptedResponse,
  receipt?: NormalizedUsageReceipt,
): TurnObservation<unknown> {
  const frames: unknown[] = [{
    type: "response.started",
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: script.requestId,
    trace_id: `trace_${script.requestId}`,
    sequence: 0,
    attribution,
  }];
  let sequence = 1;
  for (const call of script.calls ?? []) {
    frames.push({
      type: "response.tool_call",
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: script.requestId,
      trace_id: `trace_${script.requestId}`,
      sequence: sequence++,
      tool_call_id: call.id,
      name: call.name ?? "lookup",
      arguments: call.arguments ?? { query: call.id },
    });
  }
  if (script.text !== undefined) {
    frames.push({
      type: "response.text.delta",
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: script.requestId,
      trace_id: `trace_${script.requestId}`,
      sequence: sequence++,
      delta: script.text,
    });
  }
  frames.push({
    type: "response.completed",
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: script.requestId,
    trace_id: `trace_${script.requestId}`,
    sequence: sequence,
    outcome: script.outcome,
  });
  const checkpoint = {
    lastAppliedEventId: `${script.requestId}:${sequence}`,
    lastAppliedCursor: `${script.requestId}:${sequence}`,
    lastAppliedRevision: sequence,
  };
  return {
    events: { async *[Symbol.asyncIterator]() { yield* frames; } },
    result: Promise.resolve({
      status: "completed",
      checkpoint,
      ...(receipt === undefined ? {} : { usageReceipt: receipt }),
    } satisfies TurnObservationResult),
    disconnect() {},
  };
}

class ScriptedTransport implements ConversationTransport<unknown, ChatRequest> {
  readonly capabilities = {
    authoritativeCancellation: { supported: false },
    documentInput: { supported: false },
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  } as const;
  readonly starts: StartTurnInput<ChatRequest>[] = [];
  constructor(readonly scripts: ScriptedResponse[]) {}

  async startTurn(input: StartTurnInput<ChatRequest>): Promise<TransportResult<TurnHandle<unknown>>> {
    this.starts.push(input);
    const script = this.scripts.shift();
    if (script === undefined) throw new Error("No scripted response remains");
    return { ok: true, value: {
      conversationId: input.conversationId,
      mutationId: input.mutationId,
      turnId: `remote_${script.requestId}`,
      observation: observation(
        script,
        script.usageReceiptId === undefined
          ? undefined
          : usageReceipt(
              script.usageReceiptId,
              input.conversationTurnId,
              script.requestId,
            ),
      ),
    } };
  }

  async resumeTurn(): Promise<never> {
    throw new Error("Unexpected resume");
  }
}

function toolDefinition(): ToolDefinition {
  return {
    name: "lookup",
    description: "Lookup a value",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

async function harness(
  scripts: ScriptedResponse[],
  execute: ApplicationToolExecutor = async ({ query }) => ({ query: String(query ?? "") }),
  policy: ApplicationToolPolicy = () => ({ outcome: "allow" }),
  executorConcurrency = 4,
) {
  const registry = new ToolRegistry<ApplicationToolExecutor, undefined>();
  registry.register({ definition: toolDefinition(), executor: execute });
  const discoveredTools = registry.discover({ context: undefined });
  const executor = new BoundedToolExecutor({
    registry,
    policy,
    limits: { maxConcurrency: executorConcurrency },
  });
  const transport = new ScriptedTransport([...scripts]);
  let id = 0;
  const runtime = await createConversationRuntime({
    conversationId,
    clientId,
    eventStore: new InMemoryConversationEventStore(),
    transport,
    createId: (kind) => `${kind}_${++id}`,
    now: () => "2026-08-28T12:00:00.000Z",
  });
  const request = parseChatRequest({
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    continuation_of: null,
    messages: [{ role: "user", content: [{ type: "text", text: "Use tools" }] }],
    tools: discoveredTools,
    tool_results: [],
    generation: { max_output_tokens: 256, temperature: 0.2 },
    correlation_hints: {
      session: {
        external_id: "session-1",
        source: "client",
        trust: "untrusted_correlation_hint",
      },
    },
    metadata: { feature: "tool-loop" },
  });
  const initialTurn = await runtime.sendMessage({ content: "Use tools", request });
  return { discoveredTools, executor, initialTurn, request, runtime, transport };
}

async function run(h: Awaited<ReturnType<typeof harness>>, options: Record<string, unknown> = {}) {
  return runToolLoop({
    runtime: h.runtime,
    initialTurn: h.initialTurn,
    request: h.request,
    discoveredTools: h.discoveredTools,
    executor: h.executor,
    applicationContext: undefined,
    now: () => 1,
    ...options,
  });
}

describe("runToolLoop", () => {
  it("returns zero-tool text and length terminals without a continuation", async () => {
    for (const outcome of ["stop", "length"] as const) {
      const h = await harness([{ requestId: `request_${outcome}`, outcome, text: "done" }]);
      const result = await run(h);
      expect(result).toMatchObject({ status: "completed", outcome, iterations: 0, totalToolCalls: 0 });
      expect(h.transport.starts).toHaveLength(1);
    }
  });

  it("executes one tool, submits one valid continuation, and preserves logical request state", async () => {
    const execute = vi.fn<ApplicationToolExecutor>(async () => ({ found: true }));
    const h = await harness([
      { requestId: "request_1", calls: [{ id: "call_1" }], outcome: "tool_calls" },
      { requestId: "request_2", outcome: "stop", text: "answer" },
    ], execute);

    const result = await run(h);

    expect(result).toMatchObject({ status: "completed", outcome: "stop", iterations: 1 });
    expect(execute).toHaveBeenCalledOnce();
    expect(h.transport.starts).toHaveLength(2);
    const continuation = parseChatRequest(h.transport.starts[1]!.request);
    expect(continuation.continuation_of).toBe("request_1");
    expect(continuation.tool_results).toHaveLength(1);
    expect(continuation.messages).toEqual(h.request.messages);
    expect(continuation.tools).toEqual(h.request.tools);
    expect(continuation.generation).toEqual(h.request.generation);
    expect(continuation.correlation_hints).toEqual(h.request.correlation_hints);
    expect(continuation.metadata).toEqual(h.request.metadata);
    expect(h.runtime.getSnapshot().messages.map((message) => message.role)).toEqual([
      "user", "assistant",
    ]);
    expect(h.runtime.getSnapshot().turns[1]?.continuation_of_turn_id).toBe(result.turn.turnId === h.initialTurn.turnId ? null : h.initialTurn.turnId);
  });

  it("supports multiple sequential iterations and continues failed tool results", async () => {
    let invocation = 0;
    const h = await harness([
      { requestId: "request_1", calls: [{ id: "call_1" }], outcome: "tool_calls" },
      { requestId: "request_2", calls: [{ id: "call_2" }], outcome: "tool_calls" },
      { requestId: "request_3", outcome: "stop" },
    ], async () => {
      invocation += 1;
      if (invocation === 1) throw new Error("private failure");
      return "ok";
    });

    const result = await run(h);

    expect(result).toMatchObject({ status: "completed", iterations: 2, totalToolCalls: 2 });
    expect(h.transport.starts[1]?.request.tool_results[0]?.is_error).toBe(true);
    expect(h.transport.starts[2]?.request.continuation_of).toBe("request_2");
  });

  it("pauses for approval and resumes without executing or recounting the call", async () => {
    let approved = false;
    const execute = vi.fn<ApplicationToolExecutor>(async () => "approved");
    const policy = vi.fn<ApplicationToolPolicy>(() => approved
      ? { outcome: "allow" }
      : { outcome: "external_approval_required" });
    const h = await harness([
      { requestId: "request_1", calls: [{ id: "call_approval" }], outcome: "tool_calls" },
      { requestId: "request_2", outcome: "stop" },
    ], execute, policy);

    const paused = await run(h);
    expect(paused).toMatchObject({
      status: "external_approval_required",
      pendingToolCallIds: ["call_approval"],
      iterations: 1,
      totalToolCalls: 1,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(h.runtime.getSnapshot().tool_calls[0]).toMatchObject({
      started_at: null,
      approval_required_at: expect.any(String),
    });

    approved = true;
    const resumed = await runToolLoop({
      runtime: h.runtime,
      initialTurn: paused.turn,
      request: paused.request,
      discoveredTools: h.discoveredTools,
      executor: h.executor,
      applicationContext: undefined,
      progress: paused.progress,
      now: () => 1,
    });
    expect(resumed).toMatchObject({ status: "completed", iterations: 1, totalToolCalls: 1 });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("uses durable results and continuation identity to make duplicate replay side-effect safe", async () => {
    const execute = vi.fn<ApplicationToolExecutor>(async () => "once");
    const h = await harness([
      { requestId: "request_1", calls: [{ id: "call_once" }], outcome: "tool_calls" },
      { requestId: "request_2", outcome: "stop" },
    ], execute);
    expect((await run(h)).status).toBe("completed");
    expect((await run(h)).status).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    expect(h.transport.starts).toHaveLength(2);
  });

  it("permits parallel calls only with provider capability and configured parallelism", async () => {
    for (const [providerParallel, expectedMaximum] of [[true, 2], [false, 1]] as const) {
      let active = 0;
      let maximum = 0;
      const h = await harness([
        {
          requestId: `request_parallel_${providerParallel}`,
          calls: [{ id: "call_a" }, { id: "call_b" }],
          outcome: "tool_calls",
        },
        { requestId: `request_answer_${providerParallel}`, outcome: "stop" },
      ], async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return "ok";
      });
      expect((await run(h, {
        limits: { parallelism: 2 },
        providerCapabilities: { parallelToolCalls: providerParallel },
      })).status).toBe("completed");
      expect(maximum).toBe(expectedMaximum);
    }
  });

  it("keeps the executor concurrency cap authoritative", async () => {
    let active = 0;
    let maximum = 0;
    const h = await harness([
      {
        requestId: "request_capped",
        calls: [{ id: "call_a" }, { id: "call_b" }, { id: "call_c" }],
        outcome: "tool_calls",
      },
      { requestId: "request_answer", outcome: "stop" },
    ], async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return "ok";
    }, () => ({ outcome: "allow" }), 1);
    await run(h, {
      limits: { parallelism: 3 },
      providerCapabilities: { parallelToolCalls: true },
    });
    expect(maximum).toBe(1);
  });

  it("stops before calls or continuations when cancelled", async () => {
    const execute = vi.fn<ApplicationToolExecutor>(async () => "unused");
    const h = await harness([
      { requestId: "request_cancel", calls: [{ id: "call_cancel" }], outcome: "tool_calls" },
    ], execute);
    const controller = new AbortController();
    controller.abort();
    expect(await run(h, { signal: controller.signal })).toMatchObject({ status: "cancelled" });
    expect(execute).not.toHaveBeenCalled();
    expect(h.transport.starts).toHaveLength(1);
  });

  it("exhausts iteration, total-call, and wall-clock budgets durably", async () => {
    const iteration = await harness([
      { requestId: "iter_1", calls: [{ id: "call_1" }], outcome: "tool_calls" },
      { requestId: "iter_2", calls: [{ id: "call_2" }], outcome: "tool_calls" },
    ]);
    expect(await run(iteration, { limits: { maxIterations: 1 } })).toMatchObject({
      status: "budget_exhausted", budget: "iterations",
    });

    const calls = await harness([{
      requestId: "calls_1",
      calls: [{ id: "call_a" }, { id: "call_b" }],
      outcome: "tool_calls",
    }]);
    const callExhaustion = await run(calls, { limits: { maxTotalToolCalls: 1 } });
    expect(callExhaustion).toMatchObject({
      status: "budget_exhausted", budget: "total_tool_calls",
    });
    expect(await runToolLoop({
      runtime: calls.runtime,
      initialTurn: callExhaustion.turn,
      request: callExhaustion.request,
      discoveredTools: calls.discoveredTools,
      executor: calls.executor,
      applicationContext: undefined,
      limits: { maxTotalToolCalls: 1 },
      progress: callExhaustion.progress,
      now: () => 1,
    })).toMatchObject({ status: "budget_exhausted", budget: "total_tool_calls" });

    const wall = await harness([{
      requestId: "wall_1", calls: [{ id: "call_wall" }], outcome: "tool_calls",
    }]);
    let tick = 0;
    expect(await run(wall, {
      limits: { maxElapsedMs: 100 },
      now: () => tick++ === 0 ? 0 : 101,
    })).toMatchObject({ status: "budget_exhausted", budget: "wall_clock" });
    expect(wall.runtime.getSnapshot().tool_loop_budget_exhaustions).toHaveLength(1);
  });

  it("collects and deduplicates runtime receipts across two continuations", async () => {
    const h = await harness([
      {
        requestId: "runtime_usage_1",
        calls: [{ id: "call_usage_1" }],
        outcome: "tool_calls",
        usageReceiptId: "receipt_runtime_first",
      },
      {
        requestId: "runtime_usage_2",
        calls: [{ id: "call_usage_2" }],
        outcome: "tool_calls",
        usageReceiptId: "receipt_runtime_first",
      },
      {
        requestId: "runtime_usage_3",
        outcome: "stop",
        usageReceiptId: "receipt_runtime_terminal",
      },
    ]);

    const result = await run(h);

    expect(result).toMatchObject({
      status: "completed",
      iterations: 2,
      totalToolCalls: 2,
    });
    expect(h.transport.starts).toHaveLength(3);
    expect(result.usageReceipts.map((receipt) => receipt.usage_receipt_id)).toEqual([
      "receipt_runtime_first",
      "receipt_runtime_terminal",
    ]);
  });

  it("merges callback receipts additively and deduplicates by receipt identity", async () => {
    const h = await harness([
      {
        requestId: "usage_1",
        calls: [{ id: "call_usage" }],
        outcome: "tool_calls",
        usageReceiptId: "receipt_runtime",
      },
      { requestId: "usage_2", outcome: "stop" },
    ]);
    const duplicate = { usage_receipt_id: "receipt_same" } as NormalizedUsageReceipt;
    const unique = { usage_receipt_id: "receipt_unique" } as NormalizedUsageReceipt;
    const result = await run(h, {
      collectUsageReceipts: (turn: { requestId: string | null }) =>
        turn.requestId === "usage_1" ? [duplicate] : [duplicate, unique],
    });
    expect(result.usageReceipts.map((receipt) => receipt.usage_receipt_id)).toEqual([
      "receipt_runtime", "receipt_same", "receipt_unique",
    ]);
  });
});
