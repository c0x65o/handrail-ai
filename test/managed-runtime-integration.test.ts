import { describe, expect, it } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  InMemoryConversationEventStore,
  createConversationRuntime,
  createRetryPolicy,
  type AuthoritativeAttribution,
  type ChatRequest,
  type ConversationClientId,
  type ConversationId,
  type StreamEvent,
} from "../src/index.js";
import {
  createManagedRuntimeTransport,
  parseManagedRuntimeTurnStateRecord,
  type ManagedRuntimeFetch,
  type ManagedRuntimeTurnStateRecord,
  type ManagedRuntimeTurnStateStore,
} from "../src/server/managed.js";

const conversationId = "conversation_managed_restart" as ConversationId;
const clientId = "client_managed_restart" as ConversationClientId;
const encoder = new TextEncoder();

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_managed", source: "server_derived", trust: "authoritative" },
  project: { id: "project_managed", source: "server_derived", trust: "authoritative" },
  service_environment: {
    id: "test",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

const request: ChatRequest = {
  protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
  continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Resume me" }] }],
  tools: [],
  tool_results: [],
  generation: { max_output_tokens: 64, temperature: 0.2 },
  correlation_hints: {},
};

function frame(
  type: StreamEvent["type"],
  sequence: number,
  fields: Record<string, unknown> = {},
): StreamEvent {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: "req_managed_restart",
    trace_id: "trace_managed_restart",
    sequence,
    ...fields,
  } as StreamEvent;
}

function sseFrame(event: StreamEvent): string {
  return [
    `event: ${event.type}`,
    `id: ${event.request_id}:${event.sequence}`,
    `data: ${JSON.stringify(event)}`,
    "",
    "",
  ].join("\n");
}

function streamResponse(events: readonly StreamEvent[]): Response {
  return new Response(encoder.encode(events.map(sseFrame).join("")), {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

class InMemoryManagedRuntimeTurnStateStore implements ManagedRuntimeTurnStateStore {
  #record: ManagedRuntimeTurnStateRecord | null = null;

  async load(
    storedConversationId: string,
    turnId: string,
  ): Promise<ManagedRuntimeTurnStateRecord | null> {
    if (
      this.#record === null ||
      this.#record.conversationId !== storedConversationId ||
      this.#record.turnId !== turnId
    ) {
      return null;
    }
    return parseManagedRuntimeTurnStateRecord(this.#record);
  }

  async save(
    record: ManagedRuntimeTurnStateRecord,
  ): Promise<ManagedRuntimeTurnStateRecord> {
    this.#record = parseManagedRuntimeTurnStateRecord(record);
    return parseManagedRuntimeTurnStateRecord(this.#record);
  }
}

function deterministicSources() {
  let id = 0;
  let tick = 0;
  return {
    createId(kind: string) {
      id += 1;
      return `${kind}_${id}`;
    },
    now() {
      tick += 1;
      return `2026-08-28T12:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
}

function occurrences(value: string, search: string): number {
  return value.split(search).length - 1;
}

describe("managed runtime restart integration", () => {
  it("restores a managed turn through ConversationRuntime without replaying text", async () => {
    const started = frame("response.started", 0, { attribution });
    const replayedDelta = frame("response.text.delta", 1, { delta: "Persisted" });
    const newDelta = frame("response.text.delta", 2, { delta: " once" });
    const completed = frame("response.completed", 3, { outcome: "stop" });
    const responses = [
      streamResponse([started, replayedDelta]),
      streamResponse([started, replayedDelta, newDelta, completed]),
    ];
    const calls: RequestInit[] = [];
    const fetch: ManagedRuntimeFetch = async (_url, init = {}) => {
      calls.push(init);
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected managed runtime POST");
      return response;
    };
    const eventStore = new InMemoryConversationEventStore();
    const turnStateStore = new InMemoryManagedRuntimeTurnStateStore();
    const sources = deterministicSources();
    const retryPolicy = createRetryPolicy({ maximumAttempts: 1 });
    const transportBeforeRestart = createManagedRuntimeTransport({
      baseUrl: "https://runtime.example.test",
      getHeaders: () => ({ authorization: "Bearer test-token" }),
      fetch,
      turnStateStore,
    });
    const runtimeBeforeRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport: transportBeforeRestart,
      eventStore,
      retryPolicy,
      ...sources,
    });

    const disconnected = await runtimeBeforeRestart.sendMessage({
      content: "Resume me",
      request,
    });
    expect(disconnected.status).toBe("disconnected");

    const historyBeforeRestart = await eventStore.read({ conversationId, limit: 100 });
    const persistedDelta = historyBeforeRestart.entries.find(
      ({ event }) => event.payload.type === "message.text_appended",
    );
    expect(persistedDelta).toBeDefined();
    const durableRevision = persistedDelta!.event.revision;
    expect(durableRevision).not.toBe(replayedDelta.sequence);
    expect(disconnected.checkpoint).toEqual({
      lastAppliedEventId: "req_managed_restart:1",
      lastAppliedCursor: "req_managed_restart:1",
      lastAppliedRevision: durableRevision,
    });
    const storedCheckpoint = historyBeforeRestart.entries
      .map(({ event }) =>
        (event.metadata?.handrail_runtime as { checkpoint?: unknown } | undefined)
          ?.checkpoint
      )
      .find((checkpoint) => checkpoint !== undefined);
    expect(storedCheckpoint).toEqual({
      last_applied_event_id: "req_managed_restart:1",
      last_applied_cursor: "req_managed_restart:1",
      last_applied_revision: durableRevision,
    });

    const streamedMessageId = runtimeBeforeRestart.getSnapshot().messages.find(
      (message) => message.role === "assistant",
    )?.message_id;
    expect(streamedMessageId).toBeDefined();
    runtimeBeforeRestart.destroy();

    const transportAfterRestart = createManagedRuntimeTransport({
      baseUrl: "https://runtime.example.test",
      getHeaders: () => ({ authorization: "Bearer test-token" }),
      fetch,
      turnStateStore,
    });
    const runtimeAfterRestart = await createConversationRuntime({
      conversationId,
      clientId,
      transport: transportAfterRestart,
      eventStore,
      retryPolicy,
      ...sources,
    });
    const restored = await runtimeAfterRestart.restoreActiveTurn();

    expect(restored?.status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(typeof calls[0]?.body).toBe("string");
    expect(calls[0]?.body).toBe(calls[1]?.body);
    const idempotencyKeys = calls.map((call) =>
      new Headers(call.headers).get("idempotency-key")
    );
    expect(idempotencyKeys[0]).not.toBeNull();
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);

    const finalSnapshot = runtimeAfterRestart.getSnapshot();
    const assistantMessage = finalSnapshot.messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistantMessage).toMatchObject({
      message_id: streamedMessageId,
      content: [{ type: "text", text: "Persisted once" }],
    });
    const finalText = assistantMessage?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("") ?? "";
    expect(occurrences(finalText, "Persisted")).toBe(1);
    expect(occurrences(finalText, " once")).toBe(1);
    expect(finalSnapshot.turns[0]).toMatchObject({
      status: "completed",
      output_message_ids: [streamedMessageId],
    });
    expect(finalSnapshot.active_turn_id).toBeNull();

    const finalHistory = await eventStore.read({ conversationId, limit: 100 });
    expect(finalHistory.entries.flatMap(({ event }) =>
      event.payload.type === "message.text_appended" ? [event.payload.text] : []
    )).toEqual(["Persisted", " once"]);
    runtimeAfterRestart.destroy();
  });
});
