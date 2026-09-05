import { describe, expect, it, vi } from "vitest";

import {
  createOpenAIRealtimeServer,
  type OpenAIRealtimeBootstrapRequestFunction,
  type OpenAIRealtimeCleanupFunction,
  type OpenAIRealtimeUsageObservation,
  type OpenAIRealtimeDeleteRequestFunction,
  type OpenAIRealtimeProviderEventChannel,
  type OpenAIRealtimeProviderBootstrapResponse,
} from "../src/providers/openai-realtime.js";
import {
  REALTIME_VOICE_CONTRACT_VERSION,
  REALTIME_VOICE_LIMITS,
  type RealtimeVoiceBootstrapRequest,
  type RealtimeVoiceErrorCode,
  type RealtimeVoiceIdempotencyKey,
  type RealtimeVoiceRequestId,
  type RealtimeVoiceSessionId,
} from "../src/realtime/types.js";
import type {
  RealtimeVoiceServerToolBridge,
  RealtimeVoiceServerToolOutcome,
} from "../src/realtime/tool-bridge.js";
import {
  RealtimeVoiceOperationError,
  parseRealtimeVoiceBootstrapRequest,
} from "../src/realtime/validation.js";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const timestamp = (offset: number) => new Date(NOW + offset).toISOString();

function requestValue(overrides: Record<string, unknown> = {}) {
  return {
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
      interruption: false,
      server_tool_execution: false,
    },
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}): RealtimeVoiceBootstrapRequest {
  return parseRealtimeVoiceBootstrapRequest(requestValue(overrides));
}

function providerResponse(
  overrides: Record<string, unknown> = {},
): OpenAIRealtimeProviderBootstrapResponse {
  return {
    session_id: "session-1",
    expires_at: timestamp(600_000),
    client_authorization: {
      value: "ephemeral_authorization_123",
      expires_at: timestamp(120_000),
    },
    connection_reference: "webrtc:sdp-reference-1",
    ...overrides,
  } as OpenAIRealtimeProviderBootstrapResponse;
}

