import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  RealtimeVoiceCancel,
  RealtimeVoiceCapabilities,
  RealtimeVoiceControlsContext,
  RealtimeVoiceControlsRoot,
  RealtimeVoiceControlsStatus,
  RealtimeVoiceEndSession,
  RealtimeVoiceInterrupt,
  RealtimeVoiceMute,
  RealtimeVoiceStart,
  RealtimeVoiceStopMicrophone,
  RealtimeVoiceUnmute,
  useRealtimeVoiceControls,
  useRealtimeVoiceControlsContext,
} from "../src/react/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("React realtime voice package boundary", () => {
  it("exports the hook, context, model root, status, capability, and action primitives", () => {
    expect(typeof useRealtimeVoiceControls).toBe("function");
    expect(typeof useRealtimeVoiceControlsContext).toBe("function");
    expect(typeof RealtimeVoiceControlsContext).toBe("object");
    for (const primitive of [
      RealtimeVoiceControlsRoot,
      RealtimeVoiceControlsStatus,
      RealtimeVoiceCapabilities,
      RealtimeVoiceStart,
      RealtimeVoiceMute,
      RealtimeVoiceUnmute,
      RealtimeVoiceStopMicrophone,
      RealtimeVoiceInterrupt,
      RealtimeVoiceEndSession,
      RealtimeVoiceCancel,
    ]) expect(typeof primitive).toBe("object");
  });

  it("imports no styles, provider/server modules, credentials, tools, or application code", () => {
    const source = readFileSync(path.join(
      packageRoot,
      "src/react/realtime-voice.tsx",
    ), "utf8");
    expect(source).not.toMatch(/(?:from\s+|import\s*)["'][^"']*\.(?:css|less|sass|scss)["']/u);
    expect(source).not.toMatch(/(?:^|\/)providers(?:\/|["'])/mu);
    expect(source).not.toMatch(/(?:^|\/)server(?:\/|["'])/mu);
    expect(source).not.toMatch(/indexeddb|localstorage|sessionstorage|tool-bridge/iu);
    expect(source).not.toMatch(
      /(?:from\s+|import\s*)["'][^"']*(?:credential|authorization|tool)[^"']*["']/iu,
    );
    expect(source).not.toMatch(/navigator|RTCPeerConnection|MediaRecorder|window/);
  });

  it("keeps the checked recipe credential-free and provider-neutral", () => {
    const source = readFileSync(path.join(
      packageRoot,
      "examples/react-realtime-voice.tsx",
    ), "utf8");
    expect(source).not.toMatch(/@handrail\/ai\/providers|trusted-server|api[_-]?key|bearer|token/iu);
    expect(source).not.toMatch(/tool(?:Input|Result|Executor|Execution)/u);
  });
});
