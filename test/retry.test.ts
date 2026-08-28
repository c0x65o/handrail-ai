import { describe, expect, it, vi } from "vitest";

import {
  createRetryPolicy,
  executeWithRetry,
  type RetryFailure,
} from "../src/index.js";

const retryable: RetryFailure = {
  retryable: true,
  reasonCategory: "unavailable",
};

function fakeClockPolicy(overrides: Parameters<typeof createRetryPolicy>[0] = {}) {
  let time = 0;
  const sleeps: number[] = [];
  const policy = createRetryPolicy({
    maximumAttempts: 4,
    maximumElapsedMs: 10_000,
    initialDelayMs: 100,
    backoffMultiplier: 2,
    maximumDelayMs: 2_000,
    jitterRatio: 0,
    maximumRetryAfterMs: 3_000,
    now: () => time,
    random: () => 0.5,
    sleep: async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
      time += delayMs;
    },
    ...overrides,
  });
  return {
    policy,
    sleeps,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

describe("bounded retry execution", () => {
  it("retries an explicitly retryable failure and then returns success", async () => {
    const clock = fakeClockPolicy();
    let calls = 0;
    const result = await executeWithRetry(async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, failure: retryable }
        : { ok: true, value: "ready" };
    }, {
      policy: clock.policy,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ ok: true, value: "ready", attempts: 2 });
    expect(clock.sleeps).toEqual([100]);
  });

  it("does not retry a non-retryable failure", async () => {
    const clock = fakeClockPolicy();
    const operation = vi.fn(async () => ({
      ok: false as const,
      failure: {
        retryable: false,
        reasonCategory: "interrupted" as const,
      },
    }));
    const result = await executeWithRetry(operation, {
      policy: clock.policy,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      ok: false,
      attempts: 1,
      exhaustionReason: "non_retryable",
    });
    expect(operation).toHaveBeenCalledOnce();
    expect(clock.sleeps).toEqual([]);
  });

  it("stops after the maximum attempt count", async () => {
    const clock = fakeClockPolicy({ maximumAttempts: 3, initialDelayMs: 10 });
    const exhausted = vi.fn();
    const result = await executeWithRetry(
      async () => ({ ok: false, failure: retryable }),
      {
        policy: clock.policy,
        signal: new AbortController().signal,
        hooks: { onRetryExhausted: exhausted },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      attempts: 3,
      exhaustionReason: "maximum_attempts",
    });
    expect(clock.sleeps).toEqual([10, 20]);
    expect(exhausted).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 3,
      exhaustionReason: "maximum_attempts",
    }));
  });

  it("does not schedule a delay beyond the elapsed-time budget", async () => {
    const clock = fakeClockPolicy({
      maximumElapsedMs: 1_000,
      initialDelayMs: 700,
    });
    const result = await executeWithRetry(
      async () => ({ ok: false, failure: retryable }),
      {
        policy: clock.policy,
        signal: new AbortController().signal,
      },
    );

    expect(result).toMatchObject({
      ok: false,
      attempts: 2,
      elapsedMs: 700,
      exhaustionReason: "maximum_elapsed_time",
    });
    expect(clock.sleeps).toEqual([700]);
  });

  it("caps a normalized Retry-After hint", async () => {
    const clock = fakeClockPolicy({
      initialDelayMs: 10,
      maximumDelayMs: 100,
      maximumRetryAfterMs: 2_000,
    });
    let calls = 0;
    const result = await executeWithRetry(async () => {
      calls += 1;
      return calls === 1
        ? {
            ok: false,
            failure: { ...retryable, retryAfterMs: 60_000 },
          }
        : { ok: true, value: "ready" };
    }, {
      policy: clock.policy,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    expect(clock.sleeps).toEqual([2_000]);
  });

  it("aborts immediately while a retry delay is pending", async () => {
    const controller = new AbortController();
    let sleepingSignal: AbortSignal | null = null;
    let markSleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const policy = createRetryPolicy({
      maximumAttempts: 2,
      initialDelayMs: 1_000,
      jitterRatio: 0,
      sleep: (_delayMs, signal) => {
        sleepingSignal = signal;
        markSleepStarted();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    });
    const pending = executeWithRetry(
      async () => ({ ok: false, failure: retryable }),
      { policy, signal: controller.signal },
    );
    await sleepStarted;
    const reason = new Error("stop retrying");

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(sleepingSignal).toBe(controller.signal);
  });
});
