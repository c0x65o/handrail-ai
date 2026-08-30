import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  InMemoryConversationEventStore,
  createConversationRuntime,
  createRetryPolicy,
  type AppendConversationEventsInput,
  type AppendConversationEventsResult,
  type AuthoritativeAttribution,
  type CitationId,
  type CitationMessageId,
  type CitationSourceId,
  type ConversationClientId,
  type ConversationEventStore,
  type ConversationId,
  type ConversationRevision,
  type ConversationTransport,
  type ReadConversationEventsInput,
  type ReadConversationEventsResult,
  type ResumeTurnInput,
  type StartTurnInput,
  type StreamEvent,
  type TransportResult,
  type TurnHandle,
  type TurnObservation,
  type TurnObservationResult,
  type TurnResumePoint,
} from "../src/index.js";

interface FakeRequest {
  readonly prompt: string;
}

const conversationId = "conversation_runtime_citations" as ConversationId;
const clientId = "client_runtime_citations" as ConversationClientId;
const attribution: AuthoritativeAttribution = {
  organization: { id: "org_citations", source: "server_derived", trust: "authoritative" },
  project: { id: "project_citations", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

function envelope(type: StreamEvent["type"], sequence: number) {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: "provider_request_citations",
    trace_id: "trace_runtime_citations",
    sequence,
  };
}

const started = () => ({
  ...envelope("response.started", 0),
  type: "response.started" as const,
  attribution,
});

const text = (sequence: number, delta = "Cited answer") => ({
  ...envelope("response.text.delta", sequence),
  type: "response.text.delta" as const,
  delta,
});

const completed = (sequence: number) => ({
  ...envelope("response.completed", sequence),
  type: "response.completed" as const,
  outcome: "stop" as const,
});

const cancelled = (sequence: number) => ({
  ...envelope("response.cancelled", sequence),
  type: "response.cancelled" as const,
  reason: "runtime_shutdown" as const,
});

function citationBatch(
  sequence: number,
  order: number,
  suffix: string,
  targetId = "provider_assistant_output",
) {
  const target = {
    type: "assistant_message" as const,
    message_id: targetId as CitationMessageId,
  };
  return {
    ...envelope("response.citation_batch", sequence),
    type: "response.citation_batch" as const,
    target,
    sources: [{
      source_id: `source_${suffix}` as CitationSourceId,
      type: "web" as const,
      label: `Source ${suffix}`,
      locator: `https://example.com/${suffix}`,
    }],
    citations: [{
      citation_id: `citation_${suffix}` as CitationId,
      source_id: `source_${suffix}` as CitationSourceId,
      order,
      target,
    }],
  };
}

function checkpoint(raw: unknown): TurnResumePoint {
  const frame = raw as { request_id: string; sequence: number };
  return {
    lastAppliedEventId: `${frame.request_id}:${frame.sequence}`,
    lastAppliedCursor: `${frame.request_id}:${frame.sequence}`,
    lastAppliedRevision: frame.sequence,
  };
}

function observation(
  frames: readonly unknown[],
  status: TurnObservationResult["status"],
): TurnObservation<unknown> {
  let disconnected = false;
  let settled = false;
  let currentCheckpoint: TurnResumePoint = {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  };
  let settle!: (result: TurnObservationResult) => void;
  const result = new Promise<TurnObservationResult>((resolve) => {
    settle = resolve;
  });
  const finish = (next: TurnObservationResult): void => {
    if (settled) return;
    settled = true;
    settle(next);
  };
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const frame of frames) {
          if (disconnected) return;
          currentCheckpoint = checkpoint(frame);
          yield frame;
        }
        finish(status === "completed"
          ? { status, checkpoint: currentCheckpoint }
          : status === "cancelled"
            ? { status, checkpoint: currentCheckpoint }
            : { status: "disconnected", checkpoint: currentCheckpoint });
      },
    },
    result,
    disconnect() {
      disconnected = true;
      finish({ status: "disconnected", checkpoint: currentCheckpoint });
    },
  };
}

function pendingObservation(
  frames: readonly unknown[],
  onFramesConsumed?: () => void,
): TurnObservation<unknown> {
  let disconnected = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let settle!: (result: TurnObservationResult) => void;
  const result = new Promise<TurnObservationResult>((resolve) => {
    settle = resolve;
  });
  let currentCheckpoint: TurnResumePoint = {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  };
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const frame of frames) {
          if (disconnected) return;
          currentCheckpoint = checkpoint(frame);
          yield frame;
        }
        onFramesConsumed?.();
        await released;
      },
    },
    result,
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      release();
      settle({ status: "disconnected", checkpoint: currentCheckpoint });
    },
  };
}

