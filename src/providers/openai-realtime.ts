import { parseOpenAIReportedAudioUsage, type OpenAIReportedAudioUsage } from "./openai-audio-usage.js";
export { parseOpenAIReportedAudioUsage, type OpenAIReportedAudioUsage } from "./openai-audio-usage.js";
import {
  REALTIME_VOICE_CONTRACT_VERSION,
  REALTIME_VOICE_LIMITS,
  type RealtimeVoiceBootstrapRequest,
  type RealtimeVoiceBootstrapResult,
  type RealtimeVoiceCapabilities,
  type RealtimeVoiceCleanupRequest,
  type RealtimeVoiceCleanupResult,
  type RealtimeVoiceEventId,
  type RealtimeVoiceHangupReason,
  type RealtimeVoiceHangupRequest,
  type RealtimeVoiceOperationInput,
  type RealtimeVoiceSessionConfiguration,
  type RealtimeVoiceSessionEvent,
  type RealtimeVoiceSessionId,
  type RealtimeVoiceTerminalResult,
  type RealtimeVoiceTimestamp,
} from "../realtime/types.js";
import {
  RealtimeVoiceOperationError,
  assertRealtimeVoiceAbortSignal,
  narrowRealtimeVoiceCapabilities,
  realtimeVoiceSafeError,
  parseRealtimeVoiceBootstrapRequest,
  parseRealtimeVoiceBootstrapResult,
  throwIfRealtimeVoiceAborted,
} from "../realtime/validation.js";
import {
  createIdempotentRealtimeVoiceSessionAuthority,
  parseRealtimeVoiceHangupRequest,
} from "../realtime/session.js";
import type {
  RealtimeVoiceServerToolBridge,
  RealtimeVoiceServerToolOutcome,
} from "../realtime/tool-bridge.js";

export const OPENAI_REALTIME_LIMITS = Object.freeze({
  maximumTrackedSessions: REALTIME_VOICE_LIMITS.trackedTerminalSessions,
  maximumTrackedProviderEvents: 256,
  maximumTrackedToolCalls: 256,
  maximumConcurrentToolCalls: 4,
  providerAudioDeltaLength: 64 * 1_024,
  providerArgumentsBytes: 32 * 1_024,
  providerToolOutputBytes: 64 * 1_024,
  toolTimeoutMs: 15_000,
} as const);

export interface OpenAIRealtimePublicPrincipal {
  readonly id: string;
}

export interface OpenAIRealtimePublicResource {
  readonly id: string;
  readonly kind: string;
}

export type OpenAIRealtimeAuthenticationDecision =
  | { readonly authenticated: true; readonly principal: OpenAIRealtimePublicPrincipal }
  | { readonly authenticated: false };

export type OpenAIRealtimePolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false };

export interface OpenAIRealtimeBootstrapOperation<TAuthentication = unknown>
  extends RealtimeVoiceOperationInput {
  /** Host-owned credential/context. It is passed to `authenticate` and never retained. */
  readonly authentication: TAuthentication;
  readonly resource: OpenAIRealtimePublicResource;
}

export interface OpenAIRealtimeAuthenticationInput<TAuthentication = unknown> {
  readonly authentication: TAuthentication;
  readonly resource: OpenAIRealtimePublicResource;
  readonly request: RealtimeVoiceBootstrapRequest;
  readonly signal: AbortSignal;
}

export interface OpenAIRealtimePolicyInput {
  readonly principal: OpenAIRealtimePublicPrincipal;
  readonly resource: OpenAIRealtimePublicResource;
  readonly request: RealtimeVoiceBootstrapRequest;
  readonly signal: AbortSignal;
}

export interface OpenAIRealtimeSupportedCapabilities {
  readonly input_audio: boolean;
  readonly output_audio: boolean;
  readonly interruption: boolean;
  readonly server_tool_execution: boolean;
}

/** SDK-independent, already-authorized request sent to the injected OpenAI boundary. */
export interface OpenAIRealtimeProviderBootstrapRequest {
  readonly transport: "webrtc";
  readonly configuration: RealtimeVoiceSessionConfiguration;
  readonly capabilities: RealtimeVoiceCapabilities;
}

export interface OpenAIRealtimeProviderRequestOptions {
  readonly signal: AbortSignal;
  /** Deterministic bounded identity; it contains no request, principal, or resource text. */
  readonly idempotency_key: string;
}

/**
 * Minimal normalized response expected from the injected OpenAI request function.
 * The connection reference may be an opaque call reference or encoded public SDP.
 */
export interface OpenAIRealtimeProviderBootstrapResponse {
  readonly session_id: string;
  readonly expires_at: string;
  readonly client_authorization: {
    readonly value: string;
    readonly expires_at: string;
  };
  readonly connection_reference: string;
}

export type OpenAIRealtimeBootstrapRequestFunction = (
  request: OpenAIRealtimeProviderBootstrapRequest,
  options: OpenAIRealtimeProviderRequestOptions,
) => unknown | Promise<unknown>;

export interface OpenAIRealtimeProviderDeleteRequest {
  readonly session_id: RealtimeVoiceSessionId;
  readonly reason: RealtimeVoiceHangupReason;
}

export type OpenAIRealtimeDeleteRequestFunction = (
  request: OpenAIRealtimeProviderDeleteRequest,
  options: OpenAIRealtimeProviderRequestOptions,
) => void | Promise<void>;

export type OpenAIRealtimeCleanupFunction = (
  request: RealtimeVoiceCleanupRequest,
) => void | Promise<void>;

/** Minimal server-to-provider channel. The host owns its transport and lifecycle. */
export interface OpenAIRealtimeProviderEventChannel {
  send(
    event: OpenAIRealtimeProviderClientEvent,
    options: { readonly signal: AbortSignal },
  ): void | Promise<void>;
}

/** The only provider-native client event emitted by this normalizer. */
export interface OpenAIRealtimeProviderClientEvent {
  readonly event_id: string;
  readonly type: "conversation.item.create";
  readonly item: {
    readonly type: "function_call_output";
    readonly call_id: string;
    /** Bounded JSON containing only the normalized bridge outcome. */
    readonly output: string;
  };
}

export interface OpenAIRealtimeProviderEventRequest {
  readonly session_id: RealtimeVoiceSessionId;
  readonly event: unknown;
  readonly channel: OpenAIRealtimeProviderEventChannel;
}

export interface OpenAIRealtimeProviderTerminalRequest {
  readonly session_id: RealtimeVoiceSessionId;
  readonly event_id: RealtimeVoiceEventId;
  readonly reason: "closed" | "failure";
}

export interface OpenAIRealtimeUsageObservation {
  readonly session_id: RealtimeVoiceSessionId;
  readonly operation: "response" | "input_transcription";
  /** Provider response ID or input item ID. Deduplicate with session/operation/content_index. */
  readonly operation_id: string;
  readonly content_index: number | null;
  readonly terminal_status: "completed" | "cancelled" | "failed" | "incomplete";
  readonly usage: OpenAIReportedAudioUsage;
}

