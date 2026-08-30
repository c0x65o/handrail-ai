import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ForwardedRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import type {
  BrowserRealtimeVoiceController,
  BrowserRealtimeVoiceLocalMediaState,
  BrowserRealtimeVoiceState,
  BrowserRealtimeVoiceStatus,
} from "../browser/realtime-voice.js";
import type {
  RealtimeVoiceCapabilityDescriptor,
  RealtimeVoiceErrorCode,
  RealtimeVoiceSafeError,
  RealtimeVoiceUnsupportedReason,
} from "../realtime/types.js";
import type { PrimitiveRender } from "./primitives.js";

export type RealtimeVoiceControllerFactory = () => BrowserRealtimeVoiceController;

export interface ExternalRealtimeVoiceControlsOptions {
  /** Externally owned. React never disposes this controller. */
  readonly controller: BrowserRealtimeVoiceController;
  readonly createController?: never;
}

export interface OwnedRealtimeVoiceControlsOptions {
  /**
   * Called after mount, never during render or SSR. React disposes the created
   * controller after replacement or the final (including StrictMode) unmount.
   */
  readonly createController: RealtimeVoiceControllerFactory;
  readonly controller?: never;
}

export type UseRealtimeVoiceControlsOptions =
  | ExternalRealtimeVoiceControlsOptions
  | OwnedRealtimeVoiceControlsOptions;

export type RealtimeVoiceCapabilityName =
  | "input_audio"
  | "output_audio"
  | "interruption"
  | "server_tool_execution";

/** Safe negotiated capability metadata. Opaque server capability references are omitted. */
export interface RealtimeVoiceCapabilityModel {
  readonly name: RealtimeVoiceCapabilityName;
  readonly label: string;
  readonly supported: boolean;
  readonly unsupportedReason: RealtimeVoiceUnsupportedReason | null;
}

export interface RealtimeVoiceControlsController {
  readonly status: BrowserRealtimeVoiceStatus;
  readonly localMedia: BrowserRealtimeVoiceLocalMediaState;
  readonly remoteAudioActive: boolean;
  readonly responseActive: boolean;
  readonly error: RealtimeVoiceSafeError | null;
  readonly capabilities: readonly RealtimeVoiceCapabilityModel[];
  readonly controllerAvailable: boolean;
  readonly busy: boolean;
  readonly canStart: boolean;
  readonly canMute: boolean;
  readonly canUnmute: boolean;
  readonly canStopMicrophone: boolean;
  readonly canInterrupt: boolean;
  readonly canEndSession: boolean;
  readonly canCancel: boolean;
  start(): Promise<void>;
  mute(): Promise<void>;
  unmute(): Promise<void>;
  stopMicrophone(): Promise<void>;
  interrupt(): Promise<void>;
  endSession(): Promise<void>;
  cancel(): Promise<void>;
}

type RealtimeVoiceAction =
  | "start"
  | "mute"
  | "unmute"
  | "stopMicrophone"
  | "interrupt"
  | "endSession"
  | "cancel";

interface PendingOperation {
  readonly action: RealtimeVoiceAction;
  readonly controller: BrowserRealtimeVoiceController;
  readonly promise: Promise<void>;
}

interface OwnedControllerEntry {
  readonly factory: RealtimeVoiceControllerFactory;
  readonly controller: BrowserRealtimeVoiceController;
  mounts: number;
  cleanupGeneration: number;
  disposed: boolean;
}

interface OwnedControllerState {
  readonly factory: RealtimeVoiceControllerFactory;
  readonly controller: BrowserRealtimeVoiceController | null;
  readonly failed: boolean;
}

const CAPABILITY_LABELS: Readonly<Record<RealtimeVoiceCapabilityName, string>> =
  Object.freeze({
    input_audio: "Microphone input",
    output_audio: "Voice playback",
    interruption: "Interruption",
    server_tool_execution: "Server tools",
  });

const CAPABILITY_NAMES = Object.freeze([
  "input_audio",
  "output_audio",
  "interruption",
  "server_tool_execution",
] as const);

