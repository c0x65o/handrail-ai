/** @vitest-environment jsdom */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef, useRef, useState, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ChatDrawerClose,
  ChatDrawerContent,
  ChatDrawerDescription,
  ChatDrawerOverlay,
  ChatDrawerPortal,
  ChatDrawerRoot,
  ChatDrawerTitle,
  ChatDrawerTrigger,
  type ChatDrawerSide,
} from "../src/react/index.js";

afterEach(() => cleanup());

function ControlledDrawer({
  children,
  defaultOpen = false,
  dismissOnOutsideInteraction,
  modal = true,
  side = "end",
}: {
  children?: ReactNode;
  defaultOpen?: boolean;
  dismissOnOutsideInteraction?: boolean;
  modal?: boolean;
  side?: ChatDrawerSide;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <ChatDrawerRoot
      open={open}
      onOpenChange={setOpen}
      modal={modal}
      side={side}
      {...(dismissOnOutsideInteraction === undefined
        ? {}
        : { dismissOnOutsideInteraction })}
    >
      <ChatDrawerTrigger>Open drawer</ChatDrawerTrigger>
      <ChatDrawerOverlay data-testid="overlay" />
      <ChatDrawerContent>
        <ChatDrawerTitle>Support chat</ChatDrawerTitle>
        {children}
        <ChatDrawerClose>Close drawer</ChatDrawerClose>
      </ChatDrawerContent>
    </ChatDrawerRoot>
  );
}