export interface OpenAIRealtimeServerOptions<TAuthentication = unknown> {
  readonly authenticate: (
    input: OpenAIRealtimeAuthenticationInput<TAuthentication>,
  ) => OpenAIRealtimeAuthenticationDecision | Promise<OpenAIRealtimeAuthenticationDecision>;
  readonly authorize: (
    input: OpenAIRealtimePolicyInput,
  ) => OpenAIRealtimePolicyDecision | Promise<OpenAIRealtimePolicyDecision>;
  readonly capabilities: OpenAIRealtimeSupportedCapabilities;
  readonly request_bootstrap: OpenAIRealtimeBootstrapRequestFunction;
  readonly request_delete: OpenAIRealtimeDeleteRequestFunction;
  /** Host cleanup for session-scoped resources. Defaults to a no-op. */
  readonly cleanup_session?: OpenAIRealtimeCleanupFunction;
  /** Trusted-server durable usage capture, including late final events after hangup.
   * Hosts derive model/attribution from the session and deduplicate in storage;
   * response and input transcription may use different models. No prices inferred.
   */
  readonly capture_usage?: (observation: OpenAIRealtimeUsageObservation) => Promise<void>;
  /** Existing trusted-server bridge. Sessions must be registered with the exact offered capability. */
  readonly tool_bridge?: RealtimeVoiceServerToolBridge;
  readonly now?: () => number;
  readonly maximum_tracked_sessions?: number;
  readonly maximum_concurrent_tool_calls?: number;
  readonly tool_timeout_ms?: number;
}

export interface OpenAIRealtimeTrackedSession {
  readonly session_id: RealtimeVoiceSessionId;
  readonly expires_at: RealtimeVoiceTimestamp;
  readonly request_fingerprint: string;
  readonly terminal_state: "open" | "provider_ended" | "ended";
  readonly cleanup_state: "pending" | "cleaned";
}

export interface OpenAIRealtimeServer<TAuthentication = unknown> {
  bootstrap(
    request: RealtimeVoiceBootstrapRequest,
    operation: OpenAIRealtimeBootstrapOperation<TAuthentication>,
  ): Promise<RealtimeVoiceBootstrapResult>;
  hangup(request: RealtimeVoiceHangupRequest): Promise<RealtimeVoiceTerminalResult>;
  cleanup(request: RealtimeVoiceCleanupRequest): Promise<RealtimeVoiceCleanupResult>;
  /**
   * Normalizes one ordered OpenAI server event. Unknown, duplicate, and
   * lifecycle-stale events are deterministic `null` results.
   */
  handleProviderEvent(
    request: OpenAIRealtimeProviderEventRequest,
    operation: RealtimeVoiceOperationInput,
  ): Promise<RealtimeVoiceSessionEvent | null>;
  /** Normalizes transport closure, which is not an OpenAI server event. */
  providerTerminated(
    request: OpenAIRealtimeProviderTerminalRequest,
    operation: RealtimeVoiceOperationInput,
  ): Promise<RealtimeVoiceSessionEvent>;
  /** Bounded, authorization-free diagnostics suitable for host retention. */
  getTrackedSession(sessionId: RealtimeVoiceSessionId): OpenAIRealtimeTrackedSession | null;
  readonly trackedSessionCount: number;
}

type UnknownRecord = Record<string, unknown>;

interface MutableTrackedSession {
  readonly session_id: RealtimeVoiceSessionId;
  readonly expires_at: RealtimeVoiceTimestamp;
  readonly expiresAtMs: number;
  readonly request_fingerprint: string;
  readonly idempotency_key: string;
  readonly capabilities: RealtimeVoiceCapabilities;
  readonly eventController: AbortController;
  readonly providerEvents: Map<string, string>;
  readonly usageCaptures: Map<string, { fingerprint: string; promise: Promise<void>; pending: boolean }>;
  readonly toolCalls: Map<string, string>;
  readonly toolOperations: Map<string, Promise<null>>;
  readonly toolOutputsSent: Set<string>;
  provider_termination: Promise<void> | null;
  event_sequence: number;
  provider_started: boolean;
  response_id: string | null;
  terminal_event: RealtimeVoiceSessionEvent | null;
  terminal_state: OpenAIRealtimeTrackedSession["terminal_state"];
  cleanup_state: OpenAIRealtimeTrackedSession["cleanup_state"];
}

interface IdempotencyEntry {
  readonly fingerprint: string;
  session_id?: RealtimeVoiceSessionId;
  status: "pending" | "tracked" | "failed";
}

type ParsedProviderEvent =
  | { readonly kind: "unknown" }
  | {
      readonly kind: "session_started";
      readonly eventId: RealtimeVoiceEventId;
      readonly sessionId: RealtimeVoiceSessionId;
      readonly fingerprintInput: string;
    }
  | {
      readonly kind: "response_started" | "response_stopped" | "response_interrupted";
      readonly eventId: RealtimeVoiceEventId;
      readonly responseId: string;
      readonly fingerprintInput: string;
    }
  | {
      readonly kind: "failure";
      readonly eventId: RealtimeVoiceEventId;
      readonly fingerprintInput: string;
    }
  | {
      readonly kind: "tool_call";
      readonly eventId: RealtimeVoiceEventId;
      readonly responseId: string;
      readonly itemId: string;
      readonly outputIndex: number;
      readonly callId: string;
      readonly name: string;
      readonly argumentsText: string;
      readonly fingerprintInput: string;
    };

const OPENAI_ACCEPTED_EVENT_TYPES = new Set([
  "session.created",
  "response.created",
  "response.done",
  "output_audio_buffer.started",
  "output_audio_buffer.stopped",
  "output_audio_buffer.cleared",
  "response.output_audio.delta",
  "input_audio_buffer.speech_started",
  "response.function_call_arguments.done",
  "error",
]);

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/u;
const UTF8_ENCODER = new TextEncoder();

function plainRecord(value: unknown): UnknownRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) return null;
    const snapshot: UnknownRecord = Object.create(null) as UnknownRecord;
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if (!descriptor.enumerable || !("value" in descriptor)) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function hasExactFields(value: UnknownRecord, fields: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function boundedIdentifier(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= REALTIME_VOICE_LIMITS.identifierLength &&
    IDENTIFIER.test(value)
    ? value
    : null;
}

function requiredIdentifier(value: unknown): string {
  const parsed = boundedIdentifier(value);
  if (parsed === null) throw new RealtimeVoiceOperationError("invalid_request");
  return parsed;
}

function requiredRecord(value: unknown): UnknownRecord {
  const parsed = plainRecord(value);
  if (parsed === null) throw new RealtimeVoiceOperationError("invalid_request");
  return parsed;
}

function requiredIndex(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 4_096) {
    throw new RealtimeVoiceOperationError("invalid_request");
  }
  return value as number;
}

/** Parses numerical evidence from trusted provider events; never authorizes a session. */
export function parseOpenAIRealtimeUsageObservation(
  sessionId: RealtimeVoiceSessionId,
  value: unknown,
): OpenAIRealtimeUsageObservation | null {
  const source = requiredRecord(value);
  if (source.type !== "response.done" && source.type !== "conversation.item.input_audio_transcription.completed") return null;
  requiredIdentifier(sessionId);
  const response = source.type === "response.done" ? requiredRecord(source.response) : null;
  const status = response === null ? "completed" : response.status;
  if (!["completed", "cancelled", "failed", "incomplete"].includes(status as string)) {
    throw new RealtimeVoiceOperationError("invalid_request");
  }
  try {
    return Object.freeze({ session_id: sessionId,
      operation: response === null ? "input_transcription" : "response",
      operation_id: requiredIdentifier(response === null ? source.item_id : response.id),
      content_index: response === null ? requiredIndex(source.content_index) : null,
      terminal_status: status as OpenAIRealtimeUsageObservation["terminal_status"],
      usage: parseOpenAIReportedAudioUsage(response === null ? source.usage : response.usage),
    });
  } catch { throw new RealtimeVoiceOperationError("invalid_request"); }
}

