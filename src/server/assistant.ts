import { createHash } from "node:crypto";

import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type { ApplicationToolResult, AuthoritativeAttribution, ChatRequest, JsonObject, JsonValue, StreamEvent } from "../protocol.js";
import type { ProviderAdapterMetadata } from "../providers/index.js";
import type { ToolLoopLimits } from "../tools/loop.js";
import type { ConversationTransport, ResumeTurnInput, StartTurnInput, TurnHandle, TurnObservation,
  TurnResumePoint } from "../transports/types.js";
import { createApplicationGateway, createConversationActivityHttpHandler,
  type ApplicationGateway, type ApplicationGatewayAction,
  type ApplicationGatewayAuthorizationContext } from "../transports/application-gateway.js";
import { createApplicationGatewayExpressMiddleware, type ExpressLikeNext,
  type ExpressLikeRequest, type ExpressLikeResponse } from "./application-gateway.js";
import { createDurableApplicationTransport, type DurableApplicationTransport } from "../transports/durable.js";
import type { ConversationCatalog } from "../conversation/catalog.js";
import { createInMemoryLiveConversationActivityDelivery, type DurableConversationActivityStore,
  type LiveConversationActivityDelivery, type LiveConversationActivityPubSub } from "../conversation/activity.js";
import { ApprovalProposalStoreError, type ApprovalProposalStore } from "../conversation/approval-proposal-store.js";
import type { PostgresAssistantPersistence, PostgresAssistantPersistenceBundle } from "../postgres/index.js";
import { createAiApplication, type AiApplication } from "./application.js";
import type { ApplicationToolExecutor, ApplicationToolPolicy, BoundedToolExecutionOutcome } from "../tools/executor.js";
import type { ToolPlugin } from "../tools/plugin.js";
import type { ResponseToolCallEvent, ToolDefinition } from "../protocol.js";
import type { AIRuntimeUsageConfiguration } from "./usage-control.js";
import { createApprovalExecutionCoordinator, type ApprovalExecutionResume } from "../tools/approval-execution.js";
import { createApprovalCoordinator } from "../conversation/approval-coordinator.js";
import { CONVERSATION_EVENT_VERSION, parseConversationEvent } from "../conversation/events.js";
import type { ConversationEventAttribution } from "../conversation/state.js";
import { ConversationEventStoreConflictError } from "../conversation/event-store.js";
import { createConversationSynchronizationHttpHandler } from "../sync/http.js";
import { createDurableApplicationConversationSync, qualifyDurableApplicationTurnStarts } from "../sync/durable-application-adapter.js";
import { createInMemoryLivePresenceDelivery, createLivePresenceHttpHandler } from "../presence/live-delivery.js";
import type { LivePresenceDelivery, LivePresencePubSub } from "../presence/live-delivery.js";
import { createAssistantActivityTransport } from "../presence/assistant-activity.js";

export { openaiResponses, type HandrailOpenAIResponsesOptions } from "./openai-responses.js";
export { createProviderToolLoopTransport, type ProviderToolLoopTransportOptions } from "./provider-tool-loop.js";

export const HANDRAIL_ASSISTANT_VERSION = "handrail.assistant.v1" as const;

export interface HandrailAssistantAuthorizationContext extends ApplicationGatewayAuthorizationContext {
  readonly tenantId: string;
  readonly scopeId: string;
  readonly attribution: AuthoritativeAttribution;
}

export interface HandrailAssistantProvider<TContext extends HandrailAssistantAuthorizationContext> {
  readonly metadata: ProviderAdapterMetadata;
  /** SDK-owned provider packages return this transport with their bounded tool loop already installed. */
  createTransport(input: {
    readonly context: TContext;
    readonly persistence: PostgresAssistantPersistenceBundle<TContext>;
    readonly instructions: readonly string[];
    readonly tools: {
      readonly definitions: readonly ToolDefinition[];
      execute(call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">,
        signal: AbortSignal): Promise<BoundedToolExecutionOutcome>;
      awaitApproval(input: { readonly conversationId: string; readonly turnId: string;
        readonly call: Pick<ResponseToolCallEvent, "tool_call_id" | "name" | "arguments">;
        readonly signal: AbortSignal }): Promise<BoundedToolExecutionOutcome>;
    };
    readonly limits: Readonly<ToolLoopLimits>;
    readonly diagnostics?: AiDiagnosticSink;
  }): ConversationTransport<StreamEvent, ChatRequest> | Promise<ConversationTransport<StreamEvent, ChatRequest>>;
}

