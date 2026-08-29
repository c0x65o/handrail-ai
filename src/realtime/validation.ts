import {
  REALTIME_VOICE_AUDIO_ENCODINGS,
  REALTIME_VOICE_CONTRACT_VERSION,
  REALTIME_VOICE_ERROR_CODES,
  REALTIME_VOICE_LIMITS,
  REALTIME_VOICE_UNSUPPORTED_REASONS,
  type RealtimeVoiceAudioConfiguration,
  type RealtimeVoiceAudioEncoding,
  type RealtimeVoiceBootstrapRequest,
  type RealtimeVoiceBootstrapResult,
  type RealtimeVoiceCapabilities,
  type RealtimeVoiceCapabilityDescriptor,
  type RealtimeVoiceClientAuthorization,
  type RealtimeVoiceClientAuthorizationValue,
  type RealtimeVoiceClientConnection,
  type RealtimeVoiceConnectionReference,
  type RealtimeVoiceErrorCode,
  type RealtimeVoiceEventId,
  type RealtimeVoiceIdempotencyKey,
  type RealtimeVoiceRequestId,
  type RealtimeVoiceRequestedCapabilities,
  type RealtimeVoiceSafeError,
  type RealtimeVoiceServerToolCapabilityDescriptor,
  type RealtimeVoiceServerToolCapabilityReference,
  type RealtimeVoiceSessionConfiguration,
  type RealtimeVoiceSessionEvent,
  type RealtimeVoiceSessionId,
  type RealtimeVoiceSessionState,
  type RealtimeVoiceTimestamp,
  type RealtimeVoiceUnsupportedCapability,
  type RealtimeVoiceUnsupportedReason,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const OPAQUE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._~+:/=-]*$/;
const AUTHORIZATION_VALUE = /^[A-Za-z0-9][A-Za-z0-9._~+/-]*={0,2}$/;
const UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const SENSITIVE_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

const SAFE_ERRORS: Readonly<Record<RealtimeVoiceErrorCode, {
  readonly message: string;
  readonly retryable: boolean;
}>> = Object.freeze({
  invalid_request: { message: "The realtime voice request is invalid.", retryable: false },
  invalid_state: { message: "The realtime voice operation is not valid in the current state.", retryable: false },
  unsupported_capability: { message: "A requested realtime voice capability is unavailable.", retryable: false },
  authorization_expired: { message: "The realtime voice authorization has expired.", retryable: false },
  idempotency_conflict: { message: "The idempotency key conflicts with another realtime voice operation.", retryable: false },
  cancelled: { message: "The realtime voice operation was cancelled.", retryable: false },
  deadline_exceeded: { message: "The realtime voice operation exceeded its deadline.", retryable: true },
  temporarily_unavailable: { message: "Realtime voice is temporarily unavailable.", retryable: true },
  internal_failure: { message: "The realtime voice operation failed.", retryable: false },
});

export class RealtimeVoiceValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "RealtimeVoiceValidationError";
    this.path = path;
  }
}

/** An implementation may throw this without attaching a sensitive native cause. */
export class RealtimeVoiceOperationError extends Error {
  readonly code: RealtimeVoiceErrorCode;

  constructor(code: RealtimeVoiceErrorCode) {
    super(SAFE_ERRORS[code].message);
    this.name = "RealtimeVoiceOperationError";
    this.code = code;
  }
}

export class RealtimeVoiceTransitionError extends RealtimeVoiceOperationError {
  constructor() {
    super("invalid_state");
    this.name = "RealtimeVoiceTransitionError";
  }
}

