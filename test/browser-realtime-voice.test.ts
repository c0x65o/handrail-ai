import { describe, expect, it, vi } from "vitest";

import {
  BROWSER_REALTIME_VOICE_LIMITS,
  createBrowserRealtimeVoiceController,
  type BrowserRealtimeVoiceClock,
  type BrowserRealtimeVoiceDataChannel,
  type BrowserRealtimeVoiceEventListener,
  type BrowserRealtimeVoiceLifecycleHooks,
  type BrowserRealtimeVoicePeerConnection,
  type BrowserRealtimeVoicePlaybackResource,
  type BrowserRealtimeVoiceStream,
  type BrowserRealtimeVoiceTrack,
} from "../src/browser/index.js";
import {
  REALTIME_VOICE_CONTRACT_VERSION,
  type RealtimeVoiceBootstrapRequest,
  type RealtimeVoiceBootstrapResult,
  type RealtimeVoiceSessionEvent,
  type RealtimeVoiceTerminalResult,
} from "../src/realtime/types.js";
import {
  RealtimeVoiceOperationError,
  parseRealtimeVoiceBootstrapRequest,
  parseRealtimeVoiceBootstrapResult,
  realtimeVoiceSafeError,
} from "../src/realtime/validation.js";

const NOW = Date.parse("2026-08-29T12:00:00.000Z");
const timestamp = (offset: number) => new Date(NOW + offset).toISOString();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeTrack implements BrowserRealtimeVoiceTrack {
  enabled = true;
  stopCount = 0;

  stop(): void {
    this.stopCount += 1;
  }
}

class FakeStream implements BrowserRealtimeVoiceStream {
  constructor(readonly tracks: readonly FakeTrack[]) {}

  getTracks(): readonly FakeTrack[] {
    return this.tracks;
  }
}

class FakeDataChannel implements BrowserRealtimeVoiceDataChannel {
  readyState = "open";
  bufferedAmount = 0;
  closeCount = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Set<BrowserRealtimeVoiceEventListener>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCount += 1;
    this.readyState = "closed";
    this.emit("close", {});
  }

  addEventListener(type: string, listener: BrowserRealtimeVoiceEventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: BrowserRealtimeVoiceEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakePeer implements BrowserRealtimeVoicePeerConnection {
  connectionState = "new";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  readonly channel = new FakeDataChannel();
  readonly addedTracks: BrowserRealtimeVoiceTrack[] = [];
  readonly listeners = new Map<string, Set<BrowserRealtimeVoiceEventListener>>();
  closeCount = 0;
  setLocal: Promise<void> = Promise.resolve();
  setRemote: Promise<void> = Promise.resolve();
  offer: Promise<{ type: string; sdp: string }> = Promise.resolve({
    type: "offer",
    sdp: "v=0\r\no=browser-offer\r\n",
  });

  addTrack(track: BrowserRealtimeVoiceTrack): void {
    this.addedTracks.push(track);
  }

  createDataChannel(): FakeDataChannel {
    return this.channel;
  }

  createOffer(): Promise<{ type: string; sdp: string }> {
    return this.offer;
  }

  async setLocalDescription(description: { type: "offer" | "answer"; sdp: string }): Promise<void> {
    await this.setLocal;
    this.localDescription = description;
  }

  async setRemoteDescription(description: { type: "offer" | "answer"; sdp: string }): Promise<void> {
    await this.setRemote;
    this.remoteDescription = description;
  }

  close(): void {
    this.closeCount += 1;
    this.connectionState = "closed";
  }

  addEventListener(type: string, listener: BrowserRealtimeVoiceEventListener): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: BrowserRealtimeVoiceEventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakeClock implements BrowserRealtimeVoiceClock {
  current = NOW;
  nextHandle = 1;
  readonly timers = new Map<number, { due: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.timers.set(handle, { due: this.current + delayMs, callback });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const [handle, timer] of [...this.timers]) {
      if (timer.due > this.current) continue;
      this.timers.delete(handle);
      timer.callback();
    }
  }
}

class FakeLifecycle implements BrowserRealtimeVoiceLifecycleHooks {
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: "pagehide" | "beforeunload", listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "pagehide" | "beforeunload", listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: "pagehide" | "beforeunload"): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

function requestValue(overrides: Record<string, unknown> = {}) {
  return {
    version: REALTIME_VOICE_CONTRACT_VERSION,
    request_id: "browser-request-1",
    idempotency_key: "browser-start:conversation-1",
    configuration: {
      transport: "webrtc",
      maximum_duration_ms: 600_000,
      idle_timeout_ms: 60_000,
      input_audio: { encoding: "opus", sample_rate_hz: 48_000, channels: 1 },
      output_audio: { encoding: "opus", sample_rate_hz: 48_000, channels: 2 },
    },
    requested_capabilities: {
      input_audio: true,
      output_audio: true,
      interruption: true,
      server_tool_execution: false,
    },
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}): RealtimeVoiceBootstrapRequest {
  return parseRealtimeVoiceBootstrapRequest(requestValue(overrides));
}

function resultValue(
  bootstrapRequest: RealtimeVoiceBootstrapRequest,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: REALTIME_VOICE_CONTRACT_VERSION,
    request_id: bootstrapRequest.request_id,
    session_id: "browser-session-1",
    issued_at: timestamp(0),
    expires_at: timestamp(600_000),
    authorization: {
      kind: "opaque_ephemeral",
      value: "opaque_ephemeral_authorization_123",
      expires_at: timestamp(120_000),
    },
    connection: { transport: "webrtc", reference: "connection:browser-session-1" },
    configuration: bootstrapRequest.configuration,
    capabilities: {
      input_audio: { supported: true },
      output_audio: { supported: true },
      interruption: { supported: true },
      server_tool_execution: { supported: false, reason: "not_requested" },
    },
    ...overrides,
  };
}

