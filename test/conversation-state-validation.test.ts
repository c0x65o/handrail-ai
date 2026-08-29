import { describe, expect, it } from "vitest";

import { AI_RUNTIME_PROTOCOL_LIMITS } from "../src/protocol.js";
import {
  CONVERSATION_EVENT_VERSION,
  parseConversationEvent,
  type ConversationEvent,
  type ConversationId,
  type ConversationJsonValue,
} from "../src/conversation/events.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { reduceConversationEvent } from "../src/conversation/reducer.js";
import {
  CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
  replayConversation,
} from "../src/conversation/replay.js";
import { isConversationState } from "../src/conversation/state-validation.js";
import {
  createInitialConversationState,
  type ConversationState,
} from "../src/conversation/state.js";

const conversationId = "conversation-state-validation" as ConversationId;

function event(
  revision: number,
  payload: Record<string, unknown>,
): ConversationEvent {
  return parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: `event-${revision}`,
    conversation_id: conversationId,
    revision,
    occurred_at: `2026-08-28T12:00:0${revision}Z`,
    actor: { type: String(payload.type).startsWith("message.") ? "assistant" : "system" },
    source: { type: "runtime" },
    payload,
  });
}

function projectedState(): {
  readonly events: readonly ConversationEvent[];
  readonly state: ConversationState;
} {
  const events = [
    event(1, {
      type: "message.created",
      message_id: "message-user",
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    }),
    event(2, {
      type: "turn.started",
      turn_id: "turn-current",
      input_message_ids: ["message-user"],
    }),
    event(3, {
      type: "turn.attempt_started",
      turn_id: "turn-current",
      attempt: 1,
      operation: "start",
    }),
    event(4, {
      type: "turn.retry_scheduled",
      turn_id: "turn-current",
      attempt: 1,
      reason_category: "rate_limit",
      delay_ms: 250,
    }),
    event(5, {
      type: "turn.attempt_started",
      turn_id: "turn-current",
      attempt: 2,
      operation: "resume",
    }),
    event(6, {
      type: "turn.retry_exhausted",
      turn_id: "turn-current",
      attempt: 2,
      reason_category: "timeout",
      exhaustion_reason: "maximum_attempts",
    }),
    event(7, {
      type: "turn.cancellation_requested",
      turn_id: "turn-current",
      reason: "user",
    }),
    event(8, {
      type: "message.text_appended",
      turn_id: "turn-current",
      message_id: "message-assistant",
      text: "Partial response",
    }),
    event(9, {
      type: "turn.cancelled",
      turn_id: "turn-current",
      reason: "user",
    }),
  ] as const;
  return {
    events,
    state: events.reduce(
      reduceConversationEvent,
      createInitialConversationState(conversationId),
    ),
  };
}

function projectedApprovalState(): {
  readonly events: readonly ConversationEvent[];
  readonly state: ConversationState;
} {
  const events = [
    event(1, {
      type: "tool_call.requested",
      turn_id: "turn-approval",
      tool_call_id: "call-approval",
      name: "send_update",
      arguments: { destination: "account-owner" },
    }),
    event(2, {
      type: "approval.proposal_created",
      proposal_id: "proposal-validation",
      group_id: "group-validation",
      turn_id: "turn-approval",
      tool_call_id: "call-approval",
      tool_name: "send_update",
      status: "pending",
      proposal_version: 1,
      expires_at: "2026-08-28T13:00:00Z",
      reviewed_arguments: {
        type: "redacted_json",
        value: { destination: "account owner" },
      },
    }),
    event(3, {
      type: "approval.proposal_status_changed",
      proposal_id: "proposal-validation",
      proposal_version: 2,
      status: "confirmed",
      decision_reason: "Host policy confirmed the reviewed decision",
    }),
    event(4, {
      type: "approval.proposal_status_changed",
      proposal_id: "proposal-validation",
      proposal_version: 3,
      status: "executing",
    }),
    event(5, {
      type: "approval.proposal_status_changed",
      proposal_id: "proposal-validation",
      proposal_version: 4,
      status: "failed",
      failure_reason: "Bounded public failure",
    }),
  ] as const;
  return {
    events,
    state: events.reduce(
      reduceConversationEvent,
      createInitialConversationState(conversationId),
    ),
  };
}

