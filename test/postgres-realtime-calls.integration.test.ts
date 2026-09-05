import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";
import { DurableRealtimeCallConflictError, PostgresAiPersistence, PostgresRealtimeCallStore,
  type PostgresSqlClient } from "../src/postgres/index.js";

it("retains call admission, remote identity and end requests across workers, races and uncertain commits", async () => {
  const database = new PGlite();
  let loseAck = false;
  let now = 1_000;
  const adapt = (db: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = { async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      const result = await db.query<T>(sql, values ? [...values] : []);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    }, transaction: (operation) => operation(client) };
    return client;
  };
  const sql: PostgresSqlClient = { query: adapt(database).query, async transaction(operation) {
    const result = await database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">)));
    if (loseAck) { loseAck = false; throw new Error("commit acknowledgement lost"); }
    return result;
  } };
  const persistence = new PostgresAiPersistence(sql);
  const store = () => new PostgresRealtimeCallStore(new PostgresAiPersistence(sql), "environment", "owner", { clock: () => now, leaseMs: 1_000 });
  const input = { callId: "voice-1", conversationId: "conversation-1", workerId: "worker-a", fingerprint: "host-reviewed-call-settings" };
  try {
    await persistence.migrate();
    const results = await Promise.all([store().admit(input), store().admit({ ...input, workerId: "worker-b" })]);
    expect(results.filter((value) => value.created)).toHaveLength(1);
    const worker = results.find((value) => value.created)!.call.workerId;
    await expect(store().beginCreation(input.callId, "other-worker")).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await expect(store().attachProviderCall(input.callId, worker, "remote-1")).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await store().beginCreation(input.callId, worker);
    await Promise.all([store().attachProviderCall(input.callId, worker, "remote-1"), store().requestEnd(input.callId)]);
    expect(await store().get(input.callId)).toMatchObject({ status: "ending", providerCallRef: "remote-1", creationStarted: true });
    await expect(store().renewLease(input.callId, worker)).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await expect(store().attachProviderCall(input.callId, worker, "different-remote")).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await store().confirmEnded(input.callId, "remote-1");
    const ended = await store().get(input.callId);
    expect(await store().requestEnd(input.callId)).toEqual(ended);
    expect(await store().attachProviderCall(input.callId, worker, "remote-1")).toEqual(ended);
    expect(await store().admit({ ...input, workerId: "new-worker" })).toMatchObject({ created: false, call: { status: "ended" } });
    await expect(store().admit({ ...input, conversationId: "different-conversation" })).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    await expect(store().admit({ ...input, fingerprint: "changed-policy" })).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);

    await store().admit({ ...input, callId: "cancel-before-dispatch" });
    expect(await store().requestEnd("cancel-before-dispatch")).toMatchObject({ status: "ended", creationStarted: false });
    await expect(store().beginCreation("cancel-before-dispatch", input.workerId)).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);

    await store().admit({ ...input, callId: "expired-worker" });
    await store().beginCreation("expired-worker", input.workerId);
    await store().attachProviderCall("expired-worker", input.workerId, "remote-expired");
    now += 1_001;
    expect(await store().get("expired-worker")).toMatchObject({ status: "uncertain", providerCallRef: "remote-expired" });
    await expect(store().renewLease("expired-worker", input.workerId)).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    expect(await store().admit({ ...input, callId: "expired-worker" })).toMatchObject({ created: false, call: { status: "uncertain" } });
    await store().requestEnd("expired-worker");
    await expect(store().confirmEnded("expired-worker", "wrong-remote")).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    loseAck = true;
    await expect(store().confirmEnded("expired-worker", "remote-expired")).rejects.toThrow("acknowledgement lost");
    expect(await store().confirmEnded("expired-worker", "remote-expired")).toMatchObject({ status: "ended" });

    loseAck = true;
    await expect(store().admit({ ...input, callId: "lost-admission" })).rejects.toThrow("acknowledgement lost");
    expect(await store().admit({ ...input, callId: "lost-admission" })).toMatchObject({ created: false });
    await store().admit({ ...input, callId: "lost-creation-claim" });
    loseAck = true;
    await expect(store().beginCreation("lost-creation-claim", input.workerId)).rejects.toThrow("acknowledgement lost");
    await expect(store().beginCreation("lost-creation-claim", input.workerId)).rejects.toBeInstanceOf(DurableRealtimeCallConflictError);
    expect(await store().get("lost-creation-claim")).toMatchObject({ status: "starting", creationStarted: true, providerCallRef: null });
    expect(await new PostgresRealtimeCallStore(persistence, "other-environment", "owner").get(input.callId)).toBeNull();
    expect(await new PostgresRealtimeCallStore(persistence, "environment", "other-owner").get(input.callId)).toBeNull();
    const rows = await database.query<{ count: number }>("SELECT count(*)::int AS count FROM handrail_ai_documents WHERE kind='realtime_call'");
    expect(rows.rows[0]?.count).toBe(5);
    const firstPage = await store().list({ limit: 2 });
    const secondPage = await store().list({ limit: 2, afterCallId: firstPage.nextCallId! });
    const lastPage = await store().list({ limit: 2, afterCallId: secondPage.nextCallId! });
    expect(lastPage.nextCallId).toBeNull();
    expect(new Set([...firstPage.calls, ...secondPage.calls, ...lastPage.calls].map((call) => call.callId)).size).toBe(5);
    await expect(store().list({ limit: 101 })).rejects.toThrow("page size");
  } finally { await database.close(); }
}, 30_000);
