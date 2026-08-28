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
} from "react";

export type ChatTabsOrientation = "horizontal" | "vertical";
export type ChatTabsActivationMode = "automatic" | "manual";

type ValueChangeHandler = (value: string) => void;

interface TriggerRegistration {
  disabled: boolean;
  id: string;
  node: HTMLButtonElement | null;
  value: string;
}

interface ContentRegistration {
  id: string;
  value: string;
}

interface TabsInstance {
  contents: Set<ContentRegistration>;
  notify: () => void;
  state: {
    activationMode: ChatTabsActivationMode;
    initializeValue: (value: string) => void;
    orientation: ChatTabsOrientation;
    setTabStopValue: (value: string) => void;
    setValue: (value: string) => void;
    tabStopValue: string | undefined;
    value: string | undefined;
  };
  triggers: Set<TriggerRegistration>;
}

interface TabsContextValue {
  baseId: string;
  instance: TabsInstance;
}

const TabsContext = createContext<TabsContextValue | null>(null);
const useSafeLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error(`${component} must be rendered within ChatTabsRoot.`);
  }
  return context;
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

function valueIdPart(value: string): string {
  if (value.length === 0) return "empty";
  let encoded = "";
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function generatedTriggerId(baseId: string, value: string): string {
  return `${baseId}-trigger-${valueIdPart(value)}`;
}

function generatedContentId(baseId: string, value: string): string {
  return `${baseId}-content-${valueIdPart(value)}`;
}

function getRegisteredTriggerId(
  instance: TabsInstance,
  value: string,
): string | undefined {
  for (const trigger of instance.triggers) {
    if (trigger.value === value) return trigger.id;
  }
  return undefined;
}

function getRegisteredContentId(
  instance: TabsInstance,
  value: string,
): string | undefined {
  for (const content of instance.contents) {
    if (content.value === value) return content.id;
  }
  return undefined;
}

function getEnabledTriggers(instance: TabsInstance): TriggerRegistration[] {
  return Array.from(instance.triggers)
    .filter(
      (trigger): trigger is TriggerRegistration & { node: HTMLButtonElement } =>
        !trigger.disabled && trigger.node !== null && trigger.node.isConnected,
    )
    .sort((left, right) => {
      if (left.node === right.node) return 0;
      return left.node.compareDocumentPosition(right.node) &
        Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    });
}

export interface ChatTabsRootProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "defaultValue"> {
  /** Selects a tab when the component is controlled. */
  value?: string;
  /** Selects the initial tab when the component is uncontrolled. */
  defaultValue?: string;
  onValueChange?: ValueChangeHandler;
  orientation?: ChatTabsOrientation;
  activationMode?: ChatTabsActivationMode;
  children?: ReactNode;
}

export const ChatTabsRoot = forwardRef<HTMLDivElement, ChatTabsRootProps>(
  function ChatTabsRoot(
    {
      activationMode = "automatic",
      children,
      defaultValue,
      onValueChange,
      orientation = "horizontal",
      value: controlledValue,
      ...props
    },
    forwardedRef,
  ) {
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
    const controlled = controlledValue !== undefined;
    const value = controlled ? controlledValue : uncontrolledValue;
    const [tabStopValue, setTabStopValue] = useState(value);
    const [registrationVersion, notify] = useReducer(
      (version: number) => version + 1,
      0,
    );
    const reactId = useId();
    const initializedValueRef = useRef(value !== undefined);
    const instanceRef = useRef<TabsInstance | null>(null);

    const setValue = useCallback(
      (nextValue: string) => {
        if (nextValue === value) return;
        if (!controlled) setUncontrolledValue(nextValue);
        onValueChange?.(nextValue);
      },
      [controlled, onValueChange, value],
    );
    const initializeValue = useCallback(
      (initialValue: string) => {
        if (controlled || initializedValueRef.current) return;
        initializedValueRef.current = true;
        setUncontrolledValue(initialValue);
        setTabStopValue(initialValue);
      },
      [controlled],
    );

    if (!instanceRef.current) {
      instanceRef.current = {
        contents: new Set(),
        notify,
        state: {
          activationMode,
          initializeValue,
          orientation,
          setTabStopValue,
          setValue,
          tabStopValue,
          value,
        },
        triggers: new Set(),
      };
    }

    const instance = instanceRef.current;
    if (!instance) {
      throw new Error("ChatTabsRoot could not initialize its tabs instance.");
    }
    instance.notify = notify;
    instance.state = {
      activationMode,
      initializeValue,
      orientation,
      setTabStopValue,
      setValue,
      tabStopValue,
      value,
    };

    useSafeLayoutEffect(() => {
      if (value !== undefined) setTabStopValue(value);
    }, [value]);

    const context = useMemo<TabsContextValue>(
      () => ({
        baseId: `handrail-chat-tabs-${reactId}`,
        instance,
      }),
      [
        activationMode,
        controlled,
        instance,
        onValueChange,
        orientation,
        reactId,
        registrationVersion,
        tabStopValue,
        value,
      ],
    );

    return (
      <TabsContext.Provider value={context}>
        <div
          {...props}
          ref={forwardedRef}
          data-orientation={orientation}
        >
          {children}
        </div>
      </TabsContext.Provider>
    );
  },
);

export type ChatTabsListProps = HTMLAttributes<HTMLDivElement>;

export const ChatTabsList = forwardRef<HTMLDivElement, ChatTabsListProps>(
  function ChatTabsList(props, forwardedRef) {
    const { instance } = useTabsContext("ChatTabsList");
    const { orientation } = instance.state;
    return (
      <div
        {...props}
        ref={forwardedRef}
        role="tablist"
        aria-orientation={orientation}
        data-orientation={orientation}
      />
    );
  },
);

export interface ChatTabsTriggerProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export const ChatTabsTrigger = forwardRef<
  HTMLButtonElement,
  ChatTabsTriggerProps
>(function ChatTabsTrigger(
  {
    disabled = false,
    id,
    onClick,
    onFocus,
    onKeyDown,
    type,
    value,
    ...props
  },
  forwardedRef,
) {
  const { baseId, instance } = useTabsContext("ChatTabsTrigger");
  const triggerId = id ?? generatedTriggerId(baseId, value);
  const registrationRef = useRef<TriggerRegistration>({
    disabled,
    id: triggerId,
    node: null,
    value,
  });
  const registration = registrationRef.current;
  registration.disabled = disabled;
  registration.id = triggerId;
  registration.value = value;

  const attachRef = useCallback(
    (node: HTMLButtonElement | null) => {
      registration.node = node;
      setRef(forwardedRef, node);
    },
    [forwardedRef, registration],
  );

  useSafeLayoutEffect(() => {
    instance.triggers.add(registration);
    if (!disabled) instance.state.initializeValue(value);
    instance.notify();
    return () => {
      instance.triggers.delete(registration);
      instance.notify();
    };
  }, [disabled, instance, registration, triggerId, value]);

  const selected = instance.state.value === value;
  const tabStop = instance.state.tabStopValue;
  const panelId =
    getRegisteredContentId(instance, value) ?? generatedContentId(baseId, value);

  return (
    <button
      {...props}
      ref={attachRef}
      id={triggerId}
      type={type ?? "button"}
      role="tab"
      aria-controls={props["aria-controls"] ?? panelId}
      aria-selected={selected}
      disabled={disabled}
      data-disabled={disabled ? "" : undefined}
      data-orientation={instance.state.orientation}
      data-state={selected ? "active" : "inactive"}
      tabIndex={
        props.tabIndex ??
        (tabStop === value || (tabStop === undefined && selected) ? 0 : -1)
      }
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        instance.state.setTabStopValue(value);
        instance.state.setValue(value);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        if (event.defaultPrevented) return;
        instance.state.setTabStopValue(value);
        if (instance.state.activationMode === "automatic") {
          instance.state.setValue(value);
        }
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;

        const { orientation } = instance.state;
        const previousKey = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
        const nextKey = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
        const triggers = getEnabledTriggers(instance);
        if (triggers.length === 0) return;

        const currentIndex = triggers.findIndex(
          (trigger) => trigger.node === event.currentTarget,
        );
        let nextIndex: number | undefined;
        if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = triggers.length - 1;
        } else if (event.key === previousKey) {
          nextIndex = currentIndex <= 0 ? triggers.length - 1 : currentIndex - 1;
        } else if (event.key === nextKey) {
          nextIndex =
            currentIndex < 0 || currentIndex === triggers.length - 1
              ? 0
              : currentIndex + 1;
        }

        if (nextIndex === undefined) return;
        const nextTrigger = triggers[nextIndex];
        if (!nextTrigger?.node) return;
        event.preventDefault();
        focusElement(nextTrigger.node);
      }}
    />
  );
});

