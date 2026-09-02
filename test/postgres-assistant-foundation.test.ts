import { describe, expect, it } from "vitest";

import {
  PostgresAIRuntimeUsageOutbox,
  PostgresAiPersistence,
  PostgresPersistenceConflictError,
  createPostgresSqlClientFromPool,
  type PostgresPoolClientLike,
  type PostgresPoolLike,
  type PostgresVersionedDocument,
} from "../src/postgres/index.js";
import type { AIRuntimeUsageOutboxEntry } from "../src/server/usage-control.js";
import { parseNormalizedUsageReceipt } from "../src/usage.js";

function receipt(id: string, logicalRequestId = "logical-1") {
  return parseNormalizedUsageReceipt({
    version: 1,
    usage_receipt_id: id,
    conversation_id: "conversation-1",
    turn_id: "turn-1",
    logical_request_id: logicalRequestId,
    trace_id: "trace-1",
    attempt: { id: "attempt-0", index: 0 },
    continuation: { id: "continuation-0", index: 0 },
    provider_id: "openai",
    model_id: "gpt-5",
    attribution: {
      organization: { id: "org-1", source: "server_derived", trust: "authoritative" },
      project: { id: "project-1", source: "server_derived", trust: "authoritative" },
      service_environment: { id: "environment-1", source: "server_derived", trust: "authoritative" },
      known_user: { id: "user-1", source: "server_derived", trust: "authoritative" },
      session: { id: null, source: "server_derived", trust: "authoritative" },
      automation: { id: null, source: "server_derived", trust: "authoritative" },
    },
    source: "provider",
    terminal_status: "completed",
    tokens: {
      input_tokens: { status: "reported", value: 4 },
      cached_input_tokens: { status: "reported", value: 0 },
      output_tokens: { status: "reported", value: 2 },
      reasoning_tokens: { status: "unavailable" },
      total_tokens: { status: "reported", value: 6 },
    },
    provider_cost: { status: "unavailable" },
  });
}

class MemoryDocuments {
  readonly rows = new Map<string, PostgresVersionedDocument<unknown>>();

  key(tenantId: string, kind: string, scopeId: string, recordId: string) {
    return `${tenantId}\0${kind}\0${scopeId}\0${recordId}`;
  }

  readonly persistence = {
    client: {
      query: async <TRow extends Record<string, unknown>>(_text: string, values?: readonly unknown[]) => {
        const tenantId = String(values?.[0]);
        const scopeId = String(values?.[1]);
        const limit = Number(values?.[2]);
        const rows = [...this.rows.values()]
          .filter((row) => row.tenantId === tenantId && row.kind === "usage_outbox" &&
            row.scopeId === scopeId && (row.value as { status?: string }).status === "pending")
          .sort((left, right) => {
            const leftEntry = (left.value as { entry: AIRuntimeUsageOutboxEntry }).entry;
            const rightEntry = (right.value as { entry: AIRuntimeUsageOutboxEntry }).entry;
            return leftEntry.enqueuedAt.localeCompare(rightEntry.enqueuedAt) ||
              left.recordId.localeCompare(right.recordId);
          })
          .slice(0, limit)
          .map((row) => ({ payload: row.value }) as unknown as TRow);
        return { rows, rowCount: rows.length };
      },
    },
    getDocument: async <T>(tenantId: string, kind: string, scopeId: string, recordId: string) =>
      (this.rows.get(this.key(tenantId, kind, scopeId, recordId)) as
        PostgresVersionedDocument<T> | undefined) ?? null,
    compareAndSetDocument: async <T>(input: Omit<PostgresVersionedDocument<T>, "version"> & {
      readonly expectedVersion: number | null;
    }) => {
      const key = this.key(input.tenantId, input.kind, input.scopeId, input.recordId);
      const current = this.rows.get(key);
      if ((current?.version ?? null) !== input.expectedVersion) throw new PostgresPersistenceConflictError();
      const saved = { ...input, version: (current?.version ?? 0) + 1 } as PostgresVersionedDocument<T>;
      this.rows.set(key, structuredClone(saved) as PostgresVersionedDocument<unknown>);
      return saved;
    },
    listDocuments: async <T>(tenantId: string, kind: string, scopeId: string) => {
      const values: PostgresVersionedDocument<T>[] = [];
      for (const row of this.rows.values()) {
        if (row.tenantId === tenantId && row.kind === kind && row.scopeId === scopeId) {
          values.push(row as PostgresVersionedDocument<T>);
        }
      }
      return values;
    },
    deleteDocument: async (input: { readonly tenantId: string; readonly kind: string; readonly scopeId: string;
      readonly recordId: string; readonly expectedVersion: number }) => {
      const key = this.key(input.tenantId, input.kind, input.scopeId, input.recordId);
      const current = this.rows.get(key);
      if (current?.version !== input.expectedVersion) return false;
      this.rows.delete(key);
      return true;
    },
  } as unknown as PostgresAiPersistence;
}

