import { describe, expect, it } from "vitest";
import { PostgresAiPersistence, PostgresConversationEventStore, type PostgresSqlClient } from "../src/postgres/index.js";
import type { ConversationEvent, ConversationId } from "../src/index.js";

describe("Postgres high-level adapters", () => {
  it("appends, idempotently reconciles, and cursor-reads canonical conversation events", async () => {
    const events: ConversationEvent[] = [];
    const client: PostgresSqlClient = {
      transaction: async (operation) => operation(client),
      query: async (sql, values = []) => {
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
        if (sql.includes("event_id=ANY")) {
          const identifiers = values[1] as string[];
          const rows = events.filter((event) => identifiers.includes(event.event_id) ||
            (event.mutation_id !== undefined && identifiers.includes(event.mutation_id))).map((payload) => ({ payload }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes("revision>$3")) {
          const after = Number(values[2]), limit = Number(values[3]);
          const rows = events.filter((event) => event.revision > after).slice(0, limit).map((payload) => ({ payload }));
          return { rows, rowCount: rows.length };
        }
        if (sql.includes("ORDER BY revision DESC")) {
          const latest = events.at(-1);
          return { rows: latest ? [{ revision: String(latest.revision) }] : [], rowCount: latest ? 1 : 0 };
        }
        if (sql.startsWith("INSERT INTO handrail_ai_events")) {
          events.push(JSON.parse(String(values[5])) as ConversationEvent);
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const store = new PostgresConversationEventStore(new PostgresAiPersistence(client), "tenant-a");
    const conversationId = "conversation-a" as ConversationId;
    const event = {
      version: 1, event_id: "event-a", conversation_id: conversationId, revision: 1,
      occurred_at: "2026-08-30T12:00:00.000Z", actor: { type: "user" },
      source: { type: "client", client_id: "client-a" }, mutation_id: "mutation-a",
      payload: { type: "message.created", message_id: "message-a", role: "user", content: [{ type: "text", text: "Hello" }] },
    } as ConversationEvent;

    await expect(store.append({ conversationId, expectedRevision: null, events: [event] }))
      .resolves.toMatchObject({ status: "appended", latestRevision: 1 });
    await expect(store.append({ conversationId, expectedRevision: null, events: [event] }))
      .resolves.toMatchObject({ status: "idempotent", latestRevision: 1 });
    const first = await store.read({ conversationId, limit: 1 });
    expect(first).toMatchObject({ latestRevision: 1, hasMore: false, entries: [{ event: { event_id: "event-a" } }] });
    expect(await store.read({ conversationId, after: { cursor: first.nextCursor! } })).toMatchObject({ entries: [] });
  });
});
