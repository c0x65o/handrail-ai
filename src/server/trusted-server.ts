/**
 * Framework-neutral trusted-server request protection contracts.
 *
 * This module intentionally owns no authentication scheme, policy, storage,
 * resource resolver, network transport, or application side effect. Hosts
 * inject those concerns and must treat model output, request data, and tool
 * discovery as untrusted input rather than authorization.
 */

export const TRUSTED_SERVER_REQUEST_PROTECTION_VERSION =
  "trusted-server.request-protection.v1" as const;

export const TRUSTED_SERVER_V1_LIMITS = Object.freeze({
  identifierLength: 128,
  labelLength: 160,
  locatorLength: 512,
  originLength: 512,
  metadataEntries: 16,
  metadataKeyLength: 64,
  metadataValueLength: 256,
  maximumBodyBytes: 16 * 1024 * 1024,
  maximumDeadlineMs: 120_000,
  maximumRetryAfterMs: 60_000,
  publicValueBytes: 64 * 1024,
  publicValueDepth: 6,
  publicValueNodes: 256,
  publicCollectionEntries: 32,
  publicStringLength: 2_048,
});

export type TrustedServerRequestProtectionVersion =
  typeof TRUSTED_SERVER_REQUEST_PROTECTION_VERSION;

export type TrustedServerPublicScalarV1 = string | number | boolean | null;
export type TrustedServerPublicValueV1 =
  | TrustedServerPublicScalarV1
  | readonly TrustedServerPublicValueV1[]
  | { readonly [key: string]: TrustedServerPublicValueV1 };

