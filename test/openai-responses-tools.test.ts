import { describe, expect, it } from "vitest";
import { createDeferredToolDiscoveryPlan } from "../src/index.js";
import { buildOpenAIResponsesRequest, projectOpenAIResponsesTools } from "../src/providers/openai.js";

const definitions = Array.from({ length: 89 }, (_, index) => ({
  name: `aegis_tool_${index}`, description: `Aegis operation ${index}`,
  input_schema: { type: "object" as const, properties: { id: { type: "string" } }, additionalProperties: false },
}));

describe("OpenAI Responses deferred tool projection", () => {
  it("keeps a large authorized catalog deferred behind hosted tool search", () => {
    const plan = createDeferredToolDiscoveryPlan({
      tools: definitions,
      namespaces: [
        { name: "assets", description: "Asset operations", toolNames: definitions.slice(0, 45).map((tool) => tool.name) },
        { name: "security", description: "Security operations", toolNames: definitions.slice(45).map((tool) => tool.name) },
      ], maximumEagerTools: 4,
    });
    const projected = projectOpenAIResponsesTools({ plan, supportsToolSearch: true, hosted: { toolSearch: { execution: "server" }, webSearch: { search_context_size: "low" } } });
    expect(projected.filter((tool) => tool.type === "function")).toHaveLength(0);
    expect(projected.filter((tool) => tool.type === "namespace")).toHaveLength(2);
    expect(projected).toContainEqual(expect.objectContaining({ type: "tool_search", execution: "server" }));
    expect(projected).toContainEqual(expect.objectContaining({ type: "web_search" }));
  });

  it("uses only bounded eager tools when a model lacks tool search", () => {
    const plan = createDeferredToolDiscoveryPlan({
      tools: definitions.slice(0, 4), namespaces: [{ name: "deferred", description: "Deferred operations", toolNames: definitions.slice(1).slice(0, 3).map((tool) => tool.name) }],
    });
    const projected = projectOpenAIResponsesTools({ plan, supportsToolSearch: false });
    expect(projected).toEqual([expect.objectContaining({ type: "function", name: "aegis_tool_0" })]);
  });

  it("builds a stateless Responses request from a provider invocation", () => {
    const plan = createDeferredToolDiscoveryPlan({ tools: definitions.slice(0, 2), namespaces: [{ name: "aegis", description: "ERP", toolNames: definitions.slice(0, 2).map((tool) => tool.name) }] });
    const request = buildOpenAIResponsesRequest({
      model: "gpt-example", plan, supportsToolSearch: true,
      invocation: {
        messages: [{ role: "user", content: [{ type: "text", text: "List assets" }] }], tools: definitions.slice(0, 2), tool_results: [],
        generation: { max_output_tokens: 1000, temperature: 0 }, signal: new AbortController().signal,
        context: { request_id: "r", trace_id: "t", attribution: {} as never, correlation_hints: {} },
      },
    });
    expect(request).toMatchObject({ stream: true, store: false, parallel_tool_calls: false, max_output_tokens: 1000 });
    expect(request.input[0]).toMatchObject({ role: "user" });
  });
});
