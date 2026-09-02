import { createOpenAIResponsesProviderAdapter, type OpenAIResponsesProviderOptions } from "../providers/openai-responses.js";
import type { OpenAIResponsesRequest } from "../providers/openai-responses-tools.js";
import { parseServerSentEvents } from "../transports/sse.js";
import type { HandrailAssistantAuthorizationContext, HandrailAssistantProvider } from "./assistant.js";
import { createProviderToolLoopTransport } from "./provider-tool-loop.js";

export interface HandrailOpenAIResponsesOptions extends Omit<OpenAIResponsesProviderOptions,
  "request" | "instructions" | "continuationStore"> {
  readonly request?: OpenAIResponsesProviderOptions["request"];
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

function openAIRequest(options: HandrailOpenAIResponsesOptions): OpenAIResponsesProviderOptions["request"] {
  if (options.request) return options.request;
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) throw new TypeError("OPENAI_API_KEY or openaiResponses.apiKey is required");
  const fetcher = options.fetch ?? globalThis.fetch;
  const endpoint = `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/u, "")}/responses`;
  return async (request: OpenAIResponsesRequest, { signal }) => {
    const response = await fetcher(endpoint, { method: "POST", signal, headers: {
      authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "text/event-stream",
    }, body: JSON.stringify(request) });
    if (!response.ok || !response.body) {
      const error = new Error(`OpenAI Responses request failed with HTTP ${response.status}`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return (async function* () {
      for await (const frame of parseServerSentEvents(response.body!)) {
        if (!frame.data || frame.data === "[DONE]") continue;
        yield JSON.parse(frame.data) as unknown;
      }
    })();
  };
}

/** SDK-owned OpenAI Responses configuration; no OpenAI package is required by the host. */
export function openaiResponses<TContext extends HandrailAssistantAuthorizationContext = HandrailAssistantAuthorizationContext>(
  options: HandrailOpenAIResponsesOptions,
): HandrailAssistantProvider<TContext> {
  const request = openAIRequest(options);
  const { apiKey: _apiKey, baseUrl: _baseUrl, fetch: _fetch, request: _request, ...adapterOptions } = options;
  void _apiKey; void _baseUrl; void _fetch; void _request;
  const metadata = createOpenAIResponsesProviderAdapter({ ...adapterOptions, request }).metadata;
  return Object.freeze({
    metadata,
    createTransport(input) {
      const adapter = createOpenAIResponsesProviderAdapter({
        ...adapterOptions,
        request,
        continuationStore: input.persistence.continuation,
        ...(input.instructions.length === 0 ? {} : { instructions: input.instructions.join("\n\n") }),
      });
      return createProviderToolLoopTransport({
        adapter,
        tools: input.tools.definitions,
        limits: input.limits,
        createContext: ({ turnId, mutationId, iteration }) => ({
          request_id: `${turnId}:provider:${iteration}`,
          trace_id: mutationId,
          attribution: input.context.attribution,
          correlation_hints: {},
        }),
        executeTool: async ({ call, signal }) => input.tools.execute(call, signal),
        captureUsage: input.persistence.usageReceiptSink?.capture,
        resolveDocumentReference: async ({ conversationId, reference }) => {
          const resolved = await input.persistence.attachments.resolve({
            ownerScopeId: input.context.scopeId,
            conversationId,
            contentRef: reference.content_ref,
          });
          return { media_type: "application/pdf", bytes: resolved.bytes };
        },
      });
    },
  });
}
