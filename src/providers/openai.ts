import {
  AI_RUNTIME_PROTOCOL_VERSION,
  type ApplicationToolResult,
  type AttachmentReference,
  type CancellationReason,
  type ChatMessage,
  type JsonObject,
  type ProtocolMetadata,
  type StreamEvent,
} from "../protocol.js";
import type {
  ClientRequestError,
  ProviderAdapter,
  ProviderAdapterError,
  ProviderAdapterInvocation,
  ProviderAdapterMetadata,
  ProviderAdapterResult,
  ProviderAdapterStream,
  ProviderUsage,
} from "./index.js";
import {
  createOpenAIProviderContextCapability,
  type OpenAIProviderContextCompactRequestFunction,
  type OpenAIProviderContextInput,
  type OpenAIProviderContextMeasureRequestFunction,
} from "./openai-context.js";
import type { ProviderContextCapability } from "../provider-context.js";

export * from "./openai-context.js";

export interface OpenAIImageSource {
  readonly url: string;
  readonly detail?: "auto" | "low" | "high";
}

export interface OpenAIChatCompletionTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface OpenAIChatCompletionImagePart {
  readonly type: "image_url";
  readonly image_url: OpenAIImageSource;
}

export interface OpenAIChatCompletionMessage {
  readonly role: "user" | "assistant";
  readonly content:
    | string
    | readonly (OpenAIChatCompletionTextPart | OpenAIChatCompletionImagePart)[];
}

export interface OpenAIChatCompletionToolResultMessage {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
}

export interface OpenAIChatCompletionAssistantToolCallMessage {
  readonly role: "assistant";
  readonly content: null;
  readonly tool_calls: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: {
      readonly name: string;
      readonly arguments: "{}";
    };
  }[];
}

export interface OpenAIChatCompletionTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonObject;
  };
}

/**
 * The SDK-independent subset accepted by OpenAI's streaming Chat Completions
 * boundary. Hosts may adapt this to an already-configured OpenAI client.
 */
export interface OpenAIChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly (
    | OpenAIChatCompletionMessage
    | OpenAIChatCompletionAssistantToolCallMessage
    | OpenAIChatCompletionToolResultMessage
  )[];
  readonly tools?: readonly OpenAIChatCompletionTool[];
  readonly parallel_tool_calls?: false;
  readonly max_completion_tokens: number;
  readonly temperature: number;
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
}

export interface OpenAIRequestOptions {
  readonly signal: AbortSignal;
}

export type OpenAIChatCompletionRequestFunction = (
  request: OpenAIChatCompletionRequest,
  options: OpenAIRequestOptions,
) =>
  | AsyncIterable<unknown>
  | Promise<AsyncIterable<unknown>>;

export type OpenAIImageReferenceResolver = (
  attachment: AttachmentReference,
) => OpenAIImageSource | Promise<OpenAIImageSource>;

export interface OpenAIProviderAdapterOptions {
  readonly model: string;
  readonly request: OpenAIChatCompletionRequestFunction;
  readonly measure_context?: OpenAIProviderContextMeasureRequestFunction;
  readonly compact_context?: OpenAIProviderContextCompactRequestFunction;
  readonly resolve_image_reference?: OpenAIImageReferenceResolver;
  readonly context_window_tokens?: number | null;
  readonly max_output_tokens?: number | null;
  readonly supports_tool_calls?: boolean;
}

type UnknownRecord = Record<string, unknown>;

interface ToolCallAssembly {
  id?: string;
  name?: string;
  argumentsText: string;
}

interface ParsedCompletion {
  outcome: "stop" | "length" | "tool_calls";
  toolCalls: readonly {
    tool_call_id: string;
    name: string;
    arguments: JsonObject;
  }[];
  usage: ProviderUsage;
}

class OpenAIPreflightError extends Error {}
class OpenAIMalformedStreamError extends Error {}

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function setStableFragment(
  assembly: ToolCallAssembly,
  key: "id" | "name",
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || value.length === 0) {
    throw new OpenAIMalformedStreamError();
  }
  if (assembly[key] !== undefined && assembly[key] !== value) {
    throw new OpenAIMalformedStreamError();
  }
  assembly[key] = value;
}

