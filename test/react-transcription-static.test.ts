import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  TranscriptionControlsCancel,
  TranscriptionControlsRetry,
  TranscriptionControlsRoot,
  TranscriptionControlsStart,
  TranscriptionControlsStatus,
  TranscriptionControlsStop,
  useTranscriptionControls,
} from "../src/react/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("React transcription package boundary", () => {
  it("exports the hook and all unstyled controls from the optional React entry", () => {
    expect(typeof useTranscriptionControls).toBe("function");
    for (const primitive of [
      TranscriptionControlsRoot,
      TranscriptionControlsStatus,
      TranscriptionControlsStart,
      TranscriptionControlsStop,
      TranscriptionControlsCancel,
      TranscriptionControlsRetry,
    ]) {
      expect(typeof primitive).toBe("object");
    }
  });

  it("imports no styles, provider/server adapters, persistence, or application code", () => {
    const source = readFileSync(
      path.join(packageRoot, "src/react/transcription.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:from\s+|import\s*)["'][^"']*\.(?:css|less|sass|scss)["']/u,
    );
    expect(source).not.toMatch(/(?:^|\/)providers(?:\/|["'])/mu);
    expect(source).not.toMatch(/(?:^|\/)server(?:\/|["'])/mu);
    expect(source).not.toMatch(/indexeddb|localstorage|sessionstorage|react-router|next\/navigation/iu);
    expect(source).not.toMatch(/navigator|MediaRecorder|document|window/);
  });
});
