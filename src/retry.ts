export type RetryReasonCategory =
  | "rate_limit"
  | "timeout"
  | "unavailable"
  | "internal"
  | "disconnected"
  | "interrupted";

export type RetryExhaustionReason =
  | "non_retryable"
  | "maximum_attempts"
  | "maximum_elapsed_time";

export interface RetryFailure {
  readonly retryable: boolean;
  readonly reasonCategory: RetryReasonCategory;
  /** A provider-neutral, already-normalized millisecond hint. */
  readonly retryAfterMs?: number;
}

export interface RetryPolicy {
  readonly maximumAttempts: number;
  readonly maximumElapsedMs: number;
  readonly initialDelayMs: number;
  readonly backoffMultiplier: number;
  readonly maximumDelayMs: number;
  /** Maximum proportional variation around the exponential delay, from 0 to 1. */
  readonly jitterRatio: number;
  /** Upper bound applied to normalized Retry-After hints. */
  readonly maximumRetryAfterMs: number;
  readonly now: () => number;
  readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Returns a value in the half-open interval [0, 1). */
  readonly random: () => number;
}

export interface RetryPolicyOptions {
  readonly maximumAttempts?: number;
  readonly maximumElapsedMs?: number;
  readonly initialDelayMs?: number;
  readonly backoffMultiplier?: number;
  readonly maximumDelayMs?: number;
  readonly jitterRatio?: number;
  readonly maximumRetryAfterMs?: number;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export interface RetryAttemptContext {
  readonly attempt: number;
  readonly elapsedMs: number;
}

export interface RetryScheduledContext extends RetryAttemptContext {
  readonly nextAttempt: number;
  readonly reasonCategory: RetryReasonCategory;
  readonly delayMs: number;
}

export interface RetryExhaustedContext extends RetryAttemptContext {
  readonly reasonCategory: RetryReasonCategory;
  readonly exhaustionReason: Exclude<RetryExhaustionReason, "non_retryable">;
}

export interface RetryExecutionHooks {
  readonly onAttemptStarted?: (context: RetryAttemptContext) => void | Promise<void>;
  readonly onRetryScheduled?: (context: RetryScheduledContext) => void | Promise<void>;
  readonly onRetryExhausted?: (context: RetryExhaustedContext) => void | Promise<void>;
}

export interface RetryOperationSuccess<TValue> {
  readonly ok: true;
  readonly value: TValue;
}

export interface RetryOperationFailure<TFailure extends RetryFailure> {
  readonly ok: false;
  readonly failure: TFailure;
}

export type RetryOperationResult<TValue, TFailure extends RetryFailure> =
  | RetryOperationSuccess<TValue>
  | RetryOperationFailure<TFailure>;

export interface RetryExecutionSuccess<TValue> {
  readonly ok: true;
  readonly value: TValue;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export interface RetryExecutionFailure<TFailure extends RetryFailure> {
  readonly ok: false;
  readonly failure: TFailure;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly exhaustionReason: RetryExhaustionReason;
}

export type RetryExecutionResult<TValue, TFailure extends RetryFailure> =
  | RetryExecutionSuccess<TValue>
  | RetryExecutionFailure<TFailure>;

const DEFAULT_POLICY = Object.freeze({
  maximumAttempts: 3,
  maximumElapsedMs: 30_000,
  initialDelayMs: 250,
  backoffMultiplier: 2,
  maximumDelayMs: 5_000,
  jitterRatio: 0.2,
  maximumRetryAfterMs: 30_000,
});

/** Create a validated, browser-safe bounded retry policy. */
export function createRetryPolicy(options: RetryPolicyOptions = {}): RetryPolicy {
  const policy: RetryPolicy = {
    maximumAttempts: options.maximumAttempts ?? DEFAULT_POLICY.maximumAttempts,
    maximumElapsedMs: options.maximumElapsedMs ?? DEFAULT_POLICY.maximumElapsedMs,
    initialDelayMs: options.initialDelayMs ?? DEFAULT_POLICY.initialDelayMs,
    backoffMultiplier: options.backoffMultiplier ?? DEFAULT_POLICY.backoffMultiplier,
    maximumDelayMs: options.maximumDelayMs ?? DEFAULT_POLICY.maximumDelayMs,
    jitterRatio: options.jitterRatio ?? DEFAULT_POLICY.jitterRatio,
    maximumRetryAfterMs:
      options.maximumRetryAfterMs ?? DEFAULT_POLICY.maximumRetryAfterMs,
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? abortableSleep,
    random: options.random ?? (() => Math.random()),
  };
  validatePolicy(policy);
  return Object.freeze(policy);
}

export async function executeWithRetry<
  TValue,
  TFailure extends RetryFailure,
>(
  operation: (
    context: RetryAttemptContext,
  ) => Promise<RetryOperationResult<TValue, TFailure>>,
  options: {
    readonly policy: RetryPolicy;
    readonly signal: AbortSignal;
    readonly hooks?: RetryExecutionHooks;
  },
): Promise<RetryExecutionResult<TValue, TFailure>> {
  const { policy, signal, hooks } = options;
  validatePolicy(policy);
  const startedAt = policy.now();
  let attempt = 1;

  for (;;) {
    throwIfAborted(signal);
    const attemptContext = Object.freeze({
      attempt,
      elapsedMs: elapsed(policy, startedAt),
    });
    await hooks?.onAttemptStarted?.(attemptContext);
    throwIfAborted(signal);

    const outcome = await operation(attemptContext);
    const elapsedMs = elapsed(policy, startedAt);
    if (outcome.ok) {
      return Object.freeze({
        ok: true,
        value: outcome.value,
        attempts: attempt,
        elapsedMs,
      });
    }
    if (!outcome.failure.retryable) {
      return Object.freeze({
        ok: false,
        failure: outcome.failure,
        attempts: attempt,
        elapsedMs,
        exhaustionReason: "non_retryable",
      });
    }

    if (attempt >= policy.maximumAttempts) {
      await hooks?.onRetryExhausted?.(Object.freeze({
        attempt,
        elapsedMs,
        reasonCategory: outcome.failure.reasonCategory,
        exhaustionReason: "maximum_attempts",
      }));
      return Object.freeze({
        ok: false,
        failure: outcome.failure,
        attempts: attempt,
        elapsedMs,
        exhaustionReason: "maximum_attempts",
      });
    }

    const delayMs = retryDelay(policy, attempt, outcome.failure.retryAfterMs);
    if (elapsedMs >= policy.maximumElapsedMs ||
      delayMs > policy.maximumElapsedMs - elapsedMs) {
      await hooks?.onRetryExhausted?.(Object.freeze({
        attempt,
        elapsedMs,
        reasonCategory: outcome.failure.reasonCategory,
        exhaustionReason: "maximum_elapsed_time",
      }));
      return Object.freeze({
        ok: false,
        failure: outcome.failure,
        attempts: attempt,
        elapsedMs,
        exhaustionReason: "maximum_elapsed_time",
      });
    }

    await hooks?.onRetryScheduled?.(Object.freeze({
      attempt,
      nextAttempt: attempt + 1,
      elapsedMs,
      reasonCategory: outcome.failure.reasonCategory,
      delayMs,
    }));
    throwIfAborted(signal);
    await policy.sleep(delayMs, signal);
    throwIfAborted(signal);
    attempt += 1;
  }
}

export function retryDelay(
  policy: RetryPolicy,
  failedAttempt: number,
  retryAfterMs?: number,
): number {
  if (!Number.isSafeInteger(failedAttempt) || failedAttempt < 1) {
    throw new TypeError("failedAttempt must be a positive safe integer");
  }
  const exponential = Math.min(
    policy.maximumDelayMs,
    policy.initialDelayMs * policy.backoffMultiplier ** (failedAttempt - 1),
  );
  const random = policy.random();
  if (!Number.isFinite(random) || random < 0 || random >= 1) {
    throw new TypeError("RetryPolicy.random must return a number in [0, 1)");
  }
  const jittered = Math.max(
    0,
    Math.min(
      policy.maximumDelayMs,
      exponential * (1 + (random * 2 - 1) * policy.jitterRatio),
    ),
  );
  const normalizedHint = retryAfterMs === undefined
    ? 0
    : Math.min(
        policy.maximumRetryAfterMs,
        Math.max(0, Number.isFinite(retryAfterMs) ? retryAfterMs : 0),
      );
  return Math.ceil(Math.max(jittered, normalizedHint));
}

function validatePolicy(policy: RetryPolicy): void {
  positiveSafeInteger(policy.maximumAttempts, "maximumAttempts");
  nonnegativeFinite(policy.maximumElapsedMs, "maximumElapsedMs");
  nonnegativeFinite(policy.initialDelayMs, "initialDelayMs");
  if (!Number.isFinite(policy.backoffMultiplier) || policy.backoffMultiplier < 1) {
    throw new TypeError("backoffMultiplier must be a finite number of at least 1");
  }
  nonnegativeFinite(policy.maximumDelayMs, "maximumDelayMs");
  if (!Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 || policy.jitterRatio > 1) {
    throw new TypeError("jitterRatio must be a finite number from 0 to 1");
  }
  nonnegativeFinite(policy.maximumRetryAfterMs, "maximumRetryAfterMs");
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function nonnegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
}

function elapsed(policy: RetryPolicy, startedAt: number): number {
  const value = policy.now() - startedAt;
  if (!Number.isFinite(value)) {
    throw new TypeError("RetryPolicy.now must return a finite number");
  }
  return Math.max(0, value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("The retry was aborted", "AbortError");
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(done, delayMs);
    signal.addEventListener("abort", aborted, { once: true });

    function done(): void {
      signal.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted(): void {
      globalThis.clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("The retry was aborted", "AbortError"));
    }
  });
}
