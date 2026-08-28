import type { ConversationToolCallRecord } from "../conversation/state.js";
import {
  parseChatRequest,
  type ApplicationToolResult,
  type ChatRequest,
  type ToolDefinition,
} from "../protocol.js";
import type {
  ConversationRuntime,
  ConversationRuntimeTurnResult,
} from "../runtime.js";
import type { NormalizedUsageReceipt } from "../usage.js";
import { BoundedToolExecutor } from "./executor.js";

export interface ToolLoopLimits {
  readonly maxIterations: number;
  readonly maxTotalToolCalls: number;
  readonly maxElapsedMs: number;
  /** Loop fan-out. The executor's independently configured cap remains authoritative. */
  readonly parallelism: number;
}

export const DEFAULT_TOOL_LOOP_LIMITS: Readonly<ToolLoopLimits> = Object.freeze({
  maxIterations: 8,
  maxTotalToolCalls: 32,
  maxElapsedMs: 120_000,
  parallelism: 1,
});

export interface ToolLoopProviderCapabilities {
  readonly parallelToolCalls: boolean;
}

export interface ToolLoopProgress {
  readonly iterations: number;
  readonly totalToolCalls: number;
  readonly startedAtMs: number;
  readonly usageReceipts?: readonly NormalizedUsageReceipt[];
}

export interface RunToolLoopOptions<TContext = unknown, TDiscoveryContext = unknown> {
  readonly runtime: ConversationRuntime<ChatRequest>;
  /** The initial or approval-resume turn observation to inspect. */
  readonly initialTurn: ConversationRuntimeTurnResult | Promise<ConversationRuntimeTurnResult>;
  /** Exact request used for initialTurn. It is the immutable base for continuations. */
  readonly request: ChatRequest;
  readonly discoveredTools: readonly ToolDefinition[];
  readonly executor: BoundedToolExecutor<TContext, TDiscoveryContext>;
  readonly applicationContext: TContext;
  readonly limits?: Partial<ToolLoopLimits>;
  readonly providerCapabilities?: ToolLoopProviderCapabilities;
  readonly signal?: AbortSignal;
  readonly progress?: ToolLoopProgress;
  readonly now?: () => number;
  /** May return cumulative observations; receipt identity removes duplicates. */
  readonly collectUsageReceipts?: (
    result: ConversationRuntimeTurnResult,
  ) => readonly NormalizedUsageReceipt[] | Promise<readonly NormalizedUsageReceipt[]>;
}

interface ToolLoopResultBase {
  readonly turn: ConversationRuntimeTurnResult;
  readonly request: ChatRequest;
  readonly iterations: number;
  readonly totalToolCalls: number;
  readonly usageReceipts: readonly NormalizedUsageReceipt[];
  /** Feed this back to runToolLoop when resuming an approval pause. */
  readonly progress: ToolLoopProgress;
}

export type ToolLoopResult =
  | (ToolLoopResultBase & {
      readonly status: "completed";
      readonly outcome: "stop" | "length";
    })
  | (ToolLoopResultBase & { readonly status: "cancelled" })
  | (ToolLoopResultBase & {
      readonly status: "failed";
      readonly error: ConversationRuntimeTurnResult["error"];
    })
  | (ToolLoopResultBase & {
      readonly status: "external_approval_required";
      readonly pendingToolCallIds: readonly string[];
    })
  | (ToolLoopResultBase & {
      readonly status: "budget_exhausted";
      readonly budget: "iterations" | "total_tool_calls" | "wall_clock";
      readonly limit: number;
    });

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function limits(overrides: Partial<ToolLoopLimits> | undefined): Readonly<ToolLoopLimits> {
  const merged = { ...DEFAULT_TOOL_LOOP_LIMITS, ...overrides };
  return Object.freeze({
    maxIterations: positiveInteger(merged.maxIterations, "limits.maxIterations"),
    maxTotalToolCalls: positiveInteger(
      merged.maxTotalToolCalls,
      "limits.maxTotalToolCalls",
    ),
    maxElapsedMs: positiveInteger(merged.maxElapsedMs, "limits.maxElapsedMs"),
    parallelism: positiveInteger(merged.parallelism, "limits.parallelism"),
  });
}

