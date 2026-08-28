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

interface DialogInstance {
  parent: DialogInstance | null;
  trigger: HTMLButtonElement | null;
  titles: Set<HTMLElement>;
  descriptions: Set<HTMLElement>;
  notify: () => void;
  state: {
    open: boolean;
    onOpenChange: OpenChangeHandler;
    dismissOnOutsideInteraction: boolean;
  };
}

interface DialogContextValue {
  contentId: string;
  descriptionId: string;
  instance: DialogInstance;
  open: boolean;
  titleId: string;
}

interface DialogLayer {
  content: HTMLElement;
  instance: DialogInstance;
}

const DialogContext = createContext<DialogContextValue | null>(null);
const layersByDocument = new WeakMap<Document, DialogLayer[]>();
const useSafeLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

function useDialogContext(component: string): DialogContextValue {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error(`${component} must be rendered within ChatDialogRoot.`);
  }
  return context;
}

function isDescendantOf(
  instance: DialogInstance,
  possibleAncestor: DialogInstance,
): boolean {
  let parent = instance.parent;
  while (parent) {
    if (parent === possibleAncestor) return true;
    parent = parent.parent;
  }
  return false;
}

function getTopLayer(document: Document): DialogLayer | undefined {
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

function registerLayer(layer: DialogLayer): () => void {
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

export interface ChatDialogRootProps {
  children?: ReactNode;
  /** Whether pointer interaction outside the top-most dialog requests closing. */
  dismissOnOutsideInteraction?: boolean;
  onOpenChange: OpenChangeHandler;
  open: boolean;
}

export function ChatDialogRoot({
  children,
  dismissOnOutsideInteraction = true,
  onOpenChange,
  open,
}: ChatDialogRootProps) {
  const parentContext = useContext(DialogContext);
  const [registrationVersion, notify] = useReducer(
    (version: number) => version + 1,
    0,
  );
  const reactId = useId();
  const instanceRef = useRef<DialogInstance | null>(null);
  const openRef = useRef(open);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  if (!instanceRef.current) {
    instanceRef.current = {
      parent: parentContext?.instance ?? null,
      trigger: null,
      titles: new Set(),
      descriptions: new Set(),
      notify,
      state: { open, onOpenChange, dismissOnOutsideInteraction },
    };
  }

  const instance = instanceRef.current;
  instance.notify = notify;
  instance.state = { open, onOpenChange, dismissOnOutsideInteraction };
  openRef.current = open;

  useSafeLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      const activeElement = typeof document === "undefined"
        ? null
        : document.activeElement;
      previouslyFocusedRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
    } else if (!open && wasOpenRef.current) {
      const restoreTarget = instance.trigger ?? previouslyFocusedRef.current;
      queueMicrotask(() => {
        if (restoreTarget?.isConnected) focusElement(restoreTarget);
      });
    }
    wasOpenRef.current = open;
  }, [instance, open]);

  useSafeLayoutEffect(
    () => () => {
      if (!openRef.current) return;
      const restoreTarget = instance.trigger ?? previouslyFocusedRef.current;
      queueMicrotask(() => {
        if (restoreTarget?.isConnected) focusElement(restoreTarget);
      });
    },
    [instance],
  );

  const context = useMemo<DialogContextValue>(
    () => ({
      contentId: `handrail-chat-dialog-content-${reactId}`,
      descriptionId: `handrail-chat-dialog-description-${reactId}`,
      instance,
      open,
      titleId: `handrail-chat-dialog-title-${reactId}`,
    }),
    [instance, open, reactId, registrationVersion],
  );

  return <DialogContext.Provider value={context}>{children}</DialogContext.Provider>;
}

export type ChatDialogTriggerProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const ChatDialogTrigger = forwardRef<
  HTMLButtonElement,
  ChatDialogTriggerProps
>(function ChatDialogTrigger({ onClick, type, ...props }, forwardedRef) {
  const { contentId, instance, open } = useDialogContext("ChatDialogTrigger");
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
      aria-controls={props["aria-controls"] ?? contentId}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-state={open ? "open" : "closed"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) instance.state.onOpenChange(!open);
      }}
    />
  );
});