function hangup(
  sessionId = "session-1",
  overrides: Record<string, unknown> = {},
) {
  return {
    version: REALTIME_VOICE_CONTRACT_VERSION,
    request_id: "hangup-1" as RealtimeVoiceRequestId,
    idempotency_key: `hangup:${sessionId}` as RealtimeVoiceIdempotencyKey,
    session_id: sessionId as RealtimeVoiceSessionId,
    reason: "client_request" as const,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function operation(
  overrides: Record<string, unknown> = {},
) {
  return {
    authentication: "Bearer host-owned-credential",
    resource: { id: "conversation-1", kind: "conversation" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function harness(options: {
  now?: () => number;
  authenticate?: (input: Parameters<Parameters<typeof createOpenAIRealtimeServer<string>>[0]["authenticate"]>[0]) => unknown;
  authorize?: (input: Parameters<Parameters<typeof createOpenAIRealtimeServer<string>>[0]["authorize"]>[0]) => unknown;
  requestBootstrap?: OpenAIRealtimeBootstrapRequestFunction;
  requestDelete?: OpenAIRealtimeDeleteRequestFunction;
  cleanupSession?: OpenAIRealtimeCleanupFunction;
  captureUsage?: (value: OpenAIRealtimeUsageObservation) => Promise<void>;
  toolBridge?: RealtimeVoiceServerToolBridge;
  maximumTrackedSessions?: number;
  maximumConcurrentToolCalls?: number;
  toolTimeoutMs?: number;
} = {}) {
  const authenticate = vi.fn(options.authenticate ?? (() => ({
    authenticated: true as const,
    principal: { id: "principal-1" },
  })));
  const authorize = vi.fn(options.authorize ?? (() => ({ allowed: true as const })));
  const requestBootstrap = vi.fn(options.requestBootstrap ?? (() => providerResponse()));
  const requestDelete = vi.fn(options.requestDelete ?? (() => undefined));
  const cleanupSession = vi.fn(options.cleanupSession ?? (() => undefined));
  const server = createOpenAIRealtimeServer<string>({
    authenticate: authenticate as Parameters<typeof createOpenAIRealtimeServer<string>>[0]["authenticate"],
    authorize: authorize as Parameters<typeof createOpenAIRealtimeServer<string>>[0]["authorize"],
    capabilities: {
      input_audio: true,
      output_audio: false,
      interruption: true,
      server_tool_execution: true,
    },
    request_bootstrap: requestBootstrap,
    request_delete: requestDelete,
    cleanup_session: cleanupSession,
    ...(options.captureUsage === undefined ? {} : { capture_usage: options.captureUsage }),
    ...(options.toolBridge === undefined ? {} : { tool_bridge: options.toolBridge }),
    now: options.now ?? (() => NOW),
    ...(options.maximumTrackedSessions === undefined
      ? {}
      : { maximum_tracked_sessions: options.maximumTrackedSessions }),
    ...(options.maximumConcurrentToolCalls === undefined
      ? {}
      : { maximum_concurrent_tool_calls: options.maximumConcurrentToolCalls }),
    ...(options.toolTimeoutMs === undefined
      ? {}
      : { tool_timeout_ms: options.toolTimeoutMs }),
  });
  return {
    authenticate,
    authorize,
    requestBootstrap,
    requestDelete,
    cleanupSession,
    server,
  };
}

async function publicFailure(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected operation to reject");
  } catch (error) {
    return error;
  }
}

function realtimeVoiceSafeError(code: RealtimeVoiceErrorCode) {
  return new RealtimeVoiceOperationError(code);
}

describe("OpenAI trusted-server realtime bootstrap", () => {
  it("authenticates, authorizes, projects only requested supported capabilities, and propagates identity", async () => {
    const test = harness();
    const controller = new AbortController();
    const bootstrapRequest = request();
    const result = await test.server.bootstrap(bootstrapRequest, operation({
      signal: controller.signal,
    }));

    expect(test.authenticate).toHaveBeenCalledWith({
      authentication: "Bearer host-owned-credential",
      resource: { id: "conversation-1", kind: "conversation" },
      request: bootstrapRequest,
      signal: controller.signal,
    });
    expect(test.authorize).toHaveBeenCalledWith({
      principal: { id: "principal-1" },
      resource: { id: "conversation-1", kind: "conversation" },
      request: bootstrapRequest,
      signal: controller.signal,
    });
    expect(test.requestBootstrap).toHaveBeenCalledWith({
      transport: "webrtc",
      configuration: bootstrapRequest.configuration,
      capabilities: {
        input_audio: { supported: true },
        output_audio: { supported: false, reason: "provider_not_supported" },
        interruption: { supported: false, reason: "not_requested" },
        server_tool_execution: { supported: false, reason: "not_requested" },
      },
    }, {
      signal: controller.signal,
      idempotency_key: expect.stringMatching(
        /^handrail-realtime-bootstrap-[a-f0-9]{64}$/u,
      ),
    });
    expect(result).toMatchObject({
      request_id: "request-1",
      session_id: "session-1",
      authorization: {
        kind: "opaque_ephemeral",
        value: "ephemeral_authorization_123",
      },
      connection: { transport: "webrtc", reference: "webrtc:sdp-reference-1" },
    });
  });

  it("denies unauthenticated and policy-rejected requests before provider access", async () => {
    const unauthenticated = harness({
      authenticate: () => ({ authenticated: false }),
    });
    await expect(unauthenticated.server.bootstrap(request(), operation())).rejects
      .toMatchObject(realtimeVoiceSafeError("invalid_state"));
    expect(unauthenticated.authorize).not.toHaveBeenCalled();
    expect(unauthenticated.requestBootstrap).not.toHaveBeenCalled();

    const denied = harness({ authorize: () => ({ allowed: false }) });
    await expect(denied.server.bootstrap(request(), operation())).rejects
      .toMatchObject(realtimeVoiceSafeError("invalid_state"));
    expect(denied.requestBootstrap).not.toHaveBeenCalled();
  });

  it("validates the complete request, resource, and hook decisions before provider access", async () => {
    const invalidRequest = harness();
    await expect(invalidRequest.server.bootstrap({
      ...requestValue(),
      prompt: "must not reach authentication",
    } as unknown as RealtimeVoiceBootstrapRequest, operation())).rejects.toMatchObject(
      realtimeVoiceSafeError("invalid_request"),
    );
    expect(invalidRequest.authenticate).not.toHaveBeenCalled();

    const invalidResource = harness();
    await expect(invalidResource.server.bootstrap(request(), operation({
      resource: {
        id: "conversation-1",
        kind: "conversation",
        credential: "must-not-be-retained",
      },
    }))).rejects.toMatchObject(realtimeVoiceSafeError("invalid_request"));
    expect(invalidResource.authenticate).not.toHaveBeenCalled();

    const invalidAuthentication = harness({
      authenticate: () => ({
        authenticated: true,
        principal: { id: "principal-1", role: "unbounded" },
      }),
    });
    await expect(invalidAuthentication.server.bootstrap(request(), operation()))
      .rejects.toMatchObject(realtimeVoiceSafeError("internal_failure"));
    expect(invalidAuthentication.authorize).not.toHaveBeenCalled();
    expect(invalidAuthentication.requestBootstrap).not.toHaveBeenCalled();

    const invalidPolicy = harness({ authorize: () => ({ allowed: true, detail: "private" }) });
    await expect(invalidPolicy.server.bootstrap(request(), operation())).rejects
      .toMatchObject(realtimeVoiceSafeError("internal_failure"));
    expect(invalidPolicy.requestBootstrap).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", { client_authorization: {
      value: "ephemeral_authorization_123",
      expires_at: timestamp(0),
    } }],
    ["too long lived", { client_authorization: {
      value: "ephemeral_authorization_123",
      expires_at: timestamp(REALTIME_VOICE_LIMITS.maximumAuthorizationTtlMs + 1),
    } }],
    ["beyond its session", {
      expires_at: timestamp(60_000),
      client_authorization: {
        value: "ephemeral_authorization_123",
        expires_at: timestamp(60_001),
      },
    }],
  ])("rejects %s client authorization", async (_label, responseOverrides) => {
    const test = harness({
      requestBootstrap: () => providerResponse(responseOverrides),
    });
    await expect(test.server.bootstrap(request(), operation())).rejects
      .toMatchObject(realtimeVoiceSafeError("internal_failure"));
    expect(test.server.trackedSessionCount).toBe(0);
  });

  it.each([
    null,
    {},
    { session_id: "session-1" },
    { ...providerResponse(), raw_provider_response: { secret: true } },
    { ...providerResponse(), session_id: "not valid whitespace" },
    { ...providerResponse(), connection_reference: "raw SDP\r\nsecret" },
    { ...providerResponse(), client_authorization: {
      value: "Bearer provider-secret-value",
      expires_at: timestamp(60_000),
    } },
  ])("maps malformed provider response to a fixed failure", async (response) => {
    const test = harness({ requestBootstrap: () => response });
    const error = await publicFailure(test.server.bootstrap(request(), operation()));
    expect(error).toMatchObject(realtimeVoiceSafeError("internal_failure"));
    expect(JSON.stringify(error)).not.toMatch(/provider-secret|raw_provider_response|SDP/iu);
  });

  it("reuses one deterministic provider identity and rejects key conflicts across request and ownership", async () => {
    const test = harness();
    await test.server.bootstrap(request(), operation());
    await test.server.bootstrap(request({ request_id: "request-retry" }), operation());

    expect(test.requestBootstrap).toHaveBeenCalledTimes(2);
    const firstOptions = test.requestBootstrap.mock.calls[0]![1];
    const retryOptions = test.requestBootstrap.mock.calls[1]![1];
    expect(retryOptions.idempotency_key).toBe(firstOptions.idempotency_key);

    await expect(test.server.bootstrap(request({
      request_id: "request-conflict",
      configuration: {
        ...requestValue().configuration as object,
        idle_timeout_ms: 30_000,
      },
    }), operation())).rejects.toMatchObject(
      realtimeVoiceSafeError("idempotency_conflict"),
    );
    await expect(test.server.bootstrap(request({ request_id: "request-owner-conflict" }), operation({
      resource: { id: "conversation-2", kind: "conversation" },
    }))).rejects.toMatchObject(realtimeVoiceSafeError("idempotency_conflict"));
    expect(test.requestBootstrap).toHaveBeenCalledTimes(2);
  });

  it("includes authenticated principal identity in the idempotency fingerprint", async () => {
    let principalId = "principal-1";
    const test = harness({
      authenticate: () => ({
        authenticated: true,
        principal: { id: principalId },
      }),
    });
    await test.server.bootstrap(request(), operation());
    principalId = "principal-2";
    await expect(test.server.bootstrap(request({ request_id: "request-new-principal" }), operation()))
      .rejects.toMatchObject(realtimeVoiceSafeError("idempotency_conflict"));
    expect(test.requestBootstrap).toHaveBeenCalledTimes(1);
  });

  it("propagates cancellation before and during bootstrap without tracking authorization", async () => {
    const before = harness();
    const beforeController = new AbortController();
    beforeController.abort("private credential");
    await expect(before.server.bootstrap(request(), operation({
      signal: beforeController.signal,
    }))).rejects.toMatchObject(realtimeVoiceSafeError("cancelled"));
    expect(before.authenticate).not.toHaveBeenCalled();

    const duringController = new AbortController();
    const during = harness({
      requestBootstrap: (_request, options) => {
        expect(options.signal).toBe(duringController.signal);
        duringController.abort("provider secret");
        return providerResponse();
      },
    });
    await expect(during.server.bootstrap(request(), operation({
      signal: duringController.signal,
    }))).rejects.toMatchObject(realtimeVoiceSafeError("cancelled"));
    expect(during.server.trackedSessionCount).toBe(0);
  });

  it("stops waiting when authentication is cancelled and never reaches policy or provider", async () => {
    const controller = new AbortController();
    const never = new Promise<never>(() => undefined);
    const test = harness({ authenticate: () => never });
    const pending = test.server.bootstrap(request(), operation({ signal: controller.signal }));
    await vi.waitFor(() => expect(test.authenticate).toHaveBeenCalledOnce());
    controller.abort("sensitive cancellation reason");

    await expect(pending).rejects.toMatchObject(realtimeVoiceSafeError("cancelled"));
    expect(test.authorize).not.toHaveBeenCalled();
    expect(test.requestBootstrap).not.toHaveBeenCalled();
  });
});

describe("OpenAI authoritative realtime hangup and retention", () => {
  it("deletes and cleans once across duplicate hangups and propagates bounded identities", async () => {
    const test = harness();
    await test.server.bootstrap(request(), operation());
    const first = await test.server.hangup(hangup());
    const duplicate = await test.server.hangup(hangup("session-1", {
      request_id: "hangup-2" as RealtimeVoiceRequestId,
    }));

    expect(duplicate).toEqual(first);
    expect(test.requestDelete).toHaveBeenCalledTimes(1);
    expect(test.requestDelete).toHaveBeenCalledWith({
      session_id: "session-1",
      reason: "client_request",
    }, {
      signal: expect.any(AbortSignal),
      idempotency_key: expect.stringMatching(/^handrail-realtime-hangup-[a-f0-9]{64}$/u),
    });
    expect(test.cleanupSession).toHaveBeenCalledTimes(1);
    expect(test.server.getTrackedSession("session-1" as RealtimeVoiceSessionId))
      .toMatchObject({ terminal_state: "ended", cleanup_state: "cleaned" });
  });

  it("treats an expired session as authoritatively ended without provider deletion", async () => {
    let now = NOW;
    const test = harness({
      now: () => now,
      requestBootstrap: () => providerResponse({
        expires_at: timestamp(20_000),
        client_authorization: {
          value: "ephemeral_authorization_123",
          expires_at: timestamp(10_000),
        },
      }),
    });
    await test.server.bootstrap(request(), operation());
    now = NOW + 20_000;
    await expect(test.server.hangup(hangup())).resolves.toMatchObject({ status: "ended" });
    expect(test.requestDelete).not.toHaveBeenCalled();
    expect(test.cleanupSession).toHaveBeenCalledTimes(1);
  });

  it("retries cleanup after partial failure without repeating successful provider deletion", async () => {
    const cleanup = vi.fn<OpenAIRealtimeCleanupFunction>()
      .mockRejectedValueOnce(new Error("private cleanup implementation detail"))
      .mockResolvedValueOnce(undefined);
    const test = harness({ cleanupSession: cleanup });
    await test.server.bootstrap(request(), operation());

    await expect(test.server.hangup(hangup())).rejects.toMatchObject(
      realtimeVoiceSafeError("internal_failure"),
    );
    expect(test.server.getTrackedSession("session-1" as RealtimeVoiceSessionId))
      .toMatchObject({ terminal_state: "provider_ended", cleanup_state: "pending" });
    await expect(test.server.hangup(hangup())).resolves.toMatchObject({ status: "ended" });
    expect(test.requestDelete).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("propagates hangup cancellation before provider deletion", async () => {
    const test = harness();
    await test.server.bootstrap(request(), operation());
    const controller = new AbortController();
    controller.abort("private reason");
    await expect(test.server.hangup(hangup("session-1", {
      signal: controller.signal,
    }))).rejects.toMatchObject(realtimeVoiceSafeError("cancelled"));
    expect(test.requestDelete).not.toHaveBeenCalled();
    expect(test.cleanupSession).not.toHaveBeenCalled();
  });

  it("retains only bounded host session metadata and evicts a completed session", async () => {
    let response = providerResponse();
    const test = harness({
      maximumTrackedSessions: 1,
      requestBootstrap: () => response,
    });
    const firstResult = await test.server.bootstrap(request(), operation());
    const retained = test.server.getTrackedSession(firstResult.session_id);
    expect(Object.keys(retained ?? {})).toEqual([
      "session_id",
      "expires_at",
      "request_fingerprint",
      "terminal_state",
      "cleanup_state",
    ]);
    expect(JSON.stringify(retained)).not.toMatch(
      /authorization|connection|credential|prompt|instruction|transcript|audio|tool/iu,
    );

    await expect(test.server.bootstrap(request({
      request_id: "request-2",
      idempotency_key: "bootstrap:conversation-2",
    }), operation({ resource: { id: "conversation-2", kind: "conversation" } })))
      .rejects.toMatchObject(realtimeVoiceSafeError("temporarily_unavailable"));
    await test.server.hangup(hangup());

    response = providerResponse({
      session_id: "session-2",
      connection_reference: "webrtc:sdp-reference-2",
    });
    await test.server.bootstrap(request({
      request_id: "request-2",
      idempotency_key: "bootstrap:conversation-2",
    }), operation({ resource: { id: "conversation-2", kind: "conversation" } }));
    expect(test.server.trackedSessionCount).toBe(1);
    expect(test.server.getTrackedSession("session-1" as RealtimeVoiceSessionId)).toBeNull();
  });

  it("redacts provider, authentication, policy, delete, and cleanup failures", async () => {
    const providerError = Object.assign(new Error("sk-provider-secret raw transcript"), {
      status: 503,
      response: { authorization: "Bearer hidden" },
    });
    const provider = harness({ requestBootstrap: () => { throw providerError; } });
    const providerFailure = await publicFailure(provider.server.bootstrap(request(), operation()));
    expect(providerFailure).toMatchObject(realtimeVoiceSafeError("temporarily_unavailable"));
    expect(JSON.stringify(providerFailure)).not.toMatch(/secret|transcript|authorization/iu);

    const auth = harness({ authenticate: () => { throw providerError; } });
    await expect(auth.server.bootstrap(request(), operation())).rejects.toMatchObject(
      realtimeVoiceSafeError("temporarily_unavailable"),
    );
    expect(auth.requestBootstrap).not.toHaveBeenCalled();

    const policy = harness({ authorize: () => { throw providerError; } });
    await expect(policy.server.bootstrap(request(), operation())).rejects.toMatchObject(
      realtimeVoiceSafeError("temporarily_unavailable"),
    );
    expect(policy.requestBootstrap).not.toHaveBeenCalled();

    const deletion = harness({ requestDelete: () => { throw providerError; } });
    await deletion.server.bootstrap(request(), operation());
    await expect(deletion.server.hangup(hangup())).rejects.toMatchObject(
      realtimeVoiceSafeError("temporarily_unavailable"),
    );
  });
});

function eventChannel() {
  const sent: Parameters<OpenAIRealtimeProviderEventChannel["send"]>[0][] = [];
  const send = vi.fn<OpenAIRealtimeProviderEventChannel["send"]>(async (event) => {
    sent.push(event);
  });
  return { channel: { send }, send, sent };
}

function toolBridge(execute: RealtimeVoiceServerToolBridge["execute"]) {
  const executeMock = vi.fn(execute);
  const terminateSession = vi.fn(async () => undefined);
  return {
    bridge: { execute: executeMock, terminateSession } satisfies RealtimeVoiceServerToolBridge,
    execute: executeMock,
    terminateSession,
  };
}

function completedToolOutcome(call: unknown): RealtimeVoiceServerToolOutcome {
  const source = call as { session_id: RealtimeVoiceSessionId; call_id: string };
  return {
    version: REALTIME_VOICE_CONTRACT_VERSION,
    session_id: source.session_id,
    call_id: source.call_id as never,
    status: "completed",
    result: {
      name: "read.echo" as never,
      is_error: false,
      content: [{ type: "json", value: { forecast: "sunny" } }],
    },
  };
}

const providerOperation = (signal = new AbortController().signal) => ({ signal });

function providerEventRequest(
  event: unknown,
  channel: OpenAIRealtimeProviderEventChannel,
) {
  return {
    session_id: "session-1" as RealtimeVoiceSessionId,
    event,
    channel,
  };
}

const sessionCreated = (eventId = "event-session") => ({
  type: "session.created",
  event_id: eventId,
  session: { id: "session-1", instructions: "ignored-provider-field" },
});

const responseCreated = (eventId: string, responseId = "response-1") => ({
  type: "response.created",
  event_id: eventId,
  response: { id: responseId, status: "in_progress", output: [] },
});

const functionCall = (
  eventId: string,
  callId: string,
  argumentsText = JSON.stringify({ value: "weather" }),
) => ({
  type: "response.function_call_arguments.done",
  event_id: eventId,
  response_id: "response-1",
  item_id: `item-${callId}`,
  output_index: 0,
  call_id: callId,
  name: "read.echo",
  arguments: argumentsText,
});

function toolRequest(): RealtimeVoiceBootstrapRequest {
  return request({
    requested_capabilities: {
      input_audio: true,
      output_audio: true,
      interruption: true,
      server_tool_execution: { capability_ref: "tools:voice-bounded" },
    },
  });
}

async function startProviderSession(
  server: ReturnType<typeof harness>["server"],
  channel: OpenAIRealtimeProviderEventChannel,
  bootstrapRequest: RealtimeVoiceBootstrapRequest = request(),
) {
  await server.bootstrap(bootstrapRequest, operation());
  await server.handleProviderEvent(
    providerEventRequest(sessionCreated(), channel),
    providerOperation(),
  );
}

describe("OpenAI trusted-server realtime event normalization", () => {
  it("projects ordered lifecycle, audio activity, barge-in, and channel termination", async () => {
    const bridge = toolBridge(async (call) => completedToolOutcome(call));
    const test = harness({ toolBridge: bridge.bridge });
    const output = eventChannel();
    await test.server.bootstrap(request(), operation());

    await expect(test.server.handleProviderEvent(providerEventRequest(
      responseCreated("event-stale"),
      output.channel,
    ), providerOperation())).resolves.toBeNull();
    await expect(test.server.handleProviderEvent(providerEventRequest({
      type: "conversation.item.input_audio_transcription.completed",
      event_id: "event-unknown",
      transcript: "must never be projected",
    }, output.channel), providerOperation())).resolves.toBeNull();

    const started = await test.server.handleProviderEvent(
      providerEventRequest(sessionCreated(), output.channel),
      providerOperation(),
    );
    expect(started).toMatchObject({ type: "session_started", sequence: 1 });
    await expect(test.server.handleProviderEvent(
      providerEventRequest(sessionCreated(), output.channel),
      providerOperation(),
    )).resolves.toBeNull();

    const response = await test.server.handleProviderEvent(
      providerEventRequest(responseCreated("event-response"), output.channel),
      providerOperation(),
    );
    expect(response).toMatchObject({ type: "response_started", sequence: 2 });
    await expect(test.server.handleProviderEvent(providerEventRequest({
      type: "response.output_audio.delta",
      event_id: "event-audio",
      response_id: "response-1",
      item_id: "item-audio",
      output_index: 0,
      content_index: 0,
      delta: "base64-audio-is-discarded",
    }, output.channel), providerOperation())).resolves.toBeNull();
    const interrupted = await test.server.handleProviderEvent(providerEventRequest({
      type: "input_audio_buffer.speech_started",
      event_id: "event-barge-in",
      audio_start_ms: 120,
      item_id: "item-user-2",
    }, output.channel), providerOperation());
    expect(interrupted).toMatchObject({ type: "response_interrupted", sequence: 3 });

    expect(await test.server.handleProviderEvent(
      providerEventRequest(responseCreated("event-response-2", "response-2"), output.channel),
      providerOperation(),
    )).toMatchObject({ type: "response_started", sequence: 4 });
    expect(await test.server.handleProviderEvent(providerEventRequest({
      type: "output_audio_buffer.cleared",
      event_id: "event-cleared",
      response_id: "response-2",
    }, output.channel), providerOperation())).toMatchObject({
      type: "response_interrupted",
      sequence: 5,
    });

    const ended = await test.server.providerTerminated({
      session_id: "session-1" as RealtimeVoiceSessionId,
      event_id: "event-closed" as never,
      reason: "closed",
    }, providerOperation());
    expect(ended).toMatchObject({ type: "session_ended", sequence: 6 });
    expect(await test.server.providerTerminated({
      session_id: "session-1" as RealtimeVoiceSessionId,
      event_id: "event-retry" as never,
      reason: "closed",
    }, providerOperation())).toEqual(ended);
    expect(bridge.terminateSession).toHaveBeenCalledTimes(1);
    expect(test.cleanupSession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([started, response, interrupted, ended, output.sent]))
      .not.toMatch(/transcript|base64-audio|instructions/iu);
  });

  it("routes one bounded function call with exact session capability and stable upstream output", async () => {
    const bridge = toolBridge(async (call) => completedToolOutcome(call));
    const test = harness({ toolBridge: bridge.bridge });
    const output = eventChannel();
    await startProviderSession(test.server, output.channel, toolRequest());
    await test.server.handleProviderEvent(
      providerEventRequest(responseCreated("event-response"), output.channel),
      providerOperation(),
    );
    await expect(test.server.handleProviderEvent(
      providerEventRequest(functionCall("event-tool", "call-1"), output.channel),
      providerOperation(),
    )).resolves.toBeNull();

    expect(bridge.execute).toHaveBeenCalledWith({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      session_id: "session-1",
      capability_ref: "tools:voice-bounded",
      call_id: "call-1",
      idempotency_key: expect.stringMatching(/^openai-tool:[a-f0-9]{64}$/u),
      name: "read.echo",
      arguments: { value: "weather" },
    }, { signal: expect.any(AbortSignal) });
    expect(output.sent).toHaveLength(1);
    expect(output.sent[0]).toMatchObject({
      event_id: expect.stringMatching(/^handrail-tool-output-[a-f0-9]{64}$/u),
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: "call-1" },
    });
    expect(JSON.parse(output.sent[0]!.item.output)).toEqual({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      status: "completed",
      is_error: false,
      content: [{ type: "json", value: { forecast: "sunny" } }],
    });

    await test.server.handleProviderEvent(
      providerEventRequest(functionCall("event-tool", "call-1"), output.channel),
      providerOperation(),
    );
    await test.server.handleProviderEvent(
      providerEventRequest(functionCall("event-tool-retry", "call-1"), output.channel),
      providerOperation(),
    );
    expect(bridge.execute).toHaveBeenCalledTimes(1);
    expect(output.send).toHaveBeenCalledTimes(1);
    await expect(test.server.handleProviderEvent(
      providerEventRequest(functionCall("event-tool-tamper", "call-1", "{\"value\":\"changed\"}"), output.channel),
      providerOperation(),
    )).rejects.toMatchObject(realtimeVoiceSafeError("idempotency_conflict"));
    expect(output.send).toHaveBeenCalledTimes(1);
  });

  it("sends approval-required and malformed-call outcomes without sensitive details", async () => {
    const approval = toolBridge(async (call) => {
      const value = call as { session_id: RealtimeVoiceSessionId; call_id: string };
      return {
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: value.session_id,
        call_id: value.call_id as never,
        status: "approval_required",
        name: "write.private" as never,
        proposal_id: "proposal-secret-reference" as never,
      };
    });
    const test = harness({ toolBridge: approval.bridge });
    const output = eventChannel();
    await startProviderSession(test.server, output.channel, toolRequest());
    await test.server.handleProviderEvent(
      providerEventRequest(responseCreated("event-response"), output.channel),
      providerOperation(),
    );
    await test.server.handleProviderEvent(
      providerEventRequest(functionCall("event-approval", "call-approval", "{\"secret\":\"argument\"}"), output.channel),
      providerOperation(),
    );
    expect(JSON.parse(output.sent[0]!.item.output)).toEqual({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      status: "approval_required",
    });
    expect(output.sent[0]!.item.output).not.toMatch(/proposal|secret|argument|write\.private/iu);

    await test.server.handleProviderEvent(
      providerEventRequest(functionCall("event-malformed", "call-malformed", "{private malformed"), output.channel),
      providerOperation(),
    );
    expect(JSON.parse(output.sent[1]!.item.output)).toMatchObject({
      status: "failed",
      error: { code: "invalid_request", message: "The realtime voice request is invalid." },
    });
    expect(approval.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched identities and oversized accepted payloads with fixed errors", async () => {
    const bridge = toolBridge(async (call) => completedToolOutcome(call));
    const test = harness({ toolBridge: bridge.bridge });
    const output = eventChannel();
    await test.server.bootstrap(toolRequest(), operation());
    await expect(test.server.handleProviderEvent(providerEventRequest({
      ...sessionCreated("event-wrong-session"),
      session: { id: "session-tampered" },
    }, output.channel), providerOperation())).rejects.toMatchObject(
      realtimeVoiceSafeError("invalid_request"),
    );
    await test.server.handleProviderEvent(
      providerEventRequest(sessionCreated(), output.channel),
      providerOperation(),
    );
    await test.server.handleProviderEvent(
      providerEventRequest(responseCreated("event-response"), output.channel),
      providerOperation(),
    );
    await expect(test.server.handleProviderEvent(providerEventRequest({
      type: "response.output_audio.delta",
      event_id: "event-oversized-audio",
      response_id: "response-1",
      item_id: "item-audio",
      output_index: 0,
      content_index: 0,
      delta: "x".repeat(64 * 1_024 + 1),
    }, output.channel), providerOperation())).rejects.toMatchObject(
      realtimeVoiceSafeError("invalid_request"),
    );
    const malformed = await publicFailure(test.server.handleProviderEvent(
      providerEventRequest({
        ...functionCall("event-missing-name", "call-missing-name"),
        name: "invalid tool name with spaces",
        arguments: "{\"credential\":\"sk-private-value\"}",
      }, output.channel),
      providerOperation(),
    ));
    expect(malformed).toMatchObject(realtimeVoiceSafeError("invalid_request"));
    expect(JSON.stringify(malformed)).not.toMatch(/credential|private-value|tool name/iu);
    expect(bridge.execute).not.toHaveBeenCalled();
    expect(output.sent).toHaveLength(0);
  });

  it("bounds concurrency and converts tool timeout and caller cancellation to safe behavior", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const concurrent = toolBridge(async (call) => {
      await held;
      return completedToolOutcome(call);
    });
    const test = harness({
      toolBridge: concurrent.bridge,
      maximumConcurrentToolCalls: 1,
    });
    const output = eventChannel();
    await startProviderSession(test.server, output.channel, toolRequest());
    await test.server.handleProviderEvent(
      providerEventRequest(responseCreated("event-response"), output.channel),
      providerOperation(),
    );
    const first = test.server.handleProviderEvent(
      providerEventRequest(functionCall("event-first", "call-first"), output.channel),
      providerOperation(),
    );
    await vi.waitFor(() => expect(concurrent.execute).toHaveBeenCalledOnce());
    await test.server.handleProviderEvent(
      providerEventRequest(functionCall("event-second", "call-second"), output.channel),
      providerOperation(),
    );
    expect(JSON.parse(output.sent[0]!.item.output)).toMatchObject({
      status: "failed",
      error: { code: "temporarily_unavailable" },
    });
    release();
    await first;
    expect(concurrent.execute).toHaveBeenCalledTimes(1);

    const timeoutBridge = toolBridge((_call, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private timeout")), { once: true });
    }));
    const timeout = harness({ toolBridge: timeoutBridge.bridge, toolTimeoutMs: 5 });
    const timeoutOutput = eventChannel();
    await startProviderSession(timeout.server, timeoutOutput.channel, toolRequest());
    await timeout.server.handleProviderEvent(
      providerEventRequest(responseCreated("event-response"), timeoutOutput.channel),
      providerOperation(),
    );
    await timeout.server.handleProviderEvent(
      providerEventRequest(functionCall("event-timeout", "call-timeout"), timeoutOutput.channel),
      providerOperation(),
    );
    expect(JSON.parse(timeoutOutput.sent[0]!.item.output)).toMatchObject({
      status: "failed",
      error: { code: "deadline_exceeded" },
    });

    const cancelledBridge = toolBridge((_call, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private cancellation")), { once: true });
    }));
    const cancelled = harness({ toolBridge: cancelledBridge.bridge });
    const cancelledOutput = eventChannel();
    await startProviderSession(cancelled.server, cancelledOutput.channel, toolRequest());
    await cancelled.server.handleProviderEvent(
      providerEventRequest(responseCreated("event-response"), cancelledOutput.channel),
      providerOperation(),
    );
    const controller = new AbortController();
    const pending = cancelled.server.handleProviderEvent(
      providerEventRequest(functionCall("event-cancel", "call-cancel"), cancelledOutput.channel),
      providerOperation(controller.signal),
    );
    await vi.waitFor(() => expect(cancelledBridge.execute).toHaveBeenCalledOnce());
    controller.abort("sensitive cancellation reason");
    await expect(pending).rejects.toMatchObject(realtimeVoiceSafeError("cancelled"));
    expect(cancelledOutput.sent).toHaveLength(0);
  });

  it("aborts pending tool work before authoritative hangup and redacts terminal failures", async () => {
    const pendingBridge = toolBridge((_call, { signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("raw arguments and result")), {
        once: true,
      });
    }));
    const test = harness({ toolBridge: pendingBridge.bridge });
    const output = eventChannel();
    await startProviderSession(test.server, output.channel, toolRequest());
    await test.server.handleProviderEvent(
      providerEventRequest(responseCreated("event-response"), output.channel),
      providerOperation(),
    );
    const pending = test.server.handleProviderEvent(
      providerEventRequest(functionCall("event-pending", "call-pending"), output.channel),
      providerOperation(),
    );
    await vi.waitFor(() => expect(pendingBridge.execute).toHaveBeenCalledOnce());
    await test.server.hangup(hangup());
    await expect(pending).resolves.toBeNull();
    expect(pendingBridge.terminateSession).toHaveBeenCalledWith("session-1");
    expect(output.sent).toHaveLength(0);

    const failedBridge = toolBridge(async (call) => completedToolOutcome(call));
    const failed = harness({ toolBridge: failedBridge.bridge });
    const failedOutput = eventChannel();
    await startProviderSession(failed.server, failedOutput.channel);
    const terminal = await failed.server.handleProviderEvent(providerEventRequest({
      type: "error",
      event_id: "event-provider-failure",
      error: {
        type: "server_error",
        message: "raw transcript sk-provider-secret tool arguments",
      },
    }, failedOutput.channel), providerOperation());
    expect(terminal).toMatchObject({
      type: "session_failed",
      error: {
        code: "internal_failure",
        message: "The realtime voice operation failed.",
      },
    });
    expect(JSON.stringify(terminal)).not.toMatch(/transcript|provider-secret|arguments/iu);
    expect(failedBridge.terminateSession).toHaveBeenCalledWith("session-1");
  });
});


