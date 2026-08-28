import type { ConversationEvent, ConversationId } from "./events.js";
import { reduceConversationEvent } from "./reducer.js";
import {
  createInitialConversationState,
  type ConversationState,
} from "./state.js";

export type ConversationStoreListener = () => void;
export type ConversationStoreSelector<Selected> = (
  snapshot: ConversationState,
) => Selected;
export type ConversationStoreSelectorListener<Selected> = (
  selected: Selected,
  previousSelected: Selected,
) => void;
export type ConversationStoreEquality<Selected> = (
  left: Selected,
  right: Selected,
) => boolean;

export interface ConversationStore {
  /** Return the current immutable snapshot. Stable until an event changes it. */
  getSnapshot(): ConversationState;
  /** Subscribe to every material snapshot change. */
  subscribe(listener: ConversationStoreListener): () => void;
  /** Read a value derived from the current snapshot. */
  select<Selected>(selector: ConversationStoreSelector<Selected>): Selected;
  /** Subscribe only when a derived value changes according to `isEqual`. */
  select<Selected>(
    selector: ConversationStoreSelector<Selected>,
    listener: ConversationStoreSelectorListener<Selected>,
    isEqual?: ConversationStoreEquality<Selected>,
  ): () => void;
  /** Apply one event after all earlier application calls have settled. */
  applyEvent(event: ConversationEvent): Promise<ConversationState>;
  /** Apply an ordered batch through one mutation and notification boundary. */
  applyEvents(events: readonly ConversationEvent[]): Promise<ConversationState>;
  /** Reject queued/future mutations and release every subscription. */
  destroy(): void;
}

export class ConversationStoreDestroyedError extends Error {
  constructor() {
    super("Conversation store is destroyed");
    this.name = "ConversationStoreDestroyedError";
  }
}

interface SelectorSubscription {
  notify(snapshot: ConversationState): void;
}

/** Create an isolated, framework-free external store for one conversation. */
export function createConversationStore(
  conversationId: ConversationId | null = null,
  initialState: ConversationState = createInitialConversationState(conversationId),
): ConversationStore {
  if (
    conversationId !== null &&
    initialState.conversation_id !== null &&
    initialState.conversation_id !== conversationId
  ) {
    throw new TypeError("Initial conversation state belongs to another conversation");
  }
  let snapshot = initialState;
  let mutationBoundary: Promise<void> = Promise.resolve();
  let destroyed = false;
  const listeners = new Set<ConversationStoreListener>();
  const selectorSubscriptions = new Set<SelectorSubscription>();

  const assertUsable = (): void => {
    if (destroyed) throw new ConversationStoreDestroyedError();
  };

  const getSnapshot = (): ConversationState => snapshot;

  const subscribe = (listener: ConversationStoreListener): (() => void) => {
    assertUsable();
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
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
    if (listener !== undefined) assertUsable();
    const selected = selector(snapshot);
    if (listener === undefined) return selected;

    let previousSelected = selected;
    const subscription: SelectorSubscription = {
      notify(nextSnapshot) {
        const nextSelected = selector(nextSnapshot);
        if (isEqual(previousSelected, nextSelected)) return;
        const previous = previousSelected;
        previousSelected = nextSelected;
        listener(nextSelected, previous);
      },
    };
    selectorSubscriptions.add(subscription);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      selectorSubscriptions.delete(subscription);
    };
  }

  const notify = (): void => {
    for (const listener of [...listeners]) {
      if (destroyed) return;
      if (!listeners.has(listener)) continue;
      try {
        listener();
      } catch {
        // Observer failures do not alter event application or other observers.
      }
    }
    if (destroyed) return;

    for (const subscription of [...selectorSubscriptions]) {
      if (!selectorSubscriptions.has(subscription)) continue;
      try {
        subscription.notify(snapshot);
      } catch {
        // Selector and observer failures do not alter the mutation boundary.
      }
      if (destroyed) return;
    }
  };

  const applyEvents = (
    events: readonly ConversationEvent[],
  ): Promise<ConversationState> => {
    if (destroyed) {
      return Promise.reject(new ConversationStoreDestroyedError());
    }
    const orderedEvents = [...events];
    const operation = mutationBoundary.then(() => {
      assertUsable();
      const previousSnapshot = snapshot;
      let nextSnapshot = previousSnapshot;
      for (const event of orderedEvents) {
        nextSnapshot = reduceConversationEvent(nextSnapshot, event);
      }
      if (nextSnapshot !== previousSnapshot) {
        snapshot = nextSnapshot;
        notify();
      }
      return snapshot;
    });
    mutationBoundary = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const applyEvent = (event: ConversationEvent): Promise<ConversationState> =>
    applyEvents([event]);

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    listeners.clear();
    selectorSubscriptions.clear();
  };

  return Object.freeze({
    getSnapshot,
    subscribe,
    select,
    applyEvent,
    applyEvents,
    destroy,
  });
}
