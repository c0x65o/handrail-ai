import { describe, expect, it, vi } from "vitest";
import { PostgresAiPersistence, PostgresPersistenceConflictError, handrailPostgresSchemaV1, type PostgresSqlClient } from "../src/postgres/index.js";

describe("Postgres reference persistence", () => {
  it("uses tenant-scoped transactions and contiguous event revisions", async () => {
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      void values;
      return text.includes("ORDER BY revision DESC")
        ? { rows: [{ revision: "4" }], rowCount: 1 } : { rows: [], rowCount: 1 };
    });
    const client: PostgresSqlClient = { query: query as unknown as PostgresSqlClient["query"], transaction: async (operation) => operation(client) };
    const persistence = new PostgresAiPersistence(client);
    const events = await persistence.appendEvents({ tenantId: "tenant-1", conversationId: "conversation-1", expectedRevision: 4, events: [
      { event_id: "event-5", revision: 5, type: "message" }, { event_id: "event-6", revision: 6, type: "message" },
    ] });
    expect(events).toHaveLength(2);
    expect(query.mock.calls.some(([sql, values]) => String(sql).includes("tenant_id=$1") && (values as unknown[])[0] === "tenant-1")).toBe(true);
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO handrail_ai_events"))).toHaveLength(2);
  });

  it("fails a stale document CAS without overwriting", async () => {
    const query = vi.fn(async (text: string, values?: readonly unknown[]) => {
      void values;
      return text.includes("SELECT version::text")
        ? { rows: [{ version: "3" }], rowCount: 1 } : { rows: [], rowCount: 0 };
    });
    const client: PostgresSqlClient = { query: query as unknown as PostgresSqlClient["query"], transaction: async (operation) => operation(client) };
    await expect(new PostgresAiPersistence(client).compareAndSetDocument({ tenantId: "t", kind: "approval", scopeId: "c", recordId: "p", expectedVersion: 2, value: { status: "approved" } }))
      .rejects.toBeInstanceOf(PostgresPersistenceConflictError);
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO handrail_ai_documents"))).toBe(false);
  });

  it("ships an idempotent schema for every durable domain", () => {
    expect(handrailPostgresSchemaV1.every((sql) => sql.includes("IF NOT EXISTS"))).toBe(true);
    expect(handrailPostgresSchemaV1.join(" ")).toContain("handrail_ai_tool_ledger");
  });
});