function fail(path: string, message: string): never {
  throw new RealtimeVoiceValidationError(path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(path, "must be a plain JSON object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "must contain only string-named fields");
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}.${key}`, "must be an enumerable data field");
    }
  }
  return value as UnknownRecord;
}

function exactFields(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not a supported field");
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length === 0 || value.length > maximum) {
    fail(path, `must contain 1-${maximum} characters`);
  }
  if ([...value].some((character) => {
    const point = character.codePointAt(0)!;
    return point <= 0x1f || point === 0x7f;
  })) {
    fail(path, "must not contain control characters");
  }
  if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    fail(path, "must not contain credential material");
  }
  return value;
}

function identifier<T extends string>(value: unknown, path: string): T {
  const parsed = boundedString(value, path, REALTIME_VOICE_LIMITS.identifierLength);
  if (!IDENTIFIER.test(parsed)) fail(path, "must be an opaque identifier");
  return parsed as T;
}

function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    fail(path, `must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): {
  readonly value: RealtimeVoiceTimestamp;
  readonly milliseconds: number;
} {
  if (typeof value !== "string") {
    fail(path, "must be an RFC 3339 UTC timestamp with at most millisecond precision");
  }
  const match = UTC_TIMESTAMP.exec(value);
  if (match === null) {
    fail(path, "must be an RFC 3339 UTC timestamp with at most millisecond precision");
  }
  const milliseconds = Date.parse(value);
  const parsed = new Date(milliseconds);
  if (
    !Number.isFinite(milliseconds) ||
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCHours() !== Number(match[4]) ||
    parsed.getUTCMinutes() !== Number(match[5]) ||
    parsed.getUTCSeconds() !== Number(match[6])
  ) {
    fail(path, "must be a canonical valid UTC timestamp");
  }
  return { value: parsed.toISOString() as RealtimeVoiceTimestamp, milliseconds };
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function parseAudioConfiguration(
  value: unknown,
  path: string,
): RealtimeVoiceAudioConfiguration {
  const source = record(value, path);
  exactFields(source, ["encoding", "sample_rate_hz", "channels"], [], path);
  if (!REALTIME_VOICE_AUDIO_ENCODINGS.includes(source.encoding as RealtimeVoiceAudioEncoding)) {
    fail(`${path}.encoding`, `must be one of: ${REALTIME_VOICE_AUDIO_ENCODINGS.join(", ")}`);
  }
  const channels = integer(
    source.channels,
    `${path}.channels`,
    1,
    REALTIME_VOICE_LIMITS.maximumChannels,
  );
  return Object.freeze({
    encoding: source.encoding as RealtimeVoiceAudioEncoding,
    sample_rate_hz: integer(
      source.sample_rate_hz,
      `${path}.sample_rate_hz`,
      REALTIME_VOICE_LIMITS.minimumSampleRateHz,
      REALTIME_VOICE_LIMITS.maximumSampleRateHz,
    ),
    channels: channels as 1 | 2,
  });
}

export function parseRealtimeVoiceSessionConfiguration(
  value: unknown,
): RealtimeVoiceSessionConfiguration {
  return parseSessionConfiguration(value, "$configuration");
}

function parseSessionConfiguration(
  value: unknown,
  path: string,
): RealtimeVoiceSessionConfiguration {
  const source = record(value, path);
  exactFields(source, [
    "transport",
    "maximum_duration_ms",
    "idle_timeout_ms",
    "input_audio",
    "output_audio",
  ], [], path);
  if (source.transport !== "webrtc") fail(`${path}.transport`, 'must equal "webrtc"');
  const maximumDuration = integer(
    source.maximum_duration_ms,
    `${path}.maximum_duration_ms`,
    REALTIME_VOICE_LIMITS.minimumSessionDurationMs,
    REALTIME_VOICE_LIMITS.maximumSessionDurationMs,
  );
  const idleTimeout = integer(
    source.idle_timeout_ms,
    `${path}.idle_timeout_ms`,
    REALTIME_VOICE_LIMITS.minimumIdleTimeoutMs,
    REALTIME_VOICE_LIMITS.maximumIdleTimeoutMs,
  );
  if (idleTimeout >= maximumDuration) {
    fail(`${path}.idle_timeout_ms`, "must be less than maximum_duration_ms");
  }
  const inputAudio = source.input_audio === null
    ? null
    : parseAudioConfiguration(source.input_audio, `${path}.input_audio`);
  const outputAudio = source.output_audio === null
    ? null
    : parseAudioConfiguration(source.output_audio, `${path}.output_audio`);
  if (inputAudio === null && outputAudio === null) {
    fail(path, "must configure input_audio or output_audio");
  }
  return Object.freeze({
    transport: "webrtc",
    maximum_duration_ms: maximumDuration,
    idle_timeout_ms: idleTimeout,
    input_audio: inputAudio,
    output_audio: outputAudio,
  });
}

function capabilityReference(
  value: unknown,
  path: string,
): RealtimeVoiceServerToolCapabilityReference {
  const parsed = boundedString(
    value,
    path,
    REALTIME_VOICE_LIMITS.capabilityReferenceLength,
  );
  if (!OPAQUE_VALUE.test(parsed)) fail(path, "must be an opaque capability reference");
  return parsed as RealtimeVoiceServerToolCapabilityReference;
}

export function parseRealtimeVoiceRequestedCapabilities(
  value: unknown,
): RealtimeVoiceRequestedCapabilities {
  return parseRequestedCapabilities(value, "$requested_capabilities");
}

function parseRequestedCapabilities(
  value: unknown,
  path: string,
): RealtimeVoiceRequestedCapabilities {
  const source = record(value, path);
  exactFields(source, [
    "input_audio",
    "output_audio",
    "interruption",
    "server_tool_execution",
  ], [], path);
  const serverToolExecution = source.server_tool_execution === false
    ? false
    : (() => {
        const serverTool = record(
          source.server_tool_execution,
          `${path}.server_tool_execution`,
        );
        exactFields(serverTool, ["capability_ref"], [], `${path}.server_tool_execution`);
        return Object.freeze({
          capability_ref: capabilityReference(
            serverTool.capability_ref,
            `${path}.server_tool_execution.capability_ref`,
          ),
        });
      })();
  return Object.freeze({
    input_audio: boolean(source.input_audio, `${path}.input_audio`),
    output_audio: boolean(source.output_audio, `${path}.output_audio`),
    interruption: boolean(source.interruption, `${path}.interruption`),
    server_tool_execution: serverToolExecution,
  });
}

function validateRequestedAudio(
  configuration: RealtimeVoiceSessionConfiguration,
  requested: RealtimeVoiceRequestedCapabilities,
  path: string,
): void {
  if (requested.input_audio !== (configuration.input_audio !== null)) {
    fail(`${path}.input_audio`, "must match whether configuration.input_audio is present");
  }
  if (requested.output_audio !== (configuration.output_audio !== null)) {
    fail(`${path}.output_audio`, "must match whether configuration.output_audio is present");
  }
}

export function parseRealtimeVoiceBootstrapRequest(
  value: unknown,
): RealtimeVoiceBootstrapRequest {
  const path = "$bootstrap_request";
  const source = record(value, path);
  exactFields(source, [
    "version",
    "request_id",
    "idempotency_key",
    "configuration",
    "requested_capabilities",
  ], [], path);
  if (source.version !== REALTIME_VOICE_CONTRACT_VERSION) {
    fail(`${path}.version`, `must equal ${REALTIME_VOICE_CONTRACT_VERSION}`);
  }
  const idempotencyKey = boundedString(
    source.idempotency_key,
    `${path}.idempotency_key`,
    REALTIME_VOICE_LIMITS.idempotencyKeyLength,
  );
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
    fail(`${path}.idempotency_key`, "must use letters, numbers, dots, underscores, colons, or hyphens");
  }
  const configuration = parseSessionConfiguration(source.configuration, `${path}.configuration`);
  const requestedCapabilities = parseRequestedCapabilities(
    source.requested_capabilities,
    `${path}.requested_capabilities`,
  );
  validateRequestedAudio(configuration, requestedCapabilities, `${path}.requested_capabilities`);
  return Object.freeze({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    request_id: identifier<RealtimeVoiceRequestId>(source.request_id, `${path}.request_id`),
    idempotency_key: idempotencyKey as RealtimeVoiceIdempotencyKey,
    configuration,
    requested_capabilities: requestedCapabilities,
  });
}

function parseUnsupportedCapability(
  source: UnknownRecord,
  path: string,
): RealtimeVoiceUnsupportedCapability {
  exactFields(source, ["supported", "reason"], [], path);
  if (!REALTIME_VOICE_UNSUPPORTED_REASONS.includes(
    source.reason as RealtimeVoiceUnsupportedReason,
  )) {
    fail(`${path}.reason`, `must be one of: ${REALTIME_VOICE_UNSUPPORTED_REASONS.join(", ")}`);
  }
  return Object.freeze({
    supported: false,
    reason: source.reason as RealtimeVoiceUnsupportedReason,
  });
}

function parseCapability(value: unknown, path: string): RealtimeVoiceCapabilityDescriptor {
  const source = record(value, path);
  if (source.supported === true) {
    exactFields(source, ["supported"], [], path);
    return Object.freeze({ supported: true });
  }
  if (source.supported === false) return parseUnsupportedCapability(source, path);
  fail(`${path}.supported`, "must be a boolean discriminant");
}

function parseServerToolCapability(
  value: unknown,
  path: string,
): RealtimeVoiceServerToolCapabilityDescriptor {
  const source = record(value, path);
  if (source.supported === true) {
    exactFields(source, ["supported", "capability_ref"], [], path);
    return Object.freeze({
      supported: true,
      capability_ref: capabilityReference(source.capability_ref, `${path}.capability_ref`),
    });
  }
  if (source.supported === false) return parseUnsupportedCapability(source, path);
  fail(`${path}.supported`, "must be a boolean discriminant");
}

export function parseRealtimeVoiceCapabilities(value: unknown): RealtimeVoiceCapabilities {
  return parseCapabilities(value, "$capabilities");
}

function parseCapabilities(value: unknown, path: string): RealtimeVoiceCapabilities {
  const source = record(value, path);
  exactFields(source, [
    "input_audio",
    "output_audio",
    "interruption",
    "server_tool_execution",
  ], [], path);
  return Object.freeze({
    input_audio: parseCapability(source.input_audio, `${path}.input_audio`),
    output_audio: parseCapability(source.output_audio, `${path}.output_audio`),
    interruption: parseCapability(source.interruption, `${path}.interruption`),
    server_tool_execution: parseServerToolCapability(
      source.server_tool_execution,
      `${path}.server_tool_execution`,
    ),
  });
}

function unsupported(reason: RealtimeVoiceUnsupportedReason): RealtimeVoiceUnsupportedCapability {
  return Object.freeze({ supported: false, reason });
}

/**
 * Narrows an offered capability set to exactly what was requested. This helper
 * can only remove authority; it never changes or invents a server-tool scope.
 */
export function narrowRealtimeVoiceCapabilities(
  requestedValue: unknown,
  offeredValue: unknown,
): RealtimeVoiceCapabilities {
  const requested = parseRealtimeVoiceRequestedCapabilities(requestedValue);
  const offered = parseRealtimeVoiceCapabilities(offeredValue);
  const narrow = (
    wasRequested: boolean,
    capability: RealtimeVoiceCapabilityDescriptor,
  ): RealtimeVoiceCapabilityDescriptor => wasRequested
    ? capability
    : unsupported("not_requested");

  let serverTool: RealtimeVoiceServerToolCapabilityDescriptor;
  if (requested.server_tool_execution === false) {
    serverTool = unsupported("not_requested");
  } else if (!offered.server_tool_execution.supported) {
    serverTool = offered.server_tool_execution;
  } else if (
    offered.server_tool_execution.capability_ref !==
    requested.server_tool_execution.capability_ref
  ) {
    fail(
      "$offered.server_tool_execution.capability_ref",
      "must exactly match the requested opaque capability reference",
    );
  } else {
    serverTool = offered.server_tool_execution;
  }

  return Object.freeze({
    input_audio: narrow(requested.input_audio, offered.input_audio),
    output_audio: narrow(requested.output_audio, offered.output_audio),
    interruption: narrow(requested.interruption, offered.interruption),
    server_tool_execution: serverTool,
  });
}

function parseAuthorization(
  value: unknown,
  path: string,
): RealtimeVoiceClientAuthorization {
  const source = record(value, path);
  exactFields(source, ["kind", "value", "expires_at"], [], path);
  if (source.kind !== "opaque_ephemeral") {
    fail(`${path}.kind`, 'must equal "opaque_ephemeral"');
  }
  const authorization = boundedString(
    source.value,
    `${path}.value`,
    REALTIME_VOICE_LIMITS.authorizationLength,
  );
  if (!AUTHORIZATION_VALUE.test(authorization)) {
    fail(`${path}.value`, "must be an opaque authorization value");
  }
  return Object.freeze({
    kind: "opaque_ephemeral",
    value: authorization as RealtimeVoiceClientAuthorizationValue,
    expires_at: timestamp(source.expires_at, `${path}.expires_at`).value,
  });
}

function parseConnection(value: unknown, path: string): RealtimeVoiceClientConnection {
  const source = record(value, path);
  exactFields(source, ["transport", "reference"], [], path);
  if (source.transport !== "webrtc") fail(`${path}.transport`, 'must equal "webrtc"');
  const reference = boundedString(
    source.reference,
    `${path}.reference`,
    REALTIME_VOICE_LIMITS.connectionReferenceLength,
  );
  if (!OPAQUE_VALUE.test(reference)) fail(`${path}.reference`, "must be opaque connection data");
  return Object.freeze({
    transport: "webrtc",
    reference: reference as RealtimeVoiceConnectionReference,
  });
}

export interface ParseRealtimeVoiceBootstrapResultOptions {
  readonly request?: RealtimeVoiceBootstrapRequest;
  /** Unix epoch milliseconds. Defaults to Date.now(). */
  readonly now?: number;
}

export function parseRealtimeVoiceBootstrapResult(
  value: unknown,
  options: ParseRealtimeVoiceBootstrapResultOptions = {},
): RealtimeVoiceBootstrapResult {
  const path = "$bootstrap_result";
  const source = record(value, path);
  exactFields(source, [
    "version",
    "request_id",
    "session_id",
    "issued_at",
    "expires_at",
    "authorization",
    "connection",
    "configuration",
    "capabilities",
  ], [], path);
  if (source.version !== REALTIME_VOICE_CONTRACT_VERSION) {
    fail(`${path}.version`, `must equal ${REALTIME_VOICE_CONTRACT_VERSION}`);
  }
  const requestId = identifier<RealtimeVoiceRequestId>(source.request_id, `${path}.request_id`);
  const issuedAt = timestamp(source.issued_at, `${path}.issued_at`);
  const expiresAt = timestamp(source.expires_at, `${path}.expires_at`);
  const authorization = parseAuthorization(source.authorization, `${path}.authorization`);
  const authorizationExpiresAt = timestamp(
    authorization.expires_at,
    `${path}.authorization.expires_at`,
  );
  const configuration = parseSessionConfiguration(source.configuration, `${path}.configuration`);
  const parsedCapabilities = parseCapabilities(source.capabilities, `${path}.capabilities`);
  const capabilities = options.request === undefined
    ? parsedCapabilities
    : narrowRealtimeVoiceCapabilities(
        options.request.requested_capabilities,
        parsedCapabilities,
      );

  if (options.request !== undefined && requestId !== options.request.request_id) {
    fail(`${path}.request_id`, "must match the bootstrap request");
  }
  if (expiresAt.milliseconds <= issuedAt.milliseconds) {
    fail(`${path}.expires_at`, "must be after issued_at");
  }
  if (
    expiresAt.milliseconds - issuedAt.milliseconds >
    configuration.maximum_duration_ms
  ) {
    fail(`${path}.expires_at`, "exceeds configuration.maximum_duration_ms");
  }
  const authorizationTtl = authorizationExpiresAt.milliseconds - issuedAt.milliseconds;
  if (
    authorizationTtl <= 0 ||
    authorizationTtl > REALTIME_VOICE_LIMITS.maximumAuthorizationTtlMs ||
    authorizationExpiresAt.milliseconds > expiresAt.milliseconds
  ) {
    fail(
      `${path}.authorization.expires_at`,
      `must be short-lived (at most ${REALTIME_VOICE_LIMITS.maximumAuthorizationTtlMs}ms) and within the session lifetime`,
    );
  }
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) fail("$options.now", "must be a finite epoch timestamp");
  if (authorizationExpiresAt.milliseconds <= now) {
    fail(`${path}.authorization.expires_at`, "must not be expired");
  }

  if (options.request !== undefined) {
    const requestedConfiguration = options.request.configuration;
    if (
      configuration.transport !== requestedConfiguration.transport ||
      configuration.maximum_duration_ms > requestedConfiguration.maximum_duration_ms ||
      configuration.idle_timeout_ms > requestedConfiguration.idle_timeout_ms ||
      JSON.stringify(configuration.input_audio) !== JSON.stringify(requestedConfiguration.input_audio) ||
      JSON.stringify(configuration.output_audio) !== JSON.stringify(requestedConfiguration.output_audio)
    ) {
      fail(`${path}.configuration`, "must only narrow the requested configuration");
    }
  }

  return Object.freeze({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    request_id: requestId,
    session_id: identifier<RealtimeVoiceSessionId>(source.session_id, `${path}.session_id`),
    issued_at: issuedAt.value,
    expires_at: expiresAt.value,
    authorization,
    connection: parseConnection(source.connection, `${path}.connection`),
    configuration,
    capabilities,
  });
}

