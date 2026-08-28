import {
  parseChatRequest,
  parseStreamEvent,
  parseStreamEvents,
  type AuthoritativeAttribution,
  type ChatRequest,
  type ResponseStartedEvent,
  type StreamEvent,
  type TerminalStreamEvent,
  type Usage,
} from "../protocol.js";
import {
  NORMALIZED_USAGE_RECEIPT_VERSION,
  parseNormalizedUsageReceipt,
  type NormalizedUsageReceipt,
  type UsageAttemptIdentity,
  type UsageContinuationIdentity,
  type UsageReceiptTerminalStatus,
} from "../usage.js";
import {
  MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION,
  ManagedRuntimeTurnStateStoreConflictError,
  ManagedRuntimeTurnStateStoreUnavailableError,
  parseManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateStore,
} from "./managed-runtime-state.js";
import { parseServerSentEvents, type ServerSentEventFrame } from "./sse.js";
import type {
  ConversationTransport,
  ResumeTurnInput,
  StartTurnInput,
  TransportError,
  TransportResult,
  TurnHandle,
  TurnObservation,
  TurnObservationResult,
  TurnResumePoint,
} from "./types.js";

const CHAT_PATH = "/api/ai-runtime/v1/chat";
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;
const MAX_PROBLEM_BYTES = 65_536;
const DISCONNECT_REASON = Object.freeze({ kind: "disconnect" });
const TIMEOUT_REASON = Object.freeze({ kind: "timeout" });

export type ManagedRuntimeFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type ManagedRuntimeHeadersProvider = () =>
  | HeadersInit
  | Promise<HeadersInit>;

export interface ManagedRuntimeUsageReceiptIdentity {
  readonly usage_receipt_id: string;
  readonly logical_request_id: string;
  readonly attempt: UsageAttemptIdentity;
  readonly continuation: UsageContinuationIdentity;
  /** Provider-neutral runtime identity, not a provider-native SDK value. */
  readonly provider_id: string;
  /** Public runtime model identity, not a provider-native response object. */
  readonly model_id: string;
}

export interface ManagedRuntimeUsageReceiptInput {
  readonly conversationId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly traceId: string;
  readonly attribution: AuthoritativeAttribution;
  readonly usage: Usage;
  readonly terminalStatus: UsageReceiptTerminalStatus;
}

export type ManagedRuntimeUsageReceiptIdentityProvider = (
  input: ManagedRuntimeUsageReceiptInput,
) =>
  | ManagedRuntimeUsageReceiptIdentity
  | Promise<ManagedRuntimeUsageReceiptIdentity>;

export interface ManagedRuntimeTransportOptions {
  readonly baseUrl: string | URL;
  /** Called for every POST so trusted-server token rotation is respected. */
  readonly getHeaders: ManagedRuntimeHeadersProvider;
  readonly fetch: ManagedRuntimeFetch;
  /** Bounds header acquisition, request setup, and the complete SSE stream. */
  readonly timeoutMs?: number;
  /** Optional trusted-server persistence for cross-instance turn restoration. */
  readonly turnStateStore?: ManagedRuntimeTurnStateStore;
  /** Optional trusted identity needed to project cumulative runtime usage. */
  readonly createUsageReceiptIdentity?: ManagedRuntimeUsageReceiptIdentityProvider;
}

interface ManagedRuntimeResultFields {
  readonly attribution: AuthoritativeAttribution;
  readonly usage: Usage | null;
  readonly usageReceipt: NormalizedUsageReceipt | null;
}

type ManagedRuntimeObservationOutcome =
  | ({ readonly status: "completed" } & ManagedRuntimeResultFields)
  | ({ readonly status: "cancelled" } & ManagedRuntimeResultFields)
  | ({ readonly status: "disconnected" } & ManagedRuntimeResultFields)
  | ({ readonly status: "failed"; readonly error: TransportError } &
      ManagedRuntimeResultFields);

export type ManagedRuntimeTurnObservationResult =
  | (Extract<TurnObservationResult, { status: "completed" }> &
      ManagedRuntimeResultFields)
  | (Extract<TurnObservationResult, { status: "cancelled" }> &
      ManagedRuntimeResultFields)
  | (Extract<TurnObservationResult, { status: "disconnected" }> &
      ManagedRuntimeResultFields)
  | (Extract<TurnObservationResult, { status: "failed" }> &
      ManagedRuntimeResultFields);

