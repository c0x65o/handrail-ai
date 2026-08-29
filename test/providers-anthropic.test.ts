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
  createAnthropicProviderAdapter,
  type AnthropicMessagesRequest,
  type AnthropicRequestOptions,
} from "../src/providers/anthropic.js";

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
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    tool_results: [],
    generation: { max_output_tokens: 128, temperature: 0.25 },
    signal: new AbortController().signal,
    context: {
      request_id: "req_anthropic_fixture",
      trace_id: "trc_anthropic_fixture",
      attribution,
      correlation_hints: {},
      metadata: { fixture: "anthropic_adapter" },
    },
    ...overrides,
  };
}

async function* chunks(...values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}

const messageStart = {
  type: "message_start",
  message: {
    id: "msg_native_fixture",
    type: "message",
    role: "assistant",
    content: [],
    usage: {
      input_tokens: 12,
      cache_creation_input_tokens: 4,
      cache_read_input_tokens: 3,
      output_tokens: 0,
    },
  },
};

function messageDelta(stopReason: string, outputTokens = 7) {
  return {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens, reasoning_tokens: 2 },
  };
}

const messageStop = { type: "message_stop" };

function textStream(stopReason = "end_turn") {
  return chunks(
    messageStart,
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hel" },
    },
    { type: "ping" },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "lo" },
    },
    { type: "content_block_stop", index: 0 },
    messageDelta(stopReason),
    messageStop,
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
  expect(events.map((event) => event.sequence)).toEqual(
    events.map((_, index) => index),
  );
  expect(
    events.filter((event) =>
      ["response.completed", "response.cancelled", "response.error"].includes(
        event.type,
      ),
    ),
  ).toHaveLength(1);
}

