import { describe, expect, it, vi } from "vitest";
import { DualWriteConversationEventStore, InMemoryConversationEventStore,
  type ConversationEvent, type ConversationEventStore, type ConversationId } from "../src/index.js";

describe("dual-write conversation adoption", () => {
  it("keeps primary authoritative and repairs a failed shadow tail", async () => {
    const primary = new InMemoryConversationEventStore();
    const shadowInner = new InMemoryConversationEventStore();
    let fail = true;
    const shadow: ConversationEventStore = {
      checkpoints: shadowInner.checkpoints,
      append(input) { if (fail) { fail = false; throw new Error("shadow unavailable"); } return shadowInner.append(input); },
      read: (input) => shadowInner.read(input),
      getLatestRevision: (id) => shadowInner.getLatestRevision(id),
    };
    const onShadowError = vi.fn();
    const store = new DualWriteConversationEventStore({ primary, shadow, onShadowError });
    const conversationId = "conversation-dual" as ConversationId;
    const event = { version: 1, event_id: "event-dual", conversation_id: conversationId, revision: 1,
      occurred_at: "2026-08-30T12:00:00.000Z", actor: { type: "user" }, source: { type: "runtime" },
      payload: { type: "message.created", message_id: "message-dual", role: "user", content: [{ type: "text", text: "Hello" }] } } as ConversationEvent;

    await expect(store.append({ conversationId, expectedRevision: null, events: [event] })).resolves.toMatchObject({ status: "appended" });
    expect(onShadowError).toHaveBeenCalledWith({ operation: "append", conversationId });
    await expect(shadowInner.getLatestRevision(conversationId)).resolves.toBeNull();
    await expect(store.reconcile(conversationId)).resolves.toEqual({ status: "converged", repairedEvents: 1, revision: 1 });
    await expect(shadowInner.getLatestRevision(conversationId)).resolves.toBe(1);
  });
});