export function realtimeVoiceSafeError(code: RealtimeVoiceErrorCode): RealtimeVoiceSafeError {
  return Object.freeze({ code, ...SAFE_ERRORS[code] });
}

export function parseRealtimeVoiceSafeError(value: unknown): RealtimeVoiceSafeError {
  const path = "$error";
  const source = record(value, path);
  exactFields(source, ["code", "message", "retryable"], [], path);
  if (!REALTIME_VOICE_ERROR_CODES.includes(source.code as RealtimeVoiceErrorCode)) {
    fail(`${path}.code`, `must be one of: ${REALTIME_VOICE_ERROR_CODES.join(", ")}`);
  }
  const expected = realtimeVoiceSafeError(source.code as RealtimeVoiceErrorCode);
  if (source.message !== expected.message || source.retryable !== expected.retryable) {
    fail(path, "must use the fixed safe message and retryability for its code");
  }
  return expected;
}

export function normalizeRealtimeVoiceError(
  error: unknown,
  signal?: AbortSignal,
): RealtimeVoiceSafeError {
  if (signal?.aborted) return realtimeVoiceSafeError("cancelled");
  if (error instanceof RealtimeVoiceOperationError) {
    return realtimeVoiceSafeError(error.code);
  }
  try {
    return parseRealtimeVoiceSafeError(error);
  } catch {
    return realtimeVoiceSafeError("internal_failure");
  }
}