export interface ChatDialogPortalProps {
  children?: ReactNode;
  container?: Element | DocumentFragment | null;
}

export function ChatDialogPortal({ children, container }: ChatDialogPortalProps) {
  const { open } = useDialogContext("ChatDialogPortal");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!open || !mounted || typeof document === "undefined") return null;
  return createPortal(children, container ?? document.body);
}

export type ChatDialogOverlayProps = HTMLAttributes<HTMLDivElement>;

export const ChatDialogOverlay = forwardRef<
  HTMLDivElement,
  ChatDialogOverlayProps
>(function ChatDialogOverlay(props, forwardedRef) {
  const { open } = useDialogContext("ChatDialogOverlay");
  if (!open) return null;
  return (
    <div
      {...props}
      ref={forwardedRef}
      data-state={open ? "open" : "closed"}
    />
  );
});

export interface ChatDialogContentProps extends HTMLAttributes<HTMLDivElement> {
  /** Element to focus when the dialog opens, before the first tabbable fallback. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Called for pointer interaction outside this content. Prevent default to veto dismissal. */
  onInteractOutside?: (event: PointerEvent) => void;
}

export const ChatDialogContent = forwardRef<
  HTMLDivElement,
  ChatDialogContentProps
>(function ChatDialogContent(
  {
    initialFocusRef,
    onInteractOutside,
    tabIndex,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
    "aria-describedby": ariaDescribedBy,
    ...props
  },
  forwardedRef,
) {
  const { contentId, instance, open, titleId } = useDialogContext(
    "ChatDialogContent",
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
        ariaLabelledBy?.trim() ||
        instance.titles.size > 0,
    );
    if (!hasAccessibleName) {
      throw new Error(
        "ChatDialogContent requires an accessible name. Render ChatDialogTitle, or provide aria-label or aria-labelledby.",
      );
    }

    const layer: DialogLayer = { content, instance };
    const unregisterLayer = registerLayer(layer);
    const document = content.ownerDocument;
    let cancelled = false;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || getTopLayer(document) !== layer) return;
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        instance.state.onOpenChange(false);
      } else if (event.key === "Tab") {
        event.preventDefault();
        cycleFocus(content, event.shiftKey);
      }
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
    document.addEventListener("pointerdown", handlePointerDown);
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

    return () => {
      cancelled = true;
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      unregisterLayer();
    };
  }, [ariaLabel, ariaLabelledBy, instance, open]);

  if (!open) return null;
  return (
    <div
      {...props}
      ref={attachRef}
      id={props.id ?? contentId}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={resolvedLabelledBy}
      aria-describedby={resolvedDescribedBy}
      data-state={open ? "open" : "closed"}
      tabIndex={tabIndex ?? -1}
    />
  );
});

export type ChatDialogTitleProps = HTMLAttributes<HTMLHeadingElement>;

export const ChatDialogTitle = forwardRef<
  HTMLHeadingElement,
  ChatDialogTitleProps
>(function ChatDialogTitle({ id, ...props }, forwardedRef) {
  const { instance, open, titleId } = useDialogContext("ChatDialogTitle");
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
      data-state={open ? "open" : "closed"}
    />
  );
});

export type ChatDialogDescriptionProps = HTMLAttributes<HTMLParagraphElement>;

export const ChatDialogDescription = forwardRef<
  HTMLParagraphElement,
  ChatDialogDescriptionProps
>(function ChatDialogDescription({ id, ...props }, forwardedRef) {
  const { descriptionId, instance, open } = useDialogContext(
    "ChatDialogDescription",
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
      data-state={open ? "open" : "closed"}
    />
  );
});

export type ChatDialogCloseProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const ChatDialogClose = forwardRef<HTMLButtonElement, ChatDialogCloseProps>(
  function ChatDialogClose({ onClick, type, ...props }, forwardedRef) {
    const { instance, open } = useDialogContext("ChatDialogClose");
    if (!open) return null;
    return (
      <button
        {...props}
        ref={forwardedRef}
        type={type ?? "button"}
        data-state={open ? "open" : "closed"}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) instance.state.onOpenChange(false);
        }}
      />
    );
  },
);
