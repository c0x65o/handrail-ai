import { afterEach, expect, it, vi } from "vitest";
import { createRealtimeCallLease } from "../src/realtime/call-lease.js";

afterEach(() => { vi.useRealTimers(); });

it("aborts at the last confirmed deadline if a renewal stalls, without overlapping renewals", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  let release!: (value: { leaseExpiresAt: number }) => void;
  const renewLease = vi.fn().mockResolvedValueOnce({ leaseExpiresAt: 4_000 })
    .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const lease = await createRealtimeCallLease({ store: { renewLease }, callId: "call", workerId: "worker" });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(renewLease).toHaveBeenCalledTimes(2);
  expect(lease.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(lease.signal.aborted).toBe(true);
  release({ leaseExpiresAt: 7_000 });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(lease.signal.aborted).toBe(true);
  expect(renewLease).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops on an end-request renewal conflict and cleans timers on explicit close", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  const renewLease = vi.fn().mockResolvedValueOnce({ leaseExpiresAt: 4_000 }).mockRejectedValueOnce(new Error("ending"));
  const lease = await createRealtimeCallLease({ store: { renewLease }, callId: "call", workerId: "worker" });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(lease.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  const second = await createRealtimeCallLease({ store: { renewLease: async () => ({ leaseExpiresAt: 5_000 }) }, callId: "other", workerId: "worker" });
  second.close(); second.close();
  expect(second.signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
