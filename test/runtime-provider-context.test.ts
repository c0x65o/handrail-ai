import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  PROVIDER_CONTEXT_CONTRACT_VERSION,
  InMemoryConversationEventStore,
  InMemoryProviderContextCheckpointStore,
  ProviderContextCheckpointStoreError,
  ProviderContextOperationError,
  createConversationRuntime,
  createProviderContextFingerprint,
  type AuthoritativeAttribution,
  type ConversationClientId,
  type ConversationId,
  type ConversationRuntimeProviderContextOptions,
  type ConversationTransport,
  type ProviderContextCapability,
  type ProviderContextCheckpoint,
  type ProviderContextCheckpointRecord,
  type ProviderContextCheckpointStore,
  type ProviderContextCompactionRequest,
  type ProviderContextFingerprintInput,
  type ProviderContextMeasurementRequest,
  type StartTurnInput,
  type StreamEvent,
  type TransportResult,
  type TurnHandle,
  type TurnObservation,
  type TurnObservationResult,
} from "../src/index.js";

interface FakeRequest {
  readonly messages: readonly string[];
  readonly checkpointId?: string;
}

const conversationId = "conversation-provider-context" as ConversationId;
const clientId = "client-provider-context" as ConversationClientId;
const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

function completedObservation(index: number): TurnObservation<unknown> {
  const frames: StreamEvent[] = [
    {
      type: "response.started",
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: `request-${index}`,
      trace_id: `trace-${index}`,
      sequence: 0,
      attribution,
    },
    {
      type: "response.completed",
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: `request-${index}`,
      trace_id: `trace-${index}`,
      sequence: 1,
      outcome: "stop",
    },
  ];
  const checkpoint = {
    lastAppliedEventId: `request-${index}:1`,
    lastAppliedCursor: `request-${index}:1`,
    lastAppliedRevision: 1,
  };
  const result: Promise<TurnObservationResult> = Promise.resolve({
    status: "completed",
    checkpoint,
  });
  return {
    events: { async *[Symbol.asyncIterator]() { yield* frames; } },
    result,
    disconnect() {},
  };
}

let transportSequence = 0;
class CapturingTransport implements ConversationTransport<unknown, FakeRequest> {
  readonly requests: FakeRequest[] = [];
  readonly capabilities = {
    authoritativeCancellation: { supported: false },
    documentInput: { supported: false },
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  } as const;

  async startTurn(input: StartTurnInput<FakeRequest>): Promise<TransportResult<TurnHandle<unknown>>> {
    this.requests.push(input.request);
    transportSequence += 1;
    const sequence = transportSequence;
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        turnId: `transport-${sequence}`,
        mutationId: input.mutationId,
        observation: completedObservation(sequence),
      },
    };
  }

  async resumeTurn(): Promise<never> {
    throw new Error("not used");
  }
}

let sourceSequence = 0;
function ids() {
  sourceSequence += 1;
  const source = sourceSequence;
  let value = 0;
  return {
    createId(kind: string) { value += 1; return `${kind}-${source}-${value}`; },
    now() { return "2026-08-29T12:00:00.000Z"; },
  };
}

function fingerprint(overrides: Partial<ProviderContextFingerprintInput> = {}): ProviderContextFingerprintInput {
  return {
    model: { provider_id: "fake", model_id: "model-a" },
    instructions: ["safe instruction"],
    tools: [],
    generation: { max_output_tokens: 100, temperature: 0 },
    provider_settings: { reasoning: "medium" },
    ...overrides,
  };
}

function checkpointFor(
  request: ProviderContextMeasurementRequest<FakeRequest>,
  id = "checkpoint-1",
): ProviderContextCheckpoint {
  return {
    version: 1,
    provider_id: "fake",
    checkpoint_id: id,
    format: "fake.v1",
    opaque_state: "Y2hlY2twb2ludA",
    context_fingerprint: request.context_fingerprint,
    history_position: request.history_position,
  };
}

