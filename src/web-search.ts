import {
  normalizeCitationRecords,
  normalizeCitationSource,
  type CitationAttachmentTarget,
  type CitationRecordSet,
  type CitationSource,
} from "./citations.js";
import type { JsonObject, ToolDefinition } from "./protocol.js";
import type {
  ApplicationToolExecutor,
  ApplicationToolOutputProjection,
} from "./tools/executor.js";
import type {
  ToolDiscoverPredicate,
  ToolRegistration,
} from "./tools/registry.js";

/** Hard ceilings for the trusted-server web-search boundary. Overrides may only lower them. */
export const WEB_SEARCH_LIMITS = Object.freeze({
  queryUtf8Bytes: 1_024,
  idempotencyKeyUtf8Bytes: 128,
  requestedResults: 10,
  adapterResults: 20,
  sourceIdLength: 192,
  titleUtf8Bytes: 512,
  snippetUtf8Bytes: 4_096,
  urlUtf8Bytes: 2_048,
  redirectsPerResult: 5,
  totalSerializedUtf8Bytes: 65_536,
  timeoutMs: 15_000,
  idempotencyEntries: 256,
} as const);

export interface WebSearchLimits {
  readonly requestedResults: number;
  readonly adapterResults: number;
  readonly totalSerializedUtf8Bytes: number;
  readonly timeoutMs: number;
  readonly idempotencyEntries: number;
}

export type WebSearchErrorCode =
  | "invalid_request"
  | "authorization_denied"
  | "authorization_unavailable"
  | "result_denied"
  | "policy_unavailable"
  | "invalid_response"
  | "adapter_unavailable"
  | "cancelled"
  | "timeout"
  | "idempotency_conflict"
  | "capacity_exceeded";

const ERROR_MESSAGES: Readonly<Record<WebSearchErrorCode, string>> = Object.freeze({
  invalid_request: "Web search request is invalid.",
  authorization_denied: "Web search request was denied.",
  authorization_unavailable: "Web search authorization is temporarily unavailable.",
  result_denied: "Web search result was denied.",
  policy_unavailable: "Web search result policy is temporarily unavailable.",
  invalid_response: "Web search returned an invalid or unsafe result.",
  adapter_unavailable: "Web search is temporarily unavailable.",
  cancelled: "Web search was cancelled.",
  timeout: "Web search timed out.",
  idempotency_conflict: "Web search idempotency key conflicts with an earlier request.",
  capacity_exceeded: "Web search is temporarily unavailable.",
});

/** A deterministic public error. It deliberately has no cause or provider fields. */
export class WebSearchError extends Error {
  readonly code: WebSearchErrorCode;

  constructor(code: WebSearchErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "WebSearchError";
    this.code = code;
  }
}

export interface WebSearchInput {
  readonly query: string;
  readonly max_results: number;
  readonly idempotency_key: string;
}

export interface WebSearchExecutionContext<TContext = unknown> {
  readonly applicationContext: TContext;
  readonly signal: AbortSignal;
  /** Absolute Unix timestamp in milliseconds; it must be within the configured timeout. */
  readonly deadlineAt: number;
}

/** The only data sent to the injected host adapter. */
export interface WebSearchAdapterRequest {
  readonly query: string;
  readonly maxResults: number;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}

/**
 * Trusted-server host seam. Implementations own HTTP, provider SDKs, redirect
 * handling, and raw response disposal; they return only the documented data shape.
 */
export interface WebSearchAdapter {
  search(request: WebSearchAdapterRequest): unknown | Promise<unknown>;
}

export interface WebSearchAuthorizationInput<TContext = unknown>
  extends WebSearchAdapterRequest {
  readonly applicationContext: TContext;
}

export type WebSearchAuthorization<TContext = unknown> = (
  input: WebSearchAuthorizationInput<TContext>,
) => boolean | Promise<boolean>;

export type WebSearchUrlPurpose = "result" | "redirect";

export interface WebSearchUrlPolicyInput<TContext = unknown> {
  readonly applicationContext: TContext;
  readonly url: string;
  readonly hostname: string;
  readonly purpose: WebSearchUrlPurpose;
  readonly redirectIndex?: number;
  readonly signal: AbortSignal;
}

