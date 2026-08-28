export const CONVERSATION_EVENT_VERSION = 1 as const;

export const CONVERSATION_EVENT_TYPES = [
  "message.created",
  "message.attachment_referenced",
  "turn.started",
  "turn.status_changed",
  "turn.attempt_started",
  "turn.retry_scheduled",
  "turn.retry_exhausted",
  "turn.cancellation_requested",
  "turn.cancellation_unsupported",
  "turn.completed",
  "turn.cancelled",
  "turn.failed",
  "tool_call.requested",
  "tool_call.discovered",
  "tool_call.started",
  "tool_call.approval_required",
  "tool_call.result_recorded",
  "tool_loop.budget_exhausted",
  "usage.receipt_linked",
  "conversation.metadata_updated",
  "conversation.title_updated",
] as const;

export const CONVERSATION_EVENT_ACTOR_TYPES = [
  "user",
  "assistant",
  "tool",
  "system",
] as const;

export const CONVERSATION_EVENT_SOURCE_TYPES = [
  "client",
  "runtime",
  "sync",
  "import",
] as const;

export const CONVERSATION_EVENT_LIMITS = {
  identifierLength: 256,
  textLength: 1_000_000,
  titleLength: 4_096,
  filenameLength: 1_024,
  jsonDepth: 20,
  jsonNodes: 10_000,
  jsonArrayLength: 2_000,
  jsonObjectKeys: 2_000,
  jsonKeyLength: 256,
  jsonStringLength: 1_000_000,
  metadataDepth: 5,
  metadataNodes: 256,
  metadataArrayLength: 64,
  metadataObjectKeys: 64,
  metadataKeyLength: 128,
  metadataStringLength: 4_096,
  metadataSerializedBytes: 16_384,
} as const;

declare const opaqueConversationValue: unique symbol;
type OpaqueString<Name extends string> = string & {
  readonly [opaqueConversationValue]: Name;
};

export type ConversationId = OpaqueString<"ConversationId">;
export type ConversationEventId = OpaqueString<"ConversationEventId">;
export type ConversationMessageId = OpaqueString<"ConversationMessageId">;
export type ConversationTurnId = OpaqueString<"ConversationTurnId">;
export type ConversationToolCallId = OpaqueString<"ConversationToolCallId">;
export type ConversationClientId = OpaqueString<"ConversationClientId">;
export type ConversationDeviceId = OpaqueString<"ConversationDeviceId">;
export type ConversationClientMutationId = OpaqueString<"ConversationClientMutationId">;
export type ConversationUsageReceiptId = OpaqueString<"ConversationUsageReceiptId">;
export type ConversationAttachmentId = OpaqueString<"ConversationAttachmentId">;
export type ConversationActorId = OpaqueString<"ConversationActorId">;
export type ConversationTimestamp = OpaqueString<"ConversationTimestamp">;
export type ConversationRevision = number & {
  readonly [opaqueConversationValue]: "ConversationRevision";
};

export type ConversationJsonPrimitive = string | number | boolean | null;
export type ConversationJsonValue =
  | ConversationJsonPrimitive
  | ConversationJsonObject
  | ConversationJsonValue[];
export type ConversationJsonObject = { [key: string]: ConversationJsonValue };
export type ConversationEventMetadata = ConversationJsonObject;

export type ConversationEventType = (typeof CONVERSATION_EVENT_TYPES)[number];
export type ConversationEventActorType =
  (typeof CONVERSATION_EVENT_ACTOR_TYPES)[number];
export type ConversationEventSourceType =
  (typeof CONVERSATION_EVENT_SOURCE_TYPES)[number];

export interface ConversationEventActor {
  type: ConversationEventActorType;
  id?: ConversationActorId;
}

export interface ConversationClientEventSource {
  type: "client";
  client_id: ConversationClientId;
  device_id?: ConversationDeviceId;
}

export interface ConversationRuntimeEventSource {
  type: "runtime";
}

export interface ConversationSyncEventSource {
  type: "sync";
}

export interface ConversationImportEventSource {
  type: "import";
}

