/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BrowserRealtimeVoiceController,
  BrowserRealtimeVoiceEvent,
  BrowserRealtimeVoiceState,
} from "../src/browser/index.js";
import {
  RealtimeVoiceCancel,
  RealtimeVoiceCapabilities,
  RealtimeVoiceControlsRoot,
  RealtimeVoiceControlsStatus,
  RealtimeVoiceEndSession,
  RealtimeVoiceInterrupt,
  RealtimeVoiceMute,
  RealtimeVoiceStart,
  RealtimeVoiceStopMicrophone,
  RealtimeVoiceUnmute,
  useRealtimeVoiceControls,
  type UseRealtimeVoiceControlsOptions,
} from "../src/react/index.js";

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const supportedCapabilities = Object.freeze({
  input_audio: { supported: true },
  output_audio: { supported: true },
  interruption: { supported: true },
  server_tool_execution: { supported: false, reason: "server_tools_not_configured" },
} as const);

function voiceState(
  patch: Partial<BrowserRealtimeVoiceState> = {},
): BrowserRealtimeVoiceState {
  return Object.freeze({
    status: "idle",
    request_id: "request_react" as BrowserRealtimeVoiceState["request_id"],
    session_id: null,
    configuration: null,
    capabilities: null,
    local_media: "inactive",
    remote_audio_active: false,
    response_active: false,
    error: null,
    ...patch,
  });
}

class FakeVoiceController implements BrowserRealtimeVoiceController {
  private state: BrowserRealtimeVoiceState;
  private readonly listeners = new Set<(state: BrowserRealtimeVoiceState) => void>();
  readonly start = vi.fn(async () => this.publish(voiceState({
    status: "active",
    session_id: "session_react" as BrowserRealtimeVoiceState["session_id"],
    capabilities: supportedCapabilities,
    local_media: "active",
  })));
  readonly mute = vi.fn(() => this.publish({ ...this.state, local_media: "muted" }));
  readonly unmute = vi.fn(() => this.publish({ ...this.state, local_media: "active" }));
  readonly stopLocalMedia = vi.fn(() =>
    this.publish({ ...this.state, local_media: "stopped" }));
  readonly interrupt = vi.fn(async () =>
    this.publish({ ...this.state, response_active: false }));
  readonly hangup = vi.fn(async () =>
    this.publish({ ...this.state, status: "ended", response_active: false }));
  readonly cancel = vi.fn(async () =>
    this.publish({ ...this.state, status: "cancelled" }));
  readonly dispose = vi.fn(async () => undefined);

  constructor(initial = voiceState()) {
    this.state = initial;
  }

