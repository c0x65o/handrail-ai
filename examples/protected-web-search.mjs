import {
  WEB_SEARCH_LIMITS,
  WebSearchService,
  createWebSearchCitationRecords,
} from "@handrail/ai";
import {
  TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
  TrustedServerOperationFailureV1,
  createTrustedServerRequestProtectorV1,
} from "@handrail/ai/server/trusted-server";

/**
 * Framework-neutral trusted-server recipe for exactly one web-search action.
 *
 * A host should construct these request descriptors from route metadata and
 * pass the raw, bounded body separately. The protection hooks see only public request
 * descriptors; the body is parsed and its query disclosed to the search policy
 * and host adapter only after every outer denial gate has passed.
 */

export const PROTECTED_WEB_SEARCH_ACTION_ID = "web_search.search";
export const PROTECTED_WEB_SEARCH_MAXIMUM_BODY_BYTES = 4_096;
export const PROTECTED_WEB_SEARCH_MAXIMUM_DEADLINE_MS = 1_000;

const ENCODER = new globalThis.TextEncoder();

/** @typedef {{ readonly sessionReference: string }} ExampleAuthentication */
/** @typedef {{ readonly id: string, readonly label?: string }} ExamplePrincipal */
/** @typedef {{ readonly key: string, readonly fingerprint: string }} ExampleReservation */
/** @typedef {{ readonly id: string }} ExampleLease */
/** @typedef {{ readonly principalId: string, readonly resourceId: string }} SearchContext */

/**
 * @typedef {object} ProtectedWebSearchInput
 * @property {string} requestId
 * @property {string} origin
 * @property {import("@handrail/ai/server/trusted-server").TrustedServerPublicResourceV1} resource
 * @property {string} idempotencyKey
 * @property {unknown} bodyText
 * @property {ExampleAuthentication} authentication
 * @property {AbortSignal=} signal
 * @property {number=} deadlineMs
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.getOwnPropertySymbols(value).length === 0;
}

/**
 * Raw body access intentionally occurs inside the protected operation.
 * WebSearchService performs the authoritative query/count bounds afterward.
 *
 * @param {unknown} bodyText
 * @param {string} idempotencyKey
 */
function parseSearchBody(bodyText, idempotencyKey) {
  if (typeof bodyText !== "string") throw new TypeError("Invalid web-search body");
  const value = JSON.parse(bodyText);
  if (!isPlainRecord(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "query") || !Object.hasOwn(value, "max_results")) {
    throw new TypeError("Invalid web-search body");
  }
  return Object.freeze({
    query: value.query,
    max_results: value.max_results,
    idempotency_key: idempotencyKey,
  });
}

/**
 * @param {unknown} bodyText
 * @param {import("@handrail/ai/server/trusted-server").TrustedServerPublicResourceV1} resource
 */
async function describeBody(bodyText, resource) {
  if (typeof bodyText !== "string") {
    return { byteLength: PROTECTED_WEB_SEARCH_MAXIMUM_BODY_BYTES + 1, fingerprint: "invalid.body" };
  }
  const bytes = ENCODER.encode(bodyText);
  if (bytes.byteLength > PROTECTED_WEB_SEARCH_MAXIMUM_BODY_BYTES) {
    return { byteLength: bytes.byteLength, fingerprint: "invalid.body" };
  }
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    ENCODER.encode(`${PROTECTED_WEB_SEARCH_ACTION_ID}\n${resource.id}\n${bodyText}`),
  );
  return {
    byteLength: bytes.byteLength,
    fingerprint: [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join(""),
  };
}

/**
 * @param {import("@handrail/ai").WebSearchResultSet} resultSet
 * @param {string} requestId
 */
function normalizedPublicValue(resultSet, requestId) {
  const records = createWebSearchCitationRecords(resultSet, {
    type: "tool_result",
    tool_call_id: /** @type {import("@handrail/ai").CitationToolCallId} */ (requestId),
  });
  return {
    results: resultSet.results.map((result) => ({
      source_id: result.source_id,
      title: result.title,
      snippet: result.snippet,
      url: result.url,
      ...(result.redirect_urls === undefined
        ? {}
        : { redirect_urls: [...result.redirect_urls] }),
    })),
    citation_records: {
      sources: records.sources.map((source) => ({
        source_id: source.source_id,
        type: source.type,
        label: source.label,
        ...(source.locator === undefined ? {} : { locator: source.locator }),
      })),
      citations: records.citations.map((citation) => ({
        citation_id: citation.citation_id,
        source_id: citation.source_id,
        order: citation.order,
        target: { ...citation.target },
      })),
    },
  };
}

