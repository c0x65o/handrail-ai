import {
  CONVERSATION_EVENT_VERSION,
  parseConversationEvent,
  type ConversationAttachmentReference,
  type ConversationClientId,
  type ConversationClientMutationId,
  type ConversationDeviceId,
  type ConversationEvent,
  type ConversationEventActor,
  type ConversationEventId,
  type ConversationEventMetadata,
  type ConversationEventPayload,
  type ConversationEventSource,
  type ConversationId,
  type ConversationMessageContentPart,
  type ConversationMessageId,
  type ConversationRevision,
  type ConversationTimestamp,
  type ConversationToolCallId,
  type ConversationTurnCancellationReason,
  type ConversationTurnId,
} from "./conversation/events.js";
import type {
  ConversationEventCursor,
  ConversationEventStore,
} from "./conversation/event-store.js";
import { replayConversation } from "./conversation/replay.js";
import type { ConversationState } from "./conversation/state.js";
import type { ConversationStore } from "./conversation/store.js";
import {
  parseStreamEvent,
  type StreamEvent,
  type TerminalStreamEvent,
} from "./protocol.js";
import type {
  ConversationTransport,
  TransportError,
  TurnObservation,
  TurnObservationResult,
  TurnResumePoint,
} from "./transports/types.js";

const RUNTIME_METADATA_KEY = "handrail_runtime";

export type ConversationRuntimeIdKind =
  | "message"
  | "assistant_message"
  | "turn"
  | "mutation"
  | "event"
  | "idempotency";

export interface ConversationRuntimeOptions<TRequest> {
  readonly conversationId: ConversationId;
  readonly clientId: ConversationClientId;
  readonly deviceId?: ConversationDeviceId;
  readonly transport: ConversationTransport<unknown, TRequest>;
  readonly eventStore: ConversationEventStore;
  /** Deterministic identity source for tests or host-controlled identities. */
  readonly createId?: (kind: ConversationRuntimeIdKind) => string;
  /** RFC 3339 UTC string or Date. Defaults to the current wall-clock time. */
  readonly now?: () => string | Date;
  readonly replayBatchSize?: number;
}

export interface ConversationRuntimeSendMessageInput<TRequest> {
  readonly content: string | readonly ConversationMessageContentPart[];
  readonly attachments?: readonly ConversationAttachmentReference[];
  readonly request: TRequest;
}

export type ConversationRuntimeTurnStatus =
  | "completed"
  | "cancelled"
  | "failed"
  | "disconnected"
  | "interrupted";

export interface ConversationRuntimeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ConversationRuntimeTurnResult {
  readonly turnId: ConversationTurnId;
  readonly status: ConversationRuntimeTurnStatus;
  /** The latest transport frame whose effects are durably represented. */
  readonly checkpoint: TurnResumePoint;
  readonly error?: ConversationRuntimeError;
}

export type ConversationRuntimeObserver = (snapshot: ConversationState) => void;

export interface ConversationRuntime<TRequest> {
  readonly store: ConversationStore;
  getSnapshot(): ConversationState;
  observe(observer: ConversationRuntimeObserver): () => void;
  sendMessage(
    input: ConversationRuntimeSendMessageInput<TRequest>,
  ): Promise<ConversationRuntimeTurnResult>;
  resumeTurn(turnId: ConversationTurnId): Promise<ConversationRuntimeTurnResult>;
  restoreActiveTurn(): Promise<ConversationRuntimeTurnResult | null>;
  destroy(): void;
}

export class ConversationRuntimeDestroyedError extends Error {
  constructor() {
    super("The conversation runtime has been destroyed");
    this.name = "ConversationRuntimeDestroyedError";
  }
}

export class ConversationRuntimeBusyError extends Error {
  constructor() {
    super("The conversation already has an active turn");
    this.name = "ConversationRuntimeBusyError";
  }
}

interface RuntimeMetadata {
  readonly transportTurnId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
  readonly sequence?: number;
  readonly frameType?: StreamEvent["type"];
  readonly resumeSafe?: boolean;
}

interface TurnProtocolState {
  transportTurnId: string | null;
  requestId: string | null;
  traceId: string | null;
  safeSequence: number | null;
}