const EMPTY_CAPABILITIES: readonly RealtimeVoiceCapabilityModel[] = Object.freeze([]);

const INTERNAL_ERROR: RealtimeVoiceSafeError = Object.freeze({
  code: "internal_failure",
  message: "The realtime voice operation failed.",
  retryable: false,
});

function capabilityModels(
  state: BrowserRealtimeVoiceState | null,
): readonly RealtimeVoiceCapabilityModel[] {
  const capabilities = state?.capabilities;
  if (capabilities === null || capabilities === undefined) return EMPTY_CAPABILITIES;
  return Object.freeze(CAPABILITY_NAMES.map((name) => {
    const descriptor: RealtimeVoiceCapabilityDescriptor = capabilities[name];
    return Object.freeze({
      name,
      label: CAPABILITY_LABELS[name],
      supported: descriptor.supported,
      unsupportedReason: descriptor.supported ? null : descriptor.reason,
    });
  }));
}

function useOwnedController(
  factory: RealtimeVoiceControllerFactory | null,
): OwnedControllerState | null {
  const entryRef = useRef<OwnedControllerEntry | null>(null);
  const [state, setState] = useState<OwnedControllerState | null>(null);

  useEffect(() => {
    if (factory === null) return undefined;
    let entry = entryRef.current;
    if (entry === null || entry.factory !== factory || entry.disposed) {
      try {
        entry = {
          factory,
          controller: factory(),
          mounts: 0,
          cleanupGeneration: 0,
          disposed: false,
        };
        entryRef.current = entry;
      } catch {
        setState({ factory, controller: null, failed: true });
        return undefined;
      }
    }
    entry.mounts += 1;
    entry.cleanupGeneration += 1;
    setState({ factory, controller: entry.controller, failed: false });

    return () => {
      entry.mounts -= 1;
      const cleanupGeneration = ++entry.cleanupGeneration;
      queueMicrotask(() => {
        if (
          entry.disposed ||
          entry.mounts !== 0 ||
          entry.cleanupGeneration !== cleanupGeneration
        ) return;
        entry.disposed = true;
        if (entryRef.current === entry) entryRef.current = null;
        void entry.controller.dispose().catch(() => undefined);
      });
    };
  }, [factory]);

  return state?.factory === factory ? state : null;
}

/**
 * Subscribes React to one provider-neutral browser controller. All connection
 * operations remain explicit action callbacks initiated by the host's controls.
 */