/** Must include the host's DNS/private-network and redirect checks. */
export type WebSearchUrlPolicy<TContext = unknown> = (
  input: WebSearchUrlPolicyInput<TContext>,
) => boolean | Promise<boolean>;

export interface WebSearchResult {
  readonly source_id: string;
  readonly title: string;
  readonly snippet: string;
  /** Canonical effective URL (the final validated redirect, when present). */
  readonly url: string;
  /** Canonical redirect destinations, all individually validated by the host. */
  readonly redirect_urls?: readonly string[];
}

export interface WebSearchResultPolicyInput<TContext = unknown> {
  readonly applicationContext: TContext;
  readonly result: WebSearchResult;
  readonly signal: AbortSignal;
}

export type WebSearchResultPolicy<TContext = unknown> = (
  input: WebSearchResultPolicyInput<TContext>,
) => boolean | Promise<boolean>;

export interface WebSearchResultSet {
  readonly results: readonly WebSearchResult[];
  readonly sources: readonly CitationSource[];
}

export interface WebSearchServiceOptions<TContext = unknown> {
  readonly adapter: WebSearchAdapter;
  readonly authorize: WebSearchAuthorization<TContext>;
  readonly validateUrl: WebSearchUrlPolicy<TContext>;
  readonly acceptResult: WebSearchResultPolicy<TContext>;
  readonly limits?: Partial<WebSearchLimits>;
  readonly now?: () => number;
}

type UnknownRecord = Record<string, unknown>;

interface NormalizedInput {
  readonly query: string;
  readonly maxResults: number;
  readonly idempotencyKey: string;
}

interface CandidateResult extends WebSearchResult {
  readonly validationUrls: readonly string[];
}

interface IdempotencyEntry {
  readonly fingerprint: string;
  readonly operation: Promise<WebSearchResultSet>;
  settled: boolean;
}

class InvalidRequest extends Error {}
class InvalidAdapterOutput extends Error {}
class OperationAborted extends Error {}

const UTF8_ENCODER = new TextEncoder();
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;
const CREDENTIAL_PARAMETERS = new Set([
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

function byteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.enumerable && "value" in descriptor,
  );
}

function record(value: unknown, ErrorType: typeof InvalidRequest): UnknownRecord {
  if (!isPlainRecord(value)) throw new ErrorType();
  return value;
}

function exactKeys(value: UnknownRecord, required: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== required.length || required.some((key) => !Object.hasOwn(value, key))) {
    throw new InvalidRequest();
  }
}

function boundedText(
  value: unknown,
  maximumBytes: number,
  ErrorType: typeof InvalidRequest | typeof InvalidAdapterOutput,
): string {
  if (typeof value !== "string") throw new ErrorType();
  const normalized = value.trim();
  if (normalized.length === 0 || byteLength(normalized) > maximumBytes) throw new ErrorType();
  for (const character of normalized) {
    const point = character.codePointAt(0);
    if (point !== undefined && (point <= 0x1f || point === 0x7f)) throw new ErrorType();
  }
  return normalized;
}

function normalizeInput(value: unknown, limits: Readonly<WebSearchLimits>): NormalizedInput {
  const input = record(value, InvalidRequest);
  exactKeys(input, ["query", "max_results", "idempotency_key"]);
  const query = boundedText(input.query, WEB_SEARCH_LIMITS.queryUtf8Bytes, InvalidRequest);
  if (CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(query))) throw new InvalidRequest();
  if (
    !Number.isSafeInteger(input.max_results) ||
    (input.max_results as number) < 1 ||
    (input.max_results as number) > limits.requestedResults
  ) throw new InvalidRequest();
  const idempotencyKey = boundedText(
    input.idempotency_key,
    WEB_SEARCH_LIMITS.idempotencyKeyUtf8Bytes,
    InvalidRequest,
  );
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) throw new InvalidRequest();
  return Object.freeze({
    query,
    maxResults: input.max_results as number,
    idempotencyKey,
  });
}

function plainArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new InvalidAdapterOutput();
  }
  if (value.length > maximum || Object.getOwnPropertySymbols(value).length > 0) {
    throw new InvalidAdapterOutput();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new InvalidAdapterOutput();
    }
  }
  const supported = new Set(["length", ...value.map((_, index) => String(index))]);
  if (Object.keys(descriptors).some((key) => !supported.has(key))) {
    throw new InvalidAdapterOutput();
  }
  return value;
}