function projectedAttachmentState(): {
  readonly events: readonly ConversationEvent[];
  readonly state: ConversationState;
} {
  const events = [
    event(1, {
      type: "message.created",
      message_id: "message-attachments",
      role: "user",
      content: [{ type: "text", text: "Review these" }],
    }),
    event(2, {
      type: "message.attachment_referenced",
      message_id: "message-attachments",
      attachment: {
        attachment_id: "att_legacy_image",
        media_type: "image/png",
      },
    }),
    event(3, {
      type: "message.attachment_referenced",
      message_id: "message-attachments",
      attachment: {
        attachment_id: "att_pdf_checkpoint",
        kind: "document",
        media_type: "application/pdf",
        filename: "checkpoint.pdf",
        size_bytes: 2_048,
      },
    }),
  ] as const;
  return {
    events,
    state: events.reduce(
      reduceConversationEvent,
      createInitialConversationState(conversationId),
    ),
  };
}

function withTurnFields(overrides: Record<string, unknown>): unknown {
  const { state } = projectedState();
  return {
    ...state,
    turns: [{ ...state.turns[0], ...overrides }],
  };
}

function withRetryRecord(
  index: number,
  transform: (record: Record<string, unknown>) => Record<string, unknown>,
): unknown {
  const { state } = projectedState();
  const retryHistory = state.turns[0]!.retry_history.map((record, recordIndex) =>
    recordIndex === index
      ? transform({ ...record })
      : record
  );
  return withTurnFields({ retry_history: retryHistory });
}