const EVENT_TYPES = new Set([
  "session_started",
  "response_started",
  "response_interrupted",
  "local_media_stopped",
  "hangup_started",
  "session_ended",
  "session_failed",
]);

export function parseRealtimeVoiceSessionEvent(value: unknown): RealtimeVoiceSessionEvent {
  const path = "$event";
  const source = record(value, path);
  if (!EVENT_TYPES.has(source.type as string)) fail(`${path}.type`, "is not supported");
  const isFailure = source.type === "session_failed";
  exactFields(source, [
    "version",
    "session_id",
    "event_id",
    "sequence",
    "occurred_at",
    "type",
    ...(isFailure ? ["error"] : []),
  ], [], path);
  if (source.version !== REALTIME_VOICE_CONTRACT_VERSION) {
    fail(`${path}.version`, `must equal ${REALTIME_VOICE_CONTRACT_VERSION}`);
  }
  const base = {
    version: REALTIME_VOICE_CONTRACT_VERSION,
    session_id: identifier<RealtimeVoiceSessionId>(source.session_id, `${path}.session_id`),
    event_id: identifier<RealtimeVoiceEventId>(source.event_id, `${path}.event_id`),
    sequence: integer(source.sequence, `${path}.sequence`, 1, Number.MAX_SAFE_INTEGER),
    occurred_at: timestamp(source.occurred_at, `${path}.occurred_at`).value,
  } as const;
  if (isFailure) {
    return Object.freeze({
      ...base,
      type: "session_failed",
      error: parseRealtimeVoiceSafeError(source.error),
    });
  }
  return Object.freeze({ ...base, type: source.type }) as RealtimeVoiceSessionEvent;
}