export interface CreateHandrailAssistantOptions<TContext extends HandrailAssistantAuthorizationContext> {
  readonly id: string;
  readonly instructions?: string | readonly string[];
  readonly authorize: (request: Request, action: ApplicationGatewayAction) => TContext | Promise<TContext>;
  readonly provider: HandrailAssistantProvider<TContext>;
  readonly persistence: PostgresAssistantPersistence;
  readonly usage?: AIRuntimeUsageConfiguration;
  readonly tools?: readonly ToolPlugin<ApplicationToolExecutor<TContext>, TContext, TContext, TContext>[];
  readonly toolPolicy?: ApplicationToolPolicy<TContext>;
  readonly diagnostics?: AiDiagnosticSink;
  readonly workerId?: string;
  readonly toolLoopLimits?: Partial<ToolLoopLimits>;
  readonly createConversationId?: () => string;
  /** Enumerates server-trusted scopes at worker startup so pending turns and usage can recover after restart. */
  readonly recoveryContexts?: () => Iterable<TContext> | AsyncIterable<TContext> |
    Promise<Iterable<TContext> | AsyncIterable<TContext>>;
  readonly authorizeConversation?: Parameters<PostgresAssistantPersistence["forScope"]>[1]["authorizeConversation"];
  readonly authorizeApproval?: Parameters<PostgresAssistantPersistence["forScope"]>[1]["authorizeApproval"];
  readonly approvalTimeoutMilliseconds?: number;
  /** Optional multi-instance presence fan-out; process-local delivery remains the zero-config default. */
  readonly presence?: LivePresenceDelivery | { readonly pubSub: LivePresencePubSub; readonly channelPrefix?: string };
  readonly activityPubSub?: LiveConversationActivityPubSub;
  readonly titleGeneration?: (input: { readonly conversationId: string; readonly idempotencyKey: string },
    context: TContext, signal: AbortSignal) => Promise<string>;
}

export interface HandrailAssistant {
  readonly version: typeof HANDRAIL_ASSISTANT_VERSION;
  readonly id: string;
  readonly capabilities: { readonly provider: ProviderAdapterMetadata; readonly toolLoopLimits: Readonly<ToolLoopLimits> };
  handle(request: Request): Promise<Response>;
  express(options: { readonly origin: string }): (
    request: ExpressLikeRequest, response: ExpressLikeResponse, next: ExpressLikeNext,
  ) => Promise<void>;
  recoverPending(limit?: number): Promise<number>;
  flushUsage(limit?: number): Promise<{ readonly delivered: number; readonly pending: number }>;
}

const DEFAULT_LIMITS: Readonly<ToolLoopLimits> = Object.freeze({
  maxIterations: 8, maxTotalToolCalls: 32, maxElapsedMs: 120_000, parallelism: 1,
});

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function checkpointForEvent(event: StreamEvent): TurnResumePoint {
  const cursor = `${event.request_id}:${event.sequence}`;
  return Object.freeze({ lastAppliedEventId: cursor, lastAppliedCursor: cursor,
    lastAppliedRevision: event.sequence });
}

const SYSTEM_ATTRIBUTION: ConversationEventAttribution = Object.freeze({
  actor: Object.freeze({ type: "system" }), source: Object.freeze({ type: "runtime" }),
});

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function argumentReference(arguments_: JsonObject): string {
  return `args-sha256-${digest(canonicalJson(arguments_))}`;
}

