/** Provider-neutral contracts for a short-lived realtime voice session. */
export const REALTIME_VOICE_CONTRACT_VERSION = "handrail.realtime-voice.v1" as const;

export const REALTIME_VOICE_LIMITS = Object.freeze({
  identifierLength: 128,
  connectionReferenceLength: 2_048,
  authorizationLength: 4_096,
  capabilityReferenceLength: 256,
  idempotencyKeyLength: 128,
  maximumAuthorizationTtlMs: 5 * 60_000,
  maximumSessionDurationMs: 60 * 60_000,
  minimumSessionDurationMs: 10_000,
  maximumIdleTimeoutMs: 5 * 60_000,
  minimumIdleTimeoutMs: 1_000,
  minimumSampleRateHz: 8_000,
  maximumSampleRateHz: 96_000,
  maximumChannels: 2,
  safeErrorMessageLength: 160,
  trackedEventIds: 128,
  trackedTerminalSessions: 1_000,
} as const);

export const REALTIME_VOICE_AUDIO_ENCODINGS = Object.freeze([
  "pcm16",
  "g711_ulaw",
  "g711_alaw",
  "opus",
] as const);

export const REALTIME_VOICE_UNSUPPORTED_REASONS = Object.freeze([
  "not_requested",
  "provider_not_supported",
  "transport_not_supported",
  "audio_format_not_supported",
  "policy_denied",
  "server_tools_not_configured",
] as const);

export const REALTIME_VOICE_ERROR_CODES = Object.freeze([
  "invalid_request",
  "invalid_state",
  "unsupported_capability",
  "authorization_expired",
  "idempotency_conflict",
  "cancelled",
  "deadline_exceeded",
  "temporarily_unavailable",
  "internal_failure",
] as const);

declare const realtimeVoiceOpaque: unique symbol;
type OpaqueString<Name extends string> = string & {
  readonly [realtimeVoiceOpaque]: Name;
};

export type RealtimeVoiceRequestId = OpaqueString<"RealtimeVoiceRequestId">;
export type RealtimeVoiceSessionId = OpaqueString<"RealtimeVoiceSessionId">;
export type RealtimeVoiceEventId = OpaqueString<"RealtimeVoiceEventId">;
export type RealtimeVoiceIdempotencyKey = OpaqueString<"RealtimeVoiceIdempotencyKey">;
export type RealtimeVoiceConnectionReference = OpaqueString<"RealtimeVoiceConnectionReference">;
export type RealtimeVoiceClientAuthorizationValue = OpaqueString<"RealtimeVoiceClientAuthorizationValue">;
export type RealtimeVoiceServerToolCapabilityReference = OpaqueString<"RealtimeVoiceServerToolCapabilityReference">;
export type RealtimeVoiceTimestamp = OpaqueString<"RealtimeVoiceTimestamp">;

export type RealtimeVoiceAudioEncoding =
  (typeof REALTIME_VOICE_AUDIO_ENCODINGS)[number];
export type RealtimeVoiceUnsupportedReason =
  (typeof REALTIME_VOICE_UNSUPPORTED_REASONS)[number];
export type RealtimeVoiceErrorCode =
  (typeof REALTIME_VOICE_ERROR_CODES)[number];

export interface RealtimeVoiceAudioConfiguration {
  readonly encoding: RealtimeVoiceAudioEncoding;
  readonly sample_rate_hz: number;
  readonly channels: 1 | 2;
}

export interface RealtimeVoiceSessionConfiguration {
  readonly transport: "webrtc";
  readonly maximum_duration_ms: number;
  readonly idle_timeout_ms: number;
  readonly input_audio: RealtimeVoiceAudioConfiguration | null;
  readonly output_audio: RealtimeVoiceAudioConfiguration | null;
}

export interface RealtimeVoiceRequestedCapabilities {
  readonly input_audio: boolean;
  readonly output_audio: boolean;
  readonly interruption: boolean;
  /** Opaque trusted-server authorization scope; it is never an executable callback. */
  readonly server_tool_execution:
    | false
    | { readonly capability_ref: RealtimeVoiceServerToolCapabilityReference };
}

