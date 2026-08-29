import {
  PROVIDER_CONTEXT_CONTRACT_VERSION,
  ProviderContextOperationError,
  ProviderContextValidationError,
  createProviderContextFingerprint,
  parseProviderContextCompactionRequest,
  parseProviderContextCompactionResult,
  parseProviderContextMeasurementRequest,
  parseProviderContextMeasurementResult,
  parseProviderContextSafeError,
  type ProviderContextCapability,
  type ProviderContextCheckpoint,
  type ProviderContextCompactionRequest,
  type ProviderContextCompactionResult,
  type ProviderContextFingerprint,
  type ProviderContextHistoryPosition,
  type ProviderContextIdempotencyKey,
  type ProviderContextMeasurementRequest,
  type ProviderContextMeasurementResult,
  type SupportedProviderContextCapability,
} from "../provider-context.js";
import {
  AI_RUNTIME_PROTOCOL_VERSION,
  ProtocolValidationError,
  parseChatRequest,
  type ApplicationToolResult,
  type ChatMessage,
  type GenerationSettings,
  type JsonObject,
  type ToolDefinition,
} from "../protocol.js";

export const OPENAI_PROVIDER_CONTEXT_LIMITS = Object.freeze({
  requestSerializedBytes: 2_097_152,
  idempotencyEntries: 64,
} as const);

/** Canonical, provider-neutral context supplied ephemerally by the application. */
export interface OpenAIProviderContextInput {
  readonly instructions: readonly string[];
  readonly messages: readonly ChatMessage[];
  readonly tool_results: readonly ApplicationToolResult[];
  readonly tools: readonly ToolDefinition[];
  readonly generation: GenerationSettings;
  readonly provider_settings?: JsonObject;
}

/** SDK-independent request projected to an application-injected measurement operation. */
export interface OpenAIProviderContextMeasureRequest
  extends OpenAIProviderContextInput {
  readonly model: string;
  readonly context_fingerprint: ProviderContextFingerprint;
  readonly history_position: ProviderContextHistoryPosition;
  readonly checkpoint: ProviderContextCheckpoint | null;
}

/** SDK-independent request projected to an application-injected compaction operation. */
export interface OpenAIProviderContextCompactRequest
  extends OpenAIProviderContextMeasureRequest {
  readonly idempotency_key: ProviderContextIdempotencyKey;
  readonly target_input_tokens: number;
}

export interface OpenAIProviderContextRequestOptions {
  readonly signal: AbortSignal;
}

export type OpenAIProviderContextMeasurementResponse =
  ProviderContextMeasurementResult;
export type OpenAIProviderContextCompactionResponse =
  ProviderContextCompactionResult;

export type OpenAIProviderContextMeasureRequestFunction = (
  request: OpenAIProviderContextMeasureRequest,
  options: OpenAIProviderContextRequestOptions,
) => unknown | Promise<unknown>;

export type OpenAIProviderContextCompactRequestFunction = (
  request: OpenAIProviderContextCompactRequest,
  options: OpenAIProviderContextRequestOptions,
) => unknown | Promise<unknown>;

export interface OpenAIProviderContextOptions {
  readonly model: string;
  readonly measure_context?: OpenAIProviderContextMeasureRequestFunction;
  readonly compact_context?: OpenAIProviderContextCompactRequestFunction;
}

interface PreparedContextRequest {
  readonly input: OpenAIProviderContextInput;
  readonly fingerprint: ProviderContextFingerprint;
  readonly historyPosition: ProviderContextHistoryPosition;
  readonly checkpoint: ProviderContextCheckpoint | null;
  readonly signal: AbortSignal;
}

interface IdempotencyEntry {
  readonly identity: string;
  readonly promise: Promise<ProviderContextCompactionResult>;
  settled: boolean;
}

type UnknownRecord = Record<string, unknown>;

const UTF8_ENCODER = new TextEncoder();
const UNSUPPORTED_PROVIDER_CONTEXT = Object.freeze({
  supported: false,
  reason: "compaction_not_configured",
} as const);

