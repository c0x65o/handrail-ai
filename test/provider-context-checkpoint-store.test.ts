import { describe, expect, expectTypeOf, it } from "vitest";

import {
  InMemoryProviderContextCheckpointStore,
  ProviderContextCheckpointStoreError,
  parseProviderContextIdempotencyKey,
  type ProviderContextCheckpointStore,
} from "../src/index.js";
import {
  checkpoint,
  fingerprint,
  providerContextCheckpointStoreConformanceCases,
} from "./provider-context-checkpoint-store-conformance.js";

describe("InMemoryProviderContextCheckpointStore conformance", () => {
  for (const testCase of providerContextCheckpointStoreConformanceCases(
    (limits) => new InMemoryProviderContextCheckpointStore(
      limits === undefined ? {} : { limits },
    ),
  )) {
    it(testCase.name, testCase.run);
  }
});

describe("InMemoryProviderContextCheckpointStore bounds", () => {
  it("evicts the least-recently-mutated scope deterministically", async () => {
    const store = new InMemoryProviderContextCheckpointStore({
      limits: { maxCheckpoints: 2 },
    });
    const contextFingerprint = fingerprint("model-capacity");
    await save(store, "conversation-a", contextFingerprint, "a", null);
    await save(store, "conversation-b", contextFingerprint, "b", null);
    await save(store, "conversation-a", contextFingerprint, "a2", 1);
    await save(store, "conversation-c", contextFingerprint, "c", null);

    expect(await load(store, "conversation-a", contextFingerprint)).toMatchObject({
      store_version: 2,
      checkpoint: { checkpoint_id: "checkpoint-a2" },
    });
    expect(await load(store, "conversation-b", contextFingerprint)).toBeNull();
    expect(await load(store, "conversation-c", contextFingerprint)).toMatchObject({
      checkpoint: { checkpoint_id: "checkpoint-c" },
    });
  });

  it("rejects checkpoints above the configured serialized-byte limit", async () => {
    const contextFingerprint = fingerprint("model-bytes");
    const candidate = checkpoint(
      "conversation-bytes",
      contextFingerprint,
      "checkpoint-bytes",
      "eHh4eHh4eHh4eHh4eHh4eA",
    );
    const serializedBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
    const store = new InMemoryProviderContextCheckpointStore({
      limits: { maxCheckpointSerializedBytes: serializedBytes - 1 },
    });

    await expect(store.save({
      conversation_id: "conversation-bytes",
      context_fingerprint: contextFingerprint,
      checkpoint: candidate,
      expected_version: null,
      idempotency_key: parseProviderContextIdempotencyKey("save-too-large"),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "checkpoint_too_large",
      operation: "save",
      retryable: false,
    });
    expect(await load(store, "conversation-bytes", contextFingerprint)).toBeNull();
  });

  it("rejects invalid envelopes without retaining arbitrary sensitive fields", async () => {
    const store = new InMemoryProviderContextCheckpointStore();
    const contextFingerprint = fingerprint("model-envelope");
    await expect(store.save({
      conversation_id: "conversation-envelope",
      context_fingerprint: contextFingerprint,
      checkpoint: {
        ...checkpoint(
          "conversation-envelope",
          contextFingerprint,
          "checkpoint-envelope",
          "b3BhcXVl",
        ),
        prompt: "must never be retained",
      } as never,
      expected_version: null,
      idempotency_key: parseProviderContextIdempotencyKey("save-invalid-envelope"),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await load(store, "conversation-envelope", contextFingerprint)).toBeNull();
  });

  it("requires positive bounded configuration", () => {
    expect(() => new InMemoryProviderContextCheckpointStore({
      limits: { maxCheckpoints: 0 },
    })).toThrow(TypeError);
    expect(() => new InMemoryProviderContextCheckpointStore({
      limits: { maxCheckpointSerializedBytes: 70_001 },
    })).toThrow(TypeError);
  });
});

describe("ProviderContextCheckpointStore public contract", () => {
  it("exports the host contract and deterministic safe errors", () => {
    const store: ProviderContextCheckpointStore =
      new InMemoryProviderContextCheckpointStore();
    expectTypeOf(store.load).toBeFunction();
    expectTypeOf(store.save).toBeFunction();
    expectTypeOf(store.invalidate).toBeFunction();

    const error = new ProviderContextCheckpointStoreError(
      "version_conflict",
      "save",
    );
    expect(error).toMatchObject({
      name: "ProviderContextCheckpointStoreError",
      code: "version_conflict",
      operation: "save",
      retryable: true,
    });
    expect(error.message).not.toContain("checkpoint-private");
  });
});

async function save(
  store: ProviderContextCheckpointStore,
  conversationId: string,
  contextFingerprint: ReturnType<typeof fingerprint>,
  suffix: string,
  expectedVersion: number | null,
) {
  return store.save({
    conversation_id: conversationId,
    context_fingerprint: contextFingerprint,
    checkpoint: checkpoint(
      conversationId,
      contextFingerprint,
      `checkpoint-${suffix}`,
      "b3BhcXVl",
    ),
    expected_version: expectedVersion,
    idempotency_key: parseProviderContextIdempotencyKey(`save-${suffix}`),
    signal: new AbortController().signal,
  });
}

function load(
  store: ProviderContextCheckpointStore,
  conversationId: string,
  contextFingerprint: ReturnType<typeof fingerprint>,
) {
  return store.load({
    conversation_id: conversationId,
    context_fingerprint: contextFingerprint,
    signal: new AbortController().signal,
  });
}