function capability(options: {
  readonly onMeasure?: (request: ProviderContextMeasurementRequest<FakeRequest>) => Promise<void> | void;
  readonly onCompact?: (request: ProviderContextCompactionRequest<FakeRequest>) => Promise<void> | void;
} = {}): ProviderContextCapability<FakeRequest> {
  return {
    supported: true,
    version: PROVIDER_CONTEXT_CONTRACT_VERSION,
    async measure(request) {
      await options.onMeasure?.(request);
      return {
        status: "measured",
        context_fingerprint: request.context_fingerprint,
        history_position: request.history_position,
        input_tokens: request.input.messages.length * 100,
        context_window_tokens: 10_000,
      };
    },
    async compact(request) {
      await options.onCompact?.(request);
      return {
        status: "compacted",
        checkpoint: checkpointFor(request),
        measurement: {
          status: "measured",
          context_fingerprint: request.context_fingerprint,
          history_position: request.history_position,
          input_tokens: request.target_input_tokens,
          context_window_tokens: 10_000,
        },
      };
    },
  };
}

function configuration(
  store: ProviderContextCheckpointStore,
  contextCapability: ProviderContextCapability<FakeRequest> = capability(),
  fingerprintInput: ProviderContextFingerprintInput = fingerprint(),
): ConversationRuntimeProviderContextOptions<FakeRequest, FakeRequest> {
  return {
    capability: contextCapability,
    checkpointStore: store,
    threshold: { compactAtInputTokens: 500, targetInputTokens: 200, maximumAttempts: 3 },
    fingerprintInput,
    project: ({ request, checkpoint }) => {
      const projected = checkpoint === null
        ? request
        : { messages: request.messages.slice(-2), checkpointId: checkpoint.checkpoint_id };
      return { input: projected, request: projected };
    },
  };
}

async function runtime(
  eventStore: InMemoryConversationEventStore,
  transport: CapturingTransport,
  providerContext?: ConversationRuntimeProviderContextOptions<FakeRequest, FakeRequest>,
) {
  return createConversationRuntime({
    conversationId,
    clientId,
    eventStore,
    transport,
    ...(providerContext === undefined ? {} : { providerContext }),
    ...ids(),
  });
}

const longRequest: FakeRequest = {
  messages: Array.from({ length: 40 }, (_, index) => `message-${index}`),
};

