import { AI_RUNTIME_PROTOCOL_VERSION, type AttachmentReference, type CancellationReason, type JsonObject, type StreamEvent } from "../protocol.js";
import { PROVIDER_CONTEXT_NOT_SUPPORTED } from "../provider-context.js";
import { createDeferredToolDiscoveryPlan, type ToolNamespaceDefinition } from "../tools/deferred.js";
import type { ProviderAdapter, ProviderAdapterError, ProviderAdapterInvocation, ProviderAdapterMetadata, ProviderAdapterResult, ProviderAdapterStream, ProviderUsage } from "./index.js";
import { buildOpenAIResponsesRequest, type OpenAIResponsesHostedToolsOptions, type OpenAIResponsesRequest } from "./openai-responses-tools.js";

export interface OpenAIResponsesProviderOptions {
  readonly model: string;
  readonly request: (request: OpenAIResponsesRequest, options: { readonly signal: AbortSignal }) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  readonly namespaces?: readonly ToolNamespaceDefinition[];
  readonly hosted?: OpenAIResponsesHostedToolsOptions;
  readonly supportsToolSearch?: boolean;
  readonly instructions?: string;
  readonly contextWindowTokens?: number | null;
  readonly maxOutputTokens?: number | null;
  readonly resolveAttachment?: (reference: AttachmentReference) => JsonObject;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("OpenAI Responses stream event is invalid");
  return value as RecordValue;
}

function envelope(invocation: ProviderAdapterInvocation, type: StreamEvent["type"], sequence: number) {
  return { type, protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: invocation.context.request_id,
    trace_id: invocation.context.trace_id, sequence,
    ...(invocation.context.metadata ? { metadata: invocation.context.metadata } : {}) };
}

function usage(value: unknown): ProviderUsage {
  const source = record(value);
  const input = source.input_tokens, output = source.output_tokens, total = source.total_tokens;
  if (![input, output, total].every((item) => Number.isSafeInteger(item) && (item as number) >= 0) || total !== (input as number) + (output as number)) {
    throw new TypeError("OpenAI Responses usage is invalid");
  }
  const inputDetails = source.input_tokens_details && typeof source.input_tokens_details === "object" ? record(source.input_tokens_details) : {};
  const outputDetails = source.output_tokens_details && typeof source.output_tokens_details === "object" ? record(source.output_tokens_details) : {};
  const cached = Number(inputDetails.cached_tokens ?? 0), reasoning = Number(outputDetails.reasoning_tokens ?? 0);
  if (!Number.isSafeInteger(cached) || cached < 0 || cached > (input as number) ||
    !Number.isSafeInteger(reasoning) || reasoning < 0 || reasoning > (output as number)) {
    throw new TypeError("OpenAI Responses usage details are invalid");
  }
  return { input_tokens: input as number, cached_input_tokens: cached,
    output_tokens: output as number, reasoning_tokens: reasoning, total_tokens: total as number,
    provider_cost: { known: false } };
}

function safeFailure(error: unknown): ProviderAdapterError {
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status?: unknown }).status) : 0;
  if (status === 429) return { kind: "provider", retryable: true, code: "rate_limited", message: "The provider rate limit was reached." };
  if (status >= 500) return { kind: "provider", retryable: true, code: "upstream_unavailable", message: "The provider is temporarily unavailable." };
  return { kind: "provider", retryable: true, code: "upstream_unavailable", message: "The provider request failed." };
}

function cancellationReason(signal: AbortSignal): CancellationReason {
  return signal.reason === "deadline_exceeded" || signal.reason === "policy_revoked" || signal.reason === "runtime_shutdown"
    ? signal.reason : "runtime_shutdown";
}

export class OpenAIResponsesProviderAdapter implements ProviderAdapter {
  readonly metadata: ProviderAdapterMetadata;
  readonly provider_context = PROVIDER_CONTEXT_NOT_SUPPORTED;
  constructor(readonly options: OpenAIResponsesProviderOptions) {
    if (!options.model.trim()) throw new TypeError("model must not be empty");
    this.metadata = Object.freeze({ provider_id: "openai", model_id: options.model, capabilities: {
      streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: true,
      document_input: { supported: false }, citation_projection: { supported: false },
      provider_context: PROVIDER_CONTEXT_NOT_SUPPORTED,
      context_window_tokens: options.contextWindowTokens ?? null,
      max_output_tokens: options.maxOutputTokens ?? null,
    } } satisfies ProviderAdapterMetadata);
  }