function parseIpv4(hostname: string): readonly number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : undefined;
}

function isNonPublicIpv4(octets: readonly number[]): boolean {
  const first = octets[0] as number;
  const second = octets[1] as number;
  const third = octets[2] as number;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function parseIpv6(hostname: string): bigint | undefined {
  const address = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (!address.includes(":")) return undefined;
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]?.split(":") ?? [];
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]?.split(":") ?? [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return undefined;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  const segments = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (segments.length !== 8) return undefined;
  return segments.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
}

function isNonPublicIpv6(address: bigint): boolean {
  const mappedPrefix = 0xffffn << 32n;
  const mappedMask = ((1n << 128n) - 1n) ^ ((1n << 32n) - 1n);
  if ((address & mappedMask) === mappedPrefix || (address & mappedMask) === 0n) {
    const ipv4 = Number(address & 0xffff_ffffn);
    return isNonPublicIpv4([
      (ipv4 >>> 24) & 0xff,
      (ipv4 >>> 16) & 0xff,
      (ipv4 >>> 8) & 0xff,
      ipv4 & 0xff,
    ]);
  }
  // Only global unicast literals are candidates; documentation space remains non-public.
  if ((address >> 125n) !== 1n) return true; // outside 2000::/3
  return (address >> 96n) === 0x20010db8n;
}

function hasCredentialMaterial(url: URL): boolean {
  if (url.username !== "" || url.password !== "") return true;
  const parameterSets = [
    url.searchParams,
    new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash),
  ];
  for (const parameters of parameterSets) {
    for (const [name, value] of parameters) {
      const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        CREDENTIAL_PARAMETERS.has(key) ||
        CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))
      ) return true;
    }
  }
  return CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(url.hash));
}

function canonicalUrl(value: unknown): { readonly url: string; readonly hostname: string } {
  const raw = boundedText(value, WEB_SEARCH_LIMITS.urlUtf8Bytes, InvalidAdapterOutput);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidAdapterOutput();
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || hasCredentialMaterial(parsed)) {
    throw new InvalidAdapterOutput();
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new InvalidAdapterOutput();
  }
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined && isNonPublicIpv4(ipv4)) throw new InvalidAdapterOutput();
  const ipv6 = parseIpv6(hostname);
  if (ipv6 !== undefined && isNonPublicIpv6(ipv6)) throw new InvalidAdapterOutput();
  parsed.hostname = hostname;
  parsed.searchParams.sort();
  parsed.hash = "";
  const canonical = parsed.href;
  if (byteLength(canonical) > WEB_SEARCH_LIMITS.urlUtf8Bytes) {
    throw new InvalidAdapterOutput();
  }
  return Object.freeze({ url: canonical, hostname });
}

function normalizeCandidate(value: unknown): CandidateResult {
  const input = record(value, InvalidAdapterOutput);
  const allowed = new Set(["source_id", "title", "snippet", "url", "redirect_urls"]);
  if (
    !["source_id", "title", "snippet", "url"].every((key) => Object.hasOwn(input, key)) ||
    Object.keys(input).some((key) => !allowed.has(key))
  ) throw new InvalidAdapterOutput();
  const sourceId = boundedText(
    input.source_id,
    WEB_SEARCH_LIMITS.sourceIdLength,
    InvalidAdapterOutput,
  );
  if (!SOURCE_ID_PATTERN.test(sourceId)) throw new InvalidAdapterOutput();
  const title = boundedText(input.title, WEB_SEARCH_LIMITS.titleUtf8Bytes, InvalidAdapterOutput);
  const snippet = boundedText(
    input.snippet,
    WEB_SEARCH_LIMITS.snippetUtf8Bytes,
    InvalidAdapterOutput,
  );
  const initial = canonicalUrl(input.url);
  const redirects = Object.hasOwn(input, "redirect_urls")
    ? plainArray(input.redirect_urls, WEB_SEARCH_LIMITS.redirectsPerResult).map(canonicalUrl)
    : [];
  const effective = redirects.at(-1) ?? initial;
  const redirectUrls = Object.freeze(redirects.map(({ url }) => url));
  const result: CandidateResult = {
    source_id: sourceId,
    title,
    snippet,
    url: effective.url,
    ...(redirectUrls.length === 0 ? {} : { redirect_urls: redirectUrls }),
    validationUrls: Object.freeze([initial.url, ...redirectUrls]),
  };
  return Object.freeze(result);
}