export function useRealtimeVoiceControls(
  options: UseRealtimeVoiceControlsOptions,
): RealtimeVoiceControlsController {
  const hasExternal = "controller" in options && options.controller !== undefined;
  const hasFactory = "createController" in options && options.createController !== undefined;
  if (hasExternal === hasFactory) {
    throw new TypeError("Provide exactly one realtime voice controller or controller factory.");
  }

  const factory = hasFactory ? options.createController : null;
  const owned = useOwnedController(factory);
  const controller = hasExternal
    ? options.controller
    : owned?.controller ?? null;
  const creationFailed = hasFactory && owned?.failed === true;

  const subscribe = useCallback((notify: () => void) => {
    if (controller === null) return () => undefined;
    return controller.subscribe(() => notify());
  }, [controller]);
  const getSnapshot = useCallback(
    () => controller?.getState() ?? null,
    [controller],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const mounted = useRef(false);
  const controllerRef = useRef<BrowserRealtimeVoiceController | null>(controller);
  const generation = useRef(0);
  const operations = useRef(new Map<RealtimeVoiceAction, PendingOperation>());
  const [pending, setPending] = useState<readonly PendingOperation[]>([]);
  if (controllerRef.current !== controller) {
    controllerRef.current = controller;
    generation.current += 1;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      operations.current.clear();
    };
  }, []);

  useEffect(() => {
    operations.current.clear();
    setPending([]);
  }, [controller]);

  const run = useCallback((
    action: RealtimeVoiceAction,
    invoke: (active: BrowserRealtimeVoiceController) =>
      | BrowserRealtimeVoiceState
      | Promise<BrowserRealtimeVoiceState>,
  ): Promise<void> => {
    const active = controllerRef.current;
    if (active === null) return Promise.resolve();
    const existing = operations.current.get(action);
    if (existing?.controller === active) return existing.promise;
    const expectedGeneration = generation.current;
    let result: BrowserRealtimeVoiceState | Promise<BrowserRealtimeVoiceState>;
    try {
      // Keep start() in the native activation call stack for browser permission APIs.
      result = invoke(active);
    } catch {
      return Promise.resolve();
    }
    const operation: PendingOperation = {
      action,
      controller: active,
      promise: Promise.resolve(result).then(() => undefined, () => undefined),
    };
    operations.current.set(action, operation);
    if (mounted.current && controllerRef.current === active) {
      setPending([...operations.current.values()]);
    }
    void operation.promise.finally(() => {
      if (operations.current.get(action) === operation) operations.current.delete(action);
      if (
        mounted.current &&
        controllerRef.current === active &&
        generation.current === expectedGeneration
      ) setPending([...operations.current.values()]);
    });
    return operation.promise;
  }, []);

  const start = useCallback(() => run("start", (active) => active.start()), [run]);
  const mute = useCallback(() => run("mute", (active) => active.mute()), [run]);
  const unmute = useCallback(() => run("unmute", (active) => active.unmute()), [run]);
  const stopMicrophone = useCallback(
    () => run("stopMicrophone", (active) => active.stopLocalMedia()),
    [run],
  );
  const interrupt = useCallback(
    () => run("interrupt", (active) => active.interrupt()),
    [run],
  );
  const endSession = useCallback(
    () => run("endSession", (active) => active.hangup()),
    [run],
  );
  const cancel = useCallback(() => run("cancel", (active) => active.cancel()), [run]);

  const status = state?.status ?? (creationFailed ? "failed" : "idle");
  const localMedia = state?.local_media ?? "inactive";
  const pendingForController = pending.filter((item) => item.controller === controller);
  const pendingActions = new Set(pendingForController.map((item) => item.action));
  const active = status === "active";
  const terminal = status === "ended" || status === "failed" ||
    status === "cancelled" || status === "disposed";
  const capabilities = useMemo(() => capabilityModels(state), [state?.capabilities]);

  return {
    status,
    localMedia,
    remoteAudioActive: state?.remote_audio_active ?? false,
    responseActive: state?.response_active ?? false,
    error: state?.error ?? (creationFailed ? INTERNAL_ERROR : null),
    capabilities,
    controllerAvailable: controller !== null,
    busy: status === "starting" || status === "ending" || pendingForController.length > 0,
    canStart: controller !== null && status === "idle" && !pendingActions.has("start"),
    canMute: active && localMedia === "active" && !pendingActions.has("mute"),
    canUnmute: active && localMedia === "muted" && !pendingActions.has("unmute"),
    canStopMicrophone: active && (localMedia === "active" || localMedia === "muted") &&
      !pendingActions.has("stopMicrophone"),
    canInterrupt: active && state?.response_active === true &&
      state.capabilities?.interruption.supported === true &&
      !pendingActions.has("interrupt"),
    canEndSession: controller !== null && !terminal && status !== "idle" && status !== "ending" &&
      !pendingActions.has("endSession"),
    canCancel: controller !== null && status === "starting" && !pendingActions.has("cancel"),
    start,
    mute,
    unmute,
    stopMicrophone,
    interrupt,
    endSession,
    cancel,
  };
}

export interface RealtimeVoiceControlsContextValue {
  readonly controller: RealtimeVoiceControlsController;
  readonly recordActivation: (element: HTMLButtonElement) => void;
}

export const RealtimeVoiceControlsContext =
  createContext<RealtimeVoiceControlsContextValue | null>(null);
RealtimeVoiceControlsContext.displayName = "RealtimeVoiceControlsContext";

