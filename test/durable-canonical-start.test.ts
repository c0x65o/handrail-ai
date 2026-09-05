import { createHandrailAssistant, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import type { PostgresAssistantPersistence, PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { InMemoryConversationCatalog } from "../src/conversation/in-memory-catalog.js";
import { InMemoryToolExecutionLedger } from "../src/tools/executor.js";
import { replayConversation } from "../src/conversation/replay.js";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { parseConversationEvent, type ConversationEventPayload, type ConversationId, type ConversationTurnId } from "../src/conversation/events.js";
import { qualifyDurableApplicationTurnStarts } from "../src/sync/durable-application-adapter.js";
import { createDurableApplicationTransport, InMemoryDurableApplicationTurnStore } from "../src/transports/durable.js";
import type { ChatRequest, StreamEvent } from "../src/protocol.js";
import type { ConversationTransport } from "../src/transports/types.js";

const conversationId = "conversation-1" as ConversationId;
const turnId = "turn-1" as ConversationTurnId;
const checkpoint = { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null };
const request: ChatRequest = { protocol_version: "handrail.ai-runtime.v1", continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Update once" }] }], tools: [], tool_results: [],
  generation: { max_output_tokens: 1000, temperature: 0 }, correlation_hints: {} };
const input = { conversationId, conversationTurnId: turnId, mutationId: "admission-1", idempotencyKey: "start-1", request };

async function append(store: InMemoryConversationEventStore, payload: ConversationEventPayload, mutationId?: string) {
  const previous = await store.read({ conversationId });
  const revision = previous.entries.at(-1)?.event.revision ?? 0;
  await store.append({ conversationId, expectedRevision: revision || null, events: [parseConversationEvent({
    version: 1, event_id: `event-${revision + 1}`, conversation_id: conversationId, revision: revision + 1,
    occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "assistant" }, source: { type: "sync" },
    ...(mutationId ? { mutation_id: mutationId } : {}), payload,
  })] });
}
async function fixture() {
  const events = new InMemoryConversationEventStore();
  await append(events, { type: "message.created", message_id: "message-1" as never, role: "user",
    content: [{ type: "text", text: "Update once" }] }, input.mutationId);
  await append(events, { type: "turn.started", turn_id: turnId, input_message_ids: ["message-1" as never] });
  const start = vi.fn<ConversationTransport<StreamEvent, ChatRequest>["startTurn"]>(async (value) => ({ ok: true, value: {
    conversationId: value.conversationId, turnId: value.conversationTurnId, mutationId: value.mutationId,
    observation: { events: (async function* () {})(), result: Promise.resolve({ status: "completed", checkpoint }), disconnect() {} },
  } }));
  const delegate: ConversationTransport<StreamEvent, ChatRequest> = {
    capabilities: { authoritativeCancellation: { supported: false }, documentInput: { supported: false },
      attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false } },
    startTurn: start,
    async resumeTurn() { return { ok: false, error: { code: "not_found", message: "No provider resume", retryable: false } }; },
  };
  const turns = new InMemoryDurableApplicationTurnStore<ChatRequest, StreamEvent>();
  const durable = createDurableApplicationTransport({ store: turns,
    delegate: qualifyDurableApplicationTurnStarts(delegate, events), workerId: "worker", pollMilliseconds: 25,
    requestCodec: { encode: (value: ChatRequest) => value, decode: (value: ChatRequest) => value,
      fingerprint: (value: ChatRequest) => createHash("sha256").update(JSON.stringify(value)).digest("hex") }, checkpointForEvent: () => checkpoint });
  return { events, turns, durable, start, delegate };
}

it.each(["cancelled", "completed", "failed", "cancellation_requested"] as const)("does not execute a delayed start after canonical %s", async (status) => {
  const { events, durable, start } = await fixture();
  await append(events, status === "completed"
    ? { type: "turn.completed", turn_id: turnId, outcome: "stop", output_message_ids: [] }
    : status === "failed"
    ? { type: "turn.failed", turn_id: turnId, error: { code: "unavailable", message: "Stopped", retryable: false } }
    : { type: status === "cancelled" ? "turn.cancelled" : "turn.cancellation_requested", turn_id: turnId, reason: "user" });
  const handle = await durable.startTurn(input);
  if (!handle.ok) throw new Error(handle.error.message);
  for await (const event of handle.value.observation.events) { void event; }
  expect(start).not.toHaveBeenCalled();
  expect(await handle.value.observation.result).toMatchObject({ status: "failed", error: { retryable: false } });
});

it("still replays retained completed work without executing again", async () => {
  const { events, durable, start } = await fixture();
  const first = await durable.startTurn(input);
  if (!first.ok) throw new Error(first.error.message);
  for await (const event of first.value.observation.events) { void event; }
  expect((await first.value.observation.result).status).toBe("completed");
  await append(events, { type: "turn.completed", turn_id: turnId, outcome: "stop", output_message_ids: [] });
  const replay = await durable.startTurn(input);
  if (!replay.ok) throw new Error(replay.error.message);
  for await (const event of replay.value.observation.events) { void event; }
  expect((await replay.value.observation.result).status).toBe("completed");
  expect(start).toHaveBeenCalledOnce();
});