const serverEvent = (
  sequence: number,
  type: RealtimeVoiceSessionEvent["type"],
  overrides: Record<string, unknown> = {},
) => ({
  version: REALTIME_VOICE_CONTRACT_VERSION,
  session_id: "browser-session-1",
  event_id: `browser-event-${sequence}`,
  sequence,
  occurred_at: timestamp(sequence),
  type,
  ...(type === "session_failed"
    ? { error: realtimeVoiceSafeError("temporarily_unavailable") }
    : {}),
  ...overrides,
});

function setup(overrides: {
  request?: RealtimeVoiceBootstrapRequest;
  bootstrap?: (request: RealtimeVoiceBootstrapRequest, operation: { signal: AbortSignal }) => Promise<RealtimeVoiceBootstrapResult>;
  exchangeSdp?: (input: { readonly offer_sdp: string; readonly signal: AbortSignal }) => Promise<{ answer_sdp: string }>;
  getUserMedia?: () => Promise<BrowserRealtimeVoiceStream>;
  maxMessages?: number;
} = {}) {
  const bootstrapRequest = overrides.request ?? request();
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const peer = new FakePeer();
  const clock = new FakeClock();
  const lifecycle = new FakeLifecycle();
  const playback: BrowserRealtimeVoicePlaybackResource & { closeCount: number } = {
    closeCount: 0,
    close() { this.closeCount += 1; },
  };
  const bootstrap = vi.fn(overrides.bootstrap ?? (async () =>
    parseRealtimeVoiceBootstrapResult(resultValue(bootstrapRequest), {
      request: bootstrapRequest,
      now: NOW,
    })));
  const exchangeSdp = vi.fn(overrides.exchangeSdp ?? (async () => ({
    answer_sdp: "v=0\r\no=trusted-server-answer\r\n",
  })));
  const authoritativeHangup = vi.fn(async (input) => ({
    version: REALTIME_VOICE_CONTRACT_VERSION,
    session_id: input.session_id,
    status: "ended" as const,
    ended_at: timestamp(1) as RealtimeVoiceTerminalResult["ended_at"],
  }));
  const getUserMedia = vi.fn(overrides.getUserMedia ?? (async () => stream));
  const controller = createBrowserRealtimeVoiceController({
    request: bootstrapRequest,
    bootstrap,
    exchangeSdp,
    authoritativeHangup,
    peerConnectionFactory: () => peer,
    mediaDevices: { getUserMedia },
    playRemoteAudio: async () => playback,
    lifecycle,
    clock,
    ...(overrides.maxMessages === undefined
      ? {}
      : { maximumDataChannelMessages: overrides.maxMessages }),
  });
  return {
    controller,
    bootstrapRequest,
    bootstrap,
    exchangeSdp,
    authoritativeHangup,
    getUserMedia,
    track,
    stream,
    peer,
    clock,
    lifecycle,
    playback,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("browser realtime voice controller", () => {
  it("negotiates validated SDP and exposes authorization-free immutable state", async () => {
    const test = setup();
    const states: string[] = [];
    test.controller.subscribe((state) => states.push(state.status));

    const state = await test.controller.start();

    expect(test.bootstrap).toHaveBeenCalledWith(test.bootstrapRequest, {
      signal: expect.any(AbortSignal),
    });
    expect(test.getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(test.peer.addedTracks).toEqual([test.track]);
    expect(test.peer.localDescription?.sdp).toContain("browser-offer");
    expect(test.peer.remoteDescription?.sdp).toContain("trusted-server-answer");
    expect(test.exchangeSdp).toHaveBeenCalledWith(expect.objectContaining({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      request_id: "browser-request-1",
      session_id: "browser-session-1",
      offer_sdp: expect.stringContaining("browser-offer"),
      authorization: expect.objectContaining({ kind: "opaque_ephemeral" }),
      connection: { transport: "webrtc", reference: "connection:browser-session-1" },
      signal: expect.any(AbortSignal),
    }));
    expect(state).toMatchObject({
      status: "active",
      session_id: "browser-session-1",
      local_media: "active",
    });
    expect(Object.isFrozen(state)).toBe(true);
    expect(JSON.stringify(state)).not.toMatch(/authorization|connection|offer|answer|opaque_ephemeral/);
    expect(states).toContain("starting");
    await expect(test.controller.start()).resolves.toBe(state);
    expect(test.bootstrap).toHaveBeenCalledTimes(1);
  });

  it("narrows unrequested capabilities and rejects unsupported required capabilities safely", async () => {
    const outputOnlyRequest = request({
      configuration: {
        ...requestValue().configuration as object,
        input_audio: null,
      },
      requested_capabilities: {
        input_audio: false,
        output_audio: true,
        interruption: false,
        server_tool_execution: false,
      },
    });
    const narrowed = setup({
      request: outputOnlyRequest,
      bootstrap: async () => parseRealtimeVoiceBootstrapResult(resultValue(outputOnlyRequest, {
        capabilities: {
          input_audio: { supported: true },
          output_audio: { supported: true },
          interruption: { supported: true },
          server_tool_execution: { supported: false, reason: "not_requested" },
        },
      }), { request: outputOnlyRequest, now: NOW }),
    });
    await narrowed.controller.start();
    expect(narrowed.controller.getState().capabilities).toMatchObject({
      input_audio: { supported: false, reason: "not_requested" },
      interruption: { supported: false, reason: "not_requested" },
    });
    expect(narrowed.getUserMedia).not.toHaveBeenCalled();

    const required = request();
    const unsupported = setup({
      request: required,
      bootstrap: async () => parseRealtimeVoiceBootstrapResult(resultValue(required, {
        capabilities: {
          input_audio: { supported: true },
          output_audio: { supported: false, reason: "provider_not_supported" },
          interruption: { supported: true },
          server_tool_execution: { supported: false, reason: "not_requested" },
        },
      }), { request: required, now: NOW }),
    });
    await expect(unsupported.controller.start()).rejects.toEqual(
      new RealtimeVoiceOperationError("unsupported_capability"),
    );
    expect(unsupported.controller.getState()).toMatchObject({
      status: "failed",
      error: { code: "unsupported_capability" },
    });
    expect(unsupported.authoritativeHangup).toHaveBeenCalledTimes(1);
    expect(unsupported.getUserMedia).not.toHaveBeenCalled();
  });

  it("handles bootstrap and microphone permission failures without retaining native details", async () => {
    const bootstrapFailure = setup({
      bootstrap: async () => {
        throw new Error("provider payload and credential details");
      },
    });
    await expect(bootstrapFailure.controller.start()).rejects.toEqual(
      new RealtimeVoiceOperationError("internal_failure"),
    );
    expect(JSON.stringify(bootstrapFailure.controller.getState())).not.toContain("provider payload");
    expect(bootstrapFailure.authoritativeHangup).not.toHaveBeenCalled();

    const permissionFailure = setup({
      getUserMedia: async () => {
        throw new Error("device name and browser permission details");
      },
    });
    await expect(permissionFailure.controller.start()).rejects.toEqual(
      new RealtimeVoiceOperationError("invalid_state"),
    );
    expect(permissionFailure.authoritativeHangup).toHaveBeenCalledTimes(1);
    expect(permissionFailure.peer.closeCount).toBe(1);
    expect(permissionFailure.peer.channel.closeCount).toBe(1);
    expect(JSON.stringify(permissionFailure.controller.getState())).not.toContain("device name");
  });

  it("mutes, irreversibly stops local media, and interrupts without authoritative hangup", async () => {
    const test = setup();
    await test.controller.start();
    test.controller.applyServerEvent(serverEvent(1, "response_started"));

    expect(test.controller.mute().local_media).toBe("muted");
    expect(test.track.enabled).toBe(false);
    expect(test.controller.mute().local_media).toBe("muted");
    expect(test.controller.unmute().local_media).toBe("active");
    expect(test.track.enabled).toBe(true);
    await expect(test.controller.interrupt()).resolves.toMatchObject({
      response_active: false,
    });
    expect(JSON.parse(test.peer.channel.sent[0]!)).toEqual({
      version: REALTIME_VOICE_CONTRACT_VERSION,
      type: "interrupt",
      session_id: "browser-session-1",
    });
    expect(test.controller.stopLocalMedia().local_media).toBe("stopped");
    expect(test.controller.stopLocalMedia().local_media).toBe("stopped");
    expect(test.track.stopCount).toBe(1);
    expect(() => test.controller.unmute()).toThrowError(RealtimeVoiceOperationError);
    expect(test.authoritativeHangup).not.toHaveBeenCalled();

    await test.controller.hangup();
    await test.controller.hangup();
    expect(test.authoritativeHangup).toHaveBeenCalledTimes(1);
    expect(test.peer.closeCount).toBe(1);
    expect(test.peer.channel.closeCount).toBe(1);
  });

  it("plays remote audio and handles duplicate remote terminal events with exact-once cleanup", async () => {
    const test = setup();
    const remoteTrack = new FakeTrack();
    const remoteStream = new FakeStream([remoteTrack]);
    await test.controller.start();
    test.peer.emit("track", { track: remoteTrack, streams: [remoteStream] });
    await flush();
    expect(test.controller.getState().remote_audio_active).toBe(true);

    const ended = serverEvent(4, "session_ended");
    expect(test.controller.applyServerEvent(ended).status).toBe("ended");
    expect(test.controller.applyServerEvent(ended).status).toBe("ended");
    test.peer.channel.emit("close", {});
    test.peer.emit("connectionstatechange", {});
    await flush();
    expect(test.authoritativeHangup).not.toHaveBeenCalled();
    expect(test.track.stopCount).toBe(1);
    expect(remoteTrack.stopCount).toBe(1);
    expect(test.playback.closeCount).toBe(1);
    expect(test.peer.closeCount).toBe(1);
    expect(test.peer.channel.closeCount).toBe(1);
  });

  it("expires at the bounded server lifetime and hangs up authoritatively once", async () => {
    const test = setup();
    await test.controller.start();
    test.clock.advance(600_000);
    await flush();
    expect(test.controller.getState().status).toBe("ended");
    expect(test.authoritativeHangup).toHaveBeenCalledWith(expect.objectContaining({
      reason: "session_expired",
      session_id: "browser-session-1",
    }));
    expect(test.authoritativeHangup).toHaveBeenCalledTimes(1);
  });

  it("cancels a late bootstrap and closes the newly resolved server session", async () => {
    const late = deferred<RealtimeVoiceBootstrapResult>();
    const test = setup({ bootstrap: async () => late.promise });
    const started = test.controller.start();
    await flush();
    await test.controller.cancel();
    await expect(started).rejects.toEqual(new RealtimeVoiceOperationError("cancelled"));
    expect(test.authoritativeHangup).not.toHaveBeenCalled();

    late.resolve(parseRealtimeVoiceBootstrapResult(resultValue(test.bootstrapRequest), {
      request: test.bootstrapRequest,
      now: NOW,
    }));
    await flush();
    expect(test.authoritativeHangup).toHaveBeenCalledTimes(1);
    expect(test.getUserMedia).not.toHaveBeenCalled();
    expect(test.controller.getState()).toMatchObject({ status: "cancelled" });
  });

  it("stops a late microphone stream and closes negotiation resources in cancellation races", async () => {
    const lateMedia = deferred<BrowserRealtimeVoiceStream>();
    const media = setup({ getUserMedia: async () => lateMedia.promise });
    const mediaStart = media.controller.start();
    await flush();
    await media.controller.cancel();
    await expect(mediaStart).rejects.toEqual(new RealtimeVoiceOperationError("cancelled"));
    lateMedia.resolve(media.stream);
    await flush();
    expect(media.track.stopCount).toBe(1);
    expect(media.authoritativeHangup).toHaveBeenCalledTimes(1);
    expect(media.peer.closeCount).toBe(1);

    const lateAnswer = deferred<{ answer_sdp: string }>();
    const negotiation = setup({ exchangeSdp: async () => lateAnswer.promise });
    const negotiationStart = negotiation.controller.start();
    await flush();
    await negotiation.controller.cancel();
    await expect(negotiationStart).rejects.toEqual(new RealtimeVoiceOperationError("cancelled"));
    lateAnswer.resolve({ answer_sdp: "v=0\r\no=late-answer\r\n" });
    await flush();
    expect(negotiation.peer.remoteDescription).toBeNull();
    expect(negotiation.track.stopCount).toBe(1);
    expect(negotiation.authoritativeHangup).toHaveBeenCalledTimes(1);
  });

  it("cancels at offer, local-description, and remote-description async boundaries", async () => {
    for (const boundary of ["offer", "local", "remote"] as const) {
      const pending = deferred<void>();
      const test = setup();
      if (boundary === "offer") {
        test.peer.offer = pending.promise.then(() => ({
          type: "offer",
          sdp: "v=0\r\no=late-offer\r\n",
        }));
      } else if (boundary === "local") {
        test.peer.setLocal = pending.promise;
      } else {
        test.peer.setRemote = pending.promise;
      }
      const started = test.controller.start();
      await flush();
      await test.controller.cancel();
      await expect(started).rejects.toEqual(new RealtimeVoiceOperationError("cancelled"));
      pending.resolve(undefined);
      await flush();
      expect(test.controller.getState().status).toBe("cancelled");
      expect(test.track.stopCount).toBe(1);
      expect(test.peer.closeCount).toBe(1);
      expect(test.peer.channel.closeCount).toBe(1);
      expect(test.authoritativeHangup).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds SDP, data-channel messages, counts, and buffered interruption data", async () => {
    const oversizedSdp = setup({
      exchangeSdp: async () => ({
        answer_sdp: "x".repeat(BROWSER_REALTIME_VOICE_LIMITS.maximumSdpBytes + 1),
      }),
    });
    await expect(oversizedSdp.controller.start()).rejects.toEqual(
      new RealtimeVoiceOperationError("internal_failure"),
    );
    expect(oversizedSdp.authoritativeHangup).toHaveBeenCalledTimes(1);

    const messages = setup({ maxMessages: 1 });
    await messages.controller.start();
    messages.peer.channel.emit("message", {
      data: JSON.stringify(serverEvent(1, "response_started")),
    });
    messages.peer.channel.emit("message", {
      data: JSON.stringify(serverEvent(2, "response_interrupted")),
    });
    await flush();
    expect(messages.controller.getState()).toMatchObject({
      status: "failed",
      error: { code: "invalid_request" },
    });
    expect(messages.authoritativeHangup).toHaveBeenCalledTimes(1);

    const buffered = setup();
    await buffered.controller.start();
    buffered.peer.channel.bufferedAmount = BROWSER_REALTIME_VOICE_LIMITS.maximumBufferedDataChannelBytes;
    await expect(buffered.controller.interrupt()).rejects.toEqual(
      new RealtimeVoiceOperationError("invalid_state"),
    );
    expect(buffered.peer.channel.sent).toHaveLength(0);
  });

  it("cleans up on unload and dispose, and resolves all browser globals lazily", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "RTCPeerConnection");
    let accesses = 0;
    Object.defineProperty(globalThis, "RTCPeerConnection", {
      configurable: true,
      get() {
        accesses += 1;
        throw new Error("browser global accessed");
      },
    });
    try {
      const test = setup();
      expect(accesses).toBe(0);
      await test.controller.start();
      expect(accesses).toBe(0);
      test.lifecycle.emit("pagehide");
      await flush();
      expect(test.authoritativeHangup).toHaveBeenCalledTimes(1);
      expect(test.peer.closeCount).toBe(1);
      expect(test.lifecycle.listeners.get("pagehide")).toHaveLength(0);
      await test.controller.dispose();
      await test.controller.dispose();
      expect(test.controller.getState().status).toBe("disposed");
      expect(test.authoritativeHangup).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, "RTCPeerConnection");
      } else {
        Object.defineProperty(globalThis, "RTCPeerConnection", descriptor);
      }
    }
  });
});
