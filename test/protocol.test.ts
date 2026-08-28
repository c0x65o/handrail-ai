import { describe, expect, it } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  AI_RUNTIME_STREAM_EVENT_TYPES,
  ProtocolValidationError,
  isChatRequest,
  isStreamEvent,
  parseChatRequest,
  parseStreamEvent,
  parseStreamEvents,
} from "../src/index.js";

const attribution = () => ({
  organization: {
    id: "org_01J8Y7M1",
    source: "server_derived",
    trust: "authoritative",
  },
  project: {
    id: "prj_01J8Y7M2",
    source: "server_derived",
    trust: "authoritative",
  },
  service_environment: {
    id: "env_01J8Y7M3",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: {
    id: "usr_01J8Y7M4",
    source: "server_derived",
    trust: "authoritative",
  },
  session: {
    id: "ses_01J8Y7M5",
    source: "server_derived",
    trust: "authoritative",
  },
  automation: {
    id: "aut_01J8Y7M6",
    source: "server_derived",
    trust: "authoritative",
  },
});

interface RequestFixture {
  protocol_version: string;
  continuation_of: string | null;
  messages: unknown[];
  tools: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_results: Array<Record<string, unknown>>;
  generation: Record<string, unknown>;
  correlation_hints: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

const request = (): RequestFixture => ({
  protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
  continuation_of: null,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "What is the delivery status for order A-104?",
        },
      ],
    },
  ],
  tools: [
    {
      name: "lookup_order",
      description: "Look up an order in the application database.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string" },
        },
        required: ["order_id"],
        additionalProperties: false,
      },
    },
  ],
  tool_results: [],
  generation: {
    max_output_tokens: 512,
    temperature: 0.2,
  },
  correlation_hints: {
    known_user: {
      external_id: "customer-42",
      source: "client",
      trust: "untrusted_correlation_hint",
    },
    session: {
      external_id: "support-session-7",
      source: "client",
      trust: "untrusted_correlation_hint",
    },
    automation: {
      external_id: "order-support-bot",
      source: "client",
      trust: "untrusted_correlation_hint",
    },
  },
});

const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

function metadataWithSerializedByteLength(targetBytes: number, fill: string) {
  const metadata: Record<string, string> = {};
  const fillBytes = utf8ByteLength(fill);
  const maxFillCount = Math.floor(AI_RUNTIME_PROTOCOL_LIMITS.metadataStringLength / fill.length);

  for (let index = 0; index < AI_RUNTIME_PROTOCOL_LIMITS.metadataObjectKeys; index += 1) {
    const key = `chunk_${index}`;
    const emptyValueBytes = utf8ByteLength(JSON.stringify({ ...metadata, [key]: "" }));
    const remainingBytes = targetBytes - emptyValueBytes;
    const fillCount = Math.floor(remainingBytes / fillBytes);
    const remainderBytes = remainingBytes - fillCount * fillBytes;
    const value = fill.repeat(fillCount) + "x".repeat(remainderBytes);

    if (remainingBytes >= 0 && value.length <= AI_RUNTIME_PROTOCOL_LIMITS.metadataStringLength) {
      metadata[key] = value;
      expect(utf8ByteLength(JSON.stringify(metadata))).toBe(targetBytes);
      return metadata;
    }

    metadata[key] = fill.repeat(maxFillCount);
  }

  throw new Error(`Could not construct metadata serialized to ${targetBytes} bytes`);
}

const envelope = (type: string, sequence: number) => ({
  type,
  protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
  request_id: "req_01J8Y7R0E1",
  trace_id: "trc_01J8Y7R0E2",
  sequence,
});

const started = () => ({
  ...envelope("response.started", 0),
  attribution: attribution(),
});

