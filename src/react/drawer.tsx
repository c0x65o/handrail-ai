import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ForwardedRef,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type OpenChangeHandler = (open: boolean) => void;

export type ChatDrawerSide = "start" | "end" | "top" | "bottom";

interface DrawerInstance {
  parent: DrawerInstance | null;
  trigger: HTMLButtonElement | null;
  titles: Set<HTMLElement>;
  descriptions: Set<HTMLElement>;
  notify: () => void;
  state: {
    dismissOnOutsideInteraction: boolean;
    modal: boolean;
    onOpenChange: OpenChangeHandler;
    open: boolean;
  };
}

interface DrawerContextValue {
  contentId: string;
  descriptionId: string;
  instance: DrawerInstance;
  modal: boolean;
  open: boolean;
  side: ChatDrawerSide;
  titleId: string;
}

interface DrawerLayer {
  content: HTMLElement;
  instance: DrawerInstance;
}

const DrawerContext = createContext<DrawerContextValue | null>(null);
const layersByDocument = new WeakMap<Document, DrawerLayer[]>();
const useSafeLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

function useDrawerContext(component: string): DrawerContextValue {
  const context = useContext(DrawerContext);
  if (!context) {
    throw new Error(`${component} must be rendered within ChatDrawerRoot.`);
  }
  return context;
}

function isDescendantOf(
  instance: DrawerInstance,
  possibleAncestor: DrawerInstance,
): boolean {
  let parent = instance.parent;
  while (parent) {
    if (parent === possibleAncestor) return true;
    parent = parent.parent;
  }
  return false;
}

function getTopLayer(document: Document): DrawerLayer | undefined {
  const layers = layersByDocument.get(document) ?? [];
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (
      layer &&
      !layers.some(
        (other) =>
          other !== layer && isDescendantOf(other.instance, layer.instance),
      )
    ) {
      return layer;
    }
  }
  return undefined;
}

function registerLayer(layer: DrawerLayer): () => void {
  const document = layer.content.ownerDocument;
  const layers = layersByDocument.get(document) ?? [];
  layers.push(layer);
  layersByDocument.set(document, layers);

  return () => {
    const currentLayers = layersByDocument.get(document);
    if (!currentLayers) return;
    const index = currentLayers.indexOf(layer);
    if (index >= 0) currentLayers.splice(index, 1);
    if (currentLayers.length === 0) layersByDocument.delete(document);
  };
}

function setRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

function focusElement(element: HTMLElement): void {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");

function getFocusableElements(content: HTMLElement): HTMLElement[] {
  return Array.from(content.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => {
      if (element.tabIndex < 0 || element.closest("[hidden],[aria-hidden='true']")) {
        return false;
      }
      if (element.matches(":disabled")) return false;
      const view = element.ownerDocument.defaultView;
      if (!view) return true;
      const style = view.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    },
  );
}

function cycleFocus(content: HTMLElement, backwards: boolean): void {
  const focusable = getFocusableElements(content);
  if (focusable.length === 0) {
    focusElement(content);
    return;
  }

  const activeElement = content.ownerDocument.activeElement;
  const currentIndex = focusable.findIndex((element) => element === activeElement);
  let nextIndex: number;
  if (backwards) {
    nextIndex = currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1;
  } else {
    nextIndex = currentIndex < 0 || currentIndex === focusable.length - 1
      ? 0
      : currentIndex + 1;
  }
  const next = focusable[nextIndex];
  if (next) focusElement(next);
}

function focusFirst(content: HTMLElement): void {
  focusElement(getFocusableElements(content)[0] ?? content);
}

export interface ChatDrawerRootProps {
  children?: ReactNode;
  /** Whether pointer interaction outside the top-most drawer requests closing. */
  dismissOnOutsideInteraction?: boolean;
  /** Whether the drawer behaves as a modal dialog instead of a non-modal landmark. */
  modal?: boolean;
  onOpenChange: OpenChangeHandler;
  open: boolean;
  /** Styling hook only; no positioning or presentation is applied. */
  side?: ChatDrawerSide;
}

export function ChatDrawerRoot({
  children,
  dismissOnOutsideInteraction = true,
  modal = true,
  onOpenChange,
  open,
  side = "end",
}: ChatDrawerRootProps) {
  const parentContext = useContext(DrawerContext);
  const [registrationVersion, notify] = useReducer(
    (version: number) => version + 1,
    0,
  );
  const reactId = useId();
  const instanceRef = useRef<DrawerInstance | null>(null);
  const openRef = useRef(open);
  const openedAsModalRef = useRef(false);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  if (!instanceRef.current) {
    instanceRef.current = {
      parent: parentContext?.instance ?? null,
      trigger: null,
      titles: new Set(),
      descriptions: new Set(),
      notify,
      state: { dismissOnOutsideInteraction, modal, onOpenChange, open },
    };
  }

  const instance = instanceRef.current;
  instance.notify = notify;
  instance.state = { dismissOnOutsideInteraction, modal, onOpenChange, open };
  openRef.current = open;

  useSafeLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      const activeElement = typeof document === "undefined"
        ? null
        : document.activeElement;
      previouslyFocusedRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
      openedAsModalRef.current = modal;
    } else if (!open && wasOpenRef.current && openedAsModalRef.current) {
      const restoreTarget = instance.trigger ?? previouslyFocusedRef.current;
      queueMicrotask(() => {
        if (restoreTarget?.isConnected) focusElement(restoreTarget);
      });
    }
    wasOpenRef.current = open;
  }, [instance, modal, open]);

  useSafeLayoutEffect(
    () => () => {
      if (!openRef.current || !openedAsModalRef.current) return;
      const restoreTarget = instance.trigger ?? previouslyFocusedRef.current;
      queueMicrotask(() => {
        if (restoreTarget?.isConnected) focusElement(restoreTarget);
      });
    },
    [instance],
  );

  const context = useMemo<DrawerContextValue>(
    () => ({
      contentId: `handrail-chat-drawer-content-${reactId}`,
      descriptionId: `handrail-chat-drawer-description-${reactId}`,
      instance,
      modal,
      open,
      side,
      titleId: `handrail-chat-drawer-title-${reactId}`,
    }),
    [instance, modal, open, reactId, registrationVersion, side],
  );

  return <DrawerContext.Provider value={context}>{children}</DrawerContext.Provider>;
}

