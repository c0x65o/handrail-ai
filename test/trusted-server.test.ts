import { describe, expect, it, vi } from "vitest";

import {
  TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
  TRUSTED_SERVER_V1_LIMITS,
  TrustedServerOperationFailureV1,
  createTrustedServerRequestProtectorV1,
  trustedServerPublicErrorV1,
  type TrustedServerConcurrencyDecisionV1,
  type TrustedServerProtectedRequestV1,
  type TrustedServerProtectionHooksV1,
  type TrustedServerStoredResultV1,
  type TrustedServerTerminalRecordV1,
} from "../src/server/trusted-server.js";

type Principal = { readonly id: string; readonly label?: string };
type Reservation = { readonly key: string; readonly fingerprint: string };
type Lease = { readonly id: string };

interface IdempotencyEntry {
  fingerprint: string;
  status: "in_flight" | "completed" | "failed";
  result?: TrustedServerStoredResultV1;
}

function request(overrides: Partial<TrustedServerProtectedRequestV1> = {}): TrustedServerProtectedRequestV1 {
  return {
    version: TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
    requestId: "request.1",
    action: { id: "assistant.search", label: "Search" },
    resource: {
      id: "workspace.1",
      kind: "workspace",
      label: "Workspace",
      locator: "workspace:1",
    },
    origin: "https://app.example.test",
    body: { byteLength: 128 },
    idempotency: { key: "idem.1", fingerprint: "fingerprint.1" },
    metadata: { channel: "test" },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(options: {
  authorize?: boolean;
  rateLimit?: { allowed: true } | { allowed: false; retryAfterMs?: number };
  concurrency?: (
    request: TrustedServerProtectedRequestV1,
  ) => TrustedServerConcurrencyDecisionV1<Lease>;
  authenticate?: TrustedServerProtectionHooksV1<string, Principal, Reservation, Lease>["authenticate"];
  clock?: {
    setTimeout: (callback: () => void, milliseconds: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
} = {}) {
  const calls: string[] = [];
  const retained: TrustedServerTerminalRecordV1[] = [];
  const entries = new Map<string, IdempotencyEntry>();
  let leaseAvailable = true;

  const hooks: TrustedServerProtectionHooksV1<string, Principal, Reservation, Lease> = {
    validateOrigin: () => {
      calls.push("origin");
      return { allowed: true };
    },
    authenticate: options.authenticate ?? (() => {
      calls.push("authenticate");
      return { authenticated: true, principal: { id: "principal.1", label: "Person" } };
    }),
    authorize: () => {
      calls.push("authorize");
      return { allowed: options.authorize ?? true };
    },
    checkRateLimit: () => {
      calls.push("rate-limit");
      return options.rateLimit ?? { allowed: true };
    },
    reserveIdempotency: ({ request: protectedRequest }) => {
      calls.push("idempotency");
      const { key, fingerprint } = protectedRequest.idempotency;
      const existing = entries.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) return { status: "conflict" };
        if (existing.status === "in_flight") return { status: "in_flight", retryAfterMs: 25 };
        if (existing.status === "completed" && existing.result !== undefined) {
          return { status: "replay", result: existing.result };
        }
      }
      entries.set(key, { fingerprint, status: "in_flight" });
      return { status: "reserved", reservation: { key, fingerprint } };
    },
    acquireConcurrency: ({ request: protectedRequest }) => {
      calls.push("concurrency");
      if (options.concurrency !== undefined) return options.concurrency(protectedRequest);
      if (!leaseAvailable) return { status: "exhausted", retryAfterMs: 50 };
      leaseAvailable = false;
      return { status: "acquired", lease: { id: `lease:${protectedRequest.requestId}` } };
    },
    releaseConcurrency: () => {
      calls.push("release");
      leaseAvailable = true;
    },
    settleIdempotency: (settlement) => {
      calls.push(`settle:${settlement.status}`);
      const entry = entries.get(settlement.reservation.key);
      if (entry === undefined) throw new Error("missing reservation");
      if (settlement.status === "completed") {
        entry.status = "completed";
        entry.result = settlement.result;
      } else {
        entry.status = "failed";
      }
    },
    retainTerminal: (terminal) => {
      calls.push("retain");
      retained.push(terminal);
    },
  };
  const protector = createTrustedServerRequestProtectorV1({
    hooks,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  return {
    calls,
    retained,
    entries,
    hooks,
    protector,
    leaseAvailable: () => leaseAvailable,
  };
}

describe("trusted-server request protection v1", () => {
  it.each([
    ["invalid_request", "The request is invalid.", 400, false],
    ["invalid_origin", "The request origin is not allowed.", 403, false],
    ["invalid_body", "The request body is invalid or too large.", 413, false],
    ["unauthenticated", "Authentication is required.", 401, false],
    ["forbidden", "The requested action is not allowed.", 403, false],
    ["rate_limited", "Too many requests.", 429, true],
    ["idempotency_conflict", "The idempotency key conflicts with another request.", 409, false],
    ["idempotency_in_flight", "The idempotent request is still in progress.", 409, true],
    ["concurrency_exhausted", "Request concurrency is exhausted.", 429, true],
    ["cancelled", "The request was cancelled.", 499, false],
    ["deadline_exceeded", "The request deadline was exceeded.", 504, true],
    ["unavailable", "The protected operation is unavailable.", 503, true],
    ["internal_failure", "The protected request failed.", 500, false],
  ] as const)("maps %s to fixed provider-neutral public semantics", (code, message, status, retryable) => {
    expect(trustedServerPublicErrorV1(code)).toEqual({ code, message, status, retryable });
  });

  it("runs every gate before the protected operation and cleans up in exact order", async () => {
    const test = harness();

    const result = await test.protector.execute(
      { request: request(), authentication: "secret credential", deadlineMs: 1_000 },
      ({ principal, request: protectedRequest, signal }) => {
        test.calls.push("operation");
        expect(principal.id).toBe("principal.1");
        expect(protectedRequest.resource.locator).toBe("workspace:1");
        expect(signal).toBeInstanceOf(AbortSignal);
        return { status: 201, value: { accepted: true } };
      },
    );

    expect(result).toEqual({
      ok: true,
      status: 201,
      value: { accepted: true },
      replayed: false,
    });
    expect(test.calls).toEqual([
      "origin",
      "authenticate",
      "authorize",
      "rate-limit",
      "idempotency",
      "concurrency",
      "operation",
      "release",
      "settle:completed",
      "retain",
    ]);
    expect(test.retained).toEqual([{
      version: TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
      requestId: "request.1",
      actionId: "assistant.search",
      resourceId: "workspace.1",
      principalId: "principal.1",
      stage: "completed",
      outcome: "success",
    }]);
    expect(test.leaseAvailable()).toBe(true);
  });

  it("denies authorization before sensitive resolution or side effects", async () => {
    const test = harness({ authorize: false });
    const resolveSensitiveResource = vi.fn();
    const sideEffect = vi.fn();

    const result = await test.protector.execute(
      { request: request(), authentication: "secret" },
      async () => {
        resolveSensitiveResource();
        sideEffect();
        return { status: 200, value: null };
      },
    );

    expect(result).toEqual({ ok: false, error: trustedServerPublicErrorV1("forbidden") });
    expect(resolveSensitiveResource).not.toHaveBeenCalled();
    expect(sideEffect).not.toHaveBeenCalled();
    expect(test.calls).toEqual(["origin", "authenticate", "authorize", "retain"]);
    expect(test.retained[0]?.outcome).toBe("forbidden");
  });

  it("replays identical retries and rejects a reused key with another fingerprint", async () => {
    const test = harness();
    const operation = vi.fn(() => ({ status: 200, value: { answer: "stable" } } as const));

    const first = await test.protector.execute(
      { request: request(), authentication: "secret" },
      operation,
    );
    const replay = await test.protector.execute(
      { request: request({ requestId: "request.2" }), authentication: "secret" },
      operation,
    );
    const conflict = await test.protector.execute(
      {
        request: request({
          requestId: "request.3",
          idempotency: { key: "idem.1", fingerprint: "fingerprint.other" },
        }),
        authentication: "secret",
      },
      operation,
    );

    expect(first).toMatchObject({ ok: true, replayed: false, value: { answer: "stable" } });
    expect(replay).toEqual({ ok: true, status: 200, value: { answer: "stable" }, replayed: true });
    expect(conflict).toEqual({
      ok: false,
      error: trustedServerPublicErrorV1("idempotency_conflict"),
    });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(test.retained.map(({ outcome }) => outcome)).toEqual([
      "success",
      "replay",
      "idempotency_conflict",
    ]);
  });

  it("makes in-flight and concurrency exhaustion deterministic", async () => {
    const test = harness();
    const pending = deferred<TrustedServerStoredResultV1>();
    const first = test.protector.execute(
      { request: request(), authentication: "secret" },
      () => pending.promise,
    );
    await vi.waitFor(() => expect(test.calls).toContain("concurrency"));

    const inFlight = await test.protector.execute(
      { request: request({ requestId: "request.2" }), authentication: "secret" },
      () => ({ status: 200, value: "unexpected" }),
    );
    const exhausted = await test.protector.execute(
      {
        request: request({
          requestId: "request.3",
          idempotency: { key: "idem.3", fingerprint: "fingerprint.3" },
        }),
        authentication: "secret",
      },
      () => ({ status: 200, value: "unexpected" }),
    );

    expect(inFlight).toEqual({
      ok: false,
      error: trustedServerPublicErrorV1("idempotency_in_flight", 25),
    });
    expect(exhausted).toEqual({
      ok: false,
      error: trustedServerPublicErrorV1("concurrency_exhausted", 50),
    });
    expect(test.entries.get("idem.3")?.status).toBe("failed");
    pending.resolve({ status: 200, value: "done" });
    await expect(first).resolves.toMatchObject({ ok: true, value: "done" });
    expect(test.leaseAvailable()).toBe(true);
  });

  it.each(["authentication", "operation"] as const)(
    "normalizes caller cancellation during %s and performs applicable cleanup",
    async (phase) => {
      const controller = new AbortController();
      const never = new Promise<never>(() => undefined);
      const test = harness({
        ...(phase === "authentication"
          ? {
              authenticate: () => {
                test.calls.push("authenticate");
                controller.abort("credential=do-not-copy");
                return never;
              },
            }
          : {}),
      });

      const result = await test.protector.execute(
        { request: request(), authentication: "Bearer private-token", signal: controller.signal },
        () => {
          test.calls.push("operation");
          controller.abort("prompt and transcript must not escape");
          return never;
        },
      );

      expect(result).toEqual({ ok: false, error: trustedServerPublicErrorV1("cancelled") });
      expect(JSON.stringify({ result, terminal: test.retained })).not.toContain("private-token");
      expect(JSON.stringify({ result, terminal: test.retained })).not.toContain("transcript");
      expect(test.retained[0]?.outcome).toBe("cancelled");
      if (phase === "operation") {
        expect(test.calls.slice(-3)).toEqual(["release", "settle:failed", "retain"]);
        expect(test.leaseAvailable()).toBe(true);
      } else {
        expect(test.calls).toEqual(["origin", "authenticate", "retain"]);
      }
    },
  );

  it.each(["authentication", "operation"] as const)(
    "normalizes the bounded deadline during %s and performs applicable cleanup",
    async (phase) => {
      let deadline!: () => void;
      const never = new Promise<never>(() => undefined);
      const test = harness({
        clock: {
          setTimeout: (callback) => {
            deadline = callback;
            return "timer";
          },
          clearTimeout: vi.fn(),
        },
        ...(phase === "authentication"
          ? {
              authenticate: () => {
                test.calls.push("authenticate");
                deadline();
                return never;
              },
            }
          : {}),
      });

      const result = await test.protector.execute(
        { request: request(), authentication: "secret", deadlineMs: 10 },
        () => {
          test.calls.push("operation");
          deadline();
          return never;
        },
      );

      expect(result).toEqual({
        ok: false,
        error: trustedServerPublicErrorV1("deadline_exceeded"),
      });
      expect(test.retained[0]?.outcome).toBe("deadline_exceeded");
      if (phase === "operation") {
        expect(test.calls.slice(-3)).toEqual(["release", "settle:failed", "retain"]);
      }
    },
  );

  it("bounds request fields, bodies, retry hints, deadlines, and public values", async () => {
    const test = harness({ rateLimit: { allowed: false, retryAfterMs: Number.MAX_SAFE_INTEGER } });
    const oversizedLabel = "x".repeat(TRUSTED_SERVER_V1_LIMITS.labelLength + 1);
    const invalid = await test.protector.execute(
      {
        request: request({ action: { id: "assistant.search", label: oversizedLabel } }),
        authentication: "secret",
      },
      () => ({ status: 200, value: null }),
    );
    const invalidOrigin = await test.protector.execute(
      { request: request({ origin: "https://user:password@example.test" }), authentication: "secret" },
      () => ({ status: 200, value: null }),
    );
    const invalidBody = await test.protector.execute(
      {
        request: request({ body: { byteLength: TRUSTED_SERVER_V1_LIMITS.maximumBodyBytes + 1 } }),
        authentication: "secret",
      },
      () => ({ status: 200, value: null }),
    );
    const invalidDeadline = await test.protector.execute(
      { request: request({ requestId: "request.deadline" }), authentication: "secret", deadlineMs: 0 },
      () => ({ status: 200, value: null }),
    );
    const limited = await test.protector.execute(
      { request: request({ requestId: "request.rate" }), authentication: "secret" },
      () => ({ status: 200, value: null }),
    );

    expect(invalid).toEqual({ ok: false, error: trustedServerPublicErrorV1("invalid_request") });
    expect(invalidOrigin).toEqual({ ok: false, error: trustedServerPublicErrorV1("invalid_origin") });
    expect(invalidBody).toEqual({ ok: false, error: trustedServerPublicErrorV1("invalid_body") });
    expect(invalidDeadline).toEqual({ ok: false, error: trustedServerPublicErrorV1("invalid_request") });
    expect(limited).toEqual({
      ok: false,
      error: trustedServerPublicErrorV1("rate_limited", TRUSTED_SERVER_V1_LIMITS.maximumRetryAfterMs),
    });
    expect(test.calls.filter((call) => call === "authenticate")).toHaveLength(1);

    const publicValueTest = harness();
    const oversizedValue = "x".repeat(TRUSTED_SERVER_V1_LIMITS.publicStringLength + 1);
    const rejectedValue = await publicValueTest.protector.execute(
      { request: request(), authentication: "secret" },
      () => ({ status: 200, value: oversizedValue }),
    );
    expect(rejectedValue).toEqual({
      ok: false,
      error: trustedServerPublicErrorV1("internal_failure"),
    });
    expect(publicValueTest.calls.slice(-3)).toEqual(["release", "settle:failed", "retain"]);
  });

  it("replaces thrown internals and credentials with fixed errors while retaining and cleaning up", async () => {
    const test = harness();
    const result = await test.protector.execute(
      { request: request(), authentication: "Bearer credential-123" },
      () => {
        throw new Error("credential-123 prompt attachment transcript provider-native-data");
      },
    );

    expect(result).toEqual({
      ok: false,
      error: trustedServerPublicErrorV1("internal_failure"),
    });
    expect(JSON.stringify({ result, terminal: test.retained })).toBe(
      JSON.stringify({
        result: { ok: false, error: trustedServerPublicErrorV1("internal_failure") },
        terminal: [{
          version: TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
          requestId: "request.1",
          actionId: "assistant.search",
          resourceId: "workspace.1",
          principalId: "principal.1",
          stage: "operation",
          outcome: "internal_failure",
        }],
      }),
    );
    expect(test.calls.slice(-3)).toEqual(["release", "settle:failed", "retain"]);
    expect(test.leaseAvailable()).toBe(true);

    const unavailable = harness();
    const unavailableResult = await unavailable.protector.execute(
      { request: request(), authentication: "secret" },
      () => {
        throw new TrustedServerOperationFailureV1("unavailable");
      },
    );
    expect(unavailableResult).toEqual({
      ok: false,
      error: trustedServerPublicErrorV1("unavailable"),
    });
  });

  it("makes cleanup calls one-shot and ignores terminal retention failures", async () => {
    const test = harness();
    const release = vi.spyOn(test.hooks, "releaseConcurrency").mockImplementation(async () => {
      test.calls.push("release");
    });
    const settle = vi.spyOn(test.hooks, "settleIdempotency");
    vi.spyOn(test.hooks, "retainTerminal").mockImplementation(async () => {
      test.calls.push("retain");
      throw new Error("retention credential should stay private");
    });

    const result = await test.protector.execute(
      { request: request(), authentication: "secret" },
      () => ({ status: 200, value: "ok" }),
    );

    expect(result).toMatchObject({ ok: true, value: "ok" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("requires bounded constructor configuration", () => {
    const test = harness();
    expect(() => createTrustedServerRequestProtectorV1({
      hooks: test.hooks,
      maximumDeadlineMs: TRUSTED_SERVER_V1_LIMITS.maximumDeadlineMs + 1,
    })).toThrow("maximumDeadlineMs");
    expect(() => createTrustedServerRequestProtectorV1({
      hooks: test.hooks,
      maximumBodyBytes: TRUSTED_SERVER_V1_LIMITS.maximumBodyBytes + 1,
    })).toThrow("maximumBodyBytes");
  });
});
