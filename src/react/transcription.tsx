import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ForwardedRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";

import {
  BrowserAudioCaptureError,
  type BrowserAudioCaptureController,
  type BrowserAudioCaptureErrorCode,
  type BrowserAudioCaptureResult,
} from "../browser/audio.js";
import {
  executeTranscription,
  normalizeTranscriptionError,
  parseTranscriptionAudioReference,
  parseTranscriptionRequest,
  parseTranscriptionResult,
  transcriptionSafeError,
  type TranscriptionAudioReference,
  type TranscriptionCapability,
  type TranscriptionErrorCode,
  type TranscriptionIdempotencyKey,
  type TranscriptionLanguage,
  type TranscriptionRequest,
  type TranscriptionRequestId,
  type TranscriptionResult,
  type TranscriptionSafeError,
} from "../transcription.js";
import type { PrimitiveRender } from "./primitives.js";

export type TranscriptionControlsStatus =
  | "idle"
  | "requesting"
  | "recording"
  | "stopping"
  | "uploading"
  | "transcribing"
  | "success"
  | "error"
  | "cancelled";

export type TranscriptionControlsErrorStage =
  | "capture"
  | "upload"
  | "transcription"
  | "apply";

/** Fixed public metadata only. Host errors, audio, and transcript text are omitted. */
export interface TranscriptionControlsError {
  readonly stage: TranscriptionControlsErrorStage;
  readonly code: BrowserAudioCaptureErrorCode | TranscriptionErrorCode | "apply_failed";
  readonly message: string;
  readonly retryable: boolean;
}

export interface TranscriptionCaptureFactoryInput {
  /** Supply this to BrowserAudioCaptureOptions.onResult for bounded automatic stops. */
  readonly onResult: (result: BrowserAudioCaptureResult) => void;
}

export type TranscriptionCaptureFactory = (
  input: TranscriptionCaptureFactoryInput,
) => BrowserAudioCaptureController;

export interface TranscriptionUploadInput {
  readonly capture: BrowserAudioCaptureResult;
  readonly conversationId: string;
  readonly signal: AbortSignal;
}

/** The host takes ownership of the Blob and returns durable, opaque metadata. */
export type TranscriptionUpload = (
  input: TranscriptionUploadInput,
) => Promise<TranscriptionAudioReference>;

export interface TranscriptionRequestIdentityInput {
  readonly audio: TranscriptionAudioReference;
  readonly conversationId: string;
}

export interface TranscriptionRequestIdentity {
  readonly requestId: TranscriptionRequestId;
  readonly idempotencyKey: TranscriptionIdempotencyKey;
}

export type TranscriptionRequestIdentityFactory = (
  input: TranscriptionRequestIdentityInput,
) => TranscriptionRequestIdentity;

/** A provider-neutral trusted-host callback alternative to TranscriptionCapability. */
export type TranscriptionInvoker = (
  request: TranscriptionRequest,
) => Promise<TranscriptionResult>;

export interface UseTranscriptionControlsOptions {
  /** Changing this identity aborts and disposes all work for the previous conversation. */
  readonly conversationId: string;
  /** Called only by start(), never during render or automatically after mount. */
  readonly createCaptureController: TranscriptionCaptureFactory;
  readonly uploadAudio: TranscriptionUpload;
  readonly createRequestIdentity: TranscriptionRequestIdentityFactory;
  /** Exactly one capability or neutral callback must be supplied. */
  readonly capability?: TranscriptionCapability;
  /** Exactly one capability or neutral callback must be supplied. */
  readonly transcribe?: TranscriptionInvoker;
  readonly language?: TranscriptionLanguage;
  /** The host owns replacement/merge policy and receives text only after current success. */
  readonly applyTranscript: (text: string) => void | Promise<void>;
}

export interface TranscriptionControlsController {
  readonly status: TranscriptionControlsStatus;
  readonly error: TranscriptionControlsError | null;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  readonly busy: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  retry(): Promise<void>;
}

interface DurableAttempt {
  readonly audio: TranscriptionAudioReference;
  readonly identity: TranscriptionRequestIdentity;
}

interface OwnedCapture {
  readonly controller: BrowserAudioCaptureController;
  readonly unsubscribe: () => void;
}

const APPLY_ERROR: TranscriptionControlsError = Object.freeze({
  stage: "apply",
  code: "apply_failed",
  message: "The transcript could not be applied.",
  retryable: false,
});

