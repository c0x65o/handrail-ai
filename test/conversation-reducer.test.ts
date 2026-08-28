import { describe, expect, it } from "vitest";

import {
  CONVERSATION_EVENT_VERSION,
  createInitialConversationState,
  parseConversationEvent,
  reduceConversationEvent,
  type ConversationEvent,
  type ConversationState,
} from "../src/index.js";

type Fixture = Record<string, unknown>;

interface EventOptions {
  readonly eventId?: string;
  readonly revision: number;
  readonly payload: Fixture;
  readonly mutationId?: string;
  readonly conversationId?: string;
}

function event(options: EventOptions): ConversationEvent {
  return parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: options.eventId ?? `evt_${options.revision}`,
    conversation_id: options.conversationId ?? "conversation_01",
    revision: options.revision,
    occurred_at: `2026-08-27T12:00:${String(options.revision).padStart(2, "0")}.000Z`,
    actor: { type: options.mutationId === undefined ? "assistant" : "user" },
    source:
      options.mutationId === undefined
        ? { type: "runtime" }
        : { type: "client", client_id: "client_01" },
    ...(options.mutationId === undefined
      ? {}
      : { mutation_id: options.mutationId }),
    payload: options.payload,
  });
}

function replay(
  events: readonly ConversationEvent[],
  initial: ConversationState = createInitialConversationState(),
): ConversationState {
  return events.reduce(reduceConversationEvent, initial);
}

const textTurn = [
  event({
    revision: 1,
    mutationId: "mutation_01",
    payload: {
      type: "message.created",
      message_id: "message_user",
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    },
  }),
  event({
    revision: 2,
    payload: {
      type: "turn.started",
      turn_id: "turn_01",
      input_message_ids: ["message_user"],
    },
  }),
  event({
    revision: 3,
    payload: {
      type: "turn.status_changed",
      turn_id: "turn_01",
      status: "running",
    },
  }),
  event({
    revision: 4,
    payload: {
      type: "message.created",
      message_id: "message_assistant",
      role: "assistant",
      content: [{ type: "text", text: "Hi there" }],
    },
  }),
  event({
    revision: 5,
    payload: {
      type: "turn.completed",
      turn_id: "turn_01",
      outcome: "stop",
      output_message_ids: ["message_assistant"],
    },
  }),
] as const;