interface EventDraft {
  readonly actor: ConversationEventActor;
  readonly source: ConversationEventSource;
  readonly mutationId?: ConversationClientMutationId;
  readonly metadata?: ConversationEventMetadata;
  readonly payload: ConversationEventPayload;
}

interface FrameState {
  readonly turnId: ConversationTurnId;
  readonly protocol: TurnProtocolState;
  expectedSequence: number;
  text: string;
  hasUnsafeFrame: boolean;
  terminal: TerminalStreamEvent | null;
  lastWasTerminal: boolean;
  failure: ConversationRuntimeError | null;
}

const EMPTY_CHECKPOINT: TurnResumePoint = Object.freeze({
  lastAppliedEventId: null,
  lastAppliedCursor: null,
  lastAppliedRevision: null,
});

/**
 * Hydrate and compose the durable event log, headless projection, and transport.
 * No network observation begins until sendMessage/resumeTurn is called.
 */
export async function createConversationRuntime<TRequest>(
  options: ConversationRuntimeOptions<TRequest>,
): Promise<ConversationRuntime<TRequest>> {
  const replay = await replayConversation({
    conversationId: options.conversationId,
    eventStore: options.eventStore,
    ...(options.replayBatchSize === undefined
      ? {}
      : { readBatchSize: options.replayBatchSize }),
  });
  const store = replay.store;
  const createId = options.createId ?? defaultId;
  const now = options.now ?? (() => new Date());
  const protocolByTurn = new Map<string, TurnProtocolState>();
  const durableFrameKeys = new Set<string>();
  const activeObservations = new Map<string, TurnObservation<unknown>>();
  const runningTurns = new Map<string, Promise<ConversationRuntimeTurnResult>>();
  let destroyed = false;
  let mutationBoundary: Promise<void> = Promise.resolve();

  await hydrateRuntimeMetadata(
    options.conversationId,
    options.eventStore,
    protocolByTurn,
    durableFrameKeys,
  );

  const assertUsable = (): void => {
    if (destroyed) throw new ConversationRuntimeDestroyedError();
  };

  const timestamp = (): ConversationTimestamp => {
    const value = now();
    return (value instanceof Date ? value.toISOString() : value) as ConversationTimestamp;
  };

  const runtimeSource = (): ConversationEventSource => ({ type: "runtime" });
  const clientSource = (): ConversationEventSource => ({
    type: "client",
    client_id: options.clientId,
    ...(options.deviceId === undefined ? {} : { device_id: options.deviceId }),
  });

  const persist = async (
    drafts: readonly EventDraft[],
  ): Promise<readonly ConversationEvent[]> => {
    assertUsable();
    if (drafts.length === 0) return [];
    let resolveBoundary!: () => void;
    const previousBoundary = mutationBoundary;
    mutationBoundary = new Promise<void>((resolve) => {
      resolveBoundary = resolve;
    });
    await previousBoundary;
    try {
      assertUsable();
      const expectedRevision = store.getSnapshot().revision;
      const occurredAt = timestamp();
      const events = drafts.map((draft, index) =>
        parseConversationEvent({
          version: CONVERSATION_EVENT_VERSION,
          event_id: createId("event") as ConversationEventId,
          conversation_id: options.conversationId,
          revision: ((expectedRevision ?? 0) + index + 1) as ConversationRevision,
          occurred_at: occurredAt,
          actor: draft.actor,
          source: draft.source,
          ...(draft.mutationId === undefined
            ? {}
            : { mutation_id: draft.mutationId }),
          ...(draft.metadata === undefined ? {} : { metadata: draft.metadata }),
          payload: draft.payload,
        }),
      );
      const appended = await options.eventStore.append({
        conversationId: options.conversationId,
        expectedRevision,
        events,
      });
      assertUsable();
      const storedEvents = appended.entries.map((entry) => entry.event);
      const nextState = await store.applyEvents(storedEvents);
      if (nextState.replay_error !== null) {
        throw new TypeError("Persisted conversation events could not be projected contiguously");
      }
      for (const event of storedEvents) rememberRuntimeMetadata(
        event,
        protocolByTurn,
        durableFrameKeys,
      );
      return storedEvents;
    } finally {
      resolveBoundary();
    }
  };

  const result = (
    turnId: ConversationTurnId,
    status: ConversationRuntimeTurnStatus,
    error?: ConversationRuntimeError,
  ): ConversationRuntimeTurnResult => Object.freeze({
    turnId,
    status,
    checkpoint: checkpointFor(protocolByTurn.get(turnId)),
    ...(error === undefined ? {} : { error: Object.freeze({ ...error }) }),
  });

  const observeTransport = async (
    turnId: ConversationTurnId,
    observation: TurnObservation<unknown>,
  ): Promise<ConversationRuntimeTurnResult> => {
    const protocol = protocolState(protocolByTurn, turnId);
    const frameState: FrameState = {
      turnId,
      protocol,
      expectedSequence: (protocol.safeSequence ?? -1) + 1,
      text: "",
      hasUnsafeFrame: false,
      terminal: null,
      lastWasTerminal: false,
      failure: null,
    };
    // Only duplicates within this observation are suppressed. Frames whose
    // effects were not durable (notably text deltas) must be accepted again
    // when a later observation resumes from the last safe checkpoint.
    const liveFrameFingerprints = new Map<string, string>();
    activeObservations.set(turnId, observation);
    let transportResult: TurnObservationResult | null = null;

    try {
      try {
        for await (const rawFrame of observation.events) {
          assertUsable();
          const frame = parseStreamEvent(rawFrame);
          const disposition = acceptFrame(
            frameState,
            frame,
            durableFrameKeys,
            liveFrameFingerprints,
          );
          if (disposition === "duplicate") continue;

          const drafts = draftsForNonterminalFrame(frameState, frame, runtimeSource());
          if (drafts.length > 0) {
            await persist(drafts);
            if (drafts.some((draft) => runtimeMetadata(draft.metadata)?.resumeSafe)) {
              protocol.safeSequence = frame.sequence;
            }
          }
        }
      } catch (cause) {
        if (cause instanceof ConversationRuntimeDestroyedError) throw cause;
        frameState.failure = runtimeFailure(cause);
        observation.disconnect();
      }

      try {
        transportResult = await observation.result;
      } catch (cause) {
        frameState.failure ??= runtimeFailure(cause);
      }

      if (destroyed) throw new ConversationRuntimeDestroyedError();
      if (frameState.failure !== null) {
        return result(turnId, "interrupted", frameState.failure);
      }
      if (frameState.terminal === null || !frameState.lastWasTerminal) {
        const disconnected = transportResult?.status === "disconnected";
        return result(
          turnId,
          disconnected ? "disconnected" : "interrupted",
          disconnected
            ? undefined
            : {
                code: "missing_terminal",
                message: "The transport observation ended without one terminal response frame",
                retryable: true,
              },
        );
      }
      if (!terminalMatchesResult(frameState.terminal, transportResult)) {
        return result(turnId, "interrupted", {
          code: "terminal_result_conflict",
          message: "The terminal response frame conflicts with the transport result",
          retryable: false,
        });
      }

      await persist(
        draftsForTerminal(
          frameState,
          frameState.terminal,
          createId,
          runtimeSource(),
        ),
      );
      protocol.safeSequence = frameState.terminal.sequence;
      switch (frameState.terminal.type) {
        case "response.completed":
          return result(turnId, "completed");
        case "response.cancelled":
          return result(turnId, "cancelled");
        case "response.error":
          return result(turnId, "failed", {
            code: frameState.terminal.error.code,
            message: frameState.terminal.error.message,
            retryable: frameState.terminal.error.retryable,
          });
      }
    } finally {
      if (activeObservations.get(turnId) === observation) {
        activeObservations.delete(turnId);
      }
    }
  };

  const runObservation = (
    turnId: ConversationTurnId,
    observationFactory: () => Promise<TurnObservation<unknown>>,
  ): Promise<ConversationRuntimeTurnResult> => {
    const existing = runningTurns.get(turnId);
    if (existing !== undefined) return existing;
    const operation = (async () => {
      const observation = await observationFactory();
      return observeTransport(turnId, observation);
    })();
    runningTurns.set(turnId, operation);
    void operation.finally(() => {
      if (runningTurns.get(turnId) === operation) runningTurns.delete(turnId);
    }).catch(() => undefined);
    return operation;
  };

  const resumeTurn = (
    turnId: ConversationTurnId,
  ): Promise<ConversationRuntimeTurnResult> => {
    assertUsable();
    const turn = store.getSnapshot().turns.find((candidate) => candidate.turn_id === turnId);
    if (turn === undefined) throw new TypeError("The requested turn is not durable history");
    if (isTerminalTurnStatus(turn.status)) {
      throw new TypeError("A terminal turn cannot be resumed");
    }
    const protocol = protocolByTurn.get(turnId);
    if (protocol?.transportTurnId === null || protocol?.transportTurnId === undefined) {
      throw new TypeError("The active turn has no durable transport identity");
    }
    return runObservation(turnId, async () => {
      const resumed = await options.transport.resumeTurn({
        conversationId: options.conversationId,
        turnId: protocol.transportTurnId!,
        resumeFrom: checkpointFor(protocol),
      });
      if (!resumed.ok) {
        return failedObservation(resumed.error, checkpointFor(protocol));
      }
      return resumed.value;
    });
  };

  const sendMessage = async (
    input: ConversationRuntimeSendMessageInput<TRequest>,
  ): Promise<ConversationRuntimeTurnResult> => {
    assertUsable();
    if (store.getSnapshot().active_turn_id !== null) {
      throw new ConversationRuntimeBusyError();
    }
    const content = normalizeMessageContent(input.content);
    const attachments = input.attachments ?? [];
    const messageId = createId("message") as ConversationMessageId;
    const turnId = createId("turn") as ConversationTurnId;
    const startMutationId = createId("mutation") as ConversationClientMutationId;
    const idempotencyKey = createId("idempotency");
    const initialDrafts: EventDraft[] = [
      {
        actor: { type: "user" },
        source: clientSource(),
        mutationId: startMutationId,
        payload: {
          type: "message.created",
          message_id: messageId,
          role: "user",
          content,
        },
      },
      ...attachments.map((attachment): EventDraft => ({
        actor: { type: "user" },
        source: clientSource(),
        mutationId: createId("mutation") as ConversationClientMutationId,
        payload: {
          type: "message.attachment_referenced",
          message_id: messageId,
          attachment: { ...attachment },
        },
      })),
      {
        actor: { type: "assistant" },
        source: runtimeSource(),
        payload: {
          type: "turn.started",
          turn_id: turnId,
          input_message_ids: [messageId],
        },
      },
    ];
    await persist(initialDrafts);

    const started = await options.transport.startTurn({
      conversationId: options.conversationId,
      mutationId: startMutationId,
      idempotencyKey,
      request: input.request,
    });
    if (!started.ok) {
      await persist([failedTurnDraft(turnId, started.error, runtimeSource())]);
      return result(turnId, "failed", started.error);
    }
    if (
      started.value.conversationId !== options.conversationId ||
      started.value.mutationId !== startMutationId ||
      started.value.turnId.length === 0
    ) {
      started.value.observation.disconnect();
      const error = {
        code: "invalid_transport_handle",
        message: "The transport returned a handle with conflicting identities",
        retryable: false,
      };
      await persist([failedTurnDraft(turnId, error, runtimeSource())]);
      return result(turnId, "failed", error);
    }

    const protocol = protocolState(protocolByTurn, turnId);
    protocol.transportTurnId = started.value.turnId;
    await persist([{
      actor: { type: "assistant" },
      source: runtimeSource(),
      metadata: metadataFor({ transportTurnId: started.value.turnId }),
      payload: { type: "turn.status_changed", turn_id: turnId, status: "queued" },
    }]);
    return runObservation(turnId, async () => started.value.observation);
  };

  const restoreActiveTurn = (): Promise<ConversationRuntimeTurnResult | null> => {
    assertUsable();
    const activeTurnId = store.getSnapshot().active_turn_id;
    return activeTurnId === null
      ? Promise.resolve(null)
      : resumeTurn(activeTurnId);
  };

  const observe = (observer: ConversationRuntimeObserver): (() => void) => {
    assertUsable();
    return store.subscribe(() => observer(store.getSnapshot()));
  };

  const destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    for (const observation of activeObservations.values()) observation.disconnect();
    activeObservations.clear();
    store.destroy();
  };

  return Object.freeze({
    store,
    getSnapshot: () => store.getSnapshot(),
    observe,
    sendMessage,
    resumeTurn,
    restoreActiveTurn,
    destroy,
  });
}

