import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  BoundedToolExecutor,
  InMemoryConversationEventStore,
  ToolRegistry,
  createConversationRuntime,
  createDirectProviderTransport,
  parseChatRequest,
  runToolLoop,
  type ApplicationToolExecutor,
  type AuthoritativeAttribution,
  type ConversationClientId,
  type ConversationId,
  type DirectProviderTurnContext,
  type ToolDefinition,
} from "../src/index.js";
import { createOpenAIResponsesProviderAdapter } from "../src/providers/openai.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: "user", source: "server_derived", trust: "authoritative" },
  session: { id: "session", source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

const lookup: ToolDefinition = {
  name: "lookup_invoice",
  description: "Look up an invoice",
  input_schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
};

describe("OpenAI Responses direct runtime integration", () => {
  it("executes a validated tool and continues store:false to a final streamed answer", async () => {
    const nativeRequests: unknown[] = [];
    const adapter = createOpenAIResponsesProviderAdapter({
      model: "gpt-test",
      request: async function* (request) {
        nativeRequests.push(request);
        const continuation = request.input.some((item) => item.type === "function_call_output");
        if (!continuation) {
          yield {
            type: "response.function_call_arguments.done",
            call_id: "call_invoice",
            name: "lookup_invoice",
            arguments: "{\"id\":\"invoice-1\"}",
          };
          yield {
            type: "response.completed",
            response: {
              output: [
                { type: "reasoning", id: "reasoning-1", encrypted_content: "opaque" },
                { type: "function_call", call_id: "call_invoice", name: "lookup_invoice", arguments: "{\"id\":\"invoice-1\"}" },
              ],
              usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
            },
          };
          return;
        }
        yield { type: "response.output_text.delta", delta: "Invoice invoice-1 is paid." };
        yield {
          type: "response.completed",
          response: {
            output: [{ type: "message", content: [{ type: "output_text", text: "Invoice invoice-1 is paid." }] }],
            usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
          },
        };
      },
    });
    let invocation = 0;
    const transport = createDirectProviderTransport({
      adapter,
      createContext: (input): DirectProviderTurnContext => {
        invocation += 1;
        return {
          request_id: `openai-request-${invocation}`,
          trace_id: `openai-trace-${invocation}`,
          turn_id: input.conversationTurnId,
          attribution,
          correlation_hints: input.request.correlation_hints,
          usage: {
            usage_receipt_id: `openai-usage-${invocation}`,
            logical_request_id: "logical-openai-loop",
            attempt: { id: `attempt-${invocation}`, index: invocation - 1 },
            continuation: { id: `continuation-${invocation}`, index: invocation - 1 },
            source: "provider",
            quality: "reported",
          },
        };
      },
    });
    const runtime = await createConversationRuntime({
      conversationId: "conversation_openai_loop" as ConversationId,
      clientId: "client_openai_loop" as ConversationClientId,
      eventStore: new InMemoryConversationEventStore(),
      transport,
    });
    const registry = new ToolRegistry<ApplicationToolExecutor, undefined>();
    const execute = vi.fn<ApplicationToolExecutor>(async ({ id }) => ({ id: String(id ?? ""), status: "paid" }));
    registry.register({ definition: lookup, executor: execute });
    const discoveredTools = registry.discover({ context: undefined });
    const executor = new BoundedToolExecutor({ registry, policy: () => ({ outcome: "allow" }), limits: { maxConcurrency: 1 } });
    const request = parseChatRequest({
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      continuation_of: null,
      messages: [{ role: "user", content: [{ type: "text", text: "Check invoice-1" }] }],
      tools: discoveredTools,
      tool_results: [],
      generation: { max_output_tokens: 256, temperature: 0 },
      correlation_hints: {},
      metadata: {},
    });

    const initialTurn = runtime.sendMessage({ content: "Check invoice-1", request });
    const result = await runToolLoop({
      runtime,
      initialTurn,
      request,
      discoveredTools,
      executor,
      applicationContext: undefined,
      limits: { maxTotalToolCalls: 4 },
    });

    expect(result).toMatchObject({ status: "completed", outcome: "stop", iterations: 1, totalToolCalls: 1 });
    expect(execute).toHaveBeenCalledOnce();
    expect(nativeRequests).toHaveLength(2);
    expect(nativeRequests[1]).toMatchObject({ input: expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", encrypted_content: "opaque" }),
      expect.objectContaining({ type: "function_call", call_id: "call_invoice" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_invoice" }),
    ]) });
    expect(result.usageReceipts).toHaveLength(2);
    expect(runtime.getSnapshot().messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Invoice invoice-1 is paid." }],
    });
  });

  it("durably rejects an OpenAI batch that exceeds Spartan's four-call budget before execution", async () => {
    const adapter = createOpenAIResponsesProviderAdapter({
      model: "gpt-test",
      request: async function* () {
        for (let index = 1; index <= 5; index += 1) {
          yield {
            type: "response.function_call_arguments.done",
            call_id: `call_invoice_${index}`,
            name: "lookup_invoice",
            arguments: JSON.stringify({ id: `invoice-${index}` }),
          };
        }
        yield {
          type: "response.completed",
          response: {
            output: [],
            usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
          },
        };
      },
    });
    const transport = createDirectProviderTransport({
      adapter,
      createContext: (input): DirectProviderTurnContext => ({
        request_id: "openai-budget-request",
        trace_id: "openai-budget-trace",
        turn_id: input.conversationTurnId,
        attribution,
        correlation_hints: input.request.correlation_hints,
        usage: {
          usage_receipt_id: "openai-budget-usage",
          logical_request_id: "logical-openai-budget",
          attempt: { id: "attempt-budget", index: 0 },
          continuation: { id: "continuation-budget", index: 0 },
          source: "provider",
          quality: "reported",
        },
      }),
    });
    const runtime = await createConversationRuntime({
      conversationId: "conversation_openai_budget" as ConversationId,
      clientId: "client_openai_budget" as ConversationClientId,
      eventStore: new InMemoryConversationEventStore(),
      transport,
    });
    const registry = new ToolRegistry<ApplicationToolExecutor, undefined>();
    const execute = vi.fn<ApplicationToolExecutor>(async ({ id }) => ({ id: String(id ?? "") }));
    registry.register({ definition: lookup, executor: execute });
    const discoveredTools = registry.discover({ context: undefined });
    const executor = new BoundedToolExecutor({
      registry,
      policy: () => ({ outcome: "allow" }),
      limits: { maxConcurrency: 1 },
    });
    const request = parseChatRequest({
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      continuation_of: null,
      messages: [{ role: "user", content: [{ type: "text", text: "Check five invoices" }] }],
      tools: discoveredTools,
      tool_results: [],
      generation: { max_output_tokens: 256, temperature: 0 },
      correlation_hints: {},
      metadata: {},
    });

    const result = await runToolLoop({
      runtime,
      initialTurn: runtime.sendMessage({ content: "Check five invoices", request }),
      request,
      discoveredTools,
      executor,
      applicationContext: undefined,
      limits: { maxTotalToolCalls: 4 },
    });

    expect(result).toMatchObject({ status: "budget_exhausted", budget: "total_tool_calls", limit: 4 });
    expect(execute).not.toHaveBeenCalled();
    expect(runtime.getSnapshot().tool_loop_budget_exhaustions).toEqual([
      expect.objectContaining({ budget: "total_tool_calls", limit: 4 }),
    ]);
  });
});