export function useRealtimeVoiceControlsContext(): RealtimeVoiceControlsController {
  const context = useContext(RealtimeVoiceControlsContext);
  if (context === null) throw new TypeError("A RealtimeVoiceControlsRoot is required.");
  return context.controller;
}

function useResolvedController(
  explicit?: RealtimeVoiceControlsController,
): RealtimeVoiceControlsController {
  const context = useContext(RealtimeVoiceControlsContext);
  const controller = explicit ?? context?.controller;
  if (controller === undefined) {
    throw new TypeError("A realtime voice controls controller is required.");
  }
  return controller;
}

export interface RealtimeVoiceControlsRootNativeProps extends HTMLAttributes<HTMLDivElement> {
  "data-realtime-voice-status"?: BrowserRealtimeVoiceStatus;
}

export interface RealtimeVoiceControlsRootProps
  extends Omit<RealtimeVoiceControlsRootNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly controller: RealtimeVoiceControlsController;
  readonly render?: PrimitiveRender<HTMLDivElement, RealtimeVoiceControlsRootNativeProps>;
}

function isTerminalStatus(status: BrowserRealtimeVoiceStatus): boolean {
  return status === "ended" || status === "failed" ||
    status === "cancelled" || status === "disposed";
}

export const RealtimeVoiceControlsRoot = forwardRef<
  HTMLDivElement,
  RealtimeVoiceControlsRootProps
>(function RealtimeVoiceControlsRoot(
  { children, controller, render, ...props },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastActivation = useRef<HTMLButtonElement | null>(null);
  const previousStatus = useRef(controller.status);
  const recordActivation = useCallback((element: HTMLButtonElement) => {
    lastActivation.current = element;
  }, []);
  const context = useMemo<RealtimeVoiceControlsContextValue>(() => ({
    controller,
    recordActivation,
  }), [controller, recordActivation]);

  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = controller.status;
    if (isTerminalStatus(previous) || !isTerminalStatus(controller.status)) return;
    const activated = lastActivation.current;
    if (activated === null) return;
    const unavailable = !activated.isConnected || activated.disabled;
    if (unavailable || document.activeElement === activated) rootRef.current?.focus();
    lastActivation.current = null;
  }, [controller.status]);

  const setRootRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef !== null) forwardedRef.current = node;
  }, [forwardedRef]);
  const nativeProps: RealtimeVoiceControlsRootNativeProps = {
    ...props,
    children: children ?? <>
      <RealtimeVoiceControlsStatus />
      <RealtimeVoiceCapabilities />
      <RealtimeVoiceStart />
      <RealtimeVoiceMute />
      <RealtimeVoiceUnmute />
      <RealtimeVoiceStopMicrophone />
      <RealtimeVoiceInterrupt />
      <RealtimeVoiceEndSession />
      <RealtimeVoiceCancel />
    </>,
    tabIndex: props.tabIndex ?? -1,
    "aria-busy": props["aria-busy"] ?? controller.busy,
    "data-realtime-voice-status": controller.status,
  };
  return (
    <RealtimeVoiceControlsContext.Provider value={context}>
      {render ? render(nativeProps, setRootRef) : <div {...nativeProps} ref={setRootRef} />}
    </RealtimeVoiceControlsContext.Provider>
  );
});

const STATUS_MESSAGES: Readonly<Record<BrowserRealtimeVoiceStatus, string>> = Object.freeze({
  idle: "Ready to start voice session",
  starting: "Starting voice session",
  active: "Voice session active",
  ending: "Ending voice session",
  ended: "Voice session ended",
  failed: "Voice session failed",
  cancelled: "Voice session cancelled",
  disposed: "Voice controls unavailable",
});

