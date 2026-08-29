export const CITATION_SOURCE_TYPES = Object.freeze([
  "web",
  "document",
  "tool",
] as const);

export const CITATION_ATTACHMENT_TARGET_TYPES = Object.freeze([
  "assistant_message",
  "tool_result",
] as const);

/** Schemes allowed for public web-source locators. */
export const CITATION_SAFE_WEB_SCHEMES = Object.freeze([
  "http:",
  "https:",
] as const);

/** Conservative limits for one normalized citation record set. */
export const CITATION_LIMITS = Object.freeze({
  sourcesPerRecordSet: 64,
  citationsPerRecordSet: 256,
  identifierLength: 256,
  labelLength: 512,
  locatorLength: 2_048,
  totalSerializedUtf8Bytes: 131_072,
} as const);

declare const opaqueCitationValue: unique symbol;
type OpaqueString<Name extends string> = string & {
  readonly [opaqueCitationValue]: Name;
};

export type CitationSourceId = OpaqueString<"CitationSourceId">;
export type CitationId = OpaqueString<"CitationId">;
export type CitationMessageId = OpaqueString<"CitationMessageId">;
export type CitationToolCallId = OpaqueString<"CitationToolCallId">;
export type CitationSourceType = (typeof CITATION_SOURCE_TYPES)[number];
export type CitationAttachmentTargetType =
  (typeof CITATION_ATTACHMENT_TARGET_TYPES)[number];

/** A provider-neutral source. It intentionally cannot retain native payloads. */
export interface CitationSource {
  readonly source_id: CitationSourceId;
  readonly type: CitationSourceType;
  readonly label: string;
  /** A safe public URL for web sources or a bounded opaque locator otherwise. */
  readonly locator?: string;
}

export interface AssistantMessageCitationTarget {
  readonly type: "assistant_message";
  readonly message_id: CitationMessageId;
}

export interface ToolResultCitationTarget {
  readonly type: "tool_result";
  /** Tool results in the core protocol are stably identified by tool_call_id. */
  readonly tool_call_id: CitationToolCallId;
}

export type CitationAttachmentTarget =
  | AssistantMessageCitationTarget
  | ToolResultCitationTarget;

/** A stable, explicitly ordered link from an attachment target to a source. */
export interface Citation {
  readonly citation_id: CitationId;
  readonly source_id: CitationSourceId;
  readonly order: number;
  readonly target: CitationAttachmentTarget;
}

export interface CitationRecordSet {
  readonly sources: readonly CitationSource[];
  readonly citations: readonly Citation[];
}

export class CitationValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "CitationValidationError";
    this.path = path;
  }
}

type UnknownRecord = Record<string, unknown>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const OPAQUE_LOCATOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/#?=&%+~-]*$/;
const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;
const CREDENTIAL_QUERY_PARAMETERS = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "clientsecret",
  "credential",
  "key",
  "password",
  "passwd",
  "secret",
  "sig",
  "signature",
  "token",
]);

const fail = (path: string, message: string): never => {
  throw new CitationValidationError(path, message);
};

const record = (value: unknown, path: string): UnknownRecord => {
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
};

const allowedKeys = (
  value: UnknownRecord,
  keys: readonly string[],
  path: string,
): void => {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, "is not a supported field");
  }
};

const requiredKeys = (
  value: UnknownRecord,
  keys: readonly string[],
  path: string,
): void => {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
};

const boundedString = (
  value: unknown,
  path: string,
  maxLength: number,
): string => {
  if (typeof value !== "string") fail(path, "must be a string");
  const raw = value as string;
  if (raw.length > maxLength) {
    fail(path, `must be at most ${maxLength} characters`);
  }
  const normalized = raw.trim();
  if (normalized.length === 0) fail(path, "must not be empty");
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      fail(path, "must not contain control characters");
    }
  }
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    fail(path, "must not contain credential material");
  }
  return normalized;
};