export type ConversationEventSource =
  | ConversationClientEventSource
  | ConversationRuntimeEventSource
  | ConversationSyncEventSource
  | ConversationImportEventSource;

export interface ConversationMessageTextPart {
  type: "text";
  text: string;
}

export type ConversationMessageContentPart = ConversationMessageTextPart;
export type ConversationMessageRole = "user" | "assistant" | "system";

export interface MessageCreatedPayload {
  type: "message.created";
  message_id: ConversationMessageId;
  role: ConversationMessageRole;
  content: ConversationMessageContentPart[];
}

export interface ConversationAttachmentReference {
  attachment_id: ConversationAttachmentId;
  media_type: string;
  filename?: string;
  size_bytes?: number;
}

export interface MessageAttachmentReferencedPayload {
  type: "message.attachment_referenced";
  message_id: ConversationMessageId;
  attachment: ConversationAttachmentReference;
}

export interface TurnStartedPayload {
  type: "turn.started";
  turn_id: ConversationTurnId;
  input_message_ids: ConversationMessageId[];
  continuation_of_turn_id?: ConversationTurnId;
}

export type ConversationTurnStatus =
  | "queued"
  | "running"
  | "waiting_for_tool_result";

export interface TurnStatusChangedPayload {
  type: "turn.status_changed";
  turn_id: ConversationTurnId;
  status: ConversationTurnStatus;
}

export type ConversationTurnAttemptOperation = "start" | "resume";

export type ConversationRetryReasonCategory =
  | "rate_limit"
  | "timeout"
  | "unavailable"
  | "internal"
  | "disconnected"
  | "interrupted";

export type ConversationRetryExhaustionReason =
  | "maximum_attempts"
  | "maximum_elapsed_time";

export interface TurnAttemptStartedPayload {
  type: "turn.attempt_started";
  turn_id: ConversationTurnId;
  attempt: number;
  operation: ConversationTurnAttemptOperation;
}

export interface TurnRetryScheduledPayload {
  type: "turn.retry_scheduled";
  turn_id: ConversationTurnId;
  attempt: number;
  reason_category: ConversationRetryReasonCategory;
  delay_ms: number;
}

export interface TurnRetryExhaustedPayload {
  type: "turn.retry_exhausted";
  turn_id: ConversationTurnId;
  attempt: number;
  reason_category: ConversationRetryReasonCategory;
  exhaustion_reason: ConversationRetryExhaustionReason;
}

export type ConversationTurnCompletionOutcome =
  | "stop"
  | "length"
  | "tool_calls";

export interface TurnCompletedPayload {
  type: "turn.completed";
  turn_id: ConversationTurnId;
  outcome: ConversationTurnCompletionOutcome;
  output_message_ids: ConversationMessageId[];
}

export type ConversationTurnCancellationReason =
  | "user"
  | "timeout"
  | "superseded"
  | "runtime_shutdown";

export interface TurnCancellationRequestedPayload {
  type: "turn.cancellation_requested";
  turn_id: ConversationTurnId;
  reason: ConversationTurnCancellationReason;
}

export interface TurnCancellationUnsupportedPayload {
  type: "turn.cancellation_unsupported";
  turn_id: ConversationTurnId;
  reason: ConversationTurnCancellationReason;
}

export interface TurnCancelledPayload {
  type: "turn.cancelled";
  turn_id: ConversationTurnId;
  reason: ConversationTurnCancellationReason;
}

export interface ConversationTurnError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface TurnFailedPayload {
  type: "turn.failed";
  turn_id: ConversationTurnId;
  error: ConversationTurnError;
}

export interface ToolCallRequestedPayload {
  type: "tool_call.requested";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
  name: string;
  arguments: ConversationJsonObject;
}

export interface ToolCallDiscoveredPayload {
  type: "tool_call.discovered";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
}

export interface ToolCallStartedPayload {
  type: "tool_call.started";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
}

export interface ToolCallApprovalRequiredPayload {
  type: "tool_call.approval_required";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
}

export interface ConversationToolResultTextPart {
  type: "text";
  text: string;
}

export interface ConversationToolResultJsonPart {
  type: "json";
  value: ConversationJsonValue;
}