/**
 * Build the framework/router-independent boundary. Authentication material,
 * resource policy, rate limiting, idempotency, concurrency, retention, URL
 * policy, result policy, and the host search adapter are all injected seams.
 *
 * @param {object} options
 * @param {import("@handrail/ai/server/trusted-server").TrustedServerProtectionHooksV1<ExampleAuthentication, ExamplePrincipal, ExampleReservation, ExampleLease>} options.hooks
 * @param {import("@handrail/ai").WebSearchAdapter} options.adapter
 * @param {import("@handrail/ai").WebSearchAuthorization<SearchContext>} options.authorizeSearch
 * @param {import("@handrail/ai").WebSearchUrlPolicy<SearchContext>} options.validateUrl
 * @param {import("@handrail/ai").WebSearchResultPolicy<SearchContext>} options.acceptResult
 */
export function createProtectedWebSearchRecipe(options) {
  const search = new WebSearchService({
    adapter: options.adapter,
    authorize: options.authorizeSearch,
    validateUrl: options.validateUrl,
    acceptResult: options.acceptResult,
    limits: { timeoutMs: PROTECTED_WEB_SEARCH_MAXIMUM_DEADLINE_MS },
  });
  const protector = createTrustedServerRequestProtectorV1({
    hooks: options.hooks,
    maximumBodyBytes: PROTECTED_WEB_SEARCH_MAXIMUM_BODY_BYTES,
    maximumDeadlineMs: PROTECTED_WEB_SEARCH_MAXIMUM_DEADLINE_MS,
  });

  return Object.freeze({
    version: TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
    /** @param {ProtectedWebSearchInput} input */
    execute: async (input) => {
      const body = await describeBody(input.bodyText, input.resource);
      const request = {
        version: TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
        requestId: input.requestId,
        action: { id: PROTECTED_WEB_SEARCH_ACTION_ID, label: "Web search" },
        resource: input.resource,
        origin: input.origin,
        body: { byteLength: body.byteLength },
        idempotency: { key: input.idempotencyKey, fingerprint: body.fingerprint },
      };
      return protector.execute(
        {
          request,
          authentication: input.authentication,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
        },
        async ({ principal, request: protectedRequest, signal }) => {
          try {
            const resultSet = await search.search(
              parseSearchBody(input.bodyText, protectedRequest.idempotency.key),
              {
                applicationContext: Object.freeze({
                  principalId: principal.id,
                  resourceId: protectedRequest.resource.id,
                }),
                signal,
                deadlineAt: search.deadlineFromNow(),
              },
            );
            return {
              status: 200,
              value: normalizedPublicValue(resultSet, protectedRequest.requestId),
            };
          } catch (error) {
            if (signal.aborted) throw error;
            // Arbitrary adapter/policy errors collapse to one fixed public class.
            throw new TrustedServerOperationFailureV1("unavailable");
          }
        },
      );
    },
  });
}

/**
 * Deterministic, credential-free in-memory fakes used by the checked assertions.
 * They demonstrate lifecycle ordering without prescribing storage or a router.
 */
