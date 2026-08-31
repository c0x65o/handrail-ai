import type { ConversationId } from "./events.js";

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
}

/** Cross-platform polling adapter for server-backed launcher activity indexes. */
export class PollingConversationActivity implements ConversationActivityReadable {
  readonly #store: ConversationActivityStore;
  readonly #load: PollingConversationActivityOptions["load"];
  readonly #intervalMilliseconds: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #controller: AbortController | null = null;

  constructor(options: PollingConversationActivityOptions) {
    const interval = options.intervalMilliseconds ?? 5_000;
    if (!Number.isSafeInteger(interval) || interval < 500 || interval > 300_000) {
      throw new TypeError("intervalMilliseconds must be between 500 and 300000");
    }
    this.#store = options.store ?? new InMemoryConversationActivityStore();
    this.#load = options.load;
    this.#intervalMilliseconds = interval;
  }
  getSnapshot = () => this.#store.getSnapshot();
  subscribe = (listener: () => void) => this.#store.subscribe(listener);
  start(): void { if (this.#timer === null && this.#controller === null) void this.refresh(); }
  async refresh(): Promise<void> {
    if (this.#controller) return;
    const controller = new AbortController(); this.#controller = controller;
    try { this.#store.replace(await this.#load(controller.signal)); }
    finally {
      if (this.#controller === controller) this.#controller = null;
      if (!controller.signal.aborted) this.#timer = setTimeout(() => {
        this.#timer = null; void this.refresh();
      }, this.#intervalMilliseconds);
    }
  }
  stop(): void {
    this.#controller?.abort(); this.#controller = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