export type ChatDrawerTriggerProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const ChatDrawerTrigger = forwardRef<
  HTMLButtonElement,
  ChatDrawerTriggerProps
>(function ChatDrawerTrigger(
  {
    onClick,
    type,
    "aria-controls": ariaControls,
    "aria-expanded": ariaExpanded,
    "aria-haspopup": ariaHasPopup,
    ...props
  },
  forwardedRef,
) {
  const { contentId, instance, modal, open, side } = useDrawerContext(
    "ChatDrawerTrigger",
  );
  const attachRef = useCallback(
    (node: HTMLButtonElement | null) => {
      instance.trigger = node;
      setRef(forwardedRef, node);
    },
    [forwardedRef, instance],
  );

  return (
    <button
      {...props}
      ref={attachRef}
      type={type ?? "button"}
      aria-controls={ariaControls ?? contentId}
      aria-expanded={ariaExpanded ?? open}
      aria-haspopup={ariaHasPopup ?? (modal ? "dialog" : undefined)}
      data-side={side}
      data-state={open ? "open" : "closed"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) instance.state.onOpenChange(!open);
      }}
    />
  );
});

export interface ChatDrawerPortalProps {
  children?: ReactNode;
  container?: Element | DocumentFragment | null;
}

export function ChatDrawerPortal({ children, container }: ChatDrawerPortalProps) {
  const { open } = useDrawerContext("ChatDrawerPortal");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!open || !mounted || typeof document === "undefined") return null;
  return createPortal(children, container ?? document.body);
}

export type ChatDrawerOverlayProps = HTMLAttributes<HTMLDivElement>;

export const ChatDrawerOverlay = forwardRef<
  HTMLDivElement,
  ChatDrawerOverlayProps
>(function ChatDrawerOverlay(props, forwardedRef) {
  const { open, side } = useDrawerContext("ChatDrawerOverlay");
  if (!open) return null;
  return (
    <div
      {...props}
      ref={forwardedRef}
      data-side={side}
      data-state={open ? "open" : "closed"}
    />
  );
});

export interface ChatDrawerContentProps extends HTMLAttributes<HTMLDivElement> {
  /** Element to focus when a modal drawer opens, before the first tabbable fallback. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Called for pointer interaction outside this content. Prevent default to veto dismissal. */
  onInteractOutside?: (event: PointerEvent) => void;
}

export const ChatDrawerContent = forwardRef<
  HTMLDivElement,
  ChatDrawerContentProps
