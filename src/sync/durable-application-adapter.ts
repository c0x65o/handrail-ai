import { createHash } from "node:crypto";

import { parseStreamEvent, type ChatRequest, type StreamEvent } from "../protocol.js";
import type { DurableApplicationTurnStore } from "../transports/durable.js";
import type { ConversationEvent, ConversationEventPayload, ConversationId } from "../conversation/events.js";
import type { ConversationSyncMutationEvent } from "./types.js";
import type { ConversationEventStore } from "../conversation/event-store.js";
import { replayConversation } from "../conversation/replay.js";
import type { AiDiagnosticSink } from "../diagnostics.js";
import { createEventStoreConversationSyncAdapter, type CanonicalConversationSyncMutation } from "./event-store-adapter.js";

export interface DurableApplicationConversationSyncOptions<TAuthorizationContext> {
  readonly authorizationContext: TAuthorizationContext;
  readonly principalId: string;
  readonly eventStore: ConversationEventStore;
  readonly turnStore: DurableApplicationTurnStore<ChatRequest, StreamEvent>;
  readonly authorizeConversation: (conversationId: ConversationId) => boolean | Promise<boolean>;
  readonly diagnostics?: AiDiagnosticSink;
}

/**
 * Authoritative browser/runtime synchronization. User proposals are re-authored
 * from the principal; assistant proposals must exactly match a retained durable
 * provider frame before entering the canonical log.
 */
