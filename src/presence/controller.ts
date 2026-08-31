import type { ConversationId } from "../conversation/events.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type {
  ConversationPresenceSubscription,
  ConversationSyncAdapter,
} from "../sync/types.js";
import {
  mergePresenceRecords,
  normalizePresenceRecord,
  pruneExpiredPresenceRecords,
  selectActivePresenceRecords,
  summarizePresence,
  type PresenceClock,
  type PresenceDeviceId,
  type PresenceParticipantId,
  type PresenceParticipantKind,
  type PresenceParticipantSummary,
  type PresenceRecord,
  type PresenceSessionId,
  type PresenceState,
  type PresenceTimestamp,
} from "./types.js";

export const DEFAULT_PRESENCE_CONTROLLER_TIMING = {
  heartbeatMilliseconds: 15_000,
  idleMilliseconds: 60_000,
  typingStartDebounceMilliseconds: 150,
  typingRefreshMilliseconds: 2_000,
  presenceTtlMilliseconds: 45_000,
  typingTtlMilliseconds: 5_000,
} as const;

export type PresenceTimerHandle = number | object;

export interface PresenceTimerFunctions {
  readonly setTimeout: (
    callback: () => void,
    delayMilliseconds: number,
  ) => PresenceTimerHandle;
  readonly clearTimeout: (handle: PresenceTimerHandle) => void;
}

export interface PresenceControllerTimingOptions {
  readonly heartbeatMilliseconds?: number;
  readonly idleMilliseconds?: number;
  readonly typingStartDebounceMilliseconds?: number;
  readonly typingRefreshMilliseconds?: number;
  readonly presenceTtlMilliseconds?: number;
  readonly typingTtlMilliseconds?: number;
}

export type PresenceControllerAdapter = Pick<
  ConversationSyncAdapter,
  "publishPresence" | "subscribePresence"
>;

export interface CreatePresenceControllerOptions
  extends PresenceControllerTimingOptions {
  readonly conversationId: ConversationId;
  readonly participantId: string;
  readonly deviceId?: string;
  readonly sessionId: string;
  readonly participantKind: PresenceParticipantKind;
  readonly adapter: PresenceControllerAdapter;
  /** Returns Unix epoch milliseconds. */
  readonly clock?: PresenceClock;
  /** Both timer functions must be supplied together. */
  readonly timers?: PresenceTimerFunctions;
  readonly diagnostics?: AiDiagnosticSink;
}

export interface PresenceControllerSnapshot {
  readonly conversationId: ConversationId;
  readonly connected: boolean;
  /** Live records retain independent participant/device/session identity. */
  readonly records: readonly PresenceRecord[];
  readonly participants: readonly PresenceParticipantSummary[];
}

export type PresenceControllerListener = (
  snapshot: PresenceControllerSnapshot,
) => void;

export type PresenceTypingStopReason =
  | "explicit"
  | "send"
  | "blur"
  | "conversation_switch"
  | "disconnect"
  | "destroy";

export interface PresenceController {
  /** Connects, subscribes to remote presence, and republishes local state. */
  connect(): void;
  /** Records user activity and returns an idle local session to active. */
  noteActivity(): void;
  /** Starts debounced typing, or delegates `false` to `stopTyping`. */
  setTyping(typing?: boolean): void;
  /** Cancels pending/active typing and forces a non-typing publication. */
  stopTyping(reason?: PresenceTypingStopReason): void;
  /** Validates and merges a record received outside the adapter subscription. */
  applyRemotePresence(record: PresenceRecord): void;
  subscribe(listener: PresenceControllerListener): () => void;
  getSnapshot(): PresenceControllerSnapshot;
  /** Ends the current connection after non-typing and offline publications. */
  disconnect(): void;
  /** Stops typing in the old conversation, then connects the new identity. */
  switchConversation(conversationId: ConversationId): void;
  /** Permanently releases timers/subscriptions after final lifecycle updates. */
  destroy(): void;
}

