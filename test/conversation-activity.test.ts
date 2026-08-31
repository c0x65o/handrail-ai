import { describe, expect, it, vi } from "vitest";
import { InMemoryConversationActivityStore, PollingConversationActivity } from "../src/index.js";

describe("conversation activity", () => {
  it("tracks remote running, unread completion, errors, and read state", () => {
    const store = new InMemoryConversationActivityStore();
    const changed = vi.fn(); store.subscribe(changed);
    store.upsert({ conversationId: "remote-a", turnStatus: "running", unread: false,
      updatedAt: "2026-08-31T01:00:00.000Z" });
    store.upsert({ conversationId: "remote-b", turnStatus: "completed", unread: true,
      updatedAt: "2026-08-31T02:00:00.000Z" });
    expect(store.getSnapshot().map((record) => [record.conversationId, record.turnStatus, record.unread])).toEqual([
      ["remote-b", "completed", true], ["remote-a", "running", false],
    ]);
    store.markRead("remote-b");
    expect(store.getSnapshot()[0]?.unread).toBe(false);
    store.upsert({ conversationId: "remote-a", turnStatus: "error", unread: true });
    expect(store.getSnapshot().find((record) => record.conversationId === "remote-a"))
      .toMatchObject({ turnStatus: "error", unread: true });
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("loads a server-backed snapshot through the cross-platform polling adapter", async () => {
    const load = vi.fn(async () => [{ conversationId: "remote", turnStatus: "running" as const, unread: false }]);
    const activity = new PollingConversationActivity({ load, intervalMilliseconds: 60_000 });
    await activity.refresh();
    expect(activity.getSnapshot()).toEqual([expect.objectContaining({ conversationId: "remote", turnStatus: "running" })]);
    expect(load).toHaveBeenCalledOnce();
    activity.stop();
  });
});
