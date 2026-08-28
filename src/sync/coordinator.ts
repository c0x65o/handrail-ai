import {
  parseConversationEvent,
  type ConversationEvent,
  type ConversationId,
  type ConversationJsonValue,
  type ConversationRevision,
} from "../conversation/events.js";
import type { ConversationEventStore } from "../conversation/event-store.js";
import { replayConversation } from "../conversation/replay.js";
import type { ConversationState } from "../conversation/state.js";
import {
  createConversationStore,
  type ConversationStore,
  type ConversationStoreEquality,
  type ConversationStoreSelector,
  type ConversationStoreSelectorListener,
} from "../conversation/store.js";
import type {
  ConversationSyncAdapter,
  ConversationSyncMutation,
  ConversationSyncMutationEvent,
  ConversationSyncOperationFailure,
  ConversationSyncSnapshot,
  ConversationSyncSubscription,
} from "./types.js";

export type ConversationSyncStatus =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline"
  | "error";

export interface ConversationSyncCoordinatorState {
  readonly status: ConversationSyncStatus;
  readonly revision: ConversationRevision | null;
  readonly pendingMutationCount: number;
  readonly reconnectAttempt: number;
  readonly error: unknown;
}

export type ConversationSyncCoordinatorListener = (
  state: ConversationSyncCoordinatorState,
) => void;

/** A stable, read-only view over the coordinator's current projected store. */
export interface ConversationSyncViewStore {
  getSnapshot(): ConversationState;
  subscribe(listener: () => void): () => void;
  select<Selected>(selector: ConversationStoreSelector<Selected>): Selected;
  select<Selected>(
    selector: ConversationStoreSelector<Selected>,
    listener: ConversationStoreSelectorListener<Selected>,
    isEqual?: ConversationStoreEquality<Selected>,
  ): () => void;
}

export interface ConversationSyncClock {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface ConversationSyncBackoffInput {
  readonly attempt: number;
  readonly retryAfterMilliseconds?: number;
  readonly error: unknown;
}

export type ConversationSyncBackoff = (
  input: ConversationSyncBackoffInput,
) => number;

export interface ConversationSyncMutationRejection {
  readonly mutation: ConversationSyncMutation;
  readonly failure: ConversationSyncOperationFailure;
}

export interface CreateConversationSyncCoordinatorOptions<
  TSnapshot extends ConversationJsonValue = ConversationJsonValue,
> {
  readonly conversationId: ConversationId;
  readonly eventStore: ConversationEventStore;
  readonly adapter: ConversationSyncAdapter<TSnapshot>;
  /** Decode an application snapshot into the standard headless projection. */
  readonly decodeSnapshot?: (
    snapshot: ConversationSyncSnapshot<TSnapshot>,
  ) => ConversationState;
  readonly readBatchSize?: number;
  readonly clock?: ConversationSyncClock;
  readonly backoff?: ConversationSyncBackoff;
  readonly onMutationRejected?: (
    rejection: ConversationSyncMutationRejection,
  ) => void;
}

export interface ConversationSyncCoordinator {
  readonly store: ConversationSyncViewStore;
  getState(): ConversationSyncCoordinatorState;
  subscribe(listener: ConversationSyncCoordinatorListener): () => void;
  start(): Promise<void>;
  queueMutation(mutation: ConversationSyncMutation): Promise<void>;
  /** Alias for queueMutation, useful at transport boundaries. */
  enqueueMutation(mutation: ConversationSyncMutation): Promise<void>;
  /** Wait for all currently scheduled catch-up and push work. */
  flush(): Promise<void>;
  stop(): Promise<void>;
  destroy(): Promise<void>;
}

export class ConversationSyncCoordinatorDestroyedError extends Error {
  constructor() {
    super("Conversation sync coordinator is destroyed");
    this.name = "ConversationSyncCoordinatorDestroyedError";
  }
}

export class ConversationSyncSnapshotError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ConversationSyncSnapshotError";
  }
}

class RemoteRevisionGapError extends Error {
  constructor() {
    super("Remote durable events are not contiguous with the local revision");
    this.name = "RemoteRevisionGapError";
  }
}

