import { describe, expect, it, vi } from "vitest";
import {
  createApplicationGatewaySyncAdapter,
  type ApplicationGatewayResourceClient,
} from "../src/client/index.js";
import {
  createConversationSynchronizationHttpHandler,
  type ConversationSyncAdapter,
} from "../src/index.js";

const snapshot = { status: "snapshot" as const, snapshot: {
  conversationId: "conversation-1" as never, revision: null, state: { messages: [] },
} };

function resources(overrides: Partial<ApplicationGatewayResourceClient> = {}): ApplicationGatewayResourceClient {
  return {
    listConversations: vi.fn(), createConversation: vi.fn(), getConversation: vi.fn(), renameConversation: vi.fn(),
    clearConversation: vi.fn(), archiveConversation: vi.fn(), restoreConversation: vi.fn(), permanentlyDeleteConversation: vi.fn(),
    createApproval: vi.fn(), getApproval: vi.fn(), listApprovalGroup: vi.fn(), transitionApproval: vi.fn(), generateTitle: vi.fn(),
    pullSnapshot: vi.fn(async () => snapshot),
    readSince: vi.fn(async (input) => ({ status: "events" as const, events: [], revision: input.afterRevision,
      latestRevision: input.afterRevision, hasMore: false })),
    appendMutations: vi.fn(),
    ...overrides,
  } as ApplicationGatewayResourceClient;
}

describe("application gateway synchronization", () => {
  it("hosts only bounded protected synchronization operations", async () => {
    const context = { principalId: "principal-1" };
    const adapter: ConversationSyncAdapter = {
      pullSnapshot: vi.fn(async () => snapshot),
      readSince: vi.fn(), appendMutations: vi.fn(), subscribeSince: vi.fn(),
      publishPresence: vi.fn(), subscribePresence: vi.fn(),
    };
    const adapterFor = vi.fn(async (received: typeof context) => {
      expect(received).toBe(context); return adapter;
    });
    const handler = createConversationSynchronizationHttpHandler({ adapterFor, maximumBodyBytes: 2_048 });
    const response = await handler(new Request("https://app.test/synchronization", {
      method: "POST", body: JSON.stringify({ operation: "pull_snapshot",
        input: { conversationId: "conversation-1" } }),
    }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, value: snapshot });
    expect(adapter.pullSnapshot).toHaveBeenCalledWith({ conversationId: "conversation-1" });
    expect(adapterFor).toHaveBeenCalledOnce();

    const invalid = await handler(new Request("https://app.test/synchronization", {
      method: "POST", body: "not-json",
    }), context);
    expect(invalid.status).toBe(400);
    const tooLarge = await createConversationSynchronizationHttpHandler({ adapterFor, maximumBodyBytes: 10 })(
      new Request("https://app.test/synchronization", { method: "POST", body: "x".repeat(11) }), context);
    expect(tooLarge.status).toBe(413);
  });

  it("provides a cross-platform polling adapter that catches up and delegates mutations", async () => {
    let reads = 0;
    const readSince = vi.fn(async (input: { afterRevision: number | null }) => ++reads === 1
      ? { status: "events" as const, events: [], revision: input.afterRevision as never,
        latestRevision: input.afterRevision as never, hasMore: false }
      : { status: "events" as const, events: [{ revision: 1, mutation_id: "mutation-1" } as never],
        revision: 1 as never, latestRevision: 1 as never, hasMore: false });
    const appendMutations = vi.fn(async () => ({ status: "conflict" as const,
      expectedRevision: null, actualRevision: 1 as never }));
    const gateway = resources({ readSince, appendMutations });
    const sync = createApplicationGatewaySyncAdapter({ resources: gateway, pollingMilliseconds: 100 });
    await expect(sync.pullSnapshot({ conversationId: "conversation-1" as never })).resolves.toEqual(snapshot);
    await expect(sync.appendMutations({ conversationId: "conversation-1" as never,
      expectedRevision: null, mutations: [] })).resolves.toMatchObject({ status: "conflict" });
    expect(appendMutations).toHaveBeenCalledOnce();

    const subscribed = await sync.subscribeSince({ conversationId: "conversation-1" as never, afterRevision: null });
    expect(subscribed.status).toBe("subscribed");
    if (subscribed.status !== "subscribed") return;
    const update = await subscribed.subscription.updates[Symbol.asyncIterator]().next();
    expect(update).toMatchObject({ value: { status: "events", revision: 1,
      events: [{ mutation_id: "mutation-1" }] } });
    subscribed.subscription.close();
    await expect(sync.publishPresence({ conversationId: "conversation-1" as never, record: {} as never }))
      .resolves.toMatchObject({ status: "unauthorized" });
  });
});