describe("isConversationState", () => {
  it("accepts an initial conversation state", () => {
    expect(
      isConversationState(
        createInitialConversationState(conversationId),
        conversationId,
        null,
      ),
    ).toBe(true);
  });

  it("rejects a null nested message", () => {
    const state = createInitialConversationState(conversationId);

    expect(
      isConversationState(
        { ...state, messages: [null] },
        conversationId,
        null,
      ),
    ).toBe(false);
  });

  it("accepts reducer-projected retry, cancellation, and streamed assistant fields", () => {
    const { state } = projectedState();

    expect(state.turns[0]).toMatchObject({
      cancellation_status: "cancelled",
      cancellation_requested_reason: "user",
      remote_may_still_be_running: false,
    });
    expect(state.turns[0]?.retry_history).toHaveLength(4);
    expect(state.messages.find((message) => message.role === "assistant")?.turn_id)
      .toBe("turn-current");
    expect(isConversationState(state, conversationId, state.revision)).toBe(true);
  });

  it("strictly accepts linked legacy-image and PDF attachment metadata", () => {
    const { state } = projectedAttachmentState();
    const serialized = JSON.stringify(state);

    expect(state.messages[0]?.attachments).toEqual([
      { attachment_id: "att_legacy_image", media_type: "image/png" },
      {
        attachment_id: "att_pdf_checkpoint",
        kind: "document",
        media_type: "application/pdf",
        filename: "checkpoint.pdf",
        size_bytes: 2_048,
      },
    ]);
    expect(isConversationState(state, conversationId, state.revision)).toBe(true);
    expect(serialized).not.toMatch(
      /"(?:content_ref|provider_file_id|remote_url|binary|bytes|blob)":/,
    );
  });

  it("rejects attachment checkpoint fields that durable events reject", () => {
    const { state } = projectedAttachmentState();
    const pdf = state.messages[0]!.attachments[1]!;
    const malformedReferences: unknown[] = [
      { ...pdf, attachment_id: "file_provider_123" },
      { ...pdf, filename: "../unsafe.pdf" },
      { ...pdf, size_bytes: 0 },
      {
        ...pdf,
        size_bytes: AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes + 1,
      },
      { ...pdf, kind: "image" },
      { ...pdf, media_type: "application/octet-stream" },
      { ...pdf, content_ref: "ref_binary" },
      { ...pdf, provider_file_id: "file_123" },
      { ...pdf, bytes: new Uint8Array([37, 80, 68, 70]) },
      { ...pdf, binary: new Blob(["%PDF"]) },
    ];

    for (const malformedReference of malformedReferences) {
      expect(isConversationState({
        ...state,
        messages: [{
          ...state.messages[0],
          attachments: [state.messages[0]!.attachments[0], malformedReference],
        }],
        attachments: [
          state.attachments[0],
          {
            ...state.attachments[1],
            attachment_id: (malformedReference as Record<string, unknown>).attachment_id,
            reference: malformedReference,
          },
        ],
      }, conversationId, state.revision)).toBe(false);
    }

    expect(isConversationState({
      ...state,
      messages: [{ ...state.messages[0], content_ref: "ref_binary" }],
    }, conversationId, state.revision)).toBe(false);
    expect(isConversationState({
      ...state,
      messages: [{
        ...state.messages[0],
        content: [{ type: "text", text: "Review these", content_ref: "ref_binary" }],
      }],
    }, conversationId, state.revision)).toBe(false);
    expect(isConversationState({
      ...state,
      attachments: [{ ...state.attachments[0], provider_file_id: "file_123" }],
    }, conversationId, state.revision)).toBe(false);
    expect(isConversationState({
      ...state,
      attachments: [{
        ...state.attachments[0],
        reference: { ...state.attachments[0]!.reference, filename: "different.png" },
      }, state.attachments[1]],
    }, conversationId, state.revision)).toBe(false);
  });

  it("accepts absent, null, and nonempty message turn identifiers", () => {
    const { state } = projectedState();
    const userMessage = state.messages[0]!;

    expect(Object.hasOwn(userMessage, "turn_id")).toBe(false);
    expect(isConversationState(state, conversationId, state.revision)).toBe(true);
    expect(isConversationState({
      ...state,
      messages: [{ ...userMessage, turn_id: null }, ...state.messages.slice(1)],
    }, conversationId, state.revision)).toBe(true);
  });

  it.each(["", 123, false])(
    "rejects malformed message turn_id %j",
    (turnId) => {
      const { state } = projectedState();
      expect(isConversationState({
        ...state,
        messages: [{ ...state.messages[0], turn_id: turnId }, ...state.messages.slice(1)],
      }, conversationId, state.revision)).toBe(false);
    },
  );

  it.each([undefined, "pending", 1])(
    "rejects malformed cancellation_status %j",
    (cancellationStatus) => {
      expect(isConversationState(
        withTurnFields({ cancellation_status: cancellationStatus }),
        conversationId,
        9 as ConversationState["revision"],
      )).toBe(false);
    },
  );

  it.each([undefined, "disconnect", 1])(
    "rejects malformed cancellation_requested_reason %j",
    (reason) => {
      expect(isConversationState(
        withTurnFields({ cancellation_requested_reason: reason }),
        conversationId,
        9 as ConversationState["revision"],
      )).toBe(false);
    },
  );

  it.each([null, "yes", 1])(
    "rejects non-boolean remote_may_still_be_running %j",
    (remoteMayStillBeRunning) => {
      expect(isConversationState(
        withTurnFields({ remote_may_still_be_running: remoteMayStillBeRunning }),
        conversationId,
        9 as ConversationState["revision"],
      )).toBe(false);
    },
  );

  it.each([null, {}, "retries"])(
    "rejects non-array retry_history %j",
    (retryHistory) => {
      expect(isConversationState(
        withTurnFields({ retry_history: retryHistory }),
        conversationId,
        9 as ConversationState["revision"],
      )).toBe(false);
    },
  );

  it.each([
    ["unsupported discriminator", 0, (record: Record<string, unknown>) => ({
      ...record,
      type: "turn.retrying",
    })],
    ["missing variant field", 0, (record: Record<string, unknown>) => {
      const withoutOperation = { ...record };
      delete withoutOperation.operation;
      return withoutOperation;
    }],
    ["extra variant field", 0, (record: Record<string, unknown>) => ({
      ...record,
      delay_ms: 1,
    })],
    ["mixed variant fields", 1, (record: Record<string, unknown>) => ({
      ...record,
      operation: "resume",
    })],
  ] as const)("rejects retry record with %s", (_name, index, transform) => {
    expect(isConversationState(
      withRetryRecord(index, transform),
      conversationId,
      9 as ConversationState["revision"],
    )).toBe(false);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid retry attempt %j",
    (attempt) => {
      expect(isConversationState(
        withRetryRecord(0, (record) => ({ ...record, attempt })),
        conversationId,
        9 as ConversationState["revision"],
      )).toBe(false);
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid retry delay_ms %j",
    (delayMs) => {
      expect(isConversationState(
        withRetryRecord(1, (record) => ({ ...record, delay_ms: delayMs })),
        conversationId,
        9 as ConversationState["revision"],
      )).toBe(false);
    },
  );

  it.each([
    [0, { operation: "restart" }],
    [1, { reason_category: "network" }],
    [3, { exhaustion_reason: "gave_up" }],
    [3, { reason_category: "network" }],
  ] as const)("rejects invalid retry variant values at index %i", (index, fields) => {
    expect(isConversationState(
      withRetryRecord(index, (record) => ({ ...record, ...fields })),
      conversationId,
      9 as ConversationState["revision"],
    )).toBe(false);
  });

  it.each(["not-a-timestamp", "2026-02-30T12:00:00Z", 123])(
    "rejects invalid retry occurred_at %j",
    (occurredAt) => {
      expect(isConversationState(
        withRetryRecord(0, (record) => ({ ...record, occurred_at: occurredAt })),
        conversationId,
        9 as ConversationState["revision"],
      )).toBe(false);
    },
  );

  it.each([
    null,
    { actor: { type: "operator" }, source: { type: "runtime" } },
    { actor: { type: "system" }, source: { type: "client" } },
  ])("rejects invalid retry attribution %j", (attribution) => {
    expect(isConversationState(
      withRetryRecord(0, (record) => ({ ...record, attribution })),
      conversationId,
      9 as ConversationState["revision"],
    )).toBe(false);
  });

  it("strictly accepts the linked bounded approval proposal projection", () => {
    const { state } = projectedApprovalState();

    expect(state.approval_proposals[0]).toMatchObject({
      proposal_id: "proposal-validation",
      group_id: "group-validation",
      turn_id: "turn-approval",
      tool_call_id: "call-approval",
      tool_name: "send_update",
      status: "failed",
      proposal_version: 4,
      failure_reason: "Bounded public failure",
      decision_attribution: { actor: { type: "system" } },
    });
    expect(isConversationState(state, conversationId, state.revision)).toBe(true);
  });

  it("rejects legacy or malformed approval proposal checkpoint shapes", () => {
    const { state } = projectedApprovalState();
    const proposal = state.approval_proposals[0]!;
    const withoutApprovalProjection = { ...state } as Record<string, unknown>;
    delete withoutApprovalProjection.approval_proposals;
    expect(isConversationState(
      withoutApprovalProjection,
      conversationId,
      state.revision,
    )).toBe(false);

    const malformedProposals = [
      { ...proposal, proposal_version: 0 },
      { ...proposal, status: "pending" },
      { ...proposal, decision_attribution: null },
      { ...proposal, failure_reason: null },
      { ...proposal, failure_reason: "Bearer abcdefghijklmnop" },
      {
        ...proposal,
        reviewed_arguments: {
          type: "redacted_json",
          value: { provider_response: { native: true } },
        },
      },
      {
        ...proposal,
        reviewed_arguments: {
          type: "redacted_json",
          value: { password: "redacted" },
        },
      },
      { ...proposal, unexpected_internal: true },
    ];
    for (const malformed of malformedProposals) {
      expect(isConversationState({
        ...state,
        approval_proposals: [malformed],
      }, conversationId, state.revision)).toBe(false);
    }

    expect(isConversationState({
      ...state,
      approval_proposals: [proposal, { ...proposal }],
    }, conversationId, state.revision)).toBe(false);
    expect(isConversationState({
      ...state,
      tool_calls: [{ ...state.tool_calls[0], name: "mismatched_tool" }],
    }, conversationId, state.revision)).toBe(false);
  });

  it("loads an approval projection through the current checkpoint path", async () => {
    const { events, state } = projectedApprovalState();
    const eventStore = new InMemoryConversationEventStore();
    await eventStore.append({
      conversationId,
      expectedRevision: null,
      events,
    });
    await eventStore.checkpoints.write({
      conversationId,
      schemaVersion: CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
      revision: state.revision!,
      state: JSON.parse(JSON.stringify(state)) as ConversationJsonValue,
    });

    const replayed = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: false,
    });

    expect(CONVERSATION_CHECKPOINT_SCHEMA_VERSION).toBe(3);
    expect(replayed.checkpointStatus).toBe("used");
    expect(replayed.replayedEventCount).toBe(0);
    expect(replayed.state).toEqual(state);
  });

  it("loads the reducer projection through the checkpoint replay path", async () => {
    const { events, state } = projectedState();
    const eventStore = new InMemoryConversationEventStore();
    await eventStore.append({
      conversationId,
      expectedRevision: null,
      events,
    });
    await eventStore.checkpoints.write({
      conversationId,
      schemaVersion: CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
      revision: state.revision!,
      state: JSON.parse(JSON.stringify(state)) as ConversationJsonValue,
    });

    const replayed = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: false,
    });

    expect(replayed.checkpointStatus).toBe("used");
    expect(replayed.replayedEventCount).toBe(0);
    expect(replayed.state).toEqual(state);
  });

  it("loads bounded attachment metadata through the checkpoint replay path", async () => {
    const { events, state } = projectedAttachmentState();
    const eventStore = new InMemoryConversationEventStore();
    await eventStore.append({
      conversationId,
      expectedRevision: null,
      events,
    });
    await eventStore.checkpoints.write({
      conversationId,
      schemaVersion: CONVERSATION_CHECKPOINT_SCHEMA_VERSION,
      revision: state.revision!,
      state: JSON.parse(JSON.stringify(state)) as ConversationJsonValue,
    });

    const replayed = await replayConversation({
      conversationId,
      eventStore,
      checkpointPolicy: false,
    });

    expect(replayed.checkpointStatus).toBe("used");
    expect(replayed.replayedEventCount).toBe(0);
    expect(replayed.state).toEqual(state);
    expect(Object.isFrozen(replayed.state.attachments[1]?.reference)).toBe(true);
  });
});