function parseProviderEvent(value: unknown): ParsedProviderEvent {
  const source = plainRecord(value);
  if (source === null || typeof source.type !== "string") {
    throw new RealtimeVoiceOperationError("invalid_request");
  }
  if (
    source.type.length === 0 ||
    source.type.length > REALTIME_VOICE_LIMITS.identifierLength ||
    !OPENAI_ACCEPTED_EVENT_TYPES.has(source.type)
  ) return Object.freeze({ kind: "unknown" });

  const eventId = requiredIdentifier(source.event_id) as RealtimeVoiceEventId;
  switch (source.type) {
    case "session.created": {
      const session = requiredRecord(source.session);
      const sessionId = requiredIdentifier(session.id) as RealtimeVoiceSessionId;
      return Object.freeze({
        kind: "session_started",
        eventId,
        sessionId,
        fingerprintInput: `${source.type}\u001f${sessionId}`,
      });
    }
    case "response.created": {
      const response = requiredRecord(source.response);
      const responseId = requiredIdentifier(response.id);
      if (response.status !== "in_progress") {
        throw new RealtimeVoiceOperationError("invalid_request");
      }
      return Object.freeze({
        kind: "response_started",
        eventId,
        responseId,
        fingerprintInput: `${source.type}\u001f${responseId}`,
      });
    }
    case "response.done": {
      const response = requiredRecord(source.response);
      const responseId = requiredIdentifier(response.id);
      if (!["completed", "cancelled", "failed", "incomplete"].includes(response.status as string)) {
        throw new RealtimeVoiceOperationError("invalid_request");
      }
      const kind = response.status === "failed" ? "failure" : "response_stopped";
      return Object.freeze({
        kind,
        eventId,
        ...(kind === "failure" ? {} : { responseId }),
        fingerprintInput: `${source.type}\u001f${responseId}\u001f${String(response.status)}`,
      }) as ParsedProviderEvent;
    }
    case "output_audio_buffer.started":
    case "output_audio_buffer.stopped":
    case "output_audio_buffer.cleared": {
      const responseId = requiredIdentifier(source.response_id);
      return Object.freeze({
        kind: source.type === "output_audio_buffer.started"
          ? "response_started"
          : source.type === "output_audio_buffer.cleared"
          ? "response_interrupted"
          : "response_stopped",
        eventId,
        responseId,
        fingerprintInput: `${source.type}\u001f${responseId}`,
      });
    }
    case "response.output_audio.delta": {
      const responseId = requiredIdentifier(source.response_id);
      const itemId = requiredIdentifier(source.item_id);
      const outputIndex = requiredIndex(source.output_index);
      const contentIndex = requiredIndex(source.content_index);
      if (
        typeof source.delta !== "string" ||
        source.delta.length === 0 ||
        source.delta.length > OPENAI_REALTIME_LIMITS.providerAudioDeltaLength
      ) throw new RealtimeVoiceOperationError("invalid_request");
      return Object.freeze({
        kind: "response_started",
        eventId,
        responseId,
        fingerprintInput: [
          source.type,
          responseId,
          itemId,
          String(outputIndex),
          String(contentIndex),
          source.delta,
        ].join("\u001f"),
      });
    }
    case "input_audio_buffer.speech_started": {
      const itemId = requiredIdentifier(source.item_id);
      if (!Number.isSafeInteger(source.audio_start_ms) || (source.audio_start_ms as number) < 0) {
        throw new RealtimeVoiceOperationError("invalid_request");
      }
      return Object.freeze({
        kind: "response_interrupted",
        eventId,
        responseId: "barge-in",
        fingerprintInput: `${source.type}\u001f${itemId}\u001f${String(source.audio_start_ms)}`,
      });
    }
    case "response.function_call_arguments.done": {
      const responseId = requiredIdentifier(source.response_id);
      const itemId = requiredIdentifier(source.item_id);
      const callId = requiredIdentifier(source.call_id);
      const name = requiredIdentifier(source.name);
      const outputIndex = requiredIndex(source.output_index);
      if (
        typeof source.arguments !== "string" ||
        source.arguments.length === 0 ||
        UTF8_ENCODER.encode(source.arguments).byteLength >
          OPENAI_REALTIME_LIMITS.providerArgumentsBytes
      ) throw new RealtimeVoiceOperationError("invalid_request");
      return Object.freeze({
        kind: "tool_call",
        eventId,
        responseId,
        itemId,
        outputIndex,
        callId,
        name,
        argumentsText: source.arguments,
        fingerprintInput: [
          source.type,
          responseId,
          itemId,
          String(outputIndex),
          callId,
          name,
          source.arguments,
        ].join("\u001f"),
      });
    }
    case "error":
      requiredRecord(source.error);
      return Object.freeze({
        kind: "failure",
        eventId,
        fingerprintInput: source.type,
      });
  }
  return Object.freeze({ kind: "unknown" });
}

function parseResource(value: unknown): OpenAIRealtimePublicResource {
  const source = plainRecord(value);
  const id = source === null ? null : boundedIdentifier(source.id);
  const kind = source === null ? null : boundedIdentifier(source.kind);
  if (source === null || !hasExactFields(source, ["id", "kind"]) || id === null || kind === null) {
    throw new RealtimeVoiceOperationError("invalid_request");
  }
  return Object.freeze({ id, kind });
}

function parseAuthenticationDecision(value: unknown): OpenAIRealtimeAuthenticationDecision {
  const source = plainRecord(value);
  if (source === null) throw new RealtimeVoiceOperationError("internal_failure");
  if (source.authenticated === false && hasExactFields(source, ["authenticated"])) {
    return Object.freeze({ authenticated: false });
  }
  if (source.authenticated !== true || !hasExactFields(source, ["authenticated", "principal"])) {
    throw new RealtimeVoiceOperationError("internal_failure");
  }
  const principal = plainRecord(source.principal);
  const id = principal === null ? null : boundedIdentifier(principal.id);
  if (principal === null || !hasExactFields(principal, ["id"]) || id === null) {
    throw new RealtimeVoiceOperationError("internal_failure");
  }
  return Object.freeze({ authenticated: true, principal: Object.freeze({ id }) });
}

function parsePolicyDecision(value: unknown): OpenAIRealtimePolicyDecision {
  const source = plainRecord(value);
  if (
    source === null ||
    !hasExactFields(source, ["allowed"]) ||
    typeof source.allowed !== "boolean"
  ) throw new RealtimeVoiceOperationError("internal_failure");
  return Object.freeze({ allowed: source.allowed });
}

