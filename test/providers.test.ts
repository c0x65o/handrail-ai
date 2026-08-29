import { describe, expect, it } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  isStreamEvent,
  parseProviderDocumentInputCapability,
  parseStreamEvents,
  type AuthoritativeAttribution,
  type ProviderAdapter,
  type ProviderAdapterError,
  type ProviderAdapterInvocation,
  type ProviderAdapterResult,
  type ProviderAdapterStream,
  type ProviderCost,
  type ProviderDocumentInputCapability,
  type ProviderUsage,
  type StreamEvent,
} from "../src/index.js";

type NativeInvocationKey = Extract<
  keyof ProviderAdapterInvocation,
  "client" | "credentials" | "headers" | "native_request" | "provider_request" | "sdk_request"
>;
const invocationHasNoNativeKeys: NativeInvocationKey extends never ? true : false = true;

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_1", source: "server_derived", trust: "authoritative" },
  project: { id: "prj_1", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "env_1", source: "server_derived", trust: "authoritative" },
  known_user: { id: "usr_1", source: "server_derived", trust: "authoritative" },
  session: { id: "ses_1", source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

const normalizedUsage: ProviderUsage = {
  input_tokens: 120,
  cached_input_tokens: 40,
  output_tokens: 30,
  reasoning_tokens: 10,
  total_tokens: 150,
  provider_cost: { known: true, amount: "0.001230", currency: "USD" },
};

function invocation(signal = new AbortController().signal): ProviderAdapterInvocation {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is shown in this image?" },
          {
            type: "image",
            attachment: {
              attachment_id: "att_provider_fixture_1",
              content_ref: "ref_provider_fixture_1",
              media_type: "image/webp",
              byte_size: 12_345,
              filename: "fixture.webp",
            },
            alt_text: "Provider adapter fixture",
          },
        ],
      },
    ],
    tools: [
      {
        name: "lookup_weather",
        description: "Look up weather.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ],
    tool_results: [],
    generation: { max_output_tokens: 128, temperature: 0 },
    signal,
    context: {
      request_id: "req_fake_1",
      trace_id: "trc_fake_1",
      attribution,
      correlation_hints: {},
      metadata: { fixture: "provider_adapter" },
    },
  };
}

type Scenario = "text" | "tool" | "cancel" | "provider_error" | "client_error" | "policy_error";

class FakeProviderAdapter implements ProviderAdapter {
  readonly provider_context = {
    supported: false,
    reason: "provider_not_supported",
  } as const;
  readonly metadata = {
    provider_id: "fake",
    model_id: "fake-model-v1",
    capabilities: {
      streaming: true,
      text: true,
      tool_calls: true,
      parallel_tool_calls: false,
      reasoning: true,
      document_input: { supported: false },
      provider_context: this.provider_context,
      context_window_tokens: 8_192,
      max_output_tokens: 1_024,
    },
  } as const;

  constructor(private readonly scenario: Scenario) {}

  invoke(input: ProviderAdapterInvocation): ProviderAdapterStream {
    return this.stream(input);
  }

