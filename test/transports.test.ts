import { describe, expect, expectTypeOf, it } from "vitest";

import {
  NORMALIZED_USAGE_RECEIPT_VERSION,
  parseNormalizedUsageReceipt,
} from "../src/index.js";
import type {
  AuthoritativeCancelTurnResult,
  CancelTurnInput,
  ConversationTransport,
  ConversationTurnId,
  DirectProviderTurnObservationResult,
  NormalizedUsageReceipt,
  ResumeTurnInput,
  StartTurnInput,
  TransportResult,
  TurnHandle,
  TurnObservation,
  TurnObservationResult,
  TurnResumePoint,
} from "../src/index.js";
import type { ManagedRuntimeTurnObservationResult } from "../src/server/managed.js";

interface FakeConversationEvent {
  readonly eventId: string;
  readonly cursor: string;
  readonly revision: number;
  readonly text: string;
}

interface FakeStartRequest {
  readonly text: string;
}

const events: readonly FakeConversationEvent[] = [
  { eventId: "event-1", cursor: "cursor-1", revision: 1, text: "first" },
  { eventId: "event-2", cursor: "cursor-2", revision: 2, text: "second" },
];

const initialCheckpoint: TurnResumePoint = {
  lastAppliedEventId: null,
  lastAppliedCursor: null,
  lastAppliedRevision: null,
};

const normalizedReceipt = parseNormalizedUsageReceipt({
  version: NORMALIZED_USAGE_RECEIPT_VERSION,
  usage_receipt_id: "usage-transport-1",
  conversation_id: "conversation-1",
  turn_id: "turn-1",
  logical_request_id: "logical-request-1",
  trace_id: "trace-1",
  attempt: { id: "attempt-1", index: 0 },
  continuation: { id: "continuation-1", index: 0 },
  provider_id: "fake-provider",
  model_id: "fake-model-v1",
  attribution: {
    organization: { id: "org-1", source: "server_derived", trust: "authoritative" },
    project: { id: "project-1", source: "server_derived", trust: "authoritative" },
    service_environment: {
      id: "development",
      source: "server_derived",
      trust: "authoritative",
    },
    known_user: { id: "user-1", source: "server_derived", trust: "authoritative" },
    session: { id: null, source: "server_derived", trust: "authoritative" },
    automation: { id: null, source: "server_derived", trust: "authoritative" },
  },
  source: "provider",
  terminal_status: "completed",
  tokens: {
    input_tokens: { status: "reported", value: 4 },
    cached_input_tokens: { status: "reported", value: 0 },
    output_tokens: { status: "reported", value: 2 },
    reasoning_tokens: { status: "reported", value: 0 },
    total_tokens: { status: "reported", value: 6 },
  },
  provider_cost: { status: "unavailable" },
});

const callerTurnId = "conversation-turn-1" as ConversationTurnId;

function checkpointFor(event: FakeConversationEvent): TurnResumePoint {
  return {
    lastAppliedEventId: event.eventId,
    lastAppliedCursor: event.cursor,
    lastAppliedRevision: event.revision,
  };
}

function createObservation(
  observedEvents: readonly FakeConversationEvent[],
  startingCheckpoint: TurnResumePoint,
  usageReceipt?: NormalizedUsageReceipt,
): TurnObservation<FakeConversationEvent> {
  let disconnected = false;
  let resolveResult: (result: TurnObservationResult) => void = () => undefined;
  let checkpoint = startingCheckpoint;

  const result = new Promise<TurnObservationResult>((resolve) => {
    resolveResult = resolve;
  });

  const observation: TurnObservation<FakeConversationEvent> = {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const event of observedEvents) {
          if (disconnected) {
            resolveResult({ status: "disconnected", checkpoint });
            return;
          }
          checkpoint = checkpointFor(event);
          yield event;
        }
        resolveResult({
          status: "completed",
          checkpoint,
          ...(usageReceipt === undefined ? {} : { usageReceipt }),
        });
      },
    },
    result,
    disconnect() {
      disconnected = true;
    },
  };

  return observation;
}

class FakeTransport
  implements ConversationTransport<FakeConversationEvent, FakeStartRequest>
{
  readonly capabilities = {
    authoritativeCancellation: { supported: false },
    documentInput: { supported: false },
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  } as const;

  readonly starts: StartTurnInput<FakeStartRequest>[] = [];
  readonly resumes: ResumeTurnInput[] = [];

  constructor(private readonly usageReceipt?: NormalizedUsageReceipt) {}

  async startTurn(
    input: StartTurnInput<FakeStartRequest>,
  ): Promise<TransportResult<TurnHandle<FakeConversationEvent>>> {
    this.starts.push(input);
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        turnId: "turn-1",
        mutationId: input.mutationId,
        observation: createObservation(events, initialCheckpoint, this.usageReceipt),
      },
    };
  }

  async resumeTurn(
    input: ResumeTurnInput,
  ): Promise<TransportResult<TurnObservation<FakeConversationEvent>>> {
    this.resumes.push(input);
    const remainingEvents = events.filter(
      (event) => event.revision > (input.resumeFrom.lastAppliedRevision ?? 0),
    );
    return {
      ok: true,
      value: createObservation(
        remainingEvents,
        input.resumeFrom,
        this.usageReceipt,
      ),
    };
  }
}