function normalizeMessageContent(
  content: string | readonly ConversationMessageContentPart[],
): ConversationMessageContentPart[] {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content.map((part) => ({ ...part }));
}

function draftsForNonterminalFrame(
  state: FrameState,
  frame: StreamEvent,
  source: ConversationEventSource,
): EventDraft[] {
  const metadata = (resumeSafe: boolean): ConversationEventMetadata =>
    metadataFor({
      ...(state.protocol.transportTurnId === null
        ? {}
        : { transportTurnId: state.protocol.transportTurnId }),
      requestId: frame.request_id,
      traceId: frame.trace_id,
      sequence: frame.sequence,
      frameType: frame.type,
      resumeSafe,
    });

  switch (frame.type) {
    case "response.started": {
      const safe = !state.hasUnsafeFrame;
      return [{
        actor: { type: "assistant" },
        source,
        metadata: metadata(safe),
        payload: { type: "turn.status_changed", turn_id: state.turnId, status: "running" },
      }];
    }
    case "response.text.delta":
      state.text += frame.delta;
      state.hasUnsafeFrame = true;
      return [];
    case "response.tool_call": {
      const safe = !state.hasUnsafeFrame;
      return [{
        actor: { type: "assistant" },
        source,
        metadata: metadata(safe),
        payload: {
          type: "tool_call.requested",
          turn_id: state.turnId,
          tool_call_id: frame.tool_call_id as ConversationToolCallId,
          name: frame.name,
          arguments: frame.arguments,
        },
      }];
    }
    case "response.usage":
      state.hasUnsafeFrame = true;
      return [];
    case "response.completed":
    case "response.cancelled":
    case "response.error":
      return [];
  }
}