export interface ManagedRuntimeTurnObservation
  extends Omit<TurnObservation<StreamEvent>, "result"> {
  readonly result: Promise<ManagedRuntimeTurnObservationResult>;
}

export interface ManagedRuntimeTurnHandle
  extends Omit<TurnHandle<StreamEvent>, "observation"> {
  readonly attribution: AuthoritativeAttribution;
  readonly observation: ManagedRuntimeTurnObservation;
}

export interface ManagedRuntimeTransportContract
  extends ConversationTransport<StreamEvent, ChatRequest> {
  startTurn(
    input: StartTurnInput<ChatRequest>,
  ): Promise<TransportResult<ManagedRuntimeTurnHandle>>;
  resumeTurn(
    input: ResumeTurnInput,
  ): Promise<TransportResult<ManagedRuntimeTurnObservation>>;
}

interface TurnSnapshot {
  readonly conversationId: string;
  readonly conversationTurnId: string;
  readonly mutationId: string;
  readonly request: ChatRequest;
  readonly serializedBody: string;
  readonly idempotencyKey: string;
  readonly turnId: string;
}

interface RuntimeConnection {
  readonly controller: AbortController;
  readonly frames: AsyncIterator<ServerSentEventFrame>;
  clearTimeout(): void;
}

interface OpenedStream {
  readonly connection: RuntimeConnection;
  readonly validator: ManagedStreamValidator;
  readonly started: ResponseStartedEvent;
}

type OpenResult = TransportResult<OpenedStream>;

function failure(error: TransportError): TransportResult<never> {
  return { ok: false, error };
}

function fixedError(
  code: TransportError["code"],
  message: string,
  retryable: boolean,
): TransportError {
  return { code, message, retryable };
}

const INVALID_REQUEST = fixedError(
  "invalid_request",
  "The managed runtime request is invalid.",
  false,
);
const INVALID_PROTOCOL = fixedError(
  "internal_error",
  "The managed runtime returned an invalid protocol response.",
  false,
);
const DISCONNECTED = fixedError(
  "unavailable",
  "The managed runtime stream was interrupted.",
  true,
);
const TIMED_OUT = fixedError(
  "timeout",
  "The managed runtime request timed out.",
  true,
);
const TURN_STATE_NOT_FOUND = fixedError(
  "not_found",
  "The managed runtime turn is not available for replay.",
  false,
);
const INVALID_TURN_STATE = fixedError(
  "internal_error",
  "The managed runtime turn state is invalid.",
  false,
);
const CONFLICTING_TURN_STATE = fixedError(
  "conflict",
  "The managed runtime turn state conflicts with an existing replay.",
  false,
);

function turnStateStoreError(error: unknown): TransportError {
  if (error instanceof ManagedRuntimeTurnStateStoreConflictError) {
    return CONFLICTING_TURN_STATE;
  }
  if (error instanceof ManagedRuntimeTurnStateStoreUnavailableError) {
    return fixedError(
      "unavailable",
      "The managed runtime turn state store is unavailable.",
      error.retryable,
    );
  }
  return INVALID_TURN_STATE;
}

function turnStateRecord(snapshot: TurnSnapshot): ManagedRuntimeTurnStateRecord {
  return parseManagedRuntimeTurnStateRecord({
    schemaVersion: MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION,
    ...snapshot,
  });
}

function snapshotFromTurnState(
  value: unknown,
  conversationId?: string,
  turnId?: string,
): TurnSnapshot {
  const record = parseManagedRuntimeTurnStateRecord(value);
  if (
    (conversationId !== undefined && record.conversationId !== conversationId) ||
    (turnId !== undefined && record.turnId !== turnId)
  ) {
    throw new TypeError("Managed runtime turn state identity mismatch");
  }
  return {
    conversationId: record.conversationId,
    conversationTurnId: record.conversationTurnId,
    mutationId: record.mutationId,
    request: record.request,
    serializedBody: record.serializedBody,
    idempotencyKey: record.idempotencyKey,
    turnId: record.turnId,
  };
}

