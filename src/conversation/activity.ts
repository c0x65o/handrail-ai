import type { ConversationId } from "./events.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";

export type ConversationActivityTurnStatus = "idle" | "running" | "completed" | "error";

export interface ConversationActivityRecord {
  readonly conversationId: ConversationId | string;
  readonly turnStatus: ConversationActivityTurnStatus;
  readonly unread: boolean;
  readonly updatedAt?: string;
}

export interface ConversationActivityReadable {
  getSnapshot(): readonly ConversationActivityRecord[];
  subscribe(listener: () => void): () => void;
}

export interface ConversationActivityStore extends ConversationActivityReadable {
  replace(records: readonly ConversationActivityRecord[]): void;
  upsert(record: ConversationActivityRecord): void;
  remove(conversationId: ConversationId | string): void;
  markRead(conversationId: ConversationId | string): void;
}

/** Server persistence contract for a principal/workspace-scoped activity index. */
export interface DurableConversationActivityStore {
  list(): Promise<readonly ConversationActivityRecord[]>;
  upsert(record: ConversationActivityRecord): Promise<ConversationActivityRecord>;
  markRead(conversationId: ConversationId | string): Promise<ConversationActivityRecord | null>;
}

export const LIVE_CONVERSATION_ACTIVITY_PROTOCOL_VERSION =
  "handrail.live-conversation-activity.v1" as const;

export interface LiveConversationActivityEnvelope {
  readonly version: typeof LIVE_CONVERSATION_ACTIVITY_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly deliveryId: string;
  readonly record: ConversationActivityRecord;
}

export interface LiveConversationActivitySubscription
  extends AsyncIterable<LiveConversationActivityEnvelope> {
  close(): void;
}

export interface LiveConversationActivityDelivery {
  publish(record: ConversationActivityRecord): Promise<void>;
  subscribe(signal?: AbortSignal): LiveConversationActivitySubscription;
}

/** Multi-instance fan-out seam for a principal/workspace-scoped activity channel. */
export interface LiveConversationActivityPubSub {
  publish(channel: string, envelope: LiveConversationActivityEnvelope): Promise<void>;
  subscribe(
    channel: string,
    receive: (envelope: LiveConversationActivityEnvelope) => void,
  ): Promise<() => void>;
}

export interface InMemoryLiveConversationActivityOptions {
  readonly pubSub?: LiveConversationActivityPubSub;
  readonly channel?: string;
  readonly now?: () => number;
}

interface ActivitySubscriber {
  push(value: LiveConversationActivityEnvelope): void;
  close(): void;
}

function activityQueue(onClose: () => void): LiveConversationActivitySubscription & ActivitySubscriber {
  const values: LiveConversationActivityEnvelope[] = [];
  const waiters: Array<(result: IteratorResult<LiveConversationActivityEnvelope>) => void> = [];
  let closed = false;
  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ done: false, value });
      else values.push(value);
    },
    close() {
      if (closed) return;
      closed = true;
      onClose();
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const value = values.shift();
          if (value) return Promise.resolve({ done: false as const, value });
          if (closed) return Promise.resolve({ done: true as const, value: undefined });
          return new Promise<IteratorResult<LiveConversationActivityEnvelope>>((resolve) => waiters.push(resolve));
        },
        return: async () => {
          this.close();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

/** Process-local delivery with an injectable Redis/NATS/Postgres pub-sub bridge. */
export function createInMemoryLiveConversationActivityDelivery(
  options: InMemoryLiveConversationActivityOptions = {},
): LiveConversationActivityDelivery {
  const subscribers = new Set<ActivitySubscriber>();
  const seen = new Set<string>();
  const channel = options.channel ?? "handrail:conversation-activity";
  const now = options.now ?? Date.now;
  let sequence = 0;
  let counter = 0;
  let subscribed: Promise<() => void> | null = null;
  const emit = (envelope: LiveConversationActivityEnvelope) => {
    if (seen.has(envelope.deliveryId)) return;
    seen.add(envelope.deliveryId);
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);
    for (const subscriber of subscribers) subscriber.push(envelope);
  };
  return Object.freeze({
    async publish(input: ConversationActivityRecord) {
      const record = parseConversationActivityRecord(input);
      const envelope = Object.freeze({
        version: LIVE_CONVERSATION_ACTIVITY_PROTOCOL_VERSION,
        sequence: ++sequence,
        deliveryId: `${now().toString(36)}-${(++counter).toString(36)}`,
        record,
      });
      emit(envelope);
      await options.pubSub?.publish(channel, envelope);
    },
    subscribe(signal?: AbortSignal) {
      const queue = activityQueue(() => subscribers.delete(queue));
      subscribers.add(queue);
      if (options.pubSub && subscribed === null) {
        subscribed = options.pubSub.subscribe(channel, emit);
      }
      signal?.addEventListener("abort", () => queue.close(), { once: true });
      return queue;
    },
  });
}

const ACTIVITY_STATUSES = new Set<ConversationActivityTurnStatus>([
  "idle", "running", "completed", "error",
]);

export function parseConversationActivityRecord(input: ConversationActivityRecord): ConversationActivityRecord {
  const conversationId = String(input.conversationId).trim();
  if (!conversationId || conversationId.length > 256 || !ACTIVITY_STATUSES.has(input.turnStatus) ||
    typeof input.unread !== "boolean") throw new TypeError("Conversation activity record is invalid");
  if (input.updatedAt !== undefined && (!Number.isFinite(Date.parse(input.updatedAt)) || input.updatedAt.length > 64)) {
    throw new TypeError("Conversation activity timestamp is invalid");
  }
  return Object.freeze({ conversationId, turnStatus: input.turnStatus, unread: input.unread,
    ...(input.updatedAt === undefined ? {} : { updatedAt: new Date(input.updatedAt).toISOString() }) });
}