function draftsForTerminal(
  state: FrameState,
  terminal: TerminalStreamEvent,
  createId: (kind: ConversationRuntimeIdKind) => string,
  source: ConversationEventSource,
): EventDraft[] {
  const metadata = metadataFor({
    ...(state.protocol.transportTurnId === null
      ? {}
      : { transportTurnId: state.protocol.transportTurnId }),
    requestId: terminal.request_id,
    traceId: terminal.trace_id,
    sequence: terminal.sequence,
    frameType: terminal.type,
    resumeSafe: true,
  });
  if (terminal.type === "response.completed") {
    const assistantMessageId =
      state.text.length === 0 ? null : createId("assistant_message");
    return [
      ...(assistantMessageId === null
        ? []
        : [{
            actor: { type: "assistant" } as ConversationEventActor,
            source,
            metadata,
            payload: {
              type: "message.created" as const,
              message_id: assistantMessageId as ConversationMessageId,
              role: "assistant" as const,
              content: [{ type: "text" as const, text: state.text }],
            },
          }]),
      {
        actor: { type: "assistant" },
        source,
        metadata,
        payload: {
          type: "turn.completed",
          turn_id: state.turnId,
          outcome: terminal.outcome,
          output_message_ids:
            assistantMessageId === null
              ? []
              : [assistantMessageId as ConversationMessageId],
        },
      },
    ];
  }
  if (terminal.type === "response.cancelled") {
    return [{
      actor: { type: "assistant" },
      source,
      metadata,
      payload: {
        type: "turn.cancelled",
        turn_id: state.turnId,
        reason: cancellationReason(terminal.reason),
      },
    }];
  }
  return [{
    actor: { type: "assistant" },
    source,
    metadata,
    payload: {
      type: "turn.failed",
      turn_id: state.turnId,
      error: {
        code: terminal.error.code,
        message: terminal.error.message,
        retryable: terminal.error.retryable,
      },
    },
  }];
}