const DEFAULT_CLOCK: ConversationSyncClock = {
  wait(milliseconds, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const timeout = setTimeout(finish, milliseconds);
      signal.addEventListener("abort", abort, { once: true });

      function finish(): void {
        signal.removeEventListener("abort", abort);
        resolve();
      }
      function abort(): void {
        clearTimeout(timeout);
        reject(signal.reason);
      }
    });
  },
};

const DEFAULT_BACKOFF: ConversationSyncBackoff = ({
  attempt,
  retryAfterMilliseconds,
}) => retryAfterMilliseconds ?? Math.min(30_000, 250 * 2 ** (attempt - 1));

/**
 * Coordinate one local durable log, one headless projection, and one remote
 * authoritative adapter. Presence is intentionally absent from this API.
 */
export function createConversationSyncCoordinator<
  TSnapshot extends ConversationJsonValue = ConversationJsonValue,
>(
  options: CreateConversationSyncCoordinatorOptions<TSnapshot>,
): ConversationSyncCoordinator {
  const {
    conversationId,
    eventStore,
    adapter,
    readBatchSize,
    clock = DEFAULT_CLOCK,
    backoff = DEFAULT_BACKOFF,
    onMutationRejected,
  } = options;
  if (
    readBatchSize !== undefined &&
    (!Number.isSafeInteger(readBatchSize) || readBatchSize <= 0)
  ) {
    throw new RangeError("Conversation sync batch size must be a positive safe integer");
  }

  let authoritativeStore: ConversationStore = createConversationStore(conversationId);
  let viewState = authoritativeStore.getSnapshot();
  let localDurableRevision: ConversationRevision | null = null;
  let state: ConversationSyncCoordinatorState = freezeState("idle", null, 0, 0, null);
  let operationBoundary: Promise<void> = Promise.resolve();
  let subscription: ConversationSyncSubscription | null = null;
  let reconnectAbort: AbortController | null = null;
  let generation = 0;
  let started = false;
  let destroyed = false;
  const pending = new Map<string, ConversationSyncMutation>();
  const listeners = new Set<ConversationSyncCoordinatorListener>();
  const viewListeners = new Set<() => void>();
  const selectorSubscriptions = new Set<{
    notify(snapshot: ConversationState): void;
  }>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue;
      try {
        listener(state);
      } catch {
        // Observers cannot alter coordination.
      }
    }
  };

  const notifyView = (): void => {
    for (const listener of [...viewListeners]) {
      if (!viewListeners.has(listener)) continue;
      try {
        listener();
      } catch {
        // Observers cannot alter projection updates.
      }
    }
    for (const subscription of [...selectorSubscriptions]) {
      if (!selectorSubscriptions.has(subscription)) continue;
      try {
        subscription.notify(viewState);
      } catch {
        // Selector failures do not alter projection updates.
      }
    }
  };

  const publishState = (
    status = state.status,
    error: unknown = state.error,
    reconnectAttempt = state.reconnectAttempt,
  ): void => {
    const next = freezeState(
      status,
      authoritativeStore.getSnapshot().revision,
      pending.size,
      reconnectAttempt,
      error,
    );
    if (
      next.status === state.status &&
      next.revision === state.revision &&
      next.pendingMutationCount === state.pendingMutationCount &&
      next.reconnectAttempt === state.reconnectAttempt &&
      next.error === state.error
    ) return;
    state = next;
    notify();
  };

  const assertUsable = (): void => {
    if (destroyed) throw new ConversationSyncCoordinatorDestroyedError();
  };

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationBoundary.then(operation);
    operationBoundary = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const replaceAuthoritativeStore = (next: ConversationStore): void => {
    const previous = authoritativeStore;
    authoritativeStore = next;
    previous.destroy();
  };

  const rebuildView = async (): Promise<void> => {
    const optimistic = createConversationStore(
      conversationId,
      authoritativeStore.getSnapshot(),
    );
    const events = rebasePendingEvents(
      [...pending.values()],
      authoritativeStore.getSnapshot().revision,
    );
    if (events.length > 0) await optimistic.applyEvents(events);
    const next = optimistic.getSnapshot();
    optimistic.destroy();
    if (next !== viewState) {
      viewState = next;
      notifyView();
    }
    publishState();
  };

  const persistAndApply = async (
    events: readonly ConversationEvent[],
  ): Promise<void> => {
    if (events.length === 0) return;
    const current = authoritativeStore.getSnapshot();
    const seenEvents = new Set<string>(current.processed_event_ids);
    const seenMutations = new Set<string>(current.processed_mutation_ids);
    const fresh: ConversationEvent[] = [];
    let expected = (current.revision ?? 0) + 1;

    for (const candidate of events) {
      const event = parseConversationEvent(candidate);
      if (event.conversation_id !== conversationId) throw new RemoteRevisionGapError();
      if (
        seenEvents.has(event.event_id) ||
        (event.mutation_id !== undefined && seenMutations.has(event.mutation_id))
      ) continue;
      if (event.revision !== expected) throw new RemoteRevisionGapError();
      fresh.push(event);
      seenEvents.add(event.event_id);
      if (event.mutation_id !== undefined) seenMutations.add(event.mutation_id);
      expected += 1;
    }
    if (fresh.length === 0) return;

    if (localDurableRevision === current.revision) {
      await eventStore.append({
        conversationId,
        expectedRevision: localDurableRevision,
        events: fresh,
      });
      localDurableRevision = fresh.at(-1)!.revision;
    }
    const applied = await authoritativeStore.applyEvents(fresh);
    if (applied.replay_error !== null) throw new RemoteRevisionGapError();
    await rebuildView();
  };

  const installSnapshot = async (
    snapshot: ConversationSyncSnapshot<TSnapshot>,
  ): Promise<void> => {
    if (snapshot.conversationId !== conversationId) {
      throw new ConversationSyncSnapshotError(
        "Sync snapshot belongs to another conversation",
      );
    }
    const decoded = options.decodeSnapshot === undefined
      ? defaultDecodeSnapshot(snapshot)
      : options.decodeSnapshot(snapshot);
    validateDecodedSnapshot(decoded, snapshot.conversationId, snapshot.revision);
    replaceAuthoritativeStore(createConversationStore(conversationId, decoded));
    await rebuildView();
  };

  const pullAndInstallSnapshot = async (): Promise<
    ConversationSyncOperationFailure | null
  > => {
    const result = await adapter.pullSnapshot({ conversationId });
    if (result.status !== "snapshot") return result;
    await installSnapshot(result.snapshot);
    return null;
  };

  const catchUp = async (): Promise<ConversationSyncOperationFailure | null> => {
    for (;;) {
      const result = await adapter.readSince({
        conversationId,
        afterRevision: authoritativeStore.getSnapshot().revision,
        ...(readBatchSize === undefined ? {} : { limit: readBatchSize }),
      });
      if (result.status === "snapshot_required") return pullAndInstallSnapshot();
      if (result.status !== "events") return result;
      try {
        await persistAndApply(result.events);
      } catch (error) {
        if (!(error instanceof RemoteRevisionGapError)) throw error;
        return pullAndInstallSnapshot();
      }
      if (!result.hasMore) return null;
    }
  };

  const rejectPending = (failure: ConversationSyncOperationFailure): void => {
    const rejected = [...pending.values()];
    pending.clear();
    for (const mutation of rejected) {
      try {
        onMutationRejected?.({ mutation, failure });
      } catch {
        // Rejection observers cannot alter coordination.
      }
    }
  };

  const flushPending = async (): Promise<ConversationSyncOperationFailure | null> => {
    let conflictCount = 0;
    while (started && pending.size > 0) {
      const mutations = rebasePendingMutations(
        [...pending.values()],
        authoritativeStore.getSnapshot().revision,
      );
      const result = await adapter.appendMutations({
        conversationId,
        expectedRevision: authoritativeStore.getSnapshot().revision,
        mutations,
      });
      if (result.status === "conflict" || result.status === "snapshot_required") {
        conflictCount += 1;
        if (conflictCount > 8) {
          throw new Error("Conversation sync did not stabilize after repeated conflicts");
        }
        const failure = await pullAndInstallSnapshot();
        if (failure !== null) return failure;
        continue;
      }
      if (result.status !== "mutations") return result;

      for (const acknowledgement of result.acknowledgements) {
        if (!pending.has(acknowledgement.mutationId)) continue;
        try {
          await persistAndApply(acknowledgement.events);
        } catch (error) {
          if (!(error instanceof RemoteRevisionGapError)) throw error;
          const failure = await pullAndInstallSnapshot();
          if (failure !== null) return failure;
        }
        pending.delete(acknowledgement.mutationId);
      }
      await rebuildView();
      if (result.acknowledgements.length === 0) {
        throw new Error("Conversation sync adapter acknowledged no queued mutations");
      }
    }
    return null;
  };

  const closeConnection = (): void => {
    subscription?.close();
    subscription = null;
    reconnectAbort?.abort(new Error("Conversation sync stopped"));
    reconnectAbort = null;
  };

  const failPermanently = async (
    error: unknown,
    failure?: ConversationSyncOperationFailure,
  ): Promise<void> => {
    started = false;
    generation += 1;
    closeConnection();
    if (failure?.status === "unauthorized") {
      rejectPending(failure);
      await rebuildView();
    }
    publishState("error", error, state.reconnectAttempt);
  };

  const scheduleReconnect = (
    error: unknown,
    failure?: ConversationSyncOperationFailure,
  ): void => {
    if (!started || destroyed || reconnectAbort !== null) return;
    closeConnection();
    publishState("offline", error, state.reconnectAttempt);
    const attempt = state.reconnectAttempt + 1;
    publishState("reconnecting", error, attempt);
    const abort = new AbortController();
    reconnectAbort = abort;
    const delay = backoff({
      attempt,
      error,
      ...(failure?.status === "temporarily_unavailable" &&
      failure.retryAfterMilliseconds !== undefined
        ? { retryAfterMilliseconds: failure.retryAfterMilliseconds }
        : {}),
    });
    if (!Number.isSafeInteger(delay) || delay < 0) {
      void serialize(() => failPermanently(
        new RangeError("Conversation sync backoff must return a non-negative safe integer"),
      ));
      return;
    }
    const reconnectGeneration = generation;
    void clock.wait(delay, abort.signal).then(
      () => {
        if (
          abort.signal.aborted ||
          reconnectGeneration !== generation ||
          !started ||
          destroyed
        ) return;
        reconnectAbort = null;
        void serialize(async () => {
          try {
            await connect(reconnectGeneration, true);
          } catch (connectError) {
            scheduleReconnect(connectError);
          }
        });
      },
      () => undefined,
    );
  };

  const consume = async (
    activeSubscription: ConversationSyncSubscription,
    activeGeneration: number,
  ): Promise<void> => {
    try {
      for await (const update of activeSubscription.updates) {
        if (!started || destroyed || activeGeneration !== generation) return;
        await serialize(async () => {
          if (!started || destroyed || activeGeneration !== generation) return;
          if (update.status === "events") {
            try {
              await persistAndApply(update.events);
              if (update.hasMore) {
                const failure = await catchUp();
                if (failure !== null) {
                  if (failure.status === "unauthorized") {
                    await failPermanently(failure, failure);
                  } else scheduleReconnect(failure, failure);
                }
              }
            } catch (error) {
              if (!(error instanceof RemoteRevisionGapError)) throw error;
              const failure = await pullAndInstallSnapshot();
              if (failure !== null) scheduleReconnect(failure, failure);
            }
          } else if (update.status === "snapshot_required") {
            const failure = await pullAndInstallSnapshot();
            if (failure !== null) scheduleReconnect(failure, failure);
          } else if (update.status === "unauthorized") {
            await failPermanently(update, update);
          } else {
            scheduleReconnect(update, update);
          }
        });
      }
      if (started && activeGeneration === generation) {
        scheduleReconnect(new Error("Conversation sync subscription ended"));
      }
    } catch (error) {
      if (started && activeGeneration === generation) scheduleReconnect(error);
    }
  };

  async function connect(
    activeGeneration: number,
    reconnecting: boolean,
  ): Promise<void> {
    if (!started || destroyed || activeGeneration !== generation) return;
    publishState(reconnecting ? "reconnecting" : "connecting", null);
    const catchUpFailure = await catchUp();
    if (catchUpFailure !== null) {
      if (catchUpFailure.status === "unauthorized") {
        await failPermanently(catchUpFailure, catchUpFailure);
      } else scheduleReconnect(catchUpFailure, catchUpFailure);
      return;
    }
    const subscribed = await adapter.subscribeSince({
      conversationId,
      afterRevision: authoritativeStore.getSnapshot().revision,
    });
    if (subscribed.status === "snapshot_required") {
      const failure = await pullAndInstallSnapshot();
      if (failure !== null) {
        scheduleReconnect(failure, failure);
        return;
      }
      return connect(activeGeneration, reconnecting);
    }
    if (subscribed.status !== "subscribed") {
      if (subscribed.status === "unauthorized") {
        await failPermanently(subscribed, subscribed);
      } else scheduleReconnect(subscribed, subscribed);
      return;
    }
    subscription = subscribed.subscription;
    publishState("online", null, 0);
    void consume(subscribed.subscription, activeGeneration);
    const pushFailure = await flushPending();
    if (pushFailure !== null) {
      if (pushFailure.status === "unauthorized") {
        await failPermanently(pushFailure, pushFailure);
      } else scheduleReconnect(pushFailure, pushFailure);
    }
  }

  const start = (): Promise<void> => serialize(async () => {
    assertUsable();
    if (started) return;
    started = true;
    generation += 1;
    publishState("connecting", null, 0);
    try {
      const replay = await replayConversation({
        conversationId,
        eventStore,
        ...(readBatchSize === undefined ? {} : { readBatchSize }),
      });
      replaceAuthoritativeStore(replay.store);
      localDurableRevision = replay.lastRevision;
      await rebuildView();
      await connect(generation, false);
    } catch (error) {
      await failPermanently(error);
      throw error;
    }
  });

  const queueMutation = (mutation: ConversationSyncMutation): Promise<void> =>
    serialize(async () => {
      assertUsable();
      const normalized = normalizeMutation(mutation, conversationId);
      const existing = pending.get(normalized.mutationId);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(normalized)) {
          throw new TypeError("A queued mutation ID cannot be reused with different events");
        }
        return;
      }
      if (
        authoritativeStore.getSnapshot().processed_mutation_ids.includes(
          normalized.mutationId,
        )
      ) return;
      pending.set(normalized.mutationId, normalized);
      await rebuildView();
      if (!started || state.status !== "online") return;
      const failure = await flushPending();
      if (failure === null) return;
      if (failure.status === "unauthorized") {
        await failPermanently(failure, failure);
      } else scheduleReconnect(failure, failure);
    });

  const flush = (): Promise<void> => serialize(async () => {
    assertUsable();
    if (!started || state.status !== "online") return;
    const failure = await flushPending();
    if (failure === null) return;
    if (failure.status === "unauthorized") {
      await failPermanently(failure, failure);
    } else scheduleReconnect(failure, failure);
  });

  const stop = async (): Promise<void> => {
    if (destroyed) return;
    started = false;
    generation += 1;
    closeConnection();
    await operationBoundary;
    publishState("offline", null, 0);
  };

  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    await stop();
    destroyed = true;
    authoritativeStore.destroy();
    listeners.clear();
    viewListeners.clear();
    selectorSubscriptions.clear();
  };

  const subscribe = (listener: ConversationSyncCoordinatorListener): (() => void) => {
    assertUsable();
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
    };
  };

  function select<Selected>(
    selector: ConversationStoreSelector<Selected>,
  ): Selected;
  function select<Selected>(
    selector: ConversationStoreSelector<Selected>,
    listener: ConversationStoreSelectorListener<Selected>,
    isEqual?: ConversationStoreEquality<Selected>,
  ): () => void;
  function select<Selected>(
    selector: ConversationStoreSelector<Selected>,
    listener?: ConversationStoreSelectorListener<Selected>,
    isEqual: ConversationStoreEquality<Selected> = Object.is,
  ): Selected | (() => void) {
    const selected = selector(viewState);
    if (listener === undefined) return selected;
    assertUsable();
    let previous = selected;
    const selectorSubscription = {
      notify(snapshot: ConversationState): void {
        const next = selector(snapshot);
        if (isEqual(previous, next)) return;
        const old = previous;
        previous = next;
        listener(next, old);
      },
    };
    selectorSubscriptions.add(selectorSubscription);
    return () => selectorSubscriptions.delete(selectorSubscription);
  }

  const store: ConversationSyncViewStore = Object.freeze({
    getSnapshot: () => viewState,
    subscribe(listener: () => void): () => void {
      assertUsable();
      viewListeners.add(listener);
      return () => viewListeners.delete(listener);
    },
    select,
  });

  return Object.freeze({
    store,
    getState: () => state,
    subscribe,
    start,
    queueMutation,
    enqueueMutation: queueMutation,
    flush,
    stop,
    destroy,
  });
}

