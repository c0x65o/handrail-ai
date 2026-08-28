import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  parseStreamEvents,
  type AuthoritativeAttribution,
  type ProviderAdapterInvocation,
  type ProviderAdapterResult,
  type ProviderAdapterStream,
  type StreamEvent,
} from "../src/index.js";
import {
  createOpenAIProviderAdapter,
  type OpenAIChatCompletionRequest,
  type OpenAIRequestOptions,
} from "../src/providers/openai.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_1", source: "server_derived", trust: "authoritative" },
  project: { id: "prj_1", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "env_1", source: "server_derived", trust: "authoritative" },
  known_user: { id: "usr_1", source: "server_derived", trust: "authoritative" },
  session: { id: "ses_1", source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

function invocation(
  overrides: Partial<ProviderAdapterInvocation> = {},
): ProviderAdapterInvocation {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
    tools: [],
    tool_results: [],
    generation: { max_output_tokens: 128, temperature: 0.25 },
    signal: new AbortController().signal,
    context: {
      request_id: "req_openai_fixture",
      trace_id: "trc_openai_fixture",
      attribution,
      correlation_hints: {},
      metadata: { fixture: "openai_adapter" },
    },
    ...overrides,
  };
}

async function* chunks(...values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}

const usageChunk = {
  choices: [],
  usage: {
    prompt_tokens: 12,
    completion_tokens: 7,
    total_tokens: 19,
    prompt_tokens_details: { cached_tokens: 3 },
    completion_tokens_details: { reasoning_tokens: 2 },
  },
};

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
  expect(
    events.filter((event) =>
      ["response.completed", "response.cancelled", "response.error"].includes(
        event.type,
      ),
    ),
  ).toHaveLength(1);
}

