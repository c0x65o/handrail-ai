import type { ConversationEvent } from "./events.js";

/** Keep original approval evidence while validating later display-only copies. */
export function originalApprovalEvidence(events: readonly ConversationEvent[]): ConversationEvent[] {
  const originals = new Map<string, ConversationEvent>();
  for (const event of events) {
    const reference = event.metadata?.repair_of_event_id;
    if (reference === undefined) {
      originals.set(event.event_id, event);
      continue;
    }
    const original = typeof reference === "string" ? originals.get(reference) : undefined;
    if (!original || event.mutation_id !== undefined ||
      event.conversation_id !== original.conversation_id || event.revision <= original.revision ||
      event.occurred_at !== original.occurred_at ||
      JSON.stringify(event.actor) !== JSON.stringify(original.actor) ||
      JSON.stringify(event.source) !== JSON.stringify(original.source) ||
      JSON.stringify(event.payload) !== JSON.stringify(original.payload)) {
      throw new TypeError("Approval projection does not match retained original evidence.");
    }
  }
  return [...originals.values()];
}
