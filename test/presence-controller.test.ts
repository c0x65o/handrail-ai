import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPresenceController,
  parsePresenceRecord,
  type ConversationId,
  type ConversationPresenceStreamUpdate,
  type ConversationPresenceSubscription,
  type PresenceController,
  type PresenceControllerAdapter,
  type PresenceRecord,
  type PublishPresenceInput,
  type PublishPresenceResult,
  type SubscribePresenceInput,
  type SubscribePresenceResult,
} from "../src/index.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const conversation = (value: string) => value as ConversationId;

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const reader = this.readers.shift();
    if (reader === undefined) this.values.push(value);
    else reader({ done: false, value });
  }

  close(): void {
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.readers.push(resolve);
        });
      },
    };
  }
}

type PublishOutcome = "throw" | "reject" | "temporary_unavailable";

class FakePresenceAdapter implements PresenceControllerAdapter {
  readonly publications: PublishPresenceInput[] = [];
  readonly subscribeInputs: SubscribePresenceInput[] = [];
  closedSubscriptionCount = 0;
  private readonly outcomes: PublishOutcome[] = [];
  private queue: AsyncQueue<ConversationPresenceStreamUpdate> | undefined;

  failNext(...outcomes: PublishOutcome[]): void {
    this.outcomes.push(...outcomes);
  }

  publishPresence(input: PublishPresenceInput): Promise<PublishPresenceResult> {
    this.publications.push(input);
    const outcome = this.outcomes.shift();
    if (outcome === "throw") throw new Error("synchronous transport failure");
    if (outcome === "reject") {
      return Promise.reject(new Error("rejected transport failure"));
    }
    if (outcome === "temporary_unavailable") {
      return Promise.resolve({
        status: "temporarily_unavailable",
        retryAfterMilliseconds: 25,
      });
    }
    return Promise.resolve({ status: "published", record: input.record });
  }

  subscribePresence(
    input: SubscribePresenceInput,
  ): Promise<SubscribePresenceResult> {
    this.subscribeInputs.push(input);
    const queue = new AsyncQueue<ConversationPresenceStreamUpdate>();
    this.queue = queue;
    const subscription: ConversationPresenceSubscription = {
      updates: queue,
      close: () => {
        this.closedSubscriptionCount += 1;
        queue.close();
      },
    };
    return Promise.resolve({ status: "subscribed", subscription });
  }

  pushRemote(record: PresenceRecord): void {
    this.queue?.push({ status: "presence", record });
  }
}

const controllerOptions = (
  adapter: FakePresenceAdapter,
  overrides: Partial<Parameters<typeof createPresenceController>[0]> = {},
) => ({
  conversationId: conversation("conversation-a"),
  participantId: "participant-local",
  deviceId: "device-local",
  sessionId: "session-local",
  participantKind: "human" as const,
  adapter,
  heartbeatMilliseconds: 1_000,
  idleMilliseconds: 10_000,
  typingStartDebounceMilliseconds: 100,
  typingRefreshMilliseconds: 300,
  presenceTtlMilliseconds: 5_000,
  typingTtlMilliseconds: 1_000,
  ...overrides,
});

const remotePresence = (
  deviceId: string,
  overrides: Record<string, unknown> = {},
): PresenceRecord =>
  parsePresenceRecord({
    participant_id: "participant-remote",
    device_id: deviceId,
    session_id: "shared-session",
    participant_kind: "human",
    state: "active",
    typing: false,
    updated_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 2_000).toISOString(),
    ...overrides,
  });