describe("OpenAIProviderAdapter", () => {
  it("streams text and normalizes cached/reasoning token subsets with unknown cost", async () => {
    const request = vi.fn(() =>
      chunks(
        { choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }] },
        usageChunk,
      ),
    );
    const output = await collect(
      createOpenAIProviderAdapter({ model: "gpt-fixture", request }).invoke(
        invocation(),
      ),
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.text.delta",
      "response.usage",
      "response.completed",
    ]);
    expectValid(output.events);
    expect(output.result).toEqual({
      status: "completed",
      outcome: "stop",
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 7,
        reasoning_tokens: 2,
        total_tokens: 19,
        provider_cost: { known: false },
      },
    });
  });

  it("assembles fragmented tool arguments and emits only the complete call", async () => {
    const request = vi.fn(() =>
      chunks(
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_weather",
                function: { name: "lookup_weather", arguments: "{\"city\":" },
              }],
            },
            finish_reason: null,
          }],
        },
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: "\"Chicago\"}" } }],
            },
            finish_reason: "tool_calls",
          }],
        },
        usageChunk,
      ),
    );
    const output = await collect(
      createOpenAIProviderAdapter({ model: "gpt-fixture", request }).invoke(
        invocation(),
      ),
    );

    expect(output.events.filter((event) => event.type === "response.tool_call")).toEqual([
      expect.objectContaining({
        type: "response.tool_call",
        tool_call_id: "call_weather",
        name: "lookup_weather",
        arguments: { city: "Chicago" },
      }),
    ]);
    expectValid(output.events);
    expect(output.result).toMatchObject({ status: "completed", outcome: "tool_calls" });
  });

  it("maps image references, tools, tool results, generation settings, and the signal", async () => {
    let payload: OpenAIChatCompletionRequest | undefined;
    let requestOptions: OpenAIRequestOptions | undefined;
    const controller = new AbortController();
    const request = vi.fn(
      (value: OpenAIChatCompletionRequest, options: OpenAIRequestOptions) => {
        payload = value;
        requestOptions = options;
        return chunks(
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          usageChunk,
        );
      },
    );
    const resolveImage = vi.fn(() => ({
      url: "https://images.example.test/fixture.png",
      detail: "high" as const,
    }));
    const input = invocation({
      signal: controller.signal,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe " },
          {
            type: "image",
            attachment: {
              attachment_id: "att_openai_fixture",
              content_ref: "ref_openai_fixture",
              media_type: "image/png",
              byte_size: 1024,
            },
            alt_text: "fixture",
          },
        ],
      }],
      tools: [{
        name: "lookup_weather",
        description: "Look up weather.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }],
      tool_results: [{
        tool_call_id: "call_previous",
        name: "lookup_weather",
        content: [{ type: "json", value: { temperature: 72 } }],
        is_error: false,
      }],
      generation: { max_output_tokens: 64, temperature: 0.5 },
    });

    await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request,
        resolve_image_reference: resolveImage,
      }).invoke(input),
    );

    expect(resolveImage).toHaveBeenCalledWith(
      expect.objectContaining({ content_ref: "ref_openai_fixture" }),
    );
    expect(payload).toMatchObject({
      model: "gpt-fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe " },
            {
              type: "image_url",
              image_url: {
                url: "https://images.example.test/fixture.png",
                detail: "high",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_previous",
            type: "function",
            function: { name: "lookup_weather", arguments: "{}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call_previous",
          content: "{\"temperature\":72}",
        },
      ],
      tools: [{
        type: "function",
        function: {
          name: "lookup_weather",
          parameters: { type: "object" },
        },
      }],
      parallel_tool_calls: false,
      max_completion_tokens: 64,
      temperature: 0.5,
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(requestOptions?.signal).toBe(controller.signal);
  });

  it.each([
    ["length", "length"],
    ["stop", "stop"],
  ] as const)("maps %s to the matching terminal outcome", async (finishReason, outcome) => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: () => chunks(
          { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
          usageChunk,
        ),
      }).invoke(invocation()),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.completed",
      outcome,
    });
    expect(output.result).toMatchObject({ status: "completed", outcome });
    expectValid(output.events);
  });

  it("propagates AbortSignal and returns one cancellation terminal", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const request = vi.fn(
      (_payload: OpenAIChatCompletionRequest, options: OpenAIRequestOptions) => {
        receivedSignal = options.signal;
        return (async function* () {
          await new Promise<void>((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
          yield undefined;
        })();
      },
    );
    const stream = createOpenAIProviderAdapter({ model: "gpt-fixture", request }).invoke(
      invocation({ signal: controller.signal }),
    );
    const started = await stream.next();
    const pending = stream.next();
    await vi.waitFor(() => expect(receivedSignal).toBe(controller.signal));
    controller.abort("deadline_exceeded");
    const cancelled = await pending;
    const done = await stream.next();

    expect(started.value).toMatchObject({ type: "response.started" });
    expect(cancelled.value).toMatchObject({
      type: "response.cancelled",
      reason: "deadline_exceeded",
    });
    expect(done).toEqual({
      done: true,
      value: { status: "cancelled", reason: "deadline_exceeded", usage: null },
    });
    expectValid([started.value as StreamEvent, cancelled.value as StreamEvent]);
  });

  it("normalizes 429 as retryable without leaking the raw provider error", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: async () => {
          throw {
            status: 429,
            message: "raw secret sk-fixture-do-not-leak",
            headers: { authorization: "Bearer hidden" },
            response: { native: true },
          };
        },
      }).invoke(invocation()),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.error",
      error: { code: "rate_limited", retryable: true },
    });
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "provider", code: "rate_limited", retryable: true },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("sk-fixture");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("headers");
    expect(serialized).not.toContain("native");
    expectValid(output.events);
  });

  it("normalizes a non-retryable provider request error", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: async () => { throw { status: 400, body: { raw: true } }; },
      }).invoke(invocation()),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.error",
      error: { category: "request", code: "invalid_request", retryable: false },
    });
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request", retryable: false },
    });
    expectValid(output.events);
  });

  it("normalizes authentication failures without exposing provider details", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: async () => { throw { status: 401, message: "invalid api key" }; },
      }).invoke(invocation()),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.error",
      error: {
        category: "authentication",
        code: "unauthenticated",
        retryable: false,
      },
    });
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "unauthenticated", retryable: false },
    });
    expect(JSON.stringify(output)).not.toContain("invalid api key");
    expectValid(output.events);
  });

  it("normalizes transient 5xx failures as retryable", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: async () => { throw { status: 503 }; },
      }).invoke(invocation()),
    );

    expect(output.result).toMatchObject({
      status: "failed",
      error: {
        kind: "provider",
        code: "upstream_unavailable",
        retryable: true,
      },
    });
    expectValid(output.events);
  });

  it("fails safely on malformed upstream data", async () => {
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request: () => chunks({ choices: [{ index: 0, delta: { content: 42 } }] }),
      }).invoke(invocation()),
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.error",
    ]);
    expect(output.result).toMatchObject({
      status: "failed",
      error: {
        kind: "provider",
        code: "upstream_unavailable",
        message: "The provider returned malformed streaming data.",
      },
    });
    expectValid(output.events);
  });

  it("rejects unsupported capabilities before calling upstream", async () => {
    const request = vi.fn(() => chunks());
    const output = await collect(
      createOpenAIProviderAdapter({
        model: "gpt-fixture",
        request,
        supports_tool_calls: false,
      }).invoke(invocation({
        tools: [{
          name: "lookup_weather",
          description: "Look up weather.",
          input_schema: { type: "object" },
        }],
      })),
    );

    expect(request).not.toHaveBeenCalled();
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request", retryable: false },
    });
    expectValid(output.events);
  });

  it("constructs from a host-injected BYOK request boundary with no Handrail gateway", async () => {
    const hostConfiguredRequest = vi.fn(() =>
      chunks(
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        usageChunk,
      ),
    );
    const adapter = createOpenAIProviderAdapter({
      model: "gpt-host-configured",
      request: hostConfiguredRequest,
    });
    const output = await collect(adapter.invoke(invocation()));

    expect(adapter.metadata).toMatchObject({
      provider_id: "openai",
      model_id: "gpt-host-configured",
    });
    expect(hostConfiguredRequest).toHaveBeenCalledOnce();
    expect(output.result.status).toBe("completed");
  });
});
