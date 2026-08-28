import { describe, expect, it } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  type ChatRequest,
} from "../src/protocol.js";
import * as browserEntry from "../src/browser/index.js";
import * as coreEntry from "../src/index.js";
import {
  MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION,
  ManagedRuntimeTurnStateStoreConflictError,
  parseManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateStore,
} from "../src/server/managed.js";

function chatRequest(): ChatRequest {
  return {
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    continuation_of: null,
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
    tool_results: [],
    generation: { max_output_tokens: 64, temperature: 0.2 },
    correlation_hints: {},
  };
}

function turnState(): ManagedRuntimeTurnStateRecord {
  const request = chatRequest();
  return {
    schemaVersion: MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION,
    conversationId: "conversation_managed",
    turnId: "request_managed",
    conversationTurnId: "turn_managed",
    mutationId: "mutation_managed",
    request,
    serializedBody: JSON.stringify(request),
    idempotencyKey: "managed.key-1",
  };
}

function keyFor(conversationId: string, turnId: string): string {
  return `${conversationId.length}:${conversationId}${turnId}`;
}

class FakeManagedRuntimeTurnStateStore implements ManagedRuntimeTurnStateStore {
  readonly #records = new Map<string, ManagedRuntimeTurnStateRecord>();

  async load(
    conversationId: string,
    turnId: string,
  ): Promise<ManagedRuntimeTurnStateRecord | null> {
    const stored = this.#records.get(keyFor(conversationId, turnId));
    return stored === undefined
      ? null
      : parseManagedRuntimeTurnStateRecord(stored);
  }

  async save(
    value: ManagedRuntimeTurnStateRecord,
  ): Promise<ManagedRuntimeTurnStateRecord> {
    const record = parseManagedRuntimeTurnStateRecord(value);
    const key = keyFor(record.conversationId, record.turnId);
    const stored = this.#records.get(key);
    if (stored !== undefined && JSON.stringify(stored) !== JSON.stringify(record)) {
      throw new ManagedRuntimeTurnStateStoreConflictError(
        "The managed-runtime replay identity is already stored with different state.",
        {
          code: "replay_identity_conflict",
          conversationId: record.conversationId,
          turnId: record.turnId,
        },
      );
    }
    if (stored === undefined) this.#records.set(key, record);
    return parseManagedRuntimeTurnStateRecord(stored ?? record);
  }
}

describe("ManagedRuntimeTurnStateStore", () => {
  it("is available only from the trusted-server managed entry", () => {
    expect("parseManagedRuntimeTurnStateRecord" in coreEntry).toBe(false);
    expect("ManagedRuntimeTurnStateStoreConflictError" in coreEntry).toBe(false);
    expect("parseManagedRuntimeTurnStateRecord" in browserEntry).toBe(false);
    expect("ManagedRuntimeTurnStateStoreConflictError" in browserEntry).toBe(false);
  });

  it("parses valid state and clones saved and loaded round trips", async () => {
    const store = new FakeManagedRuntimeTurnStateStore();
    const input = turnState();
    const saved = await store.save(input);

    input.request.messages[0]!.content[0] = { type: "text", text: "mutated input" };
    saved.request.messages[0]!.content[0] = { type: "text", text: "mutated output" };

    const loaded = await store.load("conversation_managed", "request_managed");
    expect(loaded).toEqual(turnState());
    expect(loaded).not.toBe(saved);
    expect(loaded!.request).not.toBe(saved.request);
  });

  it("rejects unsupported versions and malformed canonical requests", () => {
    expect(() =>
      parseManagedRuntimeTurnStateRecord({ ...turnState(), schemaVersion: 2 }),
    ).toThrow(/schemaVersion/);
    expect(() =>
      parseManagedRuntimeTurnStateRecord({
        ...turnState(),
        request: { ...chatRequest(), messages: [] },
      }),
    ).toThrow(/messages/);
    expect(() =>
      parseManagedRuntimeTurnStateRecord({
        ...turnState(),
        serializedBody: `${JSON.stringify(chatRequest())}\n`,
      }),
    ).toThrow(/serializedBody/);
  });

  it("accepts an identical save for the same durable key", async () => {
    const store = new FakeManagedRuntimeTurnStateStore();
    const first = await store.save(turnState());
    const second = await store.save(turnState());

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it.each([
    ["serialized body", (record: ManagedRuntimeTurnStateRecord) => {
      const request = { ...record.request, metadata: { replay_marker: "changed" } };
      return { ...record, request, serializedBody: JSON.stringify(request) };
    }],
    ["idempotency key", (record: ManagedRuntimeTurnStateRecord) => ({
      ...record,
      idempotencyKey: "managed.key-2",
    })],
    ["conversation turn", (record: ManagedRuntimeTurnStateRecord) => ({
      ...record,
      conversationTurnId: "turn_changed",
    })],
    ["mutation", (record: ManagedRuntimeTurnStateRecord) => ({
      ...record,
      mutationId: "mutation_changed",
    })],
  ])("rejects a conflicting %s without replacing stored state", async (_name, change) => {
    const store = new FakeManagedRuntimeTurnStateStore();
    const original = turnState();
    await store.save(original);

    await expect(store.save(change(turnState()))).rejects.toMatchObject({
      name: "ManagedRuntimeTurnStateStoreConflictError",
      code: "replay_identity_conflict",
      conversationId: original.conversationId,
      turnId: original.turnId,
    });
    await expect(store.load(original.conversationId, original.turnId)).resolves.toEqual(
      original,
    );
  });
});
