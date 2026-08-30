import { describe, expect, it } from "vitest";
import { createInMemoryLivePresenceDelivery, createLivePresenceHttpHandler, parsePresenceRecord } from "../src/index.js";

const record = (expiresAt = "2026-01-01T00:00:10.000Z") => parsePresenceRecord({
  participant_id: "user-1", device_id: "phone", session_id: "session-1",
  participant_kind: "human", state: "active", typing: true,
  updated_at: "2026-01-01T00:00:00.000Z", expires_at: expiresAt,
  typing_expires_at: "2026-01-01T00:00:05.000Z",
});

describe("live presence delivery", () => {
  it("delivers ephemeral updates and removes explicit leaves", async () => {
    const delivery = createInMemoryLivePresenceDelivery({ now: () => Date.parse("2026-01-01T00:00:01.000Z") });
    const subscription = delivery.subscribe("conversation-1");
    const iterator = subscription[Symbol.asyncIterator]();
    await delivery.publish("conversation-1", "upsert", record());
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "upsert", sequence: 1 } });
    expect(delivery.snapshot("conversation-1")).toHaveLength(1);
    await delivery.publish("conversation-1", "leave", record());
    expect(delivery.snapshot("conversation-1")).toHaveLength(0);
    subscription.close();
  });

  it("expires records without creating durable conversation facts", async () => {
    const delivery = createInMemoryLivePresenceDelivery({ now: () => Date.parse("2026-01-01T00:00:20.000Z") });
    await delivery.publish("conversation-1", "upsert", record());
    expect(delivery.snapshot("conversation-1")).toEqual([]);
  });

  it("hosts protected publish and SSE subscribe endpoints", async () => {
    const delivery = createInMemoryLivePresenceDelivery();
    const handler = createLivePresenceHttpHandler({ delivery, authorize: async (request) => {
      if (request.headers.get("authorization") !== "Bearer app") throw new Error("denied");
      return {};
    } });
    const streamResponse = await handler(new Request("https://app.test/presence?conversationId=c1", { headers: { authorization: "Bearer app" } }));
    const published = await handler(new Request("https://app.test/presence?conversationId=c1", {
      method: "POST", headers: { authorization: "Bearer app", "content-type": "application/json" },
      body: JSON.stringify({ kind: "upsert", record: record("2027-01-01T00:00:00.000Z") }),
    }));
    expect(published.status).toBe(200);
    const reader = streamResponse.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: presence.upsert");
    await reader.cancel();
  });
});
