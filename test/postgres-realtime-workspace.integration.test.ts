import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { PostgresAiPersistence, PostgresRealtimeCallStore, PostgresRealtimeToolActivityStore,
  PostgresRealtimeWorkspaceActivityStore, type PostgresSqlClient } from "../src/postgres/index.js";

it("pages only authorized voice conversations and preserves independent completion receipts", async () => {
  const database = new PGlite();
  let now = 1_000;
  let readsFail = false;
  const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      if (readsFail && sql.includes("realtime_tool_activity")) throw new Error("storage disconnected");
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: (operation) => operation(client) };
    return client;
  };
  const persistence = new PostgresAiPersistence({ query: adapt(database).query, async transaction(operation) {
    return database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">)));
  } });
  const scoped = (scope: string, tenant = "environment") => new PostgresRealtimeCallStore(persistence, tenant, scope,
    { clock: () => now, leaseMs: 1_000 });
  const first = scoped("owner:first"), second = scoped("owner:second");
  const feed = () => new PostgresRealtimeWorkspaceActivityStore([
    { conversationId: "first", calls: first }, { conversationId: "second", calls: second },
  ]);
  const start = async (calls: PostgresRealtimeCallStore, conversationId: string, callId: string) => {
    await calls.admit({ conversationId, callId, workerId: "private-worker", fingerprint: "private-settings" });
    await calls.beginCreation(callId, "private-worker");
    await calls.attachProviderCall(callId, "private-worker", "private-provider");
  };
  try {
    await persistence.migrate();
    await start(first, "first", "call-a");
    await start(first, "first", "call-b");
    await start(second, "second", "call-a");
    await start(scoped("foreign-owner:first"), "first", "foreign-call");
    await start(scoped("owner:first", "other-environment"), "first", "foreign-tenant-call");
    // Even a malformed owner scope mapping must not expose another conversation.
    await start(first, "outside", "outside-conversation");
    const tool = new PostgresRealtimeToolActivityStore(first, "call-a", () => now);
    await tool.record({ workerId: "private-worker", toolCallId: "update", name: "update_product", status: "running" });
    await first.requestEnd("call-a");
    await first.confirmEnded("call-a", "private-provider");
    const page = await feed().list({ limit: 2 });
    expect(page.calls.map((call) => [call.conversationId, call.callId, call.status, call.unread])).toEqual([
      ["first", "call-a", "ended", true], ["first", "call-b", "active", false],
    ]);
    expect(page.calls[0]?.counts).toEqual({ total: 1, running: 1, completed: 0, failed: 0 });
    expect(page.next).toEqual({ conversationId: "first", callId: "call-b" });
    const next = await feed().list({ limit: 2, after: page.next! });
    expect(next.calls.map((call) => [call.conversationId, call.callId])).toEqual([["second", "call-a"]]);
    expect(next.next).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/private-|owner:|readToken|update_product/);
    expect(Object.keys(page.calls[0]!).sort()).toEqual(["conversationId", "callId", "status", "counts", "unread"].sort());
    // Listing is observational, including repeated/reopened feeds.
    expect((await feed().list()).calls[0]?.unread).toBe(true);
    await tool.markRead((await tool.readState()).readToken!);
    expect((await feed().list()).calls[0]?.unread).toBe(false);
    await tool.record({ workerId: "private-worker", toolCallId: "update", name: "update_product", status: "completed" });
    expect((await feed().list()).calls[0]?.unread).toBe(true);
    now += 2_000;
    const recovered = await feed().list();
    expect(recovered.calls.map((call) => call.status)).toEqual(["ended", "uncertain", "uncertain"]);
    expect(recovered.calls[0]?.counts.completed).toBe(1);
    await expect(feed().list({ limit: 51 })).rejects.toThrow("page size");
    await expect(feed().list({ after: { conversationId: "foreign", callId: "call" } })).rejects.toThrow("cursor");
    expect(() => new PostgresRealtimeWorkspaceActivityStore([
      { conversationId: "first", calls: first }, { conversationId: "second", calls: first },
    ])).toThrow("scopes");
    expect(() => new PostgresRealtimeWorkspaceActivityStore([
      { conversationId: "first", calls: first }, { conversationId: "second", calls: scoped("owner:second", "other") },
    ])).toThrow("scopes");
    expect(await new PostgresRealtimeWorkspaceActivityStore([]).list()).toEqual({ calls: [], next: null });
    readsFail = true;
    await expect(feed().list()).rejects.toThrow("storage disconnected");
  } finally { await database.close(); }
}, 30_000);