function plainRecord(value: unknown): UnknownRecord | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return null;
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function parseInput(value: unknown): OpenAIProviderContextInput {
  const source = plainRecord(value);
  if (
    !source ||
    !exactKeys(
      source,
      ["instructions", "messages", "tool_results", "tools", "generation"],
      ["provider_settings"],
    ) ||
    !Array.isArray(source.instructions)
  ) {
    throw new ProviderContextOperationError("invalid_request");
  }

  const parsed = parseChatRequest({
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    continuation_of:
      Array.isArray(source.tool_results) && source.tool_results.length > 0
        ? "provider-context"
        : null,
    messages: source.messages,
    tools: source.tools,
    tool_results: source.tool_results,
    generation: source.generation,
    correlation_hints: {},
  });

  return Object.freeze({
    instructions: Object.freeze([...source.instructions]) as readonly string[],
    messages: Object.freeze([...parsed.messages]),
    tool_results: Object.freeze([...parsed.tool_results]),
    tools: Object.freeze([...parsed.tools]),
    generation: Object.freeze({ ...parsed.generation }),
    ...(Object.hasOwn(source, "provider_settings")
      ? { provider_settings: source.provider_settings as JsonObject }
      : {}),
  });
}

function sameHistoryPosition(
  left: ProviderContextHistoryPosition,
  right: ProviderContextHistoryPosition,
): boolean {
  return left.conversation_id === right.conversation_id &&
    left.revision === right.revision &&
    left.event_id === right.event_id;
}

function expectedFingerprint(
  model: string,
  input: OpenAIProviderContextInput,
): ProviderContextFingerprint {
  return createProviderContextFingerprint({
    model: { provider_id: "openai", model_id: model },
    instructions: input.instructions,
    tools: input.tools,
    generation: input.generation,
    ...(input.provider_settings === undefined
      ? {}
      : { provider_settings: input.provider_settings }),
  });
}

function safeExpectedFingerprint(
  model: string,
  input: OpenAIProviderContextInput,
): ProviderContextFingerprint {
  try {
    return expectedFingerprint(model, input);
  } catch {
    throw new ProviderContextOperationError("invalid_request");
  }
}

function prepareRequest(
  model: string,
  request:
    | ProviderContextMeasurementRequest<OpenAIProviderContextInput>
    | ProviderContextCompactionRequest<OpenAIProviderContextInput>,
  compact: boolean,
): PreparedContextRequest & {
  readonly idempotencyKey?: ProviderContextIdempotencyKey;
  readonly targetInputTokens?: number;
} {
  let parsed:
    | ProviderContextMeasurementRequest<OpenAIProviderContextInput>
    | ProviderContextCompactionRequest<OpenAIProviderContextInput>;
  try {
    parsed = compact
      ? parseProviderContextCompactionRequest(request, parseInput)
      : parseProviderContextMeasurementRequest(request, parseInput);
  } catch (error) {
    if (error instanceof ProviderContextOperationError) throw error;
    if (
      error instanceof ProviderContextValidationError ||
      error instanceof ProtocolValidationError
    ) {
      throw new ProviderContextOperationError("invalid_request");
    }
    throw new ProviderContextOperationError("invalid_request");
  }

  const fingerprint = safeExpectedFingerprint(model, parsed.input);
  if (parsed.context_fingerprint !== fingerprint) {
    throw new ProviderContextOperationError("invalid_request");
  }
  if (parsed.checkpoint !== null && parsed.checkpoint.provider_id !== "openai") {
    throw new ProviderContextOperationError("invalid_request");
  }

  return {
    input: parsed.input,
    fingerprint,
    historyPosition: parsed.history_position,
    checkpoint: parsed.checkpoint,
    signal: parsed.signal,
    ...(compact
      ? {
          idempotencyKey: (
            parsed as ProviderContextCompactionRequest<OpenAIProviderContextInput>
          ).idempotency_key,
          targetInputTokens: (
            parsed as ProviderContextCompactionRequest<OpenAIProviderContextInput>
          ).target_input_tokens,
        }
      : {}),
  };
}

