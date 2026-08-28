import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ConversationSyncStateStoreConflictError,
  InMemoryConversationSyncStateStore,
  type ConversationSyncStateStore,
} from "../src/index.js";
import {
  conversationSyncStateStoreConformanceCases,
  syncStateRecord,
} from "./sync-state-store-conformance.js";

describe("InMemoryConversationSyncStateStore conformance", () => {
  for (const testCase of conversationSyncStateStoreConformanceCases(
    () => new InMemoryConversationSyncStateStore(),
  )) {
    it(testCase.name, testCase.run);
  }
});

describe("ConversationSyncStateStore public contract", () => {
  it("exports an implementable interface and typed conflict", () => {
    const store: ConversationSyncStateStore =
      new InMemoryConversationSyncStateStore();
    expectTypeOf(store.load).toBeFunction();
    expectTypeOf(store.save).toBeFunction();

    const record = syncStateRecord("conversation-type-proof", []);
    const conflict = new ConversationSyncStateStoreConflictError("stale", {
      code: "generation_conflict",
      conversationId: record.conversationId,
      expectedGeneration: 1,
      actualGeneration: 2,
    });
    expect(conflict).toBeInstanceOf(Error);
    expect(conflict).toMatchObject({
      name: "ConversationSyncStateStoreConflictError",
      code: "generation_conflict",
      expectedGeneration: 1,
      actualGeneration: 2,
    });
  });
});