function discardOpenedStream(opened: OpenedStream): void {
  opened.connection.controller.abort(DISCONNECT_REASON);
  opened.connection.clearTimeout();
}

function timeoutValue(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_TIMEOUT_MS ||
    value > MAX_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }
  return value;
}

function endpointFor(baseUrl: string | URL): URL {
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error();
    if (base.username !== "" || base.password !== "") throw new Error();
    return new URL(CHAT_PATH, base);
  } catch {
    throw new TypeError("baseUrl must be an absolute HTTP(S) URL without credentials");
  }
}

function terminalEvent(event: StreamEvent): event is TerminalStreamEvent {
  return (
    event.type === "response.completed" ||
    event.type === "response.cancelled" ||
    event.type === "response.error"
  );
}

function checkpointFor(event: StreamEvent): TurnResumePoint {
  const eventId = `${event.request_id}:${event.sequence}`;
  return {
    lastAppliedEventId: eventId,
    lastAppliedCursor: eventId,
    lastAppliedRevision: event.sequence,
  };
}

function eventSequenceFromCheckpoint(
  point: TurnResumePoint,
  turnId: string,
): number | null {
  const eventId = point.lastAppliedEventId;
  const cursor = point.lastAppliedCursor;
  if (
    point.lastAppliedRevision !== null &&
    (!Number.isSafeInteger(point.lastAppliedRevision) || point.lastAppliedRevision < 0)
  ) {
    throw new TypeError("lastAppliedRevision is invalid");
  }
  if (eventId === null && cursor === null) {
    if (point.lastAppliedRevision === null) return null;
    throw new TypeError("The managed resume checkpoint fields are incomplete");
  }
  if (eventId === null || cursor === null) {
    throw new TypeError("The managed resume checkpoint fields are incomplete");
  }

  const sequences = [
    ["lastAppliedEventId", eventId],
    ["lastAppliedCursor", cursor],
  ] as const;
  const decodedSequences = sequences.map(([name, value]) => {
    const prefix = `${turnId}:`;
    if (!value.startsWith(prefix)) {
      throw new TypeError(`${name} does not belong to the managed turn`);
    }
    const encodedSequence = value.slice(prefix.length);
    if (!/^(?:0|[1-9]\d*)$/u.test(encodedSequence)) {
      throw new TypeError(`${name} does not contain a valid sequence`);
    }
    const sequence = Number(encodedSequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new TypeError(`${name} does not contain a valid sequence`);
    }
    return sequence;
  });
  if (decodedSequences[0] !== decodedSequences[1]) {
    throw new TypeError("The managed event ID and cursor disagree");
  }
  return decodedSequences[0]!;
}

function containsSensitiveMaterial(
  data: string,
  sensitiveValues: readonly string[],
): boolean {
  if (
    /\bbearer\s+[a-z0-9._~+/=-]{8,}/iu.test(data) ||
    /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/iu.test(data) ||
    /-----begin (?:rsa |ec |openssh )?private key-----/iu.test(data)
  ) {
    return true;
  }
  return sensitiveValues.some((value) => data.includes(value));
}

class ManagedStreamValidator {
  readonly #events: StreamEvent[] = [];
  readonly #sensitiveValues: readonly string[];
  #requestId: string | null = null;
  #traceId: string | null = null;
  #lastUsage: Usage | null = null;
  #terminal: TerminalStreamEvent | null = null;

  constructor(sensitiveValues: readonly string[]) {
    this.#sensitiveValues = sensitiveValues;
  }

  get events(): readonly StreamEvent[] {
    return this.#events;
  }

  get usage(): Usage | null {
    return this.#lastUsage === null ? null : { ...this.#lastUsage };
  }

  get terminal(): TerminalStreamEvent | null {
    return this.#terminal;
  }