describe("reduceConversationEvent", () => {
  it("replays a text turn into stable message and terminal turn records", () => {
    const state = replay(textTurn);

    expect(state.conversation_id).toBe("conversation_01");
    expect(state.revision).toBe(5);
    expect(state.messages.map(({ message_id }) => message_id)).toEqual([
      "message_user",
      "message_assistant",
    ]);
    expect(state.messages[1]?.content).toEqual([
      { type: "text", text: "Hi there" },
    ]);
    expect(state.turns[0]).toMatchObject({
      turn_id: "turn_01",
      status: "completed",
      outcome: "stop",
      input_message_ids: ["message_user"],
      output_message_ids: ["message_assistant"],
    });
    expect(state.active_turn_id).toBeNull();
    expect(state.replay_error).toBeNull();
  });

  const projections = [
    {
      name: "tool continuation",
      events: [
        event({
          revision: 1,
          payload: {
            type: "turn.started",
            turn_id: "turn_tool",
            input_message_ids: ["message_tool_input"],
          },
        }),
        event({
          revision: 2,
          payload: {
            type: "tool_call.requested",
            turn_id: "turn_tool",
            tool_call_id: "call_01",
            name: "lookup",
            arguments: { query: "order" },
          },
        }),
        event({
          revision: 3,
          payload: {
            type: "turn.status_changed",
            turn_id: "turn_tool",
            status: "waiting_for_tool_result",
          },
        }),
        event({
          revision: 4,
          payload: {
            type: "tool_call.result_recorded",
            turn_id: "turn_tool",
            tool_call_id: "call_01",
            content: [{ type: "json", value: { found: true } }],
            is_error: false,
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.turns[0]?.status).toBe("waiting_for_tool_result");
        expect(state.tool_calls[0]).toMatchObject({
          tool_call_id: "call_01",
          name: "lookup",
          arguments: { query: "order" },
          result: { content: [{ type: "json", value: { found: true } }] },
        });
      },
    },
    {
      name: "attachment-bearing message",
      events: [
        event({
          revision: 1,
          payload: {
            type: "message.created",
            message_id: "message_image",
            role: "user",
            content: [{ type: "text", text: "What is this?" }],
          },
        }),
        event({
          revision: 2,
          payload: {
            type: "message.attachment_referenced",
            message_id: "message_image",
            attachment: {
              attachment_id: "attachment_01",
              media_type: "image/png",
              filename: "photo.png",
              size_bytes: 42,
            },
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.messages[0]?.attachments).toHaveLength(1);
        expect(state.attachments[0]).toMatchObject({
          message_id: "message_image",
          attachment_id: "attachment_01",
          reference: { filename: "photo.png", size_bytes: 42 },
        });
      },
    },
    {
      name: "cancellation",
      events: [
        event({
          revision: 1,
          payload: {
            type: "turn.started",
            turn_id: "turn_cancelled",
            input_message_ids: ["message_cancel_input"],
          },
        }),
        event({
          revision: 2,
          payload: {
            type: "turn.cancelled",
            turn_id: "turn_cancelled",
            reason: "user",
          },
        }),
        event({
          revision: 3,
          payload: {
            type: "turn.status_changed",
            turn_id: "turn_cancelled",
            status: "running",
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.turns[0]).toMatchObject({
          status: "cancelled",
          cancellation_reason: "user",
        });
        expect(state.revision).toBe(3);
      },
    },
    {
      name: "retryable failure",
      events: [
        event({
          revision: 1,
          payload: {
            type: "turn.failed",
            turn_id: "turn_failed",
            error: {
              code: "upstream_unavailable",
              message: "Try again later.",
              retryable: true,
            },
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.turns[0]).toMatchObject({
          status: "failed",
          error: { code: "upstream_unavailable", retryable: true },
        });
      },
    },
    {
      name: "usage receipt link",
      events: [
        event({
          revision: 1,
          payload: {
            type: "usage.receipt_linked",
            turn_id: "turn_usage",
            usage_receipt_id: "usage_01",
          },
        }),
      ],
      assert: (state: ConversationState) => {
        expect(state.usage_receipt_links).toMatchObject([
          { turn_id: "turn_usage", usage_receipt_id: "usage_01" },
        ]);
        expect(state.usage_receipt_links[0]).not.toHaveProperty("tokens");
      },
    },
  ] as const;

  for (const projection of projections) {
    it(`projects ${projection.name}`, () => {
      projection.assert(replay(projection.events));
    });
  }

  it("makes duplicate identities and whole-log replay byte-equivalent no-ops", () => {
    const once = replay(textTurn);
    const duplicateEvent = reduceConversationEvent(once, textTurn[0]);
    const twice = replay(textTurn, once);

    expect(duplicateEvent).toBe(once);
    expect(twice).toBe(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));

    const firstMutation = event({
      eventId: "evt_original_mutation",
      revision: 1,
      mutationId: "mutation_stable",
      payload: {
        type: "message.created",
        message_id: "message_mutation",
        role: "user",
        content: [{ type: "text", text: "Once" }],
      },
    });
    const regenerated = event({
      eventId: "evt_regenerated_mutation",
      revision: 1,
      mutationId: "mutation_stable",
      payload: {
        type: "message.created",
        message_id: "message_mutation",
        role: "user",
        content: [{ type: "text", text: "Once" }],
      },
    });
    const mutationState = reduceConversationEvent(
      reduceConversationEvent(createInitialConversationState(), firstMutation),
      regenerated,
    );
    expect(mutationState.processed_event_ids).toEqual(["evt_original_mutation"]);
    expect(mutationState.messages).toHaveLength(1);
  });

  it("preserves first-seen message, attachment, tool, and receipt ordering", () => {
    const state = replay([
      event({
        revision: 1,
        payload: {
          type: "message.attachment_referenced",
          message_id: "message_first",
          attachment: {
            attachment_id: "attachment_first",
            media_type: "image/png",
          },
        },
      }),
      event({
        revision: 2,
        payload: {
          type: "message.created",
          message_id: "message_second",
          role: "assistant",
          content: [{ type: "text", text: "Second" }],
        },
      }),
      event({
        revision: 3,
        payload: {
          type: "message.created",
          message_id: "message_first",
          role: "user",
          content: [{ type: "text", text: "First" }],
        },
      }),
    ]);

    expect(state.messages.map(({ message_id }) => message_id)).toEqual([
      "message_first",
      "message_second",
    ]);
    expect(state.messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "First" }],
      attachments: [{ attachment_id: "attachment_first" }],
    });
  });

  it("surfaces revision gaps and stale revisions without partially applying them", () => {
    const missingFirst = event({
      eventId: "evt_gap",
      revision: 2,
      payload: { type: "conversation.title_updated", title: "Must not apply" },
    });
    const gap = reduceConversationEvent(
      createInitialConversationState(),
      missingFirst,
    );

    expect(gap).toMatchObject({
      conversation_id: null,
      revision: null,
      title: null,
      processed_event_ids: [],
      replay_error: {
        type: "revision_gap",
        expected_revision: 1,
        received_revision: 2,
      },
    });

    const recovered = reduceConversationEvent(
      gap,
      event({
        eventId: "evt_first",
        revision: 1,
        payload: { type: "conversation.title_updated", title: "Accepted" },
      }),
    );
    expect(recovered.replay_error).toBeNull();
    expect(recovered.title).toBe("Accepted");

    const stale = reduceConversationEvent(
      recovered,
      event({
        eventId: "evt_stale",
        revision: 1,
        payload: { type: "conversation.title_updated", title: "Must not replace" },
      }),
    );
    expect(stale.title).toBe("Accepted");
    expect(stale.revision).toBe(1);
    expect(stale.replay_error?.type).toBe("stale_revision");
  });

  it("deeply detaches projected JSON data from mutable event inputs", () => {
    const source = {
      type: "tool_call.requested" as const,
      turn_id: "turn_clone",
      tool_call_id: "call_clone",
      name: "clone",
      arguments: { nested: { value: "original" } },
    };
    const input = event({ revision: 1, payload: source });
    const state = reduceConversationEvent(createInitialConversationState(), input);

    source.arguments.nested.value = "mutated";
    expect(state.tool_calls[0]?.arguments).toEqual({
      nested: { value: "original" },
    });
    expect(Object.isFrozen(state.tool_calls[0]?.arguments)).toBe(true);
  });
});
