import { getPresenceRecordKey, parsePresenceRecord, type PresenceRecord } from "./types.js";

export const LIVE_PRESENCE_PROTOCOL_VERSION = "handrail.live-presence.v1" as const;

export interface LivePresenceEnvelope {
  readonly version: typeof LIVE_PRESENCE_PROTOCOL_VERSION;
  readonly conversationId: string;
  readonly sequence: number;
  /** Opaque delivery identity used to suppress pub-sub echo/duplicates. */
  readonly deliveryId: string;
  readonly kind: "upsert" | "leave";
  readonly record: PresenceRecord;
}

export interface LivePresenceSubscription extends AsyncIterable<LivePresenceEnvelope> {
  close(): void;
}

export interface LivePresenceDelivery {
  publish(conversationId: string, kind: "upsert" | "leave", record: PresenceRecord): Promise<void>;
  subscribe(conversationId: string, signal?: AbortSignal): LivePresenceSubscription;
  snapshot(conversationId: string): readonly PresenceRecord[];
}

export interface LivePresenceHttpHandlerOptions<TAuthorization> {
  readonly delivery: LivePresenceDelivery;
  readonly authorize: (request: Request, conversationId: string, operation: "subscribe" | "publish") => Promise<TAuthorization>;
  readonly maximumBodyBytes?: number;
}

/** Optional multi-instance fan-out seam (Redis, NATS, Postgres NOTIFY, etc.). */
export interface LivePresencePubSub {
  publish(channel: string, envelope: LivePresenceEnvelope): Promise<void>;
  subscribe(channel: string, receive: (envelope: LivePresenceEnvelope) => void): Promise<() => void>;
}

export interface InMemoryLivePresenceOptions {
  readonly pubSub?: LivePresencePubSub;
  readonly channelPrefix?: string;
  readonly now?: () => number;
}

interface Subscriber { push(value: LivePresenceEnvelope): void; close(): void }

function requireConversationId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(value)) throw new TypeError("conversationId is invalid");
  return value;
}

function createQueue(onClose: () => void): LivePresenceSubscription & Subscriber {
  const values: LivePresenceEnvelope[] = [];
  const waiters: ((result: IteratorResult<LivePresenceEnvelope>) => void)[] = [];
  let closed = false;
  return {
    push(value) { if (closed) return; const waiter = waiters.shift(); if (waiter) waiter({ done: false, value }); else values.push(value); },
    close() { if (closed) return; closed = true; onClose(); for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined }); },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const value = values.shift();
          if (value) return Promise.resolve({ done: false as const, value });
          if (closed) return Promise.resolve({ done: true as const, value: undefined });
          return new Promise<IteratorResult<LivePresenceEnvelope>>((resolve) => waiters.push(resolve));
        },
        return: async () => { this.close(); return { done: true as const, value: undefined }; },
      };
    },
  };
}

/**
 * Ephemeral presence hub. Records expire from memory and are never written to
 * conversation event stores. Use the pub-sub seam for multi-instance fan-out.
 */
export function createInMemoryLivePresenceDelivery(options: InMemoryLivePresenceOptions = {}): LivePresenceDelivery {
  const records = new Map<string, Map<string, PresenceRecord>>();
  const subscribers = new Map<string, Set<Subscriber>>();
  const subscribed = new Map<string, Promise<() => void>>();
  const sequence = new Map<string, number>();
  const seen = new Set<string>();
  let deliveryCounter = 0;
  const now = options.now ?? Date.now;
  const channel = (id: string) => `${options.channelPrefix ?? "handrail:presence:"}${id}`;
  const emit = (envelope: LivePresenceEnvelope) => {
    if (seen.has(envelope.deliveryId)) return;
    seen.add(envelope.deliveryId);
    if (seen.size > 10_000) seen.delete(seen.values().next().value!);
    const bucket = records.get(envelope.conversationId) ?? new Map<string, PresenceRecord>();
    records.set(envelope.conversationId, bucket);
    const key = getPresenceRecordKey(envelope.record);
    if (envelope.kind === "leave") bucket.delete(key); else bucket.set(key, envelope.record);
    for (const subscriber of subscribers.get(envelope.conversationId) ?? []) subscriber.push(envelope);
  };
  return Object.freeze({
    async publish(conversationId: string, kind: "upsert" | "leave", input: PresenceRecord) {
      const id = requireConversationId(conversationId);
      const record = parsePresenceRecord(input);
      const next = (sequence.get(id) ?? 0) + 1;
      sequence.set(id, next);
      const envelope = Object.freeze({ version: LIVE_PRESENCE_PROTOCOL_VERSION, conversationId: id, sequence: next,
        deliveryId: `${now().toString(36)}-${(++deliveryCounter).toString(36)}`, kind, record });
      emit(envelope);
      await options.pubSub?.publish(channel(id), envelope);
    },
    subscribe(conversationId: string, signal?: AbortSignal) {
      const id = requireConversationId(conversationId);
      const set = subscribers.get(id) ?? new Set<Subscriber>();
      subscribers.set(id, set);
      const queue = createQueue(() => set.delete(queue));
      set.add(queue);
      if (options.pubSub && !subscribed.has(id)) subscribed.set(id, options.pubSub.subscribe(channel(id), emit));
      signal?.addEventListener("abort", () => queue.close(), { once: true });
      return queue;
    },
    snapshot(conversationId: string) {
      const id = requireConversationId(conversationId);
      const bucket = records.get(id);
      if (!bucket) return [];
      const current = now();
      for (const [key, record] of bucket) if (Date.parse(record.expires_at) <= current) bucket.delete(key);
      return Object.freeze([...bucket.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value));
    },
  });
}

/** Encode live presence as an application-hosted SSE response. */
export function livePresenceSseResponse(subscription: LivePresenceSubscription): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of subscription) controller.enqueue(encoder.encode(`id: ${event.deliveryId}\nevent: presence.${event.kind}\ndata: ${JSON.stringify(event)}\n\n`));
        controller.close();
      } catch (error) { controller.error(error); }
    },
    cancel() { subscription.close(); },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" } });
}

/** Web-standard application-hosted presence endpoint (GET stream, POST publish). */
export function createLivePresenceHttpHandler<TAuthorization>(options: LivePresenceHttpHandlerOptions<TAuthorization>) {
  const maximumBodyBytes = options.maximumBodyBytes ?? 32_768;
  return async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const conversationId = requireConversationId(url.searchParams.get("conversationId") ?? "");
      if (request.method === "GET") {
        await options.authorize(request, conversationId, "subscribe");
        return livePresenceSseResponse(options.delivery.subscribe(conversationId, request.signal));
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      await options.authorize(request, conversationId, "publish");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > maximumBodyBytes) return new Response(null, { status: 413 });
      const input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as { kind?: unknown; record?: unknown };
      if (input.kind !== "upsert" && input.kind !== "leave") return new Response(null, { status: 400 });
      await options.delivery.publish(conversationId, input.kind, parsePresenceRecord(input.record));
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    } catch {
      return new Response(JSON.stringify({ ok: false, error: { code: "forbidden", message: "Presence request denied." } }),
        { status: 403, headers: { "content-type": "application/json" } });
    }
  };
}