describe("AnthropicProviderAdapter", () => {
  it("streams text and normalizes cache creation, cache reads, reasoning, and unknown cost", async () => {
    const output = await collect(
      createAnthropicProviderAdapter({
        model: "claude-fixture",
        request: () => textStream(),
      }).invoke(invocation()),
    );

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
        input_tokens: 19,
        cached_input_tokens: 3,
        output_tokens: 7,
        reasoning_tokens: 2,
        total_tokens: 26,
        provider_cost: { known: false },
      },
    });
    expectValid(output.events);
  });

  it("assembles fragmented tool-use JSON and emits only a complete normalized call", async () => {
    const request = vi.fn(() =>
      chunks(
        messageStart,
        {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_weather",
            name: "lookup_weather",
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{\"city\":" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "\"Chicago\"}" },
        },
        { type: "content_block_stop", index: 0 },
        messageDelta("tool_use"),
        messageStop,
      ),
    );
    const output = await collect(
      createAnthropicProviderAdapter({ model: "claude-fixture", request }).invoke(
        invocation(),
      ),
    );

    expect(output.events.filter((event) => event.type === "response.tool_call")).toEqual([
      expect.objectContaining({
        type: "response.tool_call",
        tool_call_id: "toolu_weather",
        name: "lookup_weather",
        arguments: { city: "Chicago" },
      }),
    ]);
    expect(output.result).toMatchObject({
      status: "completed",
      outcome: "tool_calls",
    });
    expectValid(output.events);
  });

  it("maps images, tool schemas, tool results, generation settings, and AbortSignal", async () => {
    let payload: AnthropicMessagesRequest | undefined;
    let requestOptions: AnthropicRequestOptions | undefined;
    const controller = new AbortController();
    const request = vi.fn(
      (value: AnthropicMessagesRequest, options: AnthropicRequestOptions) => {
        payload = value;
        requestOptions = options;
        return textStream();
      },
    );
    const resolveImage = vi.fn(() => ({
      type: "base64" as const,
      media_type: "image/png" as const,
      data: "aW1hZ2UtZml4dHVyZQ==",
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
              attachment_id: "att_anthropic_fixture",
              content_ref: "ref_anthropic_fixture",
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
        tool_call_id: "toolu_previous",
        name: "lookup_weather",
        content: [{ type: "json", value: { temperature: 72 } }],
        is_error: false,
      }],
      generation: { max_output_tokens: 64, temperature: 0.5 },
    });

    await collect(
      createAnthropicProviderAdapter({
        model: "claude-fixture",
        request,
        resolve_image_reference: resolveImage,
      }).invoke(input),
    );

    expect(resolveImage).toHaveBeenCalledWith(
      expect.objectContaining({ content_ref: "ref_anthropic_fixture" }),
    );
    expect(payload).toEqual({
      model: "claude-fixture",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe " },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aW1hZ2UtZml4dHVyZQ==",
              },
            },
          ],
        },
        {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "toolu_previous",
            name: "lookup_weather",
            input: {},
          }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_previous",
            content: "{\"temperature\":72}",
            is_error: false,
          }],
        },
      ],
      tools: [{
        name: "lookup_weather",
        description: "Look up weather.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      max_tokens: 64,
      temperature: 0.5,
      stream: true,
    });
    expect(requestOptions?.signal).toBe(controller.signal);
  });

  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["model_context_window_exceeded", "length"],
  ] as const)("normalizes %s completion to %s", async (stopReason, outcome) => {
    const output = await collect(
      createAnthropicProviderAdapter({
        model: "claude-fixture",
        request: () => textStream(stopReason),
      }).invoke(invocation()),
    );

    expect(output.result).toMatchObject({ status: "completed", outcome });
    expect(output.events.at(-1)).toMatchObject({
      type: "response.completed",
      outcome,
    });
    expectValid(output.events);
  });

  it("normalizes a refusal as a policy terminal with usage", async () => {
    const output = await collect(
      createAnthropicProviderAdapter({
        model: "claude-fixture",
        request: () => textStream("refusal"),
      }).invoke(invocation()),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.error",
      error: { category: "policy", code: "policy_denied" },
    });
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "policy", code: "policy_denied" },
      usage: { input_tokens: 19, output_tokens: 7 },
    });
    expectValid(output.events);
  });

  it("pre-aborts without resolving images or invoking upstream", async () => {
    const controller = new AbortController();
    controller.abort("policy_revoked");
    const request = vi.fn(() => textStream());
    const resolveImage = vi.fn(() => ({
      type: "url" as const,
      url: "https://images.example.test/fixture.png",
    }));
    const output = await collect(
      createAnthropicProviderAdapter({
        model: "claude-fixture",
        request,
        resolve_image_reference: resolveImage,
      }).invoke(invocation({ signal: controller.signal })),
    );

    expect(request).not.toHaveBeenCalled();
    expect(resolveImage).not.toHaveBeenCalled();
    expect(output.result).toEqual({
      status: "cancelled",
      reason: "policy_revoked",
      usage: null,
    });
    expectValid(output.events);
  });

  it("normalizes an in-stream abort and emits one cancellation terminal", async () => {
    const controller = new AbortController();
    const request = () => (async function* () {
      yield messageStart;
      controller.abort("deadline_exceeded");
      yield { type: "ping" };
    })();
    const output = await collect(
      createAnthropicProviderAdapter({ model: "claude-fixture", request }).invoke(
        invocation({ signal: controller.signal }),
      ),
    );

    expect(output.events.at(-1)).toMatchObject({
      type: "response.cancelled",
      reason: "deadline_exceeded",
    });
    expect(output.result).toEqual({
      status: "cancelled",
      reason: "deadline_exceeded",
      usage: null,
    });
    expectValid(output.events);
  });

  it.each([
    [429, "upstream", "rate_limited", true],
    [503, "upstream", "upstream_unavailable", true],
    [408, "upstream", "deadline_exceeded", true],
    [401, "authentication", "unauthenticated", false],
    [403, "authorization", "forbidden", false],
    [400, "request", "invalid_request", false],
  ] as const)(
    "normalizes status %i without exposing the native error",
    async (status, category, code, retryable) => {
      const output = await collect(
        createAnthropicProviderAdapter({
          model: "claude-fixture",
          request: async () => {
            throw {
              status,
              message: "raw secret sk-ant-fixture-do-not-leak",
              headers: { authorization: "Bearer native-secret" },
              response: { native_chunk: true },
            };
          },
        }).invoke(invocation()),
      );

      expect(output.events.at(-1)).toMatchObject({
        type: "response.error",
        error: { category, code, retryable },
      });
      expect(output.result).toMatchObject({
        status: "failed",
        error: { code, retryable },
        usage: null,
      });
      const serialized = JSON.stringify(output);
      for (const marker of [
        "sk-ant-fixture",
        "native-secret",
        "Bearer",
        "headers",
        "native_chunk",
      ]) {
        expect(serialized).not.toContain(marker);
      }
      expectValid(output.events);
    },
  );

  it("normalizes a provider-reported overloaded stream error", async () => {
    const output = await collect(
      createAnthropicProviderAdapter({
        model: "claude-fixture",
        request: () => chunks(messageStart, {
          type: "error",
          error: {
            type: "overloaded_error",
            message: "native capacity details",
          },
        }),
      }).invoke(invocation()),
    );

    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "provider", code: "upstream_unavailable" },
    });
    expect(JSON.stringify(output)).not.toContain("native capacity details");
    expectValid(output.events);
  });

  it("fails safely on malformed blocks without exposing native chunks", async () => {
    const output = await collect(
      createAnthropicProviderAdapter({
        model: "claude-fixture",
        request: () => chunks(
          messageStart,
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: { secret_marker: "native-content-do-not-leak" },
            },
          },
        ),
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
    expect(JSON.stringify(output)).not.toContain("native-content-do-not-leak");
    expectValid(output.events);
  });

  it("rejects unsupported tool capability before invoking upstream", async () => {
    const request = vi.fn(() => textStream());
    const output = await collect(
      createAnthropicProviderAdapter({
        model: "claude-fixture",
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

  it("rejects invalid provider input before invoking upstream", async () => {
    const request = vi.fn(() => textStream());
    const output = await collect(
      createAnthropicProviderAdapter({ model: "claude-fixture", request }).invoke(
        invocation({ messages: [] }),
      ),
    );

    expect(request).not.toHaveBeenCalled();
    expect(output.events.at(-1)).toMatchObject({
      type: "response.error",
      error: { category: "request", code: "invalid_request" },
    });
    expectValid(output.events);
  });

  it("constructs around a host-configured BYOK request with no managed transport", async () => {
    const hostConfiguredRequest = vi.fn(() => textStream());
    const adapter = createAnthropicProviderAdapter({
      model: "claude-host-configured",
      request: hostConfiguredRequest,
      context_window_tokens: 200_000,
      max_output_tokens: 8192,
    });
    const output = await collect(adapter.invoke(invocation()));

    expect(adapter.metadata).toEqual({
      provider_id: "anthropic",
      model_id: "claude-host-configured",
      capabilities: {
        streaming: true,
        text: true,
        tool_calls: true,
        parallel_tool_calls: false,
        reasoning: true,
        document_input: { supported: false },
        context_window_tokens: 200_000,
        max_output_tokens: 8192,
      },
    });
    expect(hostConfiguredRequest).toHaveBeenCalledOnce();
    expect(output.result.status).toBe("completed");
    expectValid(output.events);
  });

  it("rejects documents before resolving references or calling upstream", async () => {
    const request = vi.fn(() => textStream());
    const resolveDocumentReference = vi.fn(() => ({
      media_type: "application/pdf" as const,
      bytes: new Uint8Array([1]),
    }));
    const adapter = createAnthropicProviderAdapter({ model: "claude-fixture", request });
    const output = await collect(adapter.invoke(invocation({
      messages: [{
        role: "user",
        content: [{
          type: "document",
          attachment: {
            attachment_id: "att_anthropic_pdf",
            content_ref: "ref_anthropic_pdf",
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