const BUSY_STATUSES = new Set<TranscriptionControlsStatus>([
  "requesting",
  "stopping",
  "uploading",
  "transcribing",
]);
const STOPPABLE_STATUSES = new Set<TranscriptionControlsStatus>([
  "requesting",
  "recording",
]);
const CANCELLABLE_STATUSES = new Set<TranscriptionControlsStatus>([
  "requesting",
  "recording",
  "stopping",
  "uploading",
  "transcribing",
]);

function captureError(error: unknown): TranscriptionControlsError {
  const code = error instanceof BrowserAudioCaptureError
    ? error.code
    : "recorder_failed";
  const normalized = error instanceof BrowserAudioCaptureError
    ? error
    : new BrowserAudioCaptureError(code);
  return Object.freeze({
    stage: "capture",
    code,
    message: normalized.message,
    retryable: false,
  });
}

function safeOperationError(
  stage: "upload" | "transcription",
  error: TranscriptionSafeError,
  retryable = error.retryable,
): TranscriptionControlsError {
  return Object.freeze({
    stage,
    code: error.code,
    message: error.message,
    retryable,
  });
}

function isCurrent(
  mounted: { readonly current: boolean },
  generation: { readonly current: number },
  expected: number,
  signal?: AbortSignal,
): boolean {
  return mounted.current && generation.current === expected && !signal?.aborted;
}

