import type {
  ConversationId,
  ConversationTurnId,
  ConversationUsageReceiptId,
} from "./conversation/events.js";
import type { AuthoritativeAttribution } from "./protocol.js";
import type { ProviderUsage } from "./providers/index.js";

export const NORMALIZED_USAGE_RECEIPT_VERSION = 1 as const;

export const USAGE_VALUE_STATUSES = [
  "reported",
  "estimated",
  "unavailable",
] as const;

export const USAGE_RECEIPT_SOURCES = ["provider", "runtime"] as const;
export const USAGE_RECEIPT_TERMINAL_STATUSES = [
  "completed",
  "cancelled",
  "failed",
] as const;

export const NORMALIZED_USAGE_RECEIPT_LIMITS = {
  identifierLength: 256,
  providerIdLength: 128,
  modelIdLength: 256,
  decimalLength: 128,
  currencyLength: 3,
} as const;

export type UsageValueStatus = (typeof USAGE_VALUE_STATUSES)[number];
export type KnownUsageValueStatus = Exclude<
  UsageValueStatus,
  "unavailable"
>;
export type UsageReceiptSource = (typeof USAGE_RECEIPT_SOURCES)[number];
export type UsageReceiptTerminalStatus =
  (typeof USAGE_RECEIPT_TERMINAL_STATUSES)[number];

export interface ReportedUsageQuantity {
  readonly status: "reported";
  readonly value: number;
}

export interface EstimatedUsageQuantity {
  readonly status: "estimated";
  readonly value: number;
}

export interface UnavailableUsageQuantity {
  readonly status: "unavailable";
}

/** A required union preserves a known zero while making unknown explicit. */
export type NormalizedUsageQuantity =
  | ReportedUsageQuantity
  | EstimatedUsageQuantity
  | UnavailableUsageQuantity;

export interface ReportedUsageCost {
  readonly status: "reported";
  /** Exact non-negative base-10 amount. Never convert this value to number. */
  readonly amount: string;
  /** ISO 4217 alphabetic currency code. */
  readonly currency: string;
}

export interface EstimatedUsageCost {
  readonly status: "estimated";
  /** Exact non-negative base-10 amount. Never convert this value to number. */
  readonly amount: string;
  /** ISO 4217 alphabetic currency code. */
  readonly currency: string;
}

export interface UnavailableUsageCost {
  readonly status: "unavailable";
}

/** An unavailable cost is distinct from a reported or estimated amount of zero. */
export type NormalizedUsageCost =
  | ReportedUsageCost
  | EstimatedUsageCost
  | UnavailableUsageCost;

export interface NormalizedTokenUsage {
  /** All input tokens, including cached input tokens. */
  readonly input_tokens: NormalizedUsageQuantity;
  /** A non-additive subset of input_tokens. */
  readonly cached_input_tokens: NormalizedUsageQuantity;
  /** A non-additive subset written into a provider prompt cache. Optional in v1 for compatibility. */
  readonly cache_write_input_tokens?: NormalizedUsageQuantity;
  /** All output tokens, including reasoning tokens. */
  readonly output_tokens: NormalizedUsageQuantity;
  /** A non-additive subset of output_tokens. */
  readonly reasoning_tokens: NormalizedUsageQuantity;
  /** input_tokens + output_tokens; subsets are not added again. */
  readonly total_tokens: NormalizedUsageQuantity;
}

export interface UsageAttemptIdentity {
  /** Stable identity for one retry attempt of a logical request. */
  readonly id: string;
  /** Zero-based retry attempt index. */
  readonly index: number;
}

export interface UsageContinuationIdentity {
  /** Stable identity for one provider invocation within an attempt. */
  readonly id: string;
  /** Zero-based continuation index; tool continuations increment this value. */
  readonly index: number;
}

/**
 * Browser-safe telemetry and attribution output for exactly one provider
 * invocation. Deduplicate by usage_receipt_id; logical_request_id deliberately
 * remains stable across retry attempts and tool continuations.
 */
export interface NormalizedUsageReceipt {
  readonly version: typeof NORMALIZED_USAGE_RECEIPT_VERSION;
  /** Provider invocation start time used for effective-dated price selection. */
  readonly occurred_at?: string;
  readonly usage_receipt_id: ConversationUsageReceiptId;
  readonly conversation_id: ConversationId;
  readonly turn_id: ConversationTurnId;
  readonly logical_request_id: string;
  readonly trace_id: string;
  readonly attempt: UsageAttemptIdentity;
  readonly continuation: UsageContinuationIdentity;
  readonly provider_id: string;
  readonly model_id: string;
  readonly attribution: AuthoritativeAttribution;
  readonly source: UsageReceiptSource;
  readonly terminal_status: UsageReceiptTerminalStatus;
  readonly tokens: NormalizedTokenUsage;
  readonly provider_cost: NormalizedUsageCost;
}

