import { describe, expect, it, vi } from "vitest";
import { parseServerSentEvents } from "../src/transports/sse.js";

describe("SSE reader cancellation", () => {
  it("aborts a pending reader and releases the stream lock", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); }, cancel,
    });
    const controller = new AbortController();
    const events = parseServerSentEvents(source, { signal: controller.signal });
    await expect(events.next()).resolves.toMatchObject({ value: { data: "first" }, done: false });
    const pending = events.next();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });
  it("cancels unread input when the consumer exits early", async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n")); }, cancel,
    });
    for await (const event of parseServerSentEvents(source)) { expect(event.data).toBe("first"); break; }
    expect(cancel).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });
});
