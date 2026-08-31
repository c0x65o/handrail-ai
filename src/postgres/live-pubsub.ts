import {
  LIVE_CONVERSATION_ACTIVITY_PROTOCOL_VERSION,
  parseConversationActivityRecord,
  type LiveConversationActivityEnvelope,
  type LiveConversationActivityPubSub,
} from "../conversation/activity.js";
import { diagnoseAiOperation, emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import {
  LIVE_PRESENCE_PROTOCOL_VERSION,
  type LivePresenceEnvelope,
  type LivePresencePubSub,
} from "../presence/live-delivery.js";
import { parsePresenceRecord } from "../presence/types.js";
export const POSTGRES_LIVE_NOTIFICATION_VERSION = 1 as const;
export const POSTGRES_LIVE_NOTIFICATION_MAX_BYTES = 7_500 as const;

export interface PostgresNotification {
  readonly channel: string;
  readonly payload?: string | undefined;
}

/** A dedicated LISTEN connection. Applications adapt pg/other drivers here. */
export interface PostgresListenConnection {
  query(text: string): Promise<unknown>;
  onNotification(listener: (notification: PostgresNotification) => void): void;
  offNotification(listener: (notification: PostgresNotification) => void): void;
  release(): void | Promise<void>;
}

export interface PostgresLivePubSubOptions {
  readonly publisher: {
    query(text: string, values?: readonly unknown[]): Promise<unknown>;
  };
  readonly connect: () => Promise<PostgresListenConnection>;
  /** One fixed database channel carries bounded logical activity/presence channels. */
  readonly databaseChannel?: string;
  readonly diagnostics?: AiDiagnosticSink;
}

/** Structural subset of a pg PoolClient; pg remains an application dependency. */
export interface PgCompatibleListenClient {
  query(text: string): Promise<unknown>;
  on(event: "notification", listener: (notification: PostgresNotification) => void): unknown;
  removeListener(event: "notification", listener: (notification: PostgresNotification) => void): unknown;
  release(): void;
}

/** Structural subset of a pg Pool used by the one-call application adapter. */
export interface PgCompatiblePool {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
  connect(): Promise<PgCompatibleListenClient>;
}

export interface PgPoolLivePubSubOptions {
  readonly pool: PgCompatiblePool;
  readonly databaseChannel?: string;
  readonly diagnostics?: AiDiagnosticSink;
}

type LiveEnvelope = LiveConversationActivityEnvelope | LivePresenceEnvelope;
type LiveReceiver = (envelope: LiveEnvelope) => void;

interface PostgresLiveNotification {
  readonly version: typeof POSTGRES_LIVE_NOTIFICATION_VERSION;
  readonly channel: string;
  readonly envelope: LiveEnvelope;
}

function databaseChannel(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new TypeError("databaseChannel must be a safe PostgreSQL identifier");
  }
  return value;
}

function logicalChannel(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u.test(normalized)) {
    throw new TypeError("live pub-sub channel is invalid");
  }
  return normalized;
}

function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TypeError("live envelope sequence is invalid");
  return Number(value);
}

function deliveryId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value)) {
    throw new TypeError("live envelope deliveryId is invalid");
  }
  return value;
}

function normalizeEnvelope(input: unknown): LiveEnvelope {
  if (!input || typeof input !== "object") throw new TypeError("live envelope is invalid");
  const envelope = input as Record<string, unknown>;
  if (envelope.version === LIVE_CONVERSATION_ACTIVITY_PROTOCOL_VERSION) {
    return Object.freeze({
      version: LIVE_CONVERSATION_ACTIVITY_PROTOCOL_VERSION,
      sequence: sequence(envelope.sequence),
      deliveryId: deliveryId(envelope.deliveryId),
      record: parseConversationActivityRecord(envelope.record as LiveConversationActivityEnvelope["record"]),
    });
  }
  if (envelope.version === LIVE_PRESENCE_PROTOCOL_VERSION) {
    const conversationId = String(envelope.conversationId ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(conversationId)) {
      throw new TypeError("live presence conversationId is invalid");
    }
    if (envelope.kind !== "upsert" && envelope.kind !== "leave") {
      throw new TypeError("live presence kind is invalid");
    }
    return Object.freeze({
      version: LIVE_PRESENCE_PROTOCOL_VERSION,
      conversationId,
      sequence: sequence(envelope.sequence),
      deliveryId: deliveryId(envelope.deliveryId),
      kind: envelope.kind,
      record: parsePresenceRecord(envelope.record),
    });
  }
  throw new TypeError("live envelope version is unsupported");
}

function encodeNotification(channel: string, envelope: LiveEnvelope): string {
  const payload = JSON.stringify({
    version: POSTGRES_LIVE_NOTIFICATION_VERSION,
    channel: logicalChannel(channel),
    envelope: normalizeEnvelope(envelope),
  } satisfies PostgresLiveNotification);
  if (new TextEncoder().encode(payload).byteLength > POSTGRES_LIVE_NOTIFICATION_MAX_BYTES) {
    throw new TypeError("live pub-sub notification exceeds the PostgreSQL payload limit");
  }
  return payload;
}