function parseUsage(value: unknown): ProviderUsage {
  const usage = record(value);
  if (!usage) throw new OpenAIMalformedStreamError();

  const inputTokens = safeInteger(usage.prompt_tokens);
  const outputTokens = safeInteger(usage.completion_tokens);
  const totalTokens = safeInteger(usage.total_tokens);
  if (
    inputTokens === null ||
    outputTokens === null ||
    totalTokens === null ||
    totalTokens !== inputTokens + outputTokens
  ) {
    throw new OpenAIMalformedStreamError();
  }

  const promptDetails =
    usage.prompt_tokens_details === undefined
      ? null
      : record(usage.prompt_tokens_details);
  const completionDetails =
    usage.completion_tokens_details === undefined
      ? null
      : record(usage.completion_tokens_details);
  if (
    (usage.prompt_tokens_details !== undefined && !promptDetails) ||
    (usage.completion_tokens_details !== undefined && !completionDetails)
  ) {
    throw new OpenAIMalformedStreamError();
  }

  const cachedTokens =
    promptDetails?.cached_tokens === undefined
      ? 0
      : safeInteger(promptDetails.cached_tokens);
  const reasoningTokens =
    completionDetails?.reasoning_tokens === undefined
      ? 0
      : safeInteger(completionDetails.reasoning_tokens);
  if (
    cachedTokens === null ||
    reasoningTokens === null ||
    cachedTokens > inputTokens ||
    reasoningTokens > outputTokens
  ) {
    throw new OpenAIMalformedStreamError();
  }

  return {
    input_tokens: inputTokens,
    cached_input_tokens: cachedTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens,
    total_tokens: totalTokens,
    provider_cost: { known: false },
  };
}

function toolResultContent(result: ApplicationToolResult): string {
  const content = result.content
    .map((part) =>
      part.type === "text" ? part.text : JSON.stringify(part.value),
    )
    .join("\n");
  return result.is_error ? `[tool error]\n${content}` : content;
}

async function mapMessage(
  message: ChatMessage,
  resolveImageReference: OpenAIImageReferenceResolver | undefined,
): Promise<OpenAIChatCompletionMessage> {
  if (message.content.every((part) => part.type === "text")) {
    return {
      role: message.role,
      content: message.content.map((part) => part.text).join(""),
    };
  }

  const content: (OpenAIChatCompletionTextPart | OpenAIChatCompletionImagePart)[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (!resolveImageReference) throw new OpenAIPreflightError();
    const source = await resolveImageReference(part.attachment);
    if (
      !source ||
      typeof source.url !== "string" ||
      source.url.length === 0 ||
      (source.detail !== undefined &&
        !["auto", "low", "high"].includes(source.detail))
    ) {
      throw new OpenAIPreflightError();
    }
    content.push({ type: "image_url", image_url: source });
  }
  return { role: message.role, content };
}

function cancellationReason(signal: AbortSignal): CancellationReason {
  return signal.reason === "deadline_exceeded" ||
    signal.reason === "policy_revoked" ||
    signal.reason === "runtime_shutdown"
    ? signal.reason
    : "runtime_shutdown";
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  try {
    return record(error)?.name === "AbortError";
  } catch {
    return false;
  }
}

function errorStatus(error: unknown): number | null {
  try {
    const status = record(error)?.status;
    return Number.isInteger(status) ? (status as number) : null;
  } catch {
    return null;
  }
}

function normalizeFailure(error: unknown): ProviderAdapterError {
  if (error instanceof OpenAIPreflightError) {
    return {
      kind: "client",
      retryable: false,
      code: "invalid_request",
      message: "The request uses a capability not configured for this adapter.",
    };
  }
  if (error instanceof OpenAIMalformedStreamError) {
    return {
      kind: "provider",
      retryable: true,
      code: "upstream_unavailable",
      message: "The provider returned malformed streaming data.",
    };
  }

  const status = errorStatus(error);
  if (status === 429) {
    return {
      kind: "provider",
      retryable: true,
      code: "rate_limited",
      message: "The provider rate limit was reached.",
    };
  }
  if (status === 408) {
    return {
      kind: "provider",
      retryable: true,
      code: "deadline_exceeded",
      message: "The provider request timed out.",
    };
  }
  if (status !== null && status >= 500) {
    return {
      kind: "provider",
      retryable: true,
      code: "upstream_unavailable",
      message: "The provider is temporarily unavailable.",
    };
  }

  const clientError = (
    code: ClientRequestError["code"],
    message: string,
  ): ClientRequestError => ({
    kind: "client",
    retryable: false,
    code,
    message,
  });
  if (status === 401) return clientError("unauthenticated", "Provider authentication failed.");
  if (status === 403) return clientError("forbidden", "The provider denied the request.");
  if (status === 409) {
    return clientError("idempotency_conflict", "The provider rejected a conflicting request.");
  }
  if (status !== null && status >= 400 && status < 500) {
    return clientError("invalid_request", "The provider rejected the request as invalid.");
  }
  return {
    kind: "provider",
    retryable: true,
    code: "upstream_unavailable",
    message: "The provider request failed.",
  };
}