function normalizeAdapterOutput(value: unknown, maximum: number): readonly CandidateResult[] {
  const output = record(value, InvalidAdapterOutput);
  if (Object.keys(output).length !== 1 || !Object.hasOwn(output, "results")) {
    throw new InvalidAdapterOutput();
  }
  return Object.freeze(plainArray(output.results, maximum).map(normalizeCandidate));
}

function resolvedLimits(overrides: Partial<WebSearchLimits> | undefined): Readonly<WebSearchLimits> {
  const resolved = {
    requestedResults: overrides?.requestedResults ?? WEB_SEARCH_LIMITS.requestedResults,
    adapterResults: overrides?.adapterResults ?? WEB_SEARCH_LIMITS.adapterResults,
    totalSerializedUtf8Bytes:
      overrides?.totalSerializedUtf8Bytes ?? WEB_SEARCH_LIMITS.totalSerializedUtf8Bytes,
    timeoutMs: overrides?.timeoutMs ?? WEB_SEARCH_LIMITS.timeoutMs,
    idempotencyEntries: overrides?.idempotencyEntries ?? WEB_SEARCH_LIMITS.idempotencyEntries,
  };
  for (const [name, value] of Object.entries(resolved)) {
    const ceiling = WEB_SEARCH_LIMITS[name as keyof WebSearchLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) throw new TypeError(
      `Web-search limit ${name} must be a positive integer no greater than ${ceiling}.`,
    );
  }
  if (resolved.adapterResults < resolved.requestedResults) {
    throw new TypeError("Web-search adapterResults must be at least requestedResults.");
  }
  return Object.freeze(resolved);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === "object" &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function";
}

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new OperationAborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new OperationAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function fingerprint(input: NormalizedInput): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new WebSearchError("capacity_exceeded");
  const bytes = UTF8_ENCODER.encode(
    `${input.query.length}:${input.query}\n${input.maxResults}`,
  );
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function publicResult(candidate: CandidateResult): WebSearchResult {
  return Object.freeze({
    source_id: candidate.source_id,
    title: candidate.title,
    snippet: candidate.snippet,
    url: candidate.url,
    ...(candidate.redirect_urls === undefined ? {} : { redirect_urls: candidate.redirect_urls }),
  });
}

/** Bounded, idempotent orchestration for one injected trusted-server adapter. */
export class WebSearchService<TContext = unknown> {
  readonly #adapter: WebSearchAdapter;
  readonly #authorize: WebSearchAuthorization<TContext>;
  readonly #validateUrl: WebSearchUrlPolicy<TContext>;
  readonly #acceptResult: WebSearchResultPolicy<TContext>;
  readonly #limits: Readonly<WebSearchLimits>;
  readonly #now: () => number;
  readonly #entries = new Map<string, IdempotencyEntry>();

  constructor(options: WebSearchServiceOptions<TContext>) {
    if (typeof options?.adapter?.search !== "function") throw new TypeError("adapter is required");
    if (typeof options.authorize !== "function") throw new TypeError("authorize is required");
    if (typeof options.validateUrl !== "function") throw new TypeError("validateUrl is required");
    if (typeof options.acceptResult !== "function") throw new TypeError("acceptResult is required");
    this.#adapter = options.adapter;
    this.#authorize = options.authorize;
    this.#validateUrl = options.validateUrl;
    this.#acceptResult = options.acceptResult;
    this.#limits = resolvedLimits(options.limits);
    this.#now = options.now ?? Date.now;
  }

  /** Produces the latest acceptable absolute deadline for a new call. */
  deadlineFromNow(): number {
    return this.#now() + this.#limits.timeoutMs;
  }