describe("chat request protocol", () => {
  it("round-trips the normative initial request without mutation", () => {
    const fixture = request();

    expect(parseChatRequest(fixture)).toBe(fixture);
    expect(isChatRequest(fixture)).toBe(true);
  });

  it("round-trips the normative application tool-result continuation", () => {
    const fixture = request();
    fixture.continuation_of = "req_01J8Y7PYG4";
    fixture.tool_results.push({
      tool_call_id: "call_01J8Y7Q4AF",
      name: "lookup_order",
      content: [
        {
          type: "json",
          value: {
            order_id: "A-104",
            status: "out_for_delivery",
          },
        },
      ],
      is_error: false,
    });

    expect(parseChatRequest(fixture)).toBe(fixture);
  });

  it("rejects unknown request fields and server-owned identifiers", () => {
    const forbidden = [
      "organization",
      "organization_id",
      "project",
      "project_id",
      "service_environment",
      "service_environment_id",
      "known_user",
      "known_user_id",
      "session",
      "session_id",
      "automation",
      "automation_id",
      "request_id",
      "trace_id",
      "attribution",
    ];

    for (const key of forbidden) {
      expect(() => parseChatRequest({ ...request(), [key]: "client-value" })).toThrow(
        ProtocolValidationError,
      );
    }
    expect(() => parseChatRequest({ ...request(), future_option: true })).toThrow(
      /not a supported field/,
    );
  });

  it("accepts only untrusted external correlation hints", () => {
    const authoritative = request();
    authoritative.correlation_hints.known_user = {
      external_id: "usr_client",
      source: "server_derived",
      trust: "authoritative",
    };
    expect(() => parseChatRequest(authoritative)).toThrow(/source/);

    const idInsteadOfExternalId = request();
    idInsteadOfExternalId.correlation_hints.known_user = {
      id: "usr_client",
      source: "client",
      trust: "untrusted_correlation_hint",
    };
    expect(() => parseChatRequest(idInsteadOfExternalId)).toThrow(/external_id/);
  });

  it("rejects malformed continuation linkage", () => {
    expect(() => parseChatRequest({ ...request(), continuation_of: "req_previous" })).toThrow(
      /must be null/,
    );

    const resultWithoutContinuation = request();
    resultWithoutContinuation.tool_results.push({
      tool_call_id: "call_1",
      name: "lookup_order",
      content: [{ type: "text", text: "safe result" }],
      is_error: false,
    });
    expect(() => parseChatRequest(resultWithoutContinuation)).toThrow(/preceding request/);
  });

  it("rejects malformed tool definitions and application results", () => {
    const wrongSchema = request();
    wrongSchema.tools[0]!.input_schema.type = "string";
    expect(() => parseChatRequest(wrongSchema)).toThrow(/input_schema.type/);

    const malformedProperties = request();
    malformedProperties.tools[0]!.input_schema.properties = [];
    expect(() => parseChatRequest(malformedProperties)).toThrow(/properties/);

    const missingCallId = request();
    missingCallId.continuation_of = "req_previous";
    missingCallId.tool_results.push({
      name: "lookup_order",
      content: [{ type: "text", text: "safe result" }],
      is_error: false,
    });
    expect(() => parseChatRequest(missingCallId)).toThrow(/tool_call_id/);

    const undeclaredTool = request();
    undeclaredTool.continuation_of = "req_previous";
    undeclaredTool.tool_results.push({
      tool_call_id: "call_1",
      name: "provider_tool_wrapper",
      content: [{ type: "text", text: "safe result" }],
      is_error: false,
    });
    expect(() => parseChatRequest(undeclaredTool)).toThrow(/declared tool/);

    const malformedContent = request();
    malformedContent.continuation_of = "req_previous";
    malformedContent.tool_results.push({
      tool_call_id: "call_1",
      name: "lookup_order",
      content: [{ type: "json", text: "not a JSON result part" }],
      is_error: false,
    });
    expect(() => parseChatRequest(malformedContent)).toThrow(/value/);
  });

  it("rejects credential-bearing fields throughout public request data", () => {
    const fixtures = [
      { ...request(), metadata: { api_key: "not-allowed" } },
      { ...request(), metadata: { nested: { authorization: "Bearer value" } } },
      {
        ...request(),
        tools: [
          {
            ...request().tools[0],
            input_schema: {
              type: "object",
              properties: { client_secret: { type: "string" } },
            },
          },
        ],
      },
    ];

    for (const fixture of fixtures) {
      expect(() => parseChatRequest(fixture)).toThrow(/forbidden/);
    }
  });

  it("preserves allowed bounded metadata and legitimate token usage names", () => {
    const metadata = {
      feature: "order_support",
      experiment: { cohort: "b", measurements: [1, 2, 3] },
      usage_snapshot: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    };
    const fixture = { ...request(), metadata };

    const parsed = parseChatRequest(fixture);
    expect(parsed).toBe(fixture);
    expect(parsed.metadata).toBe(metadata);
    expect(parsed.metadata).toEqual(metadata);
  });

  it("prevents provider payloads and attribution from being smuggled through metadata", () => {
    const forbiddenMetadata = [
      { provider: "openai" },
      { openai: { response: "native" } },
      { provider_payload: { chunk: {} } },
      { finish_reason: "stop" },
      { raw_response: {} },
      { request_headers: {} },
      { project_id: "prj_client" },
      { attribution: attribution() },
      { backend: "openai" },
    ];

    for (const metadata of forbiddenMetadata) {
      expect(() => parseChatRequest({ ...request(), metadata })).toThrow(
        /forbidden|provider-native/,
      );
    }
  });

  it("bounds metadata depth", () => {
    let nested: Record<string, unknown> = { value: true };
    for (let index = 0; index <= AI_RUNTIME_PROTOCOL_LIMITS.metadataDepth; index += 1) {
      nested = { nested };
    }
    expect(() => parseChatRequest({ ...request(), metadata: nested })).toThrow(/depth/);
  });

  it.each([
    ["ASCII", "x"],
    ["multibyte text", "\u00e9"],
    ["surrogate pairs", "\ud83d\ude00"],
  ])("enforces the exact serialized UTF-8 byte boundary for %s", (_label, fill) => {
    const limit = AI_RUNTIME_PROTOCOL_LIMITS.metadataSerializedBytes;
    const accepted = metadataWithSerializedByteLength(limit, fill);
    const rejected = metadataWithSerializedByteLength(limit + 1, fill);

    expect(parseChatRequest({ ...request(), metadata: accepted }).metadata).toBe(accepted);
    expect(() => parseChatRequest({ ...request(), metadata: rejected })).toThrow(
      `must serialize to at most ${limit} bytes`,
    );
  });
});

