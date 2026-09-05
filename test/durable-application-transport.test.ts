import { describe, expect, it, vi } from "vitest";

import {
  createDurableApplicationTransport,
  durableApplicationTurnStartMatches,
  InMemoryDurableApplicationTurnStore,
} from "../src/transports/durable.js";
import type { ConversationTransport, TurnObservationResult } from "../src/transports/types.js";
import type { ConversationTurnId } from "../src/conversation/events.js";

type Event = { readonly id: string; readonly text: string };
type Request = { readonly ref: string };

const checkpoint = (id: string | null) => ({ lastAppliedEventId: id, lastAppliedCursor: id, lastAppliedRevision: null });
const capabilities: ConversationTransport<Event, Request>["capabilities"] = {
  authoritativeCancellation: { supported: false }, documentInput: { supported: false },
  attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
};

function delegate(events: readonly Event[], result: TurnObservationResult = { status: "completed", checkpoint: checkpoint("2") }) {
  const startTurn = vi.fn<ConversationTransport<Event, Request>["startTurn"]>(async (input) => ({ ok: true, value: {
    conversationId: input.conversationId, turnId: `provider-${input.conversationTurnId}`, mutationId: input.mutationId,
    observation: { events: (async function* () { for (const event of events) yield event; })(),
      result: Promise.resolve(result), disconnect() {} },
  } }));
  const transport: ConversationTransport<Event, Request> = { capabilities, startTurn,
    async resumeTurn() { return { ok: false, error: { code: "not_found", message: "not supported", retryable: false } }; } };
  return { transport, startTurn };
}

function durable(store: InMemoryDurableApplicationTurnStore<Request, Event>, inner: ConversationTransport<Event, Request>, workerId: string) {
  return createDurableApplicationTransport({ delegate: inner, store, workerId, pollMilliseconds: 25,
    requestCodec: { encode: (request) => request, decode: (request) => request, fingerprint: (request) => request.ref },
    checkpointForEvent: (event) => checkpoint(event.id) });
}

const input = { conversationId: "conversation-1", conversationTurnId: "turn-1" as ConversationTurnId,
  mutationId: "mutation-1", idempotencyKey: "start-1", request: { ref: "request-1" } };
async function collect(events: AsyncIterable<Event>) { const output: Event[] = []; for await (const event of events) output.push(event); return output; }

