import {
  parseToolDefinition,
  type GenerationSettings,
  type JsonObject,
  type ToolDefinition,
} from "./protocol.js";

/** Provider-context checkpoints accelerate provider input only; canonical history remains authoritative. */
export const PROVIDER_CONTEXT_CONTRACT_VERSION =
  "handrail.provider-context.v1" as const;
export const PROVIDER_CONTEXT_CHECKPOINT_VERSION = 1 as const;

export const PROVIDER_CONTEXT_UNSUPPORTED_REASONS = Object.freeze([
  "provider_not_supported",
  "model_not_supported",
  "compaction_not_configured",
] as const);

export const PROVIDER_CONTEXT_INVALIDATION_REASONS = Object.freeze([
  "context_fingerprint_changed",
  "canonical_history_changed",
  "canonical_history_rewound",
  "checkpoint_expired",
  "checkpoint_rejected",
  "checkpoint_corrupt",
  "version_unsupported",
] as const);

export const PROVIDER_CONTEXT_ERROR_CODES = Object.freeze([
  "invalid_request",
  "idempotency_conflict",
  "cancelled",
  "deadline_exceeded",
  "provider_unavailable",
  "internal_failure",
] as const);

export const PROVIDER_CONTEXT_LIMITS = Object.freeze({
  identifierLength: 256,
  instructions: 32,
  instructionLength: 100_000,
  tools: 256,
  providerSettingDepth: 8,
  providerSettingNodes: 1_024,
  providerSettingObjectKeys: 128,
  providerSettingArrayLength: 128,
  providerSettingKeyLength: 128,
  providerSettingStringLength: 4_096,
  providerSettingsSerializedBytes: 32_768,
  fingerprintSerializedBytes: 2_097_152,
  checkpointOpaqueStateLength: 65_536,
  checkpointSerializedBytes: 70_000,
  idempotencyKeyLength: 128,
  safeErrorMessageLength: 160,
  maximumTokenCount: Number.MAX_SAFE_INTEGER,
} as const);

declare const providerContextOpaque: unique symbol;
type OpaqueString<Name extends string> = string & {
  readonly [providerContextOpaque]: Name;
};

export type ProviderContextFingerprint = OpaqueString<"ProviderContextFingerprint">;
export type ProviderContextIdempotencyKey = OpaqueString<"ProviderContextIdempotencyKey">;
export type ProviderContextUnsupportedReason =
  (typeof PROVIDER_CONTEXT_UNSUPPORTED_REASONS)[number];
export type ProviderContextInvalidationReason =
  (typeof PROVIDER_CONTEXT_INVALIDATION_REASONS)[number];
export type ProviderContextErrorCode =
  (typeof PROVIDER_CONTEXT_ERROR_CODES)[number];

export interface ProviderContextModelIdentity {
  readonly provider_id: string;
  readonly model_id: string;
}

/** Ephemeral inputs are normalized only while hashing and are never returned or retained. */
export interface ProviderContextFingerprintInput {
  readonly model: ProviderContextModelIdentity;
  readonly instructions: readonly string[];
  readonly tools: readonly ToolDefinition[];
  readonly generation: GenerationSettings;
  readonly provider_settings?: JsonObject;
}

/** A durable position in canonical conversation history. Revision zero identifies an empty history. */
export interface ProviderContextHistoryPosition {
  readonly conversation_id: string;
  readonly revision: number;
  readonly event_id: string | null;
}

/**
 * Bounded durable provider acceleration data.
 *
 * `opaque_state` is a provider-issued base64url value, not a place for prompts,
 * instructions, tools, results, credentials, or native request/response objects.
 * Hosts must retain canonical conversation history independently and may always
 * discard this record without losing conversation meaning.
 */
export interface ProviderContextCheckpoint {
  readonly version: typeof PROVIDER_CONTEXT_CHECKPOINT_VERSION;
  readonly provider_id: string;
  readonly checkpoint_id: string;
  readonly format: string;
  readonly opaque_state: string;
  readonly context_fingerprint: ProviderContextFingerprint;
  readonly history_position: ProviderContextHistoryPosition;
}

