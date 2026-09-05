import { describe, expect, it } from "vitest";
import { recordToolLifecycle } from "../src/server/tool-lifecycle.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { parseConversationEvent } from "../src/conversation/events.js";

describe("server tool lifecycle evidence", () => {
  it("deduplicates concurrent lifecycle writes and rejects changed call identity", async () => {
    const store = new InMemoryConversationEventStore();
    const requested = { type: "tool_call.requested" as const, turn_id: "turn" as never,
      tool_call_id: "call" as never, name: "update", arguments: { a: 1, b: 2 } };
    await Promise.all(Array.from({ length: 4 }, () => recordToolLifecycle(store, "conversation", requested)));
    await recordToolLifecycle(store, "conversation", { ...requested, arguments: { b: 2, a: 1 } });
    expect((await store.read({ conversationId: "conversation" as never })).entries).toHaveLength(1);
    await expect(recordToolLifecycle(store, "conversation", { ...requested, name: "delete" })).rejects.toThrow(/identity conflicts/);
  });

  it("finds retained lifecycle evidence beyond the first history page", async () => {
    const store = new InMemoryConversationEventStore();
    await store.append({ conversationId: "conversation" as never, expectedRevision: null,
      events: Array.from({ length: 505 }, (_, index) => parseConversationEvent({ version: 1,
        event_id: `history-${index}`, conversation_id: "conversation", revision: index + 1,
        occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "system" }, source: { type: "runtime" },
        payload: { type: "tool_call.discovered", turn_id: "history", tool_call_id: `history-${index}` } })) });
    const payload = { type: "tool_call.started" as const, turn_id: "turn" as never, tool_call_id: "call" as never };
    await recordToolLifecycle(store, "conversation", payload);
    await recordToolLifecycle(store, "conversation", payload);
    expect(await store.getLatestRevision("conversation" as never)).toBe(506);
  });
});
