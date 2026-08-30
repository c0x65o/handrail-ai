import {
  REALTIME_VOICE_CONTRACT_VERSION,
  REALTIME_VOICE_LIMITS,
  type RealtimeVoiceBootstrapResult,
  type RealtimeVoiceCleanupRequest,
  type RealtimeVoiceCleanupResult,
  type RealtimeVoiceClientAdapter,
  type RealtimeVoiceClientSession,
  type RealtimeVoiceHangupReason,
  type RealtimeVoiceHangupRequest,
  type RealtimeVoiceIdempotencyKey,
  type RealtimeVoiceOperationInput,
  type RealtimeVoiceRequestId,
  type RealtimeVoiceSessionAuthority,
  type RealtimeVoiceSessionAuthorityAdapter,
  type RealtimeVoiceSessionId,
  type RealtimeVoiceSessionState,
  type RealtimeVoiceTerminalResult,
  type RealtimeVoiceTimestamp,
} from "./types.js";
import {
  RealtimeVoiceOperationError,
  RealtimeVoiceTransitionError,
  RealtimeVoiceValidationError,
  applyRealtimeVoiceSessionEvent,
  assertRealtimeVoiceAbortSignal,
  createRealtimeVoiceSessionState,
  normalizeRealtimeVoiceError,
  parseRealtimeVoiceBootstrapResult,
  throwIfRealtimeVoiceAborted,
} from "./validation.js";
import type { RealtimeVoiceServerToolBridge } from "./tool-bridge.js";

function operationError(error: unknown, signal: AbortSignal): RealtimeVoiceOperationError {
  if (error instanceof RealtimeVoiceOperationError) return error;
  return new RealtimeVoiceOperationError(normalizeRealtimeVoiceError(error, signal).code);
}

class RealtimeVoiceClientSessionImpl implements RealtimeVoiceClientSession {
  readonly #bootstrap: RealtimeVoiceBootstrapResult;
  readonly #adapter: RealtimeVoiceClientAdapter;
  #state: RealtimeVoiceSessionState;
  #operation: Promise<RealtimeVoiceSessionState> | null = null;

  constructor(bootstrapValue: unknown, adapter: RealtimeVoiceClientAdapter, now?: number) {
    if (
      adapter === null ||
      typeof adapter !== "object" ||
      typeof adapter.start !== "function" ||
      typeof adapter.interrupt !== "function" ||
      typeof adapter.stopLocalMedia !== "function"
    ) {
      throw new TypeError("adapter must implement start, interrupt, and stopLocalMedia");
    }
    this.#bootstrap = parseRealtimeVoiceBootstrapResult(
      bootstrapValue,
      now === undefined ? {} : { now },
    );
    this.#adapter = adapter;
    this.#state = createRealtimeVoiceSessionState(
      this.#bootstrap,
      now === undefined ? {} : { now },
    );
  }

  getState(): RealtimeVoiceSessionState {
    return this.#state;
  }

  start(input: RealtimeVoiceOperationInput): Promise<RealtimeVoiceSessionState> {
    return this.#run(input, () => {
      if (this.#state.status !== "ready") throw new RealtimeVoiceTransitionError();
      return this.#adapter.start({
        session_id: this.#bootstrap.session_id,
        connection: this.#bootstrap.connection,
        authorization: this.#bootstrap.authorization,
        signal: input.signal,
      });
    });
  }

  interrupt(input: RealtimeVoiceOperationInput): Promise<RealtimeVoiceSessionState> {
    return this.#run(input, () => {
      if (
        this.#state.status !== "active" ||
        !this.#state.capabilities.interruption.supported
      ) {
        throw new RealtimeVoiceTransitionError();
      }
      return this.#adapter.interrupt({
        session_id: this.#bootstrap.session_id,
        signal: input.signal,
      });
    });
  }

  stopLocalMedia(input: RealtimeVoiceOperationInput): Promise<RealtimeVoiceSessionState> {
    return this.#run(input, () => {
      if (
        this.#state.local_media === "stopped" ||
        this.#state.status === "ended" ||
        this.#state.status === "failed"
      ) {
        throw new RealtimeVoiceTransitionError();
      }
      return this.#adapter.stopLocalMedia({
        session_id: this.#bootstrap.session_id,
        signal: input.signal,
      });
    });
  }

  applyEvent(event: unknown): RealtimeVoiceSessionState {
    this.#state = applyRealtimeVoiceSessionEvent(this.#state, event);
    return this.#state;
  }

  #run(
    input: RealtimeVoiceOperationInput,
    invoke: () => Promise<unknown>,
  ): Promise<RealtimeVoiceSessionState> {
    try {
      assertRealtimeVoiceAbortSignal(input?.signal, "$operation.signal");
      throwIfRealtimeVoiceAborted(input.signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#operation !== null) {
      return Promise.reject(new RealtimeVoiceTransitionError());
    }
    const operation = (async () => {
      try {
        const event = await invoke();
        throwIfRealtimeVoiceAborted(input.signal);
        return this.applyEvent(event);
      } catch (error) {
        throw operationError(error, input.signal);
      } finally {
        this.#operation = null;
      }
    })();
    this.#operation = operation;
    return operation;
  }
}