describe("ConversationRuntime provider-context preflight", () => {
  it("compacts projected input and reuses the checkpoint after reconstruction without changing canonical state", async () => {
    const eventStore = new InMemoryConversationEventStore();
    const checkpointStore = new InMemoryProviderContextCheckpointStore();
    const firstTransport = new CapturingTransport();
    const first = await runtime(eventStore, firstTransport, configuration(checkpointStore));
    await first.sendMessage({ content: "first", request: longRequest });
    expect(firstTransport.requests[0]).toMatchObject({
      messages: ["message-38", "message-39"],
      checkpointId: "checkpoint-1",
    });
    const canonicalAfterFirst = first.getSnapshot();
    first.destroy();

    const secondTransport = new CapturingTransport();
    const second = await runtime(eventStore, secondTransport, configuration(checkpointStore));
    expect(second.getSnapshot()).toEqual(canonicalAfterFirst);
    await second.sendMessage({ content: "second", request: longRequest });
    expect(secondTransport.requests[0]).toMatchObject({
      messages: ["message-38", "message-39"],
      checkpointId: "checkpoint-1",
    });
    second.destroy();

    const canonicalOnly = await runtime(eventStore, new CapturingTransport());
    expect(canonicalOnly.getSnapshot().messages.map((message) => message.content)).toHaveLength(2);
    expect(canonicalOnly.getSnapshot().revision).toBeGreaterThan(canonicalAfterFirst.revision!);
  });

  it.each([
    ["model", fingerprint({ model: { provider_id: "fake", model_id: "model-b" } })],
    ["instructions", fingerprint({ instructions: ["changed"] })],
    ["tools", fingerprint({ tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object", properties: {} } }] })],
    ["generation", fingerprint({ generation: { max_output_tokens: 200, temperature: 0.5 } })],
    ["provider settings", fingerprint({ provider_settings: { reasoning: "high" } })],
  ])("rejects and invalidates a mismatched checkpoint when %s changes", async (_label, changed) => {
    const oldFingerprint = createProviderContextFingerprint(fingerprint());
    let invalidations = 0;
    const maliciousStore: ProviderContextCheckpointStore = {
      async load(input) {
        return {
          conversation_id: input.conversation_id,
          context_fingerprint: input.context_fingerprint,
          store_version: 1,
          checkpoint: {
            version: 1,
            provider_id: "fake",
            checkpoint_id: "stale",
            format: "fake.v1",
            opaque_state: "c3RhbGU",
            context_fingerprint: oldFingerprint,
            history_position: { conversation_id: conversationId, revision: 1, event_id: "old-event" },
          },
        } as ProviderContextCheckpointRecord;
      },
      async invalidate(input) {
        invalidations += 1;
        return { conversation_id: input.conversation_id, context_fingerprint: input.context_fingerprint, invalidated: true, store_version: 2 };
      },
      async save(input) {
        return { conversation_id: input.conversation_id, context_fingerprint: input.context_fingerprint, checkpoint: input.checkpoint, store_version: 1 };
      },
    };
    const transport = new CapturingTransport();
    const instance = await runtime(new InMemoryConversationEventStore(), transport, configuration(maliciousStore, capability(), changed));
    await instance.sendMessage({ content: "changed", request: { messages: ["short"] } });
    expect(transport.requests[0]?.checkpointId).toBeUndefined();
    expect(invalidations).toBe(1);
  });

  it("retries with one compaction identity and one effective checkpoint write", async () => {
    const backing = new InMemoryProviderContextCheckpointStore();
    let saveAttempts = 0;
    const store: ProviderContextCheckpointStore = {
      load: (input) => backing.load(input),
      invalidate: (input) => backing.invalidate(input),
      async save(input) {
        saveAttempts += 1;
        if (saveAttempts === 1) throw new ProviderContextCheckpointStoreError("unavailable", "save");
        return backing.save(input);
      },
    };
    const identities: string[] = [];
    let compactAttempts = 0;
    const contextCapability = capability({ onCompact(request) {
      identities.push(request.idempotency_key);
      compactAttempts += 1;
      if (compactAttempts === 1) throw new ProviderContextOperationError("provider_unavailable");
    } });
    const transport = new CapturingTransport();
    const instance = await runtime(new InMemoryConversationEventStore(), transport, configuration(store, contextCapability));
    await instance.sendMessage({ content: "retry", request: longRequest });
    expect(new Set(identities).size).toBe(1);
    expect(saveAttempts).toBe(2);
    const saved = await backing.load({
      conversation_id: conversationId,
      context_fingerprint: createProviderContextFingerprint(fingerprint()),
      signal: new AbortController().signal,
    });
    expect(saved?.store_version).toBe(1);
  });

  it("reloads and adopts a valid winner after a checkpoint version conflict", async () => {
    const backing = new InMemoryProviderContextCheckpointStore();
    let saveCalls = 0;
    const store: ProviderContextCheckpointStore = {
      load: (input) => backing.load(input),
      invalidate: (input) => backing.invalidate(input),
      async save(input) {
        saveCalls += 1;
        const winner = { ...input.checkpoint, checkpoint_id: "checkpoint-winner" };
        await backing.save({ ...input, checkpoint: winner });
        throw new ProviderContextCheckpointStoreError("version_conflict", "save");
      },
    };
    let compactCalls = 0;
    const contextCapability = capability({ onCompact() { compactCalls += 1; } });
    const transport = new CapturingTransport();
    const instance = await runtime(new InMemoryConversationEventStore(), transport, configuration(store, contextCapability));
    await instance.sendMessage({ content: "conflict", request: longRequest });
    expect(compactCalls).toBe(1);
    expect(saveCalls).toBe(1);
    expect(transport.requests[0]?.checkpointId).toBe("checkpoint-winner");
  });

  it("aborts preflight on stopObserving and never starts transport", async () => {
    let observedSignal: AbortSignal | null = null;
    const measuring = capability({ onMeasure: (request) => new Promise<void>((_resolve, reject) => {
      observedSignal = request.signal;
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }) });
    const transport = new CapturingTransport();
    const instance = await runtime(new InMemoryConversationEventStore(), transport, configuration(new InMemoryProviderContextCheckpointStore(), measuring));
    const sending = instance.sendMessage({ content: "cancel", request: longRequest });
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());
    const turnId = instance.getSnapshot().active_turn_id!;
    expect(instance.stopObserving(turnId)).toBe(true);
    await expect(sending).resolves.toMatchObject({ status: "disconnected" });
    expect(observedSignal!.aborted).toBe(true);
    expect(transport.requests).toHaveLength(0);
  });

  it("authoritatively cancels local preflight before a transport identity exists", async () => {
    let observedSignal: AbortSignal | null = null;
    const measuring = capability({ onMeasure: (request) => new Promise<void>((_resolve, reject) => {
      observedSignal = request.signal;
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }) });
    const transport = new CapturingTransport();
    const instance = await runtime(new InMemoryConversationEventStore(), transport, configuration(new InMemoryProviderContextCheckpointStore(), measuring));
    const sending = instance.sendMessage({ content: "cancel", request: longRequest });
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());
    const turnId = instance.getSnapshot().active_turn_id!;
    await expect(instance.cancelTurn(turnId, "user")).resolves.toMatchObject({
      status: "cancellation_requested",
      remoteMayStillBeRunning: false,
    });
    await expect(sending).resolves.toMatchObject({ status: expect.stringMatching(/cancelled|interrupted/) });
    expect(observedSignal!.aborted).toBe(true);
    expect(transport.requests).toHaveLength(0);
    expect(instance.getSnapshot().turns[0]?.status).toBe("cancelled");
  });

  it("fails closed on corrupt checkpoints and preserves the canonical request", async () => {
    let invalidations = 0;
    const store: ProviderContextCheckpointStore = {
      async load(input) {
        return { conversation_id: input.conversation_id, context_fingerprint: input.context_fingerprint, checkpoint: { corrupt: true }, store_version: 1 } as unknown as ProviderContextCheckpointRecord;
      },
      async invalidate(input) {
        invalidations += 1;
        return { conversation_id: input.conversation_id, context_fingerprint: input.context_fingerprint, invalidated: true, store_version: 2 };
      },
      async save(input) { return { ...input, store_version: 1 }; },
    };
    const transport = new CapturingTransport();
    const instance = await runtime(new InMemoryConversationEventStore(), transport, configuration(store));
    await instance.sendMessage({ content: "corrupt", request: { messages: ["short"] } });
    expect(transport.requests[0]).toEqual({ messages: ["short"] });
    expect(invalidations).toBe(1);
  });

  it("keeps absent and explicitly unsupported configuration byte-equivalent", async () => {
    for (const contextCapability of [undefined, { supported: false, reason: "provider_not_supported" } as const]) {
      const transport = new CapturingTransport();
      const eventStore = new InMemoryConversationEventStore();
      const configured = contextCapability === undefined
        ? undefined
        : configuration(new InMemoryProviderContextCheckpointStore(), contextCapability);
      const instance = await runtime(eventStore, transport, configured);
      await instance.sendMessage({ content: "same", request: longRequest });
      expect(transport.requests[0]).toBe(longRequest);
    }
  });

  it("falls back from checkpoint-store failure without truncating canonical replay", async () => {
    const failingStore: ProviderContextCheckpointStore = {
      async load() { throw new Error("native secret detail"); },
      async save() { throw new Error("not used"); },
      async invalidate() { throw new Error("not used"); },
    };
    const eventStore = new InMemoryConversationEventStore();
    const transport = new CapturingTransport();
    const instance = await runtime(eventStore, transport, configuration(failingStore));
    await instance.sendMessage({ content: "canonical", request: longRequest });
    expect(transport.requests[0]).toMatchObject({
      messages: ["message-38", "message-39"],
      checkpointId: "checkpoint-1",
    });
    const snapshot = instance.getSnapshot();
    instance.destroy();
    const reconstructed = await runtime(eventStore, new CapturingTransport());
    expect(reconstructed.getSnapshot()).toEqual(snapshot);
    expect(JSON.stringify(reconstructed.getSnapshot())).not.toContain("native secret detail");
  });
});