export type ConversationToolResultContentPart =
  | ConversationToolResultTextPart
  | ConversationToolResultJsonPart;

export interface ToolCallResultRecordedPayload {
  type: "tool_call.result_recorded";
  turn_id: ConversationTurnId;
  tool_call_id: ConversationToolCallId;
  content: ConversationToolResultContentPart[];
  is_error: boolean;
}

export type ToolLoopBudget = "iterations" | "total_tool_calls" | "wall_clock";

export interface ToolLoopBudgetExhaustedPayload {
  type: "tool_loop.budget_exhausted";
  turn_id: ConversationTurnId;
  budget: ToolLoopBudget;
  limit: number;
}

export interface UsageReceiptLinkedPayload {
  type: "usage.receipt_linked";
  turn_id: ConversationTurnId;
  usage_receipt_id: ConversationUsageReceiptId;
}

export interface ConversationMetadataUpdatedPayload {
  type: "conversation.metadata_updated";
  metadata: ConversationEventMetadata;
}

export interface ConversationTitleUpdatedPayload {
  type: "conversation.title_updated";
  title: string | null;
}

export type ConversationEventPayload =
  | MessageCreatedPayload
  | MessageAttachmentReferencedPayload
  | TurnStartedPayload
  | TurnStatusChangedPayload
  | TurnAttemptStartedPayload
  | TurnRetryScheduledPayload
  | TurnRetryExhaustedPayload
  | TurnCancellationRequestedPayload
  | TurnCancellationUnsupportedPayload
  | TurnCompletedPayload
  | TurnCancelledPayload
  | TurnFailedPayload
  | ToolCallRequestedPayload
  | ToolCallDiscoveredPayload
  | ToolCallStartedPayload
  | ToolCallApprovalRequiredPayload
  | ToolCallResultRecordedPayload
  | ToolLoopBudgetExhaustedPayload
  | UsageReceiptLinkedPayload
  | ConversationMetadataUpdatedPayload
  | ConversationTitleUpdatedPayload;

/**
 * A provider-neutral durable conversation fact.
 *
 * Event revisions are assigned monotonically within one conversation. Repeated
 * observations of the same event_id are the same durable fact. When present,
 * repeated observations of the same mutation_id likewise represent the same
 * client mutation and must not be applied as a new mutation.
 */
export interface ConversationEvent {
  version: typeof CONVERSATION_EVENT_VERSION;
  event_id: ConversationEventId;
  conversation_id: ConversationId;
  revision: ConversationRevision;
  occurred_at: ConversationTimestamp;
  actor: ConversationEventActor;
  source: ConversationEventSource;
  mutation_id?: ConversationClientMutationId;
  metadata?: ConversationEventMetadata;
  payload: ConversationEventPayload;
}

export class ConversationEventValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ConversationEventValidationError";
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

const CREDENTIAL_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "apitoken",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretkey",
  "secrets",
  "setcookie",
  "signingkey",
]);

const METADATA_FORBIDDEN_FIELD_NAMES = new Set([
  ...CREDENTIAL_FIELD_NAMES,
  "anthropic",
  "choices",
  "completiontokens",
  "contentblock",
  "finishreason",
  "functioncall",
  "gemini",
  "headers",
  "model",
  "modelid",
  "nativechunk",
  "nativepayload",
  "openai",
  "prompttokens",
  "provider",
  "providerchunk",
  "providererror",
  "providername",
  "providerpayload",
  "providerrequest",
  "providerresponse",
  "rawerror",
  "rawrequest",
  "rawresponse",
  "requestheaders",
  "systemfingerprint",
  "usagemetadata",
  "xai",
]);

const METADATA_FORBIDDEN_STRING_VALUES = new Set([
  "anthropic",
  "chatcompletion",
  "chatcompletionchunk",
  "contentblockdelta",
  "gemini",
  "openai",
  "xai",
]);

const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /\bsk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