/** Contains ephemeral authorization privately; `getState()` is always safe to retain. */
export function createRealtimeVoiceClientSession(
  bootstrap: unknown,
  adapter: RealtimeVoiceClientAdapter,
  options: { readonly now?: number } = {},
): RealtimeVoiceClientSession {
  return new RealtimeVoiceClientSessionImpl(bootstrap, adapter, options.now);
}

const HANGUP_REASONS = new Set<RealtimeVoiceHangupReason>([
  "client_request",
  "session_expired",
  "idle_timeout",
  "policy",
  "server_shutdown",
  "failure",
]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function authorityIdentifier<T extends string>(value: unknown, path: string): T {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > REALTIME_VOICE_LIMITS.identifierLength ||
    !IDENTIFIER.test(value)
  ) {
    throw new RealtimeVoiceValidationError(path, "must be a bounded opaque identifier");
  }
  return value as T;
}

function authorityRecord(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new RealtimeVoiceValidationError(path, "must be a plain data object");
  }
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new RealtimeVoiceValidationError(
        `${path}.${key}`,
        "must be an enumerable data field",
      );
    }
  }
  return value as Record<string, unknown>;
}

export function parseRealtimeVoiceHangupRequest(value: unknown): RealtimeVoiceHangupRequest {
  const path = "$hangup_request";
  const source = authorityRecord(value, path);
  const allowed = new Set([
    "version",
    "request_id",
    "idempotency_key",
    "session_id",
    "reason",
    "signal",
  ]);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new RealtimeVoiceValidationError(`${path}.${key}`, "is not a supported field");
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(source, key)) {
      throw new RealtimeVoiceValidationError(`${path}.${key}`, "is required");
    }
  }
  if (source.version !== REALTIME_VOICE_CONTRACT_VERSION) {
    throw new RealtimeVoiceValidationError(
      `${path}.version`,
      `must equal ${REALTIME_VOICE_CONTRACT_VERSION}`,
    );
  }
  if (!HANGUP_REASONS.has(source.reason as RealtimeVoiceHangupReason)) {
    throw new RealtimeVoiceValidationError(`${path}.reason`, "is not supported");
  }
  assertRealtimeVoiceAbortSignal(source.signal, `${path}.signal`);
  const idempotencyKey = authorityIdentifier<RealtimeVoiceIdempotencyKey>(
    source.idempotency_key,
    `${path}.idempotency_key`,
  );
  if (
    idempotencyKey.length > REALTIME_VOICE_LIMITS.idempotencyKeyLength ||
    !IDEMPOTENCY_KEY.test(idempotencyKey)
  ) {
    throw new RealtimeVoiceValidationError(
      `${path}.idempotency_key`,
      "must be a bounded idempotency key",
    );
  }
  return Object.freeze({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    request_id: authorityIdentifier<RealtimeVoiceRequestId>(
      source.request_id,
      `${path}.request_id`,
    ),
    idempotency_key: idempotencyKey,
    session_id: authorityIdentifier<RealtimeVoiceSessionId>(
      source.session_id,
      `${path}.session_id`,
    ),
    reason: source.reason as RealtimeVoiceHangupReason,
    signal: source.signal,
  });
}

export function parseRealtimeVoiceCleanupRequest(value: unknown): RealtimeVoiceCleanupRequest {
  const path = "$cleanup_request";
  const source = authorityRecord(value, path);
  for (const key of Object.keys(source)) {
    if (key !== "session_id" && key !== "signal") {
      throw new RealtimeVoiceValidationError(`${path}.${key}`, "is not a supported field");
    }
  }
  if (!Object.hasOwn(source, "session_id") || !Object.hasOwn(source, "signal")) {
    throw new RealtimeVoiceValidationError(path, "requires session_id and signal");
  }
  assertRealtimeVoiceAbortSignal(source.signal, `${path}.signal`);
  return Object.freeze({
    session_id: authorityIdentifier<RealtimeVoiceSessionId>(
      source.session_id,
      `${path}.session_id`,
    ),
    signal: source.signal,
  });
}

export interface RealtimeVoiceSessionAuthorityOptions {
  readonly adapter: RealtimeVoiceSessionAuthorityAdapter;
  /** Optional trusted-server bridge terminated before provider cleanup begins. */
  readonly toolBridge?: Pick<RealtimeVoiceServerToolBridge, "terminateSession">;
  readonly now?: () => number;
  readonly maximumTrackedSessions?: number;
}

class IdempotentRealtimeVoiceSessionAuthority implements RealtimeVoiceSessionAuthority {
  readonly #adapter: RealtimeVoiceSessionAuthorityAdapter;
  readonly #toolBridge: Pick<RealtimeVoiceServerToolBridge, "terminateSession"> | undefined;
  readonly #now: () => number;
  readonly #maximumTrackedSessions: number;
  readonly #terminal = new Map<string, RealtimeVoiceTerminalResult>();
  readonly #hangups = new Map<string, Promise<RealtimeVoiceTerminalResult>>();
  readonly #ended = new Set<string>();
  readonly #cleaned = new Set<string>();
  readonly #cleanups = new Map<string, Promise<RealtimeVoiceCleanupResult>>();
  readonly #idempotencySessions = new Map<string, string>();