function activitySnapshot(records: Iterable<ConversationActivityRecord>): readonly ConversationActivityRecord[] {
  return Object.freeze([...records].sort((left, right) =>
    (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
    String(left.conversationId).localeCompare(String(right.conversationId))));
}

/** Shared activity index for open, unopened, local, or remotely running conversations. */
export class InMemoryConversationActivityStore implements ConversationActivityStore {
  readonly #records = new Map<string, ConversationActivityRecord>();
  readonly #listeners = new Set<() => void>();
  #snapshot: readonly ConversationActivityRecord[] = Object.freeze([]);

  getSnapshot = (): readonly ConversationActivityRecord[] => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener); return () => this.#listeners.delete(listener);
  };
  replace(records: readonly ConversationActivityRecord[]): void {
    const next = new Map<string, ConversationActivityRecord>();
    for (const input of records) {
      const record = parseConversationActivityRecord(input);
      if (next.has(String(record.conversationId))) throw new TypeError("Conversation activity record is duplicated");
      next.set(String(record.conversationId), record);
    }
    this.#records.clear();
    for (const [key, value] of next) this.#records.set(key, value);
    this.#publish();
  }
  upsert(input: ConversationActivityRecord): void {
    const record = parseConversationActivityRecord(input);
    this.#records.set(String(record.conversationId), record); this.#publish();
  }
  remove(conversationId: ConversationId | string): void {
    if (this.#records.delete(String(conversationId))) this.#publish();
  }
  markRead(conversationId: ConversationId | string): void {
    const current = this.#records.get(String(conversationId));
    if (current?.unread) {
      this.#records.set(String(conversationId), Object.freeze({ ...current, unread: false }));
      this.#publish();
    }
  }
  #publish(): void {
    const next = activitySnapshot(this.#records.values());
    if (JSON.stringify(next) === JSON.stringify(this.#snapshot)) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

export interface PollingConversationActivityOptions {
  readonly load: (signal: AbortSignal) => Promise<readonly ConversationActivityRecord[]>;
  readonly intervalMilliseconds?: number;
  readonly store?: ConversationActivityStore;
  /** Optional protected live stream. Polling remains the convergence fallback. */
  readonly subscribe?: (signal: AbortSignal) => AsyncIterable<ConversationActivityRecord>;
  /** Receives bounded lifecycle failures for both the live and polling paths. */
  readonly diagnostics?: AiDiagnosticSink;
}

/** Cross-platform polling adapter for server-backed launcher activity indexes. */
export class PollingConversationActivity implements ConversationActivityReadable {
  readonly #store: ConversationActivityStore;
  readonly #load: PollingConversationActivityOptions["load"];
  readonly #intervalMilliseconds: number;
  readonly #subscribe: PollingConversationActivityOptions["subscribe"];
  readonly #diagnostics: AiDiagnosticSink | undefined;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #controller: AbortController | null = null;
  #liveController: AbortController | null = null;

  constructor(options: PollingConversationActivityOptions) {
    const interval = options.intervalMilliseconds ?? 5_000;
    if (!Number.isSafeInteger(interval) || interval < 500 || interval > 300_000) {
      throw new TypeError("intervalMilliseconds must be between 500 and 300000");
    }
    this.#store = options.store ?? new InMemoryConversationActivityStore();
    this.#load = options.load;
    this.#subscribe = options.subscribe;
    this.#diagnostics = options.diagnostics;
    this.#intervalMilliseconds = interval;
  }
  getSnapshot = () => this.#store.getSnapshot();
  subscribe = (listener: () => void) => this.#store.subscribe(listener);
  start(): void {
    if (this.#timer === null && this.#controller === null) void this.refresh();
    if (this.#subscribe && this.#liveController === null) {
      const controller = new AbortController();
      this.#liveController = controller;
      void (async () => {
        try {
          for await (const record of this.#subscribe!(controller.signal)) {
            if (controller.signal.aborted) break;
            this.#store.upsert(record);
          }
        } catch (cause) {
          if (!controller.signal.aborted) emitAiDiagnostic(this.#diagnostics, {
            domain: "activity", operation: "live_subscribe", phase: "failed",
            code: "activity_stream_unavailable", retryable: true, cause,
          });
          // The scheduled authoritative poll remains the recovery path.
        } finally {
          if (this.#liveController === controller) this.#liveController = null;
        }
      })();
    }
  }
  async refresh(): Promise<void> {
    if (this.#controller) return;
    const controller = new AbortController(); this.#controller = controller;
    try {
      this.#store.replace(await this.#load(controller.signal));
    } catch (cause) {
      if (!controller.signal.aborted) emitAiDiagnostic(this.#diagnostics, {
        domain: "activity", operation: "poll", phase: "failed",
        code: "activity_poll_unavailable", retryable: true, cause,
      });
    }
    finally {
      if (this.#controller === controller) this.#controller = null;
      if (!controller.signal.aborted) this.#timer = setTimeout(() => {
        this.#timer = null; void this.refresh();
      }, this.#intervalMilliseconds);
    }
  }
  stop(): void {
    this.#controller?.abort(); this.#controller = null;
    this.#liveController?.abort(); this.#liveController = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