function parseSupportedCapabilities(value: unknown): OpenAIRealtimeSupportedCapabilities {
  const source = plainRecord(value);
  const fields = [
    "input_audio",
    "output_audio",
    "interruption",
    "server_tool_execution",
  ] as const;
  if (
    source === null ||
    !hasExactFields(source, fields) ||
    fields.some((field) => typeof source[field] !== "boolean")
  ) throw new TypeError("OpenAI realtime capabilities must contain four boolean fields");
  return Object.freeze({
    input_audio: source.input_audio as boolean,
    output_audio: source.output_audio as boolean,
    interruption: source.interruption as boolean,
    server_tool_execution: source.server_tool_execution as boolean,
  });
}

function offeredCapabilities(
  request: RealtimeVoiceBootstrapRequest,
  supported: OpenAIRealtimeSupportedCapabilities,
): RealtimeVoiceCapabilities {
  const requested = request.requested_capabilities;
  return narrowRealtimeVoiceCapabilities(requested, {
    input_audio: supported.input_audio
      ? { supported: true }
      : { supported: false, reason: "provider_not_supported" },
    output_audio: supported.output_audio
      ? { supported: true }
      : { supported: false, reason: "provider_not_supported" },
    interruption: supported.interruption
      ? { supported: true }
      : { supported: false, reason: "provider_not_supported" },
    server_tool_execution: supported.server_tool_execution &&
      requested.server_tool_execution !== false
      ? {
          supported: true,
          capability_ref: requested.server_tool_execution.capability_ref,
        }
      : {
          supported: false,
          reason: supported.server_tool_execution
            ? "not_requested"
            : "server_tools_not_configured",
        },
  });
}

function stableFingerprintInput(
  request: RealtimeVoiceBootstrapRequest,
  principal: OpenAIRealtimePublicPrincipal,
  resource: OpenAIRealtimePublicResource,
): string {
  return JSON.stringify({
    configuration: request.configuration,
    requested_capabilities: request.requested_capabilities,
    principal_id: principal.id,
    resource_id: resource.id,
    resource_kind: resource.kind,
  });
}

async function digest(value: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) throw new Error();
    const output = await subtle.digest("SHA-256", UTF8_ENCODER.encode(value));
    return [...new Uint8Array(output)]
      .map((part) => part.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    throw new RealtimeVoiceOperationError("internal_failure");
  }
}

async function requestFingerprint(
  request: RealtimeVoiceBootstrapRequest,
  principal: OpenAIRealtimePublicPrincipal,
  resource: OpenAIRealtimePublicResource,
): Promise<string> {
  return digest(`handrail.openai.realtime.bootstrap.v1\u0000${stableFingerprintInput(
    request,
    principal,
    resource,
  )}`);
}

async function providerIdempotencyIdentity(prefix: string, key: string): Promise<string> {
  return `handrail-realtime-${prefix}-${await digest(
    `handrail.openai.realtime.${prefix}.v1\u0000${key}`,
  )}`;
}

function safeErrorField(error: unknown, field: string): unknown {
  try {
    return error !== null && typeof error === "object" && !Array.isArray(error)
      ? (error as UnknownRecord)[field]
      : undefined;
  } catch {
    return undefined;
  }
}

function awaitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfRealtimeVoiceAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new RealtimeVoiceOperationError("cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function normalizeProviderFailure(
  error: unknown,
  signal: AbortSignal,
): RealtimeVoiceOperationError {
  if (signal.aborted) return new RealtimeVoiceOperationError("cancelled");
  if (error instanceof RealtimeVoiceOperationError) return error;
  const status = safeErrorField(error, "status");
  const name = safeErrorField(error, "name");
  const code = safeErrorField(error, "code");
  if (
    status === 408 ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) return new RealtimeVoiceOperationError("deadline_exceeded");
  if (status === 409) return new RealtimeVoiceOperationError("idempotency_conflict");
  if (status === 429 || (typeof status === "number" && status >= 500 && status <= 599)) {
    return new RealtimeVoiceOperationError("temporarily_unavailable");
  }
  if (typeof status === "number" && status >= 400 && status <= 499) {
    return new RealtimeVoiceOperationError("invalid_request");
  }
  return new RealtimeVoiceOperationError("internal_failure");
}

function parseProviderResponse(
  value: unknown,
  request: RealtimeVoiceBootstrapRequest,
  capabilities: RealtimeVoiceCapabilities,
  now: number,
): RealtimeVoiceBootstrapResult {
  const source = plainRecord(value);
  const authorization = source === null ? null : plainRecord(source.client_authorization);
  if (
    source === null ||
    !hasExactFields(source, [
      "session_id",
      "expires_at",
      "client_authorization",
      "connection_reference",
    ]) ||
    authorization === null ||
    !hasExactFields(authorization, ["value", "expires_at"])
  ) throw new RealtimeVoiceOperationError("internal_failure");

  try {
    return parseRealtimeVoiceBootstrapResult({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      request_id: request.request_id,
      session_id: source.session_id,
      issued_at: new Date(now).toISOString(),
      expires_at: source.expires_at,
      authorization: {
        kind: "opaque_ephemeral",
        value: authorization.value,
        expires_at: authorization.expires_at,
      },
      connection: {
        transport: "webrtc",
        reference: source.connection_reference,
      },
      configuration: request.configuration,
      capabilities,
    }, { request, now });
  } catch {
    throw new RealtimeVoiceOperationError("internal_failure");
  }
}

function normalizedToolOutput(outcome: RealtimeVoiceServerToolOutcome): string {
  const fallback = () => JSON.stringify({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    status: "failed",
    error: realtimeVoiceSafeError("internal_failure"),
  });
  let normalized: UnknownRecord;
  switch (outcome.status) {
    case "completed":
      normalized = {
        version: REALTIME_VOICE_CONTRACT_VERSION,
        status: "completed",
        is_error: outcome.result.is_error,
        content: outcome.result.content,
      };
      break;
    case "approval_required":
      normalized = {
        version: REALTIME_VOICE_CONTRACT_VERSION,
        status: "approval_required",
      };
      break;
    case "failed":
      normalized = {
        version: REALTIME_VOICE_CONTRACT_VERSION,
        status: "failed",
        error: outcome.error,
      };
      break;
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(normalized);
  } catch {
    return fallback();
  }
  if (UTF8_ENCODER.encode(encoded).byteLength <=
    OPENAI_REALTIME_LIMITS.providerToolOutputBytes) return encoded;
  return fallback();
}

async function providerToolOutputIdentity(
  sessionId: RealtimeVoiceSessionId,
  callId: string,
): Promise<string> {
  return `handrail-tool-output-${(await digest(
    `handrail.openai.realtime.tool-output.v1\u0000${sessionId}\u001f${callId}`,
  )).slice(0, 64)}`;
}

function trackedSnapshot(value: MutableTrackedSession): OpenAIRealtimeTrackedSession {
  return Object.freeze({
    session_id: value.session_id,
    expires_at: value.expires_at,
    request_fingerprint: value.request_fingerprint,
    terminal_state: value.terminal_state,
    cleanup_state: value.cleanup_state,
  });
}