export interface ProviderContextMeasurementResult {
  readonly status: "measured";
  readonly context_fingerprint: ProviderContextFingerprint;
  readonly history_position: ProviderContextHistoryPosition;
  readonly input_tokens: number;
  readonly context_window_tokens: number | null;
}

export interface ProviderContextMeasurementRequest<TProviderInput = unknown> {
  /** Ephemeral provider input. Implementations must not persist it in a checkpoint. */
  readonly input: TProviderInput;
  readonly context_fingerprint: ProviderContextFingerprint;
  readonly history_position: ProviderContextHistoryPosition;
  readonly checkpoint: ProviderContextCheckpoint | null;
  readonly signal: AbortSignal;
}

export interface ProviderContextCompactionRequest<TProviderInput = unknown>
  extends ProviderContextMeasurementRequest<TProviderInput> {
  readonly idempotency_key: ProviderContextIdempotencyKey;
  readonly target_input_tokens: number;
}

export interface ProviderContextCompactedResult {
  readonly status: "compacted";
  readonly checkpoint: ProviderContextCheckpoint;
  readonly measurement: ProviderContextMeasurementResult;
}

export interface ProviderContextUnchangedResult {
  readonly status: "unchanged";
  readonly checkpoint: ProviderContextCheckpoint | null;
  readonly measurement: ProviderContextMeasurementResult;
}

export interface ProviderContextInvalidatedResult {
  readonly status: "invalidated";
  readonly reason: ProviderContextInvalidationReason;
  readonly context_fingerprint: ProviderContextFingerprint;
  readonly history_position: ProviderContextHistoryPosition;
}

export type ProviderContextCompactionResult =
  | ProviderContextCompactedResult
  | ProviderContextUnchangedResult
  | ProviderContextInvalidatedResult;

export type ProviderContextCheckpointAssessment =
  | { readonly valid: true; readonly checkpoint: ProviderContextCheckpoint }
  | { readonly valid: false; readonly reason: ProviderContextInvalidationReason };

export interface SupportedProviderContextCapability<TProviderInput = unknown> {
  readonly supported: true;
  readonly version: typeof PROVIDER_CONTEXT_CONTRACT_VERSION;
  measure(
    request: ProviderContextMeasurementRequest<TProviderInput>,
  ): Promise<ProviderContextMeasurementResult>;
  compact(
    request: ProviderContextCompactionRequest<TProviderInput>,
  ): Promise<ProviderContextCompactionResult>;
}

export interface UnsupportedProviderContextCapability {
  readonly supported: false;
  readonly reason: ProviderContextUnsupportedReason;
}

/** Canonical declaration for providers that do not implement provider-context operations. */
export const PROVIDER_CONTEXT_NOT_SUPPORTED = Object.freeze({
  supported: false,
  reason: "provider_not_supported",
} as const) satisfies UnsupportedProviderContextCapability;

export type ProviderContextCapabilityDescriptor =
  | Pick<SupportedProviderContextCapability<never>, "supported" | "version">
  | UnsupportedProviderContextCapability;

/** Optional capability; this contract does not assign support to any provider. */
export type ProviderContextCapability<TProviderInput = unknown> =
  | SupportedProviderContextCapability<TProviderInput>
  | UnsupportedProviderContextCapability;

export interface ProviderContextSafeError {
  readonly code: ProviderContextErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export class ProviderContextValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ProviderContextValidationError";
    this.path = path;
  }
}

/** An adapter may throw this without exposing a native error or sensitive cause. */
export class ProviderContextOperationError extends Error {
  readonly code: ProviderContextErrorCode;

