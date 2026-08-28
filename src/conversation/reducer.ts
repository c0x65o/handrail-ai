import type {
  ConversationAttachmentReference,
  ConversationEvent,
  ConversationEventActor,
  ConversationEventSource,
  ConversationJsonObject,
  ConversationJsonValue,
  ConversationMessageContentPart,
  ConversationToolResultContentPart,
} from "./events.js";
import type {
  ConversationAttachmentRecord,
  ConversationEventAttribution,
  ConversationMessageRecord,
  ConversationReplayError,
  ConversationState,
  ConversationStateJsonObject,
  ConversationStateJsonValue,
  ConversationStateToolResultContentPart,
  ConversationToolCallRecord,
  ConversationToolResultRecord,
  ConversationTurnRecord,
  ConversationUsageReceiptLink,
} from "./state.js";

/** Fold one validated durable event into an immutable conversation projection. */
export function reduceConversationEvent(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  if (
    state.processed_event_ids.includes(event.event_id) ||
    (event.mutation_id !== undefined &&
      state.processed_mutation_ids.includes(event.mutation_id))
  ) {
    return state;
  }

  if (
    state.conversation_id !== null &&
    state.conversation_id !== event.conversation_id
  ) {
    return withReplayError(state, {
      type: "conversation_mismatch",
      conversation_id: event.conversation_id,
      event_id: event.event_id,
      expected_conversation_id: state.conversation_id,
    });
  }

  const expectedRevision = (state.revision ?? 0) + 1;
  if (event.revision !== expectedRevision) {
    return withReplayError(state, {
      type:
        event.revision > expectedRevision
          ? "revision_gap"
          : "stale_revision",
      conversation_id: event.conversation_id,
      event_id: event.event_id,
      expected_revision: expectedRevision,
      received_revision: event.revision,
    });
  }

  const accepted = acceptEnvelope(state, event);
  const attribution = cloneAttribution(event.actor, event.source);
  const payload = event.payload;

  switch (payload.type) {
    case "message.created": {
      const index = accepted.messages.findIndex(
        (message) => message.message_id === payload.message_id,
      );
      if (index >= 0) {
        const current = accepted.messages[index]!;
        if (current.role !== null) return accepted;
        return updateMessages(accepted, index, freeze({
          ...current,
          role: payload.role,
          content: cloneMessageContent(payload.content),
          created_at: event.occurred_at,
          attribution,
        }));
      }

      const message: ConversationMessageRecord = freeze({
        message_id: payload.message_id,
        role: payload.role,
        content: cloneMessageContent(payload.content),
        attachments: freeze([]),
        created_at: event.occurred_at,
        attribution,
      });
      return freeze({
        ...accepted,
        messages: freeze([...accepted.messages, message]),
      });
    }

    case "message.attachment_referenced": {
      const reference = cloneAttachment(payload.attachment);
      const alreadyLinked = accepted.attachments.some(
        (attachment) =>
          attachment.message_id === payload.message_id &&
          attachment.attachment_id === reference.attachment_id,
      );
      const attachments = alreadyLinked
        ? accepted.attachments
        : freeze([
            ...accepted.attachments,
            freeze({
              message_id: payload.message_id,
              attachment_id: reference.attachment_id,
              reference,
              referenced_at: event.occurred_at,
              attribution,
            } satisfies ConversationAttachmentRecord),
          ]);

      const messageIndex = accepted.messages.findIndex(
        (message) => message.message_id === payload.message_id,
      );
      if (messageIndex >= 0) {
        const message = accepted.messages[messageIndex]!;
        if (
          message.attachments.some(
            (attachment) => attachment.attachment_id === reference.attachment_id,
          )
        ) {
          return attachments === accepted.attachments
            ? accepted
            : freeze({ ...accepted, attachments });
        }
        return freeze({
          ...updateMessages(accepted, messageIndex, freeze({
            ...message,
            attachments: freeze([...message.attachments, reference]),
          })),
          attachments,
        });
      }

      const placeholder: ConversationMessageRecord = freeze({
        message_id: payload.message_id,
        role: null,
        content: freeze([]),
        attachments: freeze([reference]),
        created_at: null,
        attribution: null,
      });
      return freeze({
        ...accepted,
        attachments,
        messages: freeze([...accepted.messages, placeholder]),
      });
    }

    case "turn.started": {
      const index = findTurn(accepted, payload.turn_id);
      if (index >= 0) {
        const turn = accepted.turns[index]!;
        if (isTerminal(turn) || turn.started_at !== null) return accepted;
        return updateTurn(accepted, index, freeze({
          ...turn,
          input_message_ids: freeze([...payload.input_message_ids]),
          started_at: event.occurred_at,
          attribution,
        }), payload.turn_id);
      }
      return appendTurn(accepted, freeze({
        turn_id: payload.turn_id,
        status: "queued",
        input_message_ids: freeze([...payload.input_message_ids]),
        output_message_ids: freeze([]),
        outcome: null,
        cancellation_reason: null,
        error: null,
        started_at: event.occurred_at,
        terminal_at: null,
        attribution,
      }), payload.turn_id);
    }

    case "turn.status_changed": {
      const index = findTurn(accepted, payload.turn_id);
      if (index >= 0) {
        const turn = accepted.turns[index]!;
        if (isTerminal(turn)) return accepted;
        return updateTurn(accepted, index, freeze({
          ...turn,
          status: payload.status,
        }), payload.turn_id);
      }
      return appendTurn(accepted, emptyTurn({
        turn_id: payload.turn_id,
        status: payload.status,
        attribution,
      }), payload.turn_id);
    }

    case "turn.completed":
      return terminateTurn(accepted, payload.turn_id, event.occurred_at, attribution, {
        status: "completed",
        output_message_ids: freeze([...payload.output_message_ids]),
        outcome: payload.outcome,
        cancellation_reason: null,
        error: null,
      });

    case "turn.cancelled":
      return terminateTurn(accepted, payload.turn_id, event.occurred_at, attribution, {
        status: "cancelled",
        output_message_ids: freeze([]),
        outcome: null,
        cancellation_reason: payload.reason,
        error: null,
      });

    case "turn.failed":
      return terminateTurn(accepted, payload.turn_id, event.occurred_at, attribution, {
        status: "failed",
        output_message_ids: freeze([]),
        outcome: null,
        cancellation_reason: null,
        error: freeze({ ...payload.error }),
      });

    case "tool_call.requested": {
      if (isTerminalTurn(accepted, payload.turn_id)) return accepted;
      const index = accepted.tool_calls.findIndex(
        (toolCall) => toolCall.tool_call_id === payload.tool_call_id,
      );
      if (index >= 0) {
        const current = accepted.tool_calls[index]!;
        if (current.name !== null || current.turn_id !== payload.turn_id) {
          return accepted;
        }
        return updateToolCall(accepted, index, freeze({
          ...current,
          name: payload.name,
          arguments: cloneJsonObject(payload.arguments),
          requested_at: event.occurred_at,
          attribution,
        }));
      }
      const toolCall: ConversationToolCallRecord = freeze({
        tool_call_id: payload.tool_call_id,
        turn_id: payload.turn_id,
        name: payload.name,
        arguments: cloneJsonObject(payload.arguments),
        requested_at: event.occurred_at,
        attribution,
        result: null,
      });
      return freeze({
        ...accepted,
        tool_calls: freeze([...accepted.tool_calls, toolCall]),
      });
    }

    case "tool_call.result_recorded": {
      if (isTerminalTurn(accepted, payload.turn_id)) return accepted;
      const result: ConversationToolResultRecord = freeze({
        content: cloneToolResultContent(payload.content),
        is_error: payload.is_error,
        recorded_at: event.occurred_at,
        attribution,
      });
      const index = accepted.tool_calls.findIndex(
        (toolCall) => toolCall.tool_call_id === payload.tool_call_id,
      );
      if (index >= 0) {
        const current = accepted.tool_calls[index]!;
        if (current.result !== null || current.turn_id !== payload.turn_id) {
          return accepted;
        }
        return updateToolCall(accepted, index, freeze({ ...current, result }));
      }
      const toolCall: ConversationToolCallRecord = freeze({
        tool_call_id: payload.tool_call_id,
        turn_id: payload.turn_id,
        name: null,
        arguments: null,
        requested_at: null,
        attribution: null,
        result,
      });
      return freeze({
        ...accepted,
        tool_calls: freeze([...accepted.tool_calls, toolCall]),
      });
    }

    case "usage.receipt_linked": {
      if (
        accepted.usage_receipt_links.some(
          (link) => link.usage_receipt_id === payload.usage_receipt_id,
        )
      ) {
        return accepted;
      }
      const link: ConversationUsageReceiptLink = freeze({
        usage_receipt_id: payload.usage_receipt_id,
        turn_id: payload.turn_id,
        linked_at: event.occurred_at,
        attribution,
      });
      return freeze({
        ...accepted,
        usage_receipt_links: freeze([...accepted.usage_receipt_links, link]),
      });
    }

    case "conversation.metadata_updated":
      return freeze({
        ...accepted,
        metadata: cloneJsonObject(payload.metadata),
      });

    case "conversation.title_updated":
      return freeze({ ...accepted, title: payload.title });
  }
}