interface ResolvedTiming {
  readonly heartbeatMilliseconds: number;
  readonly idleMilliseconds: number;
  readonly typingStartDebounceMilliseconds: number;
  readonly typingRefreshMilliseconds: number;
  readonly presenceTtlMilliseconds: number;
  readonly typingTtlMilliseconds: number;
}

interface LocalIdentity {
  readonly participantId: PresenceParticipantId;
  readonly deviceId?: PresenceDeviceId;
  readonly sessionId: PresenceSessionId;
  readonly participantKind: PresenceParticipantKind;
}

const defaultTimers: PresenceTimerFunctions = {
  setTimeout: (callback, delayMilliseconds) =>
    globalThis.setTimeout(callback, delayMilliseconds),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const readPositiveInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
};

const readNonNegativeInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
};

const resolveTiming = (
  options: PresenceControllerTimingOptions,
): ResolvedTiming => {
  const timing = {
    heartbeatMilliseconds: readPositiveInteger(
      "heartbeatMilliseconds",
      options.heartbeatMilliseconds ??
        DEFAULT_PRESENCE_CONTROLLER_TIMING.heartbeatMilliseconds,
    ),
    idleMilliseconds: readPositiveInteger(
      "idleMilliseconds",
      options.idleMilliseconds ??
        DEFAULT_PRESENCE_CONTROLLER_TIMING.idleMilliseconds,
    ),
    typingStartDebounceMilliseconds: readNonNegativeInteger(
      "typingStartDebounceMilliseconds",
      options.typingStartDebounceMilliseconds ??
        DEFAULT_PRESENCE_CONTROLLER_TIMING.typingStartDebounceMilliseconds,
    ),
    typingRefreshMilliseconds: readPositiveInteger(
      "typingRefreshMilliseconds",
      options.typingRefreshMilliseconds ??
        DEFAULT_PRESENCE_CONTROLLER_TIMING.typingRefreshMilliseconds,
    ),
    presenceTtlMilliseconds: readPositiveInteger(
      "presenceTtlMilliseconds",
      options.presenceTtlMilliseconds ??
        DEFAULT_PRESENCE_CONTROLLER_TIMING.presenceTtlMilliseconds,
    ),
    typingTtlMilliseconds: readPositiveInteger(
      "typingTtlMilliseconds",
      options.typingTtlMilliseconds ??
        DEFAULT_PRESENCE_CONTROLLER_TIMING.typingTtlMilliseconds,
    ),
  };

  if (timing.heartbeatMilliseconds >= timing.presenceTtlMilliseconds) {
    throw new TypeError(
      "heartbeatMilliseconds must be less than presenceTtlMilliseconds",
    );
  }
  if (timing.typingRefreshMilliseconds >= timing.typingTtlMilliseconds) {
    throw new TypeError(
      "typingRefreshMilliseconds must be less than typingTtlMilliseconds",
    );
  }
  return timing;
};

const recordsFingerprint = (
  connected: boolean,
  conversationId: ConversationId,
  records: readonly PresenceRecord[],
): string => JSON.stringify([connected, conversationId, records]);

class PresenceControllerImpl implements PresenceController {
  private conversationId: ConversationId;
  private readonly identity: LocalIdentity;
  private readonly adapter: PresenceControllerAdapter;
  private readonly timing: ResolvedTiming;
  private readonly clock: PresenceClock;
  private readonly timers: PresenceTimerFunctions;
  private readonly diagnostics: AiDiagnosticSink | undefined;
  private readonly listeners = new Set<PresenceControllerListener>();

  private connected = false;
  private destroyed = false;
  private localState: PresenceState = "offline";
  private typingRequested = false;
  private typingActive = false;
  private lastActivityAt: number;
  private lastLogicalTimestamp = Number.NEGATIVE_INFINITY;
  private lastLocalSemantic: string | undefined;
  private lastAttemptObservedAt: number | undefined;
  private lastAttemptSemantic: string | undefined;
  private localRecord: PresenceRecord | undefined;
  private remoteRecords: readonly PresenceRecord[] = [];
  private snapshot: PresenceControllerSnapshot;
  private snapshotFingerprint: string;