function publicError(error: ProviderAdapterError) {
  if (error.kind === "policy") {
    return {
      category: "policy" as const,
      code: error.code,
      message: error.message,
      retryable: false,
    };
  }
  if (error.kind === "provider") {
    return {
      category: "upstream" as const,
      code: error.code,
      message: error.message,
      retryable: true,
    };
  }
  return {
    category:
      error.code === "unauthenticated"
        ? ("authentication" as const)
        : error.code === "forbidden"
          ? ("authorization" as const)
          : ("request" as const),
    code: error.code,
    message: error.message,
    retryable: false,
  };
}

function envelope(
  invocation: ProviderAdapterInvocation,
  type: StreamEvent["type"],
  sequence: number,
): {
  type: StreamEvent["type"];
  protocol_version: typeof AI_RUNTIME_PROTOCOL_VERSION;
  request_id: string;
  trace_id: string;
  sequence: number;
  metadata?: ProtocolMetadata;
} {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: invocation.context.request_id,
    trace_id: invocation.context.trace_id,
    sequence,
    ...(invocation.context.metadata === undefined
      ? {}
      : { metadata: invocation.context.metadata }),
  };
}

export class OpenAIProviderAdapter implements ProviderAdapter {
  readonly metadata: ProviderAdapterMetadata;
  readonly provider_context: ProviderContextCapability<OpenAIProviderContextInput>;
  private readonly request: OpenAIChatCompletionRequestFunction;
  private readonly resolveImageReference: OpenAIImageReferenceResolver | undefined;

  constructor(options: OpenAIProviderAdapterOptions) {
    if (typeof options.model !== "string" || options.model.length === 0) {
      throw new TypeError("model must be a non-empty string");
    }
    if (typeof options.request !== "function") {
      throw new TypeError("request must be a function");
    }
    this.request = options.request;
    this.resolveImageReference = options.resolve_image_reference;
    this.provider_context = createOpenAIProviderContextCapability({
      model: options.model,
      ...(options.measure_context === undefined
        ? {}
        : { measure_context: options.measure_context }),
      ...(options.compact_context === undefined
        ? {}
        : { compact_context: options.compact_context }),
    });
    this.metadata = {
      provider_id: "openai",
      model_id: options.model,
      capabilities: {
        streaming: true,
        text: true,
        tool_calls: options.supports_tool_calls ?? true,
        parallel_tool_calls: false,
        reasoning: true,
        document_input: { supported: false },
        context_window_tokens: options.context_window_tokens ?? null,
        max_output_tokens: options.max_output_tokens ?? null,
      },
    };
  }

  invoke(invocation: ProviderAdapterInvocation): ProviderAdapterStream {
    return this.stream(invocation);
  }

  private async requestPayload(
    invocation: ProviderAdapterInvocation,
  ): Promise<OpenAIChatCompletionRequest> {
    if (invocation.messages.length === 0) throw new OpenAIPreflightError();
    if (
      !this.metadata.capabilities.tool_calls &&
      (invocation.tools.length > 0 || invocation.tool_results.length > 0)
    ) {
      throw new OpenAIPreflightError();
    }
    if (
      this.metadata.capabilities.max_output_tokens !== null &&
      invocation.generation.max_output_tokens >
        this.metadata.capabilities.max_output_tokens
    ) {
      throw new OpenAIPreflightError();
    }
    if (
      invocation.messages.some((message) =>
        message.content.some((part) => part.type === "document"),
      )
    ) {
      throw new OpenAIPreflightError();
    }
    if (
      invocation.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((part) => part.type === "image"),
      ) ||
      (invocation.messages.some((message) =>
        message.content.some((part) => part.type === "image"),
      ) &&
        !this.resolveImageReference)
    ) {
      throw new OpenAIPreflightError();
    }

