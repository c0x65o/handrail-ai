import {
  AI_RUNTIME_PROTOCOL_VERSION,
  BoundedToolExecutor,
  InMemoryConversationEventStore,
  InMemoryToolExecutionLedger,
  ToolRegistry,
  createConversationRuntime,
  parseChatRequest,
  runToolLoop,
  type ApplicationToolExecutor,
  type ChatRequest,
  type ConversationAttachmentId,
  type ConversationAttachmentReference,
  type ConversationClientId,
  type ConversationId,
  type ConversationRuntime,
  type ConversationRuntimeTurnResult,
  type ConversationTransport,
  type NormalizedUsageReceipt,
  type ResumeTurnInput,
  type StartTurnInput,
  type StreamEvent,
  type ToolDefinition,
  type TransportResult,
  type TurnHandle,
  type TurnObservation,
  type TurnObservationResult,
  type TurnResumePoint,
} from "@handrail/ai";

const EMPTY_CHECKPOINT: TurnResumePoint = {
  lastAppliedEventId: null,
  lastAppliedCursor: null,
  lastAppliedRevision: null,
};

const attribution = {
  organization: { id: "example-org", source: "server_derived", trust: "authoritative" },
  project: { id: "example-project", source: "server_derived", trust: "authoritative" },
  service_environment: {
    id: "example",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
} as const;

function fakeObservation(turnId: string): TurnObservation<StreamEvent> {
  let settle!: (result: TurnObservationResult) => void;
  let settled = false;
  const result = new Promise<TurnObservationResult>((resolve) => {
    settle = resolve;
  });
  const finish = (value: TurnObservationResult): void => {
    if (settled) return;
    settled = true;
    settle(value);
  };
  const events: readonly StreamEvent[] = [
    {
      type: "response.started",
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: turnId,
      trace_id: `trace-${turnId}`,
      sequence: 0,
      attribution,
    },
    {
      type: "response.text.delta",
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: turnId,
      trace_id: `trace-${turnId}`,
      sequence: 1,
      delta: "This response came from an injected fake transport.",
    },
    {
      type: "response.completed",
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: turnId,
      trace_id: `trace-${turnId}`,
      sequence: 2,
      outcome: "stop",
    },
  ];

  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
        finish({ status: "completed", checkpoint: EMPTY_CHECKPOINT });
      },
    },
    result,
    disconnect() {
      finish({ status: "disconnected", checkpoint: EMPTY_CHECKPOINT });
    },
  };
}

/** A credential-free transport for examples and contract checks only. */
export class FakeConversationTransport
  implements ConversationTransport<StreamEvent, ChatRequest>
{
  readonly capabilities = {
    authoritativeCancellation: { supported: false },
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  } as const;

  async startTurn(
    input: StartTurnInput<ChatRequest>,
  ): Promise<TransportResult<TurnHandle<StreamEvent>>> {
    const turnId = `fake-${input.idempotencyKey}`;
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        mutationId: input.mutationId,
        turnId,
        observation: fakeObservation(turnId),
      },
    };
  }

  async resumeTurn(
    input: ResumeTurnInput,
  ): Promise<TransportResult<TurnObservation<StreamEvent>>> {
    return { ok: true, value: fakeObservation(input.turnId) };
  }
}

interface ApplicationContext {
  readonly locale: string;
}

const toolRegistry = new ToolRegistry<
  ApplicationToolExecutor<ApplicationContext>,
  ApplicationContext
>();

