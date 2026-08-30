import { useState } from "react";

import {
  TRANSCRIPTION_CONTRACT_VERSION,
  type SupportedTranscriptionCapability,
  type TranscriptionAudioId,
  type TranscriptionAudioReference,
  type TranscriptionContentReference,
  type TranscriptionIdempotencyKey,
  type TranscriptionRequest,
  type TranscriptionRequestId,
  type TranscriptionResult,
} from "@handrail/ai";
import {
  type BrowserAudioCaptureController,
  type BrowserAudioCaptureListener,
  type BrowserAudioCaptureResult,
  type BrowserAudioCaptureState,
} from "@handrail/ai/browser";
import {
  TranscriptionControlsCancel,
  TranscriptionControlsRetry,
  TranscriptionControlsRoot,
  TranscriptionControlsStart,
  TranscriptionControlsStatus,
  TranscriptionControlsStop,
  useTranscriptionControls,
  type TranscriptionCaptureFactoryInput,
} from "@handrail/ai/react";

const format = Object.freeze({
  media_type: "audio/webm",
  container: "webm",
} as const);

/** Credential-free fake: a real host can inject createBrowserAudioCaptureController here. */
function createRecipeCaptureController(
  input: TranscriptionCaptureFactoryInput,
): BrowserAudioCaptureController {
  void input;
  let state: BrowserAudioCaptureState = { status: "idle" };
  let disposed = false;
  const listeners = new Set<BrowserAudioCaptureListener>();
  const publish = (next: BrowserAudioCaptureState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    async start() {
      if (disposed) return;
      publish({ status: "requesting", format });
      publish({
        status: "recording",
        format,
        accumulatedBytes: 0,
        elapsedSeconds: 0.001,
      });
    },
    async stop(): Promise<BrowserAudioCaptureResult | null> {
      if (disposed || state.status !== "recording") return null;
      // Created only after the user presses Stop; no browser globals are read on render.
      const source = new Blob(["demo"], { type: format.media_type });
      const result = Object.freeze({
        source,
        format,
        byteSize: source.size,
        durationSeconds: 1,
        fingerprint: "browser-audio:recipe",
      });
      publish({
        status: "stopped",
        format,
        byteSize: source.size,
        durationSeconds: 1,
        fingerprint: result.fingerprint,
      });
      return result;
    },
    async cancel() {
      if (disposed) return;
      publish({
        status: "failed",
        error: { code: "cancelled", message: "Audio capture was cancelled." },
      });
    },
    async dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

/** Credential-free host upload boundary; production hosts store bytes outside React. */
async function uploadRecipeAudio({
  capture,
  signal,
}: {
  readonly capture: BrowserAudioCaptureResult;
  readonly signal: AbortSignal;
}): Promise<TranscriptionAudioReference> {
  signal.throwIfAborted();
  return Object.freeze({
    audio_id: "audio_recipe" as TranscriptionAudioId,
    content_ref: "host_audio_recipe" as TranscriptionContentReference,
    format: capture.format,
    byte_size: capture.byteSize,
    duration_seconds: capture.durationSeconds,
  });
}

/** Credential-free fake trusted-host capability; no provider adapter is imported. */
const recipeCapability: SupportedTranscriptionCapability = Object.freeze({
  supported: true,
  version: TRANSCRIPTION_CONTRACT_VERSION,
  formats: [format],
  limits: {
    max_inputs: 1,
    max_bytes_per_input: 1024,
    max_duration_seconds: 60,
  },
  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    request.signal.throwIfAborted();
    const input = request.inputs[0]!;
    return {
      status: "completed",
      request_id: request.request_id,
      outputs: [{
        audio_id: input.audio_id,
        text: "Demo dictated text.",
        metadata: { language: null, duration_seconds: input.duration_seconds },
      }],
    };
  },
});

let identitySequence = 0;

export function CredentialFreeTranscriptionRecipe({
  conversationId,
}: {
  readonly conversationId: string;
}) {
  const [draft, setDraft] = useState("");
  const controller = useTranscriptionControls({
    conversationId,
    createCaptureController: createRecipeCaptureController,
    uploadAudio: uploadRecipeAudio,
    capability: recipeCapability,
    createRequestIdentity: () => {
      identitySequence += 1;
      return {
        requestId: `recipe_request_${identitySequence}` as TranscriptionRequestId,
        idempotencyKey:
          `recipe:transcription:${identitySequence}` as TranscriptionIdempotencyKey,
      };
    },
    // This host-owned callback chooses append semantics; the primitive does not.
    applyTranscript: (text) => setDraft((current) =>
      current.length === 0 ? text : `${current} ${text}`),
  });

  return <>
    <label>
      Draft
      <textarea value={draft} onChange={(event) => setDraft(event.currentTarget.value)} />
    </label>
    <TranscriptionControlsRoot controller={controller} aria-label="Dictation controls">
      <TranscriptionControlsStatus />
      <TranscriptionControlsStart />
      <TranscriptionControlsStop />
      <TranscriptionControlsCancel />
      <TranscriptionControlsRetry />
    </TranscriptionControlsRoot>
  </>;
}