function acceptFrame(
  state: FrameState,
  frame: StreamEvent,
  durableFrameKeys: ReadonlySet<string>,
  liveFingerprints: Map<string, string>,
): "accepted" | "duplicate" {
  const key = frameKey(frame.request_id, frame.sequence);
  const fingerprint = JSON.stringify(frame);
  const existingFingerprint = liveFingerprints.get(key);
  if (existingFingerprint !== undefined && existingFingerprint !== fingerprint) {
    throw new TypeError("A replayed request_id and sequence contained conflicting data");
  }
  const known = durableFrameKeys.has(key) || existingFingerprint !== undefined;
  if (frame.sequence < state.expectedSequence) {
    if (!known) throw new TypeError("The transport replayed an unknown stale sequence");
    return "duplicate";
  }
  if (frame.sequence !== state.expectedSequence) {
    throw new TypeError("Transport frame sequences must be contiguous");
  }
  if (state.lastWasTerminal) {
    throw new TypeError("A response frame followed the terminal response frame");
  }
  if (known) {
    liveFingerprints.set(key, fingerprint);
    state.expectedSequence += 1;
    return "duplicate";
  }
  if (state.protocol.requestId === null) {
    if (frame.type !== "response.started" || frame.sequence !== 0) {
      throw new TypeError("The first response frame must be response.started at sequence zero");
    }
    state.protocol.requestId = frame.request_id;
    state.protocol.traceId = frame.trace_id;
  } else if (
    frame.request_id !== state.protocol.requestId ||
    (state.protocol.traceId !== null && frame.trace_id !== state.protocol.traceId)
  ) {
    throw new TypeError("Transport frame stream identities must remain stable");
  }
  if (frame.type === "response.started" && frame.sequence !== 0) {
    throw new TypeError("response.started may appear only once");
  }
  liveFingerprints.set(key, fingerprint);
  state.expectedSequence += 1;
  state.lastWasTerminal = isTerminalFrame(frame);
  if (state.lastWasTerminal) state.terminal = frame as TerminalStreamEvent;
  return "accepted";
}

