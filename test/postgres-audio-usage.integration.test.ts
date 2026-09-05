import { PGlite } from "@electric-sql/pglite";
import { expect, it, vi } from "vitest";
import { PostgresAiPersistence, PostgresAIRuntimeUsageOutbox, PostgresOpenAIAudioUsageEvidenceStore,
  PostgresPersistenceConflictError, type OpenAIAudioUsageEvidence, type PostgresSqlClient } from "../src/postgres/index.js";

it("retains immutable audio evidence across concurrent capture, lost acknowledgement and restart without billing it", async () => {
  const database = new PGlite();
  let loseAcknowledgement = false;
  const adapt = (queryable: Pick<PGlite, "query">): PostgresSqlClient => {
    const client: PostgresSqlClient = {
      async query<T extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
        const result = await queryable.query<T>(sql, values ? [...values] : []);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
      transaction: (operation) => operation(client),
    };
    return client;
  };
  const sql: PostgresSqlClient = { query: adapt(database).query, async transaction(operation) {
    const value = await database.transaction((tx) => operation(adapt(tx as unknown as Pick<PGlite, "query">)));
    if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error("commit acknowledgement lost"); }
    return value;
  } };
  const evidence: OpenAIAudioUsageEvidence = { version: 1, context: {
    usage_receipt_id: "audio-1" as never, conversation_id: "conversation-1" as never, turn_id: "turn-1" as never,
    logical_request_id: "voice-session-1-response-1", trace_id: "trace-1",
    attempt: { id: "attempt-1", index: 0 }, continuation: { id: "response-1", index: 0 },
    provider_id: "openai", model_id: "gpt-4o-mini-transcribe", source: "provider", terminal_status: "completed",
    attribution: { organization: { id: "org-1", source: "server_derived", trust: "authoritative" },
      project: { id: "project-1", source: "server_derived", trust: "authoritative" },
      service_environment: { id: "environment-1", source: "server_derived", trust: "authoritative" },
      known_user: { id: "user-1", source: "server_derived", trust: "authoritative" },
      session: { id: "session-1", source: "server_derived", trust: "authoritative" },
      automation: { id: null, source: "server_derived", trust: "authoritative" } },
  }, usage: { type: "duration", seconds: 2.75 } };
  try {
    const persistence = new PostgresAiPersistence(sql);
    await persistence.migrate();
    const store = new PostgresOpenAIAudioUsageEvidenceStore(persistence, "tenant-1", "environment-1");
    // Commit succeeds but caller cannot know it. The same identity must repair
    // acknowledgement without overwriting or creating a second evidence record.
    loseAcknowledgement = true;
    await expect(store.capture(evidence)).rejects.toThrow("acknowledgement lost");
    const restarted = new PostgresOpenAIAudioUsageEvidenceStore(new PostgresAiPersistence(sql), "tenant-1", "environment-1");
    await Promise.all([restarted.capture(evidence), restarted.capture(evidence)]);
    expect(await restarted.get("audio-1")).toEqual(evidence);
    const next = { ...evidence, context: { ...evidence.context, usage_receipt_id: "audio-2" as never } };
    await Promise.all([restarted.capture(next), restarted.capture(next)]);
    expect((await restarted.list({ limit: 1 })).map((row) => row.context.usage_receipt_id)).toEqual(["audio-1"]);
    expect((await restarted.list({ afterId: "audio-1", limit: 1 })).map((row) => row.context.usage_receipt_id)).toEqual(["audio-2"]);
    await expect(restarted.capture({ ...evidence, usage: { type: "duration", seconds: 3 } }))
      .rejects.toBeInstanceOf(PostgresPersistenceConflictError);
    await expect(restarted.capture({ ...evidence, context: { ...evidence.context, model_id: "other-model" } }))
      .rejects.toBeInstanceOf(PostgresPersistenceConflictError);
    const foreign = new PostgresOpenAIAudioUsageEvidenceStore(persistence, "tenant-2", "environment-1");
    expect(await foreign.get("audio-1")).toBeNull();
    expect(await foreign.list()).toEqual([]);
    const wrongEnvironment = new PostgresOpenAIAudioUsageEvidenceStore(persistence, "tenant-1", "environment-2");
    expect(await wrongEnvironment.list()).toEqual([]);
    await expect(wrongEnvironment.capture(evidence)).rejects.toThrow("environment");
    const query = vi.spyOn(sql, "query");
    await expect(restarted.list({ limit: 0 })).rejects.toThrow(TypeError);
    expect(query).not.toHaveBeenCalled();
    expect(await new PostgresAIRuntimeUsageOutbox(persistence, "tenant-1", "environment-1").pending(100)).toEqual([]);
    const rows = await database.query<{ version: number; kind: string; payload: unknown }>("SELECT version,kind,payload FROM handrail_ai_documents ORDER BY record_id");
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.version === 1 && row.kind === "audio_usage_evidence")).toBe(true);
    expect(JSON.stringify(rows.rows)).not.toContain("provider_cost");
  } finally { await database.close(); }
}, 30_000);
