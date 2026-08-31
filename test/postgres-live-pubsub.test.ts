import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryLiveConversationActivityDelivery,
  createInMemoryLivePresenceDelivery,
  parsePresenceRecord,
  type AiDiagnosticEvent,
} from "../src/index.js";
import {
  PostgresLivePubSub,
  type PostgresListenConnection,
  type PostgresNotification,
  type PostgresSqlClient,
} from "../src/postgres/index.js";

class FakePostgresNotifications {
  readonly connections = new Set<FakeListenConnection>();
  readonly publisher: PostgresSqlClient = {
    query: async (_text, values) => {
      this.deliver({ channel: String(values?.[0]), payload: String(values?.[1]) });
      return { rows: [], rowCount: 1 };
    },
    transaction: (operation) => operation(this.publisher),
  };

  connect = async (): Promise<PostgresListenConnection> => {
    const connection = new FakeListenConnection(this);
    this.connections.add(connection);
    return connection;
  };

  deliver(notification: PostgresNotification): void {
    for (const connection of this.connections) connection.deliver(notification);
  }
}

class FakeListenConnection implements PostgresListenConnection {
  readonly listeners = new Set<(notification: PostgresNotification) => void>();
  readonly queries: string[] = [];
  released = false;
  constructor(readonly hub: FakePostgresNotifications) {}
  async query(text: string): Promise<unknown> { this.queries.push(text); return undefined; }
  onNotification(listener: (notification: PostgresNotification) => void): void { this.listeners.add(listener); }
  offNotification(listener: (notification: PostgresNotification) => void): void { this.listeners.delete(listener); }
  release(): void { this.released = true; this.hub.connections.delete(this); }
  deliver(notification: PostgresNotification): void {
    if (!this.released) for (const listener of this.listeners) listener(notification);
  }
}

const presence = () => parsePresenceRecord({
  participant_id: "user-1", device_id: "browser-1", session_id: "session-1",
  participant_kind: "human", state: "active", typing: true,
  updated_at: "2026-08-31T20:00:00.000Z", expires_at: "2026-08-31T20:01:00.000Z",
  typing_expires_at: "2026-08-31T20:00:05.000Z",
});

describe("PostgresLivePubSub", () => {
  it("fans activity and presence across independent application instances", async () => {
    const hub = new FakePostgresNotifications();
    const first = new PostgresLivePubSub({ publisher: hub.publisher, connect: hub.connect });
    const second = new PostgresLivePubSub({ publisher: hub.publisher, connect: hub.connect });
    const firstActivity = createInMemoryLiveConversationActivityDelivery({
      pubSub: first, channel: "tenant:principal:activity",
    });
    const secondActivity = createInMemoryLiveConversationActivityDelivery({
      pubSub: second, channel: "tenant:principal:activity",
    });
    const activitySubscription = secondActivity.subscribe();
    const activityIterator = activitySubscription[Symbol.asyncIterator]();
    await vi.waitFor(() => expect(hub.connections.size).toBe(1));
    await firstActivity.publish({ conversationId: "conversation-1", turnStatus: "running", unread: false });
    await expect(activityIterator.next()).resolves.toMatchObject({
      value: { record: { conversationId: "conversation-1", turnStatus: "running" } },
    });

    const firstPresence = createInMemoryLivePresenceDelivery({
      pubSub: first, channelPrefix: "tenant:principal:presence:",
    });
    const secondPresence = createInMemoryLivePresenceDelivery({
      pubSub: second, channelPrefix: "tenant:principal:presence:",
    });
    const presenceSubscription = secondPresence.subscribe("conversation-1");
    const presenceIterator = presenceSubscription[Symbol.asyncIterator]();
    await firstPresence.publish("conversation-1", "upsert", presence());
    await expect(presenceIterator.next()).resolves.toMatchObject({
      value: { conversationId: "conversation-1", kind: "upsert", record: { typing: true } },
    });

    activitySubscription.close();
    presenceSubscription.close();
    await first.close();
    await second.close();
    expect(hub.connections.size).toBe(0);
  });

  it("isolates malformed notifications, emits safe diagnostics, and continues", async () => {
    const hub = new FakePostgresNotifications();
    const diagnostics: AiDiagnosticEvent[] = [];
    const bridge = new PostgresLivePubSub({
      publisher: hub.publisher, connect: hub.connect, diagnostics: (event) => diagnostics.push(event),
    });
    const receive = vi.fn();
    await bridge.subscribe("tenant:activity", receive);
    hub.deliver({ channel: "handrail_ai_live_v1", payload: "{not-json" });
    expect(receive).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      domain: "persistence", operation: "postgres_notification_receive", phase: "failed",
      code: "invalid_live_notification", retryable: false,
    }));

    await bridge.publish("tenant:activity", {
      version: "handrail.live-conversation-activity.v1",
      sequence: 1,
      deliveryId: "delivery-1",
      record: { conversationId: "conversation-1", turnStatus: "completed", unread: true },
    });
    expect(receive).toHaveBeenCalledOnce();
    await bridge.close();
  });

  it("rejects unsafe channels and oversized payloads before reaching PostgreSQL", async () => {
    const hub = new FakePostgresNotifications();
    const bridge = new PostgresLivePubSub({ publisher: hub.publisher, connect: hub.connect });
    await expect(bridge.publish("bad channel", {
      version: "handrail.live-conversation-activity.v1", sequence: 1, deliveryId: "delivery-1",
      record: { conversationId: "conversation-1", turnStatus: "running", unread: false },
    })).rejects.toThrow("channel is invalid");
    await expect(bridge.publish("safe:channel", {
      version: "handrail.live-conversation-activity.v1", sequence: 1, deliveryId: "delivery-2",
      record: { conversationId: "x".repeat(8_000), turnStatus: "running", unread: false },
    })).rejects.toThrow();
    expect(hub.connections.size).toBe(0);
    await bridge.close();
  });
});