const flushAsyncWork = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("createPresenceController", () => {
  let controllers: PresenceController[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    controllers = [];
  });

  afterEach(() => {
    for (const controller of controllers) controller.destroy();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const createController = (
    adapter: FakePresenceAdapter,
    overrides: Partial<Parameters<typeof createPresenceController>[0]> = {},
  ): PresenceController => {
    const controller = createPresenceController(
      controllerOptions(adapter, overrides),
    );
    controllers.push(controller);
    return controller;
  };

  it("publishes connected presence on the configured heartbeat cadence", () => {
    const adapter = new FakePresenceAdapter();
    const controller = createController(adapter);

    controller.connect();
    expect(adapter.publications).toHaveLength(1);
    expect(adapter.publications[0]?.record).toMatchObject({
      state: "active",
      typing: false,
    });

    controller.noteActivity();
    expect(adapter.publications).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(adapter.publications).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(adapter.publications).toHaveLength(2);
    expect(Date.parse(adapter.publications[1]!.record.updated_at)).toBe(
      NOW + 1_000,
    );
  });

  it("debounces typing start and cancels it without publishing stale typing", () => {
    const adapter = new FakePresenceAdapter();
    const controller = createController(adapter);
    controller.connect();

    controller.setTyping();
    vi.advanceTimersByTime(99);
    expect(adapter.publications.some(({ record }) => record.typing)).toBe(false);
    controller.stopTyping("send");
    expect(adapter.publications.at(-1)?.record.typing).toBe(false);
    vi.advanceTimersByTime(1);
    expect(adapter.publications.some(({ record }) => record.typing)).toBe(false);

    controller.setTyping();
    vi.advanceTimersByTime(100);
    expect(adapter.publications.at(-1)?.record.typing).toBe(true);
  });

  it("throttles redundant typing calls and refreshes before typing TTL", () => {
    const adapter = new FakePresenceAdapter();
    const controller = createController(adapter);
    controller.connect();
    controller.setTyping();
    vi.advanceTimersByTime(100);
    const afterStart = adapter.publications.length;

    controller.setTyping();
    controller.setTyping();
    expect(adapter.publications).toHaveLength(afterStart);
    vi.advanceTimersByTime(299);
    expect(adapter.publications).toHaveLength(afterStart);
    vi.advanceTimersByTime(1);
    expect(adapter.publications).toHaveLength(afterStart + 1);
    const refreshed = adapter.publications.at(-1)!.record;
    expect(refreshed.typing).toBe(true);
    expect(
      Date.parse(refreshed.typing_expires_at!) - Date.parse(refreshed.updated_at),
    ).toBe(1_000);
  });

  it("returns to active on activity and transitions to idle after inactivity", () => {
    const adapter = new FakePresenceAdapter();
    const controller = createController(adapter, {
      heartbeatMilliseconds: 500,
      idleMilliseconds: 1_000,
      presenceTtlMilliseconds: 2_000,
    });
    controller.connect();
    vi.advanceTimersByTime(700);
    controller.noteActivity();
    vi.advanceTimersByTime(999);
    expect(adapter.publications.at(-1)?.record.state).toBe("active");
    vi.advanceTimersByTime(1);
    expect(adapter.publications.at(-1)?.record).toMatchObject({
      state: "idle",
      typing: false,
    });
  });

  it("forces a final non-typing update for send, blur, switch, disconnect, and destroy", async () => {
    const adapter = new FakePresenceAdapter();
    const controller = createController(adapter);
    controller.connect();
    await flushAsyncWork();

    controller.setTyping();
    vi.advanceTimersByTime(100);
    controller.stopTyping("send");
    expect(adapter.publications.at(-1)?.record.typing).toBe(false);

    controller.setTyping();
    vi.advanceTimersByTime(100);
    controller.stopTyping("blur");
    expect(adapter.publications.at(-1)?.record.typing).toBe(false);

    controller.setTyping();
    vi.advanceTimersByTime(100);
    controller.switchConversation(conversation("conversation-b"));
    expect(adapter.publications.slice(-2).map((input) => [
      input.conversationId,
      input.record.typing,
    ])).toEqual([
      [conversation("conversation-a"), false],
      [conversation("conversation-b"), false],
    ]);

    controller.setTyping();
    vi.advanceTimersByTime(100);
    controller.disconnect();
    expect(adapter.publications.slice(-2).map(({ record }) => [
      record.state,
      record.typing,
    ])).toEqual([
      ["active", false],
      ["offline", false],
    ]);

    controller.connect();
    controller.setTyping();
    vi.advanceTimersByTime(100);
    controller.destroy();
    expect(adapter.publications.slice(-2).map(({ record }) => [
      record.state,
      record.typing,
    ])).toEqual([
      ["active", false],
      ["offline", false],
    ]);
  });

  it("prunes remote presence and typing expiry while preserving multiple devices", () => {
    const adapter = new FakePresenceAdapter();
    const controller = createController(adapter);
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.applyRemotePresence(
      remotePresence("device-one", {
        typing: true,
        typing_expires_at: new Date(NOW + 500).toISOString(),
      }),
    );
    controller.applyRemotePresence(remotePresence("device-two"));
    expect(controller.getSnapshot().records).toHaveLength(2);
    expect(new Set(controller.getSnapshot().records.map((r) => r.device_id))).toEqual(
      new Set(["device-one", "device-two"]),
    );
    expect(controller.getSnapshot().participants[0]?.record_count).toBe(2);

    vi.advanceTimersByTime(500);
    expect(controller.getSnapshot().records.every((record) => !record.typing)).toBe(
      true,
    );
    vi.advanceTimersByTime(1_500);
    expect(controller.getSnapshot().records).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });

  it("consumes subscribed remote records and republishes current state on reconnect", async () => {
    const adapter = new FakePresenceAdapter();
    const controller = createController(adapter);
    controller.connect();
    await flushAsyncWork();
    adapter.pushRemote(remotePresence("device-remote"));
    await flushAsyncWork();
    expect(
      controller.getSnapshot().records.map((record) => record.device_id),
    ).toEqual(["device-local", "device-remote"]);

    controller.disconnect();
    const beforeReconnect = adapter.publications.length;
    controller.connect();
    expect(adapter.publications).toHaveLength(beforeReconnect + 1);
    expect(adapter.publications.at(-1)?.record).toMatchObject({
      state: "active",
      typing: false,
    });
    expect(adapter.subscribeInputs.at(-1)?.conversationId).toBe(
      conversation("conversation-a"),
    );
  });

  it("recovers from thrown, rejected, and temporarily unavailable publications", async () => {
    const adapter = new FakePresenceAdapter();
    adapter.failNext("throw", "reject", "temporary_unavailable");
    const controller = createController(adapter);

    expect(() => controller.connect()).not.toThrow();
    vi.advanceTimersByTime(1_000);
    await flushAsyncWork();
    vi.advanceTimersByTime(1_000);
    await flushAsyncWork();
    vi.advanceTimersByTime(1_000);
    await flushAsyncWork();
    expect(adapter.publications).toHaveLength(4);
    expect(adapter.publications.at(-1)?.record.state).toBe("active");

    controller.setTyping();
    vi.advanceTimersByTime(100);
    expect(adapter.publications.at(-1)?.record.typing).toBe(true);
    adapter.failNext("reject");
    controller.stopTyping("blur");
    await flushAsyncWork();
    expect(
      controller
        .getSnapshot()
        .records.find((record) => record.participant_id === "participant-local")
        ?.typing,
    ).toBe(false);
    vi.advanceTimersByTime(900);
    expect(adapter.publications.at(-1)?.record.typing).toBe(false);
  });

  it("cancels injected timers/subscriptions and becomes inert after destroy", async () => {
    const adapter = new FakePresenceAdapter();
    const setTimer = vi.fn((callback: () => void, delay: number) =>
      globalThis.setTimeout(callback, delay),
    );
    const clearTimer = vi.fn((handle: number | object) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    );
    const controller = createController(adapter, {
      clock: Date.now,
      timers: { setTimeout: setTimer, clearTimeout: clearTimer },
    });
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.connect();
    controller.setTyping();
    await flushAsyncWork();
    expect(setTimer).toHaveBeenCalled();

    controller.destroy();
    const publicationsAfterDestroy = adapter.publications.length;
    const notificationsAfterDestroy = listener.mock.calls.length;
    expect(adapter.closedSubscriptionCount).toBe(1);
    expect(clearTimer).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    controller.connect();
    controller.noteActivity();
    controller.setTyping();
    controller.stopTyping("send");
    controller.applyRemotePresence(remotePresence("ignored-device"));
    controller.switchConversation(conversation("ignored-conversation"));
    vi.runAllTimers();
    await flushAsyncWork();
    expect(adapter.publications).toHaveLength(publicationsAfterDestroy);
    expect(listener).toHaveBeenCalledTimes(notificationsAfterDestroy);
    expect(vi.getTimerCount()).toBe(0);
  });
});