const identifier = <TIdentifier extends string>(
  value: unknown,
  path: string,
): TIdentifier => {
  const normalized = boundedString(
    value,
    path,
    CITATION_LIMITS.identifierLength,
  );
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    fail(
      path,
      "must use letters, numbers, dot, underscore, colon, at-sign, or hyphen",
    );
  }
  return normalized as TIdentifier;
};

const enumValue = <TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  path: string,
): TValue => {
  if (typeof value !== "string" || !allowed.includes(value as TValue)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as TValue;
};

const parseIpv4 = (hostname: string): number[] | undefined => {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return undefined;
  }
  return octets;
};

const isUnsafeIpv4 = (octets: readonly number[]): boolean => {
  const first = octets[0] as number;
  const second = octets[1] as number;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
};

const parseIpv6 = (hostname: string): bigint | undefined => {
  const unwrapped = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (!unwrapped.includes(":")) return undefined;

  const halves = unwrapped.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]?.split(":") ?? [];
  const right = halves.length === 1 || halves[1] === ""
    ? []
    : halves[1]?.split(":") ?? [];
  if (left.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return undefined;
  if (right.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return undefined;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  const segments = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (segments.length !== 8) return undefined;
  return segments.reduce(
    (result, segment) => (result << 16n) | BigInt(`0x${segment}`),
    0n,
  );
};

const IPV6_LINK_LOCAL_PREFIX = 0xfe80n << 112n;
const IPV6_LINK_LOCAL_MASK = 0xffc0n << 112n;
const IPV6_UNIQUE_LOCAL_PREFIX = 0xfc00n << 112n;
const IPV6_UNIQUE_LOCAL_MASK = 0xfe00n << 112n;
const IPV6_MAPPED_PREFIX = 0xffffn << 32n;
const IPV6_MAPPED_MASK = (1n << 128n) - (1n << 32n);

const isUnsafeIpv6 = (address: bigint): boolean => {
  if (address === 0n || address === 1n) return true;
  if ((address & IPV6_LINK_LOCAL_MASK) === IPV6_LINK_LOCAL_PREFIX) return true;
  if ((address & IPV6_UNIQUE_LOCAL_MASK) === IPV6_UNIQUE_LOCAL_PREFIX) return true;

  const prefix = address & IPV6_MAPPED_MASK;
  if (prefix === 0n || prefix === IPV6_MAPPED_PREFIX) {
    const ipv4 = Number(address & 0xffffffffn);
    return isUnsafeIpv4([
      (ipv4 >>> 24) & 0xff,
      (ipv4 >>> 16) & 0xff,
      (ipv4 >>> 8) & 0xff,
      ipv4 & 0xff,
    ]);
  }
  return false;
};

const normalizeWebLocator = (value: unknown, path: string): string => {
  const locator = boundedString(value, path, CITATION_LIMITS.locatorLength);
  const url = (() => {
    try {
      return new URL(locator);
    } catch {
      return fail(path, "must be a valid absolute URL");
    }
  })();
  if (!CITATION_SAFE_WEB_SCHEMES.includes(url.protocol as "http:" | "https:")) {
    fail(path, `must use one of: ${CITATION_SAFE_WEB_SCHEMES.join(", ")}`);
  }
  if (url.username !== "" || url.password !== "") {
    fail(path, "must not contain credentials");
  }
  const parameterSets = [
    url.searchParams,
    new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash),
  ];
  for (const parameters of parameterSets) {
    for (const [name, parameterValue] of parameters) {
      const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        CREDENTIAL_QUERY_PARAMETERS.has(normalizedName) ||
        CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(parameterValue))
      ) {
        fail(path, "must not contain credential query parameters or fragments");
      }
    }
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    fail(path, "must not target localhost");
  }
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined && isUnsafeIpv4(ipv4)) {
    fail(path, "must not target a private or non-public IPv4 address");
  }
  const ipv6 = parseIpv6(hostname);
  if (ipv6 !== undefined && isUnsafeIpv6(ipv6)) {
    fail(path, "must not target a private or non-public IPv6 address");
  }
  const normalized = url.href;
  if (normalized.length > CITATION_LIMITS.locatorLength) {
    fail(
      path,
      `must normalize to at most ${CITATION_LIMITS.locatorLength} characters`,
    );
  }
  return normalized;
};