export function createRealtimeVoiceSessionState(
  bootstrapValue: unknown,
  options: ParseRealtimeVoiceBootstrapResultOptions = {},
): RealtimeVoiceSessionState {
  const bootstrap = parseRealtimeVoiceBootstrapResult(bootstrapValue, options);
  return Object.freeze({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    session_id: bootstrap.session_id,
    status: "ready",
    configuration: bootstrap.configuration,
    capabilities: bootstrap.capabilities,
    local_media: "active",
    response_active: false,
    last_event_sequence: 0,
    recent_event_ids: Object.freeze([]),
    error: null,
  });
}

function rememberEvent(
  state: RealtimeVoiceSessionState,
  event: RealtimeVoiceSessionEvent,
): Pick<RealtimeVoiceSessionState, "last_event_sequence" | "recent_event_ids"> {
  return {
    last_event_sequence: event.sequence,
    recent_event_ids: Object.freeze([
      ...state.recent_event_ids,
      event.event_id,
    ].slice(-REALTIME_VOICE_LIMITS.trackedEventIds)),
  };
}

function transitionPatch(
  state: RealtimeVoiceSessionState,
  event: RealtimeVoiceSessionEvent,
): Partial<RealtimeVoiceSessionState> {
  if (state.status === "ended" || state.status === "failed") {
    throw new RealtimeVoiceTransitionError();
  }
  switch (event.type) {
    case "session_started":
      if (state.status !== "ready") throw new RealtimeVoiceTransitionError();
      return { status: "active" };
    case "response_started":
      if (state.status !== "active" || state.response_active) {
        throw new RealtimeVoiceTransitionError();
      }
      return { response_active: true };
    case "response_interrupted":
      if (state.status !== "active" || !state.response_active) {
        throw new RealtimeVoiceTransitionError();
      }
      return { response_active: false };
    case "local_media_stopped":
      if (state.local_media === "stopped") throw new RealtimeVoiceTransitionError();
      return { local_media: "stopped" };
    case "hangup_started":
      if (state.status === "ending") throw new RealtimeVoiceTransitionError();
      return { status: "ending", response_active: false };
    case "session_ended":
      return {
        status: "ended",
        local_media: "stopped",
        response_active: false,
        error: null,
      };
    case "session_failed":
      return {
        status: "failed",
        local_media: "stopped",
        response_active: false,
        error: event.error,
      };
  }
}

