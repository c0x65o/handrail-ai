import { describe, expect, it } from "vitest";
import {
  InMemoryConversationEventStore,
  createEventStoreConversationSyncAdapter,
  createSynchronizedConversationEventStore,
  parseConversationEvent,
  type ConversationClientMutationId,
  type ConversationEventId,
  type ConversationId,
} from "../src/index.js";

const conversationId = "conversation-remote-store" as ConversationId;

function localEvent(input: {
  readonly eventId: string;
  readonly revision: number;
  readonly source?: "client" | "runtime";
  readonly mutationId?: string;
  readonly step: number;
}) {
  return parseConversationEvent({
    version: 1,
    event_id: input.eventId,
    conversation_id: conversationId,
    revision: input.revision,
    occurred_at: "2026-08-31T20:00:00.000Z",
    actor: { type: input.source === "runtime" ? "assistant" : "user" },
    source: input.source === "runtime"
      ? { type: "runtime" }
      : { type: "client", client_id: "untrusted-client", device_id: "untrusted-device" },
    ...(input.mutationId === undefined ? {} : { mutation_id: input.mutationId }),
    payload: { type: "conversation.metadata_updated", metadata: { step: input.step } },
  });
}

function authoritativeAdapter(store: InMemoryConversationEventStore, allowRuntime = true) {
  return createEventStoreConversationSyncAdapter({
    authorizationContext: { principalId: "principal-1" },
    eventStore: store,
    authorize: () => true,
    allowRuntimeMutationProposals: allowRuntime,
    canonicalizeMutation: async ({ proposedEvent }) => ({
      actor: proposedEvent.actor,
      source: { type: "sync" as const },
      payload: proposedEvent.payload,
      metadata: { verified_by: "durable-turn-authority" },
    }),
    createEventId: ({ mutationId }) => `server:${mutationId}` as ConversationEventId,
    now: () => "2026-08-31T21:00:00.000Z" as never,
  });
}

describe("synchronized conversation event store", () => {
  it("returns server-authored envelopes and converges another device on the same log", async () => {
    const authority = new InMemoryConversationEventStore();
    const adapter = authoritativeAdapter(authority);
    const first = createSynchronizedConversationEventStore({ adapter });
    const second = createSynchronizedConversationEventStore({ adapter });
    const proposed = localEvent({ eventId: "local-runtime-1", revision: 1, source: "runtime", step: 1 });

    const appended = await first.append({ conversationId, expectedRevision: null, events: [proposed] });
    expect(appended).toMatchObject({
      status: "appended",
      latestRevision: 1,
      entries: [{ event: {
        event_id: "server:sync-event:local-runtime-1",
        mutation_id: "sync-event:local-runtime-1",
        revision: 1,
        occurred_at: "2026-08-31T21:00:00.000Z",
        source: { type: "sync" },
        metadata: { verified_by: "durable-turn-authority" },
      } }],
    });

    await expect(second.read({ conversationId })).resolves.toMatchObject({
      latestRevision: 1,
      entries: [{ event: { event_id: "server:sync-event:local-runtime-1", revision: 1 } }],
    });
    await expect(second.getLatestRevision(conversationId)).resolves.toBe(1);

    const duplicate = await first.append({ conversationId, expectedRevision: null, events: [proposed] });
    expect(duplicate).toMatchObject({ status: "idempotent", latestRevision: 1,
      entries: [{ event: { event_id: "server:sync-event:local-runtime-1" } }] });
    expect((await authority.read({ conversationId })).entries).toHaveLength(1);
  });

  it("preserves explicit client mutation IDs and translates optimistic conflicts", async () => {
    const authority = new InMemoryConversationEventStore();
    const adapter = authoritativeAdapter(authority);
    const remote = createSynchronizedConversationEventStore({ adapter });
    const mutationId = "client-mutation-1" as ConversationClientMutationId;
    await remote.append({ conversationId, expectedRevision: null,
      events: [localEvent({ eventId: "local-client-1", revision: 1, mutationId, step: 1 })] });

    await expect(remote.append({ conversationId, expectedRevision: null,
      events: [localEvent({ eventId: "losing-event", revision: 1, step: 2 })] })).rejects.toMatchObject({
      name: "ConversationEventStoreConflictError",
      code: "revision_conflict",
      expectedRevision: null,
      actualRevision: 1,
    });
    const stored = (await authority.read({ conversationId })).entries[0]!.event;
    expect(stored.mutation_id).toBe(mutationId);
  });

  it("keeps runtime proposals denied unless the server explicitly opts into verification", async () => {
    const authority = new InMemoryConversationEventStore();
    const remote = createSynchronizedConversationEventStore({
      adapter: authoritativeAdapter(authority, false),
    });
    await expect(remote.append({ conversationId, expectedRevision: null,
      events: [localEvent({ eventId: "unverified-runtime", revision: 1, source: "runtime", step: 1 })] }))
      .rejects.toMatchObject({
        name: "ConversationEventStoreUnavailableError",
        retryable: false,
      });
    expect(await authority.getLatestRevision(conversationId)).toBeNull();
  });

  it("scopes opaque cursors to the conversation that issued them", async () => {
    const authority = new InMemoryConversationEventStore();
    const remote = createSynchronizedConversationEventStore({ adapter: authoritativeAdapter(authority) });
    await remote.append({ conversationId, expectedRevision: null,
      events: [localEvent({ eventId: "cursor-event", revision: 1, step: 1 })] });
    const page = await remote.read({ conversationId, limit: 1 });
    const otherConversation = "conversation-other" as ConversationId;
    await expect(remote.read({ conversationId: otherConversation, after: { cursor: page.nextCursor! } }))
      .rejects.toMatchObject({ name: "ConversationEventStoreConflictError", code: "cursor_not_found" });
  });
});