export interface ProviderUsageReceiptContext {
  /** Provider invocation start time. Omitted only by legacy receipt producers. */
  readonly occurred_at?: string;
  readonly usage_receipt_id: string;
  readonly conversation_id: string;
  readonly turn_id: string;
  readonly logical_request_id: string;
  readonly trace_id: string;
  readonly attempt: UsageAttemptIdentity;
  readonly continuation: UsageContinuationIdentity;
  readonly provider_id: string;
  readonly model_id: string;
  readonly attribution: AuthoritativeAttribution;
  readonly source: UsageReceiptSource;
  /** Quality assigned to every value known by ProviderUsage. */
  readonly quality: KnownUsageValueStatus;
  readonly terminal_status: UsageReceiptTerminalStatus;
}

export class NormalizedUsageReceiptValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "NormalizedUsageReceiptValidationError";
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /\bsk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

const EXACT_NON_NEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;
const SAFE_PROVIDER_ID = /^[a-z0-9][a-z0-9._:/-]*$/i;
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._:@/+-]*$/i;

function fail(path: string, message: string): never {
  throw new NormalizedUsageReceiptValidationError(path, message);
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

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function boundedString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length === 0) fail(path, "must not be empty");
  if (value.length > maxLength) {
    fail(path, `must be at most ${maxLength} characters`);
  }
  if (
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  ) {
    fail(path, "must not contain control characters");
  }
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
    fail(path, "must not contain credential material");
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  return boundedString(
    value,
    path,
    NORMALIZED_USAGE_RECEIPT_LIMITS.identifierLength,
  );
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(path, "must be a non-negative safe integer");
  }
  return value as number;
}

function validateIdentity(value: unknown, path: string): void {
  const object = record(value, path);
  requiredKeys(object, ["id", "index"], path);
  allowedKeys(object, ["id", "index"], path);
  identifier(object.id, `${path}.id`);
  nonNegativeSafeInteger(object.index, `${path}.index`);
}

function validateQuantity(value: unknown, path: string): void {
  const object = record(value, path);
  requiredKeys(object, ["status"], path);
  const status = enumValue(object.status, USAGE_VALUE_STATUSES, `${path}.status`);
  if (status === "unavailable") {
    allowedKeys(object, ["status"], path);
    return;
  }
  requiredKeys(object, ["value"], path);
  allowedKeys(object, ["status", "value"], path);
  nonNegativeSafeInteger(object.value, `${path}.value`);
}

function knownQuantityValue(value: unknown): number | undefined {
  const object = value as UnknownRecord;
  return object.status === "unavailable" ? undefined : (object.value as number);
}

function validateTokenUsage(value: unknown, path: string): void {
  const object = record(value, path);
  const fields = [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_tokens",
    "total_tokens",
  ] as const;
  requiredKeys(object, fields, path);
  allowedKeys(object, [...fields, "cache_write_input_tokens"], path);
  for (const field of fields) validateQuantity(object[field], `${path}.${field}`);
  if (object.cache_write_input_tokens !== undefined) validateQuantity(object.cache_write_input_tokens, `${path}.cache_write_input_tokens`);

  const input = knownQuantityValue(object.input_tokens);
  const output = knownQuantityValue(object.output_tokens);
  const total = knownQuantityValue(object.total_tokens);
  const knownTotals = [input, output, total].filter(
    (item) => item !== undefined,
  ).length;
  if (knownTotals !== 0 && knownTotals !== 3) {
    fail(
      path,
      "input_tokens, output_tokens, and total_tokens must be available together",
    );
  }
  if (input !== undefined && output !== undefined && total !== input + output) {
    fail(`${path}.total_tokens.value`, "must equal input_tokens + output_tokens");
  }

  const cached = knownQuantityValue(object.cached_input_tokens);
  if (cached !== undefined && input === undefined) {
    fail(`${path}.cached_input_tokens`, "cannot be available when input_tokens is unavailable");
  }
  if (cached !== undefined && input !== undefined && cached > input) {
    fail(`${path}.cached_input_tokens.value`, "must not exceed input_tokens");
  }
  const cacheWrite = object.cache_write_input_tokens === undefined ? undefined : knownQuantityValue(object.cache_write_input_tokens);
  if (cacheWrite !== undefined && (input === undefined || cacheWrite > input || cacheWrite + (cached ?? 0) > input)) {
    fail(`${path}.cache_write_input_tokens.value`, "must be a disjoint subset of input_tokens");
  }

  const reasoning = knownQuantityValue(object.reasoning_tokens);
  if (reasoning !== undefined && output === undefined) {
    fail(`${path}.reasoning_tokens`, "cannot be available when output_tokens is unavailable");
  }
  if (reasoning !== undefined && output !== undefined && reasoning > output) {
    fail(`${path}.reasoning_tokens.value`, "must not exceed output_tokens");
  }
}