export function createDeterministicProtectedWebSearchHarness() {
  const controls = {
    authenticated: true,
    authorized: true,
    rateLimited: false,
    concurrencyAvailable: true,
  };
  /** @type {string[]} */
  const trace = [];
  /** @type {string[]} */
  const outerGateSnapshots = [];
  /** @type {import("@handrail/ai/server/trusted-server").TrustedServerTerminalRecordV1[]} */
  const retained = [];
  /** @type {{ query: string, maxResults: number, idempotencyKey: string }[]} */
  const adapterCalls = [];
  /** @type {Map<string, { fingerprint: string, status: "in_flight" | "completed" | "failed", result?: import("@handrail/ai/server/trusted-server").TrustedServerStoredResultV1 }>} */
  const entries = new Map();
  let leaseHeld = false;
  /** @type {{ promise: Promise<void>, resolve: () => void, entered: Promise<void>, markEntered: () => void } | undefined} */
  let adapterBarrier;

  /** @param {string} label @param {import("@handrail/ai/server/trusted-server").TrustedServerHookContextV1} context */
  function observeOuterGate(label, context) {
    trace.push(label);
    outerGateSnapshots.push(JSON.stringify(context.request));
  }

  /** @type {import("@handrail/ai/server/trusted-server").TrustedServerProtectionHooksV1<ExampleAuthentication, ExamplePrincipal, ExampleReservation, ExampleLease>} */
  const hooks = {
    validateOrigin: (context) => {
      observeOuterGate("origin", context);
      return { allowed: context.request.origin === "https://app.example.test" };
    },
    authenticate: (context) => {
      observeOuterGate("authenticate", context);
      return controls.authenticated
        ? { authenticated: true, principal: { id: "principal.example", label: "Example user" } }
        : { authenticated: false };
    },
    authorize: (context) => {
      observeOuterGate("authorize", context);
      return { allowed: controls.authorized && context.request.resource.id === "workspace.example" };
    },
    checkRateLimit: (context) => {
      observeOuterGate("rate-limit", context);
      return controls.rateLimited
        ? { allowed: false, retryAfterMs: 50 }
        : { allowed: true };
    },
    reserveIdempotency: (context) => {
      observeOuterGate("idempotency", context);
      const { key, fingerprint } = context.request.idempotency;
      const existing = entries.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) return { status: "conflict" };
        if (existing.status === "in_flight") return { status: "in_flight", retryAfterMs: 25 };
        if (existing.status === "completed" && existing.result !== undefined) {
          return { status: "replay", result: existing.result };
        }
      }
      entries.set(key, { fingerprint, status: "in_flight" });
      return { status: "reserved", reservation: { key, fingerprint } };
    },
    settleIdempotency: (settlement) => {
      trace.push(`settle:${settlement.status}`);
      const entry = entries.get(settlement.reservation.key);
      if (entry === undefined) throw new Error("Missing in-memory reservation");
      entry.status = settlement.status === "completed" ? "completed" : "failed";
      if (settlement.status === "completed") entry.result = settlement.result;
    },
    acquireConcurrency: (context) => {
      observeOuterGate("concurrency", context);
      if (!controls.concurrencyAvailable || leaseHeld) {
        return { status: "exhausted", retryAfterMs: 25 };
      }
      leaseHeld = true;
      return { status: "acquired", lease: { id: `lease:${context.request.requestId}` } };
    },
    releaseConcurrency: () => {
      trace.push("release");
      leaseHeld = false;
    },
    retainTerminal: (record) => {
      trace.push("retain");
      retained.push(record);
    },
  };

  const recipe = createProtectedWebSearchRecipe({
    hooks,
    authorizeSearch: () => {
      trace.push("search-policy");
      return true;
    },
    validateUrl: () => {
      trace.push("url-policy");
      return true;
    },
    acceptResult: () => {
      trace.push("result-policy");
      return true;
    },
    adapter: {
      search: async ({ query, maxResults, idempotencyKey, signal }) => {
        trace.push("adapter");
        adapterCalls.push({ query, maxResults, idempotencyKey });
        if (adapterBarrier !== undefined) {
          adapterBarrier.markEntered();
          await Promise.race([
            adapterBarrier.promise,
            new Promise((_, reject) => {
              if (signal.aborted) reject(new Error("cancelled"));
              else signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
            }),
          ]);
        }
        // A real host adapter would discard its native envelope in exactly this way.
        const providerNativeResponse = {
          provider_private_field: "discarded-provider-material",
          credential_reference: "discarded-credential-reference",
          items: [{
            id: "source.example",
            heading: "Handrail search result",
            summary: "A deterministic normalized result.",
            href: "https://docs.example.test/handrail",
          }],
        };
        return {
          results: providerNativeResponse.items.map((item) => ({
            source_id: item.id,
            title: item.heading,
            snippet: item.summary,
            url: item.href,
          })),
        };
      },
    },
  });

  return Object.freeze({
    controls,
    trace,
    outerGateSnapshots,
    retained,
    adapterCalls,
    execute: recipe.execute,
    holdAdapter() {
      let resolve = () => {};
      let markEntered = () => {};
      /** @type {Promise<void>} */
      const promise = new Promise((done) => { resolve = () => done(); });
      /** @type {Promise<void>} */
      const entered = new Promise((done) => { markEntered = () => done(); });
      adapterBarrier = { promise, resolve, entered, markEntered };
      return Object.freeze({
        entered,
        release: () => {
          adapterBarrier?.resolve();
          adapterBarrier = undefined;
        },
      });
    },
  });
}

// Keep the checked recipe's service deadline visibly within the SDK ceiling.
if (PROTECTED_WEB_SEARCH_MAXIMUM_DEADLINE_MS > WEB_SEARCH_LIMITS.timeoutMs) {
  throw new Error("Protected web-search deadline exceeds the SDK ceiling");
}
