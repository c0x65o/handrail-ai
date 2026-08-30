import {
  REALTIME_VOICE_CONTRACT_VERSION,
  REALTIME_VOICE_LIMITS,
  type RealtimeVoiceBootstrapRequest,
  type RealtimeVoiceBootstrapResult,
  type RealtimeVoiceCapabilities,
  type RealtimeVoiceClientAuthorization,
  type RealtimeVoiceClientConnection,
  type RealtimeVoiceHangupReason,
  type RealtimeVoiceHangupRequest,
  type RealtimeVoiceSafeError,
  type RealtimeVoiceSessionConfiguration,
  type RealtimeVoiceSessionEvent,
  type RealtimeVoiceSessionId,
  type RealtimeVoiceTerminalResult,
} from "../realtime/types.js";
import {
  RealtimeVoiceOperationError,
  RealtimeVoiceValidationError,
  assertRealtimeVoiceAbortSignal,
  normalizeRealtimeVoiceError,
  parseRealtimeVoiceBootstrapRequest,
  parseRealtimeVoiceBootstrapResult,
  parseRealtimeVoiceSessionEvent,
  realtimeVoiceSafeError,
  throwIfRealtimeVoiceAborted,
} from "../realtime/validation.js";

export const BROWSER_REALTIME_VOICE_LIMITS = Object.freeze({
  maximumSdpBytes: 65_536,
  maximumDataChannelMessageBytes: 16_384,
  maximumDataChannelMessages: 512,
  maximumBufferedDataChannelBytes: 65_536,
} as const);

export interface BrowserRealtimeVoiceTrack {
  enabled: boolean;
  stop(): void;
}

export interface BrowserRealtimeVoiceStream {
  getTracks(): readonly BrowserRealtimeVoiceTrack[];
}

export interface BrowserRealtimeVoiceMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<BrowserRealtimeVoiceStream>;
}

export type BrowserRealtimeVoiceEventListener = (event: unknown) => void;

export interface BrowserRealtimeVoiceDataChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: BrowserRealtimeVoiceEventListener): void;
  removeEventListener(type: string, listener: BrowserRealtimeVoiceEventListener): void;
}

export interface BrowserRealtimeVoiceSessionDescription {
  readonly type: "offer" | "answer";
  readonly sdp: string;
}

export interface BrowserRealtimeVoicePeerConnection {
  readonly connectionState?: string;
  readonly localDescription?: { readonly type?: string; readonly sdp?: string } | null;
  addTrack(track: BrowserRealtimeVoiceTrack, stream: BrowserRealtimeVoiceStream): unknown;
  createDataChannel(label: string): BrowserRealtimeVoiceDataChannel;
  createOffer(): Promise<{ readonly type?: string; readonly sdp?: string }>;
  setLocalDescription(description: BrowserRealtimeVoiceSessionDescription): Promise<void>;
  setRemoteDescription(description: BrowserRealtimeVoiceSessionDescription): Promise<void>;
  close(): void;
  addEventListener(type: string, listener: BrowserRealtimeVoiceEventListener): void;
  removeEventListener(type: string, listener: BrowserRealtimeVoiceEventListener): void;
}

export interface BrowserRealtimeVoicePlaybackResource {
  close(): void;
}

export interface BrowserRealtimeVoiceLifecycleHooks {
  addEventListener(type: "pagehide" | "beforeunload", listener: () => void): void;
  removeEventListener(type: "pagehide" | "beforeunload", listener: () => void): void;
}

export interface BrowserRealtimeVoiceClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BrowserRealtimeVoiceSdpExchangeRequest {
  readonly version: typeof REALTIME_VOICE_CONTRACT_VERSION;
  readonly request_id: RealtimeVoiceBootstrapRequest["request_id"];
  readonly session_id: RealtimeVoiceSessionId;
  readonly connection: RealtimeVoiceClientConnection;
  readonly authorization: RealtimeVoiceClientAuthorization;
  readonly offer_sdp: string;
  readonly signal: AbortSignal;
}

export interface BrowserRealtimeVoiceSdpExchangeResult {
  readonly answer_sdp: string;
}

export type BrowserRealtimeVoiceStatus =
  | "idle"
  | "starting"
  | "active"
  | "ending"
  | "ended"
  | "failed"
  | "cancelled"
  | "disposed";

export type BrowserRealtimeVoiceLocalMediaState =
  | "inactive"
  | "requesting"
  | "active"
  | "muted"
  | "stopped";

