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
  createGeminiProviderAdapter,
  GeminiProviderAdapter,
  type GeminiGenerateContentRequest,
  type GeminiRequestOptions,
} from "../src/providers/gemini.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_fixture", source: "server_derived", trust: "authoritative" },
  project: { id: "prj_fixture", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "env_fixture", source: "server_derived", trust: "authoritative" },
  known_user: { id: "usr_fixture", source: "server_derived", trust: "authoritative" },
  session: { id: "ses_fixture", source: "server_derived", trust: "authoritative" },
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
      request_id: "req_gemini_fixture",
      trace_id: "trc_gemini_fixture",
      attribution,
      correlation_hints: {},
      metadata: { fixture: "provider_adapter" },
    },
    ...overrides,
  };
}

async function* chunks(...values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}

const usageMetadata = {
  promptTokenCount: 12,
  cachedContentTokenCount: 3,
  candidatesTokenCount: 5,
  thoughtsTokenCount: 2,
  toolUsePromptTokenCount: 4,
  totalTokenCount: 19,
  promptTokensDetails: [{ modality: "TEXT", tokenCount: 12 }],
};

function textStream(finishReason = "STOP") {
  return chunks(
    {
      candidates: [{
        index: 0,
        content: { role: "model", parts: [{ text: "Hel" }] },
        safetyRatings: [{ category: "HARM_CATEGORY_HATE_SPEECH", probability: "NEGLIGIBLE" }],
      }],
    },
    {
      candidates: [{
        index: 0,
        content: {
          role: "model",
          parts: [
            { text: "private chain of thought", thought: true, thoughtSignature: "private" },
            { text: "lo" },
          ],
        },
        finishReason,
      }],
      usageMetadata,
    },
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

describe("GeminiProviderAdapter", () => {
  it("streams text, hides thought parts, and normalizes cache/reasoning usage", async () => {
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
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
    expect(
      output.events
        .filter((event) => event.type === "response.text.delta")
        .map((event) => event.delta),
    ).toEqual(["Hel", "lo"]);
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
    expectValid(output.events);
  });

  it("maps images, tools, one prior tool result, generation settings, and AbortSignal", async () => {
    let payload: GeminiGenerateContentRequest | undefined;
    let options: GeminiRequestOptions | undefined;
    const controller = new AbortController();
    const request = vi.fn(
      (value: GeminiGenerateContentRequest, requestOptions: GeminiRequestOptions) => {
        payload = value;
        options = requestOptions;
        return textStream();
      },
    );
    const resolveImage = vi.fn(() => ({
      inlineData: {
        mimeType: "image/png" as const,
        data: "aW1hZ2UtZml4dHVyZQ==",
      },
    }));

    await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request,
        resolve_image_reference: resolveImage,
      }).invoke(invocation({
        signal: controller.signal,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Describe " },
            {
              type: "image",
              attachment: {
                attachment_id: "att_gemini_fixture",
                content_ref: "ref_gemini_fixture",
                media_type: "image/png",
                byte_size: 1024,
              },
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
      })),
    );

    expect(resolveImage).toHaveBeenCalledWith(
      expect.objectContaining({ content_ref: "ref_gemini_fixture" }),
    );
    expect(payload).toEqual({
      model: "gemini-fixture",
      contents: [
        {
          role: "user",
          parts: [
            { text: "Describe " },
            {
              inlineData: {
                mimeType: "image/png",
                data: "aW1hZ2UtZml4dHVyZQ==",
              },
            },
          ],
        },
        {
          role: "model",
          parts: [{
            functionCall: {
              id: "call_previous",
              name: "lookup_weather",
              args: {},
            },
          }],
        },
        {
          role: "user",
          parts: [{
            functionResponse: {
              id: "call_previous",
              name: "lookup_weather",
              response: {
                content: [{ type: "json", value: { temperature: 72 } }],
                is_error: false,
              },
            },
          }],
        },
      ],
      tools: [{
        functionDeclarations: [{
          name: "lookup_weather",
          description: "Look up weather.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        }],
      }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      generationConfig: { maxOutputTokens: 64, temperature: 0.5 },
    });
    expect(options?.signal).toBe(controller.signal);
  });

  it("emits only a complete cloned function call and maps STOP to tool_calls", async () => {
    const nativeArguments = { city: "Chicago", units: { system: "metric" } };
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request: () => chunks({
          candidates: [{
            index: 0,
            content: {
              role: "model",
              parts: [{
                functionCall: {
                  id: "call_weather",
                  name: "lookup_weather",
                  args: nativeArguments,
                },
              }],
            },
            finishReason: "STOP",
          }],
          usageMetadata,
        }),
      }).invoke(invocation()),
    );

    const callEvent = output.events.find(
      (event) => event.type === "response.tool_call",
    );
    expect(callEvent).toMatchObject({
      tool_call_id: "call_weather",
      name: "lookup_weather",
      arguments: nativeArguments,
    });
    expect(
      callEvent?.type === "response.tool_call" && callEvent.arguments,
    ).not.toBe(nativeArguments);
    expect(output.result).toMatchObject({
      status: "completed",
      outcome: "tool_calls",
    });
    expectValid(output.events);
  });

  it("creates a deterministic call id when Gemini omits its optional id", async () => {
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request: () => chunks({
          candidates: [{
            content: {
              role: "model",
              parts: [{ functionCall: { name: "lookup_weather", args: {} } }],
            },
            finishReason: "STOP",
          }],
          usageMetadata,
        }),
      }).invoke(invocation()),
    );

    expect(output.events[1]).toMatchObject({
      type: "response.tool_call",
      tool_call_id: "req_gemini_fixture:gemini:0",
    });
    expectValid(output.events);
  });

  it.each([
    ["STOP", "stop"],
    ["MAX_TOKENS", "length"],
  ] as const)("normalizes %s completion to %s", async (finishReason, outcome) => {
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request: () => textStream(finishReason),
      }).invoke(invocation()),
    );

    expect(output.result).toMatchObject({ status: "completed", outcome });
    expect(output.events.at(-1)).toMatchObject({
      type: "response.completed",
      outcome,
    });
    expectValid(output.events);
  });

  it("normalizes prompt-feedback denial without leaking feedback or safety data", async () => {
    const native = {
      candidates: [],
      promptFeedback: {
        blockReason: "SAFETY",
        blockReasonMessage: "private provider detail",
        safetyRatings: [{ category: "private", probability: "HIGH" }],
      },
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 0,
        totalTokenCount: 4,
      },
    };
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request: () => chunks(native),
      }).invoke(invocation()),
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.usage",
      "response.error",
    ]);
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "policy", code: "policy_denied" },
      usage: { input_tokens: 4, output_tokens: 0, total_tokens: 4 },
    });
    expect(JSON.stringify(output)).not.toMatch(
      /promptFeedback|safetyRatings|blockReason|private provider detail/,
    );
    expectValid(output.events);
  });

  it("normalizes a safety finish outcome as a policy denial", async () => {
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request: () => textStream("PROHIBITED_CONTENT"),
      }).invoke(invocation()),
    );

    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "policy", code: "policy_denied" },
      usage: { total_tokens: 19 },
    });
    expectValid(output.events);
  });

  it.each([
    [{ status: 429 }, "rate_limited"],
    [{ code: "RESOURCE_EXHAUSTED" }, "rate_limited"],
    [{ status: 503 }, "upstream_unavailable"],
    [{ code: "UNAVAILABLE" }, "upstream_unavailable"],
    [{ status: 504 }, "deadline_exceeded"],
    [{ name: "TimeoutError" }, "deadline_exceeded"],
  ] as const)("normalizes retryable failure %#", async (nativeError, code) => {
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request: () => {
          throw nativeError;
        },
      }).invoke(invocation()),
    );

    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "provider", retryable: true, code },
      usage: null,
    });
    expect(JSON.stringify(output)).not.toContain(JSON.stringify(nativeError));
    expectValid(output.events);
  });

  it.each([
    [{ status: 401 }, "unauthenticated"],
    [{ code: "PERMISSION_DENIED" }, "forbidden"],
    [{ status: 400 }, "invalid_request"],
  ] as const)("normalizes client failure %#", async (nativeError, code) => {
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request: () => {
          throw nativeError;
        },
      }).invoke(invocation()),
    );

    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", retryable: false, code },
      usage: null,
    });
    expectValid(output.events);
  });

  it("pre-aborts without resolving images or invoking upstream", async () => {
    const controller = new AbortController();
    controller.abort("policy_revoked");
    const request = vi.fn(() => textStream());
    const resolveImage = vi.fn(() => ({
      fileData: {
        mimeType: "image/png" as const,
        fileUri: "files/image-fixture",
      },
    }));
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
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

  it("propagates an in-stream abort to one cancellation terminal", async () => {
    const controller = new AbortController();
    const request = () => (async function* () {
      yield {
        candidates: [{ content: { role: "model", parts: [{ text: "partial" }] } }],
      };
      controller.abort("deadline_exceeded");
      yield {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata,
      };
    })();
    const output = await collect(
      createGeminiProviderAdapter({ model: "gemini-fixture", request }).invoke(
        invocation({ signal: controller.signal }),
      ),
    );

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.cancelled",
    ]);
    expect(output.result).toEqual({
      status: "cancelled",
      reason: "deadline_exceeded",
      usage: null,
    });
    expectValid(output.events);
  });

  it.each([
    ["multiple candidates", {
      candidates: [{ finishReason: "STOP" }, { finishReason: "STOP" }],
      usageMetadata,
    }],
    ["missing finish reason", {
      candidates: [{ content: { role: "model", parts: [{ text: "text" }] } }],
      usageMetadata,
    }],
    ["invalid usage total", {
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { ...usageMetadata, totalTokenCount: 999 },
    }],
    ["parallel calls", {
      candidates: [{
        content: {
          role: "model",
          parts: [
            { functionCall: { id: "one", name: "first", args: {} } },
            { functionCall: { id: "two", name: "second", args: {} } },
          ],
        },
        finishReason: "STOP",
      }],
      usageMetadata,
    }],
  ] as const)("rejects malformed native response: %s", async (_name, native) => {
    const output = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request: () => chunks(native),
      }).invoke(invocation()),
    );

    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "provider", code: "upstream_unavailable" },
      usage: null,
    });
    expect(JSON.stringify(output)).not.toMatch(
      /candidates|usageMetadata|finishReason|functionCall/,
    );
    expectValid(output.events);
  });

  it("rejects unsupported capabilities before calling the client", async () => {
    const request = vi.fn(() => textStream());
    const withImage = invocation({
      messages: [{
        role: "user",
        content: [{
          type: "image",
          attachment: {
            attachment_id: "att_gemini_fixture",
            content_ref: "ref_gemini_fixture",
            media_type: "image/png",
            byte_size: 10,
          },
        }],
      }],
    });
    const output = await collect(
      createGeminiProviderAdapter({ model: "gemini-fixture", request }).invoke(
        withImage,
      ),
    );

    expect(request).not.toHaveBeenCalled();
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "client", code: "invalid_request" },
    });
    expectValid(output.events);
  });

  it("rejects unsupported parallel prior results and disabled tool calls", async () => {
    const result = {
      tool_call_id: "call_one",
      name: "tool",
      content: [{ type: "text" as const, text: "done" }],
      is_error: false,
    };
    const request = vi.fn(() => textStream());
    const parallelOutput = await collect(
      createGeminiProviderAdapter({ model: "gemini-fixture", request }).invoke(
        invocation({
          tool_results: [result, { ...result, tool_call_id: "call_two" }],
        }),
      ),
    );
    const disabledOutput = await collect(
      createGeminiProviderAdapter({
        model: "gemini-fixture",
        request,
        supports_tool_calls: false,
      }).invoke(invocation({
        tools: [{
          name: "tool",
          description: "Tool.",
          input_schema: { type: "object" },
        }],
      })),
    );

    expect(request).not.toHaveBeenCalled();
    for (const output of [parallelOutput, disabledOutput]) {
      expect(output.result).toMatchObject({
        status: "failed",
        error: { kind: "client", code: "invalid_request" },
      });
      expectValid(output.events);
    }
  });

  it("constructs directly from an injected BYOK request without a gateway or SDK", async () => {
    const request = vi.fn(() => textStream());
    const adapter = new GeminiProviderAdapter({
      model: "models/gemini-byok-fixture",
      request,
      context_window_tokens: 1_000_000,
      max_output_tokens: 8_192,
    });
    const output = await collect(adapter.invoke(invocation()));

    expect(adapter.metadata).toEqual({
      provider_id: "gemini",
      model_id: "models/gemini-byok-fixture",
      capabilities: {
        streaming: true,
        text: true,
        tool_calls: true,
        parallel_tool_calls: false,
        reasoning: true,
        context_window_tokens: 1_000_000,
        max_output_tokens: 8_192,
      },
    });
    expect(request).toHaveBeenCalledOnce();
    expect(output.result.status).toBe("completed");
    expectValid(output.events);
  });
});