  private async *stream(input: ProviderAdapterInvocation): ProviderAdapterStream {
    const envelope = (type: StreamEvent["type"], sequence: number) => ({
      type,
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: input.context.request_id,
      trace_id: input.context.trace_id,
      sequence,
    });

    yield {
      ...envelope("response.started", 0),
      type: "response.started",
      attribution: input.context.attribution,
    };

    if (this.scenario === "cancel") {
      if (!input.signal.aborted) {
        await new Promise<void>((resolve) => {
          input.signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
      yield {
        ...envelope("response.cancelled", 1),
        type: "response.cancelled",
        reason: "deadline_exceeded",
      };
      return { status: "cancelled", reason: "deadline_exceeded", usage: null };
    }

    if (this.scenario === "text") {
      yield {
        ...envelope("response.text.delta", 1),
        type: "response.text.delta",
        delta: "Hello from the fake adapter.",
      };
      yield {
        ...envelope("response.usage", 2),
        type: "response.usage",
        usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      };
      yield {
        ...envelope("response.completed", 3),
        type: "response.completed",
        outcome: "stop",
      };
      return { status: "completed", outcome: "stop", usage: normalizedUsage };
    }

    if (this.scenario === "tool") {
      yield {
        ...envelope("response.tool_call", 1),
        type: "response.tool_call",
        tool_call_id: "call_fake_1",
        name: "lookup_weather",
        arguments: { city: "Chicago" },
      };
      yield {
        ...envelope("response.usage", 2),
        type: "response.usage",
        usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
      };
      yield {
        ...envelope("response.completed", 3),
        type: "response.completed",
        outcome: "tool_calls",
      };
      return { status: "completed", outcome: "tool_calls", usage: normalizedUsage };
    }

    const error = this.errorForScenario();
    const publicError =
      error.kind === "provider"
        ? { category: "upstream" as const, code: error.code, message: error.message, retryable: true }
        : error.kind === "policy"
          ? { category: "policy" as const, code: error.code, message: error.message, retryable: false }
          : { category: "request" as const, code: error.code, message: error.message, retryable: false };

    yield {
      ...envelope("response.error", 1),
      type: "response.error",
      error: publicError,
    };
    return { status: "failed", error, usage: null };
  }

  private errorForScenario(): ProviderAdapterError {
    switch (this.scenario) {
      case "provider_error":
        return {
          kind: "provider",
          retryable: true,
          code: "upstream_unavailable",
          message: "The provider is temporarily unavailable.",
        };
      case "policy_error":
        return {
          kind: "policy",
          retryable: false,
          code: "policy_denied",
          message: "The request was denied by policy.",
        };
      case "client_error":
        return {
          kind: "client",
          retryable: false,
          code: "invalid_request",
          message: "The request is invalid.",
        };
      default:
        throw new Error(`scenario ${this.scenario} does not produce an error`);
    }
  }
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

function expectValidV1Sequence(events: StreamEvent[]) {
  expect(events.every((event) => isStreamEvent(event))).toBe(true);
  expect(parseStreamEvents(events)).toBe(events);
}

describe("provider adapter contract", () => {
  it("narrows supported and unsupported document capabilities", () => {
    const capabilities: ProviderDocumentInputCapability[] = [
      parseProviderDocumentInputCapability({ supported: false }),
      parseProviderDocumentInputCapability({
        supported: true,
        capability: {
          supported_mime_types: ["application/pdf"],
          max_document_count: 2,
          max_document_bytes: 1_024,
          requires_host_resolution: true,
        },
      }),
    ];

    expect(capabilities[0]?.supported).toBe(false);
    const supported = capabilities[1];
    if (supported === undefined || !supported.supported) {
      throw new Error("document capability should be supported");
    }
    expect(supported.capability).toEqual({
      supported_mime_types: ["application/pdf"],
      max_document_count: 2,
      max_document_bytes: 1_024,
      requires_host_resolution: true,
    });
  });

  it.each([
    ["malformed", null],
    [
      "empty MIME list",
      {
        supported: true,
        capability: {
          supported_mime_types: [],
          max_document_count: 1,
          max_document_bytes: 1,
          requires_host_resolution: true,
        },
      },
    ],
    [
      "duplicate MIME list",
      {
        supported: true,
        capability: {
          supported_mime_types: ["application/pdf", "application/pdf"],
          max_document_count: 1,
          max_document_bytes: 1,
          requires_host_resolution: true,
        },
      },
    ],
    [
      "unbounded count",
      {
        supported: true,
        capability: {
          supported_mime_types: ["application/pdf"],
          max_document_count: Number.POSITIVE_INFINITY,
          max_document_bytes: 1,
          requires_host_resolution: true,
        },
      },
    ],
    [
      "over-protocol count",
      {
        supported: true,
        capability: {
          supported_mime_types: ["application/pdf"],
          max_document_count:
            AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerRequest + 1,
          max_document_bytes: 1,
          requires_host_resolution: true,
        },
      },
    ],
    [
      "over-protocol bytes",
      {
        supported: true,
        capability: {
          supported_mime_types: ["application/pdf"],
          max_document_count: 1,
          max_document_bytes:
            AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes + 1,
          requires_host_resolution: true,
        },
      },
    ],
    [
      "unbounded bytes",
      {
        supported: true,
        capability: {
          supported_mime_types: ["application/pdf"],
          max_document_count: 1,
          max_document_bytes: Number.POSITIVE_INFINITY,
          requires_host_resolution: true,
        },
      },
    ],
    [
      "unsupported MIME",
      {
        supported: true,
        capability: {
          supported_mime_types: ["text/plain"],
          max_document_count: 1,
          max_document_bytes: 1,
          requires_host_resolution: true,
        },
      },
    ],
  ])("rejects %s document capability descriptors", (_label, capability) => {
    expect(() => parseProviderDocumentInputCapability(capability)).toThrow(
      TypeError,
    );
  });

  it("streams normalized text events and returns exact normalized usage", async () => {
    const adapter: ProviderAdapter = new FakeProviderAdapter("text");
    const output = await collect(adapter.invoke(invocation()));

    expect(output.events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.usage",
      "response.completed",
    ]);
    expectValidV1Sequence(output.events);
    expect(output.result).toEqual({ status: "completed", outcome: "stop", usage: normalizedUsage });
    expect(adapter.metadata.capabilities.reasoning).toBe(true);
  });

  it("streams one normalized tool-call event with valid terminal sequencing", async () => {
    const output = await collect(new FakeProviderAdapter("tool").invoke(invocation()));

    expect(output.events[1]).toMatchObject({
      type: "response.tool_call",
      tool_call_id: "call_fake_1",
      name: "lookup_weather",
      arguments: { city: "Chicago" },
    });
    expectValidV1Sequence(output.events);
    expect(output.result).toMatchObject({ status: "completed", outcome: "tool_calls" });
  });

  it("turns the supplied AbortSignal into a valid v1 cancellation sequence", async () => {
    const controller = new AbortController();
    const stream = new FakeProviderAdapter("cancel").invoke(invocation(controller.signal));
    const first = await stream.next();
    expect(first.done).toBe(false);
    controller.abort();

    const remainder = await collect(stream);
    const events = [first.value as StreamEvent, ...remainder.events];
    expect(events.map((event) => event.type)).toEqual(["response.started", "response.cancelled"]);
    expectValidV1Sequence(events);
    expect(remainder.result).toEqual({
      status: "cancelled",
      reason: "deadline_exceeded",
      usage: null,
    });
  });

  it("keeps cached input and reasoning as subsets and distinguishes unknown cost from zero", () => {
    expect(normalizedUsage).toMatchObject({
      input_tokens: 120,
      cached_input_tokens: 40,
      output_tokens: 30,
      reasoning_tokens: 10,
      total_tokens: 150,
      provider_cost: { known: true, amount: "0.001230", currency: "USD" },
    });
    expect(normalizedUsage.total_tokens).toBe(
      normalizedUsage.input_tokens + normalizedUsage.output_tokens,
    );

    const unknown: ProviderCost = { known: false };
    const knownZero: ProviderCost = { known: true, amount: "0", currency: "USD" };
    expect(unknown).not.toEqual(knownZero);
  });

  it("returns a retryable provider failure without leaking a native error", async () => {
    const output = await collect(new FakeProviderAdapter("provider_error").invoke(invocation()));

    expectValidV1Sequence(output.events);
    expect(output.events.at(-1)).toMatchObject({
      type: "response.error",
      error: { category: "upstream", code: "upstream_unavailable", retryable: true },
    });
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind: "provider", code: "upstream_unavailable", retryable: true },
    });
  });

  it.each([
    ["client_error", "client", "invalid_request"],
    ["policy_error", "policy", "policy_denied"],
  ] as const)("distinguishes %s as a non-retryable %s error", async (scenario, kind, code) => {
    const output = await collect(new FakeProviderAdapter(scenario).invoke(invocation()));

    expectValidV1Sequence(output.events);
    expect(output.result).toMatchObject({
      status: "failed",
      error: { kind, code, retryable: false },
    });
  });

  it("has a provider-neutral TypeScript invocation surface", () => {
    expect(invocationHasNoNativeKeys).toBe(true);
  });

  it("exposes provider-neutral image references to adapters as serializable message content", () => {
    const input = invocation();
    const part = input.messages[0]!.content[1]!;

    expect(part.type).toBe("image");
    if (part.type !== "image") throw new Error("expected an image content part");
    expect(part.attachment).toEqual({
      attachment_id: "att_provider_fixture_1",
      content_ref: "ref_provider_fixture_1",
      media_type: "image/webp",
      byte_size: 12_345,
      filename: "fixture.webp",
    });
    expect(JSON.parse(JSON.stringify(input.messages))).toEqual(input.messages);
  });
});