  constructor(options: RealtimeVoiceSessionAuthorityOptions) {
    if (
      options?.adapter === null ||
      typeof options?.adapter !== "object" ||
      typeof options.adapter.endSession !== "function" ||
      typeof options.adapter.cleanupSession !== "function"
    ) {
      throw new TypeError("options.adapter must implement endSession and cleanupSession");
    }
    const maximumTrackedSessions =
      options.maximumTrackedSessions ?? REALTIME_VOICE_LIMITS.trackedTerminalSessions;
    if (!Number.isSafeInteger(maximumTrackedSessions) || maximumTrackedSessions <= 0) {
      throw new TypeError("maximumTrackedSessions must be a positive safe integer");
    }
    if (
      options.toolBridge !== undefined &&
      (options.toolBridge === null ||
        typeof options.toolBridge !== "object" ||
        typeof options.toolBridge.terminateSession !== "function")
    ) {
      throw new TypeError("options.toolBridge must implement terminateSession");
    }
    this.#adapter = options.adapter;
    this.#toolBridge = options.toolBridge;
    this.#now = options.now ?? Date.now;
    this.#maximumTrackedSessions = maximumTrackedSessions;
  }

  hangup(value: RealtimeVoiceHangupRequest): Promise<RealtimeVoiceTerminalResult> {
    const request = parseRealtimeVoiceHangupRequest(value);
    const existingSession = this.#idempotencySessions.get(request.idempotency_key);
    if (existingSession !== undefined && existingSession !== request.session_id) {
      return Promise.reject(new RealtimeVoiceOperationError("idempotency_conflict"));
    }
    this.#idempotencySessions.set(request.idempotency_key, request.session_id);
    const terminal = this.#terminal.get(request.session_id);
    if (terminal !== undefined) return Promise.resolve(terminal);
    const existing = this.#hangups.get(request.session_id);
    if (existing !== undefined) return existing;
    try {
      throwIfRealtimeVoiceAborted(request.signal);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.#performHangup(request);
    this.#hangups.set(request.session_id, operation);
    return operation;
  }

  cleanup(value: RealtimeVoiceCleanupRequest): Promise<RealtimeVoiceCleanupResult> {
    const request = parseRealtimeVoiceCleanupRequest(value);
    if (this.#cleaned.has(request.session_id)) {
      return Promise.resolve(Object.freeze({
        session_id: request.session_id,
        status: "cleaned",
      }));
    }
    const existing = this.#cleanups.get(request.session_id);
    if (existing !== undefined) return existing;
    try {
      throwIfRealtimeVoiceAborted(request.signal);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = (async () => {
      try {
        await this.#toolBridge?.terminateSession(request.session_id);
        await this.#adapter.cleanupSession(request);
        this.#cleaned.add(request.session_id);
        return Object.freeze({
          session_id: request.session_id,
          status: "cleaned" as const,
        });
      } catch (error) {
        throw operationError(error, request.signal);
      } finally {
        this.#cleanups.delete(request.session_id);
      }
    })();
    this.#cleanups.set(request.session_id, operation);
    return operation;
  }

  async #performHangup(
    request: RealtimeVoiceHangupRequest,
  ): Promise<RealtimeVoiceTerminalResult> {
    try {
      await this.#toolBridge?.terminateSession(request.session_id);
      if (!this.#ended.has(request.session_id)) {
        await this.#adapter.endSession(request);
        this.#ended.add(request.session_id);
      }
      await this.cleanup({ session_id: request.session_id, signal: request.signal });
      const now = this.#now();
      if (!Number.isFinite(now)) throw new RealtimeVoiceOperationError("internal_failure");
      const result = Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: request.session_id,
        status: "ended" as const,
        ended_at: new Date(now).toISOString() as RealtimeVoiceTimestamp,
      });
      this.#rememberTerminal(result);
      return result;
    } catch (error) {
      throw operationError(error, request.signal);
    } finally {
      this.#hangups.delete(request.session_id);
    }
  }

  #rememberTerminal(result: RealtimeVoiceTerminalResult): void {
    this.#terminal.set(result.session_id, result);
    while (this.#terminal.size > this.#maximumTrackedSessions) {
      const oldest = this.#terminal.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#terminal.delete(oldest);
      this.#ended.delete(oldest);
      this.#cleaned.delete(oldest);
      for (const [key, sessionId] of this.#idempotencySessions) {
        if (sessionId === oldest) this.#idempotencySessions.delete(key);
      }
    }
  }
}

/**
 * Creates a bounded trusted-server authority. Successful hangup and cleanup are
 * process-local idempotent terminal operations; durable coordination remains host-owned.
 */
export function createIdempotentRealtimeVoiceSessionAuthority(
  options: RealtimeVoiceSessionAuthorityOptions,
): RealtimeVoiceSessionAuthority {
  return new IdempotentRealtimeVoiceSessionAuthority(options);
}