const ERROR_MESSAGES: Readonly<Record<RealtimeVoiceErrorCode, string>> = Object.freeze({
  invalid_request: "The voice request is invalid",
  invalid_state: "The voice action is unavailable",
  unsupported_capability: "A requested voice capability is unavailable",
  authorization_expired: "Voice authorization expired",
  idempotency_conflict: "The voice request conflicts with an existing request",
  cancelled: "Voice session cancelled",
  deadline_exceeded: "The voice request timed out",
  temporarily_unavailable: "Voice is temporarily unavailable",
  internal_failure: "Voice session failed",
});

export interface RealtimeVoiceControlsStatusNativeProps
  extends HTMLAttributes<HTMLParagraphElement> {
  "data-realtime-voice-status"?: BrowserRealtimeVoiceStatus;
}

export interface RealtimeVoiceControlsStatusProps
  extends Omit<RealtimeVoiceControlsStatusNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly controller?: RealtimeVoiceControlsController;
  readonly render?: PrimitiveRender<
    HTMLParagraphElement,
    RealtimeVoiceControlsStatusNativeProps
  >;
}

export const RealtimeVoiceControlsStatus = forwardRef<
  HTMLParagraphElement,
  RealtimeVoiceControlsStatusProps
>(function RealtimeVoiceControlsStatus(
  { children, controller: explicit, render, ...props },
  forwardedRef,
) {
  const controller = useResolvedController(explicit);
  const message = controller.status === "failed" && controller.error !== null
    ? ERROR_MESSAGES[controller.error.code]
    : STATUS_MESSAGES[controller.status];
  const nativeProps: RealtimeVoiceControlsStatusNativeProps = {
    ...props,
    children: children ?? message,
    role: props.role ?? "status",
    "aria-live": props["aria-live"] ?? "polite",
    "aria-atomic": props["aria-atomic"] ?? true,
    "aria-label": props["aria-label"] ?? `Voice status: ${message}`,
    "data-realtime-voice-status": controller.status,
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <p {...nativeProps} ref={forwardedRef} />;
});

const REASON_LABELS: Readonly<Record<RealtimeVoiceUnsupportedReason, string>> = Object.freeze({
  not_requested: "not requested",
  provider_not_supported: "not supported",
  transport_not_supported: "transport not supported",
  audio_format_not_supported: "audio format not supported",
  policy_denied: "not allowed",
  server_tools_not_configured: "not configured",
});

export interface RealtimeVoiceCapabilitiesNativeProps
  extends HTMLAttributes<HTMLUListElement> {
  "data-realtime-voice-capabilities"?: "pending" | "negotiated";
}

export interface RealtimeVoiceCapabilitiesProps
  extends Omit<RealtimeVoiceCapabilitiesNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly controller?: RealtimeVoiceControlsController;
  readonly renderCapability?: (
    capability: RealtimeVoiceCapabilityModel,
    index: number,
  ) => ReactNode;
  readonly render?: PrimitiveRender<
    HTMLUListElement,
    RealtimeVoiceCapabilitiesNativeProps
  >;
}

export const RealtimeVoiceCapabilities = forwardRef<
  HTMLUListElement,
  RealtimeVoiceCapabilitiesProps
>(function RealtimeVoiceCapabilities(
  { children, controller: explicit, render, renderCapability, ...props },
  forwardedRef,
) {
  const controller = useResolvedController(explicit);
  const content = children ?? controller.capabilities.map((capability, index) =>
    renderCapability?.(capability, index) ?? (
      <li key={capability.name} data-realtime-voice-capability={capability.name}>
        {capability.label}: {capability.supported
          ? "supported"
          : `unsupported (${REASON_LABELS[capability.unsupportedReason!]})`}
      </li>
    ));
  const nativeProps: RealtimeVoiceCapabilitiesNativeProps = {
    ...props,
    children: content,
    "aria-label": props["aria-label"] ?? "Voice capabilities",
    "data-realtime-voice-capabilities": controller.capabilities.length === 0
      ? "pending"
      : "negotiated",
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <ul {...nativeProps} ref={forwardedRef} />;
});

export interface RealtimeVoiceActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly controller?: RealtimeVoiceControlsController;
  readonly render?: PrimitiveRender<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement>
  >;
}