  private heartbeatTimer: PresenceTimerHandle | undefined;
  private idleTimer: PresenceTimerHandle | undefined;
  private typingDebounceTimer: PresenceTimerHandle | undefined;
  private typingRefreshTimer: PresenceTimerHandle | undefined;
  private expiryTimer: PresenceTimerHandle | undefined;
  private transportSubscription: ConversationPresenceSubscription | undefined;
  private subscriptionGeneration = 0;

  constructor(options: CreatePresenceControllerOptions) {
    this.conversationId = options.conversationId;
    this.adapter = options.adapter;
    this.timing = resolveTiming(options);
    this.clock = options.clock ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.diagnostics = options.diagnostics;
    this.lastActivityAt = this.readNow();

    const identityRecord = normalizePresenceRecord({
      participant_id: options.participantId,
      ...(options.deviceId === undefined ? {} : { device_id: options.deviceId }),
      session_id: options.sessionId,
      participant_kind: options.participantKind,
      state: "offline",
      typing: false,
      updated_at: this.toTimestamp(this.lastActivityAt),
      expires_at: this.toTimestamp(
        this.lastActivityAt + this.timing.presenceTtlMilliseconds,
      ),
    });
    this.identity = {
      participantId: identityRecord.participant_id,
      ...(identityRecord.device_id === undefined
        ? {}
        : { deviceId: identityRecord.device_id }),
      sessionId: identityRecord.session_id,
      participantKind: identityRecord.participant_kind,
    };

    this.snapshot = Object.freeze({
      conversationId: this.conversationId,
      connected: false,
      records: Object.freeze([]) as readonly PresenceRecord[],
      participants: Object.freeze([]) as readonly PresenceParticipantSummary[],
    });
    this.snapshotFingerprint = recordsFingerprint(
      false,
      this.conversationId,
      [],
    );
  }

  connect(): void {
    if (this.destroyed) return;
    const wasConnected = this.connected;
    this.closeTransportSubscription();
    this.clearTimer("heartbeatTimer");
    this.clearTimer("idleTimer");

    this.connected = true;
    if (!wasConnected) {
      const now = this.readNow();
      this.localState =
        now - this.lastActivityAt >= this.timing.idleMilliseconds
          ? "idle"
          : "active";
    }
    this.publishLocal(true, false);
    this.scheduleHeartbeat();
    this.scheduleIdle();
    if (this.typingRequested && !this.typingActive) {
      this.scheduleTypingStart();
    } else if (this.typingActive) {
      this.scheduleTypingRefresh();
    }

    const generation = this.subscriptionGeneration;
    void this.openTransportSubscription(generation);
  }

  noteActivity(): void {
    if (this.destroyed) return;
    this.lastActivityAt = this.readNow();
    if (!this.connected) return;
    const changed = this.localState !== "active";
    this.localState = "active";
    if (changed) this.publishLocal(false, true);
    this.scheduleIdle();
  }

  setTyping(typing = true): void {
    if (!typing) {
      this.stopTyping("explicit");
      return;
    }
    if (this.destroyed) return;
    this.noteActivity();
    if (!this.connected || this.typingRequested) return;
    this.typingRequested = true;
    this.scheduleTypingStart();
  }

  stopTyping(reason: PresenceTypingStopReason = "explicit"): void {
    void reason;
    if (this.destroyed) return;
    this.typingRequested = false;
    this.typingActive = false;
    this.clearTimer("typingDebounceTimer");
    this.clearTimer("typingRefreshTimer");
    if (this.connected) this.publishLocal(true, false);
  }