export interface RealtimeVoiceSupportedCapability {
  readonly supported: true;
}

export interface RealtimeVoiceUnsupportedCapability {
  readonly supported: false;
  readonly reason: RealtimeVoiceUnsupportedReason;
}

export type RealtimeVoiceCapabilityDescriptor =
  | RealtimeVoiceSupportedCapability
  | RealtimeVoiceUnsupportedCapability;

export interface RealtimeVoiceServerToolCapability {
  readonly supported: true;
  readonly capability_ref: RealtimeVoiceServerToolCapabilityReference;
}

export type RealtimeVoiceServerToolCapabilityDescriptor =
  | RealtimeVoiceServerToolCapability
  | RealtimeVoiceUnsupportedCapability;

export interface RealtimeVoiceCapabilities {
  readonly input_audio: RealtimeVoiceCapabilityDescriptor;
  readonly output_audio: RealtimeVoiceCapabilityDescriptor;
  readonly interruption: RealtimeVoiceCapabilityDescriptor;
  readonly server_tool_execution: RealtimeVoiceServerToolCapabilityDescriptor;
}

/** Strict trusted-server input. Authentication and policy context stay outside this value. */
export interface RealtimeVoiceBootstrapRequest {
  readonly version: typeof REALTIME_VOICE_CONTRACT_VERSION;
  readonly request_id: RealtimeVoiceRequestId;
  readonly idempotency_key: RealtimeVoiceIdempotencyKey;
  readonly configuration: RealtimeVoiceSessionConfiguration;
  readonly requested_capabilities: RealtimeVoiceRequestedCapabilities;
}

/** Ephemeral browser authorization. It must never be copied into normalized session state. */
export interface RealtimeVoiceClientAuthorization {
  readonly kind: "opaque_ephemeral";
  readonly value: RealtimeVoiceClientAuthorizationValue;
  readonly expires_at: RealtimeVoiceTimestamp;
}

export interface RealtimeVoiceClientConnection {
  readonly transport: "webrtc";
  /** Opaque adapter-owned connection data, not a raw provider request or response. */
  readonly reference: RealtimeVoiceConnectionReference;
}

export interface RealtimeVoiceBootstrapResult {
  readonly version: typeof REALTIME_VOICE_CONTRACT_VERSION;
  readonly request_id: RealtimeVoiceRequestId;
  readonly session_id: RealtimeVoiceSessionId;
  readonly issued_at: RealtimeVoiceTimestamp;
  readonly expires_at: RealtimeVoiceTimestamp;
  readonly authorization: RealtimeVoiceClientAuthorization;
  readonly connection: RealtimeVoiceClientConnection;
  readonly configuration: RealtimeVoiceSessionConfiguration;
  readonly capabilities: RealtimeVoiceCapabilities;
}

export type RealtimeVoiceSessionStatus =
  | "ready"
  | "active"
  | "ending"
  | "ended"
  | "failed";