  accept(frame: ServerSentEventFrame): StreamEvent {
    if (frame.event === undefined || frame.id === undefined || frame.data === undefined) {
      throw new TypeError("Managed runtime SSE frames require event, id, and data");
    }
    if (containsSensitiveMaterial(frame.data, this.#sensitiveValues)) {
      throw new TypeError("Managed runtime protocol data contained sensitive material");
    }
    if (this.#terminal !== null) {
      throw new TypeError("A managed runtime protocol event followed the terminal event");
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(frame.data);
    } catch {
      throw new TypeError("Managed runtime SSE data must be JSON");
    }
    const event = parseStreamEvent(decoded);
    if (frame.event !== event.type) {
      throw new TypeError("The SSE event field does not match the JSON event type");
    }
    if (frame.id !== `${event.request_id}:${event.sequence}`) {
      throw new TypeError("The SSE id does not match the JSON event envelope");
    }
    if (event.sequence !== this.#events.length) {
      throw new TypeError("Managed runtime event sequences must be contiguous from zero");
    }
    if (this.#events.length === 0) {
      if (event.type !== "response.started") {
        throw new TypeError("response.started must be the first managed runtime event");
      }
      this.#requestId = event.request_id;
      this.#traceId = event.trace_id;
    } else {
      if (event.type === "response.started") {
        throw new TypeError("response.started may appear only once");
      }
      if (event.request_id !== this.#requestId || event.trace_id !== this.#traceId) {
        throw new TypeError("Managed runtime stream identifiers must remain stable");
      }
    }
    if (event.type === "response.usage") {
      if (
        this.#lastUsage !== null &&
        (event.usage.input_tokens < this.#lastUsage.input_tokens ||
          event.usage.output_tokens < this.#lastUsage.output_tokens ||
          event.usage.total_tokens < this.#lastUsage.total_tokens)
      ) {
        throw new TypeError("Managed runtime cumulative usage must not decrease");
      }
      this.#lastUsage = { ...event.usage };
    }
    if (terminalEvent(event)) this.#terminal = event;
    this.#events.push(event);
    return event;
  }

  finish(): TerminalStreamEvent | null {
    if (this.#terminal === null) return null;
    parseStreamEvents(this.#events);
    return this.#terminal;
  }
}

class ManagedObservation implements ManagedRuntimeTurnObservation {
  readonly result: Promise<ManagedRuntimeTurnObservationResult>;
  readonly events: AsyncIterable<StreamEvent>;
  readonly #buffer: StreamEvent[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #resolveResult: (result: ManagedRuntimeTurnObservationResult) => void;
  readonly #attribution: AuthoritativeAttribution;
  readonly #abort: () => void;
  #checkpoint: TurnResumePoint;
  #finalResult: ManagedRuntimeObservationOutcome | null = null;
  #closed = false;
  #disconnected = false;
  #settled = false;

  constructor(
    attribution: AuthoritativeAttribution,
    checkpoint: TurnResumePoint,
    abort: () => void,
  ) {
    this.#attribution = attribution;
    this.#checkpoint = checkpoint;
    this.#abort = abort;
    let resolveResult!: (result: ManagedRuntimeTurnObservationResult) => void;
    this.result = new Promise((resolve) => {
      resolveResult = resolve;
    });
    this.#resolveResult = resolveResult;
    this.events = { [Symbol.asyncIterator]: () => this.#iterate() };
  }

  disconnect(): void {
    if (this.#settled || this.#disconnected) return;
    this.#disconnected = true;
    this.#abort();
    this.#buffer.length = 0;
    this.#settle({
      status: "disconnected",
      attribution: this.#attribution,
      usage: null,
      usageReceipt: null,
      checkpoint: this.#checkpoint,
    });
    this.#wake();
  }

  push(event: StreamEvent): void {
    if (this.#closed || this.#disconnected) return;
    this.#buffer.push(event);
    this.#wake();
  }

  close(result: ManagedRuntimeObservationOutcome): void {
    if (this.#closed || this.#disconnected) return;
    this.#closed = true;
    this.#finalResult = result;
    this.#settleIfDrained();
    this.#wake();
  }

  async *#iterate(): AsyncGenerator<StreamEvent, void, void> {
    try {
      while (!this.#disconnected) {
        const event = this.#buffer.shift();
        if (event !== undefined) {
          this.#checkpoint = checkpointFor(event);
          yield event;
          this.#settleIfDrained();
          continue;
        }
        if (this.#closed) {
          this.#settleIfDrained();
          return;
        }
        await new Promise<void>((resolve) => this.#waiters.add(resolve));
      }
    } finally {
      if (!this.#closed && !this.#disconnected) this.disconnect();
    }
  }

  #settleIfDrained(): void {
    if (this.#finalResult === null || this.#buffer.length > 0) return;
    this.#settle({ ...this.#finalResult, checkpoint: this.#checkpoint });
  }

  #settle(result: ManagedRuntimeTurnObservationResult): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolveResult(result);
  }

  #wake(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }
}

function problemErrorFor(status: number): TransportError {
  switch (status) {
    case 400:
    case 422:
      return INVALID_REQUEST;
    case 401:
      return fixedError("unauthenticated", "Managed runtime authentication failed.", false);
    case 403:
      return fixedError("forbidden", "Managed runtime access was denied.", false);
    case 404:
      return fixedError("not_found", "The managed runtime endpoint was not found.", false);
    case 409:
      return fixedError(
        "conflict",
        "The idempotency key conflicts with a different managed runtime request.",
        false,
      );
    case 408:
    case 504:
      return TIMED_OUT;
    case 429:
      return fixedError("rate_limited", "The managed runtime rate limit was reached.", true);
    case 502:
    case 503:
      return fixedError("unavailable", "The managed runtime is temporarily unavailable.", true);
    default:
      return fixedError(
        "internal_error",
        "The managed runtime returned an unexpected error response.",
        status >= 500,
      );
  }
}

async function readBoundedText(response: Response): Promise<string> {
  if (response.body === null) throw new TypeError("Missing problem body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_PROBLEM_BYTES) throw new TypeError("Problem body is too large");
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function validateProblemResponse(
  response: Response,
  signal: AbortSignal,
): Promise<boolean> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType?.toLowerCase() !== "application/problem+json") return false;
  try {
    const value: unknown = JSON.parse(
      await awaitWithAbort(readBoundedText(response), signal),
    );
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const problem = value as Record<string, unknown>;
    return (
      problem.status === response.status &&
      typeof problem.type === "string" &&
      typeof problem.title === "string" &&
      typeof problem.category === "string" &&
      typeof problem.code === "string" &&
      typeof problem.message === "string" &&
      problem.message.length <= 1_024 &&
      typeof problem.request_id === "string" &&
      typeof problem.trace_id === "string" &&
      typeof problem.retryable === "boolean"
    );
  } catch {
    return false;
  }
}

function terminalTransportError(event: TerminalStreamEvent): TransportError | null {
  if (event.type !== "response.error") return null;
  switch (event.error.code) {
    case "invalid_request":
      return INVALID_REQUEST;
    case "unauthenticated":
      return fixedError("unauthenticated", "Managed runtime authentication failed.", false);
    case "forbidden":
    case "policy_denied":
      return fixedError("forbidden", "Managed runtime access was denied.", false);
    case "idempotency_conflict":
      return fixedError("conflict", "The managed runtime request conflicts with prior state.", false);
    case "rate_limited":
    case "capacity_exceeded":
      return fixedError("rate_limited", "The managed runtime is temporarily at capacity.", true);
    case "deadline_exceeded":
      return TIMED_OUT;
    case "upstream_unavailable":
      return fixedError("unavailable", "The managed runtime is temporarily unavailable.", true);
    case "internal_error":
      return fixedError("internal_error", "The managed runtime could not complete the request.", true);
  }
}

function abortError(signal: AbortSignal): TransportError {
  return signal.reason === TIMEOUT_REASON ? TIMED_OUT : DISCONNECTED;
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
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

function safeHeaders(
  supplied: HeadersInit,
  idempotencyKey: string,
): { headers: Headers; sensitiveValues: string[] } {
  const headers = new Headers(supplied);
  const sensitiveValues: string[] = [];
  headers.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (
      normalized === "accept" ||
      normalized === "content-type" ||
      normalized === "idempotency-key" ||
      normalized === "content-length" ||
      normalized === "host"
    ) {
      throw new TypeError("Managed runtime authentication headers are invalid");
    }
    if (value.length >= 4) sensitiveValues.push(value);
  });
  headers.set("accept", "text/event-stream");
  headers.set("content-type", "application/json");
  headers.set("idempotency-key", idempotencyKey);
  return { headers, sensitiveValues };
}

async function openStream(
  options: ManagedRuntimeTransportOptions,
  endpoint: URL,
  timeoutMs: number,
  snapshot: Pick<TurnSnapshot, "serializedBody" | "idempotencyKey">,
): Promise<OpenResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(TIMEOUT_REASON), timeoutMs);
  let sensitiveValues: string[];
  try {
    const supplied = await awaitWithAbort(
      Promise.resolve().then(() => options.getHeaders()),
      controller.signal,
    );
    const safe = safeHeaders(supplied, snapshot.idempotencyKey);
    sensitiveValues = safe.sensitiveValues;
    const response = await awaitWithAbort(
      options.fetch(endpoint, {
        method: "POST",
        headers: safe.headers,
        body: snapshot.serializedBody,
        signal: controller.signal,
      }),
      controller.signal,
    );
    if (!response.ok) {
      if (!(await validateProblemResponse(response, controller.signal))) {
        clearTimeout(timer);
        return failure(INVALID_PROTOCOL);
      }
      clearTimeout(timer);
      return failure(problemErrorFor(response.status));
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
    if (response.status !== 200 || contentType?.toLowerCase() !== "text/event-stream") {
      clearTimeout(timer);
      return failure(INVALID_PROTOCOL);
    }
    if (response.body === null) {
      clearTimeout(timer);
      return failure(INVALID_PROTOCOL);
    }
    const frames = parseServerSentEvents(response.body)[Symbol.asyncIterator]();
    const validator = new ManagedStreamValidator(sensitiveValues);
    const item = await awaitWithAbort(frames.next(), controller.signal);
    if (item.done) {
      clearTimeout(timer);
      return failure(INVALID_PROTOCOL);
    }
    const first = validator.accept(item.value);
    if (first.type !== "response.started") {
      clearTimeout(timer);
      return failure(INVALID_PROTOCOL);
    }
    return {
      ok: true,
      value: {
        connection: {
          controller,
          frames,
          clearTimeout: () => clearTimeout(timer),
        },
        validator,
        started: first,
      },
    };
  } catch (error) {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(DISCONNECT_REASON);
    return failure(
      controller.signal.reason === TIMEOUT_REASON
        ? abortError(controller.signal)
        : error instanceof TypeError
          ? INVALID_PROTOCOL
          : DISCONNECTED,
    );
  }
}

function usageReceipt(
  identity: ManagedRuntimeUsageReceiptIdentity,
  input: ManagedRuntimeUsageReceiptInput,
): NormalizedUsageReceipt {
  return parseNormalizedUsageReceipt({
    version: NORMALIZED_USAGE_RECEIPT_VERSION,
    usage_receipt_id: identity.usage_receipt_id,
    conversation_id: input.conversationId,
    turn_id: input.turnId,
    logical_request_id: identity.logical_request_id,
    trace_id: input.traceId,
    attempt: { ...identity.attempt },
    continuation: { ...identity.continuation },
    provider_id: identity.provider_id,
    model_id: identity.model_id,
    attribution: input.attribution,
    source: "runtime",
    terminal_status: input.terminalStatus,
    tokens: {
      input_tokens: { status: "reported", value: input.usage.input_tokens },
      cached_input_tokens: { status: "unavailable" },
      output_tokens: { status: "reported", value: input.usage.output_tokens },
      reasoning_tokens: { status: "unavailable" },
      total_tokens: { status: "reported", value: input.usage.total_tokens },
    },
    provider_cost: { status: "unavailable" },
  });
}

async function resultForTerminal(
  options: ManagedRuntimeTransportOptions,
  snapshot: TurnSnapshot,
  started: ResponseStartedEvent,
  terminal: TerminalStreamEvent,
  usage: Usage | null,
): Promise<ManagedRuntimeObservationOutcome> {
  let receipt: NormalizedUsageReceipt | null = null;
  if (usage !== null && options.createUsageReceiptIdentity !== undefined) {
    const terminalStatus: UsageReceiptTerminalStatus =
      terminal.type === "response.completed"
        ? "completed"
        : terminal.type === "response.cancelled"
          ? "cancelled"
          : "failed";
    const receiptInput: ManagedRuntimeUsageReceiptInput = {
      conversationId: snapshot.conversationId,
      turnId: snapshot.conversationTurnId,
      requestId: started.request_id,
      traceId: started.trace_id,
      attribution: started.attribution,
      usage,
      terminalStatus,
    };
    receipt = usageReceipt(
      await options.createUsageReceiptIdentity(receiptInput),
      receiptInput,
    );
  }
  const common = {
    attribution: started.attribution,
    usage,
    usageReceipt: receipt,
  };
  if (terminal.type === "response.completed") {
    return { status: "completed", ...common };
  }
  if (terminal.type === "response.cancelled") {
    return { status: "cancelled", ...common };
  }
  return {
    status: "failed",
    ...common,
    error: terminalTransportError(terminal) ?? INVALID_PROTOCOL,
  };
}

async function pumpStream(
  options: ManagedRuntimeTransportOptions,
  snapshot: TurnSnapshot,
  opened: OpenedStream,
  observation: ManagedObservation,
  suppressThrough: number | null,
): Promise<void> {
  const { connection, validator, started } = opened;
  try {
    if (suppressThrough === null || started.sequence > suppressThrough) {
      observation.push(started);
    }
    while (true) {
      const item = await awaitWithAbort(
        connection.frames.next(),
        connection.controller.signal,
      );
      if (item.done) break;
      const event = validator.accept(item.value);
      if (!terminalEvent(event) && (suppressThrough === null || event.sequence > suppressThrough)) {
        observation.push(event);
      }
    }
    const terminal = validator.finish();
    if (terminal === null) {
      observation.close({
        status: "disconnected",
        attribution: started.attribution,
        usage: validator.usage,
        usageReceipt: null,
      });
      return;
    }
    if (suppressThrough !== null && suppressThrough > terminal.sequence) {
      throw new TypeError("The managed replay checkpoint exceeds the terminal sequence");
    }
    const result = await resultForTerminal(
      options,
      snapshot,
      started,
      terminal,
      validator.usage,
    );
    if (suppressThrough === null || terminal.sequence > suppressThrough) {
      observation.push(terminal);
    }
    observation.close(result);
  } catch (error) {
    if (connection.controller.signal.reason === DISCONNECT_REASON) return;
    observation.close({
      status: "failed",
      attribution: started.attribution,
      usage: validator.usage,
      usageReceipt: null,
      error: connection.controller.signal.aborted
        ? abortError(connection.controller.signal)
        : error instanceof TypeError
          ? INVALID_PROTOCOL
          : DISCONNECTED,
    });
  } finally {
    connection.clearTimeout();
  }
}

/** Trusted-server transport for the public Handrail AI Runtime v1 endpoint. */
export class ManagedRuntimeTransport implements ManagedRuntimeTransportContract {
  readonly capabilities = {
    authoritativeCancellation: { supported: false },
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  } as const;

  readonly #options: ManagedRuntimeTransportOptions;
  readonly #endpoint: URL;
  readonly #timeoutMs: number;
  readonly #turns = new Map<string, TurnSnapshot>();

  constructor(options: ManagedRuntimeTransportOptions) {
    this.#options = options;
    this.#endpoint = endpointFor(options.baseUrl);
    this.#timeoutMs = timeoutValue(options.timeoutMs);
    if (typeof options.getHeaders !== "function" || typeof options.fetch !== "function") {
      throw new TypeError("Managed runtime header and fetch providers are required");
    }
    if (
      options.turnStateStore !== undefined &&
      (typeof options.turnStateStore.load !== "function" ||
        typeof options.turnStateStore.save !== "function")
    ) {
      throw new TypeError("Managed runtime turn state store is invalid");
    }
  }

  async startTurn(
    input: StartTurnInput<ChatRequest>,
  ): Promise<TransportResult<ManagedRuntimeTurnHandle>> {
    let request: ChatRequest;
    let serializedBody: string;
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) return failure(INVALID_REQUEST);
    try {
      request = parseChatRequest(input.request);
      serializedBody = JSON.stringify(request);
    } catch {
      return failure(INVALID_REQUEST);
    }
    const provisional = {
      conversationId: input.conversationId,
      conversationTurnId: input.conversationTurnId,
      mutationId: input.mutationId,
      request,
      serializedBody,
      idempotencyKey: input.idempotencyKey,
    };
    const opened = await openStream(
      this.#options,
      this.#endpoint,
      this.#timeoutMs,
      provisional,
    );
    if (!opened.ok) return opened;
    let snapshot: TurnSnapshot = {
      ...provisional,
      turnId: opened.value.started.request_id,
    };
    let record: ManagedRuntimeTurnStateRecord;
    try {
      record = turnStateRecord(snapshot);
    } catch {
      discardOpenedStream(opened.value);
      return failure(INVALID_REQUEST);
    }
    if (this.#options.turnStateStore !== undefined) {
      try {
        const saved = await awaitWithAbort(
          Promise.resolve().then(() => this.#options.turnStateStore!.save(record)),
          opened.value.connection.controller.signal,
        );
        const savedRecord = parseManagedRuntimeTurnStateRecord(saved);
        if (JSON.stringify(savedRecord) !== JSON.stringify(record)) {
          throw new TypeError("Managed runtime turn state save changed replay identity");
        }
        snapshot = snapshotFromTurnState(savedRecord);
      } catch (error) {
        const stateError = opened.value.connection.controller.signal.aborted
          ? abortError(opened.value.connection.controller.signal)
          : turnStateStoreError(error);
        discardOpenedStream(opened.value);
        return failure(stateError);
      }
    }
    this.#turns.set(this.#turnKey(snapshot.conversationId, snapshot.turnId), snapshot);
    const observation = this.#observation(snapshot, opened.value, null, {
      lastAppliedEventId: null,
      lastAppliedCursor: null,
      lastAppliedRevision: null,
    });
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        turnId: snapshot.turnId,
        mutationId: input.mutationId,
        attribution: opened.value.started.attribution,
        observation,
      },
    };
  }

