import { describe, expect, it } from "vitest";

import {
  CONVERSATION_EVENT_LIMITS,
  CONVERSATION_EVENT_TYPES,
  CONVERSATION_EVENT_VERSION,
  ConversationEventValidationError,
  isConversationEvent,
  parseConversationEvent,
} from "../src/index.js";

type Fixture = Record<string, unknown>;

const payloads: Fixture[] = [
  {
    type: "message.created",
    message_id: "msg_01",
    role: "user",
    content: [{ type: "text", text: "Where is my order?" }],
  },
  {
    type: "message.attachment_referenced",
    message_id: "msg_01",
    attachment: {
      attachment_id: "att_01",
      media_type: "image/png",
      filename: "order.png",
      size_bytes: 2_048,
    },
  },
  {
    type: "turn.started",
    turn_id: "turn_01",
    input_message_ids: ["msg_01"],
  },
  {
    type: "turn.status_changed",
    turn_id: "turn_01",
    status: "waiting_for_tool_result",
  },
  {
    type: "turn.attempt_started",
    turn_id: "turn_01",
    attempt: 1,
    operation: "start",
  },
  {
    type: "turn.retry_scheduled",
    turn_id: "turn_01",
    attempt: 1,
    reason_category: "unavailable",
    delay_ms: 250,
  },
  {
    type: "turn.retry_exhausted",
    turn_id: "turn_01",
    attempt: 3,
    reason_category: "unavailable",
    exhaustion_reason: "maximum_attempts",
  },
  {
    type: "turn.cancellation_requested",
    turn_id: "turn_01",
    reason: "user",
  },
  {
    type: "turn.cancellation_unsupported",
    turn_id: "turn_01",
    reason: "user",
  },
  {
    type: "turn.completed",
    turn_id: "turn_01",
    outcome: "stop",
    output_message_ids: ["msg_02"],
  },
  {
    type: "turn.cancelled",
    turn_id: "turn_01",
    reason: "user",
  },
  {
    type: "turn.failed",
    turn_id: "turn_01",
    error: {
      code: "runtime_unavailable",
      message: "The runtime is temporarily unavailable.",
      retryable: true,
    },
  },
  {
    type: "tool_call.requested",
    turn_id: "turn_01",
    tool_call_id: "call_01",
    name: "lookup_order",
    arguments: { order_id: "A-104" },
  },
  {
    type: "tool_call.result_recorded",
    turn_id: "turn_01",
    tool_call_id: "call_01",
    content: [
      {
        type: "json",
        value: { order_id: "A-104", status: "out_for_delivery" },
      },
    ],
    is_error: false,
  },
  {
    type: "usage.receipt_linked",
    turn_id: "turn_01",
    usage_receipt_id: "usage_01",
  },
  {
    type: "conversation.metadata_updated",
    metadata: { feature: "order_support", experiment: { cohort: "b" } },
  },
  {
    type: "conversation.title_updated",
    title: "Order support",
  },
];

const event = (payload: Fixture = payloads[0]!): Fixture => ({
  version: CONVERSATION_EVENT_VERSION,
  event_id: "evt_01",
  conversation_id: "conversation_01",
  revision: 1,
  occurred_at: "2026-08-27T12:34:56.789Z",
  actor: { type: "user", id: "user_01" },
  source: {
    type: "client",
    client_id: "client_01",
    device_id: "device_01",
  },
  mutation_id: "mutation_01",
  metadata: { feature: "support" },
  payload,
});

const without = (fixture: Fixture, key: string): Fixture =>
  Object.fromEntries(Object.entries(fixture).filter(([name]) => name !== key));