/** Retainable browser state. It deliberately excludes authorization, SDP and connection data. */
export interface BrowserRealtimeVoiceState {
  readonly status: BrowserRealtimeVoiceStatus;
  readonly request_id: RealtimeVoiceBootstrapRequest["request_id"];
  readonly session_id: RealtimeVoiceSessionId | null;
  readonly configuration: RealtimeVoiceSessionConfiguration | null;
  readonly capabilities: RealtimeVoiceCapabilities | null;
  readonly local_media: BrowserRealtimeVoiceLocalMediaState;
  readonly remote_audio_active: boolean;
  readonly response_active: boolean;
  readonly error: RealtimeVoiceSafeError | null;
}

export type BrowserRealtimeVoiceEvent =
  | { readonly type: "state_changed"; readonly state: BrowserRealtimeVoiceState }
  | { readonly type: "server_event"; readonly event: RealtimeVoiceSessionEvent };

export interface BrowserRealtimeVoiceOperationInput {
  readonly signal?: AbortSignal;
}

export interface BrowserRealtimeVoiceController {
  getState(): BrowserRealtimeVoiceState;
  subscribe(listener: (state: BrowserRealtimeVoiceState) => void): () => void;
  subscribeEvents(listener: (event: BrowserRealtimeVoiceEvent) => void): () => void;
  start(input?: BrowserRealtimeVoiceOperationInput): Promise<BrowserRealtimeVoiceState>;
  mute(): BrowserRealtimeVoiceState;
  unmute(): BrowserRealtimeVoiceState;
  stopLocalMedia(): BrowserRealtimeVoiceState;
  interrupt(input?: BrowserRealtimeVoiceOperationInput): Promise<BrowserRealtimeVoiceState>;
  applyServerEvent(event: unknown): BrowserRealtimeVoiceState;
  hangup(input?: BrowserRealtimeVoiceOperationInput): Promise<BrowserRealtimeVoiceState>;
  cancel(): Promise<BrowserRealtimeVoiceState>;
  dispose(): Promise<void>;
}

export interface BrowserRealtimeVoiceControllerOptions {
  readonly request: RealtimeVoiceBootstrapRequest;
  readonly bootstrap: (
    request: RealtimeVoiceBootstrapRequest,
    operation: { readonly signal: AbortSignal },
  ) => Promise<RealtimeVoiceBootstrapResult>;
  readonly exchangeSdp: (
    request: BrowserRealtimeVoiceSdpExchangeRequest,
  ) => Promise<BrowserRealtimeVoiceSdpExchangeResult>;
  readonly authoritativeHangup: (
    request: RealtimeVoiceHangupRequest,
  ) => Promise<RealtimeVoiceTerminalResult>;
  readonly peerConnectionFactory?: () => BrowserRealtimeVoicePeerConnection;
  readonly mediaDevices?: BrowserRealtimeVoiceMediaDevices;
  readonly playRemoteAudio?: (
    stream: BrowserRealtimeVoiceStream,
  ) => BrowserRealtimeVoicePlaybackResource | Promise<BrowserRealtimeVoicePlaybackResource>;
  readonly lifecycle?: BrowserRealtimeVoiceLifecycleHooks;
  readonly clock?: BrowserRealtimeVoiceClock;
  readonly maximumSdpBytes?: number;
  readonly maximumDataChannelMessageBytes?: number;
  readonly maximumDataChannelMessages?: number;
  readonly maximumBufferedDataChannelBytes?: number;
}

const UTF8_ENCODER = new TextEncoder();