const TURN_STATUSES = ["queued", "running", "waiting_for_tool_result"] as const;
const TURN_COMPLETION_OUTCOMES = ["stop", "length", "tool_calls"] as const;
const TURN_CANCELLATION_REASONS = [
  "user",
  "timeout",
  "superseded",
  "runtime_shutdown",
] as const;
const RETRY_REASON_CATEGORIES = [
  "rate_limit",
  "timeout",
  "unavailable",
  "internal",
  "disconnected",
  "interrupted",
] as const;
const RETRY_EXHAUSTION_REASONS = [
  "maximum_attempts",
  "maximum_elapsed_time",
] as const;

const normalizeFieldName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");

function fail(path: string, message: string): never {
  throw new ConversationEventValidationError(path, message);
}

function record(value: unknown, path: string): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    fail(path, "must be a JSON object");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    fail(path, "must contain only string-named JSON fields");
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}.${key}`, "must be an enumerable JSON data field");
    }
  }
  return value as UnknownRecord;
}

function allowedKeys(
  value: UnknownRecord,
  keys: readonly string[],
  path: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not a supported field");
  }
}

function requiredKeys(
  value: UnknownRecord,
  keys: readonly string[],
  path: string,
): void {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
}

function stringValue(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  const {
    allowEmpty = false,
    maxLength = CONVERSATION_EVENT_LIMITS.identifierLength,
  } = options;
  if (typeof value !== "string") fail(path, "must be a string");
  if (!allowEmpty && value.length === 0) fail(path, "must not be empty");
  if (value.length > maxLength) {
    fail(path, `must be at most ${maxLength} characters`);
  }
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(path, `must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function identifier(value: unknown, path: string): string {
  return stringValue(value, path);
}

function identifierArray(
  value: unknown,
  path: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (!options.allowEmpty && value.length === 0) {
    fail(path, "must be a non-empty array");
  }
  const identifiers = value.map((item, index) =>
    identifier(item, `${path}[${index}]`),
  );
  if (new Set(identifiers).size !== identifiers.length) {
    fail(path, "must contain unique identifiers");
  }
  return identifiers;
}

interface JsonLimits {
  maxDepth: number;
  maxNodes: number;
  maxArrayLength: number;
  maxObjectKeys: number;
  maxKeyLength: number;
  maxStringLength: number;
  forbiddenFields: ReadonlySet<string>;
  forbiddenStringValues?: ReadonlySet<string>;
}

const JSON_LIMITS: JsonLimits = {
  maxDepth: CONVERSATION_EVENT_LIMITS.jsonDepth,
  maxNodes: CONVERSATION_EVENT_LIMITS.jsonNodes,
  maxArrayLength: CONVERSATION_EVENT_LIMITS.jsonArrayLength,
  maxObjectKeys: CONVERSATION_EVENT_LIMITS.jsonObjectKeys,
  maxKeyLength: CONVERSATION_EVENT_LIMITS.jsonKeyLength,
  maxStringLength: CONVERSATION_EVENT_LIMITS.jsonStringLength,
  forbiddenFields: CREDENTIAL_FIELD_NAMES,
};

const METADATA_LIMITS: JsonLimits = {
  maxDepth: CONVERSATION_EVENT_LIMITS.metadataDepth,
  maxNodes: CONVERSATION_EVENT_LIMITS.metadataNodes,
  maxArrayLength: CONVERSATION_EVENT_LIMITS.metadataArrayLength,
  maxObjectKeys: CONVERSATION_EVENT_LIMITS.metadataObjectKeys,
  maxKeyLength: CONVERSATION_EVENT_LIMITS.metadataKeyLength,
  maxStringLength: CONVERSATION_EVENT_LIMITS.metadataStringLength,
  forbiddenFields: METADATA_FORBIDDEN_FIELD_NAMES,
  forbiddenStringValues: METADATA_FORBIDDEN_STRING_VALUES,
};

