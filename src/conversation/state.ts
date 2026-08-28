import type {
  ConversationAttachmentId,
  ConversationAttachmentReference,
  ConversationClientMutationId,
  ConversationEventActor,
  ConversationEventId,
  ConversationEventSource,
  ConversationId,
  ConversationMessageContentPart,
  ConversationMessageId,
  ConversationMessageRole,
  ConversationRevision,
  ConversationTimestamp,
  ConversationToolCallId,
  ConversationTurnCancellationReason,
  ConversationTurnCompletionOutcome,
  ConversationTurnError,
  ConversationTurnId,
  ConversationTurnStatus,
  ConversationUsageReceiptId,
} from "./events.js";

export type ConversationStateJsonPrimitive = string | number | boolean | null;
export type ConversationStateJsonValue =
  | ConversationStateJsonPrimitive
  | ConversationStateJsonObject
  | readonly ConversationStateJsonValue[];
export interface ConversationStateJsonObject {
  readonly [key: string]: ConversationStateJsonValue;
}

export interface ConversationEventAttribution {
  readonly actor: Readonly<ConversationEventActor>;
  readonly source: Readonly<ConversationEventSource>;
}

export interface ConversationMessageRecord {
  readonly message_id: ConversationMessageId;
  /** Null only when an attachment referenced the message before it was created. */
  readonly role: ConversationMessageRole | null;
  readonly content: readonly Readonly<ConversationMessageContentPart>[];
  readonly attachments: readonly Readonly<ConversationAttachmentReference>[];
  readonly created_at: ConversationTimestamp | null;
  readonly attribution: ConversationEventAttribution | null;
}

export interface ConversationAttachmentRecord {
  readonly message_id: ConversationMessageId;
  readonly attachment_id: ConversationAttachmentId;
  readonly reference: Readonly<ConversationAttachmentReference>;
  readonly referenced_at: ConversationTimestamp;
  readonly attribution: ConversationEventAttribution;
}

export type ConversationTurnStateStatus =
  | ConversationTurnStatus
  | "completed"
  | "cancelled"
  | "failed";

export interface ConversationTurnRecord {
  readonly turn_id: ConversationTurnId;
  readonly status: ConversationTurnStateStatus;
  readonly input_message_ids: readonly ConversationMessageId[];
  readonly output_message_ids: readonly ConversationMessageId[];
  readonly outcome: ConversationTurnCompletionOutcome | null;
  readonly cancellation_reason: ConversationTurnCancellationReason | null;
  readonly error: Readonly<ConversationTurnError> | null;
  readonly started_at: ConversationTimestamp | null;
  readonly terminal_at: ConversationTimestamp | null;
  readonly attribution: ConversationEventAttribution | null;
}

export interface ConversationToolResultRecord {
  readonly content: readonly ConversationStateToolResultContentPart[];
  readonly is_error: boolean;
  readonly recorded_at: ConversationTimestamp;
  readonly attribution: ConversationEventAttribution;
}

export interface ConversationStateToolResultTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ConversationStateToolResultJsonPart {
  readonly type: "json";
  readonly value: ConversationStateJsonValue;
}

export type ConversationStateToolResultContentPart =
  | ConversationStateToolResultTextPart
  | ConversationStateToolResultJsonPart;

export interface ConversationToolCallRecord {
  readonly tool_call_id: ConversationToolCallId;
  readonly turn_id: ConversationTurnId;
  /** Null only when a result was observed before its request. */
  readonly name: string | null;
  readonly arguments: ConversationStateJsonObject | null;
  readonly requested_at: ConversationTimestamp | null;
  readonly attribution: ConversationEventAttribution | null;
  readonly result: ConversationToolResultRecord | null;
}

export interface ConversationUsageReceiptLink {
  readonly usage_receipt_id: ConversationUsageReceiptId;
  readonly turn_id: ConversationTurnId;
  readonly linked_at: ConversationTimestamp;
  readonly attribution: ConversationEventAttribution;
}

export interface ConversationRevisionGapError {
  readonly type: "revision_gap";
  readonly conversation_id: ConversationId;
  readonly event_id: ConversationEventId;
  readonly expected_revision: number;
  readonly received_revision: ConversationRevision;
}

export interface ConversationStaleRevisionError {
  readonly type: "stale_revision";
  readonly conversation_id: ConversationId;
  readonly event_id: ConversationEventId;
  readonly expected_revision: number;
  readonly received_revision: ConversationRevision;
}

export interface ConversationIdentityMismatchError {
  readonly type: "conversation_mismatch";
  readonly conversation_id: ConversationId;
  readonly event_id: ConversationEventId;
  readonly expected_conversation_id: ConversationId;
}

export type ConversationReplayError =
  | ConversationRevisionGapError
  | ConversationStaleRevisionError
  | ConversationIdentityMismatchError;

/**
 * Immutable, JSON-serializable projection of a durable conversation event log.
 * Arrays retain first-seen order so serialization is deterministic.
 */
export interface ConversationState {
  readonly conversation_id: ConversationId | null;
  readonly revision: ConversationRevision | null;
  readonly last_event_id: ConversationEventId | null;
  readonly processed_event_ids: readonly ConversationEventId[];
  readonly processed_mutation_ids: readonly ConversationClientMutationId[];
  readonly messages: readonly ConversationMessageRecord[];
  readonly attachments: readonly ConversationAttachmentRecord[];
  readonly turns: readonly ConversationTurnRecord[];
  readonly active_turn_id: ConversationTurnId | null;
  readonly tool_calls: readonly ConversationToolCallRecord[];
  /** References only; receipt bodies live behind the usage contract/store. */
  readonly usage_receipt_links: readonly ConversationUsageReceiptLink[];
  readonly metadata: ConversationStateJsonObject;
  readonly title: string | null;
  readonly replay_error: ConversationReplayError | null;
}

export function createInitialConversationState(
  conversationId: ConversationId | null = null,
): ConversationState {
  return Object.freeze({
    conversation_id: conversationId,
    revision: null,
    last_event_id: null,
    processed_event_ids: Object.freeze([]),
    processed_mutation_ids: Object.freeze([]),
    messages: Object.freeze([]),
    attachments: Object.freeze([]),
    turns: Object.freeze([]),
    active_turn_id: null,
    tool_calls: Object.freeze([]),
    usage_receipt_links: Object.freeze([]),
    metadata: Object.freeze({}),
    title: null,
    replay_error: null,
  });
}
