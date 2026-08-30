import { describe, expect, it } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  CITATION_LIMITS,
  createDirectProviderTransport,
  parseProviderCitationProjectionCapability,
  parseStreamEvent,
  parseStreamEvents,
  type AuthoritativeAttribution,
  type ChatRequest,
  type CitationId,
  type CitationMessageId,
  type CitationSourceId,
  type ConversationTurnId,
  type DirectProviderTurnContext,
  type ProviderAdapter,
  type ProviderAdapterInvocation,
  type ProviderAdapterStream,
  type ProviderUsage,
  type StreamEvent,
} from "../src/index.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_citations", source: "server_derived", trust: "authoritative" },
  project: { id: "project_citations", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: "session_citations", source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

const request: ChatRequest = {
  protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
  continuation_of: null,
  messages: [{ role: "user", content: [{ type: "text", text: "Cite this" }] }],
  tools: [],
  tool_results: [],
  generation: { max_output_tokens: 64, temperature: 0 },
  correlation_hints: {},
};

const usage: ProviderUsage = {
  input_tokens: 4,
  cached_input_tokens: 0,
  output_tokens: 3,
  reasoning_tokens: 0,
  total_tokens: 7,
  provider_cost: { known: false },
};

const envelope = (type: StreamEvent["type"], sequence: number) => ({
  type,
  protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
  request_id: "request_citations",
  trace_id: "trace_citations",
  sequence,
});

const started = () => ({
  ...envelope("response.started", 0),
  type: "response.started" as const,
  attribution,
});

const batch = (sequence = 2) => ({
  ...envelope("response.citation_batch", sequence),
  type: "response.citation_batch" as const,
  target: {
    type: "assistant_message" as const,
    message_id: "assistant_output_1" as CitationMessageId,
  },
  sources: [{
    source_id: "source_1" as CitationSourceId,
    type: "web" as const,
    label: "Public source",
    locator: "https://example.com/source",
  }],
  citations: [{
    citation_id: "citation_1" as CitationId,
    source_id: "source_1" as CitationSourceId,
    order: 0,
    target: {
      type: "assistant_message" as const,
      message_id: "assistant_output_1" as CitationMessageId,
    },
  }],
});

const completeEvents = (): StreamEvent[] => [
  started(),
  {
    ...envelope("response.text.delta", 1),
    type: "response.text.delta",
    delta: "Answer",
  },
  batch(),
  {
    ...envelope("response.usage", 3),
    type: "response.usage",
    usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
  },
  {
    ...envelope("response.completed", 4),
    type: "response.completed",
    outcome: "stop",
  },
];

const context = (): DirectProviderTurnContext => ({
  request_id: "request_citations",
  trace_id: "trace_citations",
  turn_id: "transport_turn_citations",
  attribution,
  correlation_hints: {},
  usage: {
    usage_receipt_id: "usage_citations",
    logical_request_id: "logical_citations",
    attempt: { id: "attempt_citations", index: 0 },
    continuation: { id: "continuation_citations", index: 0 },
    source: "provider",
    quality: "reported",
  },
});

class CitationAdapter implements ProviderAdapter {
  readonly provider_context = {
    supported: false,
    reason: "provider_not_supported",
  } as const;

  readonly metadata = {
    provider_id: "citation-fixture",
    model_id: "citation-fixture-v1",
    capabilities: {
      streaming: true,
      text: true,
      tool_calls: false,
      parallel_tool_calls: false,
      reasoning: false,
      document_input: { supported: false },
      citation_projection: { supported: true },
      provider_context: this.provider_context,
      context_window_tokens: null,
      max_output_tokens: null,
    },
  } as const;

  constructor(
    private readonly streamFactory: (
      invocation: ProviderAdapterInvocation,
    ) => ProviderAdapterStream,
  ) {}

  invoke(invocation: ProviderAdapterInvocation): ProviderAdapterStream {
    return this.streamFactory(invocation);
  }
}

async function start(adapter: ProviderAdapter) {
  const transport = createDirectProviderTransport({
    adapter,
    createContext: () => context(),
  });
  const result = await transport.startTurn({
    conversationId: "conversation_citations",
    conversationTurnId: "turn_citations" as ConversationTurnId,
    mutationId: "mutation_citations",
    idempotencyKey: "idempotency_citations",
    request,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const output: StreamEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

describe("provider citation projection contract", () => {
  it("accepts only exact citation capability declarations", () => {
    expect(parseProviderCitationProjectionCapability({ supported: true })).toEqual({
      supported: true,
    });
    expect(parseProviderCitationProjectionCapability({ supported: false })).toEqual({
      supported: false,
    });
    expect(() => parseProviderCitationProjectionCapability({
      supported: true,
      projector: () => undefined,
    })).toThrow(/invalid fields/);
    expect(() => parseProviderCitationProjectionCapability({
      supported: false,
      annotations: [],
    })).toThrow(/invalid fields/);
  });

  it("accepts a normalized batch and preserves exact complete-stream sequence", () => {
    const events = completeEvents();
    expect(parseStreamEvent(events[2])).toBe(events[2]);
    expect(parseStreamEvents(events)).toBe(events);
    expect(events.map((event) => event.type)).toEqual([
      "response.started",
      "response.text.delta",
      "response.citation_batch",
      "response.usage",
      "response.completed",
    ]);
  });

  it.each([
    ["sequence", () => ({ ...batch(), sequence: 5 })],
    ["assistant target", () => ({
      ...batch(),
      target: { type: "tool_result", tool_call_id: "call_1" },
    })],
    ["nested target", () => ({
      ...batch(),
      citations: [{
        ...batch().citations[0],
        target: { type: "assistant_message", message_id: "assistant_output_other" },
      }],
    })],
    ["duplicate order", () => ({
      ...batch(),
      citations: [
        batch().citations[0],
        {
          ...batch().citations[0],
          citation_id: "citation_2",
          order: 0,
        },
      ],
    })],
    ["identity duplication", () => ({
      ...batch(),
      citations: [batch().citations[0], batch().citations[0]],
    })],
    ["unsafe locator", () => ({
      ...batch(),
      sources: [{ ...batch().sources[0], locator: "http://127.0.0.1/private" }],
    })],
    ["provider-native source key", () => ({
      ...batch(),
      sources: [{ ...batch().sources[0], provider_payload: { private: true } }],
    })],
    ["raw annotations", () => ({ ...batch(), annotations: [{ url: "https://example.com" }] })],
    ["credential locator", () => ({
      ...batch(),
      sources: [{ ...batch().sources[0], locator: "https://example.com/?api_key=secret" }],
    })],
  ])("rejects malformed %s values", (_label, mutate) => {
    const events = completeEvents();
    events[2] = mutate() as unknown as StreamEvent;
    expect(() => parseStreamEvents(events)).toThrow();
  });

  it("rejects nonzero initial order and cross-batch target/order/identity conflicts", () => {
    const initialOrder = completeEvents();
    initialOrder[2] = {
      ...batch(),
      citations: [{ ...batch().citations[0]!, order: 1 }],
    };
    expect(() => parseStreamEvents(initialOrder)).toThrow(/must equal 0/);

    const first = batch();
    const second = {
      ...batch(3),
      target: {
        type: "assistant_message" as const,
        message_id: "assistant_output_2" as CitationMessageId,
      },
      sources: [{ ...batch().sources[0]!, label: "Conflicting source" }],
      citations: [{
        ...batch().citations[0]!,
        order: 1,
        target: {
          type: "assistant_message" as const,
          message_id: "assistant_output_2" as CitationMessageId,
        },
      }],
    };
    const events = [
      started(),
      { ...envelope("response.text.delta", 1), type: "response.text.delta" as const, delta: "Answer" },
      first,
      second,
      { ...envelope("response.completed", 4), type: "response.completed" as const, outcome: "stop" as const },
    ];
    expect(() => parseStreamEvents(events)).toThrow(/target|source identity/);

    const duplicateIdentity = [
      events[0],
      events[1],
      first,
      {
        ...second,
        target: first.target,
        sources: first.sources,
        citations: [{ ...first.citations[0]!, order: 1 }],
      },
      events[4],
    ];
    expect(() => parseStreamEvents(duplicateIdentity)).toThrow(/unique within the stream/);
  });

  it("enforces citation count and serialized-byte bounds", () => {
    const tooMany = batch();
    tooMany.citations = Array.from(
      { length: CITATION_LIMITS.citationsPerRecordSet + 1 },
      (_, index) => ({
        ...batch().citations[0]!,
        citation_id: `citation_${index}` as CitationId,
        order: index,
      }),
    );
    expect(() => parseStreamEvent(tooMany)).toThrow(/at most/);

    const oversized = batch();
    oversized.sources = Array.from(
      { length: CITATION_LIMITS.sourcesPerRecordSet },
      (_, index) => ({
        source_id: `source_${index}` as CitationSourceId,
        type: "web" as const,
        label: `${index}-${"l".repeat(CITATION_LIMITS.labelLength - 3)}`,
        locator: `https://example.com/${index}/${"x".repeat(1_980)}`,
      }),
    );
    oversized.citations = oversized.sources.map((source, index) => ({
      citation_id: `citation_${index}` as CitationId,
      source_id: source.source_id,
      order: index,
      target: batch().target,
    }));
    expect(() => parseStreamEvent(oversized)).toThrow(/serialize to at most/);
  });
});

describe("DirectProviderTransport citation forwarding", () => {
  it("forwards a valid citation batch in exact sequence", async () => {
    const adapter = new CitationAdapter(async function* () {
      for (const event of completeEvents()) yield event;
      return { status: "completed", outcome: "stop", usage };
    });
    const handle = await start(adapter);
    const events = await collect(handle.observation.events);

    expect(events).toEqual(completeEvents());
    await expect(handle.observation.result).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("maps malformed citation output to the existing safe normalized failure", async () => {
    const adapter = new CitationAdapter(async function* () {
      yield started();
      yield {
        ...batch(1),
        annotations: [{ provider: "native", payload: { secret: true } }],
      } as unknown as StreamEvent;
      yield {
        ...envelope("response.completed", 2),
        type: "response.completed",
        outcome: "stop",
      };
      return { status: "completed", outcome: "stop", usage };
    });
    const handle = await start(adapter);
    const events = await collect(handle.observation.events);

    expect(events.map((event) => event.type)).toEqual(["response.started"]);
    await expect(handle.observation.result).resolves.toEqual({
      status: "failed",
      checkpoint: {
        lastAppliedEventId: null,
        lastAppliedCursor: null,
        lastAppliedRevision: null,
      },
      error: {
        code: "internal_error",
        message: "The provider returned an invalid normalized response.",
        retryable: false,
      },
      usageReceipt: null,
    });
  });

  it("keeps legacy adapters compatible but rejects undeclared citation output", async () => {
    const legacy: ProviderAdapter = {
      provider_context: {
        supported: false,
        reason: "provider_not_supported",
      },
      metadata: {
        provider_id: "legacy-fixture",
        model_id: "legacy-v1",
        capabilities: {
          streaming: true,
          text: true,
          tool_calls: false,
          parallel_tool_calls: false,
          reasoning: false,
          document_input: { supported: false },
          provider_context: {
            supported: false,
            reason: "provider_not_supported",
          },
          context_window_tokens: null,
          max_output_tokens: null,
        },
      },
      async *invoke() {
        yield started();
        yield {
          ...envelope("response.completed", 1),
          type: "response.completed",
          outcome: "stop",
        };
        return { status: "completed", outcome: "stop", usage };
      },
    };
    const ordinaryHandle = await start(legacy);
    expect((await collect(ordinaryHandle.observation.events)).map((event) => event.type)).toEqual([
      "response.started",
      "response.completed",
    ]);
    await expect(ordinaryHandle.observation.result).resolves.toMatchObject({ status: "completed" });

    const undeclared = {
      ...legacy,
      async *invoke() {
        yield started();
        yield batch(1);
        yield {
          ...envelope("response.completed", 2),
          type: "response.completed" as const,
          outcome: "stop" as const,
        };
        return { status: "completed" as const, outcome: "stop" as const, usage };
      },
    } satisfies ProviderAdapter;
    const invalidHandle = await start(undeclared);
    expect((await collect(invalidHandle.observation.events)).map((event) => event.type)).toEqual([
      "response.started",
    ]);
    await expect(invalidHandle.observation.result).resolves.toMatchObject({
      status: "failed",
      error: { code: "internal_error" },
    });
  });
});
