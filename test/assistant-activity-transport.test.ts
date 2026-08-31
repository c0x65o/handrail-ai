import { describe, expect, it } from "vitest";
import { createAssistantActivityTransport } from "../src/presence/assistant-activity.js";
import { createInMemoryLivePresenceDelivery } from "../src/presence/live-delivery.js";
import type { ConversationTransport } from "../src/transports/types.js";
import type { ConversationTurnId } from "../src/conversation/events.js";

describe("assistant activity transport", () => {
  it("publishes thinking, response, tool, and terminal leave automatically", async () => {
    const delivery = createInMemoryLivePresenceDelivery();
    const received: string[] = [], subscription = delivery.subscribe("conversation-1");
    const collecting = (async () => { for await (const envelope of subscription) {
      received.push(envelope.kind === "leave" ? "leave" : envelope.record.assistant_activity ?? "none");
      if (envelope.kind === "leave") subscription.close();
    } })();
    const delegate: ConversationTransport<{ type: string }, unknown> = {
      capabilities: { authoritativeCancellation: { supported: false }, documentInput: { supported: false },
        attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
      async startTurn(input) { return { ok: true, value: { conversationId: input.conversationId,
        turnId: input.conversationTurnId, mutationId: input.mutationId, observation: {
          events: (async function* () { yield { type: "text" }; yield { type: "tool" }; })(),
          result: Promise.resolve({ status: "completed", checkpoint: { lastAppliedEventId: null,
            lastAppliedCursor: null, lastAppliedRevision: null } }), disconnect() {},
        } } }; },
      async resumeTurn() { return { ok: false, error: { code: "not_found", message: "missing", retryable: false } }; },
    };
    const transport = createAssistantActivityTransport({ delegate, delivery, sessionId: (_conversation, turn) => `session-${turn}`,
      activityForEvent: (event) => event.type === "tool" ? "using_tool" : "responding" });
    const started = await transport.startTurn({ conversationId: "conversation-1", conversationTurnId: "turn-1" as ConversationTurnId,
      mutationId: "mutation-1", idempotencyKey: "start-1", request: {} });
    expect(started.ok).toBe(true); if (!started.ok) return;
    for await (const event of started.value.observation.events) void event;
    await started.value.observation.result; await collecting;
    expect(received).toEqual(["thinking", "responding", "using_tool", "leave"]);
  });
});