describe("ChatDrawer", () => {
  it("supports controlled trigger and close behavior", () => {
    render(<ControlledDrawer />);
    const trigger = screen.getByRole("button", { name: "Open drawer" });
    expect(trigger.dataset.state).toBe("closed");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "Support chat" });
    expect(drawer.dataset.state).toBe("open");
    expect(trigger.dataset.state).toBe("open");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.dataset.state).toBe("closed");
  });

  it("moves modal focus, traps it, dismisses on Escape, and restores the trigger", async () => {
    function FocusDrawer() {
      const [open, setOpen] = useState(false);
      const initialFocusRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button data-testid="outside">Outside</button>
          <ChatDrawerRoot open={open} onOpenChange={setOpen}>
            <ChatDrawerTrigger>Open focus drawer</ChatDrawerTrigger>
            <ChatDrawerContent initialFocusRef={initialFocusRef}>
              <ChatDrawerTitle>Focus drawer</ChatDrawerTitle>
              <button>First</button>
              <button ref={initialFocusRef}>Requested</button>
              <button>Last</button>
            </ChatDrawerContent>
          </ChatDrawerRoot>
        </>
      );
    }

    render(<FocusDrawer />);
    const trigger = screen.getByRole("button", { name: "Open focus drawer" });
    trigger.focus();
    fireEvent.click(trigger);
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

    screen.getByTestId("outside").focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("restores the previously focused element when there is no trigger", async () => {
    const previouslyFocused = document.createElement("button");
    document.body.append(previouslyFocused);
    previouslyFocused.focus();
    const { rerender } = render(
      <ChatDrawerRoot open onOpenChange={() => undefined}>
        <ChatDrawerContent aria-label="Triggerless drawer">
          <button>Drawer action</button>
        </ChatDrawerContent>
      </ChatDrawerRoot>,
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Drawer action" }),
      ),
    );

    rerender(
      <ChatDrawerRoot open={false} onOpenChange={() => undefined}>
        <ChatDrawerContent aria-label="Triggerless drawer" />
      </ChatDrawerRoot>,
    );
    await waitFor(() => expect(document.activeElement).toBe(previouslyFocused));
    previouslyFocused.remove();
  });

  it("does not force or trap focus in non-modal mode and leaves outside focus alone", async () => {
    render(
      <>
        <button data-testid="outside">Outside</button>
        <ControlledDrawer modal />
        <ControlledDrawer modal={false} />
      </>,
    );
    const triggers = screen.getAllByRole("button", { name: "Open drawer" });
    const nonModalTrigger = triggers[1];
    expect(nonModalTrigger).toBeTruthy();
    nonModalTrigger?.focus();
    fireEvent.click(nonModalTrigger as HTMLButtonElement);
    await act(async () => undefined);

    const drawer = screen.getByRole("complementary", { name: "Support chat" });
    expect(document.activeElement).toBe(nonModalTrigger);
    expect(drawer.getAttribute("tabindex")).toBeNull();
    expect(drawer.getAttribute("aria-modal")).toBeNull();

    const outside = screen.getByTestId("outside");
    outside.focus();
    expect(document.activeElement).toBe(outside);
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("supports vetoable and configurable outside dismissal", () => {
    const onOpenChange = vi.fn();
    const onInteractOutside = vi.fn((event: PointerEvent) => event.preventDefault());
    const { rerender } = render(
      <>
        <button data-testid="outside">Outside</button>
        <ChatDrawerRoot open onOpenChange={onOpenChange}>
          <ChatDrawerContent
            aria-label="Outside drawer"
            onInteractOutside={onInteractOutside}
          />
        </ChatDrawerRoot>
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onInteractOutside).toHaveBeenCalledOnce();
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(
      <>
        <button data-testid="outside">Outside</button>
        <ChatDrawerRoot
          open
          onOpenChange={onOpenChange}
          dismissOnOutsideInteraction={false}
        >
          <ChatDrawerContent aria-label="Outside drawer" />
        </ChatDrawerRoot>
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onOpenChange).not.toHaveBeenCalled();

    rerender(
      <>
        <button data-testid="outside">Outside</button>
        <ChatDrawerRoot open onOpenChange={onOpenChange}>
          <ChatDrawerContent aria-label="Outside drawer" />
        </ChatDrawerRoot>
      </>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("uses modal and non-modal roles with title and description linkage", async () => {
    const { rerender } = render(
      <ChatDrawerRoot open onOpenChange={() => undefined}>
        <ChatDrawerContent>
          <ChatDrawerTitle id="modal-title">Modal chat</ChatDrawerTitle>
          <ChatDrawerDescription id="modal-description">
            Modal details
          </ChatDrawerDescription>
        </ChatDrawerContent>
      </ChatDrawerRoot>,
    );
    const modal = screen.getByRole("dialog", { name: "Modal chat" });
    await waitFor(() => {
      expect(modal.getAttribute("aria-labelledby")).toBe("modal-title");
      expect(modal.getAttribute("aria-describedby")).toBe("modal-description");
    });
    expect(modal.getAttribute("aria-modal")).toBe("true");

    rerender(
      <ChatDrawerRoot open modal={false} onOpenChange={() => undefined}>
        <ChatDrawerContent>
          <ChatDrawerTitle id="landmark-title">Non-modal chat</ChatDrawerTitle>
          <ChatDrawerDescription id="landmark-description">
            Non-modal details
          </ChatDrawerDescription>
        </ChatDrawerContent>
      </ChatDrawerRoot>,
    );
    const nonModal = screen.getByRole("complementary", { name: "Non-modal chat" });
    await waitFor(() => {
      expect(nonModal.getAttribute("aria-labelledby")).toBe("landmark-title");
      expect(nonModal.getAttribute("aria-describedby")).toBe(
        "landmark-description",
      );
    });
    expect(nonModal.getAttribute("aria-modal")).toBeNull();
  });

  it("enforces an accessible name and forwards ARIA overrides", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <ChatDrawerRoot open modal={false} onOpenChange={() => undefined}>
          <ChatDrawerContent />
        </ChatDrawerRoot>,
      ),
    ).toThrow(/requires an accessible name/u);
    consoleError.mockRestore();

    render(
      <ChatDrawerRoot open modal={false} onOpenChange={() => undefined}>
        <ChatDrawerTrigger aria-controls="consumer-controls" aria-expanded="false" />
        <ChatDrawerContent
          id="consumer-drawer"
          role="region"
          aria-label="Explicit chat label"
          aria-describedby="consumer-description"
        />
      </ChatDrawerRoot>,
    );
    const region = screen.getByRole("region", { name: "Explicit chat label" });
    expect(region.id).toBe("consumer-drawer");
    expect(region.getAttribute("aria-describedby")).toBe("consumer-description");
    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-controls")).toBe("consumer-controls");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it.each<ChatDrawerSide>(["start", "end", "top", "bottom"])(
    "exposes the %s side only as data attributes",
    (side) => {
      render(<ControlledDrawer defaultOpen side={side} />);
      for (const element of [
        screen.getByRole("button", { name: "Open drawer" }),
        screen.getByTestId("overlay"),
        screen.getByRole("dialog"),
        screen.getByRole("heading"),
        screen.getByRole("button", { name: "Close drawer" }),
      ]) {
        expect(element.dataset.side).toBe(side);
        expect(element.dataset.state).toBe("open");
      }
    },
  );

  it("forwards consumer props, styles, events, and refs without defaults", () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const overlayRef = createRef<HTMLDivElement>();
    const contentRef = createRef<HTMLDivElement>();
    const onClick = vi.fn();
    render(
      <ChatDrawerRoot open onOpenChange={() => undefined}>
        <ChatDrawerTrigger ref={triggerRef}>Open styled drawer</ChatDrawerTrigger>
        <ChatDrawerOverlay ref={overlayRef} data-testid="unstyled-overlay" />
        <ChatDrawerContent
          ref={contentRef}
          className="consumer-content"
          style={{ color: "rgb(1, 2, 3)" }}
          data-consumer="yes"
          onClick={onClick}
        >
          <ChatDrawerTitle>Styled chat</ChatDrawerTitle>
          <ChatDrawerDescription>Useful details</ChatDrawerDescription>
          <ChatDrawerClose>Close styled drawer</ChatDrawerClose>
        </ChatDrawerContent>
      </ChatDrawerRoot>,
    );

    const drawer = screen.getByRole("dialog", { name: "Styled chat" });
    expect(triggerRef.current).toBe(screen.getByRole("button", { name: "Open styled drawer" }));
    expect(overlayRef.current).toBe(screen.getByTestId("unstyled-overlay"));
    expect(contentRef.current).toBe(drawer);
    expect(drawer.className).toBe("consumer-content");
    expect(drawer.style.color).toBe("rgb(1, 2, 3)");
    expect(drawer.style.cssText).toBe("color: rgb(1, 2, 3);");
    expect(drawer.dataset.consumer).toBe("yes");
    fireEvent.click(drawer);
    expect(onClick).toHaveBeenCalledOnce();

    for (const element of [
      triggerRef.current,
      overlayRef.current,
      screen.getByRole("heading"),
      screen.getByText("Useful details"),
      screen.getByRole("button", { name: "Close styled drawer" }),
    ]) {
      expect(element?.getAttribute("class")).toBeNull();
      expect(element?.getAttribute("style")).toBeNull();
    }
    expect(document.querySelector("style, link[rel='stylesheet']")).toBeNull();
  });

  it("portals into a consumer container and renders safely during SSR", async () => {
    const portalContainer = document.createElement("section");
    document.body.append(portalContainer);
    render(
      <ChatDrawerRoot open onOpenChange={() => undefined}>
        <ChatDrawerPortal container={portalContainer}>
          <ChatDrawerContent aria-label="Portalled drawer" />
        </ChatDrawerPortal>
      </ChatDrawerRoot>,
    );
    await waitFor(() =>
      expect(portalContainer.querySelector("[role='dialog']")).not.toBeNull(),
    );

    expect(() =>
      renderToString(
        <ChatDrawerRoot open onOpenChange={() => undefined}>
          <ChatDrawerPortal>
            <ChatDrawerContent aria-label="Server drawer" />
          </ChatDrawerPortal>
        </ChatDrawerRoot>,
      ),
    ).not.toThrow();
    portalContainer.remove();
  });

  it("keeps externally owned streaming state alive while closed", () => {
    function StreamingDrawer() {
      const [chunks, setChunks] = useState(0);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setChunks((value) => value + 1)}>
            Receive stream chunk
          </button>
          <ChatDrawerRoot open={open} onOpenChange={setOpen}>
            <ChatDrawerTrigger>Open streaming drawer</ChatDrawerTrigger>
            <ChatDrawerContent>
              <ChatDrawerTitle>Streaming chat</ChatDrawerTitle>
              <output aria-label="Received chunks">{chunks}</output>
              <ChatDrawerClose>Close streaming drawer</ChatDrawerClose>
            </ChatDrawerContent>
          </ChatDrawerRoot>
        </>
      );
    }

    render(<StreamingDrawer />);
    expect(screen.getByLabelText("Received chunks").textContent).toBe("0");
    fireEvent.click(screen.getByRole("button", { name: "Close streaming drawer" }));
    expect(screen.queryByLabelText("Received chunks")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Receive stream chunk" }));
    fireEvent.click(screen.getByRole("button", { name: "Open streaming drawer" }));
    expect(screen.getByLabelText("Received chunks").textContent).toBe("1");
  });
});