const normalizeOpaqueLocator = (value: unknown, path: string): string => {
  const locator = boundedString(value, path, CITATION_LIMITS.locatorLength);
  if (!OPAQUE_LOCATOR_PATTERN.test(locator) || locator.includes("://")) {
    fail(path, "must be a bounded provider-neutral opaque locator");
  }
  if (
    /(?:^|[?&#;])(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|credential|password|passwd|secret|sig(?:nature)?|token)=/i.test(
      locator,
    )
  ) {
    fail(path, "must not contain credential parameters");
  }
  return locator;
};

/** Strictly validates, clones, canonicalizes, and freezes one source. */
export const normalizeCitationSource = (input: unknown): CitationSource => {
  const source = record(input, "$source");
  requiredKeys(source, ["source_id", "type", "label"], "$source");
  allowedKeys(source, ["source_id", "type", "label", "locator"], "$source");
  const sourceId = identifier<CitationSourceId>(source.source_id, "$source.source_id");
  const type = enumValue(source.type, CITATION_SOURCE_TYPES, "$source.type");
  const label = boundedString(source.label, "$source.label", CITATION_LIMITS.labelLength);
  const locator = Object.hasOwn(source, "locator")
    ? type === "web"
      ? normalizeWebLocator(source.locator, "$source.locator")
      : normalizeOpaqueLocator(source.locator, "$source.locator")
    : undefined;
  return Object.freeze({
    source_id: sourceId,
    type,
    label,
    ...(locator === undefined ? {} : { locator }),
  });
};

const normalizeTarget = (input: unknown): CitationAttachmentTarget => {
  const target = record(input, "$citation.target");
  requiredKeys(target, ["type"], "$citation.target");
  const type = enumValue(
    target.type,
    CITATION_ATTACHMENT_TARGET_TYPES,
    "$citation.target.type",
  );
  if (type === "assistant_message") {
    requiredKeys(target, ["message_id"], "$citation.target");
    allowedKeys(target, ["type", "message_id"], "$citation.target");
    return Object.freeze({
      type,
      message_id: identifier<CitationMessageId>(
        target.message_id,
        "$citation.target.message_id",
      ),
    });
  }
  requiredKeys(target, ["tool_call_id"], "$citation.target");
  allowedKeys(target, ["type", "tool_call_id"], "$citation.target");
  return Object.freeze({
    type,
    tool_call_id: identifier<CitationToolCallId>(
      target.tool_call_id,
      "$citation.target.tool_call_id",
    ),
  });
};

/** Strictly validates, clones, canonicalizes, and deeply freezes one citation. */
export const normalizeCitation = (input: unknown): Citation => {
  const citation = record(input, "$citation");
  requiredKeys(
    citation,
    ["citation_id", "source_id", "order", "target"],
    "$citation",
  );
  allowedKeys(
    citation,
    ["citation_id", "source_id", "order", "target"],
    "$citation",
  );
  if (!Number.isSafeInteger(citation.order) || (citation.order as number) < 0) {
    fail("$citation.order", "must be a non-negative safe integer");
  }
  return Object.freeze({
    citation_id: identifier<CitationId>(
      citation.citation_id,
      "$citation.citation_id",
    ),
    source_id: identifier<CitationSourceId>(
      citation.source_id,
      "$citation.source_id",
    ),
    order: citation.order as number,
    target: normalizeTarget(citation.target),
  });
};

const array = (value: unknown, path: string, maxLength: number): unknown[] => {
  if (!Array.isArray(value)) fail(path, "must be an array");
  const values = value as unknown[];
  if (Object.getPrototypeOf(values) !== Array.prototype) {
    fail(path, "must be a plain JSON array");
  }
  if (Object.getOwnPropertySymbols(values).length > 0) {
    fail(path, "must contain only JSON array entries");
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(values),
  )) {
    if (key === "length") continue;
    const index = Number(key);
    if (
      !/^(?:0|[1-9]\d*)$/.test(key) ||
      !Number.isSafeInteger(index) ||
      index >= values.length
    ) {
      fail(`${path}.${key}`, "is not a supported array field");
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      fail(`${path}[${key}]`, "must be an enumerable JSON data entry");
    }
  }
  if (values.length > maxLength) {
    fail(path, `must contain at most ${maxLength} records`);
  }
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index)) fail(`${path}[${index}]`, "must be a JSON value");
  }
  return values;
};