/** Coordinates explicit browser capture, host upload, and trusted transcription. */
export function useTranscriptionControls(
  options: UseTranscriptionControlsOptions,
): TranscriptionControlsController {
  if ((options.capability === undefined) === (options.transcribe === undefined)) {
    throw new TypeError("Provide exactly one transcription capability or callback.");
  }
  const [status, setStatus] = useState<TranscriptionControlsStatus>("idle");
  const [error, setError] = useState<TranscriptionControlsError | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const statusRef = useRef(status);
  const optionsRef = useRef(options);
  const capture = useRef<OwnedCapture | null>(null);
  const operation = useRef<AbortController | null>(null);
  const durableAttempt = useRef<DurableAttempt | null>(null);
  const captureHandled = useRef(false);
  const startPromise = useRef<Promise<void> | null>(null);
  const stopPromise = useRef<Promise<void> | null>(null);
  const transcriptionPromise = useRef<Promise<void> | null>(null);
  optionsRef.current = options;
  statusRef.current = status;

  const publish = useCallback((
    next: TranscriptionControlsStatus,
    nextError: TranscriptionControlsError | null = null,
  ) => {
    if (!mounted.current) return;
    statusRef.current = next;
    setStatus(next);
    setError(nextError);
  }, []);

  const releaseCapture = useCallback(async (cancelFirst: boolean): Promise<void> => {
    const owned = capture.current;
    if (owned === null) return;
    capture.current = null;
    owned.unsubscribe();
    if (cancelFirst) await owned.controller.cancel().catch(() => undefined);
    await owned.controller.dispose().catch(() => undefined);
  }, []);

  const runTranscription = useCallback((
    attempt: DurableAttempt,
    expectedGeneration: number,
  ): Promise<void> => {
    if (transcriptionPromise.current !== null) return transcriptionPromise.current;
    const run = (async () => {
      if (!isCurrent(mounted, generation, expectedGeneration)) return;
      const requestOptions = optionsRef.current;
      const controller = new AbortController();
      operation.current?.abort();
      operation.current = controller;
      publish("transcribing");

      let request: TranscriptionRequest;
      try {
        request = parseTranscriptionRequest({
          request_id: attempt.identity.requestId,
          inputs: [attempt.audio],
          idempotency_key: attempt.identity.idempotencyKey,
          signal: controller.signal,
          ...(requestOptions.language === undefined
            ? {}
            : { language: requestOptions.language }),
        });
      } catch {
        if (isCurrent(mounted, generation, expectedGeneration, controller.signal)) {
          publish("error", safeOperationError(
            "transcription",
            transcriptionSafeError("invalid_request"),
          ));
        }
        return;
      }

      let result: TranscriptionResult | null = null;
      let failure: TranscriptionSafeError | null = null;
      if (requestOptions.capability !== undefined) {
        const outcome = await executeTranscription(requestOptions.capability, request);
        if (outcome.ok) result = outcome.result;
        else failure = outcome.error;
      } else {
        try {
          const returned = await requestOptions.transcribe!(request);
          result = parseTranscriptionResult(returned, request);
        } catch (caught) {
          failure = normalizeTranscriptionError(caught, controller.signal);
        }
      }
      if (!isCurrent(mounted, generation, expectedGeneration, controller.signal)) return;
      if (failure !== null) {
        if (failure.cancelled) publish("cancelled");
        else publish("error", safeOperationError("transcription", failure));
        return;
      }

      const text = result?.outputs[0]?.text;
      if (text === undefined) {
        publish("error", safeOperationError(
          "transcription",
          transcriptionSafeError("internal_failure"),
        ));
        return;
      }
      try {
        await requestOptions.applyTranscript(text);
      } catch {
        if (isCurrent(mounted, generation, expectedGeneration, controller.signal)) {
          publish("error", APPLY_ERROR);
        }
        return;
      }
      if (isCurrent(mounted, generation, expectedGeneration, controller.signal)) {
        durableAttempt.current = null;
        publish("success");
      }
    })().finally(() => {
      if (transcriptionPromise.current === run) transcriptionPromise.current = null;
    });
    transcriptionPromise.current = run;
    return run;
  }, [publish]);

  const acceptCaptureResult = useCallback((
    result: BrowserAudioCaptureResult,
    expectedGeneration: number,
  ): Promise<void> => {
    if (captureHandled.current || !isCurrent(mounted, generation, expectedGeneration)) {
      result.objectUrl?.revoke();
      return Promise.resolve();
    }
    captureHandled.current = true;
    const run = (async () => {
      const requestOptions = optionsRef.current;
      const controller = new AbortController();
      operation.current?.abort();
      operation.current = controller;
      publish("uploading");
      let audio: TranscriptionAudioReference;
      try {
        const uploaded = await requestOptions.uploadAudio({
          capture: result,
          conversationId: requestOptions.conversationId,
          signal: controller.signal,
        });
        audio = parseTranscriptionAudioReference(uploaded);
      } catch (caught) {
        result.objectUrl?.revoke();
        await releaseCapture(false);
        if (isCurrent(mounted, generation, expectedGeneration, controller.signal)) {
          const normalized = normalizeTranscriptionError(caught, controller.signal);
          if (normalized.cancelled) publish("cancelled");
          else {
            // A failed upload has not produced a durable reference to retry safely.
            publish("error", safeOperationError("upload", normalized, false));
          }
        }
        return;
      }
      result.objectUrl?.revoke();
      await releaseCapture(false);
      if (!isCurrent(mounted, generation, expectedGeneration, controller.signal)) return;

      let identity: TranscriptionRequestIdentity;
      try {
        identity = requestOptions.createRequestIdentity({
          audio,
          conversationId: requestOptions.conversationId,
        });
      } catch {
        publish("error", safeOperationError(
          "transcription",
          transcriptionSafeError("invalid_request"),
        ));
        return;
      }
      const attempt = Object.freeze({ audio, identity });
      durableAttempt.current = attempt;
      await runTranscription(attempt, expectedGeneration);
    })();
    return run;
  }, [publish, releaseCapture, runTranscription]);

  const start = useCallback((): Promise<void> => {
    if (startPromise.current !== null) return startPromise.current;
    if (!["idle", "success", "error", "cancelled"].includes(statusRef.current)) {
      return Promise.resolve();
    }
    const expectedGeneration = ++generation.current;
    captureHandled.current = false;
    durableAttempt.current = null;
    operation.current?.abort();
    operation.current = null;
    publish("requesting");
    const run = (async () => {
      let controller: BrowserAudioCaptureController;
      try {
        controller = optionsRef.current.createCaptureController({
          onResult: (result) => {
            void acceptCaptureResult(result, expectedGeneration);
          },
        });
      } catch (caught) {
        if (isCurrent(mounted, generation, expectedGeneration)) {
          publish("error", captureError(caught));
        }
        return;
      }
      let unsubscribe: () => void;
      try {
        unsubscribe = controller.subscribe((captureState) => {
          if (!isCurrent(mounted, generation, expectedGeneration)) return;
          if (captureState.status === "requesting") {
            publish(stopPromise.current === null ? "requesting" : "stopping");
          } else if (captureState.status === "recording") {
            publish(stopPromise.current === null ? "recording" : "stopping");
          } else if (captureState.status === "failed") {
            if (captureState.error.code === "cancelled" ||
              captureState.error.code === "disposed") {
              publish("cancelled");
            } else {
              publish("error", captureError(
                new BrowserAudioCaptureError(captureState.error.code),
              ));
            }
            void releaseCapture(false);
          }
        });
      } catch (caught) {
        await controller.dispose().catch(() => undefined);
        if (isCurrent(mounted, generation, expectedGeneration)) {
          publish("error", captureError(caught));
        }
        return;
      }
      capture.current = { controller, unsubscribe };
      try {
        await controller.start();
      } catch (caught) {
        if (isCurrent(mounted, generation, expectedGeneration)) {
          if (statusRef.current !== "error" && statusRef.current !== "cancelled") {
            publish("error", captureError(caught));
          }
          await releaseCapture(false);
        }
      }
    })().finally(() => {
      if (startPromise.current === run) startPromise.current = null;
    });
    startPromise.current = run;
    return run;
  }, [acceptCaptureResult, publish, releaseCapture]);

  const stop = useCallback((): Promise<void> => {
    if (stopPromise.current !== null) return stopPromise.current;
    if (!STOPPABLE_STATUSES.has(statusRef.current) || capture.current === null) {
      return Promise.resolve();
    }
    const expectedGeneration = generation.current;
    publish("stopping");
    const owned = capture.current;
    const run = (async () => {
      try {
        const result = await owned.controller.stop();
        if (result !== null) await acceptCaptureResult(result, expectedGeneration);
      } catch (caught) {
        if (isCurrent(mounted, generation, expectedGeneration) &&
          statusRef.current !== "error" && statusRef.current !== "cancelled") {
          publish("error", captureError(caught));
        }
      }
    })().finally(() => {
      if (stopPromise.current === run) stopPromise.current = null;
    });
    stopPromise.current = run;
    return run;
  }, [acceptCaptureResult, publish]);

  const cancel = useCallback(async (): Promise<void> => {
    if (!CANCELLABLE_STATUSES.has(statusRef.current)) return;
    generation.current += 1;
    operation.current?.abort();
    operation.current = null;
    startPromise.current = null;
    stopPromise.current = null;
    transcriptionPromise.current = null;
    durableAttempt.current = null;
    captureHandled.current = true;
    publish("cancelled");
    await releaseCapture(true);
  }, [publish, releaseCapture]);

  const retry = useCallback((): Promise<void> => {
    const attempt = durableAttempt.current;
    if (statusRef.current !== "error" || error === null || !error.retryable ||
      attempt === null || transcriptionPromise.current !== null) {
      return Promise.resolve();
    }
    const expectedGeneration = ++generation.current;
    operation.current?.abort();
    operation.current = null;
    return runTranscription(attempt, expectedGeneration);
  }, [error, runTranscription]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    operation.current?.abort();
    operation.current = null;
    startPromise.current = null;
    stopPromise.current = null;
    transcriptionPromise.current = null;
    durableAttempt.current = null;
    captureHandled.current = false;
    publish("idle");
    return () => {
      mounted.current = false;
      generation.current += 1;
      operation.current?.abort();
      operation.current = null;
      startPromise.current = null;
      stopPromise.current = null;
      transcriptionPromise.current = null;
      durableAttempt.current = null;
      captureHandled.current = true;
      void releaseCapture(true);
    };
  }, [options.conversationId, publish, releaseCapture]);

  const canStart = ["idle", "success", "error", "cancelled"].includes(status);
  const canStop = STOPPABLE_STATUSES.has(status);
  const canCancel = CANCELLABLE_STATUSES.has(status);
  const canRetry = status === "error" && error?.retryable === true &&
    durableAttempt.current !== null;
  return {
    status,
    error,
    canStart,
    canStop,
    canCancel,
    canRetry,
    busy: BUSY_STATUSES.has(status),
    start,
    stop,
    cancel,
    retry,
  };
}