function acceptEnvelope(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  return freeze({
    ...state,
    conversation_id: state.conversation_id ?? event.conversation_id,
    revision: event.revision,
    last_event_id: event.event_id,
    processed_event_ids: freeze([
      ...state.processed_event_ids,
      event.event_id,
    ]),
    processed_mutation_ids:
      event.mutation_id === undefined
        ? state.processed_mutation_ids
        : freeze([...state.processed_mutation_ids, event.mutation_id]),
    replay_error: null,
  });
}

function withReplayError(
  state: ConversationState,
  error: ConversationReplayError,
): ConversationState {
  if (sameReplayError(state.replay_error, error)) return state;
  return freeze({ ...state, replay_error: freeze(error) });
}

function sameReplayError(
  left: ConversationReplayError | null,
  right: ConversationReplayError,
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}

function cloneAttribution(
  actor: ConversationEventActor,
  source: ConversationEventSource,
): ConversationEventAttribution {
  const clonedActor = freeze(
    actor.id === undefined ? { type: actor.type } : { type: actor.type, id: actor.id },
  );
  let clonedSource: Readonly<ConversationEventSource>;
  if (source.type === "client") {
    clonedSource = freeze(
      source.device_id === undefined
        ? { type: source.type, client_id: source.client_id }
        : {
            type: source.type,
            client_id: source.client_id,
            device_id: source.device_id,
          },
    );
  } else {
    clonedSource = freeze({ type: source.type });
  }
  return freeze({ actor: clonedActor, source: clonedSource });
}