function terminalMatchesResult(
  terminal: TerminalStreamEvent,
  result: TurnObservationResult | null,
): boolean {
  if (result === null) return false;
  return (
    (terminal.type === "response.completed" && result.status === "completed") ||
    (terminal.type === "response.cancelled" && result.status === "cancelled") ||
    (terminal.type === "response.error" && result.status === "failed")
  );
}

function isTerminalFrame(frame: StreamEvent): frame is TerminalStreamEvent {
  return frame.type === "response.completed" ||
    frame.type === "response.cancelled" ||
    frame.type === "response.error";
}

function failedTurnDraft(
  turnId: ConversationTurnId,
  error: TransportError | ConversationRuntimeError,
  source: ConversationEventSource,
): EventDraft {
  return {
    actor: { type: "assistant" },
    source,
    payload: {
      type: "turn.failed",
      turn_id: turnId,
      error: { code: error.code, message: error.message, retryable: error.retryable },
    },
  };
}

function failedObservation(
  error: TransportError,
  checkpoint: TurnResumePoint,
): TurnObservation<unknown> {
  return {
    events: { async *[Symbol.asyncIterator]() { /* no response frames */ } },
    result: Promise.resolve({ status: "failed", checkpoint, error }),
    disconnect() { /* already settled */ },
  };
}

function cancellationReason(reason: string): ConversationTurnCancellationReason {
  switch (reason) {
    case "deadline_exceeded": return "timeout";
    case "policy_revoked": return "superseded";
    default: return "runtime_shutdown";
  }
}

function runtimeFailure(cause: unknown): ConversationRuntimeError {
  return {
    code: "invalid_protocol",
    message: cause instanceof Error ? cause.message : "The transport observation failed",
    retryable: false,
  };
}

function metadataFor(metadata: RuntimeMetadata): ConversationEventMetadata {
  const runtime: Record<string, string | number | boolean> = {};
  if (metadata.transportTurnId !== undefined) runtime.transport_turn_id = metadata.transportTurnId;
  if (metadata.requestId !== undefined) runtime.request_id = metadata.requestId;
  if (metadata.traceId !== undefined) runtime.trace_id = metadata.traceId;
  if (metadata.sequence !== undefined) runtime.sequence = metadata.sequence;
  if (metadata.frameType !== undefined) runtime.frame_type = metadata.frameType;
  if (metadata.resumeSafe !== undefined) runtime.resume_safe = metadata.resumeSafe;
  return { [RUNTIME_METADATA_KEY]: runtime };
}