export function createDurableApplicationConversationSync<TAuthorizationContext>(
  options: DurableApplicationConversationSyncOptions<TAuthorizationContext>,
) {
  return createEventStoreConversationSyncAdapter({
    authorizationContext: options.authorizationContext,
    eventStore: options.eventStore,
    authorize: ({ conversationId }) => options.authorizeConversation(conversationId),
    allowRuntimeMutationProposals: true,
    canonicalizeMutation: ({ conversationId, proposedEvent }) => canonicalize(
      proposedEvent, conversationId, options.principalId, options.turnStore,
    ),
    validateCanonicalBatch: async ({ conversationId, events }) => {
      const replay = await replayConversation({ conversationId, eventStore: options.eventStore, checkpointPolicy: false });
      const state = await replay.store.applyEvents(events);
      if (state.replay_error !== null) throw new TypeError("The proposed history is not a valid canonical transition");
    },
    createEventId: ({ conversationId, mutationId }) =>
      `assistant-sync:${digest(`${conversationId}\0${mutationId}`)}` as never,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
}

async function canonicalize(
  proposed: ConversationSyncMutationEvent,
  conversationId: ConversationId,
  principalId: string,
  turnStore: DurableApplicationTurnStore<ChatRequest, StreamEvent>,
): Promise<CanonicalConversationSyncMutation> {
  const payload = proposed.payload;
  if (payload.type === "message.created") {
    if (proposed.source.type !== "client" || proposed.actor.type !== "user" || payload.role !== "user") deny();
    return canonical(proposed, { type: "user", id: principalId as never });
  }
  if (payload.type === "message.attachment_referenced") {
    if (proposed.source.type !== "client" || proposed.actor.type !== "user") deny();
    return canonical(proposed, { type: "user", id: principalId as never });
  }
  if (payload.type === "turn.started") {
    if (proposed.source.type !== "runtime" || proposed.actor.type !== "assistant" ||
      payload.input_message_ids.length !== 1 || payload.continuation_of_turn_id !== undefined) deny();
    return canonical(proposed, { type: "assistant" });
  }
  if (payload.type === "turn.attempt_started" || payload.type === "turn.retry_scheduled" ||
    payload.type === "turn.retry_exhausted") {
    if (proposed.source.type !== "runtime" || proposed.actor.type !== "assistant") deny();
    return canonical(proposed, { type: "assistant" });
  }
  if (payload.type === "turn.cancellation_requested" || payload.type === "turn.cancellation_unsupported") {
    if (proposed.source.type !== "client" || proposed.actor.type !== "user") deny();
    return canonical(proposed, { type: "user", id: principalId as never });
  }
  const metadata = runtimeMetadata(proposed);
  const turnId = payloadTurnId(payload) ?? (typeof metadata.turn_id === "string" ? metadata.turn_id : null);
  if (!turnId || proposed.source.type !== "runtime" || proposed.actor.type !== "assistant") deny();
  const durable = await turnStore.load(conversationId, turnId);
  if (!durable) deny();
  if (payload.type === "turn.status_changed" && payload.status === "queued") {
    if (runtimeMetadata(proposed).transport_turn_id !== turnId) deny();
    return canonical(proposed, { type: "assistant" });
  }
  const frame = retainedFrame(proposed, durable.record.events.map((entry) => entry.event));
  if (!frame || !payloadMatchesFrame(payload, frame)) deny();
  return canonical(proposed, { type: "assistant" });
}

function canonical(proposed: ConversationSyncMutationEvent, actor: ConversationEvent["actor"]): CanonicalConversationSyncMutation {
  return Object.freeze({ actor, source: { type: "sync" as const }, payload: proposed.payload,
    ...(proposed.metadata === undefined ? {} : { metadata: proposed.metadata }) });
}

function retainedFrame(proposed: ConversationSyncMutationEvent, events: readonly StreamEvent[]): StreamEvent | null {
  const metadata = runtimeMetadata(proposed);
  if (typeof metadata.sequence !== "number" || typeof metadata.request_id !== "string" ||
    typeof metadata.trace_id !== "string" || typeof metadata.frame_type !== "string") return null;
  const frame = events.map(parseStreamEvent).find((candidate) => candidate.sequence === metadata.sequence);
  return frame && frame.request_id === metadata.request_id && frame.trace_id === metadata.trace_id &&
    frame.type === metadata.frame_type ? frame : null;
}

function payloadMatchesFrame(payload: ConversationEventPayload, frame: StreamEvent): boolean {
  switch (frame.type) {
    case "response.started": return payload.type === "turn.status_changed" && payload.status === "running" && payload.turn_id === frame.request_id;
    case "response.text.delta": return payload.type === "message.text_appended" && payload.turn_id === frame.request_id && payload.text === frame.delta;
    case "response.tool_call": return payload.type === "tool_call.requested" && payload.turn_id === frame.request_id &&
      payload.tool_call_id === frame.tool_call_id && payload.name === frame.name && json(payload.arguments) === json(frame.arguments);
    case "response.citation_batch": return payload.type === "citation.records_linked" && json(payload.sources) === json(frame.sources) &&
      json(payload.citations.map(withoutTarget)) === json(frame.citations.map(withoutTarget));
    case "response.completed": return payload.type === "turn.completed" && payload.turn_id === frame.request_id && payload.outcome === frame.outcome;
    case "response.cancelled": return payload.type === "turn.cancelled" && payload.turn_id === frame.request_id && payload.reason === cancellationReason(frame.reason);
    case "response.error": return payload.type === "turn.failed" && payload.turn_id === frame.request_id &&
      json(payload.error) === json({ code: frame.error.code, message: frame.error.message, retryable: frame.error.retryable });
    case "response.usage": return false;
  }
}

function payloadTurnId(payload: ConversationEventPayload): string | null {
  return "turn_id" in payload && typeof payload.turn_id === "string" ? payload.turn_id : null;
}
function runtimeMetadata(event: ConversationSyncMutationEvent): Record<string, unknown> {
  const value = event.metadata?.handrail_runtime;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function cancellationReason(reason: string): "user" | "timeout" | "superseded" | "runtime_shutdown" {
  if (reason === "deadline_exceeded") return "timeout";
  if (reason === "policy_revoked") return "superseded";
  return "runtime_shutdown";
}
function withoutTarget(value: { readonly citation_id: string; readonly source_id: string; readonly order: number }) {
  return { citation_id: value.citation_id, source_id: value.source_id, order: value.order };
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 32); }
function json(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${json(record[key])}`).join(",")}}`;
}
function deny(): never { throw new TypeError("The proposed runtime event is not backed by server authority"); }