  applyRemotePresence(record: PresenceRecord): void {
    if (this.destroyed) return;
    const normalized = normalizePresenceRecord(record);
    this.remoteRecords = mergePresenceRecords(this.remoteRecords, [normalized]);
    this.rebuildSnapshot(true);
  }

  subscribe(listener: PresenceControllerListener): () => void {
    if (this.destroyed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): PresenceControllerSnapshot {
    if (!this.destroyed) this.rebuildSnapshot(false);
    return this.snapshot;
  }

  disconnect(): void {
    if (this.destroyed || !this.connected) return;
    this.typingRequested = false;
    this.typingActive = false;
    this.clearConnectionTimers();

    // A distinct non-typing update makes every lifecycle exit explicit even
    // when an offline tombstone is delayed or dropped by the transport.
    this.publishLocal(true, false);
    this.connected = false;
    this.localState = "offline";
    this.publishLocal(true, false, true);
    this.closeTransportSubscription();
  }

  switchConversation(conversationId: ConversationId): void {
    if (this.destroyed || conversationId === this.conversationId) return;
    const shouldReconnect = this.connected;
    this.typingRequested = false;
    this.typingActive = false;
    this.clearConnectionTimers();

    if (shouldReconnect) this.publishLocal(true, false);
    else this.publishLocal(true, false, true);
    this.closeTransportSubscription();

    this.conversationId = conversationId;
    this.remoteRecords = [];
    this.localRecord = undefined;
    this.lastLocalSemantic = undefined;
    this.lastAttemptObservedAt = undefined;
    this.lastAttemptSemantic = undefined;
    this.localState = shouldReconnect ? "active" : "offline";
    this.lastActivityAt = this.readNow();
    this.rebuildSnapshot(true);

    if (shouldReconnect) {
      this.publishLocal(true, false);
      this.scheduleHeartbeat();
      this.scheduleIdle();
      const generation = this.subscriptionGeneration;
      void this.openTransportSubscription(generation);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    if (this.connected) {
      this.disconnect();
    } else {
      this.localState = "offline";
      this.typingRequested = false;
      this.typingActive = false;
      this.publishLocal(true, false, true);
    }
    this.destroyed = true;
    this.clearEveryTimer();
    this.closeTransportSubscription();
    this.listeners.clear();
  }

  private readNow(): number {
    const now = this.clock();
    if (!Number.isFinite(now)) {
      throw new TypeError("clock must return finite Unix epoch milliseconds");
    }
    return now;
  }

  private toTimestamp(milliseconds: number): PresenceTimestamp {
    return new Date(milliseconds).toISOString() as PresenceTimestamp;
  }

  private nextLogicalTimestamp(observedNow: number): number {
    const timestamp = Math.max(observedNow, this.lastLogicalTimestamp + 1);
    this.lastLogicalTimestamp = timestamp;
    return timestamp;
  }

  private localSemantic(state: PresenceState, typing: boolean): string {
    return JSON.stringify([state, typing]);
  }

  private publishLocal(
    force: boolean,
    coalesceSameTick: boolean,
    allowDisconnected = false,
  ): void {
    if (this.destroyed || (!this.connected && !allowDisconnected)) return;
    const typing = this.localState === "offline" ? false : this.typingActive;
    const semantic = this.localSemantic(this.localState, typing);
    if (!force && semantic === this.lastLocalSemantic) return;

    const observedNow = this.readNow();
    if (
      force &&
      coalesceSameTick &&
      observedNow === this.lastAttemptObservedAt &&
      semantic === this.lastAttemptSemantic
    ) {
      return;
    }

    const updatedAt = this.nextLogicalTimestamp(observedNow);
    const record = normalizePresenceRecord({
      participant_id: this.identity.participantId,
      ...(this.identity.deviceId === undefined
        ? {}
        : { device_id: this.identity.deviceId }),
      session_id: this.identity.sessionId,
      participant_kind: this.identity.participantKind,
      state: this.localState,
      typing,
      updated_at: this.toTimestamp(updatedAt),
      expires_at: this.toTimestamp(
        updatedAt + this.timing.presenceTtlMilliseconds,
      ),
      ...(typing
        ? {
            typing_expires_at: this.toTimestamp(
              updatedAt + this.timing.typingTtlMilliseconds,
            ),
          }
        : {}),
    });

    this.localRecord = record;
    this.lastLocalSemantic = semantic;
    this.lastAttemptObservedAt = observedNow;
    this.lastAttemptSemantic = semantic;
    this.rebuildSnapshot(true);
    this.safePublish(this.conversationId, record);
  }

  private safePublish(
    conversationId: ConversationId,
    record: PresenceRecord,
  ): void {
    try {
      const result = this.adapter.publishPresence({ conversationId, record });
      void Promise.resolve(result).catch((cause: unknown) => emitAiDiagnostic(this.diagnostics, {
        domain: "presence", operation: "publish", phase: "failed", conversationId,
        code: "publish_failed", retryable: true, cause,
      }));
    } catch (cause) {
      emitAiDiagnostic(this.diagnostics, { domain: "presence", operation: "publish", phase: "failed",
        conversationId, code: "publish_failed", retryable: true, cause });
      // A synchronous adapter failure is equivalent to a rejected publication.
      // Heartbeat/typing refresh or a later lifecycle call will retry state.
    }
  }

  private scheduleHeartbeat(): void {
    this.clearTimer("heartbeatTimer");
    if (!this.connected || this.destroyed) return;
    this.heartbeatTimer = this.timers.setTimeout(() => {
      this.heartbeatTimer = undefined;
      if (!this.connected || this.destroyed) return;
      this.publishLocal(true, true);
      this.scheduleHeartbeat();
    }, this.timing.heartbeatMilliseconds);
  }

  private scheduleIdle(): void {
    this.clearTimer("idleTimer");
    if (!this.connected || this.destroyed) return;
    const delay = Math.max(
      0,
      this.lastActivityAt + this.timing.idleMilliseconds - this.readNow(),
    );
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.connected || this.destroyed) return;
      if (
        this.readNow() - this.lastActivityAt <
        this.timing.idleMilliseconds
      ) {
        this.scheduleIdle();
        return;
      }
      this.typingRequested = false;
      this.typingActive = false;
      this.clearTimer("typingDebounceTimer");
      this.clearTimer("typingRefreshTimer");
      this.localState = "idle";
      this.publishLocal(false, true);
    }, delay);
  }

  private scheduleTypingStart(): void {
    this.clearTimer("typingDebounceTimer");
    if (!this.connected || this.destroyed || !this.typingRequested) return;
    this.typingDebounceTimer = this.timers.setTimeout(() => {
      this.typingDebounceTimer = undefined;
      if (!this.connected || this.destroyed || !this.typingRequested) return;
      this.typingActive = true;
      this.publishLocal(false, true);
      this.scheduleTypingRefresh();
    }, this.timing.typingStartDebounceMilliseconds);
  }

  private scheduleTypingRefresh(): void {
    this.clearTimer("typingRefreshTimer");
    if (
      !this.connected ||
      this.destroyed ||
      !this.typingRequested ||
      !this.typingActive
    ) {
      return;
    }
    this.typingRefreshTimer = this.timers.setTimeout(() => {
      this.typingRefreshTimer = undefined;
      if (
        !this.connected ||
        this.destroyed ||
        !this.typingRequested ||
        !this.typingActive
      ) {
        return;
      }
      this.publishLocal(true, true);
      this.scheduleTypingRefresh();
    }, this.timing.typingRefreshMilliseconds);
  }

  private rebuildSnapshot(notify: boolean): void {
    const now = this.readNow();
    this.remoteRecords = pruneExpiredPresenceRecords(this.remoteRecords, {
      clock: () => now,
    });
    const candidates =
      this.localRecord === undefined
        ? this.remoteRecords
        : mergePresenceRecords(this.remoteRecords, [this.localRecord]);
    const records = Object.freeze(
      selectActivePresenceRecords(candidates, { clock: () => now }),
    );
    const participants = Object.freeze(
      summarizePresence(records, { clock: () => now }),
    );
    const fingerprint = recordsFingerprint(
      this.connected,
      this.conversationId,
      records,
    );
    const changed = fingerprint !== this.snapshotFingerprint;
    if (changed) {
      this.snapshot = Object.freeze({
        conversationId: this.conversationId,
        connected: this.connected,
        records,
        participants,
      });
      this.snapshotFingerprint = fingerprint;
    }
    this.scheduleExpiry();
    if (changed && notify && !this.destroyed) this.notifyListeners();
  }

  private scheduleExpiry(): void {
    this.clearTimer("expiryTimer");
    if (this.destroyed || this.remoteRecords.length === 0) return;
    const now = this.readNow();
    let expiry = Number.POSITIVE_INFINITY;
    for (const record of this.remoteRecords) {
      expiry = Math.min(expiry, Date.parse(record.expires_at));
      if (record.typing_expires_at !== undefined) {
        expiry = Math.min(expiry, Date.parse(record.typing_expires_at));
      }
    }
    if (!Number.isFinite(expiry)) return;
    this.expiryTimer = this.timers.setTimeout(() => {
      this.expiryTimer = undefined;
      if (!this.destroyed) this.rebuildSnapshot(true);
    }, Math.max(0, expiry - now));
  }

  private notifyListeners(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot);
      } catch {
        // Subscriber failures are isolated from controller lifecycle work.
      }
    }
  }

  private async openTransportSubscription(generation: number): Promise<void> {
    try {
      const result = await this.adapter.subscribePresence({
        conversationId: this.conversationId,
      });
      if (result.status !== "subscribed") return;
      if (
        this.destroyed ||
        !this.connected ||
        generation !== this.subscriptionGeneration
      ) {
        result.subscription.close();
        return;
      }

      this.transportSubscription = result.subscription;
      try {
        for await (const update of result.subscription.updates) {
          if (
            this.destroyed ||
            !this.connected ||
            generation !== this.subscriptionGeneration
          ) {
            break;
          }
          if (update.status === "presence") {
            try {
              this.applyRemotePresence(update.record);
            } catch {
              // Treat malformed adapter input as a dropped ephemeral update.
            }
          }
        }
      } catch {
        // Subscription transport failures are recoverable through connect().
      } finally {
        if (generation === this.subscriptionGeneration) {
          this.transportSubscription = undefined;
        }
      }
    } catch {
      // A thrown/rejected subscribe attempt leaves local timers operational.
    }
  }

  private closeTransportSubscription(): void {
    this.subscriptionGeneration += 1;
    const subscription = this.transportSubscription;
    this.transportSubscription = undefined;
    if (subscription !== undefined) {
      try {
        subscription.close();
      } catch {
        // Closing is best effort for an ephemeral transport handle.
      }
    }
  }

  private clearConnectionTimers(): void {
    this.clearTimer("heartbeatTimer");
    this.clearTimer("idleTimer");
    this.clearTimer("typingDebounceTimer");
    this.clearTimer("typingRefreshTimer");
  }

  private clearEveryTimer(): void {
    this.clearConnectionTimers();
    this.clearTimer("expiryTimer");
  }

  private clearTimer(
    key:
      | "heartbeatTimer"
      | "idleTimer"
      | "typingDebounceTimer"
      | "typingRefreshTimer"
      | "expiryTimer",
  ): void {
    const handle = this[key];
    if (handle === undefined) return;
    this.timers.clearTimeout(handle);
    this[key] = undefined;
  }
}

export const createPresenceController = (
  options: CreatePresenceControllerOptions,
): PresenceController => new PresenceControllerImpl(options);
