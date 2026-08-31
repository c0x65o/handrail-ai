export type AiDiagnosticDomain =
  | "provider" | "gateway" | "retry" | "tool" | "mcp" | "approval" | "presence" | "activity"
  | "persistence" | "attachment" | "policy" | "validation" | "upstream";
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
  readonly toolCallId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly statusCode?: number;
  /** Host-only original failure. Never serialized or included in public metadata. */
  readonly cause?: unknown;
}

export type AiDiagnosticSink = (event: AiDiagnosticEvent) => void;

/** Structural subset supported by Pino and other structured application loggers. */
export interface AiDiagnosticLogger {
  debug(value: unknown, message?: string): void;
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
  error(value: unknown, message?: string): void;
}

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

/**
 * Create a safe structured logger sink. The original cause is deliberately
 * omitted because provider/tool failures may retain prompts or sensitive host
 * data; applications can capture it in a separate access-controlled sink.
 */
export function createAiDiagnosticLoggerSink(
  logger: AiDiagnosticLogger,
  message = "AI operation lifecycle",
): AiDiagnosticSink {
  return (event) => {
    const value = publicAiDiagnostic(event);
    if (event.phase === "failed") logger.error(value, message);
    else if (event.phase === "retrying") logger.warn(value, message);
    else if (event.phase === "started") logger.debug(value, message);
    else logger.info(value, message);
  };
}

export async function diagnoseAiOperation<T>(
  sink: AiDiagnosticSink | undefined,
  input: Omit<AiDiagnosticEvent, "timestamp" | "phase" | "cause">,
  execute: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  emitAiDiagnostic(sink, { ...input, phase: "started" });
  try {
    const value = await execute();
    emitAiDiagnostic(sink, { ...input, phase: "succeeded", durationMs: Date.now() - startedAt });
    return value;
  } catch (cause) {
    emitAiDiagnostic(sink, { ...input, phase: "failed", durationMs: Date.now() - startedAt, cause });
    throw cause;
  }
}

/** Adapter for the existing retry engine's lifecycle hooks. */
export function createRetryDiagnosticHooks(sink: AiDiagnosticSink | undefined) {
  return Object.freeze({
    onAttemptStarted: (context: { readonly attempt: number }) => emitAiDiagnostic(sink,
      { domain: "retry", operation: "attempt", phase: "started", attempt: context.attempt }),
    onRetryScheduled: (context: { readonly reasonCategory: string; readonly nextAttempt: number }) => emitAiDiagnostic(sink,
      { domain: "retry", operation: "schedule", phase: "retrying", code: context.reasonCategory,
        retryable: true, attempt: context.nextAttempt }),
    onRetryExhausted: (context: { readonly reasonCategory: string; readonly exhaustionReason: string }) => emitAiDiagnostic(sink,
      { domain: "retry", operation: "exhaust", phase: "failed",
        code: `${context.reasonCategory}:${context.exhaustionReason}`, retryable: false }),
  });
}