function projection(
  model: string,
  prepared: PreparedContextRequest,
): OpenAIProviderContextMeasureRequest {
  return Object.freeze({
    model,
    instructions: prepared.input.instructions,
    messages: prepared.input.messages,
    tool_results: prepared.input.tool_results,
    tools: prepared.input.tools,
    generation: prepared.input.generation,
    ...(prepared.input.provider_settings === undefined
      ? {}
      : { provider_settings: prepared.input.provider_settings }),
    context_fingerprint: prepared.fingerprint,
    history_position: prepared.historyPosition,
    checkpoint: prepared.checkpoint,
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as UnknownRecord;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

function boundedCanonicalRequest(value: unknown): string {
  const serialized = canonicalJson(value);
  if (
    UTF8_ENCODER.encode(serialized).byteLength >
    OPENAI_PROVIDER_CONTEXT_LIMITS.requestSerializedBytes
  ) {
    throw new ProviderContextOperationError("invalid_request");
  }
  return serialized;
}

async function sha256(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new ProviderContextOperationError("internal_failure");
  const digest = await subtle.digest("SHA-256", UTF8_ENCODER.encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function safeErrorField(error: unknown, field: string): unknown {
  try {
    return error !== null && typeof error === "object" && !Array.isArray(error)
      ? (error as UnknownRecord)[field]
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeUpstreamFailure(
  error: unknown,
  signal: AbortSignal,
): ProviderContextOperationError {
  if (signal.aborted) return new ProviderContextOperationError("cancelled");
  if (error instanceof ProviderContextOperationError) return error;
  try {
    return new ProviderContextOperationError(parseProviderContextSafeError(error).code);
  } catch {
    // Provider-native failures are reduced to status/name/code only.
  }

  const status = safeErrorField(error, "status");
  const name = safeErrorField(error, "name");
  const code = safeErrorField(error, "code");
  if (
    status === 408 ||
    name === "TimeoutError" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT"
  ) {
    return new ProviderContextOperationError("deadline_exceeded");
  }
  if (status === 409) {
    return new ProviderContextOperationError("idempotency_conflict");
  }
  if (
    status === 429 ||
    (typeof status === "number" && status >= 500 && status <= 599)
  ) {
    return new ProviderContextOperationError("provider_unavailable");
  }
  if (typeof status === "number" && status >= 400 && status <= 499) {
    return new ProviderContextOperationError("invalid_request");
  }
  return new ProviderContextOperationError("internal_failure");
}

function rejectIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderContextOperationError("cancelled");
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  rejectIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new ProviderContextOperationError("cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function assertMeasurementIdentity(
  measurement: ProviderContextMeasurementResult,
  prepared: PreparedContextRequest,
): void {
  if (
    measurement.context_fingerprint !== prepared.fingerprint ||
    !sameHistoryPosition(measurement.history_position, prepared.historyPosition)
  ) {
    throw new ProviderContextOperationError("internal_failure");
  }
}

class OpenAIProviderContextCapability
  implements SupportedProviderContextCapability<OpenAIProviderContextInput> {
  readonly supported = true as const;
  readonly version = PROVIDER_CONTEXT_CONTRACT_VERSION;

  private readonly entries = new Map<string, IdempotencyEntry>();

  constructor(
    private readonly model: string,
    private readonly measureRequest: OpenAIProviderContextMeasureRequestFunction,
    private readonly compactRequest: OpenAIProviderContextCompactRequestFunction,
  ) {}

  async measure(
    request: ProviderContextMeasurementRequest<OpenAIProviderContextInput>,
  ): Promise<ProviderContextMeasurementResult> {
    const directSignal = request?.signal;
    if (directSignal?.aborted) {
      throw new ProviderContextOperationError("cancelled");
    }
    const prepared = prepareRequest(this.model, request, false);
    rejectIfAborted(prepared.signal);
    const projected = projection(this.model, prepared);
    boundedCanonicalRequest(projected);

    let raw: unknown;
    try {
      raw = await awaitWithSignal(
        Promise.resolve().then(() =>
          this.measureRequest(projected, { signal: prepared.signal }),
        ),
        prepared.signal,
      );
    } catch (error) {
      throw normalizeUpstreamFailure(error, prepared.signal);
    }

    try {
      const measurement = parseProviderContextMeasurementResult(raw);
      assertMeasurementIdentity(measurement, prepared);
      return measurement;
    } catch (error) {
      if (error instanceof ProviderContextOperationError) throw error;
      throw new ProviderContextOperationError("internal_failure");
    }
  }

  async compact(
    request: ProviderContextCompactionRequest<OpenAIProviderContextInput>,
  ): Promise<ProviderContextCompactionResult> {
    const directSignal = request?.signal;
    if (directSignal?.aborted) {
      throw new ProviderContextOperationError("cancelled");
    }
    const prepared = prepareRequest(this.model, request, true);
    rejectIfAborted(prepared.signal);
    const baseProjection = projection(this.model, prepared);
    const projected = Object.freeze({
      ...baseProjection,
      idempotency_key: prepared.idempotencyKey!,
      target_input_tokens: prepared.targetInputTokens!,
    });
    const identity = await sha256(boundedCanonicalRequest(projected));
    rejectIfAborted(prepared.signal);

    const key = prepared.idempotencyKey!;
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.identity !== identity) {
        throw new ProviderContextOperationError("idempotency_conflict");
      }
      this.entries.delete(key);
      this.entries.set(key, existing);
      return awaitWithSignal(existing.promise, prepared.signal);
    }

    this.reserveCapacity();
    const promise = this.performCompaction(projected, prepared);
    const entry: IdempotencyEntry = { identity, promise, settled: false };
    this.entries.set(key, entry);
    promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    return awaitWithSignal(promise, prepared.signal);
  }

  private reserveCapacity(): void {
    if (this.entries.size < OPENAI_PROVIDER_CONTEXT_LIMITS.idempotencyEntries) {
      return;
    }
    for (const [key, entry] of this.entries) {
      if (entry.settled) {
        this.entries.delete(key);
        return;
      }
    }
    throw new ProviderContextOperationError("provider_unavailable");
  }

  private async performCompaction(
    projected: OpenAIProviderContextCompactRequest,
    prepared: PreparedContextRequest,
  ): Promise<ProviderContextCompactionResult> {
    let raw: unknown;
    try {
      raw = await awaitWithSignal(
        Promise.resolve().then(() =>
          this.compactRequest(projected, { signal: prepared.signal }),
        ),
        prepared.signal,
      );
    } catch (error) {
      throw normalizeUpstreamFailure(error, prepared.signal);
    }

    try {
      const result = parseProviderContextCompactionResult(raw);
      if (result.status === "invalidated") {
        if (
          result.context_fingerprint !== prepared.fingerprint ||
          !sameHistoryPosition(result.history_position, prepared.historyPosition)
        ) {
          throw new ProviderContextOperationError("internal_failure");
        }
        return result;
      }
      assertMeasurementIdentity(result.measurement, prepared);
      if (result.checkpoint !== null && result.checkpoint.provider_id !== "openai") {
        throw new ProviderContextOperationError("internal_failure");
      }
      return result;
    } catch (error) {
      if (error instanceof ProviderContextOperationError) throw error;
      throw new ProviderContextOperationError("internal_failure");
    }
  }
}

export function createOpenAIProviderContextCapability(
  options: OpenAIProviderContextOptions,
): ProviderContextCapability<OpenAIProviderContextInput> {
  const measureConfigured = options.measure_context !== undefined;
  const compactConfigured = options.compact_context !== undefined;
  if (!measureConfigured || !compactConfigured) {
    return UNSUPPORTED_PROVIDER_CONTEXT;
  }
  if (
    typeof options.measure_context !== "function" ||
    typeof options.compact_context !== "function"
  ) {
    throw new TypeError("OpenAI provider-context operations must be functions");
  }
  return new OpenAIProviderContextCapability(
    options.model,
    options.measure_context,
    options.compact_context,
  );
}
