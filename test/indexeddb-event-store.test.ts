import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { type ConversationEventStore } from "../src/index.js";
import { IndexedDBConversationEventStore } from "../src/browser/index.js";
import {
  conformanceEvent,
  conversationEventStoreConformanceCases,
} from "./event-store-conformance.js";

let databaseSequence = 0;
const openStores: IndexedDBConversationEventStore[] = [];

function createStore(
  options: { databaseName?: string; storePrefix?: string } = {},
): IndexedDBConversationEventStore {
  const store = new IndexedDBConversationEventStore({
    databaseName:
      options.databaseName ?? `handrail-ai-test-${databaseSequence++}`,
    storePrefix: options.storePrefix ?? "events-",
    indexedDB,
    keyRange: IDBKeyRange,
  });
  openStores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(openStores.splice(0).map(async (store) => store.close()));
});

describe("IndexedDBConversationEventStore conformance", () => {
  for (const testCase of conversationEventStoreConformanceCases(createStore)) {
    it(testCase.name, testCase.run);
  }
});

describe("IndexedDBConversationEventStore durability and atomicity", () => {
  it("preserves events and checkpoints when a second adapter reopens the database", async () => {
    const databaseName = `handrail-ai-reopen-${databaseSequence++}`;
    const first = createStore({ databaseName });
    const storedEvent = conformanceEvent({
      eventId: "evt-reopen",
      revision: 1,
      marker: "durable",
    });
    await first.append({
      conversationId: storedEvent.conversation_id,
      expectedRevision: null,
      events: [storedEvent],
    });
    await first.checkpoints!.write({
      conversationId: storedEvent.conversation_id,
      revision: storedEvent.revision,
      state: { durable: true },
    });
    await first.close();

    const reopened = createStore({ databaseName });
    const read = await reopened.read({
      conversationId: storedEvent.conversation_id,
    });
    expect(read.entries.map(({ event }) => event.event_id)).toEqual([
      "evt-reopen",
    ]);
    await expect(
      reopened.checkpoints!.read(storedEvent.conversation_id),
    ).resolves.toEqual({
      conversationId: storedEvent.conversation_id,
      revision: 1,
      state: { durable: true },
    });
  });

  it("leaves no partial writes after a stale-revision conflict", async () => {
    const store = createStore();
    const existing = conformanceEvent({ eventId: "evt-atomic-existing", revision: 1 });
    await store.append({
      conversationId: existing.conversation_id,
      expectedRevision: null,
      events: [existing],
    });

    await expect(
      store.append({
        conversationId: existing.conversation_id,
        expectedRevision: null,
        events: [
          conformanceEvent({ eventId: "evt-atomic-stale-1", revision: 1 }),
          conformanceEvent({ eventId: "evt-atomic-stale-2", revision: 2 }),
        ],
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const read = await store.read({ conversationId: existing.conversation_id });
    expect(read.entries.map(({ event }) => event.event_id)).toEqual([
      "evt-atomic-existing",
    ]);
  });

  it("serializes simultaneous conflicting appends as one complete winner", async () => {
    const databaseName = `handrail-ai-race-${databaseSequence++}`;
    const first = createStore({ databaseName });
    const second = createStore({ databaseName });
    const conversationId = conformanceEvent({
      eventId: "evt-race-placeholder",
      revision: 1,
    }).conversation_id;
    await Promise.all([
      first.getLatestRevision(conversationId),
      second.getLatestRevision(conversationId),
    ]);

    const results = await Promise.allSettled([
      first.append({
        conversationId,
        expectedRevision: null,
        events: [conformanceEvent({ eventId: "evt-race-a", revision: 1 })],
      }),
      second.append({
        conversationId,
        expectedRevision: null,
        events: [conformanceEvent({ eventId: "evt-race-b", revision: 1 })],
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        name: "ConversationEventStoreConflictError",
        code: "revision_conflict",
      }),
    });
    expect(await first.read({ conversationId })).toMatchObject({
      latestRevision: 1,
      entries: [{ event: { revision: 1 } }],
    });
  });

  it("isolates conversations and configured store namespaces", async () => {
    const databaseName = `handrail-ai-namespaces-${databaseSequence++}`;
    const tenantA = createStore({ databaseName, storePrefix: "tenant-a-" });
    const tenantB = createStore({ databaseName, storePrefix: "tenant-b-" });
    const eventA = conformanceEvent({
      conversationId: "conversation-shared-id",
      eventId: "evt-shared-id",
      revision: 1,
      marker: "tenant-a",
    });
    const eventB = conformanceEvent({
      conversationId: "conversation-shared-id",
      eventId: "evt-shared-id",
      revision: 1,
      marker: "tenant-b",
    });

    await tenantA.append({
      conversationId: eventA.conversation_id,
      expectedRevision: null,
      events: [eventA],
    });
    await tenantB.append({
      conversationId: eventB.conversation_id,
      expectedRevision: null,
      events: [eventB],
    });

    const [readA, readB] = await Promise.all([
      tenantA.read({ conversationId: eventA.conversation_id }),
      tenantB.read({ conversationId: eventB.conversation_id }),
    ]);
    expect(readA.entries[0]!.event.payload).toMatchObject({
      metadata: { marker: "tenant-a" },
    });
    expect(readB.entries[0]!.event.payload).toMatchObject({
      metadata: { marker: "tenant-b" },
    });
  });

  it("enforces event and mutation identifiers across conversations", async () => {
    const store = createStore();
    const original = conformanceEvent({
      conversationId: "conversation-global-a",
      eventId: "evt-global",
      mutationId: "mutation-global",
      revision: 1,
    });
    await store.append({
      conversationId: original.conversation_id,
      expectedRevision: null,
      events: [original],
    });

    for (const conflicting of [
      conformanceEvent({
        conversationId: "conversation-global-b",
        eventId: "evt-global",
        mutationId: "mutation-global-b",
        revision: 1,
      }),
      conformanceEvent({
        conversationId: "conversation-global-b",
        eventId: "evt-global-b",
        mutationId: "mutation-global",
        revision: 1,
      }),
    ]) {
      await expect(
        store.append({
          conversationId: conflicting.conversation_id,
          expectedRevision: null,
          events: [conflicting],
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    }

    await expect(
      store.getLatestRevision(conflictingConversationId()),
    ).resolves.toBeNull();
  });

  it("clones stored inputs and returned entries", async () => {
    const store = createStore();
    const event = conformanceEvent({
      eventId: "evt-indexeddb-clone",
      revision: 1,
      marker: "original",
    });
    await store.append({
      conversationId: event.conversation_id,
      expectedRevision: null,
      events: [event],
    });
    if (event.payload.type !== "conversation.metadata_updated") return;
    event.payload.metadata.marker = "changed input";

    const firstRead = await store.read({ conversationId: event.conversation_id });
    if (firstRead.entries[0]!.event.payload.type !== "conversation.metadata_updated") {
      return;
    }
    firstRead.entries[0]!.event.payload.metadata.marker = "changed output";
    const secondRead = await store.read({ conversationId: event.conversation_id });
    expect(secondRead.entries[0]!.event.payload).toMatchObject({
      metadata: { marker: "original" },
    });
    expect(Object.isFrozen(secondRead.entries)).toBe(true);
  });
});

describe("IndexedDBConversationEventStore availability", () => {
  it("reports a typed non-retryable error when IndexedDB is unavailable", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: undefined,
    });
    try {
      const store: ConversationEventStore = new IndexedDBConversationEventStore();
      const conversationId = conformanceEvent({
        eventId: "evt-no-indexeddb",
        revision: 1,
      }).conversation_id;
      await expect(store.getLatestRevision(conversationId)).rejects.toMatchObject({
        name: "ConversationEventStoreUnavailableError",
        operation: "latest_revision",
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

  it("reports a blocked schema upgrade as retryable unavailability", async () => {
    const databaseName = `handrail-ai-blocked-${databaseSequence++}`;
    const blockingConnection = await openUnmanagedDatabase(databaseName);
    try {
      const store = createStore({ databaseName, storePrefix: "blocked-" });
      const conversationId = conformanceEvent({
        eventId: "evt-blocked",
        revision: 1,
      }).conversation_id;
      await expect(store.getLatestRevision(conversationId)).rejects.toMatchObject({
        name: "ConversationEventStoreUnavailableError",
        operation: "latest_revision",
        retryable: true,
      });
    } finally {
      blockingConnection.close();
    }
  });
});

function conflictingConversationId() {
  return conformanceEvent({
    conversationId: "conversation-global-b",
    eventId: "evt-global-placeholder",
    revision: 1,
  }).conversation_id;
}

function openUnmanagedDatabase(databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("unrelated-store");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
