import { describe, expect, it } from "vitest";

import {
  CITATION_LIMITS,
  CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
  CONVERSATION_CITATION_RECORDS_VERSION,
  CONVERSATION_EVENT_VERSION,
  ConversationEventValidationError,
  InMemoryConversationEventStore,
  createInitialConversationState,
  isConversationState,
  parseConversationEvent,
  reduceConversationEvent,
  replayConversation,
  type ConversationEvent,
  type ConversationId,
  type ConversationJsonValue,
  type ConversationState,
} from "../src/index.js";

type Fixture = Record<string, unknown>;

const conversationId = "conversation-citations" as ConversationId;

function event(revision: number, payload: Fixture): ConversationEvent {
  return parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: `citation-event-${revision}`,
    conversation_id: conversationId,
    revision,
    occurred_at: `2026-08-29T12:00:${String(revision).padStart(2, "0")}Z`,
    actor: { type: "assistant" },
    source: { type: "runtime" },
    payload,
  });
}

function citationPayload(
  target: Fixture = { type: "assistant_message", message_id: "message-cited" },
  overrides: Partial<Fixture> = {},
): Fixture {
  const nestedTarget = target.type === "tool_result"
    ? { type: "tool_result", tool_call_id: target.tool_call_id }
    : { type: "assistant_message", message_id: target.message_id };
  return {
    type: "citation.records_linked",
    citation_records_version: CONVERSATION_CITATION_RECORDS_VERSION,
    target,
    sources: [
      {
        source_id: "source-handbook",
        type: "web",
        label: "Handbook",
        locator: "https://example.com/handbook",
      },
    ],
    citations: [
      {
        citation_id: "citation-handbook",
        source_id: "source-handbook",
        order: 0,
        target: nestedTarget,
      },
    ],
    ...overrides,
  };
}

function replay(events: readonly ConversationEvent[]): ConversationState {
  return events.reduce(reduceConversationEvent, createInitialConversationState());
}