  constructor(code: ProviderContextErrorCode) {
    super(ERROR_DEFINITIONS[code].message);
    this.name = "ProviderContextOperationError";
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_STATE = /^[A-Za-z0-9_-]+={0,2}$/;
const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;
const FORBIDDEN_SETTING_FIELDS = new Set([
  "accesstoken", "apikey", "authorization", "cookie", "credential",
  "credentials", "headers", "input", "instructions", "messages", "output",
  "password", "privatekey", "prompt", "refreshtoken",
  "providerrequest", "providerresponse", "rawrequest", "rawresponse",
  "request", "response", "secret", "systeminstruction", "toolpayload",
  "tooldefinitions", "toolresult", "toolresults", "tools",
]);
const UTF8_ENCODER = new TextEncoder();

const ERROR_DEFINITIONS: Readonly<Record<ProviderContextErrorCode, {
  readonly message: string;
  readonly retryable: boolean;
}>> = Object.freeze({
  invalid_request: { message: "The provider-context request is invalid.", retryable: false },
  idempotency_conflict: { message: "The idempotency key conflicts with another compaction.", retryable: false },
  cancelled: { message: "The provider-context operation was cancelled.", retryable: false },
  deadline_exceeded: { message: "The provider-context operation exceeded its deadline.", retryable: true },
  provider_unavailable: { message: "Provider-context processing is temporarily unavailable.", retryable: true },
  internal_failure: { message: "Provider-context processing failed.", retryable: false },
});

function fail(path: string, message: string): never {
  throw new ProviderContextValidationError(path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) fail(path, "must be a plain JSON object");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "must contain only string-named fields");
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
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

function safeString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length === 0 || value.length > maxLength) {
    fail(path, `must contain 1-${maxLength} characters`);
  }
  if ([...value].some((character) => {
    const point = character.codePointAt(0)!;
    return point <= 0x1f || point === 0x7f;
  })) fail(path, "must not contain control characters");
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    fail(path, "must not contain credential material");
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  const parsed = safeString(value, path, PROVIDER_CONTEXT_LIMITS.identifierLength);
  if (!IDENTIFIER.test(parsed)) fail(path, "must be an opaque identifier");
  return parsed;
}

