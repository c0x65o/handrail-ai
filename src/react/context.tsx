import {
  createContext,
  useEffect,
  useId,
  useMemo,
  type ReactNode,
} from "react";

import type { ConversationStore } from "../conversation/store.js";
import type { ConversationRuntime } from "../runtime.js";

export type ConversationProviderFactory<TRequest = unknown> = () =>
  | ConversationStore
  | ConversationRuntime<TRequest>;

interface ConversationBinding<TRequest = unknown> {
  readonly store: ConversationStore;
  readonly runtime: ConversationRuntime<TRequest> | null;
}

interface ConversationProviderBaseProps {
  readonly children?: ReactNode;
}

export interface ConversationStoreProviderProps
  extends ConversationProviderBaseProps {
  /** Externally owned. The provider never destroys this store. */
  readonly store: ConversationStore;
  readonly runtime?: never;
  readonly create?: never;
}

export interface ConversationRuntimeProviderProps<TRequest = unknown>
  extends ConversationProviderBaseProps {
  /** Externally owned. The provider never destroys this runtime. */
  readonly runtime: ConversationRuntime<TRequest>;
  readonly store?: never;
  readonly create?: never;
}

export interface ConversationFactoryProviderProps<TRequest = unknown>
  extends ConversationProviderBaseProps {
  /**
   * Creates a provider-owned store or runtime. The provider destroys it after
   * its final unmount, including React StrictMode's development remount cycle.
   */
  readonly create: ConversationProviderFactory<TRequest>;
  readonly store?: never;
  readonly runtime?: never;
}

export type ConversationProviderProps<TRequest = unknown> =
  | ConversationStoreProviderProps
  | ConversationRuntimeProviderProps<TRequest>
  | ConversationFactoryProviderProps<TRequest>;

interface OwnedBindingEntry {
  readonly binding: ConversationBinding<unknown>;
  readonly instanceId: string;
  readonly factory: ConversationProviderFactory<unknown>;
  mounts: number;
  cleanupGeneration: number;
  destroyed: boolean;
}

// React deliberately calls render initializers twice in development StrictMode.
// useId is stable across those calls, so this render-lifetime registry prevents
// invoking an owning factory twice. It stores lifecycle metadata only; the
// ConversationStore remains the sole source of conversation state.
const ownedBindings = new WeakMap<
  ConversationProviderFactory<unknown>,
  Map<string, OwnedBindingEntry>
>();

export const ConversationContext = createContext<ConversationBinding<unknown> | null>(
  null,
);

ConversationContext.displayName = "ConversationContext";

/** Bind one headless conversation store/runtime to a React subtree. */
export function ConversationProvider<TRequest = unknown>(
  props: ConversationProviderProps<TRequest>,
) {
  const instanceId = useId();
  const externalRuntime = "runtime" in props ? props.runtime : undefined;
  const externalStore = "store" in props ? props.store : undefined;
  const factory = "create" in props ? props.create : undefined;
  const sourceCount = Number(externalRuntime !== undefined) +
    Number(externalStore !== undefined) + Number(factory !== undefined);
  const ownedEntry = sourceCount === 1 && factory !== undefined
    ? getOwnedBinding(
        factory as ConversationProviderFactory<unknown>,
        instanceId,
      )
    : null;
  const externalBinding = useMemo<ConversationBinding<unknown> | null>(() => {
    if (externalRuntime !== undefined) {
      return Object.freeze({
        store: externalRuntime.store,
        runtime: externalRuntime as ConversationRuntime<unknown>,
      });
    }
    if (externalStore !== undefined) {
      return Object.freeze({ store: externalStore, runtime: null });
    }
    return null;
  }, [externalRuntime, externalStore]);
  const binding = ownedEntry?.binding ?? externalBinding;

  if (sourceCount !== 1 || binding === null) {
    throw new TypeError(
      "ConversationProvider requires exactly one of `store`, `runtime`, or `create`.",
    );
  }

  useEffect(() => {
    if (ownedEntry === null) return undefined;
    ownedEntry.mounts += 1;
    ownedEntry.cleanupGeneration += 1;

    return () => {
      ownedEntry.mounts -= 1;
      const cleanupGeneration = ++ownedEntry.cleanupGeneration;
      queueMicrotask(() => {
        if (
          ownedEntry.destroyed ||
          ownedEntry.mounts !== 0 ||
          ownedEntry.cleanupGeneration !== cleanupGeneration
        ) {
          return;
        }
        ownedEntry.destroyed = true;
        const entries = ownedBindings.get(ownedEntry.factory);
        entries?.delete(ownedEntry.instanceId);
        if (entries?.size === 0) ownedBindings.delete(ownedEntry.factory);
        destroyBinding(ownedEntry.binding);
      });
    };
  }, [ownedEntry]);

  return (
    <ConversationContext.Provider value={binding}>
      {props.children}
    </ConversationContext.Provider>
  );
}

function getOwnedBinding(
  factory: ConversationProviderFactory<unknown>,
  instanceId: string,
): OwnedBindingEntry {
  let entries = ownedBindings.get(factory);
  if (entries === undefined) {
    entries = new Map();
    ownedBindings.set(factory, entries);
  }
  const existing = entries.get(instanceId);
  if (existing !== undefined && !existing.destroyed) return existing;

  const binding = bindingFrom(factory());
  const entry: OwnedBindingEntry = {
    binding,
    instanceId,
    factory,
    mounts: 0,
    cleanupGeneration: 0,
    destroyed: false,
  };
  entries.set(instanceId, entry);
  return entry;
}

function bindingFrom(
  source: ConversationStore | ConversationRuntime<unknown>,
): ConversationBinding<unknown> {
  if ("store" in source) {
    return Object.freeze({ store: source.store, runtime: source });
  }
  return Object.freeze({ store: source, runtime: null });
}

function destroyBinding(binding: ConversationBinding<unknown>): void {
  if (binding.runtime !== null) {
    binding.runtime.destroy();
  } else {
    binding.store.destroy();
  }
}
