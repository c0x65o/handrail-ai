/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  CONVERSATION_EVENT_VERSION,
  InMemoryConversationEventStore,
  createConversationStore,
  createConversationSyncCoordinator,
  parseConversationEvent,
  type ConversationEvent,
  type ConversationId,
  type ConversationRuntime,
  type ConversationRuntimeSendMessageInput,
  type ConversationStore,
  type ConversationSyncAdapter,
  type ConversationSyncSubscription,
  type ConversationSyncUpdate,
} from "../src/index.js";
import {
  ConversationProvider,
  MessageList,
  useConversationActions,
  useConversationSelector,
  useConversationSnapshot,
  useConversationStore,
} from "../src/react/index.js";

afterEach(() => cleanup());

class RemoteUpdateStream implements AsyncIterable<ConversationSyncUpdate> {
  private readonly values: ConversationSyncUpdate[] = [];
  private readonly readers: Array<(
    result: IteratorResult<ConversationSyncUpdate>,
  ) => void> = [];
  private closed = false;

  push(update: ConversationSyncUpdate): void {
    const reader = this.readers.shift();
    if (reader === undefined) this.values.push(update);
    else reader({ done: false, value: update });
  }

  close(): void {
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ConversationSyncUpdate> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.closed) return { done: true, value: undefined };
        return new Promise((resolve) => this.readers.push(resolve));
      },
    };
  }
}

function remoteSyncAdapter(updates: RemoteUpdateStream): ConversationSyncAdapter {
  const subscription: ConversationSyncSubscription = {
    updates,
    close: () => updates.close(),
  };
  return {
    async pullSnapshot() {
      return { status: "unauthorized", message: "No snapshot expected" };
    },
    async readSince() {
      return {
        status: "events",
        events: [],
        revision: null,
        latestRevision: null,
        hasMore: false,
      };
    },
    async appendMutations() {
      return { status: "unauthorized", message: "Read-only test adapter" };
    },
    async subscribeSince() {
      return { status: "subscribed", subscription };
    },
    async publishPresence() {
      return { status: "unauthorized", message: "Presence not used" };
    },
    async subscribePresence() {
      return { status: "unauthorized", message: "Presence not used" };
    },
  };
}

function event(
  revision: number,
  payload: ConversationEvent["payload"],
  conversationId = "conversation_react",
): ConversationEvent {
  return parseConversationEvent({
    version: CONVERSATION_EVENT_VERSION,
    event_id: `event_${conversationId}_${revision}`,
    conversation_id: conversationId,
    revision,
    occurred_at: `2026-08-27T12:00:${String(revision).padStart(2, "0")}.000Z`,
    actor: { type: "assistant" },
    source: { type: "runtime" },
    payload,
  });
}

function titleEvent(
  revision: number,
  title: string,
  conversationId?: string,
): ConversationEvent {
  return event(
    revision,
    { type: "conversation.title_updated", title },
    conversationId,
  );
}

function fakeRuntime<TRequest>(store: ConversationStore) {
  const destroy = vi.fn();
  const sendMessage = vi.fn<ConversationRuntime<TRequest>["sendMessage"]>();
  const resumeTurn = vi.fn<ConversationRuntime<TRequest>["resumeTurn"]>();
  const stopObserving = vi.fn<ConversationRuntime<TRequest>["stopObserving"]>();
  const cancelTurn = vi.fn<ConversationRuntime<TRequest>["cancelTurn"]>();
  const restoreActiveTurn = vi.fn<ConversationRuntime<TRequest>["restoreActiveTurn"]>();
  const runtime: ConversationRuntime<TRequest> = {
    store,
    getSnapshot: store.getSnapshot,
    observe(observer) {
      return store.subscribe(() => observer(store.getSnapshot()));
    },
    sendMessage,
    resumeTurn,
    stopObserving,
    cancelTurn,
    restoreActiveTurn,
    destroy,
  };
  return { runtime, destroy, sendMessage };
}