export interface ChatTabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
  /** Keeps inactive content mounted while applying the native hidden attribute. */
  forceMount?: boolean;
}

export const ChatTabsContent = forwardRef<HTMLDivElement, ChatTabsContentProps>(
  function ChatTabsContent(
    {
      forceMount = false,
      hidden,
      id,
      tabIndex,
      value,
      "aria-labelledby": ariaLabelledBy,
      ...props
    },
    forwardedRef,
  ) {
    const { baseId, instance } = useTabsContext("ChatTabsContent");
    const contentId = id ?? generatedContentId(baseId, value);
    const registrationRef = useRef<ContentRegistration>({ id: contentId, value });
    const registration = registrationRef.current;
    registration.id = contentId;
    registration.value = value;

    useSafeLayoutEffect(() => {
      instance.contents.add(registration);
      instance.notify();
      return () => {
        instance.contents.delete(registration);
        instance.notify();
      };
    }, [contentId, instance, registration, value]);

    const selected = instance.state.value === value;
    const triggerId =
      getRegisteredTriggerId(instance, value) ?? generatedTriggerId(baseId, value);
    if (!selected && !forceMount) return null;

    return (
      <div
        {...props}
        ref={forwardedRef}
        id={contentId}
        role="tabpanel"
        aria-labelledby={ariaLabelledBy ?? triggerId}
        data-orientation={instance.state.orientation}
        data-state={selected ? "active" : "inactive"}
        hidden={selected ? hidden : true}
        tabIndex={tabIndex ?? 0}
      />
    );
  },
);