function actionButton(
  action: RealtimeVoiceAction,
  props: RealtimeVoiceActionProps,
  forwardedRef: ForwardedRef<HTMLButtonElement>,
): ReactNode {
  const { children, controller: explicit, onClick, render, ...rest } = props;
  const context = useContext(RealtimeVoiceControlsContext);
  const controller = explicit ?? context?.controller;
  if (controller === undefined) {
    throw new TypeError("A realtime voice controls controller is required.");
  }
  const config = {
    start: { label: "Start voice session", enabled: controller.canStart, activate: controller.start },
    mute: { label: "Mute microphone", enabled: controller.canMute, activate: controller.mute },
    unmute: { label: "Unmute microphone", enabled: controller.canUnmute, activate: controller.unmute },
    stopMicrophone: {
      label: "Stop microphone",
      enabled: controller.canStopMicrophone,
      activate: controller.stopMicrophone,
    },
    interrupt: {
      label: "Interrupt voice response",
      enabled: controller.canInterrupt,
      activate: controller.interrupt,
    },
    endSession: {
      label: "End voice session",
      enabled: controller.canEndSession,
      activate: controller.endSession,
    },
    cancel: {
      label: "Cancel voice start",
      enabled: controller.canCancel,
      activate: controller.cancel,
    },
  }[action];
  const nativeProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    ...rest,
    type: rest.type ?? "button",
    children: children ?? config.label,
    "aria-label": rest["aria-label"] ?? config.label,
    disabled: rest.disabled ?? !config.enabled,
    onClick: (event) => {
      onClick?.(event);
      if (event.defaultPrevented || !config.enabled) return;
      context?.recordActivation(event.currentTarget);
      void config.activate();
    },
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <button {...nativeProps} ref={forwardedRef} />;
}

export type RealtimeVoiceStartProps = RealtimeVoiceActionProps;
export const RealtimeVoiceStart = forwardRef<HTMLButtonElement, RealtimeVoiceStartProps>(
  function RealtimeVoiceStart(props, ref) { return actionButton("start", props, ref); },
);
export type RealtimeVoiceMuteProps = RealtimeVoiceActionProps;
export const RealtimeVoiceMute = forwardRef<HTMLButtonElement, RealtimeVoiceMuteProps>(
  function RealtimeVoiceMute(props, ref) { return actionButton("mute", props, ref); },
);
export type RealtimeVoiceUnmuteProps = RealtimeVoiceActionProps;
export const RealtimeVoiceUnmute = forwardRef<HTMLButtonElement, RealtimeVoiceUnmuteProps>(
  function RealtimeVoiceUnmute(props, ref) { return actionButton("unmute", props, ref); },
);
export type RealtimeVoiceStopMicrophoneProps = RealtimeVoiceActionProps;
export const RealtimeVoiceStopMicrophone = forwardRef<
  HTMLButtonElement,
  RealtimeVoiceStopMicrophoneProps
>(function RealtimeVoiceStopMicrophone(props, ref) {
  return actionButton("stopMicrophone", props, ref);
});
export type RealtimeVoiceInterruptProps = RealtimeVoiceActionProps;
export const RealtimeVoiceInterrupt = forwardRef<HTMLButtonElement, RealtimeVoiceInterruptProps>(
  function RealtimeVoiceInterrupt(props, ref) { return actionButton("interrupt", props, ref); },
);
export type RealtimeVoiceEndSessionProps = RealtimeVoiceActionProps;
export const RealtimeVoiceEndSession = forwardRef<HTMLButtonElement, RealtimeVoiceEndSessionProps>(
  function RealtimeVoiceEndSession(props, ref) { return actionButton("endSession", props, ref); },
);
export type RealtimeVoiceCancelProps = RealtimeVoiceActionProps;
export const RealtimeVoiceCancel = forwardRef<HTMLButtonElement, RealtimeVoiceCancelProps>(
  function RealtimeVoiceCancel(props, ref) { return actionButton("cancel", props, ref); },
);