describe("ConversationProvider and hooks", () => {
  it("fails with an actionable error when a hook has no provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function MissingProvider() {
      useConversationStore();
      return null;
    }

    expect(() => render(<MissingProvider />)).toThrow(
      /useConversationStore must be used within a <ConversationProvider>/u,
    );
    consoleError.mockRestore();
  });

  it("selectively rerenders while observing every external store update", async () => {
    const store = createConversationStore();
    let titleRenders = 0;
    let snapshotRenders = 0;

    function SelectedTitle() {
      titleRenders += 1;
      return <span data-testid="title">{useConversationSelector((state) => state.title)}</span>;
    }
    function Revision() {
      snapshotRenders += 1;
      return <span data-testid="revision">{useConversationSnapshot().revision ?? 0}</span>;
    }

    render(
      <ConversationProvider store={store}>
        <SelectedTitle />
        <Revision />
      </ConversationProvider>,
    );
    expect(titleRenders).toBe(1);
    expect(snapshotRenders).toBe(1);

    await act(() =>
      store.applyEvent(
        event(1, {
          type: "conversation.metadata_updated",
          metadata: { streamed: true },
        }),
      ),
    );
    expect(screen.getByTestId("revision").textContent).toBe("1");
    expect(titleRenders).toBe(1);
    expect(snapshotRenders).toBe(2);

    await act(() => store.applyEvent(titleEvent(2, "Streaming complete")));
    expect(screen.getByTestId("title").textContent).toBe("Streaming complete");
    expect(titleRenders).toBe(2);
    expect(snapshotRenders).toBe(3);
  });

  it("observes authoritative remote updates from a sync view store exactly once", async () => {
    const conversationId = "conversation_react_sync" as ConversationId;
    const updates = new RemoteUpdateStream();
    const coordinator = createConversationSyncCoordinator({
      conversationId,
      eventStore: new InMemoryConversationEventStore(),
      adapter: remoteSyncAdapter(updates),
    });
    await coordinator.start();
    let selectedRenders = 0;
    let primitiveRenders = 0;
    let observedStore: ReturnType<typeof useConversationStore> | undefined;
    let actions: ReturnType<typeof useConversationActions> | undefined;

    function SelectedMessageCount() {
      selectedRenders += 1;
      observedStore = useConversationStore();
      actions = useConversationActions();
      const count = useConversationSelector((state) => state.messages.length);
      return <span data-testid="sync-count">{count}</span>;
    }

    const view = render(
      <ConversationProvider store={coordinator.store}>
        <SelectedMessageCount />
        <MessageList
          data-testid="sync-messages"
          render={(props, ref) => {
            primitiveRenders += 1;
            return <div {...props} ref={ref} />;
          }}
        />
      </ConversationProvider>,
    );
    expect(observedStore).toBe(coordinator.store);
    expect(selectedRenders).toBe(1);
    expect(primitiveRenders).toBe(1);

    const remoteEvent = event(1, {
      type: "message.created",
      message_id: "message_remote" as never,
      role: "assistant",
      content: [{ type: "text", text: "Authoritative remote message" }],
    }, conversationId);
    updates.push({
      status: "events",
      events: [remoteEvent],
      revision: remoteEvent.revision,
      latestRevision: remoteEvent.revision,
      hasMore: false,
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(coordinator.store.getSnapshot().revision).toBe(1);
      });
    });

    expect(screen.getByTestId("sync-count").textContent).toBe("1");
    expect(screen.getByTestId("sync-messages").textContent).toContain(
      "Authoritative remote message",
    );
    expect(selectedRenders).toBe(2);
    expect(primitiveRenders).toBe(2);

    expect(actions).toBeDefined();
    expect(() => actions?.applyEvent(remoteEvent)).toThrow(/mutable ConversationStore/u);
    expect(() => actions?.applyEvents([remoteEvent])).toThrow(/mutable ConversationStore/u);
    expect(() => actions?.sendMessage({ content: "hello", request: undefined })).toThrow(
      /runtime actions require/u,
    );
    expect(() => actions?.resumeTurn("turn_remote" as never)).toThrow(
      /runtime actions require/u,
    );
    expect(() => actions?.restoreActiveTurn()).toThrow(/runtime actions require/u);

    view.unmount();
    const create = vi.fn(() => coordinator.store);
    const ownedView = render(
      <ConversationProvider create={create}>
        <SelectedMessageCount />
      </ConversationProvider>,
    );
    ownedView.unmount();
    await act(async () => Promise.resolve());
    expect(create).toHaveBeenCalledOnce();
    expect(coordinator.store.getSnapshot().revision).toBe(1);
    await coordinator.destroy();
  });

  it("keeps action identity stable and preserves the runtime request type", async () => {
    interface Request {
      readonly model: string;
      readonly temperature?: number;
    }
    const store = createConversationStore();
    const { runtime, sendMessage } = fakeRuntime<Request>(store);
    const seenActions: unknown[] = [];

    function Consumer() {
      const actions = useConversationActions<Request>();
      useConversationSnapshot();
      seenActions.push(actions);
      expectTypeOf(actions.sendMessage).parameter(0).toEqualTypeOf<
        ConversationRuntimeSendMessageInput<Request>
      >();
      return null;
    }

    render(
      <ConversationProvider runtime={runtime}>
        <Consumer />
      </ConversationProvider>,
    );
    await act(() => store.applyEvent(titleEvent(1, "Updated")));

    expect(new Set(seenActions).size).toBe(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("isolates nested providers and their conversations", async () => {
    const outer = createConversationStore();
    const inner = createConversationStore();

    function Title({ testId }: { testId: string }) {
      return <span data-testid={testId}>{useConversationSelector((state) => state.title)}</span>;
    }

    render(
      <ConversationProvider store={outer}>
        <Title testId="outer" />
        <ConversationProvider store={inner}>
          <Title testId="inner" />
        </ConversationProvider>
      </ConversationProvider>,
    );
    await act(() =>
      outer.applyEvent(titleEvent(1, "Outer", "conversation_outer")),
    );
    expect(screen.getByTestId("outer").textContent).toBe("Outer");
    expect(screen.getByTestId("inner").textContent).toBe("");

    await act(() =>
      inner.applyEvent(titleEvent(1, "Inner", "conversation_inner")),
    );
    expect(screen.getByTestId("outer").textContent).toBe("Outer");
    expect(screen.getByTestId("inner").textContent).toBe("Inner");
  });

  it("uses the stable store snapshot during server rendering", async () => {
    const store = createConversationStore();
    await store.applyEvent(titleEvent(1, "Server title"));
    const initialSnapshot = store.getSnapshot();

    function ServerConsumer() {
      const snapshot = useConversationSnapshot();
      expect(snapshot).toBe(initialSnapshot);
      return <span>{snapshot.title}</span>;
    }

    expect(
      renderToString(
        <ConversationProvider store={store}>
          <ServerConsumer />
        </ConversationProvider>,
      ),
    ).toContain("Server title");
  });

  it("creates and destroys an owned store once across StrictMode lifecycle replay", async () => {
    const baseStore = createConversationStore();
    let activeSubscriptions = 0;
    let maximumActiveSubscriptions = 0;
    const destroy = vi.fn(baseStore.destroy);
    const ownedStore: ConversationStore = {
      ...baseStore,
      subscribe(listener) {
        activeSubscriptions += 1;
        maximumActiveSubscriptions = Math.max(
          maximumActiveSubscriptions,
          activeSubscriptions,
        );
        const unsubscribe = baseStore.subscribe(listener);
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          activeSubscriptions -= 1;
          unsubscribe();
        };
      },
      destroy,
    };
    const create = vi.fn(() => ownedStore);

    function Consumer() {
      useConversationSnapshot();
      return null;
    }

    const view = render(
      <StrictMode>
        <ConversationProvider create={create}>
          <Consumer />
        </ConversationProvider>
      </StrictMode>,
    );
    expect(create).toHaveBeenCalledOnce();
    expect(maximumActiveSubscriptions).toBe(1);
    expect(activeSubscriptions).toBe(1);
    expect(destroy).not.toHaveBeenCalled();

    view.unmount();
    await act(async () => Promise.resolve());
    expect(activeSubscriptions).toBe(0);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("never destroys an externally supplied runtime", () => {
    const store = createConversationStore();
    const { runtime, destroy } = fakeRuntime<unknown>(store);
    const view = render(
      <ConversationProvider runtime={runtime}>
        <span>External runtime</span>
      </ConversationProvider>,
    );

    view.unmount();
    expect(destroy).not.toHaveBeenCalled();
    expect(store.getSnapshot().revision).toBeNull();
  });

  it("lets two simultaneous presentations observe the same runtime", async () => {
    const store = createConversationStore();
    const { runtime } = fakeRuntime<unknown>(store);

    function Presentation({ children }: { children: ReactNode }) {
      const title = useConversationSelector((state) => state.title);
      return <span data-testid={String(children)}>{title}</span>;
    }

    render(
      <ConversationProvider runtime={runtime}>
        <Presentation>dialog</Presentation>
        <Presentation>drawer</Presentation>
      </ConversationProvider>,
    );
    await act(() => store.applyEvent(titleEvent(1, "Shared runtime")));

    expect(screen.getByTestId("dialog").textContent).toBe("Shared runtime");
    expect(screen.getByTestId("drawer").textContent).toBe("Shared runtime");
  });

  it("reports that runtime actions need a runtime-backed provider", () => {
    const store = createConversationStore();
    let send: (() => void) | undefined;
    function StoreActions() {
      const actions = useConversationActions();
      send = () => {
        void actions.sendMessage({ content: "hello", request: undefined });
      };
      return null;
    }
    render(
      <ConversationProvider store={store}>
        <StoreActions />
      </ConversationProvider>,
    );

    expect(send).toBeDefined();
    expect(() => send?.()).toThrow(/runtime actions require/u);
  });
});