export interface TrustedServerPublicDescriptorV1 {
  readonly id: string;
  readonly label?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface TrustedServerPublicResourceV1
  extends TrustedServerPublicDescriptorV1 {
  readonly kind: string;
  /** A bounded, non-secret, opaque locator. Sensitive resolution happens later. */
  readonly locator?: string;
}

export interface TrustedServerIdempotencyV1 {
  readonly key: string;
  /** Host-produced fingerprint over the authoritative operation inputs. */
  readonly fingerprint: string;
}

export interface TrustedServerProtectedRequestV1 {
  readonly version: TrustedServerRequestProtectionVersion;
  readonly requestId: string;
  readonly action: TrustedServerPublicDescriptorV1;
  readonly resource: TrustedServerPublicResourceV1;
  readonly origin: string;
  readonly body: { readonly byteLength: number };
  readonly idempotency: TrustedServerIdempotencyV1;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** The only principal data exposed to later policy hooks and audit summaries. */
export type TrustedServerPrincipalV1 = TrustedServerPublicDescriptorV1;

export interface TrustedServerStoredResultV1 {
  readonly status: number;
  readonly value: TrustedServerPublicValueV1;
}

export type TrustedServerPublicErrorCodeV1 =
  | "invalid_request"
  | "invalid_origin"
  | "invalid_body"
  | "unauthenticated"
  | "forbidden"
  | "rate_limited"
  | "idempotency_conflict"
  | "idempotency_in_flight"
  | "concurrency_exhausted"
  | "cancelled"
  | "deadline_exceeded"
  | "unavailable"
  | "internal_failure";

export interface TrustedServerPublicErrorV1 {
  readonly code: TrustedServerPublicErrorCodeV1;
  readonly message: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface TrustedServerProtectedSuccessV1 {
  readonly ok: true;
  readonly status: number;
  readonly value: TrustedServerPublicValueV1;
  readonly replayed: boolean;
}

export interface TrustedServerProtectedFailureV1 {
  readonly ok: false;
  readonly error: TrustedServerPublicErrorV1;
}

export type TrustedServerProtectedResultV1 =
  | TrustedServerProtectedSuccessV1
  | TrustedServerProtectedFailureV1;

export interface TrustedServerHookContextV1 {
  readonly request: TrustedServerProtectedRequestV1;
  readonly signal: AbortSignal;
}

export interface TrustedServerAuthenticatedContextV1<TPrincipal extends TrustedServerPrincipalV1>
  extends TrustedServerHookContextV1 {
  readonly principal: TPrincipal;
}

export type TrustedServerAuthenticationDecisionV1<TPrincipal extends TrustedServerPrincipalV1> =
  | { readonly authenticated: true; readonly principal: TPrincipal }
  | { readonly authenticated: false };

export type TrustedServerAuthorizationDecisionV1 =
  | { readonly allowed: true }
  | { readonly allowed: false };

export type TrustedServerOriginDecisionV1 = TrustedServerAuthorizationDecisionV1;

export type TrustedServerRateLimitDecisionV1 =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly retryAfterMs?: number };

export type TrustedServerIdempotencyDecisionV1<TReservation> =
  | { readonly status: "reserved"; readonly reservation: TReservation }
  | { readonly status: "replay"; readonly result: TrustedServerStoredResultV1 }
  | { readonly status: "conflict" }
  | { readonly status: "in_flight"; readonly retryAfterMs?: number };

export type TrustedServerConcurrencyDecisionV1<TLease> =
  | { readonly status: "acquired"; readonly lease: TLease }
  | { readonly status: "exhausted"; readonly retryAfterMs?: number };

export type TrustedServerIdempotencySettlementV1<TReservation> =
  | {
      readonly reservation: TReservation;
      readonly status: "completed";
      readonly result: TrustedServerStoredResultV1;
    }
  | {
      readonly reservation: TReservation;
      readonly status: "failed";
      readonly error: TrustedServerPublicErrorV1;
    };

export type TrustedServerTerminalStageV1 =
  | "validation"
  | "origin"
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "idempotency"
  | "concurrency"
  | "operation"
  | "cleanup"
  | "completed";

export interface TrustedServerTerminalRecordV1 {
  readonly version: TrustedServerRequestProtectionVersion;
  readonly requestId: string | null;
  readonly actionId: string | null;
  readonly resourceId: string | null;
  readonly principalId: string | null;
  readonly stage: TrustedServerTerminalStageV1;
  readonly outcome: "success" | "replay" | TrustedServerPublicErrorCodeV1;
}

export interface TrustedServerProtectionHooksV1<
  TAuthentication,
  TPrincipal extends TrustedServerPrincipalV1,
  TReservation,
  TLease,
> {
  readonly validateOrigin: (
    context: TrustedServerHookContextV1,
  ) => Promise<TrustedServerOriginDecisionV1> | TrustedServerOriginDecisionV1;
  readonly authenticate: (
    context: TrustedServerHookContextV1 & { readonly authentication: TAuthentication },
  ) => Promise<TrustedServerAuthenticationDecisionV1<TPrincipal>> |
    TrustedServerAuthenticationDecisionV1<TPrincipal>;
  readonly authorize: (
    context: TrustedServerAuthenticatedContextV1<TPrincipal>,
  ) => Promise<TrustedServerAuthorizationDecisionV1> | TrustedServerAuthorizationDecisionV1;
  readonly checkRateLimit: (
    context: TrustedServerAuthenticatedContextV1<TPrincipal>,
  ) => Promise<TrustedServerRateLimitDecisionV1> | TrustedServerRateLimitDecisionV1;
  readonly reserveIdempotency: (
    context: TrustedServerAuthenticatedContextV1<TPrincipal>,
  ) => Promise<TrustedServerIdempotencyDecisionV1<TReservation>> |
    TrustedServerIdempotencyDecisionV1<TReservation>;
  /** Records exactly one bounded public result or fixed public failure per reservation. */
  readonly settleIdempotency: (
    settlement: TrustedServerIdempotencySettlementV1<TReservation>,
  ) => Promise<void> | void;
  readonly acquireConcurrency: (
    context: TrustedServerAuthenticatedContextV1<TPrincipal>,
  ) => Promise<TrustedServerConcurrencyDecisionV1<TLease>> |
    TrustedServerConcurrencyDecisionV1<TLease>;
  readonly releaseConcurrency: (lease: TLease) => Promise<void> | void;
  /** Receives identifiers and a fixed outcome only; it never receives request/result data. */
  readonly retainTerminal: (record: TrustedServerTerminalRecordV1) => Promise<void> | void;
}

export type TrustedServerProtectedOperationContextV1<
  TPrincipal extends TrustedServerPrincipalV1,
> = TrustedServerAuthenticatedContextV1<TPrincipal>;

export type TrustedServerProtectedOperationV1<TPrincipal extends TrustedServerPrincipalV1> = (
  context: TrustedServerProtectedOperationContextV1<TPrincipal>,
) => Promise<TrustedServerStoredResultV1> | TrustedServerStoredResultV1;

export interface TrustedServerProtectionOptionsV1<
  TAuthentication,
  TPrincipal extends TrustedServerPrincipalV1,
  TReservation,
  TLease,
> {
  readonly hooks: TrustedServerProtectionHooksV1<
    TAuthentication,
    TPrincipal,
    TReservation,
    TLease
  >;
  readonly maximumBodyBytes?: number;
  readonly maximumDeadlineMs?: number;
  readonly clock?: {
    readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
    readonly clearTimeout: (handle: unknown) => void;
  };
}

export interface TrustedServerProtectionExecutionV1<TAuthentication> {
  readonly request: unknown;
  /** Opaque host authentication material. It is never copied into public or retention data. */
  readonly authentication: TAuthentication;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

export interface TrustedServerRequestProtectorV1<
  TAuthentication,
  TPrincipal extends TrustedServerPrincipalV1,
> {
  readonly version: TrustedServerRequestProtectionVersion;
  readonly execute: (
    input: TrustedServerProtectionExecutionV1<TAuthentication>,
    operation: TrustedServerProtectedOperationV1<TPrincipal>,
  ) => Promise<TrustedServerProtectedResultV1>;
}

const ERROR_DEFINITIONS: Readonly<Record<
  TrustedServerPublicErrorCodeV1,
  Omit<TrustedServerPublicErrorV1, "code" | "retryAfterMs">
>> = Object.freeze({
  invalid_request: { message: "The request is invalid.", status: 400, retryable: false },
  invalid_origin: { message: "The request origin is not allowed.", status: 403, retryable: false },
  invalid_body: { message: "The request body is invalid or too large.", status: 413, retryable: false },
  unauthenticated: { message: "Authentication is required.", status: 401, retryable: false },
  forbidden: { message: "The requested action is not allowed.", status: 403, retryable: false },
  rate_limited: { message: "Too many requests.", status: 429, retryable: true },
  idempotency_conflict: { message: "The idempotency key conflicts with another request.", status: 409, retryable: false },
  idempotency_in_flight: { message: "The idempotent request is still in progress.", status: 409, retryable: true },
  concurrency_exhausted: { message: "Request concurrency is exhausted.", status: 429, retryable: true },
  cancelled: { message: "The request was cancelled.", status: 499, retryable: false },
  deadline_exceeded: { message: "The request deadline was exceeded.", status: 504, retryable: true },
  unavailable: { message: "The protected operation is unavailable.", status: 503, retryable: true },
  internal_failure: { message: "The protected request failed.", status: 500, retryable: false },
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const METADATA_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CANCELLED = Object.freeze({ kind: "trusted-server-cancelled" });
const DEADLINE = Object.freeze({ kind: "trusted-server-deadline" });

/** A deliberately message-free operation classification for safe public mapping. */
export class TrustedServerOperationFailureV1 extends Error {
  readonly code: "unavailable";

  constructor(code: "unavailable" = "unavailable") {
    super("Trusted server operation failure");
    this.name = "TrustedServerOperationFailureV1";
    this.code = code;
  }
}

/** Return a fresh fixed public error; arbitrary thrown data is never consulted. */
export function trustedServerPublicErrorV1(
  code: TrustedServerPublicErrorCodeV1,
  retryAfterMs?: number,
): TrustedServerPublicErrorV1 {
  const definition = ERROR_DEFINITIONS[code];
  const boundedRetry = definition.retryable ? boundedRetryAfter(retryAfterMs) : undefined;
  return Object.freeze({
    code,
    ...definition,
    ...(boundedRetry === undefined ? {} : { retryAfterMs: boundedRetry }),
  });
}

/**
 * Build a v1 lifecycle coordinator. The application operation cannot be
 * invoked before validation, authentication, authorization, rate limiting,
 * idempotency reservation, and concurrency acquisition all succeed.
 *
 * Gate hooks must honor `context.signal`: reservation/acquisition adapters
 * must not commit new state after it aborts. Cleanup hooks are deliberately
 * terminal and uninterruptible. The operation closure is the host seam for
 * raw body access, sensitive resource resolution, and side effects, and its
 * returned value must be intentionally public; this coordinator validates and
 * clones that value before returning or recording it.
 */
export function createTrustedServerRequestProtectorV1<
  TAuthentication,
  TPrincipal extends TrustedServerPrincipalV1,
  TReservation,
  TLease,
>(
  options: TrustedServerProtectionOptionsV1<
    TAuthentication,
    TPrincipal,
    TReservation,
    TLease
  >,
): TrustedServerRequestProtectorV1<TAuthentication, TPrincipal> {
  const maximumBodyBytes = options.maximumBodyBytes ?? TRUSTED_SERVER_V1_LIMITS.maximumBodyBytes;
  const maximumDeadlineMs = options.maximumDeadlineMs ?? TRUSTED_SERVER_V1_LIMITS.maximumDeadlineMs;
  requireBoundedInteger(maximumBodyBytes, 1, TRUSTED_SERVER_V1_LIMITS.maximumBodyBytes, "maximumBodyBytes");
  requireBoundedInteger(maximumDeadlineMs, 1, TRUSTED_SERVER_V1_LIMITS.maximumDeadlineMs, "maximumDeadlineMs");
  const clock = options.clock ?? {
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  return Object.freeze({
    version: TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
    execute: async (
      input: TrustedServerProtectionExecutionV1<TAuthentication>,
      operation: TrustedServerProtectedOperationV1<TPrincipal>,
    ) => {
      const retentionBase: MutableTerminal = {
        requestId: null,
        actionId: null,
        resourceId: null,
        principalId: null,
        stage: "validation",
        outcome: "internal_failure",
      };
      let reservation: TReservation | undefined;
      let hasReservation = false;
      let lease: TLease | undefined;
      let hasLease = false;
      let result: TrustedServerProtectedResultV1;
      let lifecycle: ReturnType<typeof createLifecycleSignal> | undefined;

      try {
        const parsed = validateRequest(input.request, maximumBodyBytes);
        if (!parsed.ok) {
          result = failure(parsed.code);
          retentionBase.outcome = parsed.code;
          return await retainAndReturn(options.hooks, retentionBase, result);
        }
        const protectedRequest = parsed.request;
        retentionBase.requestId = protectedRequest.requestId;
        retentionBase.actionId = protectedRequest.action.id;
        retentionBase.resourceId = protectedRequest.resource.id;

        const deadlineMs = input.deadlineMs ?? maximumDeadlineMs;
        if (!isBoundedInteger(deadlineMs, 1, maximumDeadlineMs)) {
          result = failure("invalid_request");
          retentionBase.outcome = "invalid_request";
          return await retainAndReturn(options.hooks, retentionBase, result);
        }

        lifecycle = createLifecycleSignal(input.signal, deadlineMs, clock);
        const signal = lifecycle.signal;
        throwIfLifecycleAborted(lifecycle);

        retentionBase.stage = "origin";
        const origin = await protectedAwait(
          () => options.hooks.validateOrigin({ request: protectedRequest, signal }),
          lifecycle,
        );
        if (!isBooleanDecision(origin, "allowed")) throw new Error("Invalid origin decision");
        if (!origin.allowed) {
          result = failure("invalid_origin");
          retentionBase.outcome = "invalid_origin";
          return await retainAndReturn(options.hooks, retentionBase, result);
        }

        retentionBase.stage = "authentication";
        const authentication = await protectedAwait(
          () => options.hooks.authenticate({ request: protectedRequest, authentication: input.authentication, signal }),
          lifecycle,
        );
        if (!isAuthenticationDecision(authentication)) throw new Error("Invalid authentication decision");
        if (!authentication.authenticated) {
          result = failure("unauthenticated");
          retentionBase.outcome = "unauthenticated";
          return await retainAndReturn(options.hooks, retentionBase, result);
        }
        const principal = validatePrincipal(authentication.principal);
        retentionBase.principalId = principal.id;
        const context = { request: protectedRequest, principal: principal as TPrincipal, signal };

        retentionBase.stage = "authorization";
        const authorization = await protectedAwait(
          () => options.hooks.authorize(context),
          lifecycle,
        );
        if (!isBooleanDecision(authorization, "allowed")) throw new Error("Invalid authorization decision");
        if (!authorization.allowed) {
          result = failure("forbidden");
          retentionBase.outcome = "forbidden";
          return await retainAndReturn(options.hooks, retentionBase, result);
        }

        retentionBase.stage = "rate_limit";
        const rateLimit = await protectedAwait(
          () => options.hooks.checkRateLimit(context),
          lifecycle,
        );
        if (!isRateLimitDecision(rateLimit)) throw new Error("Invalid rate-limit decision");
        if (!rateLimit.allowed) {
          result = failure("rate_limited", rateLimit.retryAfterMs);
          retentionBase.outcome = "rate_limited";
          return await retainAndReturn(options.hooks, retentionBase, result);
        }

        retentionBase.stage = "idempotency";
        const idempotency = await protectedAwait(
          () => options.hooks.reserveIdempotency(context),
          lifecycle,
        );
        if (!isIdempotencyDecision(idempotency)) throw new Error("Invalid idempotency decision");
        if (idempotency.status === "replay") {
          const stored = cloneStoredResult(idempotency.result);
          result = success(stored, true);
          retentionBase.outcome = "replay";
          return await retainAndReturn(options.hooks, retentionBase, result);
        }
        if (idempotency.status === "conflict") {
          result = failure("idempotency_conflict");
          retentionBase.outcome = "idempotency_conflict";
          return await retainAndReturn(options.hooks, retentionBase, result);
        }
        if (idempotency.status === "in_flight") {
          result = failure("idempotency_in_flight", idempotency.retryAfterMs);
          retentionBase.outcome = "idempotency_in_flight";
          return await retainAndReturn(options.hooks, retentionBase, result);
        }
        reservation = idempotency.reservation;
        hasReservation = true;

        retentionBase.stage = "concurrency";
        const concurrency = await protectedAwait(
          () => options.hooks.acquireConcurrency(context),
          lifecycle,
        );
        if (!isConcurrencyDecision(concurrency)) throw new Error("Invalid concurrency decision");
        if (concurrency.status === "exhausted") {
          result = failure("concurrency_exhausted", concurrency.retryAfterMs);
          retentionBase.outcome = "concurrency_exhausted";
        } else {
          lease = concurrency.lease;
          hasLease = true;
          retentionBase.stage = "operation";
          const stored = cloneStoredResult(await protectedAwait(() => operation(context), lifecycle));
          throwIfLifecycleAborted(lifecycle);
          result = success(stored, false);
          retentionBase.outcome = "success";
          retentionBase.stage = "completed";
        }
      } catch (error) {
        const code = publicCodeForThrown(error, lifecycle);
        result = failure(code);
        retentionBase.outcome = code;
      } finally {
        lifecycle?.dispose();
      }

      retentionBase.stage = retentionBase.stage === "completed" ? "completed" : retentionBase.stage;
      if (hasLease) {
        try {
          await options.hooks.releaseConcurrency(lease as TLease);
        } catch {
          result = failure("internal_failure");
          retentionBase.stage = "cleanup";
          retentionBase.outcome = "internal_failure";
        }
      }
      if (hasReservation) {
        try {
          await options.hooks.settleIdempotency(
            result.ok
              ? {
                  reservation: reservation as TReservation,
                  status: "completed",
                  result: { status: result.status, value: result.value },
                }
              : {
                  reservation: reservation as TReservation,
                  status: "failed",
                  error: result.error,
                },
          );
        } catch {
          result = failure("internal_failure");
          retentionBase.stage = "cleanup";
          retentionBase.outcome = "internal_failure";
        }
      }
      return await retainAndReturn(options.hooks, retentionBase, result);
    },
  });
}

type MutableTerminal = {
  requestId: string | null;
  actionId: string | null;
  resourceId: string | null;
  principalId: string | null;
  stage: TrustedServerTerminalStageV1;
  outcome: TrustedServerTerminalRecordV1["outcome"];
};

async function retainAndReturn<TAuthentication, TPrincipal extends TrustedServerPrincipalV1, TReservation, TLease>(
  hooks: TrustedServerProtectionHooksV1<TAuthentication, TPrincipal, TReservation, TLease>,
  terminal: MutableTerminal,
  result: TrustedServerProtectedResultV1,
): Promise<TrustedServerProtectedResultV1> {
  const record = Object.freeze({
    version: TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
    ...terminal,
  });
  try {
    await hooks.retainTerminal(record);
  } catch {
    // Retention is terminal notification: failure cannot expose internals or recur.
  }
  return result;
}

function success(stored: TrustedServerStoredResultV1, replayed: boolean): TrustedServerProtectedSuccessV1 {
  return Object.freeze({ ok: true, status: stored.status, value: stored.value, replayed });
}

function failure(code: TrustedServerPublicErrorCodeV1, retryAfterMs?: number): TrustedServerProtectedFailureV1 {
  return Object.freeze({ ok: false, error: trustedServerPublicErrorV1(code, retryAfterMs) });
}

function validateRequest(
  value: unknown,
  maximumBodyBytes: number,
): { readonly ok: true; readonly request: TrustedServerProtectedRequestV1 } |
  { readonly ok: false; readonly code: "invalid_request" | "invalid_origin" | "invalid_body" } {
  if (!isPlainObject(value) || value.version !== TRUSTED_SERVER_REQUEST_PROTECTION_VERSION) {
    return { ok: false, code: "invalid_request" };
  }
  if (!validIdentifier(value.requestId) || !validDescriptor(value.action) || !validResource(value.resource) ||
      !validIdempotency(value.idempotency) || !validMetadata(value.metadata)) {
    return { ok: false, code: "invalid_request" };
  }
  if (!validOrigin(value.origin)) return { ok: false, code: "invalid_origin" };
  if (!isPlainObject(value.body) || !isBoundedInteger(value.body.byteLength, 0, maximumBodyBytes)) {
    return { ok: false, code: "invalid_body" };
  }
  return {
    ok: true,
    request: Object.freeze({
      version: TRUSTED_SERVER_REQUEST_PROTECTION_VERSION,
      requestId: value.requestId,
      action: cloneDescriptor(value.action),
      resource: cloneResource(value.resource),
      origin: value.origin,
      body: Object.freeze({ byteLength: value.body.byteLength }),
      idempotency: Object.freeze({
        key: value.idempotency.key,
        fingerprint: value.idempotency.fingerprint,
      }),
      ...(value.metadata === undefined ? {} : { metadata: cloneMetadata(value.metadata) }),
    }),
  };
}

function validDescriptor(value: unknown): value is TrustedServerPublicDescriptorV1 {
  return isPlainObject(value) && validIdentifier(value.id) &&
    (value.label === undefined || validLabel(value.label)) && validMetadata(value.metadata);
}

function validResource(value: unknown): value is TrustedServerPublicResourceV1 {
  if (!isPlainObject(value)) return false;
  return validDescriptor(value) && validIdentifier(value.kind) &&
    (value.locator === undefined || validLocator(value.locator));
}

function validIdempotency(value: unknown): value is TrustedServerIdempotencyV1 {
  return isPlainObject(value) && validIdentifier(value.key) && validIdentifier(value.fingerprint);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length <= TRUSTED_SERVER_V1_LIMITS.identifierLength &&
    IDENTIFIER.test(value);
}

function validLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= TRUSTED_SERVER_V1_LIMITS.labelLength && !hasControlCharacter(value);
}

function validLocator(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= TRUSTED_SERVER_V1_LIMITS.locatorLength &&
    /^[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*$/.test(value);
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > TRUSTED_SERVER_V1_LIMITS.originLength) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" && url.password === "" && url.pathname === "/" &&
      url.search === "" && url.hash === "" && url.origin === value;
  } catch {
    return false;
  }
}

function validMetadata(value: unknown): value is Readonly<Record<string, string>> | undefined {
  if (value === undefined) return true;
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= TRUSTED_SERVER_V1_LIMITS.metadataEntries && entries.every(([key, item]) =>
    key.length <= TRUSTED_SERVER_V1_LIMITS.metadataKeyLength && METADATA_KEY.test(key) &&
    !UNSAFE_OBJECT_KEYS.has(key) &&
    typeof item === "string" && item.length <= TRUSTED_SERVER_V1_LIMITS.metadataValueLength &&
    !hasControlCharacter(item));
}

function cloneDescriptor(value: TrustedServerPublicDescriptorV1): TrustedServerPublicDescriptorV1 {
  return Object.freeze({
    id: value.id,
    ...(value.label === undefined ? {} : { label: value.label }),
    ...(value.metadata === undefined ? {} : { metadata: cloneMetadata(value.metadata) }),
  });
}

function cloneResource(value: TrustedServerPublicResourceV1): TrustedServerPublicResourceV1 {
  return Object.freeze({
    ...cloneDescriptor(value),
    kind: value.kind,
    ...(value.locator === undefined ? {} : { locator: value.locator }),
  });
}

function validatePrincipal<TPrincipal extends TrustedServerPrincipalV1>(value: TPrincipal): TPrincipal {
  if (!validDescriptor(value)) throw new Error("Invalid principal");
  return value;
}

function cloneMetadata(value: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(Object.entries(value)));
}

function cloneStoredResult(value: unknown): TrustedServerStoredResultV1 {
  if (!isPlainObject(value) || !isBoundedInteger(value.status, 200, 299)) {
    throw new Error("Invalid public result");
  }
  const state = { nodes: 0 };
  const publicValue = clonePublicValue(value.value, 0, state);
  const serialized = JSON.stringify(publicValue);
  if (new TextEncoder().encode(serialized).byteLength > TRUSTED_SERVER_V1_LIMITS.publicValueBytes) {
    throw new Error("Public result exceeds its bound");
  }
  return Object.freeze({ status: value.status, value: publicValue });
}

function clonePublicValue(
  value: unknown,
  depth: number,
  state: { nodes: number },
): TrustedServerPublicValueV1 {
  state.nodes += 1;
  if (state.nodes > TRUSTED_SERVER_V1_LIMITS.publicValueNodes || depth > TRUSTED_SERVER_V1_LIMITS.publicValueDepth) {
    throw new Error("Invalid public result");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Invalid public result");
    return value;
  }
  if (typeof value === "string") {
    if (value.length > TRUSTED_SERVER_V1_LIMITS.publicStringLength) throw new Error("Invalid public result");
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > TRUSTED_SERVER_V1_LIMITS.publicCollectionEntries) throw new Error("Invalid public result");
    return Object.freeze(value.map((item) => clonePublicValue(item, depth + 1, state)));
  }
  if (!isPlainObject(value)) throw new Error("Invalid public result");
  const entries = Object.entries(value);
  if (entries.length > TRUSTED_SERVER_V1_LIMITS.publicCollectionEntries) throw new Error("Invalid public result");
  const clone: Record<string, TrustedServerPublicValueV1> = Object.create(null) as Record<string, TrustedServerPublicValueV1>;
  for (const [key, item] of entries) {
    if (key.length === 0 || key.length > TRUSTED_SERVER_V1_LIMITS.metadataKeyLength ||
        UNSAFE_OBJECT_KEYS.has(key) || hasControlCharacter(key)) {
      throw new Error("Invalid public result");
    }
    clone[key] = clonePublicValue(item, depth + 1, state);
  }
  return Object.freeze(clone);
}

function isAuthenticationDecision(value: unknown): value is TrustedServerAuthenticationDecisionV1<TrustedServerPrincipalV1> {
  return isPlainObject(value) && typeof value.authenticated === "boolean" &&
    (!value.authenticated || validDescriptor(value.principal));
}

function isBooleanDecision(value: unknown, key: "allowed"): value is { readonly allowed: boolean } {
  return isPlainObject(value) && typeof value[key] === "boolean";
}

function isRateLimitDecision(value: unknown): value is TrustedServerRateLimitDecisionV1 {
  if (!isPlainObject(value) || typeof value.allowed !== "boolean") return false;
  return value.allowed || validOptionalRetry(value.retryAfterMs);
}

function isIdempotencyDecision(value: unknown): value is TrustedServerIdempotencyDecisionV1<unknown> {
  if (!isPlainObject(value) || typeof value.status !== "string") return false;
  if (value.status === "reserved") return "reservation" in value;
  if (value.status === "replay") return "result" in value;
  if (value.status === "conflict") return true;
  return value.status === "in_flight" && validOptionalRetry(value.retryAfterMs);
}

function isConcurrencyDecision(value: unknown): value is TrustedServerConcurrencyDecisionV1<unknown> {
  if (!isPlainObject(value) || typeof value.status !== "string") return false;
  if (value.status === "acquired") return "lease" in value;
  return value.status === "exhausted" && validOptionalRetry(value.retryAfterMs);
}

function validOptionalRetry(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function boundedRetryAfter(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(TRUSTED_SERVER_V1_LIMITS.maximumRetryAfterMs, Math.max(0, Math.round(value)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function requireBoundedInteger(value: unknown, minimum: number, maximum: number, name: string): asserts value is number {
  if (!isBoundedInteger(value, minimum, maximum)) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
}

interface LifecycleSignal {
  readonly signal: AbortSignal;
  readonly kind: () => "cancelled" | "deadline_exceeded" | null;
  readonly dispose: () => void;
}

function createLifecycleSignal(
  caller: AbortSignal | undefined,
  deadlineMs: number,
  clock: NonNullable<TrustedServerProtectionOptionsV1<unknown, TrustedServerPrincipalV1, unknown, unknown>["clock"]>,
): LifecycleSignal {
  const controller = new AbortController();
  let kind: "cancelled" | "deadline_exceeded" | null = null;
  const cancel = () => {
    if (kind !== null) return;
    kind = "cancelled";
    controller.abort(CANCELLED);
  };
  if (caller?.aborted) cancel();
  else caller?.addEventListener("abort", cancel, { once: true });
  const handle = clock.setTimeout(() => {
    if (kind !== null) return;
    kind = "deadline_exceeded";
    controller.abort(DEADLINE);
  }, deadlineMs);
  let disposed = false;
  return {
    signal: controller.signal,
    kind: () => kind,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clock.clearTimeout(handle);
      caller?.removeEventListener("abort", cancel);
    },
  };
}

async function protectedAwait<T>(operation: () => Promise<T> | T, lifecycle: LifecycleSignal): Promise<T> {
  throwIfLifecycleAborted(lifecycle);
  const promise = Promise.resolve().then(operation);
  const signal = lifecycle.signal;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? CANCELLED);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason ?? CANCELLED);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function throwIfLifecycleAborted(lifecycle: LifecycleSignal): void {
  if (lifecycle.signal.aborted) throw lifecycle.signal.reason ?? CANCELLED;
}

function publicCodeForThrown(
  error: unknown,
  lifecycle: LifecycleSignal | undefined,
): TrustedServerPublicErrorCodeV1 {
  const lifecycleKind = lifecycle?.kind();
  if (lifecycleKind !== null && lifecycleKind !== undefined) return lifecycleKind;
  if (error instanceof TrustedServerOperationFailureV1) return error.code;
  return "internal_failure";
}
