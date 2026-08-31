import { describe, expect, it, vi } from "vitest";
import { createAiDiagnosticLoggerSink, diagnoseAiOperation } from "../src/diagnostics.js";

describe("AI diagnostics", () => {
  it("logs safe structured lifecycle events without retaining the private cause", () => {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sink = createAiDiagnosticLoggerSink(logger);
    sink({ domain: "upstream", operation: "request", phase: "failed",
      timestamp: "2026-08-30T00:00:00.000Z", code: "unavailable", cause: new Error("secret") });
    expect(logger.error).toHaveBeenCalledWith(expect.not.objectContaining({ cause: expect.anything() }),
      "AI operation lifecycle");
  });

  it("reports terminal duration while preserving the original failure", async () => {
    const events: import("../src/diagnostics.js").AiDiagnosticEvent[] = [];
    const failure = new Error("upstream failed");
    await expect(diagnoseAiOperation((event) => events.push(event),
      { domain: "upstream", operation: "request" }, async () => { throw failure; })).rejects.toBe(failure);
    expect(events.map((event) => event.phase)).toEqual(["started", "failed"]);
    expect(events[1]).toEqual(expect.objectContaining({ durationMs: expect.any(Number), cause: failure }));
  });
});