  async search(
    input: unknown,
    context: WebSearchExecutionContext<TContext>,
  ): Promise<WebSearchResultSet> {
    let normalized: NormalizedInput;
    try {
      normalized = normalizeInput(input, this.#limits);
      if (!isAbortSignal(context?.signal) || !Number.isSafeInteger(context.deadlineAt)) {
        throw new InvalidRequest();
      }
    } catch {
      if (context?.signal?.aborted) throw new WebSearchError("cancelled");
      throw new WebSearchError("invalid_request");
    }

    if (context.signal.aborted) throw new WebSearchError("cancelled");
    const now = this.#now();
    if (context.deadlineAt <= now) throw new WebSearchError("timeout");
    if (context.deadlineAt > now + this.#limits.timeoutMs) {
      throw new WebSearchError("invalid_request");
    }
    const requestFingerprint = await fingerprint(normalized);
    const existing = this.#entries.get(normalized.idempotencyKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new WebSearchError("idempotency_conflict");
      }
      return existing.operation;
    }
    this.#makeRoom();
    const operation = this.#executeOnce(normalized, context);
    const entry: IdempotencyEntry = {
      fingerprint: requestFingerprint,
      operation,
      settled: false,
    };
    this.#entries.set(normalized.idempotencyKey, entry);
    void operation.then(
      () => { entry.settled = true; },
      () => { entry.settled = true; },
    );
    return operation;
  }

  #makeRoom(): void {
    if (this.#entries.size < this.#limits.idempotencyEntries) return;
    for (const [key, entry] of this.#entries) {
      if (entry.settled) {
        this.#entries.delete(key);
        if (this.#entries.size < this.#limits.idempotencyEntries) return;
      }
    }
    throw new WebSearchError("capacity_exceeded");
  }

  async #executeOnce(
    input: NormalizedInput,
    context: WebSearchExecutionContext<TContext>,
  ): Promise<WebSearchResultSet> {
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    context.signal.addEventListener("abort", onCallerAbort, { once: true });
    const remaining = Math.max(0, context.deadlineAt - this.#now());
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remaining);
    const adapterRequest = Object.freeze({
      query: input.query,
      maxResults: input.maxResults,
      idempotencyKey: input.idempotencyKey,
      signal: controller.signal,
      deadlineAt: context.deadlineAt,
    });
    const authorizationInput = Object.freeze({
      ...adapterRequest,
      applicationContext: context.applicationContext,
    });

    try {
      let authorized: boolean;
      try {
        authorized = await raceWithSignal(
          Promise.resolve().then(() => this.#authorize(authorizationInput)),
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted || error instanceof OperationAborted) throw error;
        throw new WebSearchError("authorization_unavailable");
      }
      if (authorized !== true) throw new WebSearchError("authorization_denied");

      let rawOutput: unknown;
      try {
        rawOutput = await raceWithSignal(
          Promise.resolve().then(() => this.#adapter.search(adapterRequest)),
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted || error instanceof OperationAborted) throw error;
        throw new WebSearchError("adapter_unavailable");
      }

      let candidates: readonly CandidateResult[];
      try {
        candidates = normalizeAdapterOutput(rawOutput, this.#limits.adapterResults);
      } catch {
        throw new WebSearchError("invalid_response");
      } finally {
        rawOutput = undefined;
      }

      const retained: WebSearchResult[] = [];
      const sources: CitationSource[] = [];
      const seenUrls = new Set<string>();
      const seenSourceIds = new Set<string>();
      for (const candidate of candidates) {
        for (const [index, url] of candidate.validationUrls.entries()) {
          const parsed = new URL(url);
          let accepted: boolean;
          try {
            accepted = await raceWithSignal(
              Promise.resolve().then(() => this.#validateUrl(Object.freeze({
                applicationContext: context.applicationContext,
                url,
                hostname: parsed.hostname,
                purpose: index === 0 ? "result" : "redirect",
                ...(index === 0 ? {} : { redirectIndex: index - 1 }),
                signal: controller.signal,
              }))),
              controller.signal,
            );
          } catch (error) {
            if (controller.signal.aborted || error instanceof OperationAborted) throw error;
            throw new WebSearchError("policy_unavailable");
          }
          if (accepted !== true) throw new WebSearchError("result_denied");
        }

        const result = publicResult(candidate);
        let accepted: boolean;
        try {
          accepted = await raceWithSignal(
            Promise.resolve().then(() => this.#acceptResult(Object.freeze({
              applicationContext: context.applicationContext,
              result,
              signal: controller.signal,
            }))),
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted || error instanceof OperationAborted) throw error;
          throw new WebSearchError("policy_unavailable");
        }
        if (accepted !== true) throw new WebSearchError("result_denied");

        if (
          retained.length >= input.maxResults ||
          seenUrls.has(result.url) ||
          seenSourceIds.has(result.source_id)
        ) continue;
        const source = normalizeCitationSource({
          source_id: result.source_id,
          type: "web",
          label: result.title,
          locator: result.url,
        });
        retained.push(result);
        sources.push(source);
        seenUrls.add(result.url);
        seenSourceIds.add(result.source_id);
      }

      const output = Object.freeze({
        results: Object.freeze(retained),
        sources: Object.freeze(sources),
      });
      if (byteLength(JSON.stringify(output)) > this.#limits.totalSerializedUtf8Bytes) {
        throw new WebSearchError("invalid_response");
      }
      return output;
    } catch (error) {
      if (error instanceof WebSearchError) throw error;
      if (controller.signal.aborted || error instanceof OperationAborted) {
        throw new WebSearchError(timedOut ? "timeout" : "cancelled");
      }
      throw new WebSearchError("adapter_unavailable");
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", onCallerAbort);
    }
  }
}

