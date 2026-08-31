import { describe, expect, it, vi } from "vitest";

import { createApplicationGatewayPresenceAdapter } from "../src/client/index.js";
import type { LivePresenceEnvelope, PresenceRecord } from "../src/client/index.js";

const record = Object.freeze({
  participant_id: "user-1",
  session_id: "session-1",
  participant_kind: "human",
  state: "active",
  typing: true,
  updated_at: "2026-08-31T19:00:00.000Z",
  expires_at: "2026-08-31T19:00:45.000Z",
  typing_expires_at: "2026-08-31T19:00:05.000Z",
}) as PresenceRecord;

describe("application gateway presence adapter", () => {
  it("maps controller publications and subscriptions to ephemeral gateway delivery", async () => {
    const publish = vi.fn(async () => undefined);
    const envelope = { version: "handrail.live-presence.v1", conversationId: "conversation-1",
      sequence: 1, deliveryId: "delivery-1", kind: "upsert", record } satisfies LivePresenceEnvelope;
    let subscribedSignal: AbortSignal | undefined;
    const gateway = {
      publish,
      subscribe(_conversationId: string, signal?: AbortSignal) {
        subscribedSignal = signal;
        return (async function* () { yield envelope; })();
      },
    };
    const adapter = createApplicationGatewayPresenceAdapter(gateway);

    await expect(adapter.publishPresence({ conversationId: "conversation-1" as never, record }))
      .resolves.toEqual({ status: "published", record });
    expect(publish).toHaveBeenCalledWith("conversation-1", "upsert", record);

    const subscribed = await adapter.subscribePresence({ conversationId: "conversation-1" as never });
    expect(subscribed.status).toBe("subscribed");
    if (subscribed.status !== "subscribed") return;
    const updates = [];
    for await (const update of subscribed.subscription.updates) updates.push(update);
    expect(updates).toEqual([{ status: "presence", record }]);
    subscribed.subscription.close();
    expect(subscribedSignal?.aborted).toBe(true);
  });

  it("publishes offline records as leave envelopes", async () => {
    const publish = vi.fn(async () => undefined);
    const adapter = createApplicationGatewayPresenceAdapter({
      publish,
      subscribe: () => (async function* () {})(),
    });
    const offline = { ...record, state: "offline", typing: false } as PresenceRecord;

    await adapter.publishPresence({ conversationId: "conversation-1" as never, record: offline });
    expect(publish).toHaveBeenCalledWith("conversation-1", "leave", offline);
  });
});
