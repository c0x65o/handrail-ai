import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForApplicationApproval } from "../src/server/application-approval-wait.js";
import { createToolActivityObserver } from "../src/server/tool-observer.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";

afterEach(() => vi.useRealTimers());
const options = () => ({ signal: new AbortController().signal, expiresAt: Date.now() + 10_000 });

describe("host-owned approval observation", () => {
  it("waits through pending state and returns only the saved settled result", async () => {
    vi.useFakeTimers();
    const value = { applied: true };
    const read = vi.fn().mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce({ status: "settled", value });
    const result = waitForApplicationApproval({ ...options(), read });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe(value);
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "expire"])("bounds a hung read on %s and never polls again after its late result", async (outcome) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let resolve!: (value: { status: "pending" }) => void;
    const read = vi.fn(() => new Promise<{ status: "pending" }>((accept) => { resolve = accept; }));
    const result = waitForApplicationApproval({ ...options(), signal: controller.signal, read });
    const rejected = expect(result).rejects.toThrow(outcome === "cancel" ? "Stopped" : "Approval waiting expired");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledOnce();
    if (outcome === "cancel") controller.abort(new Error("Stopped"));
    else await vi.advanceTimersByTimeAsync(8_000);
    await rejected;
    resolve({ status: "pending" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not read an expired or cancelled proposal and rejects invalid polling options", async () => {
    const read = vi.fn();
    await expect(waitForApplicationApproval({ ...options(), read, expiresAt: Date.now() - 1 })).rejects.toThrow("expired");
    await expect(waitForApplicationApproval({ ...options(), read, signal: AbortSignal.abort(new Error("Stopped")) })).rejects.toThrow("Stopped");
    await expect(waitForApplicationApproval({ ...options(), read, pollIntervalMs: 0 })).rejects.toThrow(TypeError);
    expect(read).not.toHaveBeenCalled();
  });

  it("propagates a domain rejection or failed action without retrying it", async () => {
    const failure = new Error("Action rejected by the owner");
    const read = vi.fn(async () => { throw failure; });
    await expect(waitForApplicationApproval({ ...options(), read })).rejects.toBe(failure);
    expect(read).toHaveBeenCalledOnce();
  });

  it("caps one observation at fifteen minutes even if the proposal expires later", async () => {
    vi.useFakeTimers();
    const result = waitForApplicationApproval({ ...options(), expiresAt: Date.now() + 86_400_000,
      read: async () => new Promise<never>(() => undefined) });
    const rejected = expect(result).rejects.toThrow("Approval waiting expired");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled activity write before the first domain read", async () => {
    vi.useFakeTimers();
    const observer = createToolActivityObserver({ events: new InMemoryConversationEventStore(),
      report: () => new Promise<never>(() => undefined) });
    const read = vi.fn();
    const result = observer.waitForApproval({ ...options(), conversationId: "conversation", turnId: "turn", read });
    const rejected = expect(result).rejects.toThrow("Approval waiting expired");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports waiting before reading and settlement before returning without recording domain output", async () => {
    const report = vi.fn(async () => undefined);
    const events = new InMemoryConversationEventStore();
    const observer = createToolActivityObserver({ events, report });
    const value = { privateResult: "domain data" };
    const read = vi.fn(async () => {
      expect(report).toHaveBeenLastCalledWith("conversation", "turn", { summary: "Waiting for approval to continue" });
      return { status: "settled" as const, value };
    });
    await expect(observer.waitForApproval({ ...options(), conversationId: "conversation", turnId: "turn", read })).resolves.toBe(value);
    expect(report).toHaveBeenLastCalledWith("conversation", "turn", { summary: "Approval action settled; continuing" });
    expect(await events.getLatestRevision("conversation" as never)).toBeNull();
  });
});