/** Projects one accepted result set onto the shared citation model in stable result order. */
export function createWebSearchCitationRecords(
  resultSet: WebSearchResultSet,
  target: CitationAttachmentTarget,
): CitationRecordSet {
  return normalizeCitationRecords({
    sources: resultSet.sources,
    citations: resultSet.sources.map((source, order) => ({
      citation_id: `web_search:${source.source_id}`,
      source_id: source.source_id,
      order,
      target,
    })),
  });
}

const WEB_SEARCH_TOOL_DEFINITION_VALUE: ToolDefinition = {
  name: "web_search",
  description: "Search the public web through the application's trusted server.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 1_024 },
      max_results: {
        type: "integer",
        minimum: 1,
        maximum: WEB_SEARCH_LIMITS.requestedResults,
      },
      idempotency_key: { type: "string", minLength: 1, maxLength: 128 },
    },
    required: ["query", "max_results", "idempotency_key"],
    additionalProperties: false,
  },
};

export const WEB_SEARCH_TOOL_DEFINITION: ToolDefinition = Object.freeze(
  WEB_SEARCH_TOOL_DEFINITION_VALUE,
);

export interface WebSearchToolRegistrationOptions<
  TContext = unknown,
  TDiscoveryContext = unknown,
> {
  readonly service: WebSearchService<TContext>;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly discover?: ToolDiscoverPredicate<TDiscoveryContext>;
}

/** Creates an optional trusted-server registration for ToolRegistry/BoundedToolExecutor. */
export function createWebSearchToolRegistration<
  TContext = unknown,
  TDiscoveryContext = unknown,
>(
  options: WebSearchToolRegistrationOptions<TContext, TDiscoveryContext>,
): ToolRegistration<ApplicationToolExecutor<TContext>, TDiscoveryContext> {
  const executor: ApplicationToolExecutor<TContext> = async (arguments_, context) => {
    const resultSet = await options.service.search(arguments_, {
      applicationContext: context.applicationContext,
      signal: context.signal,
      deadlineAt: options.service.deadlineFromNow(),
    });
    const citationRecords = createWebSearchCitationRecords(
      resultSet,
      { type: "tool_result", tool_call_id: context.toolCallId as never },
    );
    const content: JsonObject = {
      results: resultSet.results.map((result) => ({
        source_id: result.source_id,
        title: result.title,
        snippet: result.snippet,
        url: result.url,
        ...(result.redirect_urls === undefined
          ? {}
          : { redirect_urls: [...result.redirect_urls] }),
      })),
    };
    const projection: ApplicationToolOutputProjection = {
      type: "handrail.application_tool_output",
      content,
      citation_records: citationRecords,
    };
    return projection;
  };
  return Object.freeze({
    definition: WEB_SEARCH_TOOL_DEFINITION,
    executor,
    tags: Object.freeze(["web-search", ...(options.tags ?? [])]),
    capabilities: Object.freeze(["trusted-server", ...(options.capabilities ?? [])]),
    ...(options.discover === undefined ? {} : { discover: options.discover }),
  });
}