describe("durable conversation citations", () => {
  it("parses versioned assistant-message and tool-result links", () => {
    const assistant = event(1, citationPayload());
    const tool = event(2, citationPayload({
      type: "tool_result",
      turn_id: "turn-cited",
      tool_call_id: "call-cited",
    }, {
      sources: [{
        source_id: "source-tool",
        type: "tool",
        label: "Catalog lookup",
        locator: "catalog/result-42",
      }],
      citations: [{
        citation_id: "citation-tool",
        source_id: "source-tool",
        order: 1,
        target: { type: "tool_result", tool_call_id: "call-cited" },
      }],
    }));

    expect(assistant.payload.type).toBe("citation.records_linked");
    expect(tool.payload).toMatchObject({
      target: {
        type: "tool_result",
        turn_id: "turn-cited",
        tool_call_id: "call-cited",
      },
    });
  });

  it("rejects unsafe, oversized, unknown, provider-native, and mismatched records", () => {
    const invalidPayloads = [
      citationPayload(undefined, {
        sources: [{
          source_id: "source-handbook",
          type: "web",
          label: "Private service",
          locator: "http://127.0.0.1/private",
        }],
      }),
      citationPayload(undefined, {
        sources: Array.from(
          { length: CITATION_LIMITS.sourcesPerRecordSet + 1 },
          (_, index) => ({
            source_id: `source-${index}`,
            type: "document",
            label: `Source ${index}`,
          }),
        ),
      }),
      citationPayload(undefined, {
        sources: [{
          source_id: "source-handbook",
          type: "web",
          label: "Handbook",
          provider_payload: { native: true },
        }],
      }),
      citationPayload(undefined, {
        citations: [{
          citation_id: "citation-handbook",
          source_id: "source-handbook",
          order: 0,
          target: { type: "assistant_message", message_id: "another-message" },
        }],
      }),
      citationPayload(undefined, {
        sources: [
          { source_id: "source-handbook", type: "web", label: "Handbook" },
          { source_id: "source-handbook", type: "web", label: "Conflict" },
        ],
      }),
    ];

    for (const [index, payload] of invalidPayloads.entries()) {
      expect(
        () => event(index + 1, payload),
        `invalid payload ${index}`,
      ).toThrow(ConversationEventValidationError);
    }
  });

  it("links citations to actual assistant messages and tool results", () => {
    const state = replay([
      event(1, {
        type: "message.created",
        message_id: "message-cited",
        role: "assistant",
        content: [{ type: "text", text: "According to the handbook" }],
      }),
      event(2, citationPayload()),
      event(3, {
        type: "tool_call.result_recorded",
        turn_id: "turn-cited",
        tool_call_id: "call-cited",
        content: [{ type: "text", text: "Found" }],
        is_error: false,
      }),
      event(4, citationPayload({
        type: "tool_result",
        turn_id: "turn-cited",
        tool_call_id: "call-cited",
      }, {
        sources: [{
          source_id: "source-tool",
          type: "tool",
          label: "Lookup result",
        }],
        citations: [{
          citation_id: "citation-tool",
          source_id: "source-tool",
          order: 1,
          target: { type: "tool_result", tool_call_id: "call-cited" },
        }],
      })),
    ]);

    expect(state.citation_sources.map((source) => source.source_id)).toEqual([
      "source-handbook",
      "source-tool",
    ]);
    expect(state.citations.map((citation) => citation.target)).toEqual([
      { type: "assistant_message", message_id: "message-cited" },
      { type: "tool_result", tool_call_id: "call-cited" },
    ]);
    expect(state.tool_calls[0]?.result?.content).toEqual([
      { type: "text", text: "Found" },
    ]);
  });

  it("handles duplicate, conflicting, and out-of-order links deterministically", () => {
    const first = event(1, citationPayload());
    const duplicate = event(2, citationPayload());
    const sourceConflict = event(3, citationPayload(undefined, {
      sources: [{
        source_id: "source-handbook",
        type: "web",
        label: "Conflicting handbook",
      }],
    }));
    const citationConflict = event(4, citationPayload(undefined, {
      citations: [{
        citation_id: "citation-handbook",
        source_id: "source-handbook",
        order: 99,
        target: { type: "assistant_message", message_id: "message-cited" },
      }],
    }));
    const resolved = event(5, {
      type: "message.created",
      message_id: "message-cited",
      role: "assistant",
      content: [{ type: "text", text: "Resolved later" }],
    });

    const pending = replay([first]);
    expect(pending.messages[0]).toMatchObject({
      message_id: "message-cited",
      role: null,
    });
    const state = replay([first, duplicate, sourceConflict, citationConflict, resolved]);
    expect(state.citation_sources).toHaveLength(1);
    expect(state.citation_sources[0]?.label).toBe("Handbook");
    expect(state.citations).toHaveLength(1);
    expect(state.citations[0]?.order).toBe(0);
    expect(state.messages[0]?.role).toBe("assistant");
    expect(state.revision).toBe(5);
  });

  it("uses safe placeholders and excludes contradictory targets", () => {
    const wrongRole = replay([
      event(1, citationPayload()),
      event(2, {
        type: "message.created",
        message_id: "message-cited",
        role: "user",
        content: [{ type: "text", text: "Not an assistant answer" }],
      }),
    ]);
    expect(wrongRole.citations).toEqual([]);
    expect(wrongRole.citation_sources).toHaveLength(1);

    const pendingTool = replay([event(1, citationPayload({
      type: "tool_result",
      turn_id: "turn-cited",
      tool_call_id: "call-cited",
    }))]);
    expect(pendingTool.tool_calls[0]).toMatchObject({
      tool_call_id: "call-cited",
      turn_id: "turn-cited",
      result: null,
    });
    expect(isConversationState(
      JSON.parse(JSON.stringify(pendingTool)),
      conversationId,
      pendingTool.revision,
    )).toBe(true);

    const mismatchedTool = replay([
      event(1, {
        type: "tool_call.result_recorded",
        turn_id: "turn-existing",
        tool_call_id: "call-cited",
        content: [{ type: "text", text: "Existing" }],
        is_error: false,
      }),
      event(2, citationPayload({
        type: "tool_result",
        turn_id: "turn-mismatch",
        tool_call_id: "call-cited",
      })),
    ]);
    expect(mismatchedTool.citations).toEqual([]);
    expect(mismatchedTool.citation_sources).toEqual([]);
  });

  it("defensively clones and deeply freezes citation projections", () => {
    const source: Fixture = {
      source_id: "source-handbook",
      type: "web",
      label: "Handbook",
      locator: "https://example.com/handbook",
    };
    const nestedTarget: Fixture = {
      type: "assistant_message",
      message_id: "message-cited",
    };
    const citation: Fixture = {
      citation_id: "citation-handbook",
      source_id: "source-handbook",
      order: 0,
      target: nestedTarget,
    };
    const sources = [source];
    const citations = [citation];
    const state = replay([event(1, citationPayload(undefined, { sources, citations }))]);

    source.label = "mutated";
    nestedTarget.message_id = "mutated";
    sources.push({});
    citations.push({});

    expect(state.citation_sources[0]?.label).toBe("Handbook");
    expect(state.citations[0]?.target).toEqual({
      type: "assistant_message",
      message_id: "message-cited",
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.citation_sources)).toBe(true);
    expect(Object.isFrozen(state.citation_sources[0])).toBe(true);
    expect(Object.isFrozen(state.citations)).toBe(true);
    expect(Object.isFrozen(state.citations[0])).toBe(true);
    expect(Object.isFrozen(state.citations[0]?.target)).toBe(true);
  });

  it("replays historical logs and rejects version-2 checkpoints after the shape change", async () => {
    const events = [
      event(1, {
        type: "message.created",
        message_id: "historical-message",
        role: "assistant",
        content: [{ type: "text", text: "Historical v1 event" }],
      }),
      event(2, citationPayload(undefined, {
        citations: [{
          citation_id: "citation-handbook",
          source_id: "source-handbook",
          order: 0,
          target: {
            type: "assistant_message",
            message_id: "historical-message",
          },
        }],
        target: { type: "assistant_message", message_id: "historical-message" },
      })),
    ];
    const expected = replay(events);
    const eventStore = new InMemoryConversationEventStore();
    await eventStore.append({
      conversationId,
      expectedRevision: null,
      events,
    });
    const legacyState = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
    delete legacyState.citation_sources;
    delete legacyState.citations;
    await eventStore.checkpoints.write({
      conversationId,
      schemaVersion: 2,
      revision: expected.revision!,
      state: legacyState as ConversationJsonValue,
    });

    const result = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: false,
    });

    expect(CONVERSATION_CHECKPOINT_SCHEMA_VERSION).toBe(3);
    expect(result.checkpointStatus).toBe("invalid");
    expect(result.replayedEventCount).toBe(events.length);
    expect(result.state).toEqual(expected);
  });

  it("round-trips equivalent deeply frozen state through a version-3 checkpoint", async () => {
    const events = [
      event(1, citationPayload()),
      event(2, {
        type: "message.created",
        message_id: "message-cited",
        role: "assistant",
        content: [{ type: "text", text: "Restart-safe" }],
      }),
    ];
    const eventStore = new InMemoryConversationEventStore();
    await eventStore.append({
      conversationId,
      expectedRevision: null,
      events,
    });
    const initial = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: { eventCount: 1 },
    });
    initial.store.destroy();
    const restarted = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: false,
    });

    expect(initial.checkpointWrite?.status).toBe("written");
    expect(restarted.checkpointStatus).toBe("used");
    expect(restarted.replayedEventCount).toBe(0);
    expect(restarted.state).toEqual(initial.state);
    expect(Object.isFrozen(restarted.state)).toBe(true);
    expect(Object.isFrozen(restarted.state.citations)).toBe(true);
    expect(Object.isFrozen(restarted.state.citations[0]?.target)).toBe(true);
    restarted.store.destroy();
  });
});
