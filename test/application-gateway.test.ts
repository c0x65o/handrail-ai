import { describe, expect, it, vi } from "vitest";
import {
  createApplicationGateway,
  createApplicationGatewayTransport,
  negotiateApplicationGatewayCapabilities,
  type ConversationTransport,
  type TurnObservation,
  type TurnResumePoint,
} from "../src/index.js";

type Event = { id: string; revision: number; text: string };

function observation(events: Event[]): TurnObservation<Event> {
  const checkpoint = events.length === 0 ? { lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null }
    : point(events.at(-1)!);
  return {
    events: (async function* () { for (const event of events) yield event; })(),
    result: Promise.resolve({ status: "completed", checkpoint }),
    disconnect() {},
  };
}

function point(event: Event): TurnResumePoint {
  return { lastAppliedEventId: event.id, lastAppliedCursor: `cursor:${event.id}`, lastAppliedRevision: event.revision };
}

describe("application-owned gateway transport", () => {
  it("negotiates capabilities, streams events, resumes, and cancels authoritatively", async () => {
    const cancelTurn = vi.fn(async () => ({ ok: true as const, value: { status: "cancellation_requested" as const } }));
    const serverTransport: ConversationTransport<Event, { prompt: string }> = {
      capabilities: {
        authoritativeCancellation: { supported: true, capability: { cancelTurn } },
        documentInput: { supported: false }, attachmentUpload: { supported: false },
        presence: { supported: false }, synchronization: { supported: false },
      },
      async startTurn(input) {
        return { ok: true, value: { conversationId: input.conversationId, turnId: "server-turn", mutationId: input.mutationId,
          observation: observation([{ id: "e1", revision: 1, text: "hello" }]) } };
      },
      async resumeTurn() { return { ok: true, value: observation([{ id: "e2", revision: 2, text: "again" }]) }; },
    };
    const gateway = createApplicationGateway({
      transport: serverTransport,
      authorize: async (request) => {
        if (request.headers.get("authorization") !== "Bearer app") throw new Error("no");
        return { principalId: "user-1" };
      },
      checkpointForEvent: point,
      capabilities: { attachments: { maximumFiles: 3, maximumBytesPerFile: 1000, acceptedMediaTypes: ["image/png"], uploadUrl: "/uploads" }, presence: true, synchronization: true },
    });
    const fetch = (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/uploads") return Promise.resolve(new Response(JSON.stringify({ ok: true, value: {
        attachment_id: "attachment-1", content_ref: "app:attachment-1", media_type: "image/png", byte_size: 3, filename: "a.png",
      } }), { headers: { "content-type": "application/json" } }));
      return gateway.handle(request);
    };
    const protectedRequest = (input: RequestInit & { url: string }) => ({ ...input, headers: { ...input.headers, authorization: "Bearer app" } });
    const capabilities = await negotiateApplicationGatewayCapabilities({ baseUrl: "https://app.test/ai", fetch, protectedRequest });
    expect(capabilities.attachments).toMatchObject({ maximumFiles: 3 });
    const synchronization = { kind: "application-sync" };
    const client = createApplicationGatewayTransport<Event, { prompt: string }, typeof synchronization>({ baseUrl: "https://app.test/ai", fetch, protectedRequest, capabilities, synchronization });
    expect(client.capabilities.presence.supported).toBe(true);
    expect(client.capabilities.synchronization).toEqual({ supported: true, capability: synchronization });
    const started = await client.startTurn({ conversationId: "c1", conversationTurnId: "client-turn" as never, mutationId: "m1", idempotencyKey: "i1", request: { prompt: "hi" } });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.turnId).toBe("server-turn");
    const received: Event[] = [];
    for await (const event of started.value.observation.events) received.push(event);
    expect(received).toEqual([{ id: "e1", revision: 1, text: "hello" }]);
    await expect(started.value.observation.result).resolves.toMatchObject({ status: "completed", checkpoint: { lastAppliedEventId: "e1" } });
    const resumed = await client.resumeTurn({ conversationId: "c1", turnId: "server-turn", resumeFrom: point(received[0]!) });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) { const values = []; for await (const event of resumed.value.events) values.push(event); expect(values).toHaveLength(1); }
    const cancellation = client.capabilities.authoritativeCancellation;
    expect(cancellation.supported).toBe(true);
    if (cancellation.supported) await cancellation.capability.cancelTurn({ conversationId: "c1", turnId: "server-turn", mutationId: "m2", idempotencyKey: "i2", reason: "user_requested" as never });
    expect(cancelTurn).toHaveBeenCalledOnce();
    const uploads = client.capabilities.attachmentUpload;
    expect(uploads.supported).toBe(true);
    if (uploads.supported) await expect(uploads.capability.upload({
      source: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      metadata: { mediaType: "image/png", byteSize: 3, filename: "a.png" }, idempotencyKey: "upload-1",
      signal: new AbortController().signal, onProgress() {},
    })).resolves.toMatchObject({ attachment_id: "attachment-1" });
  });

  it("does not expose arbitrary authorization failures", async () => {
    const gateway = createApplicationGateway<Event, unknown, { principalId: string }>({
      transport: { capabilities: {
        authoritativeCancellation: { supported: false }, documentInput: { supported: false },
        attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
      } } as ConversationTransport<Event>, authorize: async () => { throw new Error("secret"); }, checkpointForEvent: point,
    });
    const response = await gateway.handle(new Request("https://app.test/ai/capabilities"));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("secret");
  });
});