it("atomically reserves cancellation before a delayed start without decoding input", async () => {
  const { durable, start, turns } = await fixture();
  const cancel = { conversationId, turnId, mutationId: "cancel-1", idempotencyKey: "cancel-1", reason: "user" as const };
  expect(await durable.cancelTurnBeforeStart(cancel)).toMatchObject({ ok: true, value: { status: "already_terminal" } });
  const handle = await durable.startTurn(input);
  if (!handle.ok) throw new Error(handle.error.message);
  for await (const event of handle.value.observation.events) { void event; }
  expect(await handle.value.observation.result).toMatchObject({ status: "cancelled" });
  expect(start).not.toHaveBeenCalled();
  expect((await turns.load(conversationId, turnId))?.record).toMatchObject({ status: "cancelled", request: null, cancelledBeforeStart: true });
});

it("uses ordinary cancellation when a start wins creation", async () => {
  const { durable, start, turns } = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const decode = vi.fn(async (value: ChatRequest) => { await barrier; return value; });
  const racing = createDurableApplicationTransport({ store: turns, delegate: {
    capabilities: durable.capabilities, startTurn: start, resumeTurn: durable.resumeTurn,
  }, workerId: "racing", pollMilliseconds: 25,
    requestCodec: { encode: (value: ChatRequest) => value, decode, fingerprint: () => "request" }, checkpointForEvent: () => checkpoint });
  const handle = await racing.startTurn(input);
  if (!handle.ok) throw new Error(handle.error.message);
  await vi.waitFor(() => expect(decode).toHaveBeenCalled());
  expect(await racing.cancelTurnBeforeStart({ conversationId, turnId, mutationId: "cancel-race", idempotencyKey: "cancel-race", reason: "user" }))
    .toMatchObject({ ok: true, value: { status: "cancellation_requested" } });
  try {
    for await (const event of handle.value.observation.events) { void event; }
  expect(await handle.value.observation.result).toMatchObject({ status: "cancelled" });
    expect(start).not.toHaveBeenCalled();
    expect((await turns.load(conversationId, turnId))?.record.cancelledBeforeStart).toBeUndefined();
  } finally { release(); }
});


it("cancels an admitted turn through the high-level HTTP gateway before start exists", async () => {
  const { events, turns, start, delegate } = await fixture();
  const context: HandrailAssistantAuthorizationContext = { principalId: "alice", tenantId: "tenant", scopeId: "alice",
    attribution: {
      organization: { id: "org", source: "server_derived", trust: "authoritative" },
      project: { id: "project", source: "server_derived", trust: "authoritative" },
      service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
      known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
      session: { id: null, source: "server_derived", trust: "authoritative" },
      automation: { id: null, source: "server_derived", trust: "authoritative" },
    } };
  const records: import("../src/conversation/activity.js").ConversationActivityRecord[] = [];
  const bundle = { events, durableTurns: turns, toolLedger: new InMemoryToolExecutionLedger(),
    approvals: new InMemoryApprovalProposalStore({ authorize: () => "allow" }),
    catalog: new InMemoryConversationCatalog({ authorize: () => "allow" }),
    activity: { async list() { return records; }, async upsert(record: typeof records[number]) { records.push(record); return record; } },
    usageReceiptSink: null, usageAdmissions: null,
  } as unknown as PostgresAssistantPersistenceBundle<HandrailAssistantAuthorizationContext>;
  const assistant = await createHandrailAssistant({ id: "cancel-before-start", authorize: () => context,
    persistence: { attachmentLimits: { maximumBytes: 1000, acceptedMediaTypes: ["text/plain"], ttlMilliseconds: 60000 },
      forScope: () => bundle } as unknown as PostgresAssistantPersistence,
    provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
      streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
      document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
      context_window_tokens: null, max_output_tokens: null,
    } }, createTransport: () => delegate } });
  const post = (path: string, body: unknown) => assistant.handle(new Request(`https://example.test/ai/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  const cancel = { conversationId, turnId, mutationId: "cancel-http", idempotencyKey: "cancel-http", reason: "user" };
  expect(await turns.load(conversationId, turnId)).toBeNull();
  const unknown = await post("turns/cancel", { ...cancel, turnId: "unknown" });
  expect(await unknown.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(await turns.load(conversationId, "unknown")).toBeNull();
  const response = await post("turns/cancel", cancel);
  expect(await response.json()).toMatchObject({ ok: true, value: { status: "already_terminal" } });
  const replay = await replayConversation({ conversationId, eventStore: events, checkpointPolicy: false });
  try {
    expect(replay.state.replay_error).toBeNull();
    expect(replay.state.turns.at(-1)).toMatchObject({ status: "cancelled", remote_may_still_be_running: false,
      cancellation_reason: "user", cancellation_requested_reason: "user" });
  } finally { replay.store.destroy(); }
  const late = await post("turns/start", input);
  expect(late.status).toBe(200);
  expect(await late.text()).toContain('"status":"cancelled"');
  expect(start).not.toHaveBeenCalled();
  expect(records.at(-1)).toMatchObject({ turnStatus: "completed", unread: true });
  const revision = await events.getLatestRevision(conversationId);
  expect(await (await post("turns/cancel", cancel)).json()).toMatchObject({ ok: true });
  expect(await events.getLatestRevision(conversationId)).toBe(revision);
});