function cloneAttachment(
  attachment: ConversationAttachmentReference,
): Readonly<ConversationAttachmentReference> {
  return freeze({
    attachment_id: attachment.attachment_id,
    media_type: attachment.media_type,
    ...(attachment.filename === undefined
      ? {}
      : { filename: attachment.filename }),
    ...(attachment.size_bytes === undefined
      ? {}
      : { size_bytes: attachment.size_bytes }),
  });
}

function cloneMessageContent(
  content: readonly ConversationMessageContentPart[],
): readonly Readonly<ConversationMessageContentPart>[] {
  return freeze(content.map((part) => freeze({ type: part.type, text: part.text })));
}

function cloneToolResultContent(
  content: readonly ConversationToolResultContentPart[],
): readonly ConversationStateToolResultContentPart[] {
  return freeze(content.map((part) =>
    part.type === "text"
      ? freeze({ type: part.type, text: part.text })
      : freeze({ type: part.type, value: cloneJson(part.value) }),
  ));
}

function cloneJsonObject(value: ConversationJsonObject): ConversationStateJsonObject {
  return cloneJson(value) as ConversationStateJsonObject;
}

function cloneJson(value: ConversationJsonValue): ConversationStateJsonValue {
  if (Array.isArray(value)) {
    return freeze(value.map((item) => cloneJson(item)));
  }
  if (value !== null && typeof value === "object") {
    return freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    ));
  }
  return value;
}

function updateMessages(
  state: ConversationState,
  index: number,
  message: ConversationMessageRecord,
): ConversationState {
  const messages = [...state.messages];
  messages[index] = message;
  return freeze({ ...state, messages: freeze(messages) });
}

function findTurn(state: ConversationState, turnId: string): number {
  return state.turns.findIndex((turn) => turn.turn_id === turnId);
}

function isTerminal(turn: ConversationTurnRecord): boolean {
  return (
    turn.status === "completed" ||
    turn.status === "cancelled" ||
    turn.status === "failed"
  );
}

function isTerminalTurn(state: ConversationState, turnId: string): boolean {
  const index = findTurn(state, turnId);
  return index >= 0 && isTerminal(state.turns[index]!);
}

function emptyTurn(
  values: Pick<ConversationTurnRecord, "turn_id" | "status" | "attribution">,
): ConversationTurnRecord {
  return freeze({
    ...values,
    input_message_ids: freeze([]),
    output_message_ids: freeze([]),
    outcome: null,
    cancellation_reason: null,
    error: null,
    started_at: null,
    terminal_at: null,
  });
}

function appendTurn(
  state: ConversationState,
  turn: ConversationTurnRecord,
  activeTurnId: ConversationTurnRecord["turn_id"] | null,
): ConversationState {
  return freeze({
    ...state,
    turns: freeze([...state.turns, turn]),
    active_turn_id: activeTurnId,
  });
}

function updateTurn(
  state: ConversationState,
  index: number,
  turn: ConversationTurnRecord,
  activeTurnId: ConversationTurnRecord["turn_id"] | null,
): ConversationState {
  const turns = [...state.turns];
  turns[index] = turn;
  return freeze({ ...state, turns: freeze(turns), active_turn_id: activeTurnId });
}

function terminateTurn(
  state: ConversationState,
  turnId: ConversationTurnRecord["turn_id"],
  terminalAt: ConversationTurnRecord["terminal_at"],
  attribution: ConversationEventAttribution,
  terminal: Pick<
    ConversationTurnRecord,
    | "status"
    | "output_message_ids"
    | "outcome"
    | "cancellation_reason"
    | "error"
  >,
): ConversationState {
  const index = findTurn(state, turnId);
  if (index >= 0) {
    const current = state.turns[index]!;
    if (isTerminal(current)) return state;
    return updateTurn(state, index, freeze({
      ...current,
      ...terminal,
      terminal_at: terminalAt,
    }), state.active_turn_id === turnId ? null : state.active_turn_id);
  }
  return appendTurn(state, freeze({
    turn_id: turnId,
    input_message_ids: freeze([]),
    started_at: null,
    terminal_at: terminalAt,
    attribution,
    ...terminal,
  }), state.active_turn_id);
}

function updateToolCall(
  state: ConversationState,
  index: number,
  toolCall: ConversationToolCallRecord,
): ConversationState {
  const toolCalls = [...state.tool_calls];
  toolCalls[index] = toolCall;
  return freeze({ ...state, tool_calls: freeze(toolCalls) });
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}