export interface CapturedAudioTranscriptionInput {
  readonly capture: BrowserAudioCaptureResult;
  readonly conversationId: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface UseCapturedAudioTranscriptionOptions {
  readonly conversationId: string;
  readonly createCaptureController: TranscriptionCaptureFactory;
  /** Authenticated host request that accepts the recording directly. */
  readonly transcribeCapturedAudio: (input: CapturedAudioTranscriptionInput) => Promise<string>;
  readonly applyTranscript: (text: string) => void | Promise<void>;
}

/**
 * Direct-recording alternative to durable upload + transcription. Reuses the
 * shared capture/cancellation controller. At most one bounded recording remains
 * in browser memory for retry; local metadata is never a server content URL.
 * Reload, conversation switch, cancellation, success and unmount release it.
 */
export function useCapturedAudioTranscription(
  options: UseCapturedAudioTranscriptionOptions,
): TranscriptionControlsController {
  const retained = useRef<{ id: string; conversationId: string; capture: BrowserAudioCaptureResult } | null>(null);
  const controller = useTranscriptionControls({
    conversationId: options.conversationId,
    createCaptureController: options.createCaptureController,
    applyTranscript: options.applyTranscript,
    uploadAudio: async ({ capture, conversationId }) => {
      const id = `captured-${globalThis.crypto.randomUUID()}`;
      retained.current = { id, conversationId, capture };
      // Private metadata lets the existing controller retain one stable attempt.
      // The binary is sent only by transcribeCapturedAudio, never uploaded here.
      return parseTranscriptionAudioReference({ audio_id: id, content_ref: id,
        format: capture.format, byte_size: capture.byteSize, duration_seconds: capture.durationSeconds });
    },
    createRequestIdentity: ({ audio }) => ({ requestId: `request-${audio.audio_id}` as TranscriptionRequestId,
      idempotencyKey: `transcribe-${audio.audio_id}` as TranscriptionIdempotencyKey }),
    transcribe: async (request) => {
      const source = retained.current;
      if (source === null || source.conversationId !== options.conversationId ||
        request.inputs[0]?.content_ref !== source.id) throw new Error("Recorded audio is no longer available.");
      const text = await options.transcribeCapturedAudio({ capture: source.capture,
        conversationId: source.conversationId, requestId: request.request_id,
        idempotencyKey: request.idempotency_key, signal: request.signal });
      return parseTranscriptionResult({ status: "completed", request_id: request.request_id,
        outputs: [{ audio_id: request.inputs[0]!.audio_id, text,
          metadata: { language: null, duration_seconds: source.capture.durationSeconds } }] }, request);
    },
  });
  useEffect(() => () => { retained.current = null; }, [options.conversationId]);
  useEffect(() => {
    if (controller.status === "success" || controller.status === "cancelled") retained.current = null;
  }, [controller.status]);
  return controller;
}

const TranscriptionControlsContext =
  createContext<TranscriptionControlsController | null>(null);

function useController(
  explicit?: TranscriptionControlsController,
): TranscriptionControlsController {
  const context = useContext(TranscriptionControlsContext);
  const controller = explicit ?? context;
  if (controller === null) {
    throw new TypeError("A TranscriptionControls controller is required.");
  }
  return controller;
}

export interface TranscriptionControlsRootNativeProps
  extends HTMLAttributes<HTMLDivElement> {
  "data-transcription-status"?: TranscriptionControlsStatus;
}

export interface TranscriptionControlsRootProps
  extends Omit<TranscriptionControlsRootNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly controller: TranscriptionControlsController;
  readonly render?: PrimitiveRender<HTMLDivElement, TranscriptionControlsRootNativeProps>;
}

