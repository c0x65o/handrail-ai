import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  REALTIME_VOICE_CONTRACT_VERSION,
  REALTIME_VOICE_LIMITS,
  RealtimeVoiceOperationError,
  RealtimeVoiceTransitionError,
  RealtimeVoiceValidationError,
  applyRealtimeVoiceSessionEvent,
  createIdempotentRealtimeVoiceSessionAuthority,
  createRealtimeVoiceClientSession,
  createRealtimeVoiceSessionState,
  narrowRealtimeVoiceCapabilities,
  normalizeRealtimeVoiceError,
  parseRealtimeVoiceBootstrapRequest,
  parseRealtimeVoiceBootstrapResult,
  parseRealtimeVoiceCleanupRequest,
  parseRealtimeVoiceHangupRequest,
  parseRealtimeVoiceSafeError,
  parseRealtimeVoiceSessionState,
  realtimeVoiceSafeError,
  type RealtimeVoiceBootstrapRequest,
  type RealtimeVoiceClientAdapter,
  type RealtimeVoiceIdempotencyKey,
  type RealtimeVoiceRequestId,
  type RealtimeVoiceSessionEvent,
  type RealtimeVoiceSessionId,
} from "../src/index.js";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const timestamp = (offset: number) => new Date(NOW + offset).toISOString();

const requestValue = (overrides: Record<string, unknown> = {}) => ({
  version: REALTIME_VOICE_CONTRACT_VERSION,
  request_id: "request-1",
  idempotency_key: "bootstrap:conversation-1",
  configuration: {
    transport: "webrtc",
    maximum_duration_ms: 600_000,
    idle_timeout_ms: 60_000,
    input_audio: { encoding: "pcm16", sample_rate_hz: 24_000, channels: 1 },
    output_audio: { encoding: "opus", sample_rate_hz: 48_000, channels: 2 },
  },
  requested_capabilities: {
    input_audio: true,
    output_audio: true,
    interruption: true,
    server_tool_execution: { capability_ref: "tools:voice-policy-1" },
  },
  ...overrides,
});

const request = (): RealtimeVoiceBootstrapRequest =>
  parseRealtimeVoiceBootstrapRequest(requestValue());

const resultValue = (overrides: Record<string, unknown> = {}) => ({
  version: REALTIME_VOICE_CONTRACT_VERSION,
  request_id: "request-1",
  session_id: "session-1",
  issued_at: timestamp(0),
  expires_at: timestamp(600_000),
  authorization: {
    kind: "opaque_ephemeral",
    value: "ephemeral_value_123456",
    expires_at: timestamp(120_000),
  },
  connection: { transport: "webrtc", reference: "connection:opaque-1" },
  configuration: requestValue().configuration,
  capabilities: {
    input_audio: { supported: true },
    output_audio: { supported: true },
    interruption: { supported: true },
    server_tool_execution: {
      supported: true,
      capability_ref: "tools:voice-policy-1",
    },
  },
  ...overrides,
});

const event = (
  sequence: number,
  type: RealtimeVoiceSessionEvent["type"],
  overrides: Record<string, unknown> = {},
) => ({
  version: REALTIME_VOICE_CONTRACT_VERSION,
  session_id: "session-1",
  event_id: `event-${sequence}`,
  sequence,
  occurred_at: timestamp(sequence),
  type,
  ...(type === "session_failed"
    ? { error: realtimeVoiceSafeError("temporarily_unavailable") }
    : {}),
  ...overrides,
});