function approvalError(call: Pick<ResponseToolCallEvent, "tool_call_id" | "name">, message: string): BoundedToolExecutionOutcome {
  const content = [{ type: "text" as const, text: message }];
  const result: ApplicationToolResult = Object.freeze({ tool_call_id: call.tool_call_id, name: call.name,
    content, is_error: true });
  return Object.freeze({ status: "completed", result });
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(true); }, milliseconds);
    const onAbort = () => { clearTimeout(timeout); resolve(false); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function recordProposalCreated(
  eventStore: PostgresAssistantPersistenceBundle<unknown>["events"], conversationId: string,
  proposal: Awaited<ReturnType<ApprovalProposalStore<unknown>["create"]>>,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const latest = await eventStore.getLatestRevision(conversationId as never);
    try {
      await eventStore.append({ conversationId: conversationId as never, expectedRevision: latest, events: [parseConversationEvent({
        version: CONVERSATION_EVENT_VERSION, event_id: `approval-created:${proposal.proposal_id}`,
        conversation_id: conversationId, revision: (latest ?? 0) + 1, occurred_at: proposal.created_at,
        actor: SYSTEM_ATTRIBUTION.actor, source: SYSTEM_ATTRIBUTION.source,
        payload: { type: "approval.proposal_created", proposal_id: proposal.proposal_id,
          ...(proposal.group_id === null ? {} : { group_id: proposal.group_id }), turn_id: proposal.turn_id,
          tool_call_id: proposal.tool_call_id, tool_name: proposal.tool_name, status: "pending", proposal_version: 1,
          expires_at: proposal.expires_at, reviewed_arguments: proposal.reviewed_arguments },
      })] });
      return;
    } catch (error) {
      if (!(error instanceof ConversationEventStoreConflictError) || error.code !== "revision_conflict") throw error;
      const retained = await eventStore.read({ conversationId: conversationId as never });
      if (retained.entries.some(({ event }) => event.payload.type === "approval.proposal_created" &&
        event.payload.proposal_id === proposal.proposal_id)) return;
    }
  }
  throw new ApprovalProposalStoreError("unavailable", "create");
}

function withDurableActivity<TEvent, TRequest>(
  delegate: ConversationTransport<TEvent, TRequest>, store: DurableConversationActivityStore,
  delivery: LiveConversationActivityDelivery, diagnostics?: AiDiagnosticSink,
): ConversationTransport<TEvent, TRequest> {
  const update = async (conversationId: string, turnStatus: "running" | "completed" | "error", unread: boolean) => {
    try {
      const record = await store.upsert({ conversationId, turnStatus, unread, updatedAt: new Date().toISOString() });
      await delivery.publish(record);
    } catch (cause) {
      emitAiDiagnostic(diagnostics, { domain: "activity", operation: "turn_lifecycle", phase: "failed",
        conversationId, code: "activity_update_failed", retryable: true, cause });
    }
  };
  const wrap = (handle: TurnHandle<TEvent>): TurnHandle<TEvent> => {
    const observation: TurnObservation<TEvent> = handle.observation;
    return { ...handle, observation: { ...observation, result: observation.result.then(async (result) => {
      if (result.status !== "disconnected") await update(handle.conversationId,
        result.status === "failed" ? "error" : "completed", true);
      return result;
    }) } };
  };
  return Object.freeze({ capabilities: delegate.capabilities,
    async startTurn(input: StartTurnInput<TRequest>) {
      const result = await delegate.startTurn(input);
      if (!result.ok) return result;
      await update(input.conversationId, "running", false);
      return { ok: true as const, value: wrap(result.value) };
    },
    async resumeTurn(input: ResumeTurnInput) {
      const result = await delegate.resumeTurn(input);
      if (!result.ok) return result;
      const observation = result.value;
      return { ok: true as const, value: { ...observation, result: observation.result.then(async (terminal) => {
        if (terminal.status !== "disconnected") await update(input.conversationId,
          terminal.status === "failed" ? "error" : "completed", true);
        return terminal;
      }) } };
    },
  });
}

/**
 * Assemble the authenticated HTTP surface and all durable ownership once.
 * Tenant and scope selection happen only after authorize() returns.
 */
