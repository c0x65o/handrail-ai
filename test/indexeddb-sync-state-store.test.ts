import { indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationSyncStateStoreConflictError,
  type ConversationSyncStateStore,
} from "../src/index.js";
import { IndexedDBConversationSyncStateStore } from "../src/browser/index.js";
import {
  conversationSyncStateStoreConformanceCases,
  syncStateRecord,
} from "./sync-state-store-conformance.js";

let databaseSequence = 0;
const openStores: IndexedDBConversationSyncStateStore[] = [];

function createStore(
  options: { databaseName?: string; namespace?: string } = {},
): IndexedDBConversationSyncStateStore {
  const store = new IndexedDBConversationSyncStateStore({
    databaseName:
      options.databaseName ?? `handrail-ai-sync-test-${databaseSequence++}`,
    namespace: options.namespace ?? "sync-test",
    indexedDB,
  });
  openStores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(openStores.splice(0).map(async (store) => store.close()));
});

describe("IndexedDBConversationSyncStateStore conformance", () => {
  for (const testCase of conversationSyncStateStoreConformanceCases(
    createStore,
  )) {
    it(testCase.name, testCase.run);
  }
});

describe("IndexedDBConversationSyncStateStore durability and atomicity", () => {
  it("preserves a complete record when a second adapter reopens the database", async () => {
    const databaseName = `handrail-ai-sync-reopen-${databaseSequence++}`;
    const first = createStore({ databaseName });
    const record = syncStateRecord("conversation-reopen", [
      "mutation-reopen-a",
      "mutation-reopen-b",
    ]);
    const saved = await first.save({ expectedGeneration: null, record });
    await first.close();

    const reopened = createStore({ databaseName });
    await expect(reopened.load(record.conversationId)).resolves.toEqual(saved);
  });

  it("serializes simultaneous generation-zero saves as exactly one winner", async () => {
    const databaseName = `handrail-ai-sync-race-${databaseSequence++}`;
    const first = createStore({ databaseName });
    const second = createStore({ databaseName });
    const recordA = syncStateRecord("conversation-race", ["mutation-race-a"]);
    const recordB = syncStateRecord("conversation-race", ["mutation-race-b"]);
    const conversationId = recordA.conversationId;
    await first.load(conversationId);
    await second.load(conversationId);

    const results = await Promise.allSettled([
      first.save({
        expectedGeneration: null,
        record: recordA,
      }),
      second.save({
        expectedGeneration: null,
        record: recordB,
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        name: "ConversationSyncStateStoreConflictError",
        code: "generation_conflict",
        expectedGeneration: null,
        actualGeneration: 1,
      }),
    });

    const stored = await first.load(conversationId);
    expect(stored).toMatchObject({ generation: 1 });
    expect(stored?.pendingMutations.map(({ mutationId }) => mutationId)).toEqual(
      [expect.stringMatching(/^mutation-race-[ab]$/u)],
    );
  });

  it("isolates the same conversation id across configured namespaces", async () => {
    const databaseName = `handrail-ai-sync-namespaces-${databaseSequence++}`;
    const tenantA = createStore({ databaseName, namespace: "tenant-a" });
    const tenantB = createStore({ databaseName, namespace: "tenant-b" });
    const recordA = syncStateRecord("conversation-shared", [
      "mutation-tenant-a",
    ]);
    const recordB = syncStateRecord("conversation-shared", [
      "mutation-tenant-b",
    ]);
    const conversationId = recordA.conversationId;

    const [savedA, savedB] = await Promise.all([
      tenantA.save({
        expectedGeneration: null,
        record: recordA,
      }),
      tenantB.save({
        expectedGeneration: null,
        record: recordB,
      }),
    ]);

    await expect(tenantA.load(conversationId)).resolves.toEqual(savedA);
    await expect(tenantB.load(conversationId)).resolves.toEqual(savedB);
  });

  it("keeps the winner unchanged after a stale-generation conflict", async () => {
    const store = createStore();
    const originalRecord = syncStateRecord("conversation-stale-atomic", [
      "mutation-original",
    ]);
    const conversationId = originalRecord.conversationId;
    const original = await store.save({
      expectedGeneration: null,
      record: originalRecord,
    });

    await expect(
      store.save({
        expectedGeneration: null,
        record: syncStateRecord(conversationId, ["mutation-stale"]),
      }),
    ).rejects.toBeInstanceOf(ConversationSyncStateStoreConflictError);
    await expect(store.load(conversationId)).resolves.toEqual(original);
  });
});

describe("IndexedDBConversationSyncStateStore availability and cleanup", () => {
  it("reports typed non-retryable unavailability without IndexedDB", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });
    try {
      const store: ConversationSyncStateStore =
        new IndexedDBConversationSyncStateStore();
      const conversationId = syncStateRecord(
        "conversation-unavailable",
        [],
      ).conversationId;
      await expect(store.load(conversationId)).rejects.toMatchObject({
        name: "ConversationSyncStateStoreUnavailableError",
        operation: "load",
        retryable: false,
      });
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, "indexedDB");
      } else {
        Object.defineProperty(globalThis, "indexedDB", descriptor);
      }
    }
  });

  it("closes idempotently, rejects later operations, and retains durable data", async () => {
    const databaseName = `handrail-ai-sync-close-${databaseSequence++}`;
    const store = createStore({ databaseName });
    const record = syncStateRecord("conversation-close", ["mutation-close"]);
    const saved = await store.save({ expectedGeneration: null, record });

    await store.close();
    await store.close();
    await expect(store.load(record.conversationId)).rejects.toMatchObject({
      name: "ConversationSyncStateStoreUnavailableError",
      operation: "load",
      retryable: false,
    });

    const reopened = createStore({ databaseName });
    await expect(reopened.load(record.conversationId)).resolves.toEqual(saved);
  });
});