async function cancelIfSupported(
  transport: ConversationTransport<FakeConversationEvent, FakeStartRequest>,
  input: CancelTurnInput,
): Promise<TransportResult<AuthoritativeCancelTurnResult> | { status: "unsupported" }> {
  const cancellation = transport.capabilities.authoritativeCancellation;
  if (!cancellation.supported) {
    return { status: "unsupported" };
  }
  return cancellation.capability.cancelTurn(input);
}

describe("ConversationTransport contract", () => {
  it("exposes a validated normalized receipt from a generic transport", async () => {
    const transport: ConversationTransport<
      FakeConversationEvent,
      FakeStartRequest
    > = new FakeTransport(normalizedReceipt);
    const started = await transport.startTurn({
      conversationId: "conversation-1",
      conversationTurnId: callerTurnId,
      mutationId: "mutation-receipt-1",
      idempotencyKey: "idempotency-receipt-1",
      request: { text: "receipt" },
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const observed: FakeConversationEvent[] = [];
    for await (const event of started.value.observation.events) observed.push(event);
    const result = await started.value.observation.result;

    expect(observed).toEqual(events);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.usageReceipt).toBe(normalizedReceipt);
  });

  it("keeps adapter-specific results assignable to the common result", () => {
    expectTypeOf<DirectProviderTurnObservationResult>().toMatchTypeOf<TurnObservationResult>();
    expectTypeOf<ManagedRuntimeTurnObservationResult>().toMatchTypeOf<TurnObservationResult>();
    expectTypeOf<
      Extract<
        DirectProviderTurnObservationResult,
        { status: "completed" }
      >["usageReceipt"]
    >().toEqualTypeOf<NormalizedUsageReceipt>();
  });

  it("starts with caller identifiers, disconnects locally, and resumes from a checkpoint", async () => {
    const transport = new FakeTransport();
    const started = await transport.startTurn({
      conversationId: "conversation-1",
      conversationTurnId: callerTurnId,
      mutationId: "mutation-client-1",
      idempotencyKey: "idempotency-client-1",
      request: { text: "hello" },
    });

    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const iterator = started.value.observation.events[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first).toEqual({ done: false, value: events[0] });

    started.value.observation.disconnect();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(await started.value.observation.result).toEqual({
      status: "disconnected",
      checkpoint: checkpointFor(events[0]!),
    });

    expect(transport.starts[0]).toMatchObject({
      conversationTurnId: callerTurnId,
      mutationId: "mutation-client-1",
      idempotencyKey: "idempotency-client-1",
    });
    expect(transport.capabilities.authoritativeCancellation.supported).toBe(false);

    const resumeFrom = checkpointFor(events[0]!);
    const resumed = await transport.resumeTurn({
      conversationId: started.value.conversationId,
      turnId: started.value.turnId,
      resumeFrom,
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;

    const resumedEvents: FakeConversationEvent[] = [];
    for await (const event of resumed.value.events) resumedEvents.push(event);

    expect(resumedEvents).toEqual([events[1]]);
    expect(await resumed.value.result).toEqual({
      status: "completed",
      checkpoint: checkpointFor(events[1]!),
    });
    expect(transport.resumes).toEqual([
      {
        conversationId: "conversation-1",
        turnId: "turn-1",
        resumeFrom: {
          lastAppliedEventId: "event-1",
          lastAppliedCursor: "cursor-1",
          lastAppliedRevision: 1,
        },
      },
    ]);
  });

  it("declines unsupported authoritative cancellation without invoking an operation", async () => {
    const transport = new FakeTransport();
    const result = await cancelIfSupported(transport, {
      conversationId: "conversation-1",
      turnId: "turn-1",
      mutationId: "mutation-cancel-1",
      idempotencyKey: "idempotency-cancel-1",
      reason: "user",
    });

    expect(result).toEqual({ status: "unsupported" });
    expect("capability" in transport.capabilities.authoritativeCancellation).toBe(false);
  });

  it("exposes an AsyncIterable event boundary with no assumed optional operations", () => {
    const transport: ConversationTransport<FakeConversationEvent, FakeStartRequest> =
      new FakeTransport();

    expectTypeOf(transport.startTurn).toBeFunction();
    expectTypeOf(transport.resumeTurn).toBeFunction();
    expectTypeOf<
      ConversationTransport<FakeConversationEvent, FakeStartRequest>["capabilities"]
    >().not.toHaveProperty("fetch");
    expect(transport.capabilities.attachmentUpload.supported).toBe(false);
    expect(transport.capabilities.presence.supported).toBe(false);
    expect(transport.capabilities.synchronization.supported).toBe(false);
  });
});