function resultFromDurableCall(call: ConversationToolCallRecord): ApplicationToolResult | null {
  if (call.name === null || call.result === null) return null;
  return {
    tool_call_id: call.tool_call_id,
    name: call.name,
    content: call.result.content.map((part) => part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "json", value: part.value }),
    is_error: call.result.is_error,
  };
}

function frozenProgress(
  iterations: number,
  totalToolCalls: number,
  startedAtMs: number,
  usageReceipts: readonly NormalizedUsageReceipt[],
): ToolLoopProgress {
  return Object.freeze({
    iterations,
    totalToolCalls,
    startedAtMs,
    usageReceipts: Object.freeze([...usageReceipts]),
  });
}

/**
 * Runs provider tool continuations without owning transport details. Every
 * side-effect decision is durably recorded by ConversationRuntime before the
 * next protocol request is submitted.
 */
export async function runToolLoop<TContext = unknown, TDiscoveryContext = unknown>(
  options: RunToolLoopOptions<TContext, TDiscoveryContext>,
): Promise<ToolLoopResult> {
  const bounded = limits(options.limits);
  const now = options.now ?? (() => Date.now());
  const startedAtMs = options.progress?.startedAtMs ?? now();
  let iterations = options.progress?.iterations ?? 0;
  let totalToolCalls = options.progress?.totalToolCalls ?? 0;
  let turn = await options.initialTurn;
  let request = parseChatRequest(options.request);
  const receipts = new Map<string, NormalizedUsageReceipt>();
  for (const receipt of options.progress?.usageReceipts ?? []) {
    receipts.set(receipt.usage_receipt_id, receipt);
  }

  const collectUsage = async (): Promise<void> => {
    const observed = await options.collectUsageReceipts?.(turn) ?? [];
    for (const receipt of observed) receipts.set(receipt.usage_receipt_id, receipt);
  };
  const base = () => {
    const usageReceipts = Object.freeze([...receipts.values()]);
    return {
      turn,
      request,
      iterations,
      totalToolCalls,
      usageReceipts,
      progress: frozenProgress(iterations, totalToolCalls, startedAtMs, usageReceipts),
    };
  };
  const elapsed = () => Math.max(0, now() - startedAtMs);
  const aborted = () => options.signal?.aborted === true;

  const exhaust = async (
    budget: "iterations" | "total_tool_calls" | "wall_clock",
    limit: number,
  ): Promise<ToolLoopResult> => {
    const alreadyRecorded = options.runtime.getSnapshot().tool_loop_budget_exhaustions.some(
      (item) => item.turn_id === turn.turnId && item.budget === budget,
    );
    if (!alreadyRecorded) {
      await options.runtime.recordToolLoopEvents([{
        type: "tool_loop.budget_exhausted",
        turn_id: turn.turnId,
        budget,
        limit,
      }]);
    }
    return Object.freeze({ ...base(), status: "budget_exhausted", budget, limit });
  };

  for (;;) {
    await collectUsage();
    if (aborted()) return Object.freeze({ ...base(), status: "cancelled" });
    if (elapsed() >= bounded.maxElapsedMs) {
      return exhaust("wall_clock", bounded.maxElapsedMs);
    }
    if (turn.status === "cancelled") {
      return Object.freeze({ ...base(), status: "cancelled" });
    }
    if (turn.status !== "completed") {
      return Object.freeze({ ...base(), status: "failed", error: turn.error });
    }
    if (turn.outcome === "stop" || turn.outcome === "length") {
      return Object.freeze({ ...base(), status: "completed", outcome: turn.outcome });
    }
    if (turn.outcome !== "tool_calls" || turn.requestId === null) {
      return Object.freeze({ ...base(), status: "failed", error: Object.freeze({
        code: "invalid_tool_loop_terminal",
        message: "A tool-call completion lacked durable protocol identity",
        retryable: false,
      }) });
    }

    const snapshot = options.runtime.getSnapshot();
    const calls = snapshot.tool_calls.filter((call) => call.turn_id === turn.turnId);
    if (calls.length === 0) {
      return Object.freeze({ ...base(), status: "failed", error: Object.freeze({
        code: "missing_tool_calls",
        message: "A tool-call completion contained no durable tool calls",
        retryable: false,
      }) });
    }
    const undiscovered = calls.filter((call) => call.discovered_at === null);
    if (undiscovered.length > 0) {
      await options.runtime.recordToolLoopEvents(undiscovered.map((call) => ({
        type: "tool_call.discovered" as const,
        turn_id: turn.turnId,
        tool_call_id: call.tool_call_id,
      })));
    }

    if (iterations >= bounded.maxIterations) {
      return exhaust("iterations", bounded.maxIterations);
    }
    const newlyCounted = calls.filter((call) => call.discovered_at === null).length;
    if (totalToolCalls + newlyCounted > bounded.maxTotalToolCalls) {
      return exhaust("total_tool_calls", bounded.maxTotalToolCalls);
    }
    totalToolCalls += newlyCounted;
    iterations += 1;

    const results = new Map<string, ApplicationToolResult>();
    for (const call of calls) {
      const durable = resultFromDurableCall(call);
      if (durable !== null) results.set(call.tool_call_id, durable);
    }
    const pending = calls.filter((call) => !results.has(call.tool_call_id));
    const approvals = new Set<string>();
    let wallClockExpired = false;
    let nextIndex = 0;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const remaining = Math.max(0, bounded.maxElapsedMs - elapsed());
    const timeout = setTimeout(() => {
      wallClockExpired = true;
      controller.abort();
    }, remaining);

    const worker = async (): Promise<void> => {
      for (;;) {
        if (controller.signal.aborted) return;
        const call = pending[nextIndex++];
        if (call === undefined || call.name === null || call.arguments === null) return;
        const outcome = await options.executor.executeDetailed({
          call: {
            tool_call_id: call.tool_call_id,
            name: call.name,
            arguments: call.arguments,
          },
          discoveredTools: options.discoveredTools,
          applicationContext: options.applicationContext,
          signal: controller.signal,
          ...(call.started_at === null
            ? { onExecutionStarted: async () => {
                await options.runtime.recordToolLoopEvents([{
                  type: "tool_call.started",
                  turn_id: turn.turnId,
                  tool_call_id: call.tool_call_id,
                }]);
              } }
            : {}),
        });
        if (controller.signal.aborted) return;
        if (outcome.status === "external_approval_required") {
          approvals.add(call.tool_call_id);
        } else {
          results.set(call.tool_call_id, outcome.result);
        }
      }
    };

    const mayRunParallel =
      options.providerCapabilities?.parallelToolCalls === true && bounded.parallelism > 1;
    const workerCount = mayRunParallel
      ? Math.min(bounded.parallelism, Math.max(1, pending.length))
      : 1;
    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }

    if (aborted()) return Object.freeze({ ...base(), status: "cancelled" });
    if (wallClockExpired || elapsed() >= bounded.maxElapsedMs) {
      return exhaust("wall_clock", bounded.maxElapsedMs);
    }

    const latest = options.runtime.getSnapshot();
    const resultEvents = calls
      .filter((call) => call.result === null)
      .map((call) => results.get(call.tool_call_id))
      .filter((result): result is ApplicationToolResult => result !== undefined)
      .map((result) => ({
        type: "tool_call.result_recorded" as const,
        turn_id: turn.turnId,
        tool_call_id: result.tool_call_id as never,
        content: result.content,
        is_error: result.is_error,
      }));
    const approvalEvents = [...approvals]
      .filter((id) => latest.tool_calls.find((call) => call.tool_call_id === id)
        ?.approval_required_at === null)
      .map((id) => ({
        type: "tool_call.approval_required" as const,
        turn_id: turn.turnId,
        tool_call_id: id as never,
      }));
    await options.runtime.recordToolLoopEvents([...resultEvents, ...approvalEvents]);

    if (approvals.size > 0) {
      return Object.freeze({
        ...base(),
        status: "external_approval_required",
        pendingToolCallIds: Object.freeze([...approvals]),
      });
    }
    if (results.size !== calls.length) {
      return Object.freeze({ ...base(), status: "failed", error: Object.freeze({
        code: "incomplete_tool_results",
        message: "Tool execution ended without a complete result set",
        retryable: true,
      }) });
    }

    const continuation = parseChatRequest({
      ...request,
      continuation_of: turn.requestId,
      tool_results: calls.map((call) => results.get(call.tool_call_id)!),
    });
    if (aborted()) return Object.freeze({ ...base(), status: "cancelled" });
    request = continuation;
    turn = await options.runtime.continueTurn({
      precedingTurnId: turn.turnId,
      request: continuation,
    });
  }
}