function decodeNotification(payload: string | undefined): PostgresLiveNotification {
  if (!payload || new TextEncoder().encode(payload).byteLength > POSTGRES_LIVE_NOTIFICATION_MAX_BYTES) {
    throw new TypeError("live pub-sub notification payload is invalid");
  }
  const parsed = JSON.parse(payload) as Record<string, unknown>;
  if (parsed.version !== POSTGRES_LIVE_NOTIFICATION_VERSION) {
    throw new TypeError("live pub-sub notification version is unsupported");
  }
  return Object.freeze({
    version: POSTGRES_LIVE_NOTIFICATION_VERSION,
    channel: logicalChannel(String(parsed.channel ?? "")),
    envelope: normalizeEnvelope(parsed.envelope),
  });
}

/**
 * Concrete multi-instance delivery for the existing live activity and presence
 * seams. Durable records remain authoritative; LISTEN/NOTIFY is only fast
 * fan-out and clients retain polling/snapshot convergence fallbacks.
 */
export class PostgresLivePubSub implements LiveConversationActivityPubSub, LivePresencePubSub {
  readonly #publisher: PostgresLivePubSubOptions["publisher"];
  readonly #connect: () => Promise<PostgresListenConnection>;
  readonly #databaseChannel: string;
  readonly #diagnostics: AiDiagnosticSink | undefined;
  readonly #subscribers = new Map<string, Set<LiveReceiver>>();
  #connection: Promise<PostgresListenConnection> | null = null;
  #closed = false;

  constructor(options: PostgresLivePubSubOptions) {
    this.#publisher = options.publisher;
    this.#connect = options.connect;
    this.#databaseChannel = databaseChannel(options.databaseChannel ?? "handrail_ai_live_v1");
    this.#diagnostics = options.diagnostics;
  }

  publish(channel: string, envelope: LiveConversationActivityEnvelope): Promise<void>;
  publish(channel: string, envelope: LivePresenceEnvelope): Promise<void>;
  async publish(channel: string, envelope: LiveEnvelope): Promise<void> {
    if (this.#closed) throw new Error("Postgres live pub-sub is closed");
    const payload = encodeNotification(channel, envelope);
    await diagnoseAiOperation(this.#diagnostics, {
      domain: envelope.version === LIVE_PRESENCE_PROTOCOL_VERSION ? "presence" : "activity",
      operation: "postgres_notify",
    }, async () => {
      await this.#publisher.query("SELECT pg_notify($1, $2)", [this.#databaseChannel, payload]);
    });
  }

  subscribe(channel: string, receive: (envelope: LiveConversationActivityEnvelope) => void): Promise<() => void>;
  subscribe(channel: string, receive: (envelope: LivePresenceEnvelope) => void): Promise<() => void>;
  async subscribe(channel: string, receive:
    ((envelope: LiveConversationActivityEnvelope) => void) |
    ((envelope: LivePresenceEnvelope) => void)): Promise<() => void> {
    if (this.#closed) throw new Error("Postgres live pub-sub is closed");
    const key = logicalChannel(channel);
    const receivers = this.#subscribers.get(key) ?? new Set<LiveReceiver>();
    this.#subscribers.set(key, receivers);
    const receiver = receive as LiveReceiver;
    receivers.add(receiver);
    try {
      await this.#ensureConnection();
    } catch (error) {
      receivers.delete(receiver);
      if (receivers.size === 0) this.#subscribers.delete(key);
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      receivers.delete(receiver);
      if (receivers.size === 0) this.#subscribers.delete(key);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#subscribers.clear();
    const connection = await this.#connection?.catch(() => null);
    if (!connection) return;
    connection.offNotification(this.#receive);
    try { await connection.query(`UNLISTEN ${this.#databaseChannel}`); }
    finally { await connection.release(); }
  }

  readonly #receive = (notification: PostgresNotification): void => {
    if (this.#closed || notification.channel !== this.#databaseChannel) return;
    try {
      const decoded = decodeNotification(notification.payload);
      for (const receive of this.#subscribers.get(decoded.channel) ?? []) receive(decoded.envelope);
    } catch (cause) {
      emitAiDiagnostic(this.#diagnostics, {
        domain: "persistence",
        operation: "postgres_notification_receive",
        phase: "failed",
        code: "invalid_live_notification",
        retryable: false,
        cause,
      });
    }
  };

  #ensureConnection(): Promise<PostgresListenConnection> {
    if (this.#connection) return this.#connection;
    this.#connection = diagnoseAiOperation(this.#diagnostics, {
      domain: "persistence",
      operation: "postgres_listen",
    }, async () => {
      const connection = await this.#connect();
      connection.onNotification(this.#receive);
      try {
        await connection.query(`LISTEN ${this.#databaseChannel}`);
        return connection;
      } catch (error) {
        connection.offNotification(this.#receive);
        await connection.release();
        throw error;
      }
    });
    return this.#connection;
  }
}

/** Create the distributed bridge directly from an injected pg-compatible pool. */
export function createPostgresLivePubSubFromPool(options: PgPoolLivePubSubOptions): PostgresLivePubSub {
  return new PostgresLivePubSub({
    publisher: options.pool,
    connect: async () => {
      const client = await options.pool.connect();
      return {
        query: (text) => client.query(text),
        onNotification: (listener) => { client.on("notification", listener); },
        offNotification: (listener) => { client.removeListener("notification", listener); },
        release: () => client.release(),
      };
    },
    ...(options.databaseChannel === undefined ? {} : { databaseChannel: options.databaseChannel }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
}