function normalizeMutation(
  mutation: ConversationSyncMutation,
  conversationId: ConversationId,
): ConversationSyncMutation {
  if (mutation.events.length === 0) {
    throw new TypeError("A conversation sync mutation must contain at least one event");
  }
  const events = mutation.events.map((candidate) => {
    const parsed = parseConversationEvent(candidate);
    if (parsed.payload.type === "usage.receipt_linked") {
      throw new TypeError("Usage receipt links cannot be proposed by clients");
    }
    const event = parsed as ConversationSyncMutationEvent;
    if (event.conversation_id !== conversationId) {
      throw new TypeError("A queued mutation belongs to another conversation");
    }
    if (event.source.type !== "client") {
      throw new TypeError("A queued mutation must contain client-authored events");
    }
    if (event.mutation_id !== mutation.mutationId) {
      throw new TypeError("Every queued event must carry its mutation ID");
    }
    return event;
  });
  return Object.freeze({ mutationId: mutation.mutationId, events: Object.freeze(events) });
}

function rebasePendingMutations(
  mutations: readonly ConversationSyncMutation[],
  revision: ConversationRevision | null,
): ConversationSyncMutation[] {
  let nextRevision = (revision ?? 0) + 1;
  return mutations.map((mutation) => ({
    mutationId: mutation.mutationId,
    events: mutation.events.map((event) => ({
      ...event,
      revision: nextRevision++ as ConversationRevision,
    })),
  }));
}

