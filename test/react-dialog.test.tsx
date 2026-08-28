/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useRef, useState, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatDialogClose,
  ChatDialogContent,
  ChatDialogDescription,
  ChatDialogOverlay,
  ChatDialogPortal,
  ChatDialogRoot,
  ChatDialogTitle,
  ChatDialogTrigger,
} from "../src/react/index.js";

afterEach(() => cleanup());

function ControlledDialog({
  children,
  defaultOpen = false,
  dismissOnOutsideInteraction,
}: {
  children?: ReactNode;
  defaultOpen?: boolean;
  dismissOnOutsideInteraction?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <ChatDialogRoot
      open={open}
      onOpenChange={setOpen}
      {...(dismissOnOutsideInteraction === undefined
        ? {}
        : { dismissOnOutsideInteraction })}
    >
      <ChatDialogTrigger>Open dialog</ChatDialogTrigger>
      <ChatDialogContent>
        <ChatDialogTitle>Support chat</ChatDialogTitle>
        {children}
        <ChatDialogClose>Close dialog</ChatDialogClose>
      </ChatDialogContent>
    </ChatDialogRoot>
  );
}

describe("ChatDialog", () => {
  it("supports controlled trigger and close behavior with state attributes", () => {
    render(<ControlledDialog />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    expect(trigger.dataset.state).toBe("closed");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Support chat" });
    expect(dialog.dataset.state).toBe("open");
    expect(trigger.dataset.state).toBe("open");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.dataset.state).toBe("closed");
  });

  it("moves initial focus and cycles Tab in both directions", async () => {
    function InitialFocusDialog() {
      const initialFocusRef = useRef<HTMLButtonElement>(null);
      return (
        <ChatDialogRoot open onOpenChange={() => undefined}>
          <ChatDialogContent initialFocusRef={initialFocusRef}>
            <ChatDialogTitle>Focus dialog</ChatDialogTitle>
            <button>First</button>
            <button ref={initialFocusRef}>Requested</button>
            <button>Last</button>
          </ChatDialogContent>
        </ChatDialogRoot>
      );
    }

    render(<InitialFocusDialog />);
    const first = screen.getByRole("button", { name: "First" });
    const requested = screen.getByRole("button", { name: "Requested" });
    const last = screen.getByRole("button", { name: "Last" });
    await waitFor(() => expect(document.activeElement).toBe(requested));

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("contains programmatic focus and removes containment on unmount", async () => {
    const onOpenChange = vi.fn();
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);

    const { unmount } = render(
      <ChatDialogRoot
        open
        onOpenChange={onOpenChange}
        dismissOnOutsideInteraction={false}
      >
        <ChatDialogContent>
          <ChatDialogTitle>Contained chat</ChatDialogTitle>
          <button>First action</button>
          <button>Second action</button>
        </ChatDialogContent>
      </ChatDialogRoot>,
    );
    const firstAction = screen.getByRole("button", { name: "First action" });
    await waitFor(() => expect(document.activeElement).toBe(firstAction));

    outside.focus();
    expect(document.activeElement).toBe(firstAction);
    expect(screen.getByRole("dialog", { name: "Contained chat" })).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();

    unmount();
    outside.focus();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("dismisses on Escape and restores focus to the trigger", async () => {
    render(<ControlledDialog />);
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Close dialog" }),
      ),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("supports configurable and vetoable outside interaction", () => {
    const onOpenChange = vi.fn();
    const onInteractOutside = vi.fn((event: PointerEvent) => event.preventDefault());
    const { rerender } = render(
      <>
        <button data-testid="outside">Outside</button>
        <ChatDialogRoot open onOpenChange={onOpenChange}>
          <ChatDialogContent onInteractOutside={onInteractOutside}>
            <ChatDialogTitle>Outside dialog</ChatDialogTitle>
          </ChatDialogContent>
        </ChatDialogRoot>
      </>,
    );
    const outside = screen.getByTestId("outside");
    fireEvent.pointerDown(outside);
    expect(onInteractOutside).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(
      <>
        <button data-testid="outside">Outside</button>
        <ChatDialogRoot
          open
          onOpenChange={onOpenChange}
          dismissOnOutsideInteraction={false}
        >
          <ChatDialogContent>
            <ChatDialogTitle>Outside dialog</ChatDialogTitle>
          </ChatDialogContent>
        </ChatDialogRoot>
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(
      <>
        <button data-testid="outside">Outside</button>
        <ChatDialogRoot open onOpenChange={onOpenChange}>
          <ChatDialogContent>
            <ChatDialogTitle>Outside dialog</ChatDialogTitle>
          </ChatDialogContent>
        </ChatDialogRoot>
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("enforces an accessible name", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <ChatDialogRoot open onOpenChange={() => undefined}>
          <ChatDialogContent />
        </ChatDialogRoot>,
      ),
    ).toThrow(/requires an accessible name/u);
    consoleError.mockRestore();

    render(
      <ChatDialogRoot open onOpenChange={() => undefined}>
        <ChatDialogContent aria-label="Explicit chat label" />
      </ChatDialogRoot>,
    );
    expect(screen.getByRole("dialog", { name: "Explicit chat label" })).toBeTruthy();
  });

  it("wires title and description relationships and preserves native props", async () => {
    const contentRef = createRef<HTMLDivElement>();
    const onClick = vi.fn();
    render(
      <ChatDialogRoot open onOpenChange={() => undefined}>
        <ChatDialogOverlay className="consumer-overlay" data-overlay="yes" />
        <ChatDialogContent
          ref={contentRef}
          className="consumer-content"
          style={{ color: "rgb(1, 2, 3)" }}
          data-consumer="yes"
          onClick={onClick}
        >
          <ChatDialogTitle id="consumer-title" className="consumer-title">
            Labelled chat
          </ChatDialogTitle>
          <ChatDialogDescription id="consumer-description">
            A useful description
          </ChatDialogDescription>
        </ChatDialogContent>
      </ChatDialogRoot>,
    );

    const dialog = screen.getByRole("dialog", { name: "Labelled chat" });
    await waitFor(() => {
      expect(dialog.getAttribute("aria-labelledby")).toBe("consumer-title");
      expect(dialog.getAttribute("aria-describedby")).toBe("consumer-description");
    });
    expect(contentRef.current).toBe(dialog);
    expect(dialog.className).toBe("consumer-content");
    expect(dialog.style.color).toBe("rgb(1, 2, 3)");
    expect(dialog.dataset.consumer).toBe("yes");
    fireEvent.click(dialog);
    expect(onClick).toHaveBeenCalledOnce();
    expect(document.querySelector(".consumer-overlay")?.getAttribute("data-overlay")).toBe(
      "yes",
    );
  });

  it("adds no visual presentation by default", () => {
    render(
      <ChatDialogRoot open onOpenChange={() => undefined}>
        <ChatDialogOverlay data-testid="overlay" />
        <ChatDialogContent>
          <ChatDialogTitle>Unstyled chat</ChatDialogTitle>
          <ChatDialogDescription>Headless content</ChatDialogDescription>
          <ChatDialogClose>Close</ChatDialogClose>
        </ChatDialogContent>
      </ChatDialogRoot>,
    );

    for (const element of [
      screen.getByTestId("overlay"),
      screen.getByRole("dialog"),
      screen.getByRole("heading"),
      screen.getByText("Headless content"),
      screen.getByRole("button", { name: "Close" }),
    ]) {
      expect(element.getAttribute("class")).toBeNull();
      expect(element.getAttribute("style")).toBeNull();
    }
    expect(document.querySelector("style, link[rel='stylesheet']")).toBeNull();
  });

  it("lets only the top nested dialog handle Escape and outside interaction", async () => {
    function NestedDialogs() {
      const [outerOpen, setOuterOpen] = useState(true);
      const [innerOpen, setInnerOpen] = useState(true);
      return (
        <ChatDialogRoot open={outerOpen} onOpenChange={setOuterOpen}>
          <ChatDialogContent>
            <ChatDialogTitle>Outer chat</ChatDialogTitle>
            <ChatDialogRoot open={innerOpen} onOpenChange={setInnerOpen}>
              <ChatDialogTrigger>Inner trigger</ChatDialogTrigger>
              <ChatDialogContent>
                <ChatDialogTitle>Inner chat</ChatDialogTitle>
                <button>Inner action</button>
              </ChatDialogContent>
            </ChatDialogRoot>
          </ChatDialogContent>
        </ChatDialogRoot>
      );
    }

    render(<NestedDialogs />);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Inner action" }),
      ),
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Inner chat" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer chat" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Inner trigger" }),
      ),
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Outer chat" })).toBeNull();
  });

  it("contains escaped focus in the top nested dialog", async () => {
    render(
      <>
        <button>Outside action</button>
        <ChatDialogRoot open onOpenChange={() => undefined}>
          <ChatDialogContent>
            <ChatDialogTitle>Parent chat</ChatDialogTitle>
            <button>Parent action</button>
            <ChatDialogRoot open onOpenChange={() => undefined}>
              <ChatDialogContent>
                <ChatDialogTitle>Child chat</ChatDialogTitle>
                <button>Child action</button>
              </ChatDialogContent>
            </ChatDialogRoot>
          </ChatDialogContent>
        </ChatDialogRoot>
      </>,
    );
    const childAction = screen.getByRole("button", { name: "Child action" });
    await waitFor(() => expect(document.activeElement).toBe(childAction));

    screen.getByRole("button", { name: "Outside action" }).focus();
    expect(document.activeElement).toBe(childAction);
    expect(screen.getByRole("dialog", { name: "Parent chat" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Child chat" })).toBeTruthy();
  });

  it("isolates simultaneous dialogs and removes listeners on unmount", async () => {
    const firstChange = vi.fn();
    const secondChange = vi.fn();
    const previouslyFocused = document.createElement("button");
    document.body.append(previouslyFocused);
    previouslyFocused.focus();
    const { unmount } = render(
      <>
        <ChatDialogRoot open onOpenChange={firstChange}>
          <ChatDialogContent aria-label="First dialog" />
        </ChatDialogRoot>
        <ChatDialogRoot open onOpenChange={secondChange}>
          <ChatDialogContent aria-label="Second dialog" />
        </ChatDialogRoot>
      </>,
    );
    await act(async () => undefined);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(firstChange).not.toHaveBeenCalled();
    expect(secondChange).toHaveBeenCalledWith(false);

    firstChange.mockClear();
    secondChange.mockClear();
    unmount();
    await waitFor(() => expect(document.activeElement).toBe(previouslyFocused));
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.pointerDown(document.body);
    expect(firstChange).not.toHaveBeenCalled();
    expect(secondChange).not.toHaveBeenCalled();
    previouslyFocused.remove();
  });

  it("uses a real browser portal and renders the portal safely during SSR", async () => {
    const portalContainer = document.createElement("section");
    document.body.append(portalContainer);
    render(
      <ChatDialogRoot open onOpenChange={() => undefined}>
        <ChatDialogPortal container={portalContainer}>
          <ChatDialogContent aria-label="Portalled chat" />
        </ChatDialogPortal>
      </ChatDialogRoot>,
    );
    await waitFor(() =>
      expect(portalContainer.querySelector("[role='dialog']")).not.toBeNull(),
    );

    expect(() =>
      renderToString(
        <ChatDialogRoot open onOpenChange={() => undefined}>
          <ChatDialogPortal>
            <ChatDialogContent aria-label="Server chat" />
          </ChatDialogPortal>
        </ChatDialogRoot>,
      ),
    ).not.toThrow();
    portalContainer.remove();
  });
});