describe("realtime voice bootstrap contracts", () => {
  it("strictly validates bounded provider-neutral requests", () => {
    const parsed = request();
    expect(parsed.version).toBe(REALTIME_VOICE_CONTRACT_VERSION);
    expect(parsed.configuration.input_audio).toEqual({
      encoding: "pcm16",
      sample_rate_hz: 24_000,
      channels: 1,
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expectTypeOf(parsed.requested_capabilities.server_tool_execution)
      .toMatchTypeOf<false | { readonly capability_ref: string }>();

    for (const invalid of [
      requestValue({ api_key: "long-lived-secret" }),
      requestValue({ provider_request: { model: "native" } }),
      requestValue({ prompt: "private prompt" }),
      requestValue({ transcript: "private transcript" }),
      requestValue({ audio: "raw-audio-contents" }),
      requestValue({ instructions: "hidden" }),
      requestValue({ tools: [{ callback: () => undefined }] }),
    ]) {
      expect(() => parseRealtimeVoiceBootstrapRequest(invalid)).toThrow(
        RealtimeVoiceValidationError,
      );
    }
  });

  it("enforces audio, duration, idempotency, and capability-reference bounds", () => {
    expect(() => parseRealtimeVoiceBootstrapRequest(requestValue({
      configuration: {
        ...requestValue().configuration as object,
        maximum_duration_ms: REALTIME_VOICE_LIMITS.maximumSessionDurationMs + 1,
      },
    }))).toThrow(/maximum_duration_ms/);
    expect(() => parseRealtimeVoiceBootstrapRequest(requestValue({
      idempotency_key: "x".repeat(REALTIME_VOICE_LIMITS.idempotencyKeyLength + 1),
    }))).toThrow(/idempotency_key/);
    expect(() => parseRealtimeVoiceBootstrapRequest(requestValue({
      requested_capabilities: {
        ...(requestValue().requested_capabilities as object),
        server_tool_execution: {
          capability_ref: "x".repeat(REALTIME_VOICE_LIMITS.capabilityReferenceLength + 1),
        },
      },
    }))).toThrow(/capability_ref/);
    expect(() => parseRealtimeVoiceBootstrapRequest(requestValue({
      requested_capabilities: {
        ...(requestValue().requested_capabilities as object),
        input_audio: false,
      },
    }))).toThrow(/must match/);
  });

  it("accepts only a short-lived, unexpired opaque client authorization", () => {
    const parsed = parseRealtimeVoiceBootstrapResult(resultValue(), {
      request: request(),
      now: NOW,
    });
    expect(parsed.authorization.kind).toBe("opaque_ephemeral");
    expect(Object.isFrozen(parsed.authorization)).toBe(true);

    expect(() => parseRealtimeVoiceBootstrapResult(resultValue({
      authorization: {
        kind: "opaque_ephemeral",
        value: "ephemeral_value_123456",
        expires_at: timestamp(REALTIME_VOICE_LIMITS.maximumAuthorizationTtlMs + 1),
      },
    }), { request: request(), now: NOW })).toThrow(/short-lived/);
    expect(() => parseRealtimeVoiceBootstrapResult(resultValue(), {
      request: request(),
      now: NOW + 120_000,
    })).toThrow(/expired/);
  });

  it("rejects credentials, secrets, provider-native payloads, and sensitive normalized data", () => {
    for (const extra of [
      { api_key: "sk-provider-long-lived" },
      { credentials: { refresh_token: "secret" } },
      { provider_response: { session: "native" } },
      { raw_request: { sdp: "native" } },
      { prompt: "private" },
      { transcript: "private" },
      { audio_contents: "base64-audio" },
      { hidden_instructions: "private" },
      { tool_arguments: { sensitive: true } },
    ]) {
      expect(() => parseRealtimeVoiceBootstrapResult(resultValue(extra), {
        request: request(),
        now: NOW,
      })).toThrow(RealtimeVoiceValidationError);
    }
    expect(() => parseRealtimeVoiceBootstrapResult(resultValue({
      authorization: {
        kind: "opaque_ephemeral",
        value: "Bearer provider-credential-value",
        expires_at: timestamp(60_000),
      },
    }), { now: NOW })).toThrow(/credential|opaque/);
  });
});

describe("realtime voice capability negotiation", () => {
  it("only removes capabilities and preserves the opaque server-tool scope", () => {
    const narrowed = narrowRealtimeVoiceCapabilities({
      input_audio: true,
      output_audio: false,
      interruption: true,
      server_tool_execution: false,
    }, {
      input_audio: { supported: true },
      output_audio: { supported: true },
      interruption: { supported: false, reason: "provider_not_supported" },
      server_tool_execution: {
        supported: true,
        capability_ref: "tools:unrequested",
      },
    });
    expect(narrowed).toEqual({
      input_audio: { supported: true },
      output_audio: { supported: false, reason: "not_requested" },
      interruption: { supported: false, reason: "provider_not_supported" },
      server_tool_execution: { supported: false, reason: "not_requested" },
    });

    expect(() => narrowRealtimeVoiceCapabilities(
      request().requested_capabilities,
      {
        input_audio: { supported: true },
        output_audio: { supported: true },
        interruption: { supported: true },
        server_tool_execution: {
          supported: true,
          capability_ref: "tools:elevated-scope",
        },
      },
    )).toThrow(/exactly match/);
  });

  it("requires an explicit unsupported descriptor for every unavailable capability", () => {
    expect(() => narrowRealtimeVoiceCapabilities(
      request().requested_capabilities,
      {
        input_audio: { supported: true },
        output_audio: { supported: true },
        interruption: undefined,
        server_tool_execution: {
          supported: false,
          reason: "server_tools_not_configured",
        },
      },
    )).toThrow(/interruption/);
  });
});

describe("normalized realtime voice state and events", () => {
  it("projects bootstrap data without retaining authorization or connection internals", () => {
    const state = createRealtimeVoiceSessionState(resultValue(), {
      request: request(),
      now: NOW,
    });
    const serialized = JSON.stringify(state);
    expect(state.status).toBe("ready");
    expect(serialized).not.toMatch(/authorization|ephemeral_value|connection/);
    expect(() => parseRealtimeVoiceSessionState({
      ...state,
      provider_response: { secret: true },
    })).toThrow(/provider_response/);
    expect(() => parseRealtimeVoiceSessionState({
      ...state,
      transcript: "sensitive words",
    })).toThrow(/transcript/);
  });

  it("applies valid transitions and rejects invalid ones", () => {
    let state = createRealtimeVoiceSessionState(resultValue(), { now: NOW });
    state = applyRealtimeVoiceSessionEvent(state, event(1, "session_started"));
    state = applyRealtimeVoiceSessionEvent(state, event(2, "response_started"));
    expect(state).toMatchObject({ status: "active", response_active: true });
    state = applyRealtimeVoiceSessionEvent(state, event(3, "response_interrupted"));
    state = applyRealtimeVoiceSessionEvent(state, event(4, "local_media_stopped"));
    state = applyRealtimeVoiceSessionEvent(state, event(5, "hangup_started"));
    state = applyRealtimeVoiceSessionEvent(state, event(6, "session_ended"));
    expect(state).toMatchObject({
      status: "ended",
      response_active: false,
      local_media: "stopped",
      error: null,
    });
    expect(() => applyRealtimeVoiceSessionEvent(
      state,
      event(7, "session_started"),
    )).toThrow(RealtimeVoiceTransitionError);

    const ready = createRealtimeVoiceSessionState(resultValue(), { now: NOW });
    expect(() => applyRealtimeVoiceSessionEvent(
      ready,
      event(1, "response_started"),
    )).toThrow(RealtimeVoiceTransitionError);
  });

  it("treats duplicate and out-of-order events as deterministic no-ops", () => {
    const ready = createRealtimeVoiceSessionState(resultValue(), { now: NOW });
    const active = applyRealtimeVoiceSessionEvent(ready, event(2, "session_started"));
    expect(applyRealtimeVoiceSessionEvent(active, event(2, "session_started"))).toBe(active);
    expect(applyRealtimeVoiceSessionEvent(active, event(1, "response_started"))).toBe(active);
    expect(applyRealtimeVoiceSessionEvent(active, event(3, "response_started", {
      event_id: "event-2",
    }))).toBe(active);
  });

  it("strictly rejects provider-native and content-bearing events", () => {
    const state = createRealtimeVoiceSessionState(resultValue(), { now: NOW });
    for (const extra of [
      { provider_event: { native: true } },
      { transcript: "private transcript" },
      { audio: "raw audio" },
      { tool_input: { sensitive: true } },
      { prompt: "private prompt" },
    ]) {
      expect(() => applyRealtimeVoiceSessionEvent(
        state,
        event(1, "session_started", extra),
      )).toThrow(RealtimeVoiceValidationError);
    }
  });
});

describe("realtime voice client lifecycle", () => {
  it("passes AbortSignal to start, interrupt, and local-media stop", async () => {
    const calls: string[] = [];
    let sequence = 0;
    const adapter: RealtimeVoiceClientAdapter = {
      async start(input) {
        expectTypeOf(input.signal).toEqualTypeOf<AbortSignal>();
        calls.push("start");
        return event(++sequence, "session_started") as RealtimeVoiceSessionEvent;
      },
      async interrupt(input) {
        expectTypeOf(input.signal).toEqualTypeOf<AbortSignal>();
        calls.push("interrupt");
        return event(++sequence, "response_interrupted") as RealtimeVoiceSessionEvent;
      },
      async stopLocalMedia(input) {
        expectTypeOf(input.signal).toEqualTypeOf<AbortSignal>();
        calls.push("local-stop");
        return event(++sequence, "local_media_stopped") as RealtimeVoiceSessionEvent;
      },
    };
    const session = createRealtimeVoiceClientSession(resultValue(), adapter, { now: NOW });
    const signal = new AbortController().signal;
    await expect(session.start({ signal })).resolves.toMatchObject({ status: "active" });
    session.applyEvent(event(++sequence, "response_started"));
    await expect(session.interrupt({ signal })).resolves.toMatchObject({
      response_active: false,
    });
    await expect(session.stopLocalMedia({ signal })).resolves.toMatchObject({
      local_media: "stopped",
      status: "active",
    });
    expect(calls).toEqual(["start", "interrupt", "local-stop"]);
  });

  it("cancels before invoking adapters and never leaks adapter failures", async () => {
    const adapter: RealtimeVoiceClientAdapter = {
      start: vi.fn(async () => event(1, "session_started") as RealtimeVoiceSessionEvent),
      interrupt: vi.fn(async () => event(2, "response_interrupted") as RealtimeVoiceSessionEvent),
      stopLocalMedia: vi.fn(async () => event(2, "local_media_stopped") as RealtimeVoiceSessionEvent),
    };
    const session = createRealtimeVoiceClientSession(resultValue(), adapter, { now: NOW });
    const controller = new AbortController();
    controller.abort("provider secret");
    await expect(session.start({ signal: controller.signal })).rejects.toMatchObject({
      code: "cancelled",
      message: "The realtime voice operation was cancelled.",
    });
    expect(adapter.start).not.toHaveBeenCalled();

    const failing = createRealtimeVoiceClientSession(resultValue(), {
      ...adapter,
      start: async () => { throw new Error("provider secret and private transcript"); },
    }, { now: NOW });
    await expect(failing.start({ signal: new AbortController().signal })).rejects.toEqual(
      new RealtimeVoiceOperationError("internal_failure"),
    );
  });
});

describe("trusted-server authoritative hangup and cleanup", () => {
  it("makes repeated and concurrent hangup/cleanup terminal and idempotent", async () => {
    const endSession = vi.fn(async () => undefined);
    const cleanupSession = vi.fn(async () => undefined);
    const authority = createIdempotentRealtimeVoiceSessionAuthority({
      adapter: { endSession, cleanupSession },
      now: () => NOW,
    });
    const signal = new AbortController().signal;
    const hangup = {
      version: REALTIME_VOICE_CONTRACT_VERSION,
      request_id: "hangup-1" as RealtimeVoiceRequestId,
      idempotency_key: "hangup:session-1" as RealtimeVoiceIdempotencyKey,
      session_id: "session-1" as RealtimeVoiceSessionId,
      reason: "client_request" as const,
      signal,
    };
    const [first, concurrent] = await Promise.all([
      authority.hangup(hangup),
      authority.hangup({
        ...hangup,
        request_id: "hangup-2" as RealtimeVoiceRequestId,
      }),
    ]);
    const repeated = await authority.hangup({
      ...hangup,
      request_id: "hangup-3" as RealtimeVoiceRequestId,
    });
    const cleaned = await authority.cleanup({
      session_id: "session-1" as RealtimeVoiceSessionId,
      signal,
    });

    expect(first).toEqual(concurrent);
    expect(repeated).toEqual(first);
    expect(cleaned.status).toBe("cleaned");
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(cleanupSession).toHaveBeenCalledTimes(1);
  });

  it("keeps local media stop distinct and honors authority cancellation", async () => {
    const endSession = vi.fn(async () => undefined);
    const cleanupSession = vi.fn(async () => undefined);
    const authority = createIdempotentRealtimeVoiceSessionAuthority({
      adapter: { endSession, cleanupSession },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(authority.hangup({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      request_id: "hangup-cancelled" as RealtimeVoiceRequestId,
      idempotency_key: "hangup:cancelled" as RealtimeVoiceIdempotencyKey,
      session_id: "session-cancelled" as RealtimeVoiceSessionId,
      reason: "client_request",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "cancelled" });
    expect(endSession).not.toHaveBeenCalled();
    expect(cleanupSession).not.toHaveBeenCalled();
  });

  it("does not repeat an authoritative end when retrying failed cleanup", async () => {
    const endSession = vi.fn(async () => undefined);
    const cleanupSession = vi.fn()
      .mockRejectedValueOnce(new Error("private provider cleanup failure"))
      .mockResolvedValueOnce(undefined);
    const authority = createIdempotentRealtimeVoiceSessionAuthority({
      adapter: { endSession, cleanupSession },
      now: () => NOW,
    });
    const signal = new AbortController().signal;
    const hangup = parseRealtimeVoiceHangupRequest({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      request_id: "hangup-cleanup-retry",
      idempotency_key: "hangup:cleanup-retry",
      session_id: "session-cleanup-retry",
      reason: "failure",
      signal,
    });

    await expect(authority.hangup(hangup)).rejects.toMatchObject({
      code: "internal_failure",
      message: "The realtime voice operation failed.",
    });
    await expect(authority.hangup(hangup)).resolves.toMatchObject({
      status: "ended",
    });
    expect(endSession).toHaveBeenCalledTimes(1);
    expect(cleanupSession).toHaveBeenCalledTimes(2);
  });

  it("strictly validates trusted-server hangup and cleanup inputs", () => {
    const signal = new AbortController().signal;
    expect(() => parseRealtimeVoiceHangupRequest({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      request_id: "hangup-strict",
      idempotency_key: "hangup:strict",
      session_id: "session-strict",
      reason: "client_request",
      signal,
      provider_request: { api_key: "secret" },
    })).toThrow(/provider_request/);
    expect(() => parseRealtimeVoiceCleanupRequest({
      session_id: "session-strict",
      signal,
      raw_response: { transcript: "private" },
    })).toThrow(/raw_response/);
  });
});

describe("realtime voice public errors", () => {
  it("uses deterministic fixed messages and sanitizes unknown failures", () => {
    const expected = realtimeVoiceSafeError("internal_failure");
    expect(normalizeRealtimeVoiceError(
      new Error("sk-secret provider response with private transcript"),
    )).toEqual(expected);
    expect(JSON.stringify(expected)).not.toMatch(/secret|transcript|provider response/);
    expect(expected.message.length).toBeLessThanOrEqual(
      REALTIME_VOICE_LIMITS.safeErrorMessageLength,
    );
    expect(() => parseRealtimeVoiceSafeError({
      ...expected,
      message: "provider said secret prompt",
    })).toThrow(/fixed safe message/);
  });
});