function finiteInteger(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(path, `must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function parseFingerprint(value: unknown, path: string): ProviderContextFingerprint {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) {
    fail(path, "must be a lowercase sha256 fingerprint");
  }
  return value as ProviderContextFingerprint;
}

export function parseProviderContextHistoryPosition(
  value: unknown,
): ProviderContextHistoryPosition {
  return parseHistoryPosition(value, "$history_position");
}

function parseHistoryPosition(value: unknown, path: string): ProviderContextHistoryPosition {
  const source = record(value, path);
  exactFields(source, ["conversation_id", "revision", "event_id"], [], path);
  const revision = finiteInteger(source.revision, `${path}.revision`, 0);
  const eventId = source.event_id === null
    ? null
    : identifier(source.event_id, `${path}.event_id`);
  if ((revision === 0) !== (eventId === null)) {
    fail(path, "revision zero requires a null event_id and nonzero revisions require an event_id");
  }
  return Object.freeze({
    conversation_id: identifier(source.conversation_id, `${path}.conversation_id`),
    revision,
    event_id: eventId,
  });
}

export function parseProviderContextCheckpoint(value: unknown): ProviderContextCheckpoint {
  const path = "$checkpoint";
  const source = record(value, path);
  exactFields(source, [
    "version", "provider_id", "checkpoint_id", "format", "opaque_state",
    "context_fingerprint", "history_position",
  ], [], path);
  if (source.version !== PROVIDER_CONTEXT_CHECKPOINT_VERSION) {
    fail(`${path}.version`, `must equal ${PROVIDER_CONTEXT_CHECKPOINT_VERSION}`);
  }
  const opaque = safeString(
    source.opaque_state,
    `${path}.opaque_state`,
    PROVIDER_CONTEXT_LIMITS.checkpointOpaqueStateLength,
  );
  if (!OPAQUE_STATE.test(opaque)) {
    fail(`${path}.opaque_state`, "must be a provider-issued base64url value");
  }
  const checkpoint = Object.freeze({
    version: PROVIDER_CONTEXT_CHECKPOINT_VERSION,
    provider_id: identifier(source.provider_id, `${path}.provider_id`),
    checkpoint_id: identifier(source.checkpoint_id, `${path}.checkpoint_id`),
    format: identifier(source.format, `${path}.format`),
    opaque_state: opaque,
    context_fingerprint: parseFingerprint(source.context_fingerprint, `${path}.context_fingerprint`),
    history_position: parseHistoryPosition(source.history_position, `${path}.history_position`),
  });
  if (UTF8_ENCODER.encode(JSON.stringify(checkpoint)).byteLength > PROVIDER_CONTEXT_LIMITS.checkpointSerializedBytes) {
    fail(path, `must serialize to at most ${PROVIDER_CONTEXT_LIMITS.checkpointSerializedBytes} bytes`);
  }
  return checkpoint;
}

/** Validates a host-loaded checkpoint before offering it as optional acceleration. */
export function assessProviderContextCheckpoint(
  value: unknown,
  expected: {
    readonly provider_id: string;
    readonly context_fingerprint: ProviderContextFingerprint;
    readonly history_position: ProviderContextHistoryPosition;
  },
): ProviderContextCheckpointAssessment {
  if (
    value !== null && typeof value === "object" &&
    Object.hasOwn(value, "version") &&
    (value as { readonly version?: unknown }).version !== PROVIDER_CONTEXT_CHECKPOINT_VERSION
  ) {
    return Object.freeze({ valid: false, reason: "version_unsupported" });
  }
  let checkpoint: ProviderContextCheckpoint;
  try {
    checkpoint = parseProviderContextCheckpoint(value);
  } catch {
    return Object.freeze({ valid: false, reason: "checkpoint_corrupt" });
  }
  if (checkpoint.provider_id !== expected.provider_id) {
    return Object.freeze({ valid: false, reason: "checkpoint_rejected" });
  }
  if (checkpoint.context_fingerprint !== expected.context_fingerprint) {
    return Object.freeze({ valid: false, reason: "context_fingerprint_changed" });
  }
  const actual = checkpoint.history_position;
  const desired = expected.history_position;
  if (actual.conversation_id !== desired.conversation_id) {
    return Object.freeze({ valid: false, reason: "canonical_history_changed" });
  }
  if (actual.revision > desired.revision) {
    return Object.freeze({ valid: false, reason: "canonical_history_rewound" });
  }
  if (actual.revision === desired.revision && actual.event_id !== desired.event_id) {
    return Object.freeze({ valid: false, reason: "canonical_history_changed" });
  }
  return Object.freeze({ valid: true, checkpoint });
}

export function parseProviderContextMeasurementResult(
  value: unknown,
): ProviderContextMeasurementResult {
  return parseMeasurement(value, "$measurement");
}

export function parseProviderContextCapabilityDescriptor(
  value: unknown,
): ProviderContextCapabilityDescriptor {
  const path = "$capability";
  const source = record(value, path);
  if (source.supported === true) {
    exactFields(source, ["supported", "version"], [], path);
    if (source.version !== PROVIDER_CONTEXT_CONTRACT_VERSION) {
      fail(`${path}.version`, `must equal ${PROVIDER_CONTEXT_CONTRACT_VERSION}`);
    }
    return Object.freeze({ supported: true, version: PROVIDER_CONTEXT_CONTRACT_VERSION });
  }
  if (source.supported === false) {
    exactFields(source, ["supported", "reason"], [], path);
    if (!PROVIDER_CONTEXT_UNSUPPORTED_REASONS.includes(source.reason as ProviderContextUnsupportedReason)) {
      fail(`${path}.reason`, `must be one of: ${PROVIDER_CONTEXT_UNSUPPORTED_REASONS.join(", ")}`);
    }
    return Object.freeze({ supported: false, reason: source.reason as ProviderContextUnsupportedReason });
  }
  fail(`${path}.supported`, "must be a boolean discriminant");
}

/** Projects and validates the serializable descriptor for an operational capability. */
export function describeProviderContextCapability(
  capability: ProviderContextCapability,
): ProviderContextCapabilityDescriptor {
  if (capability.supported) {
    if (
      typeof capability.measure !== "function" ||
      typeof capability.compact !== "function"
    ) {
      fail("$capability", "supported operations must provide measure and compact functions");
    }
    return parseProviderContextCapabilityDescriptor({
      supported: true,
      version: capability.version,
    });
  }
  return parseProviderContextCapabilityDescriptor(capability);
}

function parseMeasurement(value: unknown, path: string): ProviderContextMeasurementResult {
  const source = record(value, path);
  exactFields(source, [
    "status", "context_fingerprint", "history_position", "input_tokens",
    "context_window_tokens",
  ], [], path);
  if (source.status !== "measured") fail(`${path}.status`, 'must equal "measured"');
  const contextWindow = source.context_window_tokens === null
    ? null
    : finiteInteger(source.context_window_tokens, `${path}.context_window_tokens`, 1);
  const inputTokens = finiteInteger(source.input_tokens, `${path}.input_tokens`, 0);
  return Object.freeze({
    status: "measured",
    context_fingerprint: parseFingerprint(source.context_fingerprint, `${path}.context_fingerprint`),
    history_position: parseHistoryPosition(source.history_position, `${path}.history_position`),
    input_tokens: inputTokens,
    context_window_tokens: contextWindow,
  });
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === "object" &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function" &&
    typeof (value as AbortSignal).throwIfAborted === "function";
}

function parseRequestBase<TProviderInput>(
  value: unknown,
  path: string,
  extraFields: readonly string[],
  parseInput: (value: unknown) => TProviderInput,
): {
  readonly request: ProviderContextMeasurementRequest<TProviderInput>;
  readonly source: UnknownRecord;
} {
  const source = record(value, path);
  exactFields(source, [
    "input", "context_fingerprint", "history_position", "checkpoint", "signal",
    ...extraFields,
  ], [], path);
  if (!isAbortSignal(source.signal)) fail(`${path}.signal`, "must be an AbortSignal");
  const historyPosition = parseHistoryPosition(source.history_position, `${path}.history_position`);
  const contextFingerprint = parseFingerprint(source.context_fingerprint, `${path}.context_fingerprint`);
  const checkpoint = source.checkpoint === null ? null : parseProviderContextCheckpoint(source.checkpoint);
  if (checkpoint !== null && (
    checkpoint.context_fingerprint !== contextFingerprint ||
    checkpoint.history_position.conversation_id !== historyPosition.conversation_id ||
    checkpoint.history_position.revision > historyPosition.revision ||
    (checkpoint.history_position.revision === historyPosition.revision &&
      checkpoint.history_position.event_id !== historyPosition.event_id)
  )) {
    fail(`${path}.checkpoint`, "does not match this context or canonical-history position");
  }
  return {
    request: {
      input: parseInput(source.input),
      context_fingerprint: contextFingerprint,
      history_position: historyPosition,
      checkpoint,
      signal: source.signal,
    },
    source,
  };
}

export function parseProviderContextMeasurementRequest<TProviderInput>(
  value: unknown,
  parseInput: (value: unknown) => TProviderInput,
): ProviderContextMeasurementRequest<TProviderInput> {
  const parsed = parseRequestBase(value, "$measurement_request", [], parseInput);
  return Object.freeze(parsed.request);
}

export function parseProviderContextIdempotencyKey(
  value: unknown,
): ProviderContextIdempotencyKey {
  const parsed = safeString(value, "$idempotency_key", PROVIDER_CONTEXT_LIMITS.idempotencyKeyLength);
  if (!IDEMPOTENCY_KEY.test(parsed)) {
    fail("$idempotency_key", "must use letters, numbers, dots, underscores, colons, or hyphens");
  }
  return parsed as ProviderContextIdempotencyKey;
}

export function parseProviderContextCompactionRequest<TProviderInput>(
  value: unknown,
  parseInput: (value: unknown) => TProviderInput,
): ProviderContextCompactionRequest<TProviderInput> {
  const parsed = parseRequestBase(
    value,
    "$compaction_request",
    ["idempotency_key", "target_input_tokens"],
    parseInput,
  );
  return Object.freeze({
    ...parsed.request,
    idempotency_key: parseProviderContextIdempotencyKey(parsed.source.idempotency_key),
    target_input_tokens: finiteInteger(parsed.source.target_input_tokens, "$compaction_request.target_input_tokens", 1),
  });
}

export function parseProviderContextCompactionResult(
  value: unknown,
): ProviderContextCompactionResult {
  const path = "$compaction_result";
  const source = record(value, path);
  if (source.status === "compacted" || source.status === "unchanged") {
    exactFields(source, ["status", "checkpoint", "measurement"], [], path);
    const checkpoint = source.checkpoint === null
      ? null
      : parseProviderContextCheckpoint(source.checkpoint);
    if (source.status === "compacted" && checkpoint === null) {
      fail(`${path}.checkpoint`, "must be present for a compacted result");
    }
    const measurement = parseMeasurement(source.measurement, `${path}.measurement`);
    const checkpointPosition = checkpoint?.history_position;
    const measurementPosition = measurement.history_position;
    const invalidCheckpointAssociation = checkpoint !== null && (
      checkpoint.context_fingerprint !== measurement.context_fingerprint ||
      checkpointPosition?.conversation_id !== measurementPosition.conversation_id ||
      (source.status === "compacted" && (
        checkpointPosition?.revision !== measurementPosition.revision ||
        checkpointPosition?.event_id !== measurementPosition.event_id
      )) ||
      (source.status === "unchanged" && (
        checkpointPosition === undefined ||
        checkpointPosition.revision > measurementPosition.revision ||
        (checkpointPosition.revision === measurementPosition.revision &&
          checkpointPosition.event_id !== measurementPosition.event_id)
      ))
    );
    if (invalidCheckpointAssociation) {
      fail(`${path}.checkpoint`, "must describe the measured context and canonical-history position");
    }
    return Object.freeze({
      status: source.status,
      checkpoint,
      measurement,
    }) as ProviderContextCompactedResult | ProviderContextUnchangedResult;
  }
  if (source.status === "invalidated") {
    exactFields(source, ["status", "reason", "context_fingerprint", "history_position"], [], path);
    if (!PROVIDER_CONTEXT_INVALIDATION_REASONS.includes(source.reason as ProviderContextInvalidationReason)) {
      fail(`${path}.reason`, `must be one of: ${PROVIDER_CONTEXT_INVALIDATION_REASONS.join(", ")}`);
    }
    return Object.freeze({
      status: "invalidated",
      reason: source.reason as ProviderContextInvalidationReason,
      context_fingerprint: parseFingerprint(source.context_fingerprint, `${path}.context_fingerprint`),
      history_position: parseHistoryPosition(source.history_position, `${path}.history_position`),
    });
  }
  fail(`${path}.status`, "must equal compacted, unchanged, or invalidated");
}

export function providerContextSafeError(code: ProviderContextErrorCode): ProviderContextSafeError {
  const definition = ERROR_DEFINITIONS[code];
  return Object.freeze({ code, ...definition });
}

export function parseProviderContextSafeError(value: unknown): ProviderContextSafeError {
  const path = "$error";
  const source = record(value, path);
  exactFields(source, ["code", "message", "retryable"], [], path);
  if (!PROVIDER_CONTEXT_ERROR_CODES.includes(source.code as ProviderContextErrorCode)) {
    fail(`${path}.code`, `must be one of: ${PROVIDER_CONTEXT_ERROR_CODES.join(", ")}`);
  }
  const expected = providerContextSafeError(source.code as ProviderContextErrorCode);
  if (source.message !== expected.message || source.retryable !== expected.retryable) {
    fail(path, "must use the fixed safe message and retryability for its code");
  }
  return expected;
}

export function normalizeProviderContextError(
  error: unknown,
  signal?: AbortSignal,
): ProviderContextSafeError {
  if (signal?.aborted) return providerContextSafeError("cancelled");
  if (error instanceof ProviderContextOperationError) {
    return providerContextSafeError(error.code);
  }
  try {
    return parseProviderContextSafeError(error);
  } catch {
    return providerContextSafeError("internal_failure");
  }
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeInstructions(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > PROVIDER_CONTEXT_LIMITS.instructions) {
    fail("$fingerprint.instructions", `must contain at most ${PROVIDER_CONTEXT_LIMITS.instructions} items`);
  }
  return values.map((value, index) => {
    const path = `$fingerprint.instructions[${index}]`;
    if (typeof value !== "string" || value.length === 0 || value.length > PROVIDER_CONTEXT_LIMITS.instructionLength) {
      fail(path, `must contain 1-${PROVIDER_CONTEXT_LIMITS.instructionLength} characters`);
    }
    if ([...value].some((character) => {
      const point = character.codePointAt(0)!;
      return (point <= 0x1f && character !== "\n" && character !== "\r" && character !== "\t") || point === 0x7f;
    })) fail(path, "must not contain unsupported control characters");
    if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      fail(path, "must not contain credential material");
    }
    const parsed = value;
    const normalized = parsed.normalize("NFC").replace(/\r\n?/g, "\n")
      .split("\n").map((line) => line.trim().replace(/[\t ]+/g, " "))
      .join("\n").trim();
    if (normalized.length === 0) fail(path, "must not normalize to an empty instruction");
    return normalized;
  });
}

function normalizeJson(value: unknown, path: string): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (current: unknown, currentPath: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > PROVIDER_CONTEXT_LIMITS.providerSettingNodes) fail(path, "contains too many values");
    if (depth > PROVIDER_CONTEXT_LIMITS.providerSettingDepth) fail(currentPath, "is too deeply nested");
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail(currentPath, "must be a finite JSON number");
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current === "string") {
      return safeString(current, currentPath, PROVIDER_CONTEXT_LIMITS.providerSettingStringLength).normalize("NFC");
    }
    if (typeof current !== "object") fail(currentPath, "must be JSON-safe");
    if (ancestors.has(current)) fail(currentPath, "must not contain a circular reference");
    ancestors.add(current);
    let normalized: unknown;
    if (Array.isArray(current)) {
      if (current.length > PROVIDER_CONTEXT_LIMITS.providerSettingArrayLength) fail(currentPath, "contains too many items");
      normalized = current.map((item, index) => visit(item, `${currentPath}[${index}]`, depth + 1));
    } else {
      const source = record(current, currentPath);
      const keys = Object.keys(source).sort();
      if (keys.length > PROVIDER_CONTEXT_LIMITS.providerSettingObjectKeys) fail(currentPath, "contains too many fields");
      const target: Record<string, unknown> = {};
      for (const key of keys) {
        if (key.length === 0 || key.length > PROVIDER_CONTEXT_LIMITS.providerSettingKeyLength) fail(`${currentPath}.${key}`, "has an invalid field name length");
        if (FORBIDDEN_SETTING_FIELDS.has(normalizeFieldName(key))) fail(`${currentPath}.${key}`, "is sensitive or provider-native request data");
        target[key] = visit(source[key], `${currentPath}.${key}`, depth + 1);
      }
      normalized = target;
    }
    ancestors.delete(current);
    return normalized;
  };
  return visit(value, path, 0);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
}

/** Pure ECMAScript SHA-256 keeps the core usable in browsers without Node APIs. */
function sha256(value: string): string {
  const bytes = UTF8_ENCODER.encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const k = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  const w = new Uint32Array(64);
  const rotate = (x: number, bits: number): number => (x >>> bits) | (x << (32 - bits));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const x = w[index - 15]!; const y = w[index - 2]!;
      const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
      const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,hh] = h;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + s1 + choice + k[index]! + w[index]!) >>> 0;
      const s0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (s0 + majority) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0]=(h[0]!+a!)>>>0; h[1]=(h[1]!+b!)>>>0; h[2]=(h[2]!+c!)>>>0; h[3]=(h[3]!+d!)>>>0;
    h[4]=(h[4]!+e!)>>>0; h[5]=(h[5]!+f!)>>>0; h[6]=(h[6]!+g!)>>>0; h[7]=(h[7]!+hh!)>>>0;
  }
  return [...h].map((part) => part.toString(16).padStart(8, "0")).join("");
}

export function createProviderContextFingerprint(
  input: ProviderContextFingerprintInput,
): ProviderContextFingerprint {
  const source = record(input, "$fingerprint");
  exactFields(source, ["model", "instructions", "tools", "generation"], ["provider_settings"], "$fingerprint");
  const model = record(source.model, "$fingerprint.model");
  exactFields(model, ["provider_id", "model_id"], [], "$fingerprint.model");
  if (!Array.isArray(source.tools) || source.tools.length > PROVIDER_CONTEXT_LIMITS.tools) {
    fail("$fingerprint.tools", `must contain at most ${PROVIDER_CONTEXT_LIMITS.tools} tools`);
  }
  const tools = source.tools.map((tool, index) => {
    const parsed = parseToolDefinition(tool);
    return normalizeJson(parsed, `$fingerprint.tools[${index}]`);
  }).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  const generation = record(source.generation, "$fingerprint.generation");
  exactFields(generation, ["max_output_tokens", "temperature"], [], "$fingerprint.generation");
  const maxOutputTokens = finiteInteger(generation.max_output_tokens, "$fingerprint.generation.max_output_tokens", 1);
  if (typeof generation.temperature !== "number" || !Number.isFinite(generation.temperature) || generation.temperature < 0 || generation.temperature > 2) {
    fail("$fingerprint.generation.temperature", "must be a finite number from 0 through 2");
  }
  const normalized = {
    version: PROVIDER_CONTEXT_CONTRACT_VERSION,
    model: {
      provider_id: identifier(model.provider_id, "$fingerprint.model.provider_id"),
      model_id: identifier(model.model_id, "$fingerprint.model.model_id"),
    },
    instructions: normalizeInstructions(source.instructions as readonly string[]),
    tools,
    generation: { max_output_tokens: maxOutputTokens, temperature: Object.is(generation.temperature, -0) ? 0 : generation.temperature },
    provider_settings: Object.hasOwn(source, "provider_settings")
      ? normalizeJson(source.provider_settings, "$fingerprint.provider_settings")
      : {},
  };
  const serialized = canonicalJson(normalized);
  if (UTF8_ENCODER.encode(canonicalJson(normalized.provider_settings)).byteLength > PROVIDER_CONTEXT_LIMITS.providerSettingsSerializedBytes) {
    fail("$fingerprint.provider_settings", `must serialize to at most ${PROVIDER_CONTEXT_LIMITS.providerSettingsSerializedBytes} bytes`);
  }
  if (UTF8_ENCODER.encode(serialized).byteLength > PROVIDER_CONTEXT_LIMITS.fingerprintSerializedBytes) {
    fail("$fingerprint", `must normalize to at most ${PROVIDER_CONTEXT_LIMITS.fingerprintSerializedBytes} bytes`);
  }
  return `sha256:${sha256(serialized)}` as ProviderContextFingerprint;
}