>(function ChatDrawerContent(
  {
    initialFocusRef,
    onInteractOutside,
    role,
    tabIndex,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    "aria-modal": ariaModal,
    ...props
  },
  forwardedRef,
) {
  const { contentId, instance, modal, open, side, titleId } = useDrawerContext(
    "ChatDrawerContent",
  );
  const contentRef = useRef<HTMLDivElement | null>(null);
  const initialFocusRefRef = useRef(initialFocusRef);
  const interactOutsideRef = useRef(onInteractOutside);
  initialFocusRefRef.current = initialFocusRef;
  interactOutsideRef.current = onInteractOutside;

  const attachRef = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      setRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  const registeredTitleId = instance.titles.values().next().value?.id as
    | string
    | undefined;
  const registeredDescriptionId = instance.descriptions.values().next().value
    ?.id as string | undefined;
  const resolvedLabelledBy =
    ariaLabelledBy ?? (ariaLabel ? undefined : registeredTitleId ?? titleId);
  const resolvedDescribedBy = ariaDescribedBy ?? registeredDescriptionId;

  useSafeLayoutEffect(() => {
    if (!open) return;
    const content = contentRef.current;
    if (!content) return;

    const hasAccessibleName = Boolean(
      ariaLabel?.trim() ||
        (ariaLabelledBy === undefined
          ? instance.titles.size > 0
          : ariaLabelledBy.trim()),
    );
    if (!hasAccessibleName) {
      throw new Error(
        "ChatDrawerContent requires an accessible name. Render ChatDrawerTitle, or provide aria-label or aria-labelledby.",
      );
    }

    const layer: DrawerLayer = { content, instance };
    const unregisterLayer = registerLayer(layer);
    const document = content.ownerDocument;
    let cancelled = false;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || getTopLayer(document) !== layer) return;
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        instance.state.onOpenChange(false);
      } else if (event.key === "Tab" && instance.state.modal) {
        event.preventDefault();
        cycleFocus(content, event.shiftKey);
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (
        !instance.state.modal ||
        getTopLayer(document) !== layer ||
        event.composedPath().includes(content)
      ) {
        return;
      }
      focusFirst(content);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.defaultPrevented ||
        getTopLayer(document) !== layer ||
        event.composedPath().includes(content)
      ) {
        return;
      }
      interactOutsideRef.current?.(event);
      if (
        !event.defaultPrevented &&
        instance.state.dismissOnOutsideInteraction
      ) {
        instance.state.onOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("pointerdown", handlePointerDown);
    if (modal) {
      queueMicrotask(() => {
        if (cancelled || getTopLayer(document) !== layer) return;
        const requestedFocus = initialFocusRefRef.current?.current;
        const autoFocus = content.querySelector<HTMLElement>("[autofocus]");
        const target =
          (requestedFocus && content.contains(requestedFocus)
            ? requestedFocus
            : null) ??
          autoFocus ??
          getFocusableElements(content)[0] ??
          content;
        focusElement(target);
      });
    }

    return () => {
      cancelled = true;
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("pointerdown", handlePointerDown);
      unregisterLayer();
    };
  }, [ariaLabel, ariaLabelledBy, instance, modal, open]);

  if (!open) return null;
  return (
    <div
      {...props}
      ref={attachRef}
      id={props.id ?? contentId}
      role={role ?? (modal ? "dialog" : "complementary")}
      aria-modal={ariaModal ?? (modal ? true : undefined)}
      aria-label={ariaLabel}
      aria-labelledby={resolvedLabelledBy}
      aria-describedby={resolvedDescribedBy}
      data-side={side}
      data-state={open ? "open" : "closed"}
      tabIndex={modal ? tabIndex ?? -1 : tabIndex}
    />
  );
});

export type ChatDrawerTitleProps = HTMLAttributes<HTMLHeadingElement>;

export const ChatDrawerTitle = forwardRef<
  HTMLHeadingElement,
  ChatDrawerTitleProps
>(function ChatDrawerTitle({ id, ...props }, forwardedRef) {
  const { instance, open, side, titleId } = useDrawerContext("ChatDrawerTitle");
  const previousNodeRef = useRef<HTMLHeadingElement | null>(null);
  const attachRef = useCallback(
    (node: HTMLHeadingElement | null) => {
      const previousNode = previousNodeRef.current;
      if (previousNode) instance.titles.delete(previousNode);
      previousNodeRef.current = node;
      if (node) instance.titles.add(node);
      setRef(forwardedRef, node);
    },
    [forwardedRef, instance],
  );

  useSafeLayoutEffect(() => {
    instance.notify();
    return () => instance.notify();
  }, [id, instance]);

  if (!open) return null;
  return (
    <h2
      {...props}
      ref={attachRef}
      id={id ?? titleId}
      data-side={side}
      data-state={open ? "open" : "closed"}
    />
  );
});

export type ChatDrawerDescriptionProps = HTMLAttributes<HTMLParagraphElement>;

export const ChatDrawerDescription = forwardRef<
  HTMLParagraphElement,
  ChatDrawerDescriptionProps
>(function ChatDrawerDescription({ id, ...props }, forwardedRef) {
  const { descriptionId, instance, open, side } = useDrawerContext(
    "ChatDrawerDescription",
  );
  const previousNodeRef = useRef<HTMLParagraphElement | null>(null);
  const attachRef = useCallback(
    (node: HTMLParagraphElement | null) => {
      const previousNode = previousNodeRef.current;
      if (previousNode) instance.descriptions.delete(previousNode);
      previousNodeRef.current = node;
      if (node) instance.descriptions.add(node);
      setRef(forwardedRef, node);
    },
    [forwardedRef, instance],
  );

  useSafeLayoutEffect(() => {
    instance.notify();
    return () => instance.notify();
  }, [id, instance]);

  if (!open) return null;
  return (
    <p
      {...props}
      ref={attachRef}
      id={id ?? descriptionId}
      data-side={side}
      data-state={open ? "open" : "closed"}
    />
  );
});

export type ChatDrawerCloseProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const ChatDrawerClose = forwardRef<HTMLButtonElement, ChatDrawerCloseProps>(
  function ChatDrawerClose({ onClick, type, ...props }, forwardedRef) {
    const { instance, open, side } = useDrawerContext("ChatDrawerClose");
    if (!open) return null;
    return (
      <button
        {...props}
        ref={forwardedRef}
        type={type ?? "button"}
        data-side={side}
        data-state={open ? "open" : "closed"}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) instance.state.onOpenChange(false);
        }}
      />
    );
  },
);
