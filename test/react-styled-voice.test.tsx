// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { createAttachmentUploader, createConversationStore, type ConversationId, type ConversationRuntime } from "../src/index.js";
import { HandrailChatWorkspace, type HandrailChatVoiceControlsContext } from "../src/react-styled/index.js";

afterEach(cleanup);

it("binds custom voice controls to the selected composer and disposes them on thread switch", () => {
  const runtime = (id: string) => {
    const store = createConversationStore(id as ConversationId);
    return { store, getSnapshot: store.getSnapshot, observe: (observer: () => void) => store.subscribe(observer),
      sendMessage: vi.fn(), resumeTurn: vi.fn(), restoreActiveTurn: vi.fn(), destroy: vi.fn(),
    } as unknown as ConversationRuntime<undefined>;
  };
  const first = runtime("a"), second = runtime("b");
  let snapshot = { selectedConversationId: "a" as ConversationId, runningCount: 0, errorCount: 0, unreadCount: 0,
    threads: [{ conversationId: "a" as ConversationId, runtime: first, turnStatus: "idle" as const, unread: false, revision: null },
      { conversationId: "b" as ConversationId, runtime: second, turnStatus: "idle" as const, unread: false, revision: null }] };
  const listeners = new Set<() => void>();
  const workspace = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  }, open: vi.fn(), select: vi.fn() };
  const uploader = createAttachmentUploader<Blob>({ upload: async () => { throw new Error("Unused upload"); } });
  const disposed: string[] = [];
  function Voice({ conversationId, composer }: HandrailChatVoiceControlsContext) {
    useEffect(() => () => { disposed.push(String(conversationId)); }, [conversationId]);
    return <button type="button" onClick={() => composer.setDraft(`${composer.draft} dictated-${conversationId}`)}>Dictate {conversationId}</button>;
  }
  const view = render(<HandrailChatWorkspace workspace={workspace} conversationPicker={<span>Threads</span>}
    composerForConversation={(_runtime, conversationId) => ({ uploader, conversationId, initialDraft: `Draft-${conversationId}` })}
    renderVoiceControls={(context) => <Voice {...context}/>}/>);
  fireEvent.click(screen.getByRole("button", { name: "Dictate a" }));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft-a dictated-a");
  act(() => { snapshot = { ...snapshot, selectedConversationId: "b" as ConversationId }; listeners.forEach((listener) => listener()); });
  expect(disposed).toEqual(["a"]);
  expect(screen.queryByRole("button", { name: "Dictate a" })).toBeNull();
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft-b");
  fireEvent.click(screen.getByRole("button", { name: "Dictate b" }));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "Draft-b dictated-b");
  view.unmount();
  expect(disposed).toEqual(["a", "b"]);
});