describe("OpenAI realtime usage capture", () => {
  const done = (status = "completed", eventId = "done-1") => ({ type: "response.done", event_id: eventId,
    response: { id: "response-1", status, output: [{ transcript: "private" }],
      usage: { input_tokens: 132, output_tokens: 121, total_tokens: 253,
        input_token_details: { audio_tokens: 13, text_tokens: 119 },
        output_token_details: { audio_tokens: 91, text_tokens: 30 } } } });

  it("coalesces concurrent completion capture by operation identity and rejects changed usage", async () => {
    let release!: () => void;
    const write = new Promise<void>((resolve) => { release = resolve; });
    const capture = vi.fn(() => write);
    const { server } = harness({ captureUsage: capture });
    const { channel } = eventChannel();
    await startProviderSession(server, channel);
    await server.handleProviderEvent(providerEventRequest(responseCreated("start"), channel), providerOperation());
    const first = server.handleProviderEvent(providerEventRequest(done(), channel), providerOperation());
    const duplicate = server.handleProviderEvent(providerEventRequest(done("completed", "done-2"), channel), providerOperation());
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    expect(capture.mock.calls[0]).toEqual([{ session_id: "session-1", operation: "response",
      operation_id: "response-1", content_index: null, terminal_status: "completed",
      usage: expect.objectContaining({ total_tokens: 253 }) }]);
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private");
    release();
    await Promise.all([first, duplicate]);
    const changed = done("completed", "done-3");
    changed.response.usage.total_tokens = 254;
    await expect(server.handleProviderEvent(providerEventRequest(changed, channel), providerOperation()))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(capture).toHaveBeenCalledOnce();
  });

  it.each(["completed", "cancelled", "failed", "incomplete"])("captures %s usage after hangup without restarting the session", async (status) => {
    const capture = vi.fn(async () => undefined);
    const { server } = harness({ captureUsage: capture });
    const { channel } = eventChannel();
    await startProviderSession(server, channel);
    await server.hangup(hangup());
    await expect(server.handleProviderEvent(providerEventRequest(done(status), channel), providerOperation())).resolves.toBeNull();
    expect(capture.mock.calls[0]).toMatchObject([{ terminal_status: status, usage: { total_tokens: 253 } }]);
    expect(server.getTrackedSession("session-1" as RealtimeVoiceSessionId)?.terminal_state).toBe("ended");
  });

  it("cancels the caller immediately while retaining incurred usage and refuses unknown sessions", async () => {
    let release!: () => void;
    const capture = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { server } = harness({ captureUsage: capture });
    const { channel } = eventChannel();
    await expect(server.handleProviderEvent(providerEventRequest(done(), channel), providerOperation()))
      .rejects.toMatchObject({ code: "invalid_state" });
    expect(capture).not.toHaveBeenCalled();
    await startProviderSession(server, channel);
    const controller = new AbortController();
    controller.abort();
    await expect(server.handleProviderEvent(providerEventRequest(done(), channel), providerOperation(controller.signal)))
      .rejects.toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    release();
    await server.handleProviderEvent(providerEventRequest(done(), channel), providerOperation());
    expect(capture).toHaveBeenCalledOnce();
  });

  it("retries a failed capture with the same identity and captures input transcription separately", async () => {
    const capture = vi.fn<(value: OpenAIRealtimeUsageObservation) => Promise<void>>()
      .mockRejectedValueOnce(new Error("private storage error")).mockResolvedValue(undefined);
    const { server } = harness({ captureUsage: capture });
    const { channel } = eventChannel();
    await startProviderSession(server, channel);
    await expect(server.handleProviderEvent(providerEventRequest(done(), channel), providerOperation()))
      .rejects.toMatchObject({ code: "temporarily_unavailable" });
    await server.handleProviderEvent(providerEventRequest(done(), channel), providerOperation());
    expect(capture.mock.calls[0]).toEqual(capture.mock.calls[1]);
    const transcription = { type: "conversation.item.input_audio_transcription.completed", event_id: "input-1",
      item_id: "response-1", content_index: 0, transcript: "private", usage: { type: "duration", seconds: 2.25 } };
    await server.handleProviderEvent(providerEventRequest(transcription, channel), providerOperation());
    await server.handleProviderEvent(providerEventRequest(transcription, channel), providerOperation());
    expect(capture).toHaveBeenCalledTimes(3);
    expect(capture.mock.calls[2]).toEqual([{ session_id: "session-1", operation: "input_transcription",
      operation_id: "response-1", content_index: 0, terminal_status: "completed", usage: { type: "duration", seconds: 2.25 } }]);
  });
});