export interface RealtimeVoiceSafeError {
  readonly code: RealtimeVoiceErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

/** Safe normalized state: no authorization, connection data, audio, prompts, or transcripts. */
export interface RealtimeVoiceSessionState {
  readonly version: typeof REALTIME_VOICE_CONTRACT_VERSION;
  readonly session_id: RealtimeVoiceSessionId;
  readonly status: RealtimeVoiceSessionStatus;
  readonly configuration: RealtimeVoiceSessionConfiguration;
  readonly capabilities: RealtimeVoiceCapabilities;
  readonly local_media: "active" | "stopped";
  readonly response_active: boolean;
  readonly last_event_sequence: number;
  readonly recent_event_ids: readonly RealtimeVoiceEventId[];
  readonly error: RealtimeVoiceSafeError | null;
}

interface RealtimeVoiceEventBase {
  readonly version: typeof REALTIME_VOICE_CONTRACT_VERSION;
  readonly session_id: RealtimeVoiceSessionId;
  readonly event_id: RealtimeVoiceEventId;
  readonly sequence: number;
  readonly occurred_at: RealtimeVoiceTimestamp;
}

export type RealtimeVoiceSessionEvent =
  | (RealtimeVoiceEventBase & { readonly type: "session_started" })
  | (RealtimeVoiceEventBase & { readonly type: "response_started" })
  | (RealtimeVoiceEventBase & { readonly type: "response_interrupted" })
  | (RealtimeVoiceEventBase & { readonly type: "local_media_stopped" })
  | (RealtimeVoiceEventBase & { readonly type: "hangup_started" })
  | (RealtimeVoiceEventBase & { readonly type: "session_ended" })
  | (RealtimeVoiceEventBase & {
      readonly type: "session_failed";
      readonly error: RealtimeVoiceSafeError;
    });

export interface RealtimeVoiceOperationInput {
  readonly signal: AbortSignal;
}

export interface RealtimeVoiceClientOperationInput extends RealtimeVoiceOperationInput {
  readonly session_id: RealtimeVoiceSessionId;
}

export interface RealtimeVoiceStartInput extends RealtimeVoiceClientOperationInput {
  readonly connection: RealtimeVoiceClientConnection;
  readonly authorization: RealtimeVoiceClientAuthorization;
}

/** Browser/transport implementation boundary; no server-tool callback is accepted. */
export interface RealtimeVoiceClientAdapter {
  start(input: RealtimeVoiceStartInput): Promise<RealtimeVoiceSessionEvent>;
  interrupt(input: RealtimeVoiceClientOperationInput): Promise<RealtimeVoiceSessionEvent>;
  stopLocalMedia(input: RealtimeVoiceClientOperationInput): Promise<RealtimeVoiceSessionEvent>;
}

export interface RealtimeVoiceClientSession {
  getState(): RealtimeVoiceSessionState;
  start(input: RealtimeVoiceOperationInput): Promise<RealtimeVoiceSessionState>;
  interrupt(input: RealtimeVoiceOperationInput): Promise<RealtimeVoiceSessionState>;
  stopLocalMedia(input: RealtimeVoiceOperationInput): Promise<RealtimeVoiceSessionState>;
  applyEvent(event: unknown): RealtimeVoiceSessionState;
}

export type RealtimeVoiceHangupReason =
  | "client_request"
  | "session_expired"
  | "idle_timeout"
  | "policy"
  | "server_shutdown"
  | "failure";

export interface RealtimeVoiceHangupRequest {
  readonly version: typeof REALTIME_VOICE_CONTRACT_VERSION;
  readonly request_id: RealtimeVoiceRequestId;
  readonly idempotency_key: RealtimeVoiceIdempotencyKey;
  readonly session_id: RealtimeVoiceSessionId;
  readonly reason: RealtimeVoiceHangupReason;
  readonly signal: AbortSignal;
}

export interface RealtimeVoiceCleanupRequest {
  readonly session_id: RealtimeVoiceSessionId;
  readonly signal: AbortSignal;
}

export interface RealtimeVoiceTerminalResult {
  readonly version: typeof REALTIME_VOICE_CONTRACT_VERSION;
  readonly session_id: RealtimeVoiceSessionId;
  readonly status: "ended";
  readonly ended_at: RealtimeVoiceTimestamp;
}

export interface RealtimeVoiceCleanupResult {
  readonly session_id: RealtimeVoiceSessionId;
  readonly status: "cleaned";
}

/** Trusted-server authority. Local media stop does not invoke either operation. */
export interface RealtimeVoiceSessionAuthority {
  hangup(request: RealtimeVoiceHangupRequest): Promise<RealtimeVoiceTerminalResult>;
  cleanup(request: RealtimeVoiceCleanupRequest): Promise<RealtimeVoiceCleanupResult>;
}

export interface RealtimeVoiceSessionAuthorityAdapter {
  endSession(request: RealtimeVoiceHangupRequest): Promise<void> | void;
  cleanupSession(request: RealtimeVoiceCleanupRequest): Promise<void> | void;
}

export interface RealtimeVoiceBootstrapService {
  bootstrap(
    request: RealtimeVoiceBootstrapRequest & RealtimeVoiceOperationInput,
  ): Promise<RealtimeVoiceBootstrapResult>;
}