export const TranscriptionControlsRoot = forwardRef<
  HTMLDivElement,
  TranscriptionControlsRootProps
>(function TranscriptionControlsRoot(
  { children, controller, render, ...props },
  forwardedRef,
) {
  const nativeProps: TranscriptionControlsRootNativeProps = {
    ...props,
    children: children ?? <>
      <TranscriptionControlsStatus />
      <TranscriptionControlsStart />
      <TranscriptionControlsStop />
      <TranscriptionControlsCancel />
      <TranscriptionControlsRetry />
    </>,
    "aria-busy": props["aria-busy"] ?? controller.busy,
    "data-transcription-status": controller.status,
  };
  return (
    <TranscriptionControlsContext.Provider value={controller}>
      {render
        ? render(nativeProps, forwardedRef)
        : <div {...nativeProps} ref={forwardedRef} />}
    </TranscriptionControlsContext.Provider>
  );
});

const STATUS_MESSAGES: Readonly<Record<TranscriptionControlsStatus, string>> =
  Object.freeze({
    idle: "Ready to record",
    requesting: "Requesting microphone access",
    recording: "Recording audio",
    stopping: "Stopping recording",
    uploading: "Uploading audio",
    transcribing: "Transcribing audio",
    success: "Transcription applied",
    error: "Transcription could not be completed",
    cancelled: "Transcription cancelled",
  });

