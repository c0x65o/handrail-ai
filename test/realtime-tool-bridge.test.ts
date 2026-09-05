import { describe, expect, it, vi } from "vitest";

import {
  BoundedToolExecutor,
  InMemoryApprovalProposalStore,
  InMemoryConversationEventStore,
  InMemoryRealtimeVoiceToolCallBindingStore,
  InMemoryToolExecutionLedger,
  REALTIME_VOICE_CONTRACT_VERSION,
  REALTIME_VOICE_TOOL_LIMITS,
  RealtimeVoiceValidationError,
  ToolRegistry,
  createApprovalCoordinator,
  createApprovalExecutionCoordinator,
  createIdempotentRealtimeVoiceSessionAuthority,
  createRealtimeVoiceServerToolBridge,
  parseRealtimeVoiceServerToolCall,
  replayConversation,
  parseConversationEvent,
  type ConversationEventStore,
  type ApplicationToolExecutor,
  type ApplicationToolPolicy,
  type ApprovalExecutionResume,
  type ConversationApprovalProposalId,
  type ConversationEventAttribution,
  type ConversationId,
  type ConversationTimestamp,
  type RealtimeVoiceIdempotencyKey,
  type RealtimeVoiceServerToolCapabilityReference,
  type RealtimeVoiceSessionId,
  type ToolDefinition,
} from "../src/index.js";

const sessionId = "realtime-session-1" as RealtimeVoiceSessionId;
const capabilityRef = "tools:voice-bounded" as RealtimeVoiceServerToolCapabilityReference;
const conversationId = "conversation-realtime" as ConversationId;
const turnId = "turn-realtime" as never;
const systemAttribution = {
  actor: { type: "system", id: "trusted-realtime-host" },
  source: { type: "runtime" },
} as unknown as ConversationEventAttribution;
const userAttribution = {
  actor: { type: "user", id: "reviewer" },
  source: { type: "client", client_id: "approval-review" },
} as unknown as ConversationEventAttribution;

const definition = (name: string): ToolDefinition => ({
  name,
  description: `${name} test tool`,
  input_schema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
});

const call = (
  overrides: Record<string, unknown> = {},
  targetSession = sessionId,
) => ({
  version: REALTIME_VOICE_CONTRACT_VERSION,
  session_id: targetSession,
  capability_ref: capabilityRef,
  call_id: "provider-call-1",
  idempotency_key: `tool:${targetSession}:1`,
  name: "read.echo",
  arguments: { value: "weather in Bowling Green" },
  ...overrides,
});

interface HarnessOptions {
  readonly invoke?: ApplicationToolExecutor<{ credential: string; providerClient: object }>;
  readonly policy?: ApplicationToolPolicy<{ credential: string; providerClient: object }>;
  readonly timeoutMs?: number;
  readonly maxConcurrency?: number;
  readonly maxResultBytes?: number;
  readonly bindingStore?: InMemoryRealtimeVoiceToolCallBindingStore;
  readonly ledger?: InMemoryToolExecutionLedger;
}

function harness(options: HarnessOptions = {}) {
  const invoke = vi.fn<ApplicationToolExecutor<{
    credential: string;
    providerClient: object;
  }>>(options.invoke ?? (async (arguments_) => ({
    echoed: arguments_.value ?? null,
  })));
  const registry = new ToolRegistry<typeof invoke, { enabled: boolean }>();
  registry.register({
    definition: definition("read.echo"),
    executor: invoke,
    capabilities: ["voice-tools"],
    discover: ({ enabled }) => enabled,
  });
  registry.register({
    definition: definition("write.sensitive"),
    executor: invoke,
    capabilities: ["voice-tools"],
  });
  registry.register({
    definition: definition("read.hidden"),
    executor: invoke,
    discover: () => false,
  });
  const executor = new BoundedToolExecutor({
    registry,
    policy: options.policy ?? (({ definition: tool }) => ({
      outcome: tool.name === "write.sensitive" ? "deny" : "allow",
    })),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    limits: {
      timeoutMs: options.timeoutMs ?? 500,
      maxConcurrency: options.maxConcurrency ?? 2,
      maxResultBytes: options.maxResultBytes ?? 4_096,
    },
  });
  const bindingStore = options.bindingStore ??
    new InMemoryRealtimeVoiceToolCallBindingStore();
  const bridge = createRealtimeVoiceServerToolBridge({ executor, bindingStore });
  const descriptor = bridge.registerSession({
    session_id: sessionId,
    capability_ref: capabilityRef,
    discovery: { context: { enabled: true }, capabilities: ["voice-tools"] },
    applicationContext: {
      credential: "sk-never-serialize-this",
      providerClient: { raw_response: "private" },
    },
  });
  return { bindingStore, bridge, descriptor, executor, invoke, registry };
}