describe("durable conversation event contract", () => {
  it("round-trips every exported event discriminator without mutation", () => {
    expect(payloads.map((payload) => payload.type)).toEqual(
      CONVERSATION_EVENT_TYPES,
    );

    for (const [index, payload] of payloads.entries()) {
      const fixture = {
        ...event(payload),
        event_id: `evt_${index + 1}`,
        revision: index + 1,
      };

      expect(parseConversationEvent(fixture)).toBe(fixture);
      expect(isConversationEvent(fixture)).toBe(true);
    }
  });

  it("rejects unknown envelope and discriminator-specific payload fields", () => {
    expect(() =>
      parseConversationEvent({ ...event(), future_envelope_field: true }),
    ).toThrow(/future_envelope_field.*not a supported field/);

    for (const payload of payloads) {
      expect(() =>
        parseConversationEvent(event({ ...payload, future_payload_field: true })),
      ).toThrow(/future_payload_field.*not a supported field/);
    }

    const attachmentPayload = payloads[1]!;
    parseConversationEvent(event(attachmentPayload));
    expect(() =>
      parseConversationEvent(
        event({
          ...attachmentPayload,
          attachment: {
            ...(attachmentPayload.attachment as Fixture),
            remote_url: "https://example.invalid/native-reference",
          },
        }),
      ),
    ).toThrow(/remote_url.*not a supported field/);
  });

  it("requires non-empty event and conversation identifiers and a revision", () => {
    for (const key of ["event_id", "conversation_id", "revision"] as const) {
      expect(() => parseConversationEvent(without(event(), key))).toThrow(
        new RegExp(`${key}.*required`),
      );
    }

    for (const key of ["event_id", "conversation_id"] as const) {
      expect(() => parseConversationEvent({ ...event(), [key]: "" })).toThrow(
        new RegExp(`${key}.*must not be empty`),
      );
    }
  });

  it("rejects unsupported versions and malformed revisions", () => {
    for (const version of [0, 2, "1", null]) {
      expect(() => parseConversationEvent({ ...event(), version })).toThrow(
        /version/,
      );
    }

    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(() => parseConversationEvent({ ...event(), revision })).toThrow(
        /positive safe integer monotonic revision/,
      );
    }

    expect(parseConversationEvent({
      ...event(),
      revision: Number.MAX_SAFE_INTEGER,
    })).toBeTypeOf("object");
  });

  it("accepts strict UTC timestamps and rejects malformed timestamps", () => {
    const accepted = [
      "2026-08-27T12:34:56Z",
      "2026-08-27T12:34:56.1Z",
      "2024-02-29T23:59:59.123456789Z",
    ];
    for (const occurred_at of accepted) {
      expect(parseConversationEvent({ ...event(), occurred_at })).toBeTypeOf(
        "object",
      );
    }

    const rejected = [
      "",
      "2026-08-27",
      "2026-08-27T12:34:56",
      "2026-08-27T12:34:56+00:00",
      "2026-02-30T12:34:56Z",
      "2026-13-01T12:34:56Z",
      "not-a-date",
      1_777_777,
    ];
    for (const occurred_at of rejected) {
      expect(() => parseConversationEvent({ ...event(), occurred_at })).toThrow(
        /occurred_at/,
      );
    }
  });

  it("enforces source identity and client mutation semantics", () => {
    expect(() =>
      parseConversationEvent({
        ...event(),
        source: { type: "client", client_id: "" },
      }),
    ).toThrow(/client_id.*must not be empty/);
    expect(() =>
      parseConversationEvent({ ...event(), source: { type: "runtime" } }),
    ).toThrow(/mutation_id.*source type is client/);

    const runtimeEvent = without(event(), "mutation_id");
    runtimeEvent.source = { type: "runtime" };
    expect(parseConversationEvent(runtimeEvent)).toBe(runtimeEvent);
  });

  it("accepts bounded JSON-safe metadata without cloning it", () => {
    const metadata = {
      feature: "support",
      flags: [true, false],
      measurements: { latency_ms: 12.5, cache_hit: null },
    };
    const fixture = { ...event(), metadata };

    const parsed = parseConversationEvent(fixture);
    expect(parsed).toBe(fixture);
    expect(parsed.metadata).toBe(metadata);
  });

  it("rejects circular, non-JSON, credential, and provider-native metadata", () => {
    const circular: Fixture = {};
    circular.self = circular;

    const rejectedMetadata = [
      circular,
      { value: undefined },
      { value: 1n },
      { value: Number.NaN },
      { value: new Date() },
      { api_key: "redacted" },
      { nested: { authorization: "redacted" } },
      { provider_payload: { chunk: "opaque" } },
      { backend: "openai" },
      { note: "Bearer abcdefghijk" },
    ];

    for (const metadata of rejectedMetadata) {
      expect(() => parseConversationEvent({ ...event(), metadata })).toThrow(
        ConversationEventValidationError,
      );
      expect(isConversationEvent({ ...event(), metadata })).toBe(false);
    }
  });

  it("bounds metadata depth, string length, and serialized UTF-8 bytes", () => {
    let nested: Fixture = { value: true };
    for (
      let index = 0;
      index <= CONVERSATION_EVENT_LIMITS.metadataDepth;
      index += 1
    ) {
      nested = { nested };
    }
    expect(() => parseConversationEvent({ ...event(), metadata: nested })).toThrow(
      /depth/,
    );

    expect(() =>
      parseConversationEvent({
        ...event(),
        metadata: {
          value: "x".repeat(
            CONVERSATION_EVENT_LIMITS.metadataStringLength + 1,
          ),
        },
      }),
    ).toThrow(/at most 4096 characters/);

    expect(() =>
      parseConversationEvent({
        ...event(),
        metadata: {
          one: "😀".repeat(2_000),
          two: "😀".repeat(2_000),
          three: "😀".repeat(2_000),
        },
      }),
    ).toThrow(/serialize to at most 16384 bytes/);
  });

  it("rejects presence and typing because they are ephemeral", () => {
    for (const type of ["presence.updated", "typing.started", "typing.stopped"]) {
      expect(() => parseConversationEvent(event({ type }))).toThrow(
        /not a supported durable event discriminator/,
      );
    }

    expect(() =>
      parseConversationEvent({ ...event(), typing: { active: true } }),
    ).toThrow(/typing.*not a supported field/);
    expect(() =>
      parseConversationEvent({ ...event(), presence: { status: "online" } }),
    ).toThrow(/presence.*not a supported field/);
  });
});