function runtimeMetadata(metadata: ConversationEventMetadata | undefined): RuntimeMetadata | null {
  if (metadata === undefined) return null;
  const raw = metadata[RUNTIME_METADATA_KEY];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    ...(typeof value.transport_turn_id === "string"
      ? { transportTurnId: value.transport_turn_id }
      : {}),
    ...(typeof value.request_id === "string" ? { requestId: value.request_id } : {}),
    ...(typeof value.trace_id === "string" ? { traceId: value.trace_id } : {}),
    ...(Number.isSafeInteger(value.sequence) ? { sequence: value.sequence as number } : {}),
    ...(typeof value.frame_type === "string"
      ? { frameType: value.frame_type as StreamEvent["type"] }
      : {}),
    ...(typeof value.resume_safe === "boolean" ? { resumeSafe: value.resume_safe } : {}),
  };
}

function turnIdForEvent(event: ConversationEvent): ConversationTurnId | null {
  return "turn_id" in event.payload ? event.payload.turn_id : null;
}

function rememberRuntimeMetadata(
  event: ConversationEvent,
  protocolByTurn: Map<string, TurnProtocolState>,
  durableFrameKeys: Set<string>,
): void {
  const metadata = runtimeMetadata(event.metadata);
  const turnId = turnIdForEvent(event);
  if (metadata === null || turnId === null) return;
  const protocol = protocolState(protocolByTurn, turnId);
  if (metadata.transportTurnId !== undefined) protocol.transportTurnId = metadata.transportTurnId;
  if (metadata.requestId !== undefined) protocol.requestId = metadata.requestId;
  if (metadata.traceId !== undefined) protocol.traceId = metadata.traceId;
  if (metadata.requestId !== undefined && metadata.sequence !== undefined) {
    durableFrameKeys.add(frameKey(metadata.requestId, metadata.sequence));
    if (metadata.resumeSafe === true) {
      protocol.safeSequence = Math.max(protocol.safeSequence ?? -1, metadata.sequence);
    }
  }
}

async function hydrateRuntimeMetadata(
  conversationId: ConversationId,
  eventStore: ConversationEventStore,
  protocolByTurn: Map<string, TurnProtocolState>,
  durableFrameKeys: Set<string>,
): Promise<void> {
  let cursor: ConversationEventCursor | null = null;
  for (;;) {
    const page = await eventStore.read({
      conversationId,
      ...(cursor === null ? {} : { after: { cursor } }),
      limit: 500,
    });
    for (const entry of page.entries) {
      rememberRuntimeMetadata(entry.event, protocolByTurn, durableFrameKeys);
      cursor = entry.cursor;
    }
    if (!page.hasMore) return;
    if (page.nextCursor === null || (page.entries.length === 0 && page.nextCursor === cursor)) {
      throw new TypeError("The event store returned a non-advancing runtime hydration page");
    }
    cursor = page.nextCursor;
  }
}

function protocolState(
  states: Map<string, TurnProtocolState>,
  turnId: string,
): TurnProtocolState {
  const existing = states.get(turnId);
  if (existing !== undefined) return existing;
  const created: TurnProtocolState = {
    transportTurnId: null,
    requestId: null,
    traceId: null,
    safeSequence: null,
  };
  states.set(turnId, created);
  return created;
}

function checkpointFor(protocol: TurnProtocolState | undefined): TurnResumePoint {
  if (protocol?.requestId === null || protocol?.requestId === undefined || protocol.safeSequence === null) {
    return EMPTY_CHECKPOINT;
  }
  const eventId = frameKey(protocol.requestId, protocol.safeSequence);
  return Object.freeze({
    lastAppliedEventId: eventId,
    lastAppliedCursor: eventId,
    lastAppliedRevision: protocol.safeSequence,
  });
}

function frameKey(requestId: string, sequence: number): string {
  return `${requestId}:${sequence}`;
}

function isTerminalTurnStatus(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

let fallbackIdCounter = 0;
function defaultId(kind: ConversationRuntimeIdKind): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid !== undefined) return `${kind}_${uuid}`;
  fallbackIdCounter += 1;
  return `${kind}_${Date.now().toString(36)}_${fallbackIdCounter.toString(36)}`;
}