describe("server stream-event protocol", () => {
  it("round-trips all seven event discriminators", () => {
    const events = [
      started(),
      { ...envelope("response.text.delta", 1), delta: "Order A-104 is out for delivery." },
      {
        ...envelope("response.tool_call", 1),
        tool_call_id: "call_01J8Y7Q4AF",
        name: "lookup_order",
        arguments: { order_id: "A-104" },
      },
      {
        ...envelope("response.usage", 1),
        usage: { input_tokens: 203, output_tokens: 11, total_tokens: 214 },
      },
      { ...envelope("response.completed", 1), outcome: "stop" },
      { ...envelope("response.cancelled", 1), reason: "deadline_exceeded" },
      {
        ...envelope("response.error", 1),
        error: {
          category: "upstream",
          code: "upstream_unavailable",
          message: "The AI service is temporarily unavailable.",
          retryable: true,
        },
      },
    ];

    expect(events.map((event) => parseStreamEvent(event))).toEqual(events);
    expect(events.every((event) => isStreamEvent(event))).toBe(true);
    expect(AI_RUNTIME_STREAM_EVENT_TYPES).toHaveLength(7);
  });

  it.each([
    "response.output_text.delta",
    "response.function_call",
    "response.provider_chunk",
    "response.done",
    "error",
  ])("rejects the unknown event discriminator %s", (type) => {
    expect(() => parseStreamEvent({ ...envelope(type, 1), payload: {} })).toThrow(
      /must be one of/,
    );
  });

  it("rejects malformed tool-call events", () => {
    expect(() =>
      parseStreamEvent({
        ...envelope("response.tool_call", 1),
        tool_call_id: "call_1",
        name: "lookup_order",
        arguments: ["provider", "wrapped", "arguments"],
      }),
    ).toThrow(/JSON object/);
    expect(() =>
      parseStreamEvent({
        ...envelope("response.tool_call", 1),
        name: "lookup_order",
        arguments: {},
      }),
    ).toThrow(/tool_call_id/);
  });

  it("rejects negative, fractional, and malformed usage quantities", () => {
    for (const usage of [
      { input_tokens: -1, output_tokens: 0, total_tokens: 0 },
      { input_tokens: 1, output_tokens: 0.5, total_tokens: 1.5 },
      { input_tokens: 1, output_tokens: 1 },
      { input_tokens: 1, output_tokens: 1, total_tokens: 2, cached_tokens: 1 },
    ]) {
      expect(() =>
        parseStreamEvent({ ...envelope("response.usage", 1), usage }),
      ).toThrow(ProtocolValidationError);
    }
  });

  it("rejects malformed completed, cancelled, and error terminal events", () => {
    expect(() =>
      parseStreamEvent({ ...envelope("response.completed", 1), outcome: "content_filter" }),
    ).toThrow(/outcome/);
    expect(() =>
      parseStreamEvent({ ...envelope("response.cancelled", 1), reason: "client_disconnected" }),
    ).toThrow(/reason/);
    expect(() =>
      parseStreamEvent({
        ...envelope("response.error", 1),
        error: {
          category: "provider",
          code: "openai_429",
          message: "raw provider error",
          retryable: true,
          stack: "provider stack",
        },
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseStreamEvent({
        ...envelope("response.error", 1),
        error: {
          category: "internal",
          code: "internal_error",
          message: "x".repeat(AI_RUNTIME_PROTOCOL_LIMITS.errorMessageLength + 1),
          retryable: false,
        },
      }),
    ).toThrow(/at most/);
  });

  it("accepts authoritative attribution only on response.started", () => {
    expect(parseStreamEvent(started())).toEqual(started());
    expect(() => parseChatRequest({ ...request(), attribution: attribution() })).toThrow();

    const forged = started();
    forged.attribution.organization.source = "client";
    expect(() => parseStreamEvent(forged)).toThrow(/server_derived/);
  });

  it("preserves safe event metadata and rejects provider-native metadata", () => {
    const metadata = { delivery: { attempt: 2 }, input_tokens: 203 };
    const event = { ...envelope("response.text.delta", 1), delta: "hello", metadata };
    expect(parseStreamEvent(event)).toBe(event);
    expect(parseStreamEvent(event).metadata).toBe(metadata);

    expect(() =>
      parseStreamEvent({
        ...envelope("response.text.delta", 1),
        delta: "hello",
        metadata: { anthropic: { content_block_delta: {} } },
      }),
    ).toThrow(/forbidden/);
  });

  it("validates normative ordering, identifiers, terminality, and cumulative usage", () => {
    const valid = [
      started(),
      { ...envelope("response.text.delta", 1), delta: "Order A-104 " },
      {
        ...envelope("response.usage", 2),
        usage: { input_tokens: 200, output_tokens: 4, total_tokens: 204 },
      },
      { ...envelope("response.text.delta", 3), delta: "is out for delivery." },
      {
        ...envelope("response.usage", 4),
        usage: { input_tokens: 203, output_tokens: 11, total_tokens: 214 },
      },
      { ...envelope("response.completed", 5), outcome: "stop" },
    ];
    expect(parseStreamEvents(valid)).toBe(valid);

    const decreasing = structuredClone(valid);
    (decreasing[4] as { usage: { output_tokens: number } }).usage.output_tokens = 3;
    expect(() => parseStreamEvents(decreasing)).toThrow(/must not decrease/);

    expect(() => parseStreamEvents(valid.slice(0, -1))).toThrow(/terminal/);
    expect(() =>
      parseStreamEvents([
        started(),
        { ...envelope("response.completed", 1), outcome: "stop" },
        { ...envelope("response.text.delta", 2), delta: "too late" },
      ]),
    ).toThrow(/terminal event must be last/);
  });
});