class FakeTransport implements ConversationTransport<unknown, FakeRequest> {
  readonly capabilities = {
    authoritativeCancellation: { supported: false },
    documentInput: { supported: false },
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  } as const;
  readonly starts: StartTurnInput<FakeRequest>[] = [];
  readonly resumes: ResumeTurnInput[] = [];
  readonly startObservations: TurnObservation<unknown>[] = [];
  readonly resumeObservations: TurnObservation<unknown>[] = [];

  async startTurn(
    input: StartTurnInput<FakeRequest>,
  ): Promise<TransportResult<TurnHandle<unknown>>> {
    this.starts.push(input);
    const next = this.startObservations.shift();
    if (next === undefined) throw new Error("No start observation queued");
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        turnId: "provider_turn_citations",
        mutationId: input.mutationId,
        observation: next,
      },
    };
  }

  async resumeTurn(
    input: ResumeTurnInput,
  ): Promise<TransportResult<TurnObservation<unknown>>> {
    this.resumes.push(input);
    const next = this.resumeObservations.shift();
    if (next === undefined) throw new Error("No resume observation queued");
    return { ok: true, value: next };
  }
}

class CitationAppendFailureStore implements ConversationEventStore {
  readonly inner = new InMemoryConversationEventStore();
  failAfterCitationAppend = true;

  async append(
    input: AppendConversationEventsInput,
  ): Promise<AppendConversationEventsResult> {
    const result = await this.inner.append(input);
    if (
      this.failAfterCitationAppend &&
      input.events.some((event) => event.payload.type === "citation.records_linked")
    ) {
      this.failAfterCitationAppend = false;
      throw new Error("simulated ambiguous citation append");
    }
    return result;
  }

  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> {
    return this.inner.read(input);
  }

  getLatestRevision(id: ConversationId): Promise<ConversationRevision | null> {
    return this.inner.getLatestRevision(id);
  }
}

function deterministicSources() {
  let id = 0;
  let tick = 0;
  return {
    createId(kind: string) {
      id += 1;
      return `${kind}_runtime_citations_${id}`;
    },
    now() {
      tick += 1;
      return `2026-08-29T12:00:${String(tick).padStart(2, "0")}.000Z`;
    },
  };
}

async function createRuntime(
  transport: FakeTransport,
  eventStore: ConversationEventStore = new InMemoryConversationEventStore(),
  sources = deterministicSources(),
) {
  const runtime = await createConversationRuntime({
    conversationId,
    clientId,
    transport,
    eventStore,
    retryPolicy: createRetryPolicy({ maximumAttempts: 1 }),
    ...sources,
  });
  return { runtime, eventStore, sources };
}

const send = (runtime: Awaited<ReturnType<typeof createRuntime>>["runtime"]) =>
  runtime.sendMessage({
    content: "Please cite the answer",
    request: { prompt: "Please cite the answer" },
  });

