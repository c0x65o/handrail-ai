import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  TRANSCRIPTION_AUDIO_FORMATS,
  TRANSCRIPTION_CONTRACT_VERSION,
  TRANSCRIPTION_ERROR_CODES,
  TRANSCRIPTION_LIMITS,
  TRANSCRIPTION_NOT_SUPPORTED,
  TRANSCRIPTION_UNSUPPORTED_REASONS,
  TranscriptionOperationError,
  TranscriptionValidationError,
  describeTranscriptionCapability,
  executeTranscription,
  normalizeTranscriptionError,
  parseTranscriptionAudioReference,
  parseTranscriptionAudioResolutionRequest,
  parseTranscriptionCapabilityDescriptor,
  parseTranscriptionIdempotencyKey,
  parseTranscriptionLanguage,
  parseTranscriptionRequest,
  parseTranscriptionResult,
  parseTranscriptionSafeError,
  transcriptionSafeError,
  type SupportedTranscriptionCapability,
  type TranscriptionCapability,
  type TranscriptionRequest,
} from "../src/index.js";

const activeSignal = (): AbortSignal => new AbortController().signal;

const audio = (overrides: Record<string, unknown> = {}) => ({
  audio_id: "audio-1",
  content_ref: "opaque-audio-1",
  format: { media_type: "audio/wav", container: "wav" },
  byte_size: 4_096,
  duration_seconds: 12.5,
  ...overrides,
});

const request = (overrides: Record<string, unknown> = {}) => ({
  request_id: "request-1",
  inputs: [audio()],
  language: "en-us",
  idempotency_key: "transcribe:request-1",
  signal: activeSignal(),
  ...overrides,
});

const result = (overrides: Record<string, unknown> = {}) => ({
  status: "completed",
  request_id: "request-1",
  outputs: [{
    audio_id: "audio-1",
    text: "Hello.\r\nThis is a transcript.",
    metadata: { language: "en-us", duration_seconds: 12.5 },
  }],
  ...overrides,
});

const supportedCapability = (
  transcribe: SupportedTranscriptionCapability["transcribe"] = async () =>
    parseTranscriptionResult(result()),
  overrides: Partial<SupportedTranscriptionCapability> = {},
): SupportedTranscriptionCapability => ({
  supported: true,
  version: TRANSCRIPTION_CONTRACT_VERSION,
  formats: TRANSCRIPTION_AUDIO_FORMATS,
  limits: {
    max_inputs: TRANSCRIPTION_LIMITS.inputsPerRequest,
    max_bytes_per_input: TRANSCRIPTION_LIMITS.audioBytesMax,
    max_duration_seconds: TRANSCRIPTION_LIMITS.audioDurationSecondsMax,
  },
  transcribe,
  ...overrides,
});