toolRegistry.register({
  definition: {
    name: "lookup_delivery_window",
    description: "Return the application's delivery window for an order.",
    input_schema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  capabilities: ["orders:read"],
  discover: ({ locale }) => locale.length > 0,
  executor: async (arguments_, { applicationContext }) => ({
    order_id: arguments_.order_id ?? null,
    locale: applicationContext.locale,
    window: "next-business-day",
  }),
});

const applicationContext: ApplicationContext = { locale: "en-US" };
const discoveredTools = toolRegistry.discover({
  context: applicationContext,
  capabilities: ["orders:read"],
});
const toolExecutor = new BoundedToolExecutor<ApplicationContext, ApplicationContext>({
  registry: toolRegistry,
  policy: async () => ({ outcome: "allow" }),
  ledger: new InMemoryToolExecutionLedger(),
  limits: {
    timeoutMs: 2_000,
    maxConcurrency: 2,
    maxResultBytes: 16_384,
    maxResultNodes: 200,
    maxResultDepth: 8,
  },
});

export async function executeDiscoveredTool() {
  return toolExecutor.execute({
    call: {
      tool_call_id: "tool-call-example",
      name: "lookup_delivery_window",
      arguments: { order_id: "order-example" },
    },
    discoveredTools,
    applicationContext,
  });
}

const attachment = {
  attachment_id: "att_example_image",
  content_ref: "ref_example_upload",
  media_type: "image/png",
  byte_size: 12_345,
  filename: "parcel.png",
} as const;

function requestWithOpaqueAttachment(): ChatRequest {
  return parseChatRequest({
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    continuation_of: null,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "When will this parcel arrive?" },
        { type: "image", attachment, alt_text: "A parcel label" },
      ],
    }],
    tools: discoveredTools,
    tool_results: [],
    generation: { max_output_tokens: 256, temperature: 0.2 },
    correlation_hints: {},
  });
}

async function persistUsageReceipts(
  receipts: readonly NormalizedUsageReceipt[],
  writeReceipt: (receipt: NormalizedUsageReceipt) => Promise<void>,
): Promise<void> {
  const unique = new Map(receipts.map((receipt) => [receipt.usage_receipt_id, receipt]));
  for (const receipt of unique.values()) await writeReceipt(receipt);
}

export async function continueBoundedToolLoop(
  runtime: ConversationRuntime<ChatRequest>,
  initialTurn: ConversationRuntimeTurnResult,
  request: ChatRequest,
  collectUsageReceipts: (
    turn: ConversationRuntimeTurnResult,
  ) => readonly NormalizedUsageReceipt[] | Promise<readonly NormalizedUsageReceipt[]>,
  writeReceipt: (receipt: NormalizedUsageReceipt) => Promise<void>,
) {
  const result = await runToolLoop({
    runtime,
    initialTurn,
    request,
    discoveredTools,
    executor: toolExecutor,
    applicationContext,
    limits: {
      maxIterations: 4,
      maxTotalToolCalls: 8,
      maxElapsedMs: 30_000,
      parallelism: 1,
    },
    collectUsageReceipts,
  });
  await persistUsageReceipts(result.usageReceipts, writeReceipt);
  return result;
}

export async function headlessLifecycle(): Promise<ConversationRuntimeTurnResult> {
  // Replace this reference adapter with an application-owned durable store in production.
  const eventStore = new InMemoryConversationEventStore();
  const runtime = await createConversationRuntime({
    conversationId: "conversation-example" as ConversationId,
    clientId: "client-example" as ConversationClientId,
    transport: new FakeConversationTransport(),
    eventStore,
  });
  void runtime.getSnapshot();

  const unobserve = runtime.observe((snapshot) => {
    void snapshot.revision;
  });
  const unselect = runtime.store.select(
    (snapshot) => snapshot.messages.length,
    (messageCount) => {
      void messageCount;
    },
  );

  try {
    // Hydration already replayed durable history. Recover a nonterminal turn, if any.
    await runtime.restoreActiveTurn();
    const result = await runtime.sendMessage({
      content: "When will this parcel arrive?",
      attachments: [{
        attachment_id: attachment.attachment_id as ConversationAttachmentId,
        media_type: attachment.media_type,
        filename: attachment.filename,
        size_bytes: attachment.byte_size,
      } satisfies ConversationAttachmentReference],
      request: requestWithOpaqueAttachment(),
    });

    // A caller with a known durable turn identity may instead reconnect explicitly.
    if (result.status === "disconnected") await runtime.resumeTurn(result.turnId);
    return result;
  } finally {
    unselect();
    unobserve();
    runtime.destroy();
  }
}

export function stopLocalObservation(
  runtime: ConversationRuntime<ChatRequest>,
  turn: ConversationRuntimeTurnResult,
): boolean {
  return runtime.stopObserving(turn.turnId);
}

export function requestAuthoritativeCancellation(
  runtime: ConversationRuntime<ChatRequest>,
  turn: ConversationRuntimeTurnResult,
) {
  return runtime.cancelTurn(turn.turnId, "runtime_shutdown");
}

export function currentTools(): readonly ToolDefinition[] {
  return discoveredTools;
}