  invoke(invocation: ProviderAdapterInvocation): ProviderAdapterStream { return this.stream(invocation); }

  private async *stream(invocation: ProviderAdapterInvocation): ProviderAdapterStream {
    let sequence = 0;
    yield { ...envelope(invocation, "response.started", sequence++), type: "response.started", attribution: invocation.context.attribution };
    try {
      const allowed = new Set(invocation.tools.map((tool) => tool.name));
      const namespaces = (this.options.namespaces ?? []).map((namespace) => ({ ...namespace,
        toolNames: namespace.toolNames.filter((name) => allowed.has(name)) })).filter((namespace) => namespace.toolNames.length > 0);
      const plan = createDeferredToolDiscoveryPlan({ tools: invocation.tools, namespaces });
      const request = buildOpenAIResponsesRequest({ model: this.options.model, invocation, plan,
        supportsToolSearch: this.options.supportsToolSearch ?? true,
        ...(this.options.hosted ? { hosted: this.options.hosted } : {}),
        ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        ...(this.options.resolveAttachment ? { resolveAttachment: this.options.resolveAttachment } : {}) });
      const source = await this.options.request(request, { signal: invocation.signal });
      let finalUsage: ProviderUsage | null = null;
      let completed = false;
      for await (const item of source) {
        if (invocation.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const event = record(item);
        if (event.type === "response.output_text.delta" && typeof event.delta === "string" && event.delta) {
          yield { ...envelope(invocation, "response.text.delta", sequence++), type: "response.text.delta", delta: event.delta };
        } else if (event.type === "response.function_call_arguments.done") {
          if (typeof event.call_id !== "string" || typeof event.name !== "string" || typeof event.arguments !== "string") throw new TypeError("OpenAI Responses function call is invalid");
          const arguments_ = JSON.parse(event.arguments) as unknown;
          if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) throw new TypeError("OpenAI Responses function arguments are invalid");
          yield { ...envelope(invocation, "response.tool_call", sequence++), type: "response.tool_call",
            tool_call_id: event.call_id, name: event.name, arguments: arguments_ as JsonObject };
        } else if (event.type === "response.completed") {
          const response = record(event.response);
          finalUsage = usage(response.usage);
          completed = true;
        } else if (event.type === "response.failed" || event.type === "error") {
          throw new TypeError("OpenAI Responses request failed");
        }
      }
      if (!completed || !finalUsage) throw new TypeError("OpenAI Responses stream ended without completion");
      yield { ...envelope(invocation, "response.usage", sequence++), type: "response.usage",
        usage: { input_tokens: finalUsage.input_tokens, output_tokens: finalUsage.output_tokens, total_tokens: finalUsage.total_tokens } };
      yield { ...envelope(invocation, "response.completed", sequence), type: "response.completed", outcome: "stop" };
      return { status: "completed", outcome: "stop", usage: finalUsage } satisfies ProviderAdapterResult;
    } catch (error) {
      if (invocation.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        const reason = cancellationReason(invocation.signal);
        yield { ...envelope(invocation, "response.cancelled", sequence), type: "response.cancelled", reason };
        return { status: "cancelled", reason, usage: null };
      }
      const normalized = safeFailure(error);
      yield { ...envelope(invocation, "response.error", sequence), type: "response.error",
        error: { category: "upstream", code: normalized.code === "rate_limited" ? "rate_limited" : "upstream_unavailable", message: normalized.message, retryable: normalized.retryable } };
      return { status: "failed", error: normalized, usage: null };
    }
  }
}

export function createOpenAIResponsesProviderAdapter(options: OpenAIResponsesProviderOptions): OpenAIResponsesProviderAdapter {
  return new OpenAIResponsesProviderAdapter(options);
}
