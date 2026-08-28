/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  createContext,
  createRef,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatTabsContent,
  ChatTabsList,
  ChatTabsRoot,
  ChatTabsTrigger,
} from "../src/react/index.js";

afterEach(() => cleanup());

function BasicTabs({
  activationMode,
  orientation,
}: {
  activationMode?: "automatic" | "manual";
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <ChatTabsRoot
      defaultValue="chat"
      {...(activationMode === undefined ? {} : { activationMode })}
      {...(orientation === undefined ? {} : { orientation })}
    >
      <ChatTabsList aria-label="Workspace">
        <ChatTabsTrigger value="chat">Chat</ChatTabsTrigger>
        <ChatTabsTrigger value="history" disabled>
          History
        </ChatTabsTrigger>
        <ChatTabsTrigger value="settings">Settings</ChatTabsTrigger>
      </ChatTabsList>
      <ChatTabsContent value="chat">Chat panel</ChatTabsContent>
      <ChatTabsContent value="history">History panel</ChatTabsContent>
      <ChatTabsContent value="settings">Settings panel</ChatTabsContent>
    </ChatTabsRoot>
  );
}

describe("ChatTabs", () => {
  it("supports horizontal automatic activation, disabled skipping, Home/End, and wrapping", () => {
    render(<BasicTabs />);
    const list = screen.getByRole("tablist", { name: "Workspace" });
    const chat = screen.getByRole("tab", { name: "Chat" });
    const history = screen.getByRole("tab", { name: "History" });
    const settings = screen.getByRole("tab", { name: "Settings" });

    expect(list.getAttribute("aria-orientation")).toBe("horizontal");
    expect(list.dataset.orientation).toBe("horizontal");
    expect(chat.getAttribute("aria-selected")).toBe("true");
    expect(chat.tabIndex).toBe(0);
    expect(history.hasAttribute("disabled")).toBe(true);
    expect(history.dataset.disabled).toBe("");
    expect(screen.getByRole("tabpanel").textContent).toBe("Chat panel");

    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    expect(document.activeElement).toBe(settings);
    expect(settings.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Settings panel");

    fireEvent.keyDown(settings, { key: "ArrowRight" });
    expect(document.activeElement).toBe(chat);
    expect(chat.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(chat, { key: "End" });
    expect(document.activeElement).toBe(settings);
    fireEvent.keyDown(settings, { key: "Home" });
    expect(document.activeElement).toBe(chat);

    fireEvent.keyDown(chat, { key: "ArrowDown" });
    expect(document.activeElement).toBe(chat);
  });

  it("supports vertical manual activation while focus wraps independently of selection", () => {
    render(<BasicTabs orientation="vertical" activationMode="manual" />);
    const list = screen.getByRole("tablist", { name: "Workspace" });
    const chat = screen.getByRole("tab", { name: "Chat" });
    const settings = screen.getByRole("tab", { name: "Settings" });

    expect(list.getAttribute("aria-orientation")).toBe("vertical");
    expect(chat.getAttribute("aria-selected")).toBe("true");
    chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowDown" });
    expect(document.activeElement).toBe(settings);
    expect(settings.tabIndex).toBe(0);
    expect(settings.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tabpanel").textContent).toBe("Chat panel");

    fireEvent.keyDown(settings, { key: "ArrowDown" });
    expect(document.activeElement).toBe(chat);
    expect(chat.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(chat, { key: "ArrowUp" });
    expect(document.activeElement).toBe(settings);
    expect(settings.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(settings);
    expect(settings.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Settings panel");
  });

  it("reports controlled changes without changing selection until the value prop changes", () => {
    const onValueChange = vi.fn();
    const blockedClick = vi.fn((event: React.MouseEvent<HTMLButtonElement>) =>
      event.preventDefault(),
    );
    const { rerender } = render(
      <ChatTabsRoot value="chat" onValueChange={onValueChange}>
        <ChatTabsList>
          <ChatTabsTrigger value="chat">Chat</ChatTabsTrigger>
          <ChatTabsTrigger value="settings">Settings</ChatTabsTrigger>
          <ChatTabsTrigger value="blocked" onClick={blockedClick}>
            Blocked
          </ChatTabsTrigger>
        </ChatTabsList>
        <ChatTabsContent value="chat">Chat panel</ChatTabsContent>
        <ChatTabsContent value="settings">Settings panel</ChatTabsContent>
        <ChatTabsContent value="blocked">Blocked panel</ChatTabsContent>
      </ChatTabsRoot>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(onValueChange).toHaveBeenCalledWith("settings");
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Blocked" }));
    expect(blockedClick).toHaveBeenCalledOnce();
    expect(onValueChange).toHaveBeenCalledTimes(1);

    rerender(
      <ChatTabsRoot value="settings" onValueChange={onValueChange}>
        <ChatTabsList>
          <ChatTabsTrigger value="chat">Chat</ChatTabsTrigger>
          <ChatTabsTrigger value="settings">Settings</ChatTabsTrigger>
          <ChatTabsTrigger value="blocked">Blocked</ChatTabsTrigger>
        </ChatTabsList>
        <ChatTabsContent value="chat">Chat panel</ChatTabsContent>
        <ChatTabsContent value="settings">Settings panel</ChatTabsContent>
        <ChatTabsContent value="blocked">Blocked panel</ChatTabsContent>
      </ChatTabsRoot>,
    );
    expect(
      screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Settings panel");
  });

  it("links consumer and generated IDs and forwards refs and native props", async () => {
    const rootRef = createRef<HTMLDivElement>();
    const listRef = createRef<HTMLDivElement>();
    const triggerRef = createRef<HTMLButtonElement>();
    const contentRef = createRef<HTMLDivElement>();
    const onClick = vi.fn();
    render(
      <ChatTabsRoot
        ref={rootRef}
        defaultValue="chat"
        className="consumer-root"
        data-root="yes"
      >
        <ChatTabsList ref={listRef} className="consumer-list">
          <ChatTabsTrigger
            ref={triggerRef}
            id="consumer-chat-trigger"
            value="chat"
            name="consumer-trigger"
          >
            Chat
          </ChatTabsTrigger>
        </ChatTabsList>
        <ChatTabsContent
          ref={contentRef}
          id="consumer-chat-panel"
          value="chat"
          className="consumer-panel"
          data-panel="yes"
          onClick={onClick}
        >
          Chat panel
        </ChatTabsContent>
      </ChatTabsRoot>,
    );

    const trigger = screen.getByRole("tab", { name: "Chat" });
    const panel = screen.getByRole("tabpanel");
    await waitFor(() => {
      expect(trigger.getAttribute("aria-controls")).toBe("consumer-chat-panel");
      expect(panel.getAttribute("aria-labelledby")).toBe("consumer-chat-trigger");
    });
    expect(rootRef.current?.className).toBe("consumer-root");
    expect(rootRef.current?.dataset.root).toBe("yes");
    expect(listRef.current?.className).toBe("consumer-list");
    expect(triggerRef.current).toBe(trigger);
    expect(trigger.getAttribute("name")).toBe("consumer-trigger");
    expect(contentRef.current).toBe(panel);
    expect(panel.className).toBe("consumer-panel");
    expect(panel.dataset.panel).toBe("yes");
    fireEvent.click(panel);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("keeps force-mounted inactive panels hidden and unmounts other inactive panels", () => {
    render(
      <ChatTabsRoot defaultValue="chat">
        <ChatTabsList>
          <ChatTabsTrigger value="chat">Chat</ChatTabsTrigger>
          <ChatTabsTrigger value="settings">Settings</ChatTabsTrigger>
        </ChatTabsList>
        <ChatTabsContent value="chat">Chat panel</ChatTabsContent>
        <ChatTabsContent value="settings" forceMount data-testid="settings-panel">
          Settings panel
        </ChatTabsContent>
        <ChatTabsContent value="unmounted" data-testid="unmounted-panel">
          Unmounted panel
        </ChatTabsContent>
      </ChatTabsRoot>,
    );

    const settingsPanel = screen.getByTestId("settings-panel");
    expect(settingsPanel.hidden).toBe(true);
    expect(settingsPanel.dataset.state).toBe("inactive");
    expect(screen.queryByTestId("unmounted-panel")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(settingsPanel.hidden).toBe(false);
    expect(settingsPanel.dataset.state).toBe("active");
    expect(screen.queryByText("Chat panel")).toBeNull();
  });

  it("keeps React-generated ARIA IDs stable through server rendering and hydration", async () => {
    const fixture = <BasicTabs />;
    const serverMarkup = renderToString(fixture);
    const container = document.createElement("div");
    container.innerHTML = serverMarkup;
    document.body.append(container);
    const serverIds = Array.from(container.querySelectorAll("[id]"), (node) => node.id);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, fixture);
    });

    const hydratedIds = Array.from(
      container.querySelectorAll("[id]"),
      (node) => node.id,
    );
    expect(hydratedIds).toEqual(serverIds);
    expect(consoleError).not.toHaveBeenCalled();
    expect(
      container.querySelector("[role='tab']")?.getAttribute("aria-controls"),
    ).toBe(container.querySelector("[role='tabpanel']")?.id);

    await act(async () => root?.unmount());
    consoleError.mockRestore();
    container.remove();
  });

  it("adds no visual presentation by default", () => {
    render(<BasicTabs />);
    for (const element of [
      screen.getByRole("tablist"),
      ...screen.getAllByRole("tab"),
      screen.getByRole("tabpanel"),
    ]) {
      expect(element.getAttribute("class")).toBeNull();
      expect(element.getAttribute("style")).toBeNull();
    }
    expect(document.querySelector("style, link[rel='stylesheet']")).toBeNull();
  });

  it("does not own or pause streaming state mounted above an inactive chat panel", () => {
    const StreamContext = createContext(0);

    function StreamingOwner({ children }: { children: ReactNode }) {
      const [chunks, setChunks] = useState(0);
      return (
        <StreamContext.Provider value={chunks}>
          <button onClick={() => setChunks((count) => count + 1)}>
            Receive chunk
          </button>
          {children}
        </StreamContext.Provider>
      );
    }

    function ChatPanel() {
      const chunks = useContext(StreamContext);
      return <span>Received chunks: {chunks}</span>;
    }

    render(
      <StreamingOwner>
        <ChatTabsRoot defaultValue="chat">
          <ChatTabsList>
            <ChatTabsTrigger value="chat">Chat</ChatTabsTrigger>
            <ChatTabsTrigger value="settings">Settings</ChatTabsTrigger>
          </ChatTabsList>
          <ChatTabsContent value="chat">
            <ChatPanel />
          </ChatTabsContent>
          <ChatTabsContent value="settings">Settings panel</ChatTabsContent>
        </ChatTabsRoot>
      </StreamingOwner>,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    expect(screen.queryByText(/Received chunks/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Receive chunk" }));
    fireEvent.click(screen.getByRole("button", { name: "Receive chunk" }));
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByText("Received chunks: 2")).toBeTruthy();
  });
});