export interface TranscriptionControlsStatusNativeProps
  extends HTMLAttributes<HTMLParagraphElement> {
  "data-transcription-status"?: TranscriptionControlsStatus;
}

export interface TranscriptionControlsStatusProps
  extends Omit<TranscriptionControlsStatusNativeProps, "children"> {
  readonly children?: ReactNode;
  readonly controller?: TranscriptionControlsController;
  readonly render?: PrimitiveRender<
    HTMLParagraphElement,
    TranscriptionControlsStatusNativeProps
  >;
}

export const TranscriptionControlsStatus = forwardRef<
  HTMLParagraphElement,
  TranscriptionControlsStatusProps
>(function TranscriptionControlsStatus(
  { children, controller: explicit, render, ...props },
  forwardedRef,
) {
  const controller = useController(explicit);
  const message = controller.status === "error"
    ? controller.error?.message ?? STATUS_MESSAGES.error
    : STATUS_MESSAGES[controller.status];
  const nativeProps: TranscriptionControlsStatusNativeProps = {
    ...props,
    children: children ?? message,
    role: props.role ?? "status",
    "aria-live": props["aria-live"] ?? "polite",
    "aria-atomic": props["aria-atomic"] ?? true,
    "aria-label": props["aria-label"] ?? `Transcription status: ${message}`,
    "data-transcription-status": controller.status,
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <p {...nativeProps} ref={forwardedRef} />;
});

export interface TranscriptionControlsActionProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly controller?: TranscriptionControlsController;
  readonly render?: PrimitiveRender<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement>
  >;
}

function actionButton(
  action: "start" | "stop" | "cancel" | "retry",
  props: TranscriptionControlsActionProps,
  forwardedRef: ForwardedRef<HTMLButtonElement>,
): ReactNode {
  const { children, controller: explicit, onClick, render, ...rest } = props;
  const controller = useController(explicit);
  const config = {
    start: {
      label: "Start transcription",
      enabled: controller.canStart,
      busy: controller.status === "requesting",
      activate: controller.start,
    },
    stop: {
      label: "Stop transcription",
      enabled: controller.canStop,
      busy: controller.status === "stopping",
      activate: controller.stop,
    },
    cancel: {
      label: "Cancel transcription",
      enabled: controller.canCancel,
      busy: false,
      activate: controller.cancel,
    },
    retry: {
      label: "Retry transcription",
      enabled: controller.canRetry,
      busy: controller.status === "transcribing",
      activate: controller.retry,
    },
  }[action];
  const nativeProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    ...rest,
    type: rest.type ?? "button",
    children: children ?? config.label,
    "aria-label": rest["aria-label"] ?? config.label,
    "aria-busy": rest["aria-busy"] ?? config.busy,
    disabled: rest.disabled ?? !config.enabled,
    onClick: (event) => {
      onClick?.(event);
      if (event.defaultPrevented || !config.enabled) return;
      void config.activate();
    },
  };
  return render
    ? render(nativeProps, forwardedRef)
    : <button {...nativeProps} ref={forwardedRef} />;
}

export type TranscriptionControlsStartProps = TranscriptionControlsActionProps;
export const TranscriptionControlsStart = forwardRef<
  HTMLButtonElement,
  TranscriptionControlsStartProps
>(function TranscriptionControlsStart(props, forwardedRef) {
  return actionButton("start", props, forwardedRef);
});

export type TranscriptionControlsStopProps = TranscriptionControlsActionProps;
export const TranscriptionControlsStop = forwardRef<
  HTMLButtonElement,
  TranscriptionControlsStopProps
>(function TranscriptionControlsStop(props, forwardedRef) {
  return actionButton("stop", props, forwardedRef);
});

export type TranscriptionControlsCancelProps = TranscriptionControlsActionProps;
export const TranscriptionControlsCancel = forwardRef<
  HTMLButtonElement,
  TranscriptionControlsCancelProps
>(function TranscriptionControlsCancel(props, forwardedRef) {
  return actionButton("cancel", props, forwardedRef);
});

export type TranscriptionControlsRetryProps = TranscriptionControlsActionProps;
export const TranscriptionControlsRetry = forwardRef<
  HTMLButtonElement,
  TranscriptionControlsRetryProps
>(function TranscriptionControlsRetry(props, forwardedRef) {
  return actionButton("retry", props, forwardedRef);
});