function validateJson(
  value: unknown,
  path: string,
  limits: JsonLimits,
): asserts value is ConversationJsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();

  const visit = (current: unknown, currentPath: string, depth: number): void => {
    nodes += 1;
    if (nodes > limits.maxNodes) {
      fail(path, `must contain at most ${limits.maxNodes} JSON values`);
    }
    if (depth > limits.maxDepth) {
      fail(currentPath, `exceeds maximum depth ${limits.maxDepth}`);
    }
    if (current === null || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        fail(currentPath, "must be a finite JSON number");
      }
      return;
    }
    if (typeof current === "string") {
      if (current.length > limits.maxStringLength) {
        fail(
          currentPath,
          `must be at most ${limits.maxStringLength} characters`,
        );
      }
      if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        fail(currentPath, "must not contain credential material");
      }
      if (limits.forbiddenStringValues?.has(normalizeFieldName(current))) {
        fail(currentPath, "must not identify provider-native data");
      }
      return;
    }
    if (typeof current !== "object") {
      fail(currentPath, "must be a JSON value");
    }
    if (ancestors.has(current)) {
      fail(currentPath, "must not contain a circular reference");
    }
    ancestors.add(current);

    if (Array.isArray(current)) {
      if (Object.getOwnPropertySymbols(current).length > 0) {
        fail(currentPath, "must contain only JSON array entries");
      }
      if (current.length > limits.maxArrayLength) {
        fail(
          currentPath,
          `must contain at most ${limits.maxArrayLength} items`,
        );
      }
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) {
          fail(`${currentPath}[${index}]`, "must not be a sparse array entry");
        }
        visit(current[index], `${currentPath}[${index}]`, depth + 1);
      }
      const expectedKeys = new Set(
        Array.from({ length: current.length }, (_, index) => String(index)),
      );
      for (const key of Object.keys(current)) {
        if (!expectedKeys.has(key)) {
          fail(`${currentPath}.${key}`, "is not a JSON array index");
        }
      }
    } else {
      const object = record(current, currentPath);
      const entries = Object.entries(object);
      if (entries.length > limits.maxObjectKeys) {
        fail(
          currentPath,
          `must contain at most ${limits.maxObjectKeys} fields`,
        );
      }
      for (const [key, item] of entries) {
        if (key.length === 0 || key.length > limits.maxKeyLength) {
          fail(
            `${currentPath}.${key}`,
            `field names must be 1-${limits.maxKeyLength} characters`,
          );
        }
        if (limits.forbiddenFields.has(normalizeFieldName(key))) {
          fail(`${currentPath}.${key}`, "is forbidden in durable public data");
        }
        visit(item, `${currentPath}.${key}`, depth + 1);
      }
    }
    ancestors.delete(current);
  };

  visit(value, path, 0);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function validateMetadata(
  value: unknown,
  path: string,
): asserts value is ConversationEventMetadata {
  record(value, path);
  validateJson(value, path, METADATA_LIMITS);
  const serialized = JSON.stringify(value);
  if (
    utf8ByteLength(serialized) >
    CONVERSATION_EVENT_LIMITS.metadataSerializedBytes
  ) {
    fail(
      path,
      `must serialize to at most ${CONVERSATION_EVENT_LIMITS.metadataSerializedBytes} bytes`,
    );
  }
}

function validateActor(
  value: unknown,
  path: string,
): asserts value is ConversationEventActor {
  const object = record(value, path);
  requiredKeys(object, ["type"], path);
  allowedKeys(object, ["type", "id"], path);
  enumValue(object.type, CONVERSATION_EVENT_ACTOR_TYPES, `${path}.type`);
  if (Object.hasOwn(object, "id")) identifier(object.id, `${path}.id`);
}

function validateSource(
  value: unknown,
  path: string,
): asserts value is ConversationEventSource {
  const object = record(value, path);
  requiredKeys(object, ["type"], path);
  const sourceType = enumValue(
    object.type,
    CONVERSATION_EVENT_SOURCE_TYPES,
    `${path}.type`,
  );
  if (sourceType === "client") {
    requiredKeys(object, ["client_id"], path);
    allowedKeys(object, ["type", "client_id", "device_id"], path);
    identifier(object.client_id, `${path}.client_id`);
    if (Object.hasOwn(object, "device_id")) {
      identifier(object.device_id, `${path}.device_id`);
    }
    return;
  }
  allowedKeys(object, ["type"], path);
}

