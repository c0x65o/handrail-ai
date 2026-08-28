import type {
  ApplicationToolResult,
  AuthoritativeAttribution,
  CancellationReason,
  ChatMessage,
  CompletionOutcome,
  CorrelationHints,
  GenerationSettings,
  ProtocolMetadata,
  StreamEvent,
  ToolDefinition,
} from "../protocol.js";

export interface ProviderModelCapabilities {
  readonly streaming: true;
  readonly text: true;
  readonly tool_calls: boolean;
  readonly parallel_tool_calls: boolean;
  readonly reasoning: boolean;
  readonly context_window_tokens: number | null;
  readonly max_output_tokens: number | null;
}

export interface ProviderAdapterMetadata {
  readonly provider_id: string;
  readonly model_id: string;
  readonly capabilities: ProviderModelCapabilities;
}

export interface ProviderRequestContext {
  readonly request_id: string;
  readonly trace_id: string;
  readonly attribution: AuthoritativeAttribution;
  readonly correlation_hints: CorrelationHints;
  readonly metadata?: ProtocolMetadata;
}

export interface ProviderAdapterInvocation {
  /** A trusted host or transport resolves opaque image content_ref values before native input. */
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly tool_results: readonly ApplicationToolResult[];
  readonly generation: GenerationSettings;
  readonly signal: AbortSignal;
  readonly context: ProviderRequestContext;
}

export interface KnownProviderCost {
  readonly known: true;
  /** Exact base-10 amount as reported or calculated by the provider. */
  readonly amount: string;
  /** ISO 4217 alphabetic currency code, such as USD. */
  readonly currency: string;
}

export interface UnknownProviderCost {
  readonly known: false;
}

/** An explicit union keeps unknown cost distinct from a known zero amount. */
export type ProviderCost = KnownProviderCost | UnknownProviderCost;

export interface ProviderUsage {
  /** All input tokens, including cached input tokens. */
  readonly input_tokens: number;
  /** The subset of input_tokens served from a provider cache; never additive. */
  readonly cached_input_tokens: number;
  /** All generated output tokens, including reasoning tokens when reported. */
  readonly output_tokens: number;
  /** The subset of output_tokens used for reasoning; never additive. */
  readonly reasoning_tokens: number;
  /** input_tokens + output_tokens; cached and reasoning subsets are not added again. */
  readonly total_tokens: number;
  readonly provider_cost: ProviderCost;
}

export interface RetryableProviderError {
  readonly kind: "provider";
  readonly retryable: true;
  readonly code: "rate_limited" | "deadline_exceeded" | "upstream_unavailable";
  readonly message: string;
}

export interface ClientRequestError {
  readonly kind: "client";
  readonly retryable: false;
  readonly code: "invalid_request" | "unauthenticated" | "forbidden" | "idempotency_conflict";
  readonly message: string;
}

export interface PolicyDeniedError {
  readonly kind: "policy";
  readonly retryable: false;
  readonly code: "policy_denied";
  readonly message: string;
}

export type ProviderAdapterError =
  | RetryableProviderError
  | ClientRequestError
  | PolicyDeniedError;

export interface ProviderAdapterCompletedResult {
  readonly status: "completed";
  readonly outcome: CompletionOutcome;
  readonly usage: ProviderUsage;
}

export interface ProviderAdapterCancelledResult {
  readonly status: "cancelled";
  readonly reason: CancellationReason;
  readonly usage: ProviderUsage | null;
}

export interface ProviderAdapterFailedResult {
  readonly status: "failed";
  readonly error: ProviderAdapterError;
  readonly usage: ProviderUsage | null;
}

export type ProviderAdapterResult =
  | ProviderAdapterCompletedResult
  | ProviderAdapterCancelledResult
  | ProviderAdapterFailedResult;

/**
 * Implementations yield only v1 StreamEvent values, ending with exactly one
 * matching terminal event before returning the normalized terminal result.
 */
export type ProviderAdapterStream = AsyncGenerator<
  StreamEvent,
  ProviderAdapterResult,
  void
>;

export interface ProviderAdapter {
  readonly metadata: ProviderAdapterMetadata;
  invoke(invocation: ProviderAdapterInvocation): ProviderAdapterStream;
}