const signal = () => new AbortController().signal;

describe("trusted-server realtime tool bridge", () => {
  it("executes an allowed discovered read-only call and enforces discovery and policy", async () => {
    const h = harness();
    await expect(h.bridge.execute(call(), { signal: signal() })).resolves.toMatchObject({
      status: "completed",
      result: { name: "read.echo", is_error: false },
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke.mock.calls[0]?.[1].applicationContext.credential)
      .toBe("sk-never-serialize-this");

    await expect(h.bridge.execute(call({
      call_id: "hidden-call",
      idempotency_key: "tool:hidden:1",
      name: "read.hidden",
    }), { signal: signal() })).resolves.toMatchObject({
      status: "completed",
      result: { is_error: true, content: [{ text: "Tool is unavailable for this call." }] },
    });
    await expect(h.bridge.execute(call({
      call_id: "denied-call",
      idempotency_key: "tool:denied:1",
      name: "write.sensitive",
    }), { signal: signal() })).resolves.toMatchObject({
      status: "completed",
      result: {
        is_error: true,
        content: [{ text: "Tool execution was denied by application policy." }],
      },
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("strictly clones, freezes, and bounds JSON argument envelopes", () => {
    const parsed = parseRealtimeVoiceServerToolCall(call());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.arguments)).toBe(true);
    for (const invalid of [
      call({ provider_event: { raw: true } }),
      call({ prompt: "hidden" }),
      call({ arguments: [] }),
      call({ arguments: { value: "ok", extra: () => undefined } }),
      call({ call_id: "bad call id" }),
      call({ arguments: { value: "x".repeat(
        REALTIME_VOICE_TOOL_LIMITS.argumentStringLength + 1,
      ) } }),
    ]) {
      expect(() => parseRealtimeVoiceServerToolCall(invalid)).toThrow(
        RealtimeVoiceValidationError,
      );
    }
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index <= REALTIME_VOICE_TOOL_LIMITS.argumentDepth; index += 1) {
      cursor.next = {};
      cursor = cursor.next as Record<string, unknown>;
    }
    expect(() => parseRealtimeVoiceServerToolCall(call({ arguments: deep }))).toThrow(/depth/);
  });

  it("rejects changed call bindings while isolating provider call IDs across sessions", async () => {
    const h = harness();
    await h.bridge.execute(call(), { signal: signal() });
    await expect(h.bridge.execute(call({
      arguments: { value: "tampered" },
    }), { signal: signal() })).resolves.toMatchObject({
      status: "failed",
      error: { code: "idempotency_conflict" },
    });
    await expect(h.bridge.execute(call({
      call_id: "capability-call",
      idempotency_key: "tool:capability:1",
      capability_ref: "tools:elevated",
    }), { signal: signal() })).resolves.toMatchObject({
      status: "failed",
      error: { code: "unsupported_capability" },
    });

    const secondSession = "realtime-session-2" as RealtimeVoiceSessionId;
    h.bridge.registerSession({
      session_id: secondSession,
      capability_ref: capabilityRef,
      discovery: { context: { enabled: true }, capabilities: ["voice-tools"] },
      applicationContext: { credential: "private", providerClient: {} },
    });
    await expect(h.bridge.execute(call({
      idempotency_key: "tool:session-2:1",
    }, secondSession), { signal: signal() })).resolves.toMatchObject({
      status: "completed",
      result: { is_error: false },
    });
    expect(h.invoke).toHaveBeenCalledTimes(2);
    await expect(h.bridge.execute(call({
      call_id: "changed-session-call",
      idempotency_key: `tool:${sessionId}:1`,
    }, secondSession), { signal: signal() })).resolves.toMatchObject({
      status: "failed",
      error: { code: "idempotency_conflict" },
    });
  });

  it("executes exactly once across concurrent and later retries", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ invoke: async () => { await held; return { ok: true }; } });
    const first = h.bridge.execute(call(), { signal: signal() });
    const concurrent = h.bridge.execute(call(), { signal: signal() });
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(1));
    await expect(h.bridge.execute(call({
      arguments: { value: "concurrently tampered" },
    }), { signal: signal() })).resolves.toMatchObject({
      status: "failed",
      error: { code: "idempotency_conflict" },
    });
    release();
    const [left, right] = await Promise.all([first, concurrent]);
    expect(left).toEqual(right);
    expect(await h.bridge.execute(call(), { signal: signal() })).toEqual(left);
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it("returns bounded sanitized results and retains no private host or provider values", async () => {
    const unsafe = harness({ invoke: async () => ({ api_key: "sk-provider-secret-value" }) });
    const result = await unsafe.bridge.execute(call(), { signal: signal() });
    expect(result).toMatchObject({
      status: "completed",
      result: {
        is_error: true,
        content: [{ text: "Tool returned an invalid or unsafe result." }],
      },
    });
    const serialized = JSON.stringify({
      descriptor: unsafe.descriptor,
      result,
      bridge: unsafe.bridge,
    });
    for (const marker of [
      "sk-provider-secret-value",
      "sk-never-serialize-this",
      "weather in Bowling Green",
      "providerClient",
      "raw_response",
      "prompt",
      "transcript",
      "audio",
      "executor",
    ]) expect(serialized).not.toContain(marker);

    const oversized = harness({
      invoke: async () => "x".repeat(256),
      maxResultBytes: 64,
    });
    await expect(oversized.bridge.execute(call(), { signal: signal() }))
      .resolves.toMatchObject({ status: "completed", result: { is_error: true } });
  });

  it("queues at the executor cap and releases it after completion", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const h = harness({
      maxConcurrency: 1,
      invoke: async (_arguments, context) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve, reject) => {
          releases.push(resolve);
          context.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        active -= 1;
        return { ok: true };
      },
    });
    const first = h.bridge.execute(call(), { signal: signal() });
    const second = h.bridge.execute(call({
      call_id: "provider-call-2",
      idempotency_key: "tool:session-1:2",
    }), { signal: signal() });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(h.invoke).toHaveBeenCalledTimes(1);
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(h.invoke).toHaveBeenCalledTimes(2);
    releases.shift()?.();
    await Promise.all([first, second]);
    expect(maximum).toBe(1);
  });

  it("normalizes timeout and caller cancellation without cross-session cancellation", async () => {
    const observedSignals: AbortSignal[] = [];
    const h = harness({
      timeoutMs: 25,
      invoke: async (_arguments, context) => {
        observedSignals.push(context.signal);
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("private")), {
            once: true,
          });
        });
        return { ok: true };
      },
    });
    await expect(h.bridge.execute(call(), { signal: signal() })).resolves.toMatchObject({
      status: "completed",
      result: { is_error: true, content: [{ text: "Tool execution timed out." }] },
    });
    expect(observedSignals[0]?.aborted).toBe(true);
    await expect(h.bridge.execute(call({
      call_id: "after-timeout",
      idempotency_key: "tool:after-timeout",
    }), { signal: signal() })).resolves.toMatchObject({
      status: "completed",
      result: { is_error: true, content: [{ text: "Tool execution timed out." }] },
    });
    expect(observedSignals).toHaveLength(2);

    const cancelled = harness({
      invoke: async (_arguments, context) => {
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("private")), {
            once: true,
          });
        });
        return { ok: true };
      },
    });
    const controller = new AbortController();
    const pending = cancelled.bridge.execute(call(), { signal: controller.signal });
    await vi.waitFor(() => expect(cancelled.invoke).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      status: "completed",
      result: { is_error: true, content: [{ text: "Tool execution was cancelled." }] },
    });

    let invocation = 0;
    let releaseOther!: () => void;
    const otherReady = new Promise<void>((resolve) => { releaseOther = resolve; });
    const isolated = harness({
      invoke: async (_arguments, context) => {
        invocation += 1;
        if (invocation === 1) {
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
          });
        } else {
          await otherReady;
          expect(context.signal.aborted).toBe(false);
        }
        return { ok: true };
      },
    });
    const otherSession = "realtime-cancellation-isolation" as RealtimeVoiceSessionId;
    isolated.bridge.registerSession({
      session_id: otherSession,
      capability_ref: capabilityRef,
      discovery: { context: { enabled: true }, capabilities: ["voice-tools"] },
      applicationContext: { credential: "private", providerClient: {} },
    });
    const isolatedController = new AbortController();
    const cancelledCall = isolated.bridge.execute(call({
      call_id: "isolated-cancelled",
      idempotency_key: "tool:isolated-cancelled",
    }), { signal: isolatedController.signal });
    await vi.waitFor(() => expect(isolated.invoke).toHaveBeenCalledTimes(1));
    const unaffectedCall = isolated.bridge.execute(call({
      call_id: "isolated-unaffected",
      idempotency_key: "tool:isolated-unaffected",
    }, otherSession), { signal: signal() });
    await vi.waitFor(() => expect(isolated.invoke).toHaveBeenCalledTimes(2));
    isolatedController.abort();
    releaseOther();
    await expect(cancelledCall).resolves.toMatchObject({
      status: "completed",
      result: { is_error: true },
    });
    await expect(unaffectedCall).resolves.toMatchObject({
      status: "completed",
      result: { is_error: false },
    });
  });

  it("authoritative hangup aborts queued/running work and rejects calls after cleanup", async () => {
    const started: AbortSignal[] = [];
    const h = harness({
      maxConcurrency: 1,
      timeoutMs: 2_000,
      invoke: async (_arguments, context) => {
        started.push(context.signal);
        await new Promise<void>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return { ok: true };
      },
    });
    const running = h.bridge.execute(call(), { signal: signal() });
    const queued = h.bridge.execute(call({
      call_id: "queued-call",
      idempotency_key: "tool:queued:1",
    }), { signal: signal() });
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const cleanupSession = vi.fn(async () => {
      expect(started[0]?.aborted).toBe(true);
    });
    const authority = createIdempotentRealtimeVoiceSessionAuthority({
      adapter: { endSession: async () => undefined, cleanupSession },
      toolBridge: h.bridge,
      now: () => Date.parse("2026-08-29T12:00:00.000Z"),
    });
    const hangup = {
      version: REALTIME_VOICE_CONTRACT_VERSION,
      request_id: "hangup-tools" as never,
      idempotency_key: "hangup:tools" as RealtimeVoiceIdempotencyKey,
      session_id: sessionId,
      reason: "client_request" as const,
      signal: signal(),
    };
    await expect(authority.hangup(hangup)).resolves.toMatchObject({ status: "ended" });
    await expect(Promise.all([running, queued])).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(cleanupSession).toHaveBeenCalledTimes(1);
    await expect(authority.hangup(hangup)).resolves.toMatchObject({ status: "ended" });
    await expect(h.bridge.execute(call({
      call_id: "after-hangup",
      idempotency_key: "tool:after-hangup",
    }), { signal: signal() })).resolves.toMatchObject({
      status: "failed",
      error: { code: "invalid_state" },
    });
  });
});

