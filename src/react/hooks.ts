import {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";

import type { ConversationEvent, ConversationTurnId } from "../conversation/events.js";
import type { ConversationState } from "../conversation/state.js";
import type {
  ConversationStore,
  ConversationStoreEquality,
  ConversationStoreSelector,
} from "../conversation/store.js";
import type {
  ConversationRuntime,
  ConversationRuntimeSendMessageInput,
  ConversationRuntimeTurnResult,
} from "../runtime.js";
import { ConversationContext } from "./context.js";

export interface ConversationActions<TRequest = unknown> {
  applyEvent(event: ConversationEvent): Promise<ConversationState>;
  applyEvents(events: readonly ConversationEvent[]): Promise<ConversationState>;
  sendMessage(
    input: ConversationRuntimeSendMessageInput<TRequest>,
  ): Promise<ConversationRuntimeTurnResult>;
  resumeTurn(turnId: ConversationTurnId): Promise<ConversationRuntimeTurnResult>;
  restoreActiveTurn(): Promise<ConversationRuntimeTurnResult | null>;
}

/** Return the store supplied by the nearest ConversationProvider. */
export function useConversationStore(): ConversationStore {
  return useConversationBinding("useConversationStore").store;
}

/** Subscribe to the complete immutable conversation snapshot. */
export function useConversationSnapshot(): ConversationState {
  const store = useConversationStore();
  const subscribe = useCallback(
    (notify: () => void) => store.subscribe(notify),
    [store],
  );
  const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
}

/** Subscribe only to the selected portion of the conversation snapshot. */
export function useConversationSelector<Selected>(
  selector: ConversationStoreSelector<Selected>,
  isEqual: ConversationStoreEquality<Selected> = Object.is,
): Selected {
  const store = useConversationStore();
  const cache = useRef<{
    readonly snapshot: ConversationState;
    readonly selector: ConversationStoreSelector<Selected>;
    readonly selection: Selected;
  } | null>(null);

  const getSelectedSnapshot = useCallback((): Selected => {
    const snapshot = store.getSnapshot();
    const previous = cache.current;
    if (previous !== null && previous.snapshot === snapshot && previous.selector === selector) {
      return previous.selection;
    }

    const selection = selector(snapshot);
    const stableSelection = previous !== null && isEqual(previous.selection, selection)
      ? previous.selection
      : selection;
    cache.current = { snapshot, selector, selection: stableSelection };
    return stableSelection;
  }, [isEqual, selector, store]);
  const subscribe = useCallback(
    (notify: () => void) => store.select(selector, () => notify(), isEqual),
    [isEqual, selector, store],
  );

  return useSyncExternalStore(
    subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  );
}

/**
 * Return stable action callbacks for the nearest provider. Runtime-only
 * actions throw an actionable error when the provider was given only a store.
 */
export function useConversationActions<TRequest = unknown>(): ConversationActions<TRequest> {
  const binding = useConversationBinding("useConversationActions");
  return useMemo(() => {
    const runtime = binding.runtime as ConversationRuntime<TRequest> | null;
    const requireRuntime = (): ConversationRuntime<TRequest> => {
      if (runtime !== null) return runtime;
      throw new Error(
        "@handrail/ai/react: useConversationActions runtime actions require " +
          "<ConversationProvider runtime={runtime}> or an owned runtime factory.",
      );
    };

    return Object.freeze({
      applyEvent: (event: ConversationEvent) => binding.store.applyEvent(event),
      applyEvents: (events: readonly ConversationEvent[]) =>
        binding.store.applyEvents(events),
      sendMessage: (input: ConversationRuntimeSendMessageInput<TRequest>) =>
        requireRuntime().sendMessage(input),
      resumeTurn: (turnId: ConversationTurnId) =>
        requireRuntime().resumeTurn(turnId),
      restoreActiveTurn: () => requireRuntime().restoreActiveTurn(),
    });
  }, [binding]);
}

function useConversationBinding(hookName: string) {
  const binding = useContext(ConversationContext);
  if (binding === null) {
    throw new Error(
      `@handrail/ai/react: ${hookName} must be used within a ` +
        "<ConversationProvider>. Pass a store, runtime, or owned create factory.",
    );
  }
  return binding;
}