function entry(id: string, enqueuedAt: string, logicalRequestId?: string): AIRuntimeUsageOutboxEntry {
  return { receipt: receipt(id, logicalRequestId), enqueuedAt, attempts: 0 };
}

describe("Postgres assistant persistence foundation", () => {
  it("adapts a pg-compatible pool and releases committed and rolled-back transactions", async () => {
    const commands: string[] = [];
    let releases = 0;
    const client: PostgresPoolClientLike = {
      async query<TRow extends Record<string, unknown>>(text: string) {
        commands.push(text);
        return { rows: [] as TRow[], rowCount: null };
      },
      release() { releases += 1; },
    };
    const pool: PostgresPoolLike = {
      async query<TRow extends Record<string, unknown>>() {
        return { rows: [] as TRow[], rowCount: null };
      },
      async connect() { return client; },
    };
    const sql = createPostgresSqlClientFromPool(pool);

    await sql.transaction(async (transaction) => {
      expect((await transaction.query("SELECT 1")).rowCount).toBe(0);
    });
    await expect(sql.transaction(async () => { throw new Error("operation failed"); }))
      .rejects.toThrow("operation failed");

    expect(commands).toEqual(["BEGIN", "SELECT 1", "COMMIT", "BEGIN", "ROLLBACK"]);
    expect(releases).toBe(2);
  });

  it("retains retryable receipts durably, dead-letters permanent failures, and acknowledges delivery", async () => {
    const documents = new MemoryDocuments();
    const outbox = new PostgresAIRuntimeUsageOutbox(documents.persistence, "tenant-1", "assistant-aegis");
    await outbox.enqueue(entry("receipt-later", "2026-09-02T02:00:00.000Z"));
    await outbox.enqueue(entry("receipt-first", "2026-09-02T01:00:00.000Z"));
    await outbox.enqueue(entry("receipt-first", "2026-09-02T03:00:00.000Z"));

    expect((await outbox.pending(10)).map((value) => value.receipt.usage_receipt_id))
      .toEqual(["receipt-first", "receipt-later"]);
    await outbox.failed("receipt-first", { code: "offline", retryable: true });
    expect((await outbox.pending(10))[0]).toMatchObject({ attempts: 1 });
    await outbox.failed("receipt-first", { code: "invalid_receipt", retryable: false });
    expect((await outbox.pending(10)).map((value) => value.receipt.usage_receipt_id))
      .toEqual(["receipt-later"]);
    await outbox.acknowledge("receipt-later");
    expect(await outbox.pending(10)).toEqual([]);
  });

  it("rejects reuse of one receipt identity for different usage", async () => {
    const documents = new MemoryDocuments();
    const outbox = new PostgresAIRuntimeUsageOutbox(documents.persistence, "tenant-1", "assistant-aegis");
    await outbox.enqueue(entry("receipt-conflict", "2026-09-02T01:00:00.000Z"));
    await expect(outbox.enqueue(entry(
      "receipt-conflict",
      "2026-09-02T01:00:00.000Z",
      "different-logical-request",
    ))).rejects.toBeInstanceOf(PostgresPersistenceConflictError);
  });
});