const deduplicateByIdentity = <TRecord>(
  records: readonly TRecord[],
  identity: (record: TRecord) => string,
  kind: string,
): TRecord[] => {
  const retained = new Map<string, { record: TRecord; fingerprint: string }>();
  for (const current of records) {
    const id = identity(current);
    const fingerprint = JSON.stringify(current);
    const existing = retained.get(id);
    if (existing === undefined) {
      retained.set(id, { record: current, fingerprint });
    } else if (existing.fingerprint !== fingerprint) {
      fail(`$${kind}[${id}]`, `conflicts with an earlier record using the same identity`);
    }
  }
  return [...retained.values()].map(({ record: retainedRecord }) => retainedRecord);
};

const UTF8_ENCODER = new TextEncoder();

/**
 * Normalizes and deduplicates a complete set. Exact duplicates retain the
 * first-seen clone and collection order; conflicting identity reuse is rejected.
 */
export const deduplicateCitationRecords = (
  sourcesInput: unknown,
  citationsInput: unknown,
): CitationRecordSet => {
  const sourceValues = array(
    sourcesInput,
    "$records.sources",
    CITATION_LIMITS.sourcesPerRecordSet,
  );
  const citationValues = array(
    citationsInput,
    "$records.citations",
    CITATION_LIMITS.citationsPerRecordSet,
  );
  const sources = deduplicateByIdentity(
    sourceValues.map(normalizeCitationSource),
    (source) => source.source_id,
    "sources",
  );
  const citations = deduplicateByIdentity(
    citationValues.map(normalizeCitation),
    (citation) => citation.citation_id,
    "citations",
  );
  const sourceIds = new Set(sources.map((source) => source.source_id));
  for (const citation of citations) {
    if (!sourceIds.has(citation.source_id)) {
      fail(
        `$citations[${citation.citation_id}].source_id`,
        "must reference a source in the same record set",
      );
    }
  }
  const normalized: CitationRecordSet = {
    sources: Object.freeze(sources),
    citations: Object.freeze(citations),
  };
  const serializedBytes = UTF8_ENCODER.encode(JSON.stringify(normalized)).byteLength;
  if (serializedBytes > CITATION_LIMITS.totalSerializedUtf8Bytes) {
    fail(
      "$records",
      `must serialize to at most ${CITATION_LIMITS.totalSerializedUtf8Bytes} UTF-8 bytes`,
    );
  }
  return Object.freeze(normalized);
};

/** Strict object-form parser for untrusted citation record sets. */
export const normalizeCitationRecords = (input: unknown): CitationRecordSet => {
  const records = record(input, "$records");
  requiredKeys(records, ["sources", "citations"], "$records");
  allowedKeys(records, ["sources", "citations"], "$records");
  return deduplicateCitationRecords(records.sources, records.citations);
};

export const isCitationSource = (input: unknown): input is CitationSource => {
  try {
    normalizeCitationSource(input);
    return true;
  } catch {
    return false;
  }
};

export const isCitation = (input: unknown): input is Citation => {
  try {
    normalizeCitation(input);
    return true;
  } catch {
    return false;
  }
};