  getState(): BrowserRealtimeVoiceState { return this.state; }
  subscribe(listener: (state: BrowserRealtimeVoiceState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
  subscribeEvents(listener: (event: BrowserRealtimeVoiceEvent) => void): () => void {
    void listener;
    return () => undefined;
  }
  applyServerEvent(event: unknown): BrowserRealtimeVoiceState {
    void event;
    return this.state;
  }
  publish(state: BrowserRealtimeVoiceState): BrowserRealtimeVoiceState {
    this.state = Object.freeze(state);
    for (const listener of [...this.listeners]) listener(this.state);
    return this.state;
  }
}

function Controls({ options }: { readonly options: UseRealtimeVoiceControlsOptions }) {
  const voice = useRealtimeVoiceControls(options);
  return (
    <RealtimeVoiceControlsRoot controller={voice} aria-label="Voice controls">
      <RealtimeVoiceControlsStatus />
      <RealtimeVoiceCapabilities />
      <RealtimeVoiceStart />
      <RealtimeVoiceMute />
      <RealtimeVoiceUnmute />
      <RealtimeVoiceStopMicrophone />
      <RealtimeVoiceInterrupt />
      <RealtimeVoiceEndSession />
      <RealtimeVoiceCancel />
    </RealtimeVoiceControlsRoot>
  );
}

describe("RealtimeVoiceControls", () => {
  it("never starts on SSR, render, or mount and uses a native activation control", () => {
    const external = new FakeVoiceController();
    const html = renderToString(<Controls options={{ controller: external }} />);
    expect(html).toContain("Ready to start voice session");
    expect(external.start).not.toHaveBeenCalled();

    render(<Controls options={{ controller: external }} />);
    const start = screen.getByRole("button", { name: "Start voice session" });
    expect(start.tagName).toBe("BUTTON");
    expect(start.getAttribute("type")).toBe("button");
    expect(external.start).not.toHaveBeenCalled();
  });

  it("starts from pointer and keyboard activation and suppresses duplicate starts", async () => {
    const external = new FakeVoiceController();
    const pending = deferred<BrowserRealtimeVoiceState>();
    external.start.mockImplementation(() => {
      external.publish(voiceState({ status: "starting", local_media: "requesting" }));
      return pending.promise;
    });
    render(<Controls options={{ controller: external }} />);
    const start = screen.getByRole("button", { name: "Start voice session" });
    fireEvent.pointerDown(start);
    fireEvent.click(start);
    fireEvent.click(start);
    expect(external.start).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(true));

    pending.resolve(external.publish(voiceState({
      status: "active",
      capabilities: supportedCapabilities,
      local_media: "active",
    })));
    await pending.promise;
    external.publish(voiceState());
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    start.focus();
    fireEvent.keyDown(start, { key: "Enter" });
    fireEvent.click(start, { detail: 0 });
    expect(external.start).toHaveBeenCalledTimes(2);
  });

  it("keeps interruption, local microphone stop, mute, and authoritative hangup distinct", async () => {
    const external = new FakeVoiceController(voiceState({
      status: "active",
      capabilities: supportedCapabilities,
      local_media: "active",
      response_active: true,
    }));
    render(<Controls options={{ controller: external }} />);

    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(external.mute).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    expect(external.unmute).toHaveBeenCalledOnce();
    external.publish({ ...external.getState(), response_active: true });
    fireEvent.click(screen.getByRole("button", { name: "Interrupt voice response" }));
    await waitFor(() => expect(external.interrupt).toHaveBeenCalledOnce());
    expect(external.hangup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Stop microphone" }));
    expect(external.stopLocalMedia).toHaveBeenCalledOnce();
    expect(external.getState().status).toBe("active");
    expect(external.hangup).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "End voice session" }));
    await waitFor(() => expect(external.hangup).toHaveBeenCalledOnce());
    expect(external.getState().status).toBe("ended");
  });

  it("surfaces negotiated supported and unsupported descriptors without opaque references", () => {
    const external = new FakeVoiceController(voiceState({
      status: "active",
      capabilities: supportedCapabilities,
      local_media: "active",
    }));
    render(<Controls options={{ controller: external }} />);
    expect(screen.getByText("Microphone input: supported")).toBeTruthy();
    expect(screen.getByText("Interruption: supported")).toBeTruthy();
    expect(screen.getByText("Server tools: unsupported (not configured)")).toBeTruthy();
    expect(screen.getByLabelText("Voice capabilities").textContent).not.toContain("capability_ref");
  });

