import { describe, expect, it, vi } from "vitest";
import { PostgresAiPersistence, PostgresToolExecutionUncertainError, type PostgresSqlClient } from "../src/postgres/index.js";

// A transactional double with rollback and lost-ack injection. External effects
// live outside these maps, as an HTTP service or host's separate transaction does.
function database() {
  let claims = new Map<string, unknown>();
  let results = new Map<string, unknown>();
  let transactions = 0;
  let rollbackTransaction = 0;
  let loseAckTransaction = 0;
  let active = false;
  const key = (values: readonly unknown[]) => JSON.stringify(values.slice(0, 2));
  const query: PostgresSqlClient["query"] = async (sql, values = []) => {
    let rows: unknown[] = [];
    if (sql.includes("pg_advisory_xact_lock")) { /* serialized by the test */ }
    else if (sql.startsWith("SELECT result FROM handrail_ai_tool_ledger")) {
      if (results.has(key(values))) rows = [{ result: results.get(key(values)) }];
    } else if (sql.startsWith("SELECT version::text AS version,payload FROM handrail_ai_documents")) {
      if (claims.has(key(values))) rows = [{ version: "1", payload: claims.get(key(values)) }];
    } else if (sql.startsWith("INSERT INTO handrail_ai_documents")) {
      if (claims.has(key(values))) throw new Error("duplicate claim");
      claims.set(key(values), JSON.parse(String(values[2])));
    } else if (sql.startsWith("INSERT INTO handrail_ai_tool_ledger")) {
      if (results.has(key(values))) throw new Error("duplicate result");
      results.set(key(values), JSON.parse(String(values[2])));
    } else throw new Error(`Unexpected SQL: ${sql}`);
    return { rows, rowCount: rows.length } as never;
  };
  const client: PostgresSqlClient = {
    query,
    transaction: async (operation) => {
      expect(active).toBe(false);
      active = true;
      const number = ++transactions;
      const previousClaims = new Map(claims), previousResults = new Map(results);
      let result;
      try {
        result = await operation(client);
        if (number === rollbackTransaction) throw new Error("transaction rolled back");
      } catch (cause) {
        claims = previousClaims; results = previousResults;
        throw cause;
      } finally { active = false; }
      if (number === loseAckTransaction) throw new Error("commit acknowledgement lost");
      return result;
    },
  };
  return { client, inTransaction: () => active,
    rollback: (number: number) => { rollbackTransaction = number; },
    loseAck: (number: number) => { loseAckTransaction = number; },
    seedLegacy: (tenant: string, call: string, result: unknown) => results.set(JSON.stringify([tenant, call]), result) };
}

describe("durable tool dispatch admission", () => {
  it("commits admission before dispatch, retains results and isolates tenants", async () => {
    const db = database();
    const persistence = new PostgresAiPersistence(db.client);
    const execute = vi.fn(async () => {
      expect(db.inTransaction()).toBe(false);
      return { applied: true };
    });
    await expect(persistence.getOrExecuteTool("tenant", "call", execute)).resolves.toEqual({ applied: true });
    await expect(new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute)).resolves.toEqual({ applied: true });
    expect(execute).toHaveBeenCalledOnce();
    await persistence.getOrExecuteTool("other-tenant", "call", execute);
    expect(execute).toHaveBeenCalledTimes(2);
    db.seedLegacy("tenant", "old", { legacy: true });
    await expect(persistence.getOrExecuteTool("tenant", "old", execute)).resolves.toEqual({ legacy: true });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each(["dispatch_failure", "result_rollback"])("does not repeat external work after %s", async (failure) => {
    const db = database();
    if (failure === "result_rollback") db.rollback(2);
    let externalChanges = 0;
    const execute = vi.fn(async () => {
      externalChanges += 1;
      if (failure === "dispatch_failure") throw new Error("process stopped after external commit");
      return { applied: true };
    });
    await expect(new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute)).rejects.toThrow();
    await expect(new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute))
      .rejects.toBeInstanceOf(PostgresToolExecutionUncertainError);
    expect(externalChanges).toBe(1);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not dispatch when admission acknowledgement is lost", async () => {
    const db = database(); db.loseAck(1);
    const execute = vi.fn(async () => "result");
    await expect(new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute)).rejects.toThrow("acknowledgement");
    await expect(new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute))
      .rejects.toBeInstanceOf(PostgresToolExecutionUncertainError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reuses committed completion when its acknowledgement was lost", async () => {
    const db = database(); db.loseAck(2);
    const execute = vi.fn(async () => "result");
    await expect(new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute)).rejects.toThrow("acknowledgement");
    await expect(new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute)).resolves.toBe("result");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("blocks another worker while a claimed execution is running and returns its eventual result", async () => {
    const db = database();
    let finish!: (value: string) => void;
    const execute = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const pending = new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await expect(new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute))
      .rejects.toBeInstanceOf(PostgresToolExecutionUncertainError);
    finish("result");
    await expect(pending).resolves.toBe("result");
    await expect(new PostgresAiPersistence(db.client).getOrExecuteTool("tenant", "call", execute)).resolves.toBe("result");
    expect(execute).toHaveBeenCalledOnce();
  });
});
