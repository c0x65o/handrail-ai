import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  parseStreamEvents,
  type AuthoritativeAttribution,
  type StreamEvent,
} from "../src/protocol.js";
import type {
  ProviderAdapter,
  ProviderAdapterInvocation,
  ProviderAdapterResult,
  ProviderAdapterStream,
} from "../src/providers/index.js";
import {
  createXAIProviderAdapter,
  XAIProviderAdapter,
  type XAIChatRequest,
  type XAIRequestOptions,
} from "../src/providers/xai.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_fixture", source: "server_derived", trust: "authoritative" },
  project: { id: "prj_fixture", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "env_fixture", source: "server_derived", trust: "authoritative" },
  known_user: { id: "usr_fixture", source: "server_derived", trust: "authoritative" },
  session: { id: "ses_fixture", source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

function invocation(overrides: Partial<ProviderAdapterInvocation> = {}): ProviderAdapterInvocation {
  return {
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    tool_results: [],
    generation: { max_output_tokens: 128, temperature: 0.25 },
    signal: new AbortController().signal,
    context: {
      request_id: "req_xai_fixture",
      trace_id: "trc_xai_fixture",
      attribution,
      correlation_hints: {},
      metadata: { fixture: "xai_adapter" },
    },
    ...overrides,
  };
}

async function* chunks(...values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}

function usage(costInUsdTicks?: number | string) {
  return {
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 19,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 2 },
      ...(costInUsdTicks === undefined ? {} : { cost_in_usd_ticks: costInUsdTicks }),
    },
  };
}

function textStream(finishReason = "stop", costInUsdTicks?: number | string) {
  return chunks(
    {
      id: "native-secret-id",
      choices: [{ index: 0, delta: { content: "Hel", reasoning_content: "private reasoning" }, finish_reason: null }],
      headers: { authorization: "Bearer should-not-leak" },
    },
    { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: finishReason }] },
    usage(costInUsdTicks),
  );
}

async function collect(stream: ProviderAdapterStream): Promise<{
  events: StreamEvent[];
  result: ProviderAdapterResult;
}> {
  const events: StreamEvent[] = [];
  let item = await stream.next();
  while (!item.done) {
    events.push(item.value);
    item = await stream.next();
  }
  return { events, result: item.value };
}

function expectValid(events: StreamEvent[]): void {
  expect(parseStreamEvents(events)).toBe(events);
  expect(events[0]).toMatchObject({
    type: "response.started",
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    sequence: 0,
  });
  expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index));
  expect(events.filter((event) =>
    ["response.completed", "response.cancelled", "response.error"].includes(event.type),
  )).toHaveLength(1);
}