  it("disables interruption unless both negotiation and live response state permit it", () => {
    const external = new FakeVoiceController(voiceState({
      status: "active",
      capabilities: {
        ...supportedCapabilities,
        interruption: { supported: false, reason: "provider_not_supported" },
      },
      response_active: true,
    }));
    render(<Controls options={{ controller: external }} />);
    const interrupt = screen.getByRole("button", { name: "Interrupt voice response" });
    expect((interrupt as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Interruption: unsupported (not supported)")).toBeTruthy();
    external.publish({ ...external.getState(), capabilities: supportedCapabilities, response_active: false });
    expect((interrupt as HTMLButtonElement).disabled).toBe(true);
  });

  it("announces bounded safe lifecycle errors and never transcript or audio contents", async () => {
    const external = new FakeVoiceController(voiceState({
      status: "failed",
      error: {
        code: "authorization_expired",
        message: "The realtime voice authorization has expired.",
        retryable: false,
      },
    }));
    render(<Controls options={{ controller: external }} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Voice authorization expired");
    expect(status.textContent).not.toContain("private transcript");
    expect(status.textContent).not.toContain("audio");

    external.publish(voiceState({
      status: "failed",
      error: { code: "temporarily_unavailable", message: "unsafe native detail", retryable: true },
    }));
    await waitFor(() => expect(status.textContent).toBe("Voice is temporarily unavailable"));
    expect(status.textContent).not.toContain("unsafe native detail");
  });

  it("restores focus to the stable root after terminal hangup", async () => {
    const external = new FakeVoiceController(voiceState({
      status: "active",
      capabilities: supportedCapabilities,
      local_media: "active",
    }));
    render(<Controls options={{ controller: external }} />);
    const end = screen.getByRole("button", { name: "End voice session" });
    end.focus();
    fireEvent.click(end);
    const root = screen.getByLabelText("Voice controls");
    await waitFor(() => expect(document.activeElement).toBe(root));
  });

  it("unsubscribes from replaced controllers and ignores their stale updates", async () => {
    const first = new FakeVoiceController();
    const second = new FakeVoiceController();
    const rendered = render(<Controls options={{ controller: first }} />);
    rendered.rerender(<Controls options={{ controller: second }} />);
    first.publish(voiceState({ status: "failed", error: {
      code: "internal_failure",
      message: "private first error",
      retryable: false,
    } }));
    expect(screen.getByRole("status").textContent).toBe("Ready to start voice session");
    second.publish(voiceState({ status: "ended" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(
      "Voice session ended",
    ));
  });

  it("suppresses stale promise completions after replacement and unmount", async () => {
    const first = new FakeVoiceController();
    const firstStart = deferred<BrowserRealtimeVoiceState>();
    first.start.mockImplementation(() => firstStart.promise);
    const second = new FakeVoiceController();
    const rendered = render(<Controls options={{ controller: first }} />);
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }));
    rendered.rerender(<Controls options={{ controller: second }} />);
    fireEvent.click(screen.getByRole("button", { name: "Start voice session" }));
    await waitFor(() => expect(second.start).toHaveBeenCalledOnce());
    firstStart.resolve(voiceState({ status: "failed", error: {
      code: "internal_failure",
      message: "stale private detail",
      retryable: false,
    } }));
    await firstStart.promise;
    expect(screen.getByRole("status").textContent).toBe("Voice session active");

    rendered.unmount();
    await Promise.resolve();
    expect(first.dispose).not.toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("does not dispose external controllers on replacement or unmount", async () => {
    const first = new FakeVoiceController();
    const second = new FakeVoiceController();
    const rendered = render(<Controls options={{ controller: first }} />);
    rendered.rerender(<Controls options={{ controller: second }} />);
    rendered.unmount();
    await Promise.resolve();
    expect(first.dispose).not.toHaveBeenCalled();
    expect(second.dispose).not.toHaveBeenCalled();
  });

  it("creates owned controllers only after mount and disposes once after StrictMode final unmount", async () => {
    const owned = new FakeVoiceController();
    const createController = vi.fn(() => owned);
    expect(renderToString(<Controls options={{ createController }} />)).toContain(
      "Ready to start voice session",
    );
    expect(createController).not.toHaveBeenCalled();

    const rendered = render(
      <StrictMode><Controls options={{ createController }} /></StrictMode>,
    );
    await waitFor(() => expect(createController).toHaveBeenCalledTimes(1));
    expect(owned.start).not.toHaveBeenCalled();
    expect(owned.dispose).not.toHaveBeenCalled();
    rendered.unmount();
    await waitFor(() => expect(owned.dispose).toHaveBeenCalledTimes(1));
  });

  it("disposes a replaced owned controller while keeping the replacement alive", async () => {
    const first = new FakeVoiceController();
    const second = new FakeVoiceController();
    const firstFactory = () => first;
    const secondFactory = () => second;
    const rendered = render(<Controls options={{ createController: firstFactory }} />);
    await waitFor(() => expect((screen.getByRole("button", {
      name: "Start voice session",
    }) as HTMLButtonElement).disabled).toBe(false));
    rendered.rerender(<Controls options={{ createController: secondFactory }} />);
    await waitFor(() => expect(first.dispose).toHaveBeenCalledTimes(1));
    expect(second.dispose).not.toHaveBeenCalled();
    rendered.unmount();
    await waitFor(() => expect(second.dispose).toHaveBeenCalledTimes(1));
  });
});