class OpenAIRealtimeServerImpl<TAuthentication>
implements OpenAIRealtimeServer<TAuthentication> {
  readonly #authenticate: OpenAIRealtimeServerOptions<TAuthentication>["authenticate"];
  readonly #authorize: OpenAIRealtimeServerOptions<TAuthentication>["authorize"];
  readonly #supported: OpenAIRealtimeSupportedCapabilities;
  readonly #requestBootstrap: OpenAIRealtimeBootstrapRequestFunction;
  readonly #requestDelete: OpenAIRealtimeDeleteRequestFunction;
  readonly #cleanupSession: OpenAIRealtimeCleanupFunction;
  readonly #captureUsage: OpenAIRealtimeServerOptions<TAuthentication>["capture_usage"];
  readonly #toolBridge: RealtimeVoiceServerToolBridge | undefined;
  readonly #now: () => number;
  readonly #maximumTrackedSessions: number;
  readonly #maximumConcurrentToolCalls: number;
  readonly #toolTimeoutMs: number;
  #activeToolCalls = 0;
  readonly #sessions = new Map<string, MutableTrackedSession>();
  readonly #idempotency = new Map<string, IdempotencyEntry>();
  readonly #authority;

  constructor(options: OpenAIRealtimeServerOptions<TAuthentication>) {
    if (typeof options?.authenticate !== "function") {
      throw new TypeError("OpenAI realtime authenticate must be a function");
    }
    if (typeof options.authorize !== "function") {
      throw new TypeError("OpenAI realtime authorize must be a function");
    }
    if (typeof options.request_bootstrap !== "function") {
      throw new TypeError("OpenAI realtime bootstrap request must be a function");
    }
    if (typeof options.request_delete !== "function") {
      throw new TypeError("OpenAI realtime delete request must be a function");
    }
    if (options.cleanup_session !== undefined && typeof options.cleanup_session !== "function") {
      throw new TypeError("OpenAI realtime cleanup_session must be a function");
    }
    if (
      options.tool_bridge !== undefined &&
      (options.tool_bridge === null ||
        typeof options.tool_bridge !== "object" ||
        typeof options.tool_bridge.execute !== "function" ||
        typeof options.tool_bridge.terminateSession !== "function")
    ) throw new TypeError("OpenAI realtime tool_bridge must implement execute and terminateSession");
    const maximumTrackedSessions = options.maximum_tracked_sessions ??
      OPENAI_REALTIME_LIMITS.maximumTrackedSessions;
    if (
      !Number.isSafeInteger(maximumTrackedSessions) ||
      maximumTrackedSessions < 1 ||
      maximumTrackedSessions > OPENAI_REALTIME_LIMITS.maximumTrackedSessions
    ) throw new TypeError("OpenAI realtime maximum_tracked_sessions is out of bounds");
    const maximumConcurrentToolCalls = options.maximum_concurrent_tool_calls ??
      OPENAI_REALTIME_LIMITS.maximumConcurrentToolCalls;
    if (
      !Number.isSafeInteger(maximumConcurrentToolCalls) ||
      maximumConcurrentToolCalls < 1 ||
      maximumConcurrentToolCalls > OPENAI_REALTIME_LIMITS.maximumConcurrentToolCalls
    ) throw new TypeError("OpenAI realtime maximum_concurrent_tool_calls is out of bounds");
    const toolTimeoutMs = options.tool_timeout_ms ?? OPENAI_REALTIME_LIMITS.toolTimeoutMs;
    if (!Number.isSafeInteger(toolTimeoutMs) || toolTimeoutMs < 1 ||
      toolTimeoutMs > OPENAI_REALTIME_LIMITS.toolTimeoutMs) {
      throw new TypeError("OpenAI realtime tool_timeout_ms is out of bounds");
    }

    this.#authenticate = options.authenticate;
    this.#authorize = options.authorize;
    this.#supported = parseSupportedCapabilities(options.capabilities);
    this.#requestBootstrap = options.request_bootstrap;
    this.#requestDelete = options.request_delete;
    if (options.capture_usage !== undefined && typeof options.capture_usage !== "function") {
      throw new TypeError("OpenAI realtime usage capture must be a function");
    }
    this.#captureUsage = options.capture_usage;
    this.#cleanupSession = options.cleanup_session ?? (() => undefined);
    this.#toolBridge = options.tool_bridge;
    this.#now = options.now ?? Date.now;
    this.#maximumTrackedSessions = maximumTrackedSessions;
    this.#maximumConcurrentToolCalls = maximumConcurrentToolCalls;
    this.#toolTimeoutMs = toolTimeoutMs;
    this.#authority = createIdempotentRealtimeVoiceSessionAuthority({
      adapter: {
        endSession: (request) => this.#endProviderSession(request),
        cleanupSession: (request) => this.#cleanupTrackedSession(request),
      },
      now: this.#now,
      maximumTrackedSessions,
      ...(this.#toolBridge === undefined ? {} : { toolBridge: this.#toolBridge }),
    });
  }

  get trackedSessionCount(): number {
    return this.#sessions.size;
  }

  getTrackedSession(sessionId: RealtimeVoiceSessionId): OpenAIRealtimeTrackedSession | null {
    const id = boundedIdentifier(sessionId);
    if (id === null) throw new RealtimeVoiceOperationError("invalid_request");
    const tracked = this.#sessions.get(id);
    return tracked === undefined ? null : trackedSnapshot(tracked);
  }

  async bootstrap(
    value: RealtimeVoiceBootstrapRequest,
    operation: OpenAIRealtimeBootstrapOperation<TAuthentication>,
  ): Promise<RealtimeVoiceBootstrapResult> {
    let request: RealtimeVoiceBootstrapRequest;
    let resource: OpenAIRealtimePublicResource;
    try {
      request = parseRealtimeVoiceBootstrapRequest(value);
      assertRealtimeVoiceAbortSignal(operation?.signal, "$operation.signal");
      resource = parseResource(operation.resource);
      throwIfRealtimeVoiceAborted(operation.signal);
    } catch (error) {
      if (operation?.signal?.aborted) throw new RealtimeVoiceOperationError("cancelled");
      if (error instanceof RealtimeVoiceOperationError) throw error;
      throw new RealtimeVoiceOperationError("invalid_request");
    }

    let authentication: OpenAIRealtimeAuthenticationDecision;
    try {
      authentication = parseAuthenticationDecision(await awaitWithSignal(
        Promise.resolve().then(() => this.#authenticate(Object.freeze({
          authentication: operation.authentication,
          resource,
          request,
          signal: operation.signal,
        }))),
        operation.signal,
      ));
    } catch (error) {
      if (operation.signal.aborted) throw new RealtimeVoiceOperationError("cancelled");
      if (error instanceof RealtimeVoiceOperationError && error.code === "internal_failure") {
        throw error;
      }
      throw new RealtimeVoiceOperationError("temporarily_unavailable");
    }
    throwIfRealtimeVoiceAborted(operation.signal);
    if (!authentication.authenticated) throw new RealtimeVoiceOperationError("invalid_state");

    let policy: OpenAIRealtimePolicyDecision;
    try {
      policy = parsePolicyDecision(await awaitWithSignal(
        Promise.resolve().then(() => this.#authorize(Object.freeze({
          principal: authentication.principal,
          resource,
          request,
          signal: operation.signal,
        }))),
        operation.signal,
      ));
    } catch (error) {
      if (operation.signal.aborted) throw new RealtimeVoiceOperationError("cancelled");
      if (error instanceof RealtimeVoiceOperationError && error.code === "internal_failure") {
        throw error;
      }
      throw new RealtimeVoiceOperationError("temporarily_unavailable");
    }
    throwIfRealtimeVoiceAborted(operation.signal);
    if (!policy.allowed) throw new RealtimeVoiceOperationError("invalid_state");

    const fingerprint = await requestFingerprint(
      request,
      authentication.principal,
      resource,
    );
    throwIfRealtimeVoiceAborted(operation.signal);
    const existing = this.#idempotency.get(request.idempotency_key);
    if (existing !== undefined && existing.fingerprint !== fingerprint) {
      throw new RealtimeVoiceOperationError("idempotency_conflict");
    }
    if (existing === undefined) {
      this.#makeRoom();
      this.#idempotency.set(request.idempotency_key, {
        fingerprint,
        status: "pending",
      });
    }
    try {
      const capabilities = offeredCapabilities(request, this.#supported);
      const idempotencyKey = await providerIdempotencyIdentity(
        "bootstrap",
        request.idempotency_key,
      );
      throwIfRealtimeVoiceAborted(operation.signal);
      let rawResponse: unknown;
      try {
        rawResponse = await awaitWithSignal(
          Promise.resolve().then(() => this.#requestBootstrap(Object.freeze({
            transport: "webrtc",
            configuration: request.configuration,
            capabilities,
          }), Object.freeze({
            signal: operation.signal,
            idempotency_key: idempotencyKey,
          }))),
          operation.signal,
        );
      } catch (error) {
        throw normalizeProviderFailure(error, operation.signal);
      }
      throwIfRealtimeVoiceAborted(operation.signal);
      const now = this.#readNow();
      const result = parseProviderResponse(rawResponse, request, capabilities, now);
      const priorSessionId = this.#idempotency.get(request.idempotency_key)?.session_id;
      if (priorSessionId !== undefined && priorSessionId !== result.session_id) {
        throw new RealtimeVoiceOperationError("internal_failure");
      }
      const existingSession = this.#sessions.get(result.session_id);
      if (
        existingSession !== undefined &&
        (existingSession.request_fingerprint !== fingerprint ||
          existingSession.idempotency_key !== request.idempotency_key)
      ) throw new RealtimeVoiceOperationError("idempotency_conflict");

      if (existingSession === undefined) {
        this.#sessions.set(result.session_id, {
          session_id: result.session_id,
          expires_at: result.expires_at,
          expiresAtMs: Date.parse(result.expires_at),
          request_fingerprint: fingerprint,
          idempotency_key: request.idempotency_key,
          capabilities,
          eventController: new AbortController(),
          providerEvents: new Map(),
          usageCaptures: new Map(),
          toolCalls: new Map(),
          toolOperations: new Map(),
          toolOutputsSent: new Set(),
          provider_termination: null,
          event_sequence: 0,
          provider_started: false,
          response_id: null,
          terminal_event: null,
          terminal_state: "open",
          cleanup_state: "pending",
        });
      }
      const entry = this.#idempotency.get(request.idempotency_key);
      if (entry !== undefined) {
        entry.session_id = result.session_id;
        entry.status = "tracked";
      }
      return result;
    } catch (error) {
      const entry = this.#idempotency.get(request.idempotency_key);
      if (entry !== undefined && entry.session_id === undefined) entry.status = "failed";
      throw error;
    }
  }

  async hangup(request: RealtimeVoiceHangupRequest): Promise<RealtimeVoiceTerminalResult> {
    let parsed: RealtimeVoiceHangupRequest;
    try {
      parsed = parseRealtimeVoiceHangupRequest(request);
    } catch (error) {
      if (request?.signal?.aborted) throw new RealtimeVoiceOperationError("cancelled");
      throw error;
    }
    const tracked = this.#sessions.get(parsed.session_id);
    tracked?.eventController.abort();
    const result = await this.#authority.hangup(parsed);
    const completed = this.#sessions.get(result.session_id);
    if (completed !== undefined) completed.terminal_state = "ended";
    return result;
  }

  cleanup(request: RealtimeVoiceCleanupRequest): Promise<RealtimeVoiceCleanupResult> {
    return this.#authority.cleanup(request);
  }

  async handleProviderEvent(
    request: OpenAIRealtimeProviderEventRequest,
    operation: RealtimeVoiceOperationInput,
  ): Promise<RealtimeVoiceSessionEvent | null> {
    assertRealtimeVoiceAbortSignal(operation?.signal, "$provider_event_operation.signal");
    if (this.#captureUsage === undefined) throwIfRealtimeVoiceAborted(operation.signal);
    const sessionId = boundedIdentifier(request?.session_id);
    if (sessionId === null) throw new RealtimeVoiceOperationError("invalid_request");
    if (
      request?.channel === null || typeof request?.channel !== "object" ||
      typeof request.channel.send !== "function"
    ) throw new RealtimeVoiceOperationError("invalid_request");
    const tracked = this.#sessions.get(sessionId);
    const usage = this.#captureUsage === undefined ? null
      : parseOpenAIRealtimeUsageObservation(sessionId as RealtimeVoiceSessionId, request.event);
    if (usage !== null) {
      if (tracked === undefined) throw new RealtimeVoiceOperationError("invalid_state");
      const retention = this.#retainUsage(tracked, usage);
      // Cancellation stops waiting, not the durable write. Observe rejection
      // even when awaitWithSignal sees an already-aborted caller.
      void retention.catch(() => undefined);
      await awaitWithSignal(retention, operation.signal);
    }
    throwIfRealtimeVoiceAborted(operation.signal);
    const parsed = parseProviderEvent(request.event);
    if (parsed.kind === "unknown") return null;
    if (tracked === undefined) throw new RealtimeVoiceOperationError("invalid_state");
    if (usage !== null && tracked.terminal_state !== "open") return null;
    if (tracked.terminal_state !== "open") {
      if (parsed.kind === "failure" && tracked.terminal_event !== null) {
        return this.#terminateFromProvider(
          tracked,
          parsed.eventId,
          "failure",
          operation.signal,
        );
      }
      throw new RealtimeVoiceOperationError("invalid_state");
    }
    const fingerprint = await digest(
      `handrail.openai.realtime.event.v1\u0000${parsed.fingerprintInput}`,
    );
    throwIfRealtimeVoiceAborted(operation.signal);
    const priorEvent = tracked.providerEvents.get(parsed.eventId);
    if (priorEvent !== undefined) {
      if (priorEvent !== fingerprint) {
        throw new RealtimeVoiceOperationError("idempotency_conflict");
      }
      return null;
    }
    this.#rememberProviderEvent(tracked, parsed.eventId, fingerprint);

    switch (parsed.kind) {
      case "session_started":
        if (parsed.sessionId !== tracked.session_id) {
          throw new RealtimeVoiceOperationError("invalid_request");
        }
        if (tracked.provider_started) return null;
        tracked.provider_started = true;
        return this.#sessionEvent(tracked, parsed.eventId, "session_started");
      case "response_started":
        if (!tracked.provider_started) return null;
        if (tracked.response_id === null) {
          tracked.response_id = parsed.responseId;
          return this.#sessionEvent(tracked, parsed.eventId, "response_started");
        }
        return tracked.response_id === parsed.responseId ? null : null;
      case "response_stopped":
      case "response_interrupted":
        if (!tracked.provider_started || tracked.response_id === null) return null;
        if (parsed.responseId !== "barge-in" && parsed.responseId !== tracked.response_id) {
          return null;
        }
        tracked.response_id = null;
        return this.#sessionEvent(tracked, parsed.eventId, "response_interrupted");
      case "failure":
        return this.#terminateFromProvider(tracked, parsed.eventId, "failure", operation.signal);
      case "tool_call":
        if (!tracked.provider_started || tracked.response_id !== parsed.responseId) return null;
        return this.#handleToolCall(tracked, parsed, request.channel, operation.signal);
    }
  }

  async #retainUsage(tracked: MutableTrackedSession, observation: OpenAIRealtimeUsageObservation): Promise<void> {
    const key = JSON.stringify([observation.operation, observation.operation_id, observation.content_index]);
    const fingerprint = JSON.stringify(observation);
    const prior = tracked.usageCaptures.get(key);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) throw new RealtimeVoiceOperationError("idempotency_conflict");
      return prior.promise;
    }
    if (tracked.usageCaptures.size >= OPENAI_REALTIME_LIMITS.maximumTrackedProviderEvents) {
      const settled = [...tracked.usageCaptures].find(([, value]) => !value.pending);
      if (settled === undefined) throw new RealtimeVoiceOperationError("temporarily_unavailable");
      // This is a bounded in-process cache. The host's durable identity still
      // prevents charging twice if an evicted operation is replayed later.
      tracked.usageCaptures.delete(settled[0]);
    }
    const entry = { fingerprint, pending: true, promise: Promise.resolve() };
    entry.promise = Promise.resolve().then(() => this.#captureUsage!(observation)).then(() => {
      entry.pending = false;
    }, () => {
      tracked.usageCaptures.delete(key);
      throw new RealtimeVoiceOperationError("temporarily_unavailable");
    });
    tracked.usageCaptures.set(key, entry);
    return entry.promise;
  }

  async providerTerminated(
    request: OpenAIRealtimeProviderTerminalRequest,
    operation: RealtimeVoiceOperationInput,
  ): Promise<RealtimeVoiceSessionEvent> {
    assertRealtimeVoiceAbortSignal(operation?.signal, "$provider_terminal_operation.signal");
    throwIfRealtimeVoiceAborted(operation.signal);
    const sessionId = boundedIdentifier(request?.session_id);
    const eventId = boundedIdentifier(request?.event_id);
    if (
      sessionId === null || eventId === null ||
      (request.reason !== "closed" && request.reason !== "failure")
    ) throw new RealtimeVoiceOperationError("invalid_request");
    const tracked = this.#sessions.get(sessionId);
    if (tracked === undefined) throw new RealtimeVoiceOperationError("invalid_state");
    return this.#terminateFromProvider(
      tracked,
      eventId as RealtimeVoiceEventId,
      request.reason,
      operation.signal,
    );
  }

  #rememberProviderEvent(
    tracked: MutableTrackedSession,
    eventId: RealtimeVoiceEventId,
    fingerprint: string,
  ): void {
    tracked.providerEvents.set(eventId, fingerprint);
    while (tracked.providerEvents.size > OPENAI_REALTIME_LIMITS.maximumTrackedProviderEvents) {
      const oldest = tracked.providerEvents.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      tracked.providerEvents.delete(oldest);
    }
  }

  #sessionEvent(
    tracked: MutableTrackedSession,
    eventId: RealtimeVoiceEventId,
    type: Exclude<RealtimeVoiceSessionEvent["type"], "session_failed">,
  ): RealtimeVoiceSessionEvent {
    tracked.event_sequence += 1;
    return Object.freeze({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      session_id: tracked.session_id,
      event_id: eventId,
      sequence: tracked.event_sequence,
      occurred_at: new Date(this.#readNow()).toISOString() as RealtimeVoiceTimestamp,
      type,
    }) as RealtimeVoiceSessionEvent;
  }

  async #terminateFromProvider(
    tracked: MutableTrackedSession,
    eventId: RealtimeVoiceEventId,
    reason: "closed" | "failure",
    signal: AbortSignal,
  ): Promise<RealtimeVoiceSessionEvent> {
    if (tracked.terminal_event === null) {
      tracked.eventController.abort();
      tracked.response_id = null;
      tracked.terminal_state = "provider_ended";
      tracked.event_sequence += 1;
      const base = {
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: tracked.session_id,
        event_id: eventId,
        sequence: tracked.event_sequence,
        occurred_at: new Date(this.#readNow()).toISOString() as RealtimeVoiceTimestamp,
      } as const;
      tracked.terminal_event = reason === "failure"
        ? Object.freeze({
            ...base,
            type: "session_failed" as const,
            error: realtimeVoiceSafeError("internal_failure"),
          })
        : Object.freeze({ ...base, type: "session_ended" as const });
    }
    if (tracked.provider_termination === null) {
      const pending = (async () => {
        await this.#toolBridge?.terminateSession(tracked.session_id);
        await this.#cleanupTrackedSession(Object.freeze({
          session_id: tracked.session_id,
          signal,
        }));
        tracked.terminal_state = "ended";
      })();
      tracked.provider_termination = pending;
      void pending.catch(() => {
        if (tracked.provider_termination === pending) tracked.provider_termination = null;
      });
    }
    try {
      await tracked.provider_termination;
    } catch (error) {
      throw normalizeProviderFailure(error, signal);
    }
    return tracked.terminal_event;
  }

  async #handleToolCall(
    tracked: MutableTrackedSession,
    event: Extract<ParsedProviderEvent, { readonly kind: "tool_call" }>,
    channel: OpenAIRealtimeProviderEventChannel,
    callerSignal: AbortSignal,
  ): Promise<null> {
    const fingerprint = await digest(
      `handrail.openai.realtime.tool-call.v1\u0000${event.fingerprintInput}`,
    );
    const prior = tracked.toolCalls.get(event.callId);
    if (prior !== undefined) {
      if (prior !== fingerprint) {
        throw new RealtimeVoiceOperationError("idempotency_conflict");
      }
      if (tracked.toolOutputsSent.has(event.callId)) return null;
      const existing = tracked.toolOperations.get(event.callId);
      if (existing !== undefined) return existing;
      const retry = this.#executeAndSendToolCall(tracked, event, channel, callerSignal);
      tracked.toolOperations.set(event.callId, retry);
      void retry.finally(() => tracked.toolOperations.delete(event.callId))
        .catch(() => undefined);
      return retry;
    }
    if (tracked.toolCalls.size >= OPENAI_REALTIME_LIMITS.maximumTrackedToolCalls) {
      await this.#sendToolOutcome(channel, event.callId, Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: tracked.session_id,
        call_id: event.callId as never,
        status: "failed",
        error: realtimeVoiceSafeError("temporarily_unavailable"),
      }), callerSignal);
      tracked.toolOutputsSent.add(event.callId);
      return null;
    }
    tracked.toolCalls.set(event.callId, fingerprint);

    const existing = tracked.toolOperations.get(event.callId);
    if (existing !== undefined) return existing;
    const operation = this.#executeAndSendToolCall(tracked, event, channel, callerSignal);
    tracked.toolOperations.set(event.callId, operation);
    void operation.finally(() => tracked.toolOperations.delete(event.callId)).catch(() => undefined);
    return operation;
  }

  async #executeAndSendToolCall(
    tracked: MutableTrackedSession,
    event: Extract<ParsedProviderEvent, { readonly kind: "tool_call" }>,
    channel: OpenAIRealtimeProviderEventChannel,
    callerSignal: AbortSignal,
  ): Promise<null> {
    if (this.#activeToolCalls >= this.#maximumConcurrentToolCalls) {
      await this.#sendToolOutcome(channel, event.callId, Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: tracked.session_id,
        call_id: event.callId as never,
        status: "failed",
        error: realtimeVoiceSafeError("temporarily_unavailable"),
      }), callerSignal);
      tracked.toolOutputsSent.add(event.callId);
      return null;
    }
    const bridge = this.#toolBridge;
    const capability = tracked.capabilities.server_tool_execution;
    if (bridge === undefined || !capability.supported) {
      await this.#sendToolOutcome(channel, event.callId, Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: tracked.session_id,
        call_id: event.callId as never,
        status: "failed",
        error: realtimeVoiceSafeError("unsupported_capability"),
      }), callerSignal);
      tracked.toolOutputsSent.add(event.callId);
      return null;
    }

    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(event.argumentsText);
    } catch {
      await this.#sendToolOutcome(channel, event.callId, Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: tracked.session_id,
        call_id: event.callId as never,
        status: "failed",
        error: realtimeVoiceSafeError("invalid_request"),
      }), callerSignal);
      tracked.toolOutputsSent.add(event.callId);
      return null;
    }

    this.#activeToolCalls += 1;
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (callerSignal.aborted || tracked.eventController.signal.aborted) controller.abort();
    else {
      callerSignal.addEventListener("abort", abort, { once: true });
      tracked.eventController.signal.addEventListener("abort", abort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#toolTimeoutMs);
    let outcome: RealtimeVoiceServerToolOutcome;
    try {
      const idempotency = await digest(
        `handrail.openai.realtime.tool-idempotency.v1\u0000${tracked.session_id}\u001f${event.callId}`,
      );
      outcome = await bridge.execute(Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: tracked.session_id,
        capability_ref: capability.capability_ref,
        call_id: event.callId,
        idempotency_key: `openai-tool:${idempotency.slice(0, 64)}`,
        name: event.name,
        arguments: argumentsValue,
      }), { signal: controller.signal });
      if (timedOut) {
        outcome = Object.freeze({
          version: REALTIME_VOICE_CONTRACT_VERSION,
          session_id: tracked.session_id,
          call_id: event.callId as never,
          status: "failed",
          error: realtimeVoiceSafeError("deadline_exceeded"),
        });
      }
    } catch {
      outcome = Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: tracked.session_id,
        call_id: event.callId as never,
        status: "failed",
        error: realtimeVoiceSafeError(timedOut
          ? "deadline_exceeded"
          : controller.signal.aborted
          ? "cancelled"
          : "internal_failure"),
      });
    } finally {
      clearTimeout(timer);
      callerSignal.removeEventListener("abort", abort);
      tracked.eventController.signal.removeEventListener("abort", abort);
      this.#activeToolCalls -= 1;
    }
    if (callerSignal.aborted) throw new RealtimeVoiceOperationError("cancelled");
    if (tracked.eventController.signal.aborted) return null;
    await this.#sendToolOutcome(channel, event.callId, outcome, callerSignal);
    tracked.toolOutputsSent.add(event.callId);
    return null;
  }

  async #sendToolOutcome(
    channel: OpenAIRealtimeProviderEventChannel,
    callId: string,
    outcome: RealtimeVoiceServerToolOutcome,
    signal: AbortSignal,
  ): Promise<void> {
    const output = normalizedToolOutput(outcome);
    const outputEventId = await providerToolOutputIdentity(outcome.session_id, callId);
    try {
      await awaitWithSignal(Promise.resolve().then(() => channel.send(Object.freeze({
        event_id: outputEventId,
        type: "conversation.item.create" as const,
        item: Object.freeze({
          type: "function_call_output" as const,
          call_id: callId,
          output,
        }),
      }), Object.freeze({ signal }))), signal);
    } catch (error) {
      throw normalizeProviderFailure(error, signal);
    }
  }

  #readNow(): number {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new RealtimeVoiceOperationError("internal_failure");
    return now;
  }

  #makeRoom(): void {
    for (const [sessionId, tracked] of this.#sessions) {
      if (tracked.terminal_state !== "ended" || tracked.cleanup_state !== "cleaned") continue;
      this.#sessions.delete(sessionId);
      this.#idempotency.delete(tracked.idempotency_key);
      if (
        this.#sessions.size < this.#maximumTrackedSessions &&
        this.#idempotency.size < this.#maximumTrackedSessions
      ) return;
    }
    for (const [key, entry] of this.#idempotency) {
      if (entry.status !== "failed") continue;
      this.#idempotency.delete(key);
      if (
        this.#sessions.size < this.#maximumTrackedSessions &&
        this.#idempotency.size < this.#maximumTrackedSessions
      ) return;
    }
    if (
      this.#sessions.size >= this.#maximumTrackedSessions ||
      this.#idempotency.size >= this.#maximumTrackedSessions
    ) throw new RealtimeVoiceOperationError("temporarily_unavailable");
  }

  async #endProviderSession(request: RealtimeVoiceHangupRequest): Promise<void> {
    const tracked = this.#sessions.get(request.session_id);
    if (tracked === undefined) throw new RealtimeVoiceOperationError("invalid_state");
    if (tracked.terminal_state !== "open") return;
    if (tracked.expiresAtMs <= this.#readNow()) {
      tracked.terminal_state = "provider_ended";
      return;
    }
    const idempotencyKey = await providerIdempotencyIdentity(
      "hangup",
      request.idempotency_key,
    );
    throwIfRealtimeVoiceAborted(request.signal);
    try {
      await this.#requestDelete(Object.freeze({
        session_id: request.session_id,
        reason: request.reason,
      }), Object.freeze({
        signal: request.signal,
        idempotency_key: idempotencyKey,
      }));
      tracked.terminal_state = "provider_ended";
    } catch (error) {
      throw normalizeProviderFailure(error, request.signal);
    }
  }

  async #cleanupTrackedSession(request: RealtimeVoiceCleanupRequest): Promise<void> {
    const tracked = this.#sessions.get(request.session_id);
    if (tracked === undefined) throw new RealtimeVoiceOperationError("invalid_state");
    if (tracked.cleanup_state === "cleaned") return;
    try {
      await this.#cleanupSession(request);
      tracked.cleanup_state = "cleaned";
    } catch (error) {
      throw normalizeProviderFailure(error, request.signal);
    }
  }
}

/** Creates an opt-in trusted-server OpenAI realtime bootstrap and session authority. */
export function createOpenAIRealtimeServer<TAuthentication = unknown>(
  options: OpenAIRealtimeServerOptions<TAuthentication>,
): OpenAIRealtimeServer<TAuthentication> {
  return new OpenAIRealtimeServerImpl(options);
}