function rebasePendingEvents(
  mutations: readonly ConversationSyncMutation[],
  revision: ConversationRevision | null,
): ConversationEvent[] {
  return rebasePendingMutations(mutations, revision).flatMap((mutation) =>
    mutation.events.map((event) => event as ConversationEvent),
  );
}

function defaultDecodeSnapshot<TSnapshot extends ConversationJsonValue>(
  snapshot: ConversationSyncSnapshot<TSnapshot>,
): ConversationState {
  return deepFreeze(JSON.parse(JSON.stringify(snapshot.state))) as ConversationState;
}

function validateDecodedSnapshot(
  state: ConversationState,
  conversationId: ConversationId,
  revision: ConversationRevision | null,
): void {
  if (
    state === null ||
    typeof state !== "object" ||
    state.conversation_id !== conversationId ||
    state.revision !== revision ||
    state.replay_error !== null ||
    !Array.isArray(state.processed_event_ids) ||
    !Array.isArray(state.processed_mutation_ids) ||
    !Array.isArray(state.messages) ||
    !Array.isArray(state.attachments) ||
    !Array.isArray(state.turns) ||
    !Array.isArray(state.tool_calls) ||
    !Array.isArray(state.usage_receipt_links)
  ) {
    throw new ConversationSyncSnapshotError(
      "Sync snapshot is not a compatible conversation projection",
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function freezeState(
  status: ConversationSyncStatus,
  revision: ConversationRevision | null,
  pendingMutationCount: number,
  reconnectAttempt: number,
  error: unknown,
): ConversationSyncCoordinatorState {
  return Object.freeze({
    status,
    revision,
    pendingMutationCount,
    reconnectAttempt,
    error,
  });
}