describe("ConversationRuntime provider citations", () => {
  it("replays normalized citations onto the canonical assistant message without native fields", async () => {
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      started(),
      text(1),
      {
        ...citationBatch(2, 0, "one"),
        metadata: { safe_provider_hint: "normalized-only" },
      },
      completed(3),
    ], "completed"));
    const { runtime, eventStore } = await createRuntime(transport);

    await expect(send(runtime)).resolves.toMatchObject({ status: "completed" });

    const assistant = runtime.getSnapshot().messages.find(
      (message) => message.role === "assistant",
    );
    expect(assistant?.content).toEqual([{ type: "text", text: "Cited answer" }]);
    expect(runtime.getSnapshot().citations).toEqual([expect.objectContaining({
      citation_id: "citation_one",
      order: 0,
      target: { type: "assistant_message", message_id: assistant?.message_id },
    })]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    const linked = history.entries.find(
      ({ event }) => event.payload.type === "citation.records_linked",
    )?.event;
    expect(linked?.payload).toMatchObject({
      target: { type: "assistant_message", message_id: assistant?.message_id },
      citations: [{
        target: { type: "assistant_message", message_id: assistant?.message_id },
      }],
    });
    const durableJson = JSON.stringify(history.entries);
    expect(durableJson).not.toContain("provider_assistant_output");
    expect(durableJson).not.toContain("safe_provider_hint");
    expect(durableJson).not.toContain("provider_payload");
  });

  it("buffers citation-before-text batches and retains deterministic cross-batch order", async () => {
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      started(),
      citationBatch(1, 0, "first"),
      citationBatch(2, 1, "second"),
      text(3),
      completed(4),
    ], "completed"));
    const { runtime, eventStore } = await createRuntime(transport);

    await expect(send(runtime)).resolves.toMatchObject({ status: "completed" });
    expect(runtime.getSnapshot().citations.map(({ citation_id, order }) => ({
      citation_id,
      order,
    }))).toEqual([
      { citation_id: "citation_first", order: 0 },
      { citation_id: "citation_second", order: 1 },
    ]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "citation.records_linked",
    ).map(({ event }) => event.metadata?.handrail_runtime)).toMatchObject([
      { sequence: 1, frame_type: "response.citation_batch" },
      { sequence: 2, frame_type: "response.citation_batch" },
    ]);
  });

  it("treats an exact replayed citation frame as idempotent", async () => {
    const transport = new FakeTransport();
    const batch = citationBatch(2, 0, "duplicate");
    transport.startObservations.push(observation([
      started(),
      text(1),
      batch,
      structuredClone(batch),
      completed(3),
    ], "completed"));
    const { runtime, eventStore } = await createRuntime(transport);

    await expect(send(runtime)).resolves.toMatchObject({ status: "completed" });
    expect(runtime.getSnapshot().citations).toHaveLength(1);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "citation.records_linked",
    )).toHaveLength(1);
  });

  it.each([
    {
      name: "reordered",
      second: citationBatch(3, 2, "second"),
      message: "Citation order must be contiguous across batches",
    },
    {
      name: "cross-target",
      second: citationBatch(3, 1, "second", "other_provider_output"),
      message: "Citation batches must use one assistant output target",
    },
  ])("fails safely for $name citation batches", async ({ second, message }) => {
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      started(),
      text(1, "Canonical text"),
      citationBatch(2, 0, "first"),
      second,
    ], "disconnected"));
    const { runtime } = await createRuntime(transport);

    await expect(send(runtime)).resolves.toMatchObject({
      status: "interrupted",
      error: { code: "invalid_protocol", message },
    });
    expect(runtime.getSnapshot().messages.find(
      (candidate) => candidate.role === "assistant",
    )?.content).toEqual([{ type: "text", text: "Canonical text" }]);
    expect(runtime.getSnapshot().citations.map((citation) => citation.citation_id))
      .toEqual(["citation_first"]);
  });

  it("recovers an ambiguous citation append on resume without duplicating the fact", async () => {
    const eventStore = new CitationAppendFailureStore();
    const transport = new FakeTransport();
    const batch = citationBatch(2, 0, "retry");
    transport.startObservations.push(observation([
      started(),
      text(1),
      batch,
      completed(3),
    ], "completed"));
    transport.resumeObservations.push(observation([
      structuredClone(batch),
      completed(3),
    ], "completed"));
    const { runtime } = await createRuntime(transport, eventStore);

    const interrupted = await send(runtime);
    expect(interrupted.status).toBe("interrupted");
    await expect(runtime.resumeTurn(interrupted.turnId)).resolves.toMatchObject({
      status: "completed",
    });

    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "citation.records_linked",
    )).toHaveLength(1);
    expect(runtime.getSnapshot().citations).toHaveLength(1);
  });

  it("reconstructs and resumes without duplicating durable citations", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const transport = new FakeTransport();
    const batch = citationBatch(2, 0, "restart");
    transport.startObservations.push(observation([
      started(),
      text(1),
      batch,
    ], "disconnected"));
    const sources = deterministicSources();
    const firstRuntime = (await createRuntime(transport, eventStore, sources)).runtime;
    const disconnected = await send(firstRuntime);
    expect(disconnected.status).toBe("disconnected");
    firstRuntime.destroy();

    transport.resumeObservations.push(observation([
      structuredClone(batch),
      completed(3),
    ], "completed"));
    const secondRuntime = (await createRuntime(transport, eventStore, sources)).runtime;
    await expect(secondRuntime.restoreActiveTurn()).resolves.toMatchObject({
      status: "completed",
    });

    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.filter(
      ({ event }) => event.payload.type === "citation.records_linked",
    )).toHaveLength(1);
    expect(secondRuntime.getSnapshot().citations).toHaveLength(1);
  });

  it("drops buffered citations when the provider cancels before text", async () => {
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      started(),
      citationBatch(1, 0, "cancelled"),
      cancelled(2),
    ], "cancelled"));
    const { runtime, eventStore } = await createRuntime(transport);

    await expect(send(runtime)).resolves.toMatchObject({ status: "cancelled" });
    expect(runtime.getSnapshot().citations).toEqual([]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.map(({ event }) => event.payload.type)).not.toContain(
      "citation.records_linked",
    );
  });

  it("does not leak buffered citations when host cancellation stops observation", async () => {
    const transport = new FakeTransport();
    let markBuffered!: () => void;
    const buffered = new Promise<void>((resolve) => {
      markBuffered = resolve;
    });
    transport.startObservations.push(pendingObservation([
      started(),
      citationBatch(1, 0, "host_cancelled"),
    ], markBuffered));
    const { runtime, eventStore } = await createRuntime(transport);
    const sending = send(runtime);
    await vi.waitFor(() => {
      expect(runtime.getSnapshot().turns[0]?.status).toBe("running");
    });
    await buffered;
    const turnId = runtime.getSnapshot().active_turn_id!;

    await expect(runtime.cancelTurn(turnId, "user")).resolves.toMatchObject({
      status: "unsupported",
      remoteMayStillBeRunning: true,
    });
    await expect(sending).resolves.toMatchObject({ status: "disconnected" });
    expect(runtime.getSnapshot().citations).toEqual([]);
    const history = await eventStore.read({ conversationId, limit: 100 });
    expect(history.entries.map(({ event }) => event.payload.type)).not.toContain(
      "citation.records_linked",
    );
  });

  it("keeps canonical text safe when citation projection is malformed or follows terminal", async () => {
    const malformedTransport = new FakeTransport();
    malformedTransport.startObservations.push(observation([
      started(),
      text(1, "Safe text"),
      {
        ...citationBatch(2, 0, "malformed"),
        provider_payload: { native: true },
      },
    ], "disconnected"));
    const malformed = await createRuntime(malformedTransport);
    await expect(send(malformed.runtime)).resolves.toMatchObject({
      status: "interrupted",
      error: { code: "invalid_protocol" },
    });
    expect(malformed.runtime.getSnapshot().messages.find(
      (candidate) => candidate.role === "assistant",
    )?.content).toEqual([{ type: "text", text: "Safe text" }]);
    expect(JSON.stringify((await malformed.eventStore.read({
      conversationId,
      limit: 100,
    })).entries)).not.toContain("provider_payload");

    const terminalTransport = new FakeTransport();
    terminalTransport.startObservations.push(observation([
      started(),
      text(1, "Still safe"),
      completed(2),
      citationBatch(3, 0, "too_late"),
    ], "completed"));
    const terminal = await createRuntime(terminalTransport);
    await expect(send(terminal.runtime)).resolves.toMatchObject({
      status: "interrupted",
      error: { code: "invalid_protocol" },
    });
    expect(terminal.runtime.getSnapshot().citations).toEqual([]);
    expect(terminal.runtime.getSnapshot().messages.find(
      (candidate) => candidate.role === "assistant",
    )?.content).toEqual([{ type: "text", text: "Still safe" }]);
  });

  it("rejects a citation frame with no assistant target without damaging text", async () => {
    const transport = new FakeTransport();
    const { target: _target, ...missingTarget } = citationBatch(2, 0, "missing_target");
    void _target;
    transport.startObservations.push(observation([
      started(),
      text(1, "Target-safe text"),
      missingTarget,
    ], "disconnected"));
    const { runtime, eventStore } = await createRuntime(transport);

    await expect(send(runtime)).resolves.toMatchObject({
      status: "interrupted",
      error: { code: "invalid_protocol" },
    });
    expect(runtime.getSnapshot().messages.find(
      (candidate) => candidate.role === "assistant",
    )?.content).toEqual([{ type: "text", text: "Target-safe text" }]);
    expect(runtime.getSnapshot().citations).toEqual([]);
    expect(JSON.stringify((await eventStore.read({
      conversationId,
      limit: 100,
    })).entries)).not.toContain("missing_target");
  });

  it("leaves citation-free providers unchanged", async () => {
    const transport = new FakeTransport();
    transport.startObservations.push(observation([
      started(),
      text(1, "Plain answer"),
      completed(2),
    ], "completed"));
    const { runtime } = await createRuntime(transport);

    await expect(send(runtime)).resolves.toMatchObject({ status: "completed" });
    expect(runtime.getSnapshot().citations).toEqual([]);
    expect(runtime.getSnapshot().messages.find(
      (candidate) => candidate.role === "assistant",
    )?.content).toEqual([{ type: "text", text: "Plain answer" }]);
  });
});
