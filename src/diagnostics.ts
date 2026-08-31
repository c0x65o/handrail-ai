export type AiDiagnosticDomain =
  | "provider" | "gateway" | "retry" | "tool" | "mcp" | "approval" | "upstream";
export type AiDiagnosticPhase = "started" | "succeeded" | "failed" | "retrying" | "cancelled";

export interface AiDiagnosticEvent {
  readonly domain: AiDiagnosticDomain;
  readonly operation: string;
  readonly phase: AiDiagnosticPhase;
  readonly timestamp: string;
  readonly retryable?: boolean;
  readonly code?: string;
  readonly conversationId?: string;
  readonly turnId?: string;
  readonly toolName?: string;
  /** Host-only original failure. Never serialized or included in public metadata. */
  readonly cause?: unknown;
}

export type AiDiagnosticSink = (event: AiDiagnosticEvent) => void;

/** Emit a bounded lifecycle event; sink failures can never alter AI execution. */
export function emitAiDiagnostic(sink: AiDiagnosticSink | undefined, event: Omit<AiDiagnosticEvent, "timestamp">): void {
  if (sink === undefined) return;
  try { sink(Object.freeze({ ...event, timestamp: new Date().toISOString() })); } catch { /* observability is non-authoritative */ }
}

/** Removes the host-only cause before structured logging or transport. */
export function publicAiDiagnostic(event: AiDiagnosticEvent): Omit<AiDiagnosticEvent, "cause"> {
  const safe = { ...event };
  Reflect.deleteProperty(safe, "cause");
  return Object.freeze(safe);
}

export async function diagnoseAiOperation<T>(
  sink: AiDiagnosticSink | undefined,
  input: Omit<AiDiagnosticEvent, "timestamp" | "phase" | "cause">,
  execute: () => Promise<T>,
): Promise<T> {
  emitAiDiagnostic(sink, { ...input, phase: "started" });
  try {
    const value = await execute();
    emitAiDiagnostic(sink, { ...input, phase: "succeeded" });
    return value;
  } catch (cause) {
    emitAiDiagnostic(sink, { ...input, phase: "failed", cause });
    throw cause;
  }
}

/** Adapter for the existing retry engine's lifecycle hooks. */
export function createRetryDiagnosticHooks(sink: AiDiagnosticSink | undefined) {
  return Object.freeze({
    onAttemptStarted: (context: { readonly attempt: number }) => emitAiDiagnostic(sink,
      { domain: "retry", operation: "attempt", phase: "started", code: String(context.attempt) }),
    onRetryScheduled: (context: { readonly reasonCategory: string; readonly nextAttempt: number }) => emitAiDiagnostic(sink,
      { domain: "retry", operation: "schedule", phase: "retrying", code: context.reasonCategory,
        retryable: true, turnId: String(context.nextAttempt) }),
    onRetryExhausted: (context: { readonly reasonCategory: string; readonly exhaustionReason: string }) => emitAiDiagnostic(sink,
      { domain: "retry", operation: "exhaust", phase: "failed",
        code: `${context.reasonCategory}:${context.exhaustionReason}`, retryable: false }),
  });
}