function validateCost(value: unknown, path: string): void {
  const object = record(value, path);
  requiredKeys(object, ["status"], path);
  const status = enumValue(object.status, USAGE_VALUE_STATUSES, `${path}.status`);
  if (status === "unavailable") {
    allowedKeys(object, ["status"], path);
    return;
  }

  requiredKeys(object, ["amount", "currency"], path);
  allowedKeys(object, ["status", "amount", "currency"], path);
  const amount = boundedString(
    object.amount,
    `${path}.amount`,
    NORMALIZED_USAGE_RECEIPT_LIMITS.decimalLength,
  );
  if (!EXACT_NON_NEGATIVE_DECIMAL.test(amount)) {
    fail(`${path}.amount`, "must be an exact non-negative base-10 decimal string");
  }
  const currency = boundedString(
    object.currency,
    `${path}.currency`,
    NORMALIZED_USAGE_RECEIPT_LIMITS.currencyLength,
  );
  if (!/^[A-Z]{3}$/.test(currency)) {
    fail(`${path}.currency`, "must be a three-letter uppercase ISO 4217 code");
  }
}

function validateAttributionMember(
  value: unknown,
  path: string,
  optional: boolean,
): void {
  const object = record(value, path);
  requiredKeys(object, ["id", "source", "trust"], path);
  allowedKeys(object, ["id", "source", "trust"], path);
  if (optional && object.id === null) {
    // Null is the authoritative snapshot of an unavailable optional member.
  } else {
    identifier(object.id, `${path}.id`);
  }
  if (object.source !== "server_derived") {
    fail(`${path}.source`, 'must equal "server_derived"');
  }
  if (object.trust !== "authoritative") {
    fail(`${path}.trust`, 'must equal "authoritative"');
  }
}

function validateAttribution(value: unknown, path: string): void {
  const object = record(value, path);
  const fields = [
    "organization",
    "project",
    "service_environment",
    "known_user",
    "session",
    "automation",
  ] as const;
  requiredKeys(object, fields, path);
  allowedKeys(object, fields, path);
  validateAttributionMember(object.organization, `${path}.organization`, false);
  validateAttributionMember(object.project, `${path}.project`, false);
  validateAttributionMember(
    object.service_environment,
    `${path}.service_environment`,
    false,
  );
  validateAttributionMember(object.known_user, `${path}.known_user`, true);
  validateAttributionMember(object.session, `${path}.session`, true);
  validateAttributionMember(object.automation, `${path}.automation`, true);
}

function validateProviderIdentity(
  value: unknown,
  path: string,
  maxLength: number,
  pattern: RegExp,
): void {
  const id = boundedString(value, path, maxLength);
  if (!pattern.test(id)) {
    fail(path, "must be a safe provider/model identifier");
  }
}

