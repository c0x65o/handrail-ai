import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ConversationEventStoreConflictError,
  ConversationEventStoreUnavailableError,
  InMemoryConversationEventStore,
  type ConversationEventStore,
} from "../src/index.js";
import {
  conformanceEvent,
  conversationEventStoreConformanceCases,
} from "./event-store-conformance.js";

describe("InMemoryConversationEventStore conformance", () => {
  for (const testCase of conversationEventStoreConformanceCases(
    () => new InMemoryConversationEventStore(),
  )) {
    it(testCase.name, testCase.run);
  }
});

describe("ConversationEventStore identifier conflicts", () => {
  it("rejects conflicting event and mutation identifier reuse", async () => {
    const store = new InMemoryConversationEventStore();
    const original = conformanceEvent({
      eventId: "evt-conflict",
      mutationId: "mutation-conflict",
      revision: 1,
      marker: "original",
    });
    await store.append({
      conversationId: original.conversation_id,
      expectedRevision: null,
      events: [original],
    });

    for (const conflicting of [
      conformanceEvent({
        eventId: "evt-conflict",
        mutationId: "mutation-other",
        revision: 1,
        marker: "changed",
      }),
      conformanceEvent({
        eventId: "evt-other",
        mutationId: "mutation-conflict",
        revision: 1,
        marker: "changed",
      }),
    ]) {
      await expect(
        store.append({
          conversationId: original.conversation_id,
          expectedRevision: null,
          events: [conflicting],
        }),
      ).rejects.toMatchObject({
        name: "ConversationEventStoreConflictError",
        code: "idempotency_conflict",
      });
    }

    expect(await store.getLatestRevision(original.conversation_id)).toBe(1);
  });

  it("does not retain caller mutations or expose mutable internal entries", async () => {
    const store = new InMemoryConversationEventStore();
    const original = conformanceEvent({
      eventId: "evt-clone",
      revision: 1,
      marker: "original",
    });
    await store.append({
      conversationId: original.conversation_id,
      expectedRevision: null,
      events: [original],
    });

    if (original.payload.type !== "conversation.metadata_updated") return;
    original.payload.metadata.marker = "mutated input";
    const firstRead = await store.read({
      conversationId: original.conversation_id,
    });
    const returned = firstRead.entries[0]!.event;
    if (returned.payload.type !== "conversation.metadata_updated") return;
    expect(returned.payload.metadata.marker).toBe("original");

    returned.payload.metadata.marker = "mutated output";
    const secondRead = await store.read({
      conversationId: original.conversation_id,
    });
    expect(secondRead.entries[0]!.event.payload).toMatchObject({
      metadata: { marker: "original" },
    });
    expect(Object.isFrozen(secondRead.entries)).toBe(true);
  });
});

describe("ConversationEventStore public contract", () => {
  it("exports a standalone implementable interface and conflict error", () => {
    const store: ConversationEventStore = new InMemoryConversationEventStore();
    expectTypeOf(store.append).toBeFunction();
    expectTypeOf(store.read).toBeFunction();
    expectTypeOf(store.getLatestRevision).toBeFunction();

    const conflict = new ConversationEventStoreConflictError("stale", {
      code: "revision_conflict",
      conversationId: conformanceEvent({
        eventId: "evt-type-proof",
        revision: 1,
      }).conversation_id,
      expectedRevision: null,
      actualRevision: null,
      identifier: null,
    });
    expect(conflict).toBeInstanceOf(Error);
    expect(conflict.code).toBe("revision_conflict");
  });

  it("allows a host adapter to report typed unavailability", async () => {
    const unavailableStore: ConversationEventStore = {
      async append() {
        throw new ConversationEventStoreUnavailableError(
          "append",
          "storage offline",
        );
      },
      async read() {
        throw new ConversationEventStoreUnavailableError(
          "read",
          "storage offline",
        );
      },
      async getLatestRevision() {
        throw new ConversationEventStoreUnavailableError(
          "latest_revision",
          "storage offline",
        );
      },
    };

    const conversationId = conformanceEvent({
      eventId: "evt-unavailable",
      revision: 1,
    }).conversation_id;
    await expect(
      unavailableStore.read({ conversationId }),
    ).rejects.toMatchObject({
      name: "ConversationEventStoreUnavailableError",
      operation: "read",
      retryable: true,
    });
    await expect(
      unavailableStore.getLatestRevision(conversationId),
    ).rejects.toBeInstanceOf(ConversationEventStoreUnavailableError);
  });
});