describe("XAIProviderAdapter", () => {
  it("constructs directly from an injected request and satisfies ProviderAdapter", async () => {
    const request = vi.fn(() => textStream());
    const adapter: ProviderAdapter = createXAIProviderAdapter({
      model: "grok-fixture",
      request,
      supports_reasoning: true,
    });

    const output = await collect(adapter.invoke(invocation()));

    expect(adapter).toBeInstanceOf(XAIProviderAdapter);
    expect(adapter.metadata).toEqual({
      provider_id: "xai",
      model_id: "grok-fixture",
      capabilities: {
        streaming: true,
        text: true,
        tool_calls: false,
        parallel_tool_calls: false,
        reasoning: true,
        document_input: { supported: false },
        provider_context: {
          supported: false,
          reason: "provider_not_supported",
        },
        context_window_tokens: null,
        max_output_tokens: null,
      },
    });
    expect(adapter.provider_context).toEqual({
      supported: false,
      reason: "provider_not_supported",
    });
    expect(request).toHaveBeenCalledOnce();
    expect(output.result).toMatchObject({ status: "completed", outcome: "stop" });
  });

  it.each([
    [1, { known: true, amount: "0.0000000001", currency: "USD" }],
    ["123456789012345678901", { known: true, amount: "12345678901.2345678901", currency: "USD" }],
    [undefined, { known: false }],
  ] as const)("streams text and normalizes token subsets with exact or unknown cost", async (reportedCost, expectedCost) => {
    const output = await collect(createXAIProviderAdapter({
      model: "grok-fixture",
      request: () => textStream("stop", reportedCost),
      supports_reasoning: true,
    }).invoke(invocation()));

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.text.delta",
      "response.usage",
      "response.completed",
    ]);
    expect(output.result).toEqual({
      status: "completed",
      outcome: "stop",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 7,
        reasoning_tokens: 2,
        total_tokens: 19,
        provider_cost: expectedCost,
      },
    });
    expectValid(output.events);
  });

  it("maps advertised images, tools, results, generation settings, and AbortSignal", async () => {
    let payload: XAIChatRequest | undefined;
    let options: XAIRequestOptions | undefined;
    const controller = new AbortController();
    const request = vi.fn((value: XAIChatRequest, requestOptions: XAIRequestOptions) => {
      payload = value;
      options = requestOptions;
      return textStream();
    });
    const resolveImage = vi.fn(() => ({
      url: "https://images.example.test/fixture.png",
      detail: "high" as const,
    }));

    await collect(createXAIProviderAdapter({
      model: "grok-fixture",
      request,
      resolve_image_reference: resolveImage,
      supports_images: true,
      supports_tool_calls: true,
      supports_reasoning: true,
      max_output_tokens: 256,
    }).invoke(invocation({
      signal: controller.signal,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe " },
          {
            type: "image",
            attachment: {
              attachment_id: "att_xai_fixture",
              content_ref: "ref_xai_fixture",
              media_type: "image/png",
              byte_size: 1024,
            },
          },
        ],
      }],
      tools: [{
        name: "lookup_weather",
        description: "Look up weather.",
        input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      }],
      tool_results: [{
        tool_call_id: "call_previous",
        name: "lookup_weather",
        content: [{ type: "json", value: { temperature: 72 } }],
        is_error: false,
      }],
      generation: { max_output_tokens: 64, temperature: 0.5 },
    })));

    expect(resolveImage).toHaveBeenCalledWith(expect.objectContaining({ content_ref: "ref_xai_fixture" }));
    expect(payload).toEqual({
      model: "grok-fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe " },
            { type: "image_url", image_url: { url: "https://images.example.test/fixture.png", detail: "high" } },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_previous", type: "function", function: { name: "lookup_weather", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_previous", content: "{\"temperature\":72}" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Look up weather.",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      }],
      parallel_tool_calls: false,
      max_tokens: 64,
      temperature: 0.5,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(options?.signal).toBe(controller.signal);
  });

  it.each([
    ["stop", "stop"],
    ["length", "length"],
  ] as const)("maps %s to the matching outcome", async (finishReason, outcome) => {
    const output = await collect(createXAIProviderAdapter({
      model: "grok-fixture",
      request: () => textStream(finishReason),
      supports_reasoning: true,
    }).invoke(invocation()));
    expect(output.result).toMatchObject({ status: "completed", outcome });
    expect(output.events.at(-1)).toMatchObject({ type: "response.completed", outcome });
    expectValid(output.events);
  });

  it("assembles incremental tool arguments before emitting one tool call", async () => {
    const output = await collect(createXAIProviderAdapter({
      model: "grok-fixture",
      supports_tool_calls: true,
      supports_reasoning: true,
      request: () => chunks(
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_weather", function: { name: "lookup_weather", arguments: "{\"city\":" } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\"Chicago\"}" } }] }, finish_reason: "tool_calls" }] },
        usage(),
      ),
    }).invoke(invocation()));

    expect(output.events.filter((event) => event.type === "response.tool_call")).toEqual([
      expect.objectContaining({
        type: "response.tool_call",
        tool_call_id: "call_weather",
        name: "lookup_weather",
        arguments: { city: "Chicago" },
      }),
    ]);
    expect(output.result).toMatchObject({ status: "completed", outcome: "tool_calls" });
    expectValid(output.events);
  });

  it("does not dispatch a pre-aborted invocation", async () => {
    const controller = new AbortController();
    controller.abort("policy_revoked");
    const request = vi.fn(() => textStream());
    const output = await collect(createXAIProviderAdapter({ model: "grok-fixture", request }).invoke(
      invocation({ signal: controller.signal }),
    ));

    expect(request).not.toHaveBeenCalled();
    expect(output.result).toEqual({ status: "cancelled", reason: "policy_revoked", usage: null });
    expectValid(output.events);
  });

  it("propagates an in-flight abort and emits one cancellation terminal", async () => {
    const controller = new AbortController();
    const request = vi.fn((_request: XAIChatRequest, options: XAIRequestOptions) => (async function* () {
      await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => {
        reject(new DOMException("native secret body", "AbortError"));
      }, { once: true }));
      yield undefined;
    })());
    const stream = createXAIProviderAdapter({ model: "grok-fixture", request }).invoke(
      invocation({ signal: controller.signal }),
    );
    const started = await stream.next();
    expect(started.value).toMatchObject({ type: "response.started" });
    const pending = stream.next();
    controller.abort("deadline_exceeded");
    const cancelled = await pending;
    const terminal = await stream.next();

    expect(cancelled.value).toMatchObject({ type: "response.cancelled", reason: "deadline_exceeded" });
    expect(terminal.value).toEqual({ status: "cancelled", reason: "deadline_exceeded", usage: null });
  });

  it.each([
    [429, "provider", "rate_limited", true],
    [408, "provider", "deadline_exceeded", true],
    [504, "provider", "deadline_exceeded", true],
    [502, "provider", "upstream_unavailable", true],
    [400, "client", "invalid_request", false],
    [401, "client", "unauthenticated", false],
    [403, "client", "forbidden", false],
    [409, "client", "idempotency_conflict", false],
  ] as const)("normalizes status %s without exposing native errors", async (status, kind, code, retryable) => {
    const native = Object.assign(new Error("secret provider body api-key-fixture"), {
      status,
      headers: { authorization: "Bearer fixture" },
      response: { data: { secret: "native" } },
    });
    const output = await collect(createXAIProviderAdapter({
      model: "grok-fixture",
      request: () => { throw native; },
    }).invoke(invocation()));

    expect(output.result).toMatchObject({ status: "failed", error: { kind, code, retryable }, usage: null });
    expect(JSON.stringify(output)).not.toMatch(/secret provider body|api-key-fixture|Bearer fixture|"headers"|"response":/i);
    expectValid(output.events);
  });

  it("normalizes a content-filter stop as policy denial with usage", async () => {
    const output = await collect(createXAIProviderAdapter({
      model: "grok-fixture",
      supports_reasoning: true,
      request: () => textStream("content_filter"),
    }).invoke(invocation()));

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started", "response.text.delta", "response.text.delta", "response.usage", "response.error",
    ]);
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "policy", retryable: false, code: "policy_denied" },
      usage: { total_tokens: 19 },
    });
    expectValid(output.events);
  });

  it.each([
    ["images", invocation({ messages: [{ role: "user", content: [{ type: "image", attachment: { attachment_id: "att_x", content_ref: "ref_x", media_type: "image/png", byte_size: 10 } }] }] }), {}],
    ["tools", invocation({ tools: [{ name: "tool", description: "tool", input_schema: { type: "object" } }] }), {}],
    ["tool results", invocation({ tool_results: [{ tool_call_id: "call_x", name: "tool", content: [{ type: "text", text: "ok" }], is_error: false }] }), {}],
    ["output limit", invocation({ generation: { max_output_tokens: 129, temperature: 0.25 } }), { max_output_tokens: 128 }],
    ["generation", invocation({ generation: { max_output_tokens: 128, temperature: 3 } }), {}],
  ] as const)("rejects unsupported %s before request dispatch", async (_label, input, options) => {
    const request = vi.fn(() => textStream());
    const output = await collect(createXAIProviderAdapter({ model: "grok-fixture", request, ...options }).invoke(input));
    expect(request).not.toHaveBeenCalled();
    expect(output.result).toMatchObject({ status: "failed", error: { kind: "client", code: "invalid_request" } });
    expectValid(output.events);
  });

  it.each([
    ["non-object chunk", ["native-body"]],
    ["invalid choices", [{ choices: {} }]],
    ["bad tool arguments", [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "tool", arguments: "{" } }] }, finish_reason: "tool_calls" }] },
      usage(),
    ]],
    ["invalid usage invariants", [
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 99 } },
    ]],
    ["fractional cost ticks", [
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { ...usage(), usage: { ...usage().usage, cost_in_usd_ticks: 0.1 } },
    ]],
  ] as const)("turns malformed %s into one retryable terminal", async (_label, values) => {
    const output = await collect(createXAIProviderAdapter({
      model: "grok-fixture",
      supports_tool_calls: true,
      supports_reasoning: true,
      request: () => chunks(...values),
    }).invoke(invocation()));

    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "provider", retryable: true, code: "upstream_unavailable" },
    });
    expectValid(output.events);
  });

  it("isolates native chunks, reasoning, headers, and provider objects from public output", async () => {
    const output = await collect(createXAIProviderAdapter({
      model: "grok-fixture",
      supports_reasoning: true,
      request: () => textStream(),
    }).invoke(invocation()));
    const serialized = JSON.stringify(output);

    expect(serialized).not.toContain("private reasoning");
    expect(serialized).not.toContain("native-secret-id");
    expect(serialized).not.toContain("Bearer should-not-leak");
    expect(serialized).not.toContain("reasoning_content");
    expectValid(output.events);
  });

  it("rejects documents before resolving references or calling upstream", async () => {
    const request = vi.fn(() => textStream());
    const resolveDocumentReference = vi.fn(() => ({
      media_type: "application/pdf" as const,
      bytes: new Uint8Array([1]),
    }));
    const adapter = createXAIProviderAdapter({ model: "grok-fixture", request });
    const output = await collect(adapter.invoke(invocation({
      messages: [{
        role: "user",
        content: [{
          type: "document",
          attachment: {
            attachment_id: "att_xai_pdf",
            content_ref: "ref_xai_pdf",
            media_type: "application/pdf",
            byte_size: 10,
          },
        }],
      }],
      resolve_document_reference: resolveDocumentReference,
    })));

    expect(adapter.metadata.capabilities.document_input).toEqual({ supported: false });
    expect(resolveDocumentReference).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request" },
    });
  });
});