    const messages = await Promise.all(
      invocation.messages.map((message) =>
        mapMessage(message, this.resolveImageReference),
      ),
    );
    const toolResults: OpenAIChatCompletionToolResultMessage[] =
      invocation.tool_results.map((result) => ({
        role: "tool",
        tool_call_id: result.tool_call_id,
        content: toolResultContent(result),
      }));
    const toolResultContext: OpenAIChatCompletionAssistantToolCallMessage[] =
      invocation.tool_results.length === 0
        ? []
        : [{
            role: "assistant",
            content: null,
            tool_calls: invocation.tool_results.map((result) => ({
              id: result.tool_call_id,
              type: "function",
              function: { name: result.name, arguments: "{}" },
            })),
          }];
    const tools = invocation.tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));

    return {
      model: this.metadata.model_id,
      messages: [...messages, ...toolResultContext, ...toolResults],
      ...(tools.length === 0
        ? {}
        : { tools, parallel_tool_calls: false as const }),
      max_completion_tokens: invocation.generation.max_output_tokens,
      temperature: invocation.generation.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
  }

  private async *stream(
    invocation: ProviderAdapterInvocation,
  ): ProviderAdapterStream {
    let sequence = 0;
    yield {
      ...envelope(invocation, "response.started", sequence++),
      type: "response.started",
      attribution: invocation.context.attribution,
    };

    if (invocation.signal.aborted) {
      const reason = cancellationReason(invocation.signal);
      yield {
        ...envelope(invocation, "response.cancelled", sequence),
        type: "response.cancelled",
        reason,
      };
      return { status: "cancelled", reason, usage: null };
    }

    let parsed: ParsedCompletion;
    try {
      const payload = await this.requestPayload(invocation);
      if (invocation.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const chunks = await this.request(payload, { signal: invocation.signal });
      if (!chunks || typeof chunks[Symbol.asyncIterator] !== "function") {
        throw new OpenAIMalformedStreamError();
      }

      const toolCalls = new Map<number, ToolCallAssembly>();
      let finishReason: string | null = null;
      let usage: ProviderUsage | null = null;

      for await (const chunkValue of chunks) {
        if (invocation.signal.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const chunk = record(chunkValue);
        if (!chunk || !Array.isArray(chunk.choices) || chunk.choices.length > 1) {
          throw new OpenAIMalformedStreamError();
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          if (usage !== null) throw new OpenAIMalformedStreamError();
          usage = parseUsage(chunk.usage);
        }
        if (chunk.choices.length === 0) continue;

        const choice = record(chunk.choices[0]);
        if (!choice) throw new OpenAIMalformedStreamError();
        if (choice.index !== undefined && choice.index !== 0) {
          throw new OpenAIMalformedStreamError();
        }
        const delta = choice.delta === undefined ? null : record(choice.delta);
        if (choice.delta !== undefined && !delta) {
          throw new OpenAIMalformedStreamError();
        }
        if (delta?.content !== undefined && delta.content !== null) {
          if (typeof delta.content !== "string") {
            throw new OpenAIMalformedStreamError();
          }
          if (delta.content.length > 0) {
            yield {
              ...envelope(invocation, "response.text.delta", sequence++),
              type: "response.text.delta",
              delta: delta.content,
            };
          }
        }
        if (delta?.tool_calls !== undefined) {
          if (!Array.isArray(delta.tool_calls)) {
            throw new OpenAIMalformedStreamError();
          }
          for (const fragmentValue of delta.tool_calls) {
            const fragment = record(fragmentValue);
            const index = safeInteger(fragment?.index);
            if (!fragment || index === null) {
              throw new OpenAIMalformedStreamError();
            }
            const assembly = toolCalls.get(index) ?? { argumentsText: "" };
            setStableFragment(assembly, "id", fragment.id);
            const fn = fragment.function === undefined ? null : record(fragment.function);
            if (fragment.function !== undefined && !fn) {
              throw new OpenAIMalformedStreamError();
            }
            setStableFragment(assembly, "name", fn?.name);
            if (fn?.arguments !== undefined && fn.arguments !== null) {
              if (typeof fn.arguments !== "string") {
                throw new OpenAIMalformedStreamError();
              }
              assembly.argumentsText += fn.arguments;
            }
            toolCalls.set(index, assembly);
          }
        }

        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (
            typeof choice.finish_reason !== "string" ||
            (finishReason !== null && finishReason !== choice.finish_reason)
          ) {
            throw new OpenAIMalformedStreamError();
          }
          finishReason = choice.finish_reason;
        }
      }

      if (!usage || finishReason === null) throw new OpenAIMalformedStreamError();
      if (finishReason === "content_filter") {
        const policyError: ProviderAdapterError = {
          kind: "policy",
          retryable: false,
          code: "policy_denied",
          message: "The provider stopped the response due to policy.",
        };
        yield {
          ...envelope(invocation, "response.usage", sequence++),
          type: "response.usage",
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            total_tokens: usage.total_tokens,
          },
        };
        yield {
          ...envelope(invocation, "response.error", sequence++),
          type: "response.error",
          error: publicError(policyError),
        };
        return { status: "failed", error: policyError, usage };
      }

      const outcome =
        finishReason === "stop"
          ? "stop"
          : finishReason === "length"
            ? "length"
            : finishReason === "tool_calls" || finishReason === "function_call"
              ? "tool_calls"
              : null;
      if (!outcome) throw new OpenAIMalformedStreamError();

      const completedToolCalls = [...toolCalls.entries()]
        .sort(([left], [right]) => left - right)
        .map(([index, assembly], position) => {
          if (index !== position) throw new OpenAIMalformedStreamError();
          if (!assembly.id || !assembly.name) {
            throw new OpenAIMalformedStreamError();
          }
          let argumentsValue: unknown;
          try {
            argumentsValue = JSON.parse(assembly.argumentsText);
          } catch {
            throw new OpenAIMalformedStreamError();
          }
          if (!record(argumentsValue)) throw new OpenAIMalformedStreamError();
          return {
            tool_call_id: assembly.id,
            name: assembly.name,
            arguments: argumentsValue as JsonObject,
          };
        });
      if (
        new Set(completedToolCalls.map((toolCall) => toolCall.tool_call_id)).size !==
        completedToolCalls.length
      ) {
        throw new OpenAIMalformedStreamError();
      }
      if (
        (outcome === "tool_calls" && completedToolCalls.length === 0) ||
        (outcome !== "tool_calls" && completedToolCalls.length > 0)
      ) {
        throw new OpenAIMalformedStreamError();
      }
      parsed = { outcome, toolCalls: completedToolCalls, usage };
    } catch (error) {
      if (isAbortError(error, invocation.signal)) {
        const reason = cancellationReason(invocation.signal);
        yield {
          ...envelope(invocation, "response.cancelled", sequence),
          type: "response.cancelled",
          reason,
        };
        return { status: "cancelled", reason, usage: null };
      }
      const normalized = normalizeFailure(error);
      yield {
        ...envelope(invocation, "response.error", sequence),
        type: "response.error",
        error: publicError(normalized),
      };
      return { status: "failed", error: normalized, usage: null };
    }

    for (const toolCall of parsed.toolCalls) {
      yield {
        ...envelope(invocation, "response.tool_call", sequence++),
        type: "response.tool_call",
        ...toolCall,
      };
    }
    yield {
      ...envelope(invocation, "response.usage", sequence++),
      type: "response.usage",
      usage: {
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
        total_tokens: parsed.usage.total_tokens,
      },
    };
    yield {
      ...envelope(invocation, "response.completed", sequence),
      type: "response.completed",
      outcome: parsed.outcome,
    };
    return {
      status: "completed",
      outcome: parsed.outcome,
      usage: parsed.usage,
    } satisfies ProviderAdapterResult;
  }
}

export function createOpenAIProviderAdapter(
  options: OpenAIProviderAdapterOptions,
): OpenAIProviderAdapter {
  return new OpenAIProviderAdapter(options);
}