function validateTimestamp(value: unknown, path: string): void {
  const timestamp = stringValue(value, path, { maxLength: 64 });
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(
      timestamp,
    );
  if (match === null) {
    fail(path, "must be a valid RFC 3339 UTC timestamp");
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];
  if (
    year === 0 ||
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    fail(path, "must be a valid RFC 3339 UTC timestamp");
  }
}

function validateRevision(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(path, "must be a positive safe integer monotonic revision");
  }
}

function positiveSafeInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, "must be a positive safe integer");
  }
}

function nonnegativeSafeInteger(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(path, "must be a non-negative safe integer");
  }
}

function validateTextPart(
  value: unknown,
  path: string,
): asserts value is ConversationMessageTextPart {
  const object = record(value, path);
  requiredKeys(object, ["type", "text"], path);
  allowedKeys(object, ["type", "text"], path);
  if (object.type !== "text") fail(`${path}.type`, 'must equal "text"');
  stringValue(object.text, `${path}.text`, {
    allowEmpty: true,
    maxLength: CONVERSATION_EVENT_LIMITS.textLength,
  });
}

function validateAttachmentReference(value: unknown, path: string): void {
  const object = record(value, path);
  requiredKeys(object, ["attachment_id", "media_type"], path);
  allowedKeys(
    object,
    ["attachment_id", "media_type", "filename", "size_bytes"],
    path,
  );
  identifier(object.attachment_id, `${path}.attachment_id`);
  const mediaType = stringValue(object.media_type, `${path}.media_type`);
  if (
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(
      mediaType,
    )
  ) {
    fail(`${path}.media_type`, "must be a valid media type without parameters");
  }
  if (Object.hasOwn(object, "filename")) {
    stringValue(object.filename, `${path}.filename`, {
      maxLength: CONVERSATION_EVENT_LIMITS.filenameLength,
    });
  }
  if (Object.hasOwn(object, "size_bytes")) {
    if (
      !Number.isSafeInteger(object.size_bytes) ||
      (object.size_bytes as number) < 0
    ) {
      fail(`${path}.size_bytes`, "must be a non-negative safe integer");
    }
  }
}

function validateTurnError(value: unknown, path: string): void {
  const object = record(value, path);
  requiredKeys(object, ["code", "message", "retryable"], path);
  allowedKeys(object, ["code", "message", "retryable"], path);
  identifier(object.code, `${path}.code`);
  stringValue(object.message, `${path}.message`, {
    allowEmpty: true,
    maxLength: CONVERSATION_EVENT_LIMITS.titleLength,
  });
  booleanValue(object.retryable, `${path}.retryable`);
}

function validateToolResultPart(value: unknown, path: string): void {
  const object = record(value, path);
  if (object.type === "text") {
    validateTextPart(value, path);
    return;
  }
  if (object.type === "json") {
    requiredKeys(object, ["type", "value"], path);
    allowedKeys(object, ["type", "value"], path);
    validateJson(object.value, `${path}.value`, JSON_LIMITS);
    return;
  }
  fail(`${path}.type`, 'must equal "text" or "json"');
}