describe("realtime durable approval pause", () => {
  it.each(["new", "cancelled-before-resume", "legacy-orphan", "legacy-pending", "legacy-incomplete", "legacy-altered-review", "legacy-altered-actor"] as const)("persists a visible proposal and resumes exact confirmation from %s events", async (format) => {
    let events = new InMemoryConversationEventStore();
    const eventStore: ConversationEventStore = {
      getLatestRevision: (id) => events.getLatestRevision(id), read: (input) => events.read(input),
      append: (input) => events.append(input),
    };
    await events.append({ conversationId, expectedRevision: null, events: [parseConversationEvent({
      version: 1, event_id: "voice-input", conversation_id: conversationId,
      revision: 1, occurred_at: "2026-08-29T12:00:00.000Z", ...userAttribution,
      payload: { type: "message.created", message_id: "voice-input", role: "user",
        content: [{ type: "text", text: "Please update the record." }] },
    }), parseConversationEvent({
      version: 1, event_id: "voice-turn-start", conversation_id: conversationId,
      revision: 2, occurred_at: "2026-08-29T12:00:00.000Z", ...systemAttribution,
      payload: { type: "turn.started", turn_id: turnId, input_message_ids: ["voice-input"] },
    })] });
    const proposals = new InMemoryApprovalProposalStore<string>({
      authorize: ({ permissionContext }) => permissionContext === "allowed" ? "allow" : "deny",
      clock: { now: () => "2026-08-29T12:00:00.000Z" as ConversationTimestamp },
    });
    const ledger = new InMemoryToolExecutionLedger();
    const bindings = new InMemoryRealtimeVoiceToolCallBindingStore();
    const invoke = vi.fn<ApplicationToolExecutor>(async () => ({ changed: true }));
    const registry = new ToolRegistry<ApplicationToolExecutor, undefined>();
    registry.register({ definition: definition("write.sensitive"), executor: invoke });
    const approvalCoordinator = createApprovalExecutionCoordinator({
      proposalStore: proposals,
      eventStore,
      authorize: ({ permissionContext }) => permissionContext === "allowed" ? "allow" : "deny",
      verifyArguments: ({ binding, reviewedArguments, arguments: arguments_ }) =>
        binding.type === "reviewed_arguments_digest" &&
          binding.digest === "reviewed-value" &&
          reviewedArguments.type === "redacted_json" &&
          JSON.stringify(reviewedArguments.value) === JSON.stringify({ value: "[redacted]" }) &&
          arguments_.value === "private tool argument"
          ? "match"
          : "mismatch",
    });
    const executor = new BoundedToolExecutor({
      registry,
      policy: () => ({ outcome: "external_approval_required" }),
      approvalCoordinator,
      ledger,
    });
    let confirmed: ConversationApprovalProposalId | null = null;
    const makeBridge = () => createRealtimeVoiceServerToolBridge({
      executor,
      bindingStore: bindings,
      approvalWorkflow: {
        proposalStore: proposals,
        eventStore,
        reviewArguments: () => ({
          type: "redacted_json",
          value: { value: "[redacted]" },
        }),
        expiresAt: () => "2026-08-29T13:00:00.000Z" as ConversationTimestamp,
        resolveExecution: ({ proposalId }) => confirmed === proposalId
          ? ({
              permissionContext: "allowed",
              proposalId,
              expectedProposalVersion: 2,
              executionId: `execute-${proposalId}`,
              argumentBinding: {
                type: "reviewed_arguments_digest",
                digest: "reviewed-value",
              },
              attribution: systemAttribution,
            } satisfies ApprovalExecutionResume<string>)
          : undefined,
      },
    });
    const bridge = makeBridge();
    bridge.registerSession({
      session_id: sessionId,
      capability_ref: capabilityRef,
      discovery: { context: undefined },
      applicationContext: undefined,
      approval: {
        permissionContext: "allowed",
        conversationId,
        turnId,
        attribution: systemAttribution,
      },
    });
    const request = call({ name: "write.sensitive", arguments: { value: "private tool argument" } });
    const paused = await bridge.execute(request, { signal: signal() });
    expect(paused).toMatchObject({ status: "approval_required" });
    expect(invoke).not.toHaveBeenCalled();
    if (paused.status !== "approval_required") throw new Error("expected approval pause");
    const projected = await replayConversation({ conversationId, eventStore, checkpointPolicy: false });
    expect(projected.state.approval_proposals).toHaveLength(1);
    expect(projected.state.tool_calls[0]?.arguments).toEqual({ value: "[redacted]" });
    expect(JSON.stringify((await events.read({ conversationId })).entries)).not.toContain("private tool argument");
    if (format.startsWith("legacy-")) {
      // Earlier bridge versions persisted only approval events. Rebuild that
      // historical stream and retain subsequent real confirmation evidence.
      const saved = (await events.read({ conversationId })).entries.map((entry) => entry.event)
        .filter((event) => event.payload.type !== "tool_call.requested");
      const legacy = new InMemoryConversationEventStore();
      await legacy.append({ conversationId, expectedRevision: null, events: saved.map((event, index) =>
        parseConversationEvent({ ...event, revision: index + 1 })) });
      events = legacy;
      expect((await replayConversation({ conversationId, eventStore, checkpointPolicy: false })).state.approval_proposals).toEqual([]);
    }
    if (format === "legacy-pending" || format.startsWith("legacy-altered")) {
      expect(await bridge.execute(request, { signal: signal() })).toMatchObject({ status: "approval_required" });
      expect((await replayConversation({ conversationId, eventStore, checkpointPolicy: false })).state.approval_proposals)
        .toMatchObject([{ status: "pending", proposal_version: 1 }]);
    }
    confirmed = paused.proposal_id;
    const reviewer = createApprovalCoordinator({
      proposalStore: proposals,
      eventStore,
      authorize: () => "allow",
    });
    await expect(reviewer.decide({
      permissionContext: "allowed",
      conversationId,
      proposalId: confirmed,
      expectedVersion: 1,
      decision: "confirm",
      attribution: userAttribution,
      idempotencyKey: `confirm-${confirmed}`,
      idempotencyFingerprint: `confirm-${confirmed}`,
      signal: signal(),
    })).resolves.toMatchObject({ outcome: "accepted", proposalVersion: 2 });

    if (format === "cancelled-before-resume") {
      const revision = await events.getLatestRevision(conversationId);
      await events.append({ conversationId, expectedRevision: revision, events: [parseConversationEvent({
        version: 1, event_id: "voice-cancelled", conversation_id: conversationId,
        revision: Number(revision) + 1, occurred_at: "2026-08-29T12:01:00.000Z", ...systemAttribution,
        payload: { type: "turn.cancelled", turn_id: turnId, reason: "user" },
      })] });
      expect(await bridge.execute(request, { signal: signal() })).toMatchObject({ status: "completed", result: { is_error: true } });
      expect(invoke).not.toHaveBeenCalled();
      return;
    }

    if (format.startsWith("legacy-altered")) {
      const retained = (await events.read({ conversationId })).entries.map(({ event }) => {
        if (event.metadata?.repair_of_event_id === undefined || event.payload.type !== "approval.proposal_created") return event;
        return parseConversationEvent(format === "legacy-altered-review"
          ? { ...event, payload: { ...event.payload, reviewed_arguments: { type: "redacted_json", value: { value: "altered review" } } } }
          : { ...event, actor: { type: "system", id: "different-host" } });
      });
      events = new InMemoryConversationEventStore();
      await events.append({ conversationId, expectedRevision: null, events: retained });
      expect(await bridge.execute(request, { signal: signal() })).toMatchObject({ status: "completed", result: { is_error: true } });
      expect(invoke).not.toHaveBeenCalled();
      expect(await proposals.get({ permissionContext: "allowed", proposalId: confirmed }))
        .toMatchObject({ status: "confirmed", proposal_version: 2 });
      return;
    }

    if (format === "legacy-incomplete") {
      const retained = (await events.read({ conversationId })).entries.map((entry) => entry.event)
        .filter((event) => event.payload.type !== "approval.proposal_status_changed");
      events = new InMemoryConversationEventStore();
      await events.append({ conversationId, expectedRevision: null, events: retained.map((event, index) =>
        parseConversationEvent({ ...event, revision: index + 1 })) });
      expect(await bridge.execute(request, { signal: signal() })).toMatchObject({ status: "completed", result: { is_error: true } });
      expect(invoke).not.toHaveBeenCalled();
      expect((await replayConversation({ conversationId, eventStore, checkpointPolicy: false })).state.approval_proposals).toEqual([]);
      return;
    }

    await expect(bridge.execute(request, { signal: signal() })).resolves.toMatchObject({
      status: "completed",
      result: { is_error: false },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    const afterExecution = await replayConversation({ conversationId, eventStore, checkpointPolicy: false });
    expect(afterExecution.state.approval_proposals).toMatchObject([{ status: "executed", proposal_version: 4,
      decision_attribution: userAttribution }]);
    expect(afterExecution.state.tool_calls).toHaveLength(1);
    expect(JSON.stringify((await events.read({ conversationId })).entries)).not.toContain("private tool argument");

    const restarted = makeBridge();
    restarted.registerSession({
      session_id: sessionId,
      capability_ref: capabilityRef,
      discovery: { context: undefined },
      applicationContext: undefined,
      approval: {
        permissionContext: "allowed",
        conversationId,
        turnId,
        attribution: systemAttribution,
      },
    });
    await expect(restarted.execute(request, { signal: signal() })).resolves.toMatchObject({
      status: "completed",
      result: { is_error: false },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(proposals.get({
      permissionContext: "allowed",
      proposalId: confirmed,
    })).resolves.toMatchObject({ status: "executed", proposal_version: 4 });
  });
});