describe("provider-neutral transcription vocabulary", () => {
  it("exports immutable canonical MIME and container descriptors", () => {
    expect(TRANSCRIPTION_AUDIO_FORMATS).toEqual([
      { media_type: "audio/flac", container: "flac" },
      { media_type: "audio/mpeg", container: "mp3" },
      { media_type: "audio/mp4", container: "m4a" },
      { media_type: "audio/ogg", container: "ogg" },
      { media_type: "audio/wav", container: "wav" },
      { media_type: "audio/webm", container: "webm" },
    ]);
    expect(Object.isFrozen(TRANSCRIPTION_AUDIO_FORMATS)).toBe(true);
    for (const format of TRANSCRIPTION_AUDIO_FORMATS) {
      expect(Object.isFrozen(format)).toBe(true);
      expect(parseTranscriptionAudioReference(audio({ format })).format).toEqual(format);
    }
    expect(Object.isFrozen(TRANSCRIPTION_LIMITS)).toBe(true);
    expect(Object.isFrozen(TRANSCRIPTION_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(TRANSCRIPTION_UNSUPPORTED_REASONS)).toBe(true);
  });

  it("rejects unsupported or mismatched MIME and container combinations", () => {
    for (const format of [
      { media_type: "audio/aac", container: "aac" },
      { media_type: "audio/wav", container: "webm" },
      { media_type: "video/mp4", container: "m4a" },
      { media_type: "audio/mpeg", container: "mpeg" },
    ]) {
      expect(
        () => parseTranscriptionAudioReference(audio({ format })),
        JSON.stringify(format),
      ).toThrow(/MIME type and container combination/);
    }
  });

  it("normalizes BCP 47 language tags and rejects unbounded or invalid tags", () => {
    expect(parseTranscriptionLanguage("  EN-us  ")).toBe("en-US");
    expect(parseTranscriptionLanguage("zh-hant-tw")).toBe("zh-Hant-TW");
    for (const language of [
      "",
      "not a language",
      "x".repeat(TRANSCRIPTION_LIMITS.languageLength + 1),
      "Bearer abcdefghijklmnop",
    ]) {
      expect(() => parseTranscriptionLanguage(language)).toThrow(
        TranscriptionValidationError,
      );
    }
  });
});

describe("bounded audio references and requests", () => {
  it("accepts the exact byte, duration, identifier, and input-count bounds", () => {
    const identifier = "a".repeat(TRANSCRIPTION_LIMITS.identifierLength);
    const contentReference = "r".repeat(
      TRANSCRIPTION_LIMITS.contentReferenceLength,
    );
    const minimum = parseTranscriptionRequest(request({
      request_id: identifier,
      inputs: [audio({
        audio_id: identifier,
        content_ref: contentReference,
        byte_size: TRANSCRIPTION_LIMITS.audioBytesMin,
        duration_seconds: TRANSCRIPTION_LIMITS.audioDurationSecondsMin,
      })],
    }));
    expect(minimum.inputs).toHaveLength(TRANSCRIPTION_LIMITS.inputsPerRequest);
    expect(minimum.inputs[0]?.byte_size).toBe(TRANSCRIPTION_LIMITS.audioBytesMin);

    const maximum = parseTranscriptionAudioReference(audio({
      byte_size: TRANSCRIPTION_LIMITS.audioBytesMax,
      duration_seconds: TRANSCRIPTION_LIMITS.audioDurationSecondsMax,
    }));
    expect(maximum.byte_size).toBe(TRANSCRIPTION_LIMITS.audioBytesMax);
    expect(maximum.duration_seconds).toBe(
      TRANSCRIPTION_LIMITS.audioDurationSecondsMax,
    );
  });

  it("rejects invalid byte sizes, durations, identifiers, and input counts", () => {
    for (const byte_size of [
      0,
      1.5,
      Number.NaN,
      TRANSCRIPTION_LIMITS.audioBytesMax + 1,
    ]) {
      expect(() => parseTranscriptionAudioReference(audio({ byte_size }))).toThrow(
        /byte_size/,
      );
    }
    for (const duration_seconds of [
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      TRANSCRIPTION_LIMITS.audioDurationSecondsMax + 0.001,
    ]) {
      expect(
        () => parseTranscriptionAudioReference(audio({ duration_seconds })),
      ).toThrow(/duration_seconds/);
    }
    for (const [field, value] of [
      ["audio_id", ""],
      ["audio_id", "audio unsafe"],
      ["audio_id", "a".repeat(TRANSCRIPTION_LIMITS.identifierLength + 1)],
      ["content_ref", "opaque/audio"],
      [
        "content_ref",
        "r".repeat(TRANSCRIPTION_LIMITS.contentReferenceLength + 1),
      ],
    ] as const) {
      expect(
        () => parseTranscriptionAudioReference(audio({ [field]: value })),
      ).toThrow(new RegExp(field));
    }
    expect(() => parseTranscriptionRequest(request({ inputs: [] }))).toThrow(
      /inputs.*1-1/,
    );
    expect(() => parseTranscriptionRequest(request({
      inputs: [audio(), audio({ audio_id: "audio-2", content_ref: "opaque-2" })],
    }))).toThrow(/inputs.*1-1/);
  });

  it("requires stable, bounded idempotency input", () => {
    expect(parseTranscriptionIdempotencyKey("transcribe:request-1")).toBe(
      "transcribe:request-1",
    );
    for (const key of [
      "",
      "contains spaces",
      "key/with/path",
      "x".repeat(TRANSCRIPTION_LIMITS.idempotencyKeyLength + 1),
      "sk-sensitive-token-123456",
    ]) {
      expect(() => parseTranscriptionIdempotencyKey(key)).toThrow(
        /idempotency_key/,
      );
    }
  });

  it("rejects URLs, data URIs, embedded content, secrets, and native payloads", () => {
    for (const content_ref of [
      "https://storage.example/audio.wav",
      "file:///private/audio.wav",
      "data:audio/wav;base64,UklGRg==",
      "blob:https://app.example/audio",
      "ref-sk-sensitive-token-123456",
    ]) {
      expect(
        () => parseTranscriptionAudioReference(audio({ content_ref })),
        content_ref,
      ).toThrow(/content_ref/);
    }

    for (const extra of [
      { bytes: new Uint8Array([1, 2, 3]) },
      { base64: "UklGRg==" },
      { data: "UklGRg==" },
      { url: "https://example.test/audio.wav" },
      { storage_key: "bucket/object" },
      { api_key: "secret" },
      { authorization: "Bearer secret" },
      { provider: "example" },
      { provider_request: { file: "native" } },
      { response_format: "provider_native_json" },
    ]) {
      expect(() => parseTranscriptionAudioReference(audio(extra))).toThrow(
        /supported field/,
      );
    }
    for (const extra of [
      { credentials: { token: "secret" } },
      { headers: { authorization: "Bearer secret" } },
      { file: new Uint8Array([1, 2, 3]) },
      { provider_options: { model: "native-model" } },
      { prompt: "hidden instructions" },
    ]) {
      expect(() => parseTranscriptionRequest(request(extra))).toThrow(
        /supported field/,
      );
    }
  });

  it("keeps byte resolution in an exact trusted-host boundary", async () => {
    const parsed = parseTranscriptionAudioResolutionRequest({
      audio: audio(),
      signal: activeSignal(),
    });
    expect(Object.keys(parsed)).toEqual(["audio", "signal"]);
    expect(Object.keys(parsed.audio)).toEqual([
      "audio_id",
      "content_ref",
      "format",
      "byte_size",
      "duration_seconds",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("UklGR");
    expect(() => parseTranscriptionAudioResolutionRequest({
      audio: audio(),
      signal: activeSignal(),
      token: "secret",
    })).toThrow(/supported field/);

    const resolver = {
      resolveAudio: vi.fn(async (resolutionRequest: unknown) => {
        expect(resolutionRequest).toBe(parsed);
        return new Uint8Array([1, 2, 3]);
      }),
    };
    await expect(resolver.resolveAudio(parsed)).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(resolver.resolveAudio).toHaveBeenCalledWith(parsed);
  });
});

describe("transcription capabilities and cancellation", () => {
  it("narrows supported and unsupported capabilities", async () => {
    const verifyNarrowing = (capability: TranscriptionCapability): void => {
      if (capability.supported) {
        expectTypeOf(capability.transcribe).toBeFunction();
        expect(capability.version).toBe(TRANSCRIPTION_CONTRACT_VERSION);
      } else {
        expectTypeOf(capability.reason).toEqualTypeOf<
          (typeof TRANSCRIPTION_UNSUPPORTED_REASONS)[number]
        >();
      }
    };
    const capability = supportedCapability();
    verifyNarrowing(capability);
    verifyNarrowing(TRANSCRIPTION_NOT_SUPPORTED);

    const supported = describeTranscriptionCapability(capability);
    const unsupported = describeTranscriptionCapability(
      TRANSCRIPTION_NOT_SUPPORTED,
    );
    expect(supported.supported).toBe(true);
    expect(unsupported).toEqual({
      supported: false,
      reason: "implementation_not_configured",
    });
    expect(Object.isFrozen(supported)).toBe(true);
    expect(Object.isFrozen(unsupported)).toBe(true);
  });

  it("strictly validates descriptors and adapter-specific format limits", async () => {
    expect(() => parseTranscriptionCapabilityDescriptor({
      supported: true,
      version: TRANSCRIPTION_CONTRACT_VERSION,
      formats: [TRANSCRIPTION_AUDIO_FORMATS[0]],
      limits: {
        max_inputs: 1,
        max_bytes_per_input: TRANSCRIPTION_LIMITS.audioBytesMax,
        max_duration_seconds: TRANSCRIPTION_LIMITS.audioDurationSecondsMax,
      },
      model: "native-model",
    })).toThrow(/supported field/);

    const transcribe = vi.fn<SupportedTranscriptionCapability["transcribe"]>();
    const outcome = await executeTranscription(supportedCapability(transcribe, {
      formats: [TRANSCRIPTION_AUDIO_FORMATS[0]],
    }), request());
    expect(outcome).toEqual({
      ok: false,
      error: transcriptionSafeError("unsupported_audio"),
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("requires AbortSignal and does not invoke an adapter when pre-aborted", async () => {
    expect(() => parseTranscriptionRequest(request({ signal: undefined }))).toThrow(
      /signal.*AbortSignal/,
    );
    const controller = new AbortController();
    controller.abort({ transcript: "private", token: "secret" });
    const transcribe = vi.fn<SupportedTranscriptionCapability["transcribe"]>();
    const outcome = await executeTranscription(
      supportedCapability(transcribe),
      request({ signal: controller.signal }),
    );
    expect(outcome).toEqual({
      ok: false,
      error: transcriptionSafeError("cancelled"),
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("forwards the exact signal and safely settles in-flight cancellation", async () => {
    const controller = new AbortController();
    let received: TranscriptionRequest | undefined;
    const transcribe = vi.fn(async (value: TranscriptionRequest) => {
      received = value;
      return new Promise<never>(() => undefined);
    });
    const pending = executeTranscription(
      supportedCapability(transcribe),
      request({ signal: controller.signal }),
    );
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    expect(received?.signal).toBe(controller.signal);
    controller.abort(new Error("private cancellation reason"));
    await expect(pending).resolves.toEqual({
      ok: false,
      error: transcriptionSafeError("cancelled"),
    });
  });
});

describe("normalized results and safe failures", () => {
  it("normalizes and deeply freezes result records and nested collections", () => {
    const parsedRequest = parseTranscriptionRequest(request());
    const parsed = parseTranscriptionResult(result(), parsedRequest);
    expect(parsed.outputs[0]).toEqual({
      audio_id: "audio-1",
      text: "Hello.\nThis is a transcript.",
      metadata: { language: "en-US", duration_seconds: 12.5 },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.outputs)).toBe(true);
    expect(Object.isFrozen(parsed.outputs[0])).toBe(true);
    expect(Object.isFrozen(parsed.outputs[0]?.metadata)).toBe(true);
    expect(() => (parsed.outputs as unknown as unknown[]).push({})).toThrow();
  });

  it("rejects unknown result fields, mismatched identities, and oversized output", () => {
    const parsedRequest = parseTranscriptionRequest(request());
    expect(() => parseTranscriptionResult(result({ provider_response: {} }))).toThrow(
      /supported field/,
    );
    expect(() => parseTranscriptionResult(result({ request_id: "other" }), parsedRequest)).toThrow(
      /request_id.*match/,
    );
    expect(() => parseTranscriptionResult(result({
      outputs: [{
        audio_id: "audio-1",
        text: "x".repeat(TRANSCRIPTION_LIMITS.transcriptTextLength + 1),
        metadata: { language: null, duration_seconds: 1 },
      }],
    }))).toThrow(/text.*at most/);
    expect(() => parseTranscriptionResult(result({
      outputs: [{
        audio_id: "audio-1",
        text: "private",
        metadata: { language: null, duration_seconds: 1, confidence: 0.9 },
      }],
    }))).toThrow(/supported field/);
  });

  it("emits only fixed safe error metadata and redacts arbitrary failures", () => {
    for (const code of TRANSCRIPTION_ERROR_CODES) {
      const safe = transcriptionSafeError(code);
      expect(parseTranscriptionSafeError(safe)).toEqual(safe);
      expect(Object.keys(safe)).toEqual([
        "code",
        "message",
        "retryable",
        "cancelled",
      ]);
      expect(safe.message.length).toBeLessThanOrEqual(
        TRANSCRIPTION_LIMITS.safeErrorMessageLength,
      );
    }

    const arbitrary = normalizeTranscriptionError({
      cause: new Error("sk-secret-token transcript text"),
      provider_response: { instructions: "hidden" },
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(arbitrary).toEqual(transcriptionSafeError("internal_failure"));
    expect(JSON.stringify(arbitrary)).not.toMatch(
      /secret|transcript text|provider_response|instructions|bytes/i,
    );

    expect(normalizeTranscriptionError(
      new TranscriptionOperationError("service_unavailable"),
    )).toEqual(transcriptionSafeError("service_unavailable"));
    expect(normalizeTranscriptionError({
      ...transcriptionSafeError("rate_limited"),
      transcript: "private",
    })).toEqual(transcriptionSafeError("internal_failure"));
  });

  it("returns a frozen normalized outcome without provider-native surfaces", async () => {
    const transcribe = vi.fn(async (parsed: TranscriptionRequest) => ({
      status: "completed" as const,
      request_id: parsed.request_id,
      outputs: [{
        audio_id: parsed.inputs[0]!.audio_id,
        text: "normalized text",
        metadata: { language: null, duration_seconds: 12.5 },
      }],
    }));
    const outcome = await executeTranscription(
      supportedCapability(transcribe),
      request(),
    );
    expect(outcome.ok).toBe(true);
    expect(Object.isFrozen(outcome)).toBe(true);
    if (outcome.ok) {
      expect(Object.isFrozen(outcome.result.outputs)).toBe(true);
      expect(Object.keys(outcome.result)).toEqual([
        "status",
        "request_id",
        "outputs",
      ]);
    }
  });
});