function validatePayload(
  value: unknown,
  path: string,
): asserts value is ConversationEventPayload {
  const object = record(value, path);
  requiredKeys(object, ["type"], path);
  if (
    typeof object.type !== "string" ||
    !CONVERSATION_EVENT_TYPES.includes(object.type as ConversationEventType)
  ) {
    fail(`${path}.type`, "is not a supported durable event discriminator");
  }

  switch (object.type as ConversationEventType) {
    case "message.created": {
      requiredKeys(object, ["message_id", "role", "content"], path);
      allowedKeys(object, ["type", "message_id", "role", "content"], path);
      identifier(object.message_id, `${path}.message_id`);
      enumValue(object.role, ["user", "assistant", "system"], `${path}.role`);
      if (!Array.isArray(object.content) || object.content.length === 0) {
        fail(`${path}.content`, "must be a non-empty array");
      }
      object.content.forEach((part, index) =>
        validateTextPart(part, `${path}.content[${index}]`),
      );
      return;
    }
    case "message.attachment_referenced":
      requiredKeys(object, ["message_id", "attachment"], path);
      allowedKeys(object, ["type", "message_id", "attachment"], path);
      identifier(object.message_id, `${path}.message_id`);
      validateAttachmentReference(object.attachment, `${path}.attachment`);
      return;
    case "turn.started":
      requiredKeys(object, ["turn_id", "input_message_ids"], path);
      allowedKeys(
        object,
        ["type", "turn_id", "input_message_ids", "continuation_of_turn_id"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      identifierArray(object.input_message_ids, `${path}.input_message_ids`);
      if (Object.hasOwn(object, "continuation_of_turn_id")) {
        identifier(object.continuation_of_turn_id, `${path}.continuation_of_turn_id`);
      }
      return;
    case "turn.status_changed":
      requiredKeys(object, ["turn_id", "status"], path);
      allowedKeys(object, ["type", "turn_id", "status"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(object.status, TURN_STATUSES, `${path}.status`);
      return;
    case "turn.attempt_started":
      requiredKeys(object, ["turn_id", "attempt", "operation"], path);
      allowedKeys(object, ["type", "turn_id", "attempt", "operation"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      positiveSafeInteger(object.attempt, `${path}.attempt`);
      enumValue(object.operation, ["start", "resume"], `${path}.operation`);
      return;
    case "turn.retry_scheduled":
      requiredKeys(
        object,
        ["turn_id", "attempt", "reason_category", "delay_ms"],
        path,
      );
      allowedKeys(
        object,
        ["type", "turn_id", "attempt", "reason_category", "delay_ms"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      positiveSafeInteger(object.attempt, `${path}.attempt`);
      enumValue(object.reason_category, RETRY_REASON_CATEGORIES, `${path}.reason_category`);
      nonnegativeSafeInteger(object.delay_ms, `${path}.delay_ms`);
      return;
    case "turn.retry_exhausted":
      requiredKeys(
        object,
        ["turn_id", "attempt", "reason_category", "exhaustion_reason"],
        path,
      );
      allowedKeys(
        object,
        ["type", "turn_id", "attempt", "reason_category", "exhaustion_reason"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      positiveSafeInteger(object.attempt, `${path}.attempt`);
      enumValue(object.reason_category, RETRY_REASON_CATEGORIES, `${path}.reason_category`);
      enumValue(
        object.exhaustion_reason,
        RETRY_EXHAUSTION_REASONS,
        `${path}.exhaustion_reason`,
      );
      return;
    case "turn.cancellation_requested":
    case "turn.cancellation_unsupported":
      requiredKeys(object, ["turn_id", "reason"], path);
      allowedKeys(object, ["type", "turn_id", "reason"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(object.reason, TURN_CANCELLATION_REASONS, `${path}.reason`);
      return;
    case "turn.completed":
      requiredKeys(
        object,
        ["turn_id", "outcome", "output_message_ids"],
        path,
      );
      allowedKeys(
        object,
        ["type", "turn_id", "outcome", "output_message_ids"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(object.outcome, TURN_COMPLETION_OUTCOMES, `${path}.outcome`);
      identifierArray(object.output_message_ids, `${path}.output_message_ids`, {
        allowEmpty: true,
      });
      return;
    case "turn.cancelled":
      requiredKeys(object, ["turn_id", "reason"], path);
      allowedKeys(object, ["type", "turn_id", "reason"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(object.reason, TURN_CANCELLATION_REASONS, `${path}.reason`);
      return;
    case "turn.failed":
      requiredKeys(object, ["turn_id", "error"], path);
      allowedKeys(object, ["type", "turn_id", "error"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      validateTurnError(object.error, `${path}.error`);
      return;
    case "tool_call.requested":
      requiredKeys(
        object,
        ["turn_id", "tool_call_id", "name", "arguments"],
        path,
      );
      allowedKeys(
        object,
        ["type", "turn_id", "tool_call_id", "name", "arguments"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.tool_call_id, `${path}.tool_call_id`);
      identifier(object.name, `${path}.name`);
      record(object.arguments, `${path}.arguments`);
      validateJson(object.arguments, `${path}.arguments`, JSON_LIMITS);
      return;
    case "tool_call.discovered":
    case "tool_call.started":
    case "tool_call.approval_required":
      requiredKeys(object, ["turn_id", "tool_call_id"], path);
      allowedKeys(object, ["type", "turn_id", "tool_call_id"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.tool_call_id, `${path}.tool_call_id`);
      return;
    case "tool_call.result_recorded":
      requiredKeys(
        object,
        ["turn_id", "tool_call_id", "content", "is_error"],
        path,
      );
      allowedKeys(
        object,
        ["type", "turn_id", "tool_call_id", "content", "is_error"],
        path,
      );
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.tool_call_id, `${path}.tool_call_id`);
      if (!Array.isArray(object.content) || object.content.length === 0) {
        fail(`${path}.content`, "must be a non-empty array");
      }
      object.content.forEach((part, index) =>
        validateToolResultPart(part, `${path}.content[${index}]`),
      );
      booleanValue(object.is_error, `${path}.is_error`);
      return;
    case "tool_loop.budget_exhausted":
      requiredKeys(object, ["turn_id", "budget", "limit"], path);
      allowedKeys(object, ["type", "turn_id", "budget", "limit"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      enumValue(
        object.budget,
        ["iterations", "total_tool_calls", "wall_clock"],
        `${path}.budget`,
      );
      positiveSafeInteger(object.limit, `${path}.limit`);
      return;
    case "usage.receipt_linked":
      requiredKeys(object, ["turn_id", "usage_receipt_id"], path);
      allowedKeys(object, ["type", "turn_id", "usage_receipt_id"], path);
      identifier(object.turn_id, `${path}.turn_id`);
      identifier(object.usage_receipt_id, `${path}.usage_receipt_id`);
      return;
    case "conversation.metadata_updated":
      requiredKeys(object, ["metadata"], path);
      allowedKeys(object, ["type", "metadata"], path);
      validateMetadata(object.metadata, `${path}.metadata`);
      return;
    case "conversation.title_updated":
      requiredKeys(object, ["title"], path);
      allowedKeys(object, ["type", "title"], path);
      if (object.title !== null) {
        stringValue(object.title, `${path}.title`, {
          allowEmpty: true,
          maxLength: CONVERSATION_EVENT_LIMITS.titleLength,
        });
      }
      return;
  }
}

/** Validates a durable event without cloning or mutating it. */
export function parseConversationEvent(value: unknown): ConversationEvent {
  const object = record(value, "$event");
  requiredKeys(
    object,
    [
      "version",
      "event_id",
      "conversation_id",
      "revision",
      "occurred_at",
      "actor",
      "source",
      "payload",
    ],
    "$event",
  );
  allowedKeys(
    object,
    [
      "version",
      "event_id",
      "conversation_id",
      "revision",
      "occurred_at",
      "actor",
      "source",
      "mutation_id",
      "metadata",
      "payload",
    ],
    "$event",
  );
  if (object.version !== CONVERSATION_EVENT_VERSION) {
    fail(
      "$event.version",
      `must equal ${CONVERSATION_EVENT_VERSION}`,
    );
  }
  identifier(object.event_id, "$event.event_id");
  identifier(object.conversation_id, "$event.conversation_id");
  validateRevision(object.revision, "$event.revision");
  validateTimestamp(object.occurred_at, "$event.occurred_at");
  validateActor(object.actor, "$event.actor");
  validateSource(object.source, "$event.source");
  if (Object.hasOwn(object, "mutation_id")) {
    identifier(object.mutation_id, "$event.mutation_id");
    if (object.source.type !== "client") {
      fail(
        "$event.mutation_id",
        "is supported only for events whose source type is client",
      );
    }
  }
  if (Object.hasOwn(object, "metadata")) {
    validateMetadata(object.metadata, "$event.metadata");
  }
  validatePayload(object.payload, "$event.payload");
  return value as ConversationEvent;
}

export function isConversationEvent(value: unknown): value is ConversationEvent {
  try {
    parseConversationEvent(value);
    return true;
  } catch {
    return false;
  }
}