function boundedLimit(value: number | undefined, hardMaximum: number, name: string): number {
  const parsed = value ?? hardMaximum;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > hardMaximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${hardMaximum}`);
  }
  return parsed;
}

function byteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

function parseSdp(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RealtimeVoiceValidationError(path, "must be a non-empty SDP string");
  }
  if (value.length > maximumBytes || byteLength(value) > maximumBytes) {
    throw new RealtimeVoiceValidationError(path, `must contain at most ${maximumBytes} UTF-8 bytes`);
  }
  if (value.includes("\u0000")) {
    throw new RealtimeVoiceValidationError(path, "must not contain NUL characters");
  }
  return value;
}

function parseAnswer(value: unknown, maximumBytes: number): BrowserRealtimeVoiceSdpExchangeResult {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new RealtimeVoiceValidationError("$sdp_result", "must be a plain data object");
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== 1 || !Object.hasOwn(source, "answer_sdp")) {
    throw new RealtimeVoiceValidationError("$sdp_result", "must contain only answer_sdp");
  }
  return Object.freeze({
    answer_sdp: parseSdp(source.answer_sdp, "$sdp_result.answer_sdp", maximumBytes),
  });
}

function isTerminal(status: BrowserRealtimeVoiceStatus): boolean {
  return status === "ended" || status === "failed" || status === "cancelled" || status === "disposed";
}

function hashIdentity(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function defaultClock(): BrowserRealtimeVoiceClock {
  return {
    now: Date.now,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function defaultPeerConnection(): BrowserRealtimeVoicePeerConnection {
  const Constructor = (globalThis as typeof globalThis & {
    RTCPeerConnection?: new () => BrowserRealtimeVoicePeerConnection;
  }).RTCPeerConnection;
  if (typeof Constructor !== "function") {
    throw new RealtimeVoiceOperationError("temporarily_unavailable");
  }
  return new Constructor();
}

function defaultMediaDevices(): BrowserRealtimeVoiceMediaDevices {
  const devices = (globalThis as typeof globalThis & {
    navigator?: { readonly mediaDevices?: BrowserRealtimeVoiceMediaDevices };
  }).navigator?.mediaDevices;
  if (devices === undefined || typeof devices.getUserMedia !== "function") {
    throw new RealtimeVoiceOperationError("temporarily_unavailable");
  }
  return devices;
}

function defaultLifecycle(): BrowserRealtimeVoiceLifecycleHooks | undefined {
  if (
    typeof globalThis.addEventListener !== "function" ||
    typeof globalThis.removeEventListener !== "function"
  ) return undefined;
  return {
    addEventListener: (type, listener) => globalThis.addEventListener(type, listener),
    removeEventListener: (type, listener) => globalThis.removeEventListener(type, listener),
  };
}

function defaultPlayRemoteAudio(
  stream: BrowserRealtimeVoiceStream,
): BrowserRealtimeVoicePlaybackResource {
  const documentValue = (globalThis as typeof globalThis & { document?: Document }).document;
  if (documentValue === undefined) {
    throw new RealtimeVoiceOperationError("temporarily_unavailable");
  }
  const audio = documentValue.createElement("audio");
  audio.autoplay = true;
  audio.srcObject = stream as unknown as MediaProvider;
  void audio.play().catch(() => undefined);
  let closed = false;
  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    },
  });
}

function abortError(): RealtimeVoiceOperationError {
  return new RealtimeVoiceOperationError("cancelled");
}

function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfRealtimeVoiceAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

class BrowserRealtimeVoiceControllerImpl implements BrowserRealtimeVoiceController {
  readonly #request: RealtimeVoiceBootstrapRequest;
  readonly #options: BrowserRealtimeVoiceControllerOptions;
  readonly #clock: BrowserRealtimeVoiceClock;
  readonly #maximumSdpBytes: number;
  readonly #maximumMessageBytes: number;
  readonly #maximumMessages: number;
  readonly #maximumBufferedBytes: number;
  readonly #stateListeners = new Set<(state: BrowserRealtimeVoiceState) => void>();
  readonly #eventListeners = new Set<(event: BrowserRealtimeVoiceEvent) => void>();
  readonly #seenEventIds = new Set<string>();
  readonly #seenEventOrder: string[] = [];
  readonly #stoppedTracks = new WeakSet<BrowserRealtimeVoiceTrack>();
  readonly #closedPlaybackResources = new WeakSet<BrowserRealtimeVoicePlaybackResource>();
  #state: BrowserRealtimeVoiceState;
  #bootstrapResult: RealtimeVoiceBootstrapResult | null = null;
  #peer: BrowserRealtimeVoicePeerConnection | null = null;
  #channel: BrowserRealtimeVoiceDataChannel | null = null;
  #localTracks: BrowserRealtimeVoiceTrack[] = [];
  #remoteTracks: BrowserRealtimeVoiceTrack[] = [];
  #playbackResources: BrowserRealtimeVoicePlaybackResource[] = [];
  #startPromise: Promise<BrowserRealtimeVoiceState> | null = null;
  #terminalPromise: Promise<BrowserRealtimeVoiceState> | null = null;
  #hangupPromise: Promise<RealtimeVoiceTerminalResult> | null = null;
  #operationAbort: AbortController | null = null;
  #expiryTimer: unknown;
  #messageCount = 0;
  #lastEventSequence = 0;
  #resourcesClosed = false;
  #lifecycle: BrowserRealtimeVoiceLifecycleHooks | undefined;
  #lifecycleAttached = false;

  readonly #onPageHide = () => {
    void this.dispose();
  };
  readonly #onChannelMessage = (value: unknown) => {
    if (isTerminal(this.#state.status)) return;
    try {
      const data = value !== null && typeof value === "object"
        ? (value as { readonly data?: unknown }).data
        : undefined;
      if (typeof data !== "string") throw new RealtimeVoiceOperationError("invalid_request");
      this.#messageCount += 1;
      if (
        this.#messageCount > this.#maximumMessages ||
        data.length > this.#maximumMessageBytes ||
        byteLength(data) > this.#maximumMessageBytes
      ) throw new RealtimeVoiceOperationError("invalid_request");
      this.applyServerEvent(JSON.parse(data) as unknown);
    } catch {
      void this.#fail(new RealtimeVoiceOperationError("invalid_request"));
    }
  };
  readonly #onChannelClose = () => {
    if (!isTerminal(this.#state.status) && this.#state.status !== "ending") {
      void this.#fail(new RealtimeVoiceOperationError("temporarily_unavailable"));
    }
  };
  readonly #onConnectionStateChange = () => {
    const state = this.#peer?.connectionState;
    if (
      !isTerminal(this.#state.status) &&
      this.#state.status !== "ending" &&
      (state === "failed" || state === "closed")
    ) void this.#fail(new RealtimeVoiceOperationError("temporarily_unavailable"));
  };
  readonly #onTrack = (value: unknown) => {
    if (isTerminal(this.#state.status)) return;
    const event = value as {
      readonly track?: BrowserRealtimeVoiceTrack;
      readonly streams?: readonly BrowserRealtimeVoiceStream[];
    };
    if (event.track !== undefined) this.#remoteTracks.push(event.track);
    const stream = event.streams?.[0];
    if (stream === undefined) return;
    this.#remoteTracks.push(...stream.getTracks());
    const play = this.#options.playRemoteAudio ?? defaultPlayRemoteAudio;
    let playback: BrowserRealtimeVoicePlaybackResource | Promise<BrowserRealtimeVoicePlaybackResource>;
    try {
      playback = play(stream);
    } catch {
      void this.#fail(new RealtimeVoiceOperationError("temporarily_unavailable"));
      return;
    }
    void Promise.resolve(playback).then((resource) => {
      if (isTerminal(this.#state.status) || this.#resourcesClosed) this.#closePlayback(resource);
      else {
        this.#playbackResources.push(resource);
        this.#setState({ remote_audio_active: true });
      }
    }).catch(() => {
      if (!isTerminal(this.#state.status)) {
        void this.#fail(new RealtimeVoiceOperationError("temporarily_unavailable"));
      }
    });
  };

  constructor(options: BrowserRealtimeVoiceControllerOptions) {
    if (
      options === null ||
      typeof options !== "object" ||
      typeof options.bootstrap !== "function" ||
      typeof options.exchangeSdp !== "function" ||
      typeof options.authoritativeHangup !== "function"
    ) throw new TypeError("bootstrap, exchangeSdp, and authoritativeHangup functions are required");
    this.#request = parseRealtimeVoiceBootstrapRequest(options.request);
    this.#options = options;
    this.#clock = options.clock ?? defaultClock();
    this.#maximumSdpBytes = boundedLimit(
      options.maximumSdpBytes,
      BROWSER_REALTIME_VOICE_LIMITS.maximumSdpBytes,
      "maximumSdpBytes",
    );
    this.#maximumMessageBytes = boundedLimit(
      options.maximumDataChannelMessageBytes,
      BROWSER_REALTIME_VOICE_LIMITS.maximumDataChannelMessageBytes,
      "maximumDataChannelMessageBytes",
    );
    this.#maximumMessages = boundedLimit(
      options.maximumDataChannelMessages,
      BROWSER_REALTIME_VOICE_LIMITS.maximumDataChannelMessages,
      "maximumDataChannelMessages",
    );
    this.#maximumBufferedBytes = boundedLimit(
      options.maximumBufferedDataChannelBytes,
      BROWSER_REALTIME_VOICE_LIMITS.maximumBufferedDataChannelBytes,
      "maximumBufferedDataChannelBytes",
    );
    this.#state = Object.freeze({
      status: "idle",
      request_id: this.#request.request_id,
      session_id: null,
      configuration: null,
      capabilities: null,
      local_media: "inactive",
      remote_audio_active: false,
      response_active: false,
      error: null,
    });
  }

  getState(): BrowserRealtimeVoiceState {
    return this.#state;
  }

  subscribe(listener: (state: BrowserRealtimeVoiceState) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#stateListeners.add(listener);
    listener(this.#state);
    return () => this.#stateListeners.delete(listener);
  }

  subscribeEvents(listener: (event: BrowserRealtimeVoiceEvent) => void): () => void {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  start(input: BrowserRealtimeVoiceOperationInput = {}): Promise<BrowserRealtimeVoiceState> {
    if (this.#startPromise !== null) return this.#startPromise;
    if (this.#state.status === "active") return Promise.resolve(this.#state);
    if (this.#state.status !== "idle") return Promise.reject(new RealtimeVoiceOperationError("invalid_state"));
    const signal = input.signal ?? new AbortController().signal;
    assertRealtimeVoiceAbortSignal(signal, "$operation.signal");
    this.#operationAbort = new AbortController();
    const onAbort = () => this.#operationAbort?.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const operationSignal = this.#operationAbort.signal;
    this.#setState({ status: "starting", error: null });
    this.#attachLifecycle();

    const bootstrapPromise = Promise.resolve().then(() =>
      this.#options.bootstrap(this.#request, { signal: operationSignal }));
    this.#startPromise = (async () => {
      try {
        const rawBootstrap = await raceWithAbort(bootstrapPromise, operationSignal);
        const bootstrap = parseRealtimeVoiceBootstrapResult(rawBootstrap, {
          request: this.#request,
          now: this.#clock.now(),
        });
        this.#bootstrapResult = bootstrap;
        this.#setState({
          session_id: bootstrap.session_id,
          configuration: bootstrap.configuration,
          capabilities: bootstrap.capabilities,
        });
        this.#assertRequiredCapabilities(bootstrap.capabilities);
        throwIfRealtimeVoiceAborted(operationSignal);

        const peer = (this.#options.peerConnectionFactory ?? defaultPeerConnection)();
        this.#peer = peer;
        peer.addEventListener("track", this.#onTrack);
        peer.addEventListener("connectionstatechange", this.#onConnectionStateChange);
        const channel = peer.createDataChannel("handrail.realtime-voice.v1");
        this.#channel = channel;
        channel.addEventListener("message", this.#onChannelMessage);
        channel.addEventListener("close", this.#onChannelClose);

        if (bootstrap.capabilities.input_audio.supported) {
          this.#setState({ local_media: "requesting" });
          const devices = this.#options.mediaDevices ?? defaultMediaDevices();
          let stream: BrowserRealtimeVoiceStream;
          try {
            const mediaPromise = devices.getUserMedia({ audio: true, video: false });
            void mediaPromise.then((lateStream) => {
              if (operationSignal.aborted || this.#resourcesClosed) {
                this.#stopTracks(lateStream.getTracks());
              }
            }, () => undefined);
            stream = await raceWithAbort(
              mediaPromise,
              operationSignal,
            );
          } catch (error) {
            if (operationSignal.aborted) throw error;
            throw new RealtimeVoiceOperationError("invalid_state");
          }
          throwIfRealtimeVoiceAborted(operationSignal);
          this.#localTracks = [...stream.getTracks()];
          for (const track of this.#localTracks) peer.addTrack(track, stream);
          this.#setState({ local_media: "active" });
        }

        const offer = await raceWithAbort(peer.createOffer(), operationSignal);
        const offerSdp = parseSdp(offer.sdp, "$local_offer.sdp", this.#maximumSdpBytes);
        await raceWithAbort(
          peer.setLocalDescription({ type: "offer", sdp: offerSdp }),
          operationSignal,
        );
        this.#assertBootstrapUnexpired(bootstrap);
        const answer = parseAnswer(await raceWithAbort(
          this.#options.exchangeSdp(Object.freeze({
            version: REALTIME_VOICE_CONTRACT_VERSION,
            request_id: this.#request.request_id,
            session_id: bootstrap.session_id,
            connection: bootstrap.connection,
            authorization: bootstrap.authorization,
            offer_sdp: offerSdp,
            signal: operationSignal,
          })),
          operationSignal,
        ), this.#maximumSdpBytes);
        await raceWithAbort(
          peer.setRemoteDescription({ type: "answer", sdp: answer.answer_sdp }),
          operationSignal,
        );
        throwIfRealtimeVoiceAborted(operationSignal);
        this.#assertBootstrapUnexpired(bootstrap);
        this.#scheduleExpiry(bootstrap);
        return this.#setState({ status: "active" });
      } catch (error) {
        if (operationSignal.aborted || normalizeRealtimeVoiceError(error).code === "cancelled") {
          await this.#terminate("cancelled", "client_request", realtimeVoiceSafeError("cancelled"), true);
          throw new RealtimeVoiceOperationError(
            this.#state.status === "failed" && this.#state.error !== null
              ? this.#state.error.code
              : "cancelled",
          );
        }
        const safe = normalizeRealtimeVoiceError(error);
        await this.#terminate("failed", "failure", safe, true);
        throw new RealtimeVoiceOperationError(safe.code);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    })();

    // A bootstrap implementation may ignore cancellation. Adopt and close its late session.
    void bootstrapPromise.then((value) => {
      if (!isTerminal(this.#state.status) || this.#bootstrapResult !== null) return;
      try {
        this.#bootstrapResult = parseRealtimeVoiceBootstrapResult(value, {
          request: this.#request,
          now: this.#clock.now(),
        });
        this.#setState({ session_id: this.#bootstrapResult.session_id });
        void this.#invokeHangup("client_request");
      } catch {
        // An invalid late result has no trustworthy session identity to close.
      }
    }, () => undefined);
    return this.#startPromise;
  }

  mute(): BrowserRealtimeVoiceState {
    if (this.#state.local_media === "muted") return this.#state;
    if (this.#state.status !== "active" || this.#state.local_media !== "active") {
      throw new RealtimeVoiceOperationError("invalid_state");
    }
    for (const track of this.#localTracks) track.enabled = false;
    return this.#setState({ local_media: "muted" });
  }

  unmute(): BrowserRealtimeVoiceState {
    if (this.#state.local_media === "active") return this.#state;
    if (this.#state.status !== "active" || this.#state.local_media !== "muted") {
      throw new RealtimeVoiceOperationError("invalid_state");
    }
    for (const track of this.#localTracks) track.enabled = true;
    return this.#setState({ local_media: "active" });
  }

  stopLocalMedia(): BrowserRealtimeVoiceState {
    if (this.#state.local_media === "stopped") return this.#state;
    if (this.#state.status !== "active") throw new RealtimeVoiceOperationError("invalid_state");
    this.#stopTracks(this.#localTracks);
    this.#localTracks = [];
    return this.#setState({ local_media: "stopped" });
  }

  async interrupt(input: BrowserRealtimeVoiceOperationInput = {}): Promise<BrowserRealtimeVoiceState> {
    const signal = input.signal ?? new AbortController().signal;
    assertRealtimeVoiceAbortSignal(signal, "$operation.signal");
    throwIfRealtimeVoiceAborted(signal);
    if (
      this.#state.status !== "active" ||
      this.#state.capabilities?.interruption.supported !== true ||
      this.#channel === null ||
      this.#channel.readyState !== "open"
    ) throw new RealtimeVoiceOperationError("invalid_state");
    const message = JSON.stringify(Object.freeze({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      type: "interrupt",
      session_id: this.#state.session_id,
    }));
    const bytes = byteLength(message);
    this.#messageCount += 1;
    if (
      this.#messageCount > this.#maximumMessages ||
      bytes > this.#maximumMessageBytes ||
      !Number.isFinite(this.#channel.bufferedAmount) ||
      this.#channel.bufferedAmount < 0 ||
      this.#channel.bufferedAmount + bytes > this.#maximumBufferedBytes
    ) throw new RealtimeVoiceOperationError("invalid_state");
    this.#channel.send(message);
    return this.#setState({ response_active: false });
  }

  applyServerEvent(value: unknown): BrowserRealtimeVoiceState {
    const event = parseRealtimeVoiceSessionEvent(value);
    if (event.session_id !== this.#state.session_id) {
      throw new RealtimeVoiceValidationError("$event.session_id", "must match the browser session");
    }
    if (isTerminal(this.#state.status)) return this.#state;
    if (
      event.sequence <= this.#lastEventSequence ||
      this.#seenEventIds.has(event.event_id)
    ) return this.#state;
    this.#lastEventSequence = event.sequence;
    this.#seenEventIds.add(event.event_id);
    this.#seenEventOrder.push(event.event_id);
    if (this.#seenEventOrder.length > REALTIME_VOICE_LIMITS.trackedEventIds) {
      this.#seenEventIds.delete(this.#seenEventOrder.shift()!);
    }
    this.#emitEvent(Object.freeze({ type: "server_event", event }));
    switch (event.type) {
      case "response_started":
        if (this.#state.status === "active") return this.#setState({ response_active: true });
        return this.#state;
      case "response_interrupted":
        return this.#setState({ response_active: false });
      case "local_media_stopped":
        return this.stopLocalMedia();
      case "hangup_started":
        return this.#setState({ status: "ending", response_active: false });
      case "session_ended":
        void this.#terminate("ended", "server_shutdown", null, false);
        return this.#state;
      case "session_failed":
        void this.#terminate("failed", "failure", event.error, false);
        return this.#state;
      case "session_started":
        return this.#state;
    }
  }

  hangup(input: BrowserRealtimeVoiceOperationInput = {}): Promise<BrowserRealtimeVoiceState> {
    const signal = input.signal ?? new AbortController().signal;
    assertRealtimeVoiceAbortSignal(signal, "$operation.signal");
    try {
      throwIfRealtimeVoiceAborted(signal);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.#state.status === "idle") {
      return Promise.reject(new RealtimeVoiceOperationError("invalid_state"));
    }
    return this.#terminate("ended", "client_request", null, true);
  }

  cancel(): Promise<BrowserRealtimeVoiceState> {
    this.#operationAbort?.abort();
    if (this.#state.status === "idle") {
      return Promise.resolve(this.#setState({
        status: "cancelled",
        local_media: "stopped",
        error: realtimeVoiceSafeError("cancelled"),
      }));
    }
    return this.#terminate("cancelled", "client_request", realtimeVoiceSafeError("cancelled"), true);
  }

  async dispose(): Promise<void> {
    this.#operationAbort?.abort();
    if (this.#state.status === "disposed") return;
    await this.#terminate("disposed", "client_request", null, true);
    this.#setState({ status: "disposed" });
    this.#stateListeners.clear();
    this.#eventListeners.clear();
  }

  #assertRequiredCapabilities(capabilities: RealtimeVoiceCapabilities): void {
    const requested = this.#request.requested_capabilities;
    if (
      (requested.input_audio && !capabilities.input_audio.supported) ||
      (requested.output_audio && !capabilities.output_audio.supported) ||
      (requested.interruption && !capabilities.interruption.supported) ||
      (requested.server_tool_execution !== false && !capabilities.server_tool_execution.supported)
    ) throw new RealtimeVoiceOperationError("unsupported_capability");
  }

  #assertBootstrapUnexpired(bootstrap: RealtimeVoiceBootstrapResult): void {
    const now = this.#clock.now();
    if (
      Date.parse(bootstrap.authorization.expires_at) <= now ||
      Date.parse(bootstrap.expires_at) <= now
    ) throw new RealtimeVoiceOperationError("authorization_expired");
  }

  #scheduleExpiry(bootstrap: RealtimeVoiceBootstrapResult): void {
    const delay = Math.max(0, Math.min(
      Date.parse(bootstrap.expires_at) - this.#clock.now(),
      bootstrap.configuration.maximum_duration_ms,
    ));
    this.#expiryTimer = this.#clock.setTimeout(() => {
      void this.#terminate("ended", "session_expired", null, true);
    }, delay);
  }

  #fail(error: unknown): Promise<BrowserRealtimeVoiceState> {
    const safe = normalizeRealtimeVoiceError(error);
    return this.#terminate("failed", "failure", safe, true);
  }

  #terminate(
    status: Extract<BrowserRealtimeVoiceStatus, "ended" | "failed" | "cancelled" | "disposed">,
    reason: RealtimeVoiceHangupReason,
    error: RealtimeVoiceSafeError | null,
    authoritative: boolean,
  ): Promise<BrowserRealtimeVoiceState> {
    if (this.#terminalPromise !== null) return this.#terminalPromise;
    this.#operationAbort?.abort();
    const operation = (async () => {
      if (!isTerminal(this.#state.status)) {
        this.#setState({ status: "ending", response_active: false });
      }
      this.#closeResources();
      const finalState = this.#setState({
        status,
        local_media: "stopped",
        remote_audio_active: false,
        response_active: false,
        error,
      });
      if (authoritative) await this.#invokeHangup(reason);
      return finalState;
    })();
    this.#terminalPromise = operation;
    return operation;
  }

  #invokeHangup(reason: RealtimeVoiceHangupReason): Promise<RealtimeVoiceTerminalResult> | null {
    if (this.#bootstrapResult === null) return null;
    if (this.#hangupPromise !== null) return this.#hangupPromise;
    const bootstrap = this.#bootstrapResult;
    const controller = new AbortController();
    const request: RealtimeVoiceHangupRequest = Object.freeze({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      request_id: this.#request.request_id,
      idempotency_key: `browser-hangup:${hashIdentity(
        `${this.#request.idempotency_key}:${bootstrap.session_id}`,
      )}` as RealtimeVoiceHangupRequest["idempotency_key"],
      session_id: bootstrap.session_id,
      reason,
      signal: controller.signal,
    });
    try {
      this.#hangupPromise = Promise.resolve(this.#options.authoritativeHangup(request)).catch(() => Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: bootstrap.session_id,
        status: "ended" as const,
        ended_at: new Date(this.#clock.now()).toISOString() as RealtimeVoiceTerminalResult["ended_at"],
      }));
    } catch {
      this.#hangupPromise = Promise.resolve(Object.freeze({
        version: REALTIME_VOICE_CONTRACT_VERSION,
        session_id: bootstrap.session_id,
        status: "ended" as const,
        ended_at: new Date(this.#clock.now()).toISOString() as RealtimeVoiceTerminalResult["ended_at"],
      }));
    }
    return this.#hangupPromise;
  }

  #closeResources(): void {
    if (this.#resourcesClosed) return;
    this.#resourcesClosed = true;
    if (this.#expiryTimer !== undefined) {
      this.#clock.clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
    }
    this.#detachLifecycle();
    this.#stopTracks(this.#localTracks);
    this.#stopTracks(this.#remoteTracks);
    this.#localTracks = [];
    this.#remoteTracks = [];
    for (const resource of this.#playbackResources.splice(0)) this.#closePlayback(resource);
    if (this.#channel !== null) {
      try {
        this.#channel.removeEventListener("message", this.#onChannelMessage);
        this.#channel.removeEventListener("close", this.#onChannelClose);
        this.#channel.close();
      } catch {
        // Continue closing the remaining browser resources.
      }
      this.#channel = null;
    }
    if (this.#peer !== null) {
      try {
        this.#peer.removeEventListener("track", this.#onTrack);
        this.#peer.removeEventListener("connectionstatechange", this.#onConnectionStateChange);
        this.#peer.close();
      } catch {
        // All sensitive references are still dropped below.
      }
      this.#peer = null;
    }
  }

  #stopTracks(tracks: readonly BrowserRealtimeVoiceTrack[]): void {
    for (const track of tracks) {
      if (this.#stoppedTracks.has(track)) continue;
      this.#stoppedTracks.add(track);
      try {
        track.stop();
      } catch {
        // Continue closing the remaining tracks.
      }
    }
  }

  #closePlayback(resource: BrowserRealtimeVoicePlaybackResource): void {
    if (this.#closedPlaybackResources.has(resource)) return;
    this.#closedPlaybackResources.add(resource);
    try {
      resource.close();
    } catch {
      // Continue closing the remaining resources.
    }
  }

  #attachLifecycle(): void {
    this.#lifecycle = this.#options.lifecycle ?? defaultLifecycle();
    if (this.#lifecycle === undefined || this.#lifecycleAttached) return;
    this.#lifecycleAttached = true;
    this.#lifecycle.addEventListener("pagehide", this.#onPageHide);
    this.#lifecycle.addEventListener("beforeunload", this.#onPageHide);
  }

  #detachLifecycle(): void {
    if (this.#lifecycle === undefined || !this.#lifecycleAttached) return;
    this.#lifecycleAttached = false;
    this.#lifecycle.removeEventListener("pagehide", this.#onPageHide);
    this.#lifecycle.removeEventListener("beforeunload", this.#onPageHide);
  }

  #setState(patch: Partial<BrowserRealtimeVoiceState>): BrowserRealtimeVoiceState {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of [...this.#stateListeners]) listener(this.#state);
    this.#emitEvent(Object.freeze({ type: "state_changed", state: this.#state }));
    return this.#state;
  }

  #emitEvent(event: BrowserRealtimeVoiceEvent): void {
    for (const listener of [...this.#eventListeners]) listener(event);
  }
}

/**
 * Creates a provider-neutral WebRTC controller. Browser globals are resolved only by `start()`.
 * The controller accepts no provider parser, client tool callback, or long-lived credential.
 */
export function createBrowserRealtimeVoiceController(
  options: BrowserRealtimeVoiceControllerOptions,
): BrowserRealtimeVoiceController {
  return new BrowserRealtimeVoiceControllerImpl(options);
}
