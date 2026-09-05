import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import { PostgresAiPersistence, PostgresProviderOperationStore,
  PostgresProviderOperationConflictError, PostgresProviderOperationUncertainError,
  type PostgresSqlClient } from "../src/postgres/index.js";

it("commits provider claims before dispatch and replays completed results across restart and lost acknowledgements", async () => {
  const database = new PGlite();
  let loseAck = false;
  const adapt = (queryable: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = {
      async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        const result = await queryable.query<T>(sql, values ? [...values] : []);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      }, transaction: (operation) => operation(client),
    }; return client;
  };
  const sql: PostgresSqlClient = { query: adapt(database).query, async transaction(operation) {
    const result = await database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">)));
    if (loseAck) { loseAck = false; throw new Error("commit acknowledgement lost"); }
    return result;
  } };
  const parseResult = (value: unknown) => {
    if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") throw new TypeError("Invalid transcript");
    return { text: value.text };
  };
  try {
    const persistence = new PostgresAiPersistence(sql); await persistence.migrate();
    const store = new PostgresProviderOperationStore(persistence, "tenant", "environment");
    const restarted = () => new PostgresProviderOperationStore(new PostgresAiPersistence(sql), "tenant", "environment");
    let finish!: (result: { text: string }) => void;
    const execute = vi.fn(async () => {
      const claim = await persistence.getDocument<{ status: string }>("tenant", "provider_operation", "environment", "recording-1");
      expect(claim?.value.status).toBe("started");
      return new Promise<{ text: string }>((resolve) => { finish = resolve; });
    });
    const input = { operationId: "recording-1", requestFingerprint: "audio-hash", execute, parseResult };
    const first = store.run(input);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await expect(restarted().run(input)).rejects.toBeInstanceOf(PostgresProviderOperationUncertainError);
    await expect(restarted().run({ ...input, requestFingerprint: "different" })).rejects.toBeInstanceOf(PostgresProviderOperationConflictError);
    loseAck = true; // Completion commits, then its acknowledgement is lost.
    finish({ text: "retained transcript" });
    expect(await first).toEqual({ text: "retained transcript" });
    expect(await restarted().run(input)).toEqual({ text: "retained transcript" });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(restarted().run({ ...input, requestFingerprint: "different" })).rejects.toBeInstanceOf(PostgresProviderOperationConflictError);

    const never = vi.fn(async () => ({ text: "must not dispatch" }));
    loseAck = true; // Admission may have committed; never dispatch after this error.
    const lost = { ...input, operationId: "lost-admission", execute: never };
    await expect(store.run(lost)).rejects.toThrow("acknowledgement lost");
    await expect(restarted().run(lost)).rejects.toBeInstanceOf(PostgresProviderOperationUncertainError);
    expect(never).not.toHaveBeenCalled();

    const timeout = vi.fn(async () => { throw new Error("provider outcome unknown"); });
    const uncertain = { ...input, operationId: "provider-timeout", execute: timeout };
    await expect(store.run(uncertain)).rejects.toThrow("provider outcome unknown");
    await expect(restarted().run(uncertain)).rejects.toBeInstanceOf(PostgresProviderOperationUncertainError);
    expect(timeout).toHaveBeenCalledTimes(1);
    for (const foreign of [new PostgresProviderOperationStore(persistence, "other-tenant", "environment"),
      new PostgresProviderOperationStore(persistence, "tenant", "other-environment")]) {
      expect(await foreign.run({ ...input, execute: async () => ({ text: "isolated" }) })).toEqual({ text: "isolated" });
    }
    const racedExecute = vi.fn(async () => ({ text: "one concurrent dispatch" }));
    const racedInput = { ...input, operationId: "raced", execute: racedExecute };
    const race = await Promise.allSettled([store.run(racedInput), restarted().run(racedInput)]);
    expect(racedExecute).toHaveBeenCalledTimes(1);
    expect(race.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await restarted().run(racedInput)).toEqual({ text: "one concurrent dispatch" });
    const rows = await database.query<{ status: string; version: number }>("SELECT payload->>'status' AS status,version FROM handrail_ai_documents WHERE tenant_id='tenant' AND scope_id='environment' ORDER BY record_id");
    expect(rows.rows).toHaveLength(4);
    expect(rows.rows.filter((row) => row.status === "completed")).toEqual([{ status: "completed", version: 2 }, { status: "completed", version: 2 }]);
  } finally { await database.close(); }
}, 30_000);