export async function createHandrailAssistant<TContext extends HandrailAssistantAuthorizationContext>(
  options: CreateHandrailAssistantOptions<TContext>,
): Promise<HandrailAssistant> {
  const assistantId = identifier(options.id, "assistant id");
  const instructions = Object.freeze(typeof options.instructions === "string"
    ? [options.instructions] : [...(options.instructions ?? [])]);
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.toolLoopLimits });
  const approvalTimeoutMilliseconds = options.approvalTimeoutMilliseconds ?? 15 * 60_000;
  if (!Number.isSafeInteger(approvalTimeoutMilliseconds) || approvalTimeoutMilliseconds <= 0) {
    throw new TypeError("approvalTimeoutMilliseconds must be a positive safe integer");
  }
  const workerId = identifier(options.workerId ?? `${assistantId}-${process.pid}`, "workerId");
  const bundles = new Map<string, PostgresAssistantPersistenceBundle<TContext>>();
  const applications = new Map<string, Promise<AiApplication<TContext, TContext, unknown>>>();
  const transports = new Map<string, Promise<ConversationTransport<StreamEvent, ChatRequest>>>();
  const durableTransports = new Map<string, DurableApplicationTransport<StreamEvent, ChatRequest>>();
  const activityDeliveries = new Map<string, LiveConversationActivityDelivery>();
  const presenceDelivery = options.presence === undefined
    ? createInMemoryLivePresenceDelivery()
    : "publish" in options.presence ? options.presence
      : createInMemoryLivePresenceDelivery({ pubSub: options.presence.pubSub,
          ...(options.presence.channelPrefix === undefined ? {} : { channelPrefix: options.presence.channelPrefix }) });
  const scopeKeyFor = (context: TContext) => `${identifier(context.tenantId, "tenantId")}\0${identifier(context.scopeId, "scopeId")}`;
  // Provider transports and installed plugins may close over roles, actor data,
  // attribution, or session identity. Never reuse them for a different trusted context.
  const executionKeyFor = (context: TContext) => `${scopeKeyFor(context)}\0${digest(JSON.stringify(context))}`;
  const bundleFor = (context: TContext) => {
    const key = scopeKeyFor(context);
    let bundle = bundles.get(key);
    if (!bundle) {
      bundle = options.persistence.forScope<TContext>({ tenantId: context.tenantId, scopeId: context.scopeId }, {
        createConversationId: () => (options.createConversationId?.() ?? globalThis.crypto.randomUUID()) as never,
        ...(options.authorizeConversation === undefined ? {} : { authorizeConversation: options.authorizeConversation as never }),
        ...(options.authorizeApproval === undefined ? {} : { authorizeApproval: options.authorizeApproval as never }),
        ...(options.usage?.client == null ? {} : { usageClient: options.usage.client }),
      });
      bundles.set(key, bundle);
    }
    return bundle;
  };
  const activityDeliveryFor = (context: TContext) => {
    const key = scopeKeyFor(context);
    let delivery = activityDeliveries.get(key);
    if (!delivery) {
      delivery = createInMemoryLiveConversationActivityDelivery({
        ...(options.activityPubSub === undefined ? {} : { pubSub: options.activityPubSub }),
        channel: `handrail:activity:${digest(key).slice(0, 32)}`,
      });
      activityDeliveries.set(key, delivery);
    }
    return delivery;
  };
  const applicationFor = (context: TContext) => {
    const key = executionKeyFor(context);
    let application = applications.get(key);
    if (!application) {
      const bundle = bundleFor(context);
      application = createAiApplication({
        plugins: options.tools ?? [], installContext: context,
        policy: options.toolPolicy ?? (() => ({ outcome: "allow" })),
        toolExecutionLedger: bundle.toolLedger,
        approvalCoordinator: createApprovalExecutionCoordinator<TContext>({
          proposalStore: bundle.approvals, eventStore: bundle.events,
          authorize: () => "allow",
          verifyArguments: ({ binding, reviewedArguments, arguments: arguments_ }) => {
            if (binding.type !== "opaque_reference" || reviewedArguments.type !== "opaque_reference") return "mismatch";
            return binding.argumentReference === reviewedArguments.argument_ref &&
              binding.argumentReference === argumentReference(arguments_) ? "match" : "mismatch";
          },
        }),
        ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
      });
      applications.set(key, application);
    }
    return application;
  };
  const transportFor = (context: TContext) => {
    const key = executionKeyFor(context);
    let transport = transports.get(key);
    if (!transport) {
      transport = applicationFor(context).then((application) => {
        const bundle = bundleFor(context);
        const definitions = application.discover({ context });
        return options.provider.createTransport({
          context, persistence: bundle, limits, instructions,
          tools: Object.freeze({
            definitions,
            execute: (call, signal) => application.executeTool({ discovery: { context },
              applicationContext: context, call, signal }),
            async awaitApproval({ conversationId, turnId, call, signal }) {
              const rawArguments = call.arguments as JsonObject;
              const reference = argumentReference(rawArguments);
              const identity = digest(`${conversationId}\u001f${turnId}\u001f${call.tool_call_id}\u001f${call.name}\u001f${reference}`);
              const proposalId = `proposal-${identity.slice(0, 48)}` as never;
              const createdAt = Date.now();
              const proposal = await bundle.approvals.create({ permissionContext: context, proposalId,
                turnId: turnId as never, toolCallId: call.tool_call_id as never, toolName: call.name,
                reviewedArguments: { type: "opaque_reference", argument_ref: reference as never },
                expiresAt: new Date(createdAt + approvalTimeoutMilliseconds).toISOString() as never,
                attribution: SYSTEM_ATTRIBUTION, idempotencyKey: `approval:${identity}`,
                idempotencyFingerprint: `approval:${identity}` });
              await recordProposalCreated(bundle.events, conversationId, proposal);
              while (!signal.aborted && Date.now() - createdAt < approvalTimeoutMilliseconds) {
                const retained = await bundle.approvals.get({ permissionContext: context, proposalId });
                if (retained === null) return approvalError(call, "Tool approval is unavailable.");
                if (retained.status === "confirmed") {
                  const approval: ApprovalExecutionResume<TContext> = { permissionContext: context, proposalId,
                    expectedProposalVersion: retained.proposal_version, executionId: `execute-${identity.slice(0, 48)}`,
                    argumentBinding: { type: "opaque_reference", argumentReference: reference as never },
                    attribution: SYSTEM_ATTRIBUTION };
                  return application.executeTool({ discovery: { context }, applicationContext: context, call, signal,
                    approval: { ...approval, conversationId: conversationId as never, turnId: turnId as never } });
                }
                if (retained.status === "rejected") return approvalError(call, "Tool execution was rejected.");
                if (retained.status === "expired") return approvalError(call, "Tool approval expired.");
                if (retained.status === "executed" || retained.status === "executing") {
                  return application.executeTool({ discovery: { context }, applicationContext: context, call, signal,
                    approval: { permissionContext: context, proposalId,
                      expectedProposalVersion: 2, executionId: `execute-${identity.slice(0, 48)}`,
                      argumentBinding: { type: "opaque_reference", argumentReference: reference as never },
                      attribution: SYSTEM_ATTRIBUTION, conversationId: conversationId as never, turnId: turnId as never } });
                }
                if (retained.status === "failed") return approvalError(call, "Approved tool execution failed.");
                if (!await wait(250, signal)) break;
              }
              return approvalError(call, signal.aborted ? "Tool execution was cancelled." : "Tool approval expired.");
            },
          }),
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
        });
      }).then((delegate) => {
        const durable = createDurableApplicationTransport<StreamEvent, ChatRequest, ChatRequest>({
          delegate: qualifyDurableApplicationTurnStarts(delegate, bundleFor(context).events),
          store: bundleFor(context).durableTurns as never,
          requestCodec: {
            encode: (request: ChatRequest) => request,
            decode: (request: ChatRequest) => request,
            fingerprint: (request: ChatRequest) => createHash("sha256").update(JSON.stringify(request)).digest("hex"),
          },
          checkpointForEvent,
          workerId,
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
        });
        durableTransports.set(key, durable);
        const activity = withDurableActivity(durable, bundleFor(context).activity, activityDeliveryFor(context),
          options.diagnostics);
        return createAssistantActivityTransport({ delegate: activity, delivery: presenceDelivery,
          participantId: assistantId, sessionId: (_conversationId, turnId) => `${assistantId}:${turnId}`,
          activityForEvent: (event) => event.type === "response.tool_call" ? "using_tool"
            : event.type === "response.text.delta" ? "responding" : null,
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }) });
      });
      transports.set(key, transport);
    }
    return transport;
  };
  const catalog = Object.freeze({
    capabilities: Object.freeze({
      rename: { supported: true as const }, clear: { supported: true as const },
      archive: { supported: true as const }, restore: { supported: true as const },
      permanentDelete: { supported: true as const },
    }),
    list: (input: Parameters<ConversationCatalog<TContext>["list"]>[0]) => bundleFor(input.authorizationContext).catalog.list(input),
    create: (input: Parameters<ConversationCatalog<TContext>["create"]>[0]) => bundleFor(input.authorizationContext).catalog.create(input),
    get: (input: Parameters<ConversationCatalog<TContext>["get"]>[0]) => bundleFor(input.authorizationContext).catalog.get(input),
    rename: (input: Parameters<ConversationCatalog<TContext>["rename"]>[0]) => bundleFor(input.authorizationContext).catalog.rename(input),
    clear: (input: Parameters<ConversationCatalog<TContext>["clear"]>[0]) => bundleFor(input.authorizationContext).catalog.clear(input),
    archive: (input: Parameters<ConversationCatalog<TContext>["archive"]>[0]) => bundleFor(input.authorizationContext).catalog.archive(input),
    restore: (input: Parameters<ConversationCatalog<TContext>["restore"]>[0]) => bundleFor(input.authorizationContext).catalog.restore(input),
    permanentlyDelete: (input: Parameters<ConversationCatalog<TContext>["permanentlyDelete"]>[0]) =>
      bundleFor(input.authorizationContext).catalog.permanentlyDelete(input),
  });
  const approvals: ApprovalProposalStore<TContext> = Object.freeze({
    create: (input: Parameters<ApprovalProposalStore<TContext>["create"]>[0]) => {
      void input;
      return Promise.reject(new ApprovalProposalStoreError("permission_denied", "create"));
    },
    get: (input: Parameters<ApprovalProposalStore<TContext>["get"]>[0]) =>
      bundleFor(input.permissionContext).approvals.get(input),
    listGroup: (input: Parameters<ApprovalProposalStore<TContext>["listGroup"]>[0]) =>
      bundleFor(input.permissionContext).approvals.listGroup(input),
    async transition(input: Parameters<ApprovalProposalStore<TContext>["transition"]>[0]) {
      const supplied = input as typeof input & { readonly conversationId?: unknown };
      if (typeof supplied.conversationId !== "string" ||
        (input.status !== "confirmed" && input.status !== "rejected" && input.status !== "expired")) {
        throw new ApprovalProposalStoreError("invalid_input", "transition");
      }
      const bundle = bundleFor(input.permissionContext);
      await bundle.catalog.get({ authorizationContext: input.permissionContext,
        conversationId: supplied.conversationId as never });
      const history = await bundle.events.read({ conversationId: supplied.conversationId as never });
      if (!history.entries.some(({ event }) => event.payload.type === "approval.proposal_created" &&
        event.payload.proposal_id === input.proposalId)) {
        throw new ApprovalProposalStoreError("not_found", "transition");
      }
      const coordinator = createApprovalCoordinator<TContext>({ proposalStore: bundle.approvals,
        eventStore: bundle.events, authorize: () => "allow" });
      const result = await coordinator.decide({ permissionContext: input.permissionContext,
        conversationId: supplied.conversationId as never, proposalId: input.proposalId,
        expectedVersion: input.expectedVersion,
        decision: input.status === "confirmed" ? "confirm" : input.status === "rejected" ? "reject" : "expire",
        attribution: { actor: { type: "user", id: input.permissionContext.principalId as never },
          source: { type: "runtime" } }, idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: input.idempotencyFingerprint,
        ...(input.decisionReason === undefined ? {} : { decisionReason: input.decisionReason }),
        signal: new AbortController().signal });
      if (result.outcome === "accepted" || result.outcome === "already_decided") {
        const retained = await bundle.approvals.get({ permissionContext: input.permissionContext,
          proposalId: input.proposalId });
        if (retained !== null) return retained;
      }
      const code = result.outcome === "forbidden" ? "permission_denied"
        : result.outcome === "not_found" ? "not_found"
        : result.outcome === "persistence_failure" || result.outcome === "cancelled" ? "unavailable"
        : result.outcome === "conflict" && result.conflict === "version" ? "version_conflict"
        : result.outcome === "conflict" && result.conflict === "idempotency" ? "idempotency_conflict"
        : "invalid_input";
      throw new ApprovalProposalStoreError(code, "transition");
    },
  });
  const activity = (request: Request, context: TContext) =>
    createConversationActivityHttpHandler(bundleFor(context).activity,
      { delivery: activityDeliveryFor(context) })(request);
  const ownsConversation = async (context: TContext, conversationId: string) => {
    await bundleFor(context).catalog.get({ authorizationContext: context, conversationId: conversationId as never });
    return true;
  };
  const attachments = async (request: Request, context: TContext) => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
    try {
      const form = await request.formData();
      const file = form.get("file"), conversationId = form.get("conversationId"), idempotencyKey = form.get("idempotencyKey");
      if (!(file instanceof Blob) || typeof conversationId !== "string" || typeof idempotencyKey !== "string") {
        return new Response(null, { status: 400 });
      }
      await ownsConversation(context, conversationId);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const fingerprint = createHash("sha256").update(bytes).digest("hex");
      const reference = await bundleFor(context).attachments.stage({ ownerScopeId: context.scopeId, conversationId,
        idempotencyKey, fingerprint, mediaType: file.type,
        ...(typeof (file as File).name === "string" ? { filename: (file as File).name } : {}), bytes });
      return new Response(JSON.stringify({ ok: true, value: reference }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    } catch {
      return new Response(JSON.stringify({ ok: false, error: { code: "forbidden", message: "Attachment upload denied." } }),
        { status: 403, headers: { "content-type": "application/json; charset=utf-8" } });
    }
  };
  const synchronization = createConversationSynchronizationHttpHandler<TContext>({
    adapterFor: (context) => createDurableApplicationConversationSync({
      authorizationContext: context,
      principalId: context.principalId,
      eventStore: bundleFor(context).events,
      turnStore: bundleFor(context).durableTurns as never,
      authorizeConversation: (conversationId) => ownsConversation(context, conversationId),
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  const presence = (request: Request, context: TContext) => createLivePresenceHttpHandler({
    delivery: presenceDelivery,
    authorize: async (_request, conversationId) => { await ownsConversation(context, conversationId); return context; },
  })(request);
  const generateTitle = async (input: { readonly conversationId: string; readonly idempotencyKey: string },
    context: TContext, signal: AbortSignal): Promise<string> => {
    if (options.titleGeneration !== undefined) return options.titleGeneration(input, context, signal);
    await ownsConversation(context, input.conversationId);
    const history = await bundleFor(context).events.read({ conversationId: input.conversationId as never });
    const first = history.entries.map(({ event }) => event.payload).find((payload) =>
      payload.type === "message.created" && payload.role === "user");
    if (first?.type !== "message.created") return "New conversation";
    const text = first.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ")
      .replace(/\s+/gu, " ").trim();
    return text.length === 0 ? "New conversation" : text.slice(0, 80);
  };
  const gateway: ApplicationGateway = createApplicationGateway({
    authorize: async (request, action) => options.authorize(request, action),
    transportFor,
    checkpointForEvent,
    conversations: catalog as unknown as ConversationCatalog<TContext>,
    approvals,
    titleGeneration: { generate: generateTitle },
    handlers: { activity, attachments, synchronization, presence },
    capabilities: { activity: true, presence: true, synchronization: true,
      attachments: { maximumFiles: 16, maximumBytesPerFile: options.persistence.attachmentLimits.maximumBytes,
        acceptedMediaTypes: options.persistence.attachmentLimits.acceptedMediaTypes, uploadUrl: "attachments" },
      documentInput: options.provider.metadata.capabilities.document_input.supported
      ? options.provider.metadata.capabilities.document_input.capability : false,
      assistant: { id: assistantId, version: HANDRAIL_ASSISTANT_VERSION,
        provider: options.provider.metadata, toolLoopLimits: limits } },
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  const primeRecoveryContexts = async () => {
    const source = await options.recoveryContexts?.();
    if (source === undefined) return;
    for await (const context of source) await transportFor(context);
  };
  return Object.freeze({
    version: HANDRAIL_ASSISTANT_VERSION,
    id: assistantId,
    capabilities: Object.freeze({ provider: options.provider.metadata, toolLoopLimits: limits }),
    handle: (request: Request) => gateway.handle(request),
    express: (expressOptions: { readonly origin: string }) =>
      createApplicationGatewayExpressMiddleware(gateway, expressOptions),
    async recoverPending(limit = 100) {
      await primeRecoveryContexts();
      let recovered = 0;
      for (const transport of durableTransports.values()) recovered += (await transport.recoverPending(limit)).length;
      return recovered;
    },
    async flushUsage(limit?: number) {
      await primeRecoveryContexts();
      let delivered = 0, pending = 0;
      for (const bundle of bundles.values()) {
        if (!bundle.usageReceiptSink) continue;
        const result = await bundle.usageReceiptSink.flush(limit);
        delivered += result.delivered; pending += result.pending;
      }
      return Object.freeze({ delivered, pending });
    },
  });
}