/** Strictly validates an untrusted receipt without coercing or rounding values. */
export function parseNormalizedUsageReceipt(
  value: unknown,
): NormalizedUsageReceipt {
  const object = record(value, "$receipt");
  const fields = [
    "version",
    "usage_receipt_id",
    "conversation_id",
    "turn_id",
    "logical_request_id",
    "trace_id",
    "attempt",
    "continuation",
    "provider_id",
    "model_id",
    "attribution",
    "source",
    "terminal_status",
    "tokens",
    "provider_cost",
  ] as const;
  requiredKeys(object, fields, "$receipt");
  allowedKeys(object, [...fields, "occurred_at"], "$receipt");
  if (object.version !== NORMALIZED_USAGE_RECEIPT_VERSION) {
    fail(
      "$receipt.version",
      `must equal ${NORMALIZED_USAGE_RECEIPT_VERSION}`,
    );
  }
  if (Object.hasOwn(object, "occurred_at")) {
    const occurredAt = boundedString(
      object.occurred_at,
      "$receipt.occurred_at",
      64,
    );
    const parsed = new Date(occurredAt);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== occurredAt) {
      fail("$receipt.occurred_at", "must be a canonical ISO-8601 timestamp");
    }
  }
  for (const field of [
    "usage_receipt_id",
    "conversation_id",
    "turn_id",
    "logical_request_id",
    "trace_id",
  ] as const) {
    identifier(object[field], `$receipt.${field}`);
  }
  validateIdentity(object.attempt, "$receipt.attempt");
  validateIdentity(object.continuation, "$receipt.continuation");
  validateProviderIdentity(
    object.provider_id,
    "$receipt.provider_id",
    NORMALIZED_USAGE_RECEIPT_LIMITS.providerIdLength,
    SAFE_PROVIDER_ID,
  );
  validateProviderIdentity(
    object.model_id,
    "$receipt.model_id",
    NORMALIZED_USAGE_RECEIPT_LIMITS.modelIdLength,
    SAFE_MODEL_ID,
  );
  validateAttribution(object.attribution, "$receipt.attribution");
  enumValue(object.source, USAGE_RECEIPT_SOURCES, "$receipt.source");
  enumValue(
    object.terminal_status,
    USAGE_RECEIPT_TERMINAL_STATUSES,
    "$receipt.terminal_status",
  );
  validateTokenUsage(object.tokens, "$receipt.tokens");
  validateCost(object.provider_cost, "$receipt.provider_cost");
  return value as NormalizedUsageReceipt;
}

export function isNormalizedUsageReceipt(
  value: unknown,
): value is NormalizedUsageReceipt {
  try {
    parseNormalizedUsageReceipt(value);
    return true;
  } catch {
    return false;
  }
}

function quantity(
  status: KnownUsageValueStatus,
  value: number,
): NormalizedUsageQuantity {
  return { status, value };
}

function snapshotAttribution(
  attribution: AuthoritativeAttribution,
): AuthoritativeAttribution {
  return {
    organization: { ...attribution.organization },
    project: { ...attribution.project },
    service_environment: { ...attribution.service_environment },
    known_user: { ...attribution.known_user },
    session: { ...attribution.session },
    automation: { ...attribution.automation },
  };
}

/**
 * Projects every field known by ProviderUsage into a validated receipt. The
 * caller explicitly supplies identity, attribution, source, and value quality.
 */
export function projectProviderUsageToReceipt(
  usage: ProviderUsage,
  context: ProviderUsageReceiptContext,
): NormalizedUsageReceipt {
  const providerCost: NormalizedUsageCost = usage.provider_cost.known
    ? {
        status: context.quality,
        amount: usage.provider_cost.amount,
        currency: usage.provider_cost.currency,
      }
    : { status: "unavailable" };

  return parseNormalizedUsageReceipt({
    version: NORMALIZED_USAGE_RECEIPT_VERSION,
    ...(context.occurred_at === undefined
      ? {}
      : { occurred_at: context.occurred_at }),
    usage_receipt_id: context.usage_receipt_id,
    conversation_id: context.conversation_id,
    turn_id: context.turn_id,
    logical_request_id: context.logical_request_id,
    trace_id: context.trace_id,
    attempt: { ...context.attempt },
    continuation: { ...context.continuation },
    provider_id: context.provider_id,
    model_id: context.model_id,
    attribution: snapshotAttribution(context.attribution),
    source: context.source,
    terminal_status: context.terminal_status,
    tokens: {
      input_tokens: quantity(context.quality, usage.input_tokens),
      cached_input_tokens: quantity(
        context.quality,
        usage.cached_input_tokens,
      ),
      ...(usage.cache_write_input_tokens === undefined ? {} : {
        cache_write_input_tokens: quantity(context.quality, usage.cache_write_input_tokens),
      }),
      output_tokens: quantity(context.quality, usage.output_tokens),
      reasoning_tokens: quantity(context.quality, usage.reasoning_tokens),
      total_tokens: quantity(context.quality, usage.total_tokens),
    },
    provider_cost: providerCost,
  });
}

/** Alias emphasizing that projection also strictly normalizes and validates. */
export const normalizeProviderUsageReceipt = projectProviderUsageToReceipt;