/** Duplicate or stale sequence numbers are deterministic no-ops. */
export function applyRealtimeVoiceSessionEvent(
  state: RealtimeVoiceSessionState,
  eventValue: unknown,
): RealtimeVoiceSessionState {
  const event = parseRealtimeVoiceSessionEvent(eventValue);
  if (event.session_id !== state.session_id) {
    fail("$event.session_id", "must match the session state");
  }
  if (
    event.sequence <= state.last_event_sequence ||
    state.recent_event_ids.includes(event.event_id)
  ) {
    return state;
  }
  return Object.freeze({
    ...state,
    ...transitionPatch(state, event),
    ...rememberEvent(state, event),
  });
}

export function parseRealtimeVoiceSessionState(value: unknown): RealtimeVoiceSessionState {
  const path = "$state";
  const source = record(value, path);
  exactFields(source, [
    "version",
    "session_id",
    "status",
    "configuration",
    "capabilities",
    "local_media",
    "response_active",
    "last_event_sequence",
    "recent_event_ids",
    "error",
  ], [], path);
  if (source.version !== REALTIME_VOICE_CONTRACT_VERSION) {
    fail(`${path}.version`, `must equal ${REALTIME_VOICE_CONTRACT_VERSION}`);
  }
  if (!["ready", "active", "ending", "ended", "failed"].includes(source.status as string)) {
    fail(`${path}.status`, "is not supported");
  }
  if (source.local_media !== "active" && source.local_media !== "stopped") {
    fail(`${path}.local_media`, 'must equal "active" or "stopped"');
  }
  if (!Array.isArray(source.recent_event_ids) ||
      source.recent_event_ids.length > REALTIME_VOICE_LIMITS.trackedEventIds) {
    fail(`${path}.recent_event_ids`, `must contain at most ${REALTIME_VOICE_LIMITS.trackedEventIds} items`);
  }
  const recentEventIds = source.recent_event_ids.map((eventId, index) =>
    identifier<RealtimeVoiceEventId>(eventId, `${path}.recent_event_ids[${index}]`));
  if (new Set(recentEventIds).size !== recentEventIds.length) {
    fail(`${path}.recent_event_ids`, "must not contain duplicates");
  }
  return Object.freeze({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    session_id: identifier<RealtimeVoiceSessionId>(source.session_id, `${path}.session_id`),
    status: source.status as RealtimeVoiceSessionState["status"],
    configuration: parseSessionConfiguration(source.configuration, `${path}.configuration`),
    capabilities: parseCapabilities(source.capabilities, `${path}.capabilities`),
    local_media: source.local_media,
    response_active: boolean(source.response_active, `${path}.response_active`),
    last_event_sequence: integer(
      source.last_event_sequence,
      `${path}.last_event_sequence`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    recent_event_ids: Object.freeze(recentEventIds),
    error: source.error === null ? null : parseRealtimeVoiceSafeError(source.error),
  });
}

export function assertRealtimeVoiceAbortSignal(value: unknown, path = "$signal"): asserts value is AbortSignal {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as AbortSignal).aborted !== "boolean" ||
    typeof (value as AbortSignal).addEventListener !== "function" ||
    typeof (value as AbortSignal).removeEventListener !== "function" ||
    typeof (value as AbortSignal).throwIfAborted !== "function"
  ) {
    fail(path, "must be an AbortSignal");
  }
}

export function throwIfRealtimeVoiceAborted(signal: AbortSignal): void {
  assertRealtimeVoiceAbortSignal(signal);
  if (signal.aborted) throw new RealtimeVoiceOperationError("cancelled");
}