describe("createDurableApplicationTransport", () => {
  it.each(["completed", "failed", "cancelled"] as const)("publishes %s without observers and does not republish on replay", async (status) => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const terminal: TurnObservationResult = status === "failed"
      ? { status, checkpoint: checkpoint("2"), error: { code: "unavailable", message: "Failed", retryable: true } }
      : { status, checkpoint: checkpoint("2") };
    const inner = delegate([{ id: "2", text: "result" }], terminal);
    const onTurnStatusChanged = vi.fn();
    const transport = createDurableApplicationTransport({ delegate: inner.transport, store, workerId: "writer",
      pollMilliseconds: 25, onTurnStatusChanged,
      requestCodec: { encode: (request: Request) => request, decode: (request) => request, fingerprint: (request) => request.ref },
      checkpointForEvent: (event) => checkpoint(event.id) });
    const started = await transport.startTurn(input);
    if (!started.ok) throw new Error(started.error.message);
    started.value.observation.disconnect();
    // Never consume the original stream: completion must belong to the worker.
    await vi.waitFor(() => expect(onTurnStatusChanged.mock.calls.map(([update]) => update.status))
      .toEqual(["pending", "running", status]));
    expect((await store.load(input.conversationId, input.conversationTurnId))?.record.status).toBe(status);
    const replay = await transport.startTurn(input);
    if (!replay.ok) throw new Error(replay.error.message);
    await collect(replay.value.observation.events);
    expect((await replay.value.observation.result).status).toBe(status);
    const resumed = await transport.resumeTurn({ conversationId: input.conversationId,
      turnId: input.conversationTurnId, resumeFrom: checkpoint(null) });
    if (!resumed.ok) throw new Error(resumed.error.message);
    await collect(resumed.value.events);
    expect((await resumed.value.result).status).toBe(status);
    expect(onTurnStatusChanged).toHaveBeenCalledTimes(3);
    expect(inner.startTurn).toHaveBeenCalledOnce();
  });

  it("keeps a durable success when status delivery fails", async () => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const diagnostics = vi.fn();
    const transport = createDurableApplicationTransport({ delegate: delegate([]).transport, store, workerId: "writer",
      pollMilliseconds: 25, diagnostics, onTurnStatusChanged: () => { throw new Error("delivery unavailable"); },
      requestCodec: { encode: (request: Request) => request, decode: (request) => request, fingerprint: (request) => request.ref },
      checkpointForEvent: (event) => checkpoint(event.id) });
    await transport.startTurn(input);
    await vi.waitFor(async () => expect((await store.load(input.conversationId, input.conversationTurnId))?.record.status)
      .toBe("completed"));
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      domain: "activity", operation: "durable_turn_status", code: "activity_update_failed" }));
  });
  it("matches idempotent JSON identity after Postgres jsonb reorders keys", () => {
    const base = { schemaVersion: 1 as const, conversationId: "conversation-1", turnId: "turn-1",
      mutationId: "mutation-1", idempotencyKey: "start-1", requestFingerprint: "request-1",
      delegateTurnId: null, status: "pending" as const, attempt: 0, events: [], terminal: null,
      cancellation: null, lease: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(durableApplicationTurnStartMatches({ ...base, request: { b: 2, a: 1 } },
      { ...base, request: { a: 1, b: 2 } })).toBe(true);
  });
  it("starts once, checkpoints events, and replays after a process change", async () => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const firstDelegate = delegate([{ id: "1", text: "hello" }, { id: "2", text: " world" }]);
    const first = durable(store, firstDelegate.transport, "worker-a");
    const started = await first.startTurn(input);
    expect(started.ok).toBe(true); if (!started.ok) return;
    expect(await collect(started.value.observation.events)).toEqual([
      { id: "1", text: "hello" }, { id: "2", text: " world" },
    ]);
    expect((await started.value.observation.result).status).toBe("completed");

    const secondDelegate = delegate([]);
    const second = durable(store, secondDelegate.transport, "worker-b");
    const resumed = await second.resumeTurn({ conversationId: input.conversationId, turnId: input.conversationTurnId,
      resumeFrom: checkpoint("1") });
    expect(resumed.ok).toBe(true); if (!resumed.ok) return;
    expect(await collect(resumed.value.events)).toEqual([{ id: "2", text: " world" }]);
    expect((await resumed.value.result).status).toBe("completed");
    expect(firstDelegate.startTurn).toHaveBeenCalledTimes(1);
    expect(secondDelegate.startTurn).not.toHaveBeenCalled();
  });

  it("makes identical starts idempotent and rejects changed request identity", async () => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const inner = delegate([]);
    const transport = durable(store, inner.transport, "worker-a");
    expect((await transport.startTurn(input)).ok).toBe(true);
    expect((await transport.startTurn(input)).ok).toBe(true);
    const conflict = await transport.startTurn({ ...input, request: { ref: "request-2" } });
    expect(conflict).toEqual({ ok: false, error: { code: "conflict",
      message: "The turn start conflicts with retained identity.", retryable: false } });
    await vi.waitFor(() => expect(inner.startTurn).toHaveBeenCalledTimes(1));
  });

  it("allows only one process to claim a shared pending turn", async () => {
    const store = new InMemoryDurableApplicationTurnStore<Request, Event>();
    const innerA = delegate([]), innerB = delegate([]);
    const a = durable(store, innerA.transport, "worker-a"), b = durable(store, innerB.transport, "worker-b");
    await Promise.all([a.startTurn(input), b.startTurn(input)]);
    await vi.waitFor(() => expect(innerA.startTurn.mock.calls.length + innerB.startTurn.mock.calls.length).toBe(1));
  });

  it("persists cancellation, forwards it once, and emits nothing after the cancelled terminal", async () => {
    let finish!: () => void, cancellationCalls = 0;
    const cancelled = new Promise<void>((resolve) => { finish = resolve; });
    const inner: ConversationTransport<Event, Request> = {
      capabilities: { ...capabilities, authoritativeCancellation: { supported: true, capability: {
        async cancelTurn() { cancellationCalls += 1; finish();
          return { ok: true as const, value: { status: "cancellation_requested" as const } }; },
      } } },
      async startTurn(value) { return { ok: true, value: { conversationId: value.conversationId,
        turnId: "provider-turn", mutationId: value.mutationId, observation: {
          events: (async function* () { await cancelled; yield* [] as Event[]; })(),
          result: cancelled.then(() => ({ status: "cancelled" as const, checkpoint: checkpoint(null) })),
          disconnect() { finish(); },
        } } }; },
      async resumeTurn() { return { ok: false, error: { code: "not_found", message: "unused", retryable: false } }; },
    };
    const transport = durable(new InMemoryDurableApplicationTurnStore<Request, Event>(), inner, "worker-cancel");
    const started = await transport.startTurn(input);
    if (!started.ok) throw new Error(started.error.message);
    const cancellation = transport.capabilities.authoritativeCancellation;
    if (!cancellation.supported) throw new Error("cancellation missing");
    expect(await cancellation.capability.cancelTurn({ conversationId: input.conversationId,
      turnId: input.conversationTurnId, mutationId: "cancel-mutation", idempotencyKey: "cancel-idem",
      reason: "user" })).toMatchObject({ ok: true, value: { status: "cancellation_requested" } });
    expect(await collect(started.value.observation.events)).toEqual([]);
    expect(await started.value.observation.result).toMatchObject({ status: "cancelled" });
    await vi.waitFor(() => expect(cancellationCalls).toBe(1));
  });
});
