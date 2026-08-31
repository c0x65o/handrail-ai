import { describe, expect, it, vi } from "vitest";
import { createConversationActivityHttpHandler, InMemoryConversationActivityStore, PollingConversationActivity } from "../src/index.js";

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

  it("serves protected list and read operations through a scope-bound handler", async () => {
    const markRead = vi.fn(async () => ({ conversationId: "remote", turnStatus: "completed" as const, unread: false }));
    const handler = createConversationActivityHttpHandler({
      async list() { return [{ conversationId: "remote", turnStatus: "completed", unread: true }]; },
      async upsert(record) { return record; }, markRead,
    });
    const listed = await handler(new Request("https://app.example/activity", { method: "POST",
      body: JSON.stringify({ operation: "list" }) }));
    expect((await listed.json()).value).toEqual([expect.objectContaining({ conversationId: "remote", unread: true })]);
    const read = await handler(new Request("https://app.example/activity", { method: "POST",
      body: JSON.stringify({ operation: "mark_read", conversationId: "remote" }) }));
    expect((await read.json()).value.unread).toBe(false);
    expect(markRead).toHaveBeenCalledWith("remote");
  });
});