  async resumeTurn(
    input: ResumeTurnInput,
  ): Promise<TransportResult<ManagedRuntimeTurnObservation>> {
    const key = this.#turnKey(input.conversationId, input.turnId);
    let snapshot = this.#turns.get(key);
    if (snapshot === undefined && this.#options.turnStateStore !== undefined) {
      let loaded: ManagedRuntimeTurnStateRecord | null;
      try {
        loaded = await this.#options.turnStateStore.load(
          input.conversationId,
          input.turnId,
        );
      } catch (error) {
        return failure(turnStateStoreError(error));
      }
      if (loaded === null) return failure(TURN_STATE_NOT_FOUND);
      try {
        snapshot = snapshotFromTurnState(
          loaded,
          input.conversationId,
          input.turnId,
        );
      } catch {
        return failure(INVALID_TURN_STATE);
      }
      this.#turns.set(key, snapshot);
    }
    if (snapshot === undefined) return failure(TURN_STATE_NOT_FOUND);
    let suppressThrough: number | null;
    try {
      suppressThrough = eventSequenceFromCheckpoint(input.resumeFrom, input.turnId);
    } catch {
      return failure(INVALID_REQUEST);
    }
    const opened = await openStream(
      this.#options,
      this.#endpoint,
      this.#timeoutMs,
      snapshot,
    );
    if (!opened.ok) return opened;
    if (opened.value.started.request_id !== snapshot.turnId) {
      discardOpenedStream(opened.value);
      return failure(INVALID_PROTOCOL);
    }
    return {
      ok: true,
      value: this.#observation(
        snapshot,
        opened.value,
        suppressThrough,
        input.resumeFrom,
      ),
    };
  }

  #observation(
    snapshot: TurnSnapshot,
    opened: OpenedStream,
    suppressThrough: number | null,
    checkpoint: TurnResumePoint,
  ): ManagedRuntimeTurnObservation {
    const observation = new ManagedObservation(
      opened.started.attribution,
      checkpoint,
      () => opened.connection.controller.abort(DISCONNECT_REASON),
    );
    void pumpStream(this.#options, snapshot, opened, observation, suppressThrough);
    return observation;
  }

  #turnKey(conversationId: string, turnId: string): string {
    return `${conversationId.length}:${conversationId}${turnId}`;
  }
}

export function createManagedRuntimeTransport(
  options: ManagedRuntimeTransportOptions,
): ManagedRuntimeTransport {
  return new ManagedRuntimeTransport(options);
}
