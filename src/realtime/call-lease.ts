/** Minimal server persistence contract; provider and domain policy remain host-owned. */
export interface RealtimeCallLeaseStore {
  renewLease(callId: string, workerId: string): Promise<{ readonly leaseExpiresAt: number }>;
}

/**
 * Serial heartbeat plus an independent expiry watchdog. Failed or stalled
 * storage aborts work by the last confirmed deadline. It never recreates a call
 * or claims that the remote provider has ended. Closing also aborts work.
 */
export async function createRealtimeCallLease(input: {
  readonly store: RealtimeCallLeaseStore;
  readonly callId: string;
  readonly workerId: string;
  readonly clock?: () => number;
}) {
  const clock = input.clock ?? Date.now;
  const controller = new AbortController();
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const close = () => {
    closed = true;
    clearTimeout(heartbeat); clearTimeout(watchdog);
    controller.abort();
  };
  const arm = (expiresAt: number) => {
    if (closed) return;
    const remaining = expiresAt - clock();
    if (!Number.isSafeInteger(expiresAt) || !Number.isFinite(remaining) || remaining <= 0 || remaining > 120_000) {
      close(); return;
    }
    clearTimeout(watchdog);
    watchdog = setTimeout(close, remaining);
    heartbeat = setTimeout(() => { void renew(); }, Math.max(1, Math.floor(remaining / 3)));
  };
  const renew = async () => {
    if (closed) return;
    try { arm((await input.store.renewLease(input.callId, input.workerId)).leaseExpiresAt); }
    catch { close(); }
  };
  // Admission failure propagates; no live lease is returned without a committed renewal.
  arm((await input.store.renewLease(input.callId, input.workerId)).leaseExpiresAt);
  return Object.freeze({ signal: controller.signal, close });
}
