import { createHash } from "node:crypto";

import type { AiDiagnosticSink } from "../diagnostics.js";
import type { AuthoritativeAttribution, ChatRequest, StreamEvent } from "../protocol.js";
import type { ProviderAdapterMetadata } from "../providers/index.js";
import type { ToolLoopLimits } from "../tools/loop.js";
import type { ConversationTransport, TurnResumePoint } from "../transports/types.js";
import { createApplicationGateway, createConversationActivityHttpHandler,
  type ApplicationGateway, type ApplicationGatewayAction,
  type ApplicationGatewayAuthorizationContext } from "../transports/application-gateway.js";
import { createApplicationGatewayExpressMiddleware, type ExpressLikeNext,
  type ExpressLikeRequest, type ExpressLikeResponse } from "./application-gateway.js";
import { createDurableApplicationTransport, type DurableApplicationTransport } from "../transports/durable.js";
import type { ConversationCatalog } from "../conversation/catalog.js";
import type { ApprovalProposalStore } from "../conversation/approval-proposal-store.js";
import type { PostgresAssistantPersistence, PostgresAssistantPersistenceBundle } from "../postgres/index.js";
import { createAiApplication, type AiApplication } from "./application.js";
import type { ApplicationToolExecutor, ApplicationToolPolicy, BoundedToolExecutionOutcome } from "../tools/executor.js";
import type { ToolPlugin } from "../tools/plugin.js";
import type { ResponseToolCallEvent, ToolDefinition } from "../protocol.js";

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
  readonly tools?: readonly ToolPlugin<ApplicationToolExecutor<TContext>, TContext, TContext, TContext>[];
  readonly toolPolicy?: ApplicationToolPolicy<TContext>;
  readonly diagnostics?: AiDiagnosticSink;
  readonly workerId?: string;
  readonly toolLoopLimits?: Partial<ToolLoopLimits>;
  readonly createConversationId?: () => string;
  readonly authorizeConversation?: Parameters<PostgresAssistantPersistence["forScope"]>[1]["authorizeConversation"];
  readonly authorizeApproval?: Parameters<PostgresAssistantPersistence["forScope"]>[1]["authorizeApproval"];
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
  const workerId = identifier(options.workerId ?? `${assistantId}-${process.pid}`, "workerId");
  const bundles = new Map<string, PostgresAssistantPersistenceBundle<TContext>>();
  const applications = new Map<string, Promise<AiApplication<TContext, TContext, unknown>>>();
  const transports = new Map<string, Promise<DurableApplicationTransport<StreamEvent, ChatRequest>>>();
  const keyFor = (context: TContext) => `${identifier(context.tenantId, "tenantId")}\0${identifier(context.scopeId, "scopeId")}`;
  const bundleFor = (context: TContext) => {
    const key = keyFor(context);
    let bundle = bundles.get(key);
    if (!bundle) {
      bundle = options.persistence.forScope<TContext>({ tenantId: context.tenantId, scopeId: context.scopeId }, {
        createConversationId: () => (options.createConversationId?.() ?? globalThis.crypto.randomUUID()) as never,
        ...(options.authorizeConversation === undefined ? {} : { authorizeConversation: options.authorizeConversation as never }),
        ...(options.authorizeApproval === undefined ? {} : { authorizeApproval: options.authorizeApproval as never }),
      });
      bundles.set(key, bundle);
    }
    return bundle;
  };
  const applicationFor = (context: TContext) => {
    const key = keyFor(context);
    let application = applications.get(key);
    if (!application) {
      application = createAiApplication({
        plugins: options.tools ?? [], installContext: context,
        policy: options.toolPolicy ?? (() => ({ outcome: "allow" })),
        toolExecutionLedger: bundleFor(context).toolLedger,
        ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
      });
      applications.set(key, application);
    }
    return application;
  };
  const transportFor = (context: TContext) => {
    const key = keyFor(context);
    let transport = transports.get(key);
    if (!transport) {
      transport = applicationFor(context).then((application) => options.provider.createTransport({
        context, persistence: bundleFor(context), limits, instructions,
        tools: Object.freeze({
          definitions: application.discover({ context }),
          execute: (call, signal) => application.executeTool({ discovery: { context }, applicationContext: context,
            call, signal }),
        }),
        ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
      })).then((delegate) =>
        createDurableApplicationTransport<StreamEvent, ChatRequest, ChatRequest>({
          delegate, store: bundleFor(context).durableTurns as never,
          requestCodec: {
            encode: (request: ChatRequest) => request,
            decode: (request: ChatRequest) => request,
            fingerprint: (request: ChatRequest) => createHash("sha256").update(JSON.stringify(request)).digest("hex"),
          },
          checkpointForEvent,
          workerId,
          ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
        }));
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
    create: (input: Parameters<ApprovalProposalStore<TContext>["create"]>[0]) =>
      bundleFor(input.permissionContext).approvals.create(input),
    get: (input: Parameters<ApprovalProposalStore<TContext>["get"]>[0]) =>
      bundleFor(input.permissionContext).approvals.get(input),
    listGroup: (input: Parameters<ApprovalProposalStore<TContext>["listGroup"]>[0]) =>
      bundleFor(input.permissionContext).approvals.listGroup(input),
    transition: (input: Parameters<ApprovalProposalStore<TContext>["transition"]>[0]) =>
      bundleFor(input.permissionContext).approvals.transition(input),
  });
  const activity = (request: Request, context: TContext) =>
    createConversationActivityHttpHandler(bundleFor(context).activity)(request);
  const gateway: ApplicationGateway = createApplicationGateway({
    authorize: async (request, action) => options.authorize(request, action),
    transportFor,
    checkpointForEvent,
    conversations: catalog as unknown as ConversationCatalog<TContext>,
    approvals,
    ...(options.titleGeneration === undefined ? {} : { titleGeneration: { generate: options.titleGeneration } }),
    handlers: { activity },
    capabilities: { activity: true, documentInput: options.provider.metadata.capabilities.document_input.supported
      ? options.provider.metadata.capabilities.document_input.capability : false },
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  return Object.freeze({
    version: HANDRAIL_ASSISTANT_VERSION,
    id: assistantId,
    capabilities: Object.freeze({ provider: options.provider.metadata, toolLoopLimits: limits }),
    handle: (request: Request) => gateway.handle(request),
    express: (expressOptions: { readonly origin: string }) =>
      createApplicationGatewayExpressMiddleware(gateway, expressOptions),
    async recoverPending(limit = 100) {
      let recovered = 0;
      for (const transport of transports.values()) recovered += (await (await transport).recoverPending(limit)).length;
      return recovered;
    },
    async flushUsage(limit?: number) {
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
