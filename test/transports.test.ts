import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  AuthoritativeCancelTurnResult,
  CancelTurnInput,
  ConversationTransport,
  ResumeTurnInput,
  StartTurnInput,
  TransportResult,
  TurnHandle,
  TurnObservation,
  TurnObservationResult,
  TurnResumePoint,
} from "../src/index.js";

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
        resolveResult({ status: "completed", checkpoint });
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
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  } as const;

  readonly starts: StartTurnInput<FakeStartRequest>[] = [];
  readonly resumes: ResumeTurnInput[] = [];

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
        observation: createObservation(events, initialCheckpoint),
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
      value: createObservation(remainingEvents, input.resumeFrom),
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
  it("starts with caller identifiers, disconnects locally, and resumes from a checkpoint", async () => {
    const transport = new FakeTransport();
    const started = await transport.startTurn({
      conversationId: "conversation-1",
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
