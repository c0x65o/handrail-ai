import { parseServerSentEvents } from "./sse.js";
import type { AttachmentReference } from "../protocol.js";
import type { AttachmentUploadAdapter } from "../attachments/types.js";
import type { LivePresenceEnvelope } from "../presence/live-delivery.js";
import type { PresenceRecord } from "../presence/types.js";
import type {
  ArchiveConversationInput, ClearConversationInput, ConversationCatalog, CreateConversationInput,
  GetConversationInput, ListConversationsInput, PermanentlyDeleteConversationInput,
  RenameConversationInput, RestoreConversationInput, ArchiveConversationResult,
  ClearConversationResult, CreateConversationResult, GetConversationResult,
  ListConversationsResult, PermanentlyDeleteConversationResult,
  RenameConversationResult, RestoreConversationResult,
} from "../conversation/catalog.js";
import type {
  ApprovalProposalStore, CreateApprovalProposalInput, GetApprovalProposalInput,
  ListApprovalProposalGroupInput, TransitionApprovalProposalInput,
} from "../conversation/approval-proposal-store.js";
import type { ConversationApprovalProposalRecord } from "../conversation/state.js";
import type {
  AuthoritativeCancelTurnResult,
  CancelTurnInput,
  ConversationTransport,
  ConversationTransportCapabilities,
  ResumeTurnInput,
  StartTurnInput,
  TransportError,
  TransportResult,
  TurnHandle,
  TurnObservation,
  TurnObservationResult,
  TurnResumePoint,
} from "./types.js";

export const APPLICATION_GATEWAY_PROTOCOL_VERSION = "handrail.application-gateway.v1" as const;

export interface ApplicationGatewayCapabilities {
  readonly protocolVersion: typeof APPLICATION_GATEWAY_PROTOCOL_VERSION;
  readonly authoritativeCancellation: boolean;
  readonly attachments: false | {
    readonly maximumFiles: number;
    readonly maximumBytesPerFile: number;
    readonly acceptedMediaTypes: readonly string[];
    readonly uploadUrl?: string;
  };
  readonly presence: boolean;
  readonly synchronization: boolean;
  readonly resources?: {
    readonly conversations: boolean;
    readonly approvals: boolean;
    readonly titleGeneration: boolean;
  };
}

export interface ApplicationGatewayEventEnvelope<TEvent> {
  readonly event: TEvent;
  readonly checkpoint: TurnResumePoint;
}

export interface ApplicationGatewayAuthorizationContext {
  readonly principalId: string;
}

export interface ApplicationGatewayRequestAuthorizer<TContext extends ApplicationGatewayAuthorizationContext> {
  authorize(request: Request, action: ApplicationGatewayAction): Promise<TContext>;
}

export type ApplicationGatewayAction = "capabilities" | "start" | "resume" | "cancel" |
  "conversations" | "approvals" | "attachments" | "presence" | "synchronization" | "title_generation";

export interface ApplicationGatewayTitleGeneration<TContext> {
  generate(input: { readonly conversationId: string; readonly idempotencyKey: string }, context: TContext, signal: AbortSignal): Promise<string>;
}

export interface ApplicationGatewayResourceHandlers<TContext> {
  readonly attachments?: (request: Request, context: TContext) => Response | Promise<Response>;
  readonly presence?: (request: Request, context: TContext) => Response | Promise<Response>;
  readonly synchronization?: (request: Request, context: TContext) => Response | Promise<Response>;
}

export interface ApplicationGatewayOptions<TEvent, TRequest, TContext extends ApplicationGatewayAuthorizationContext> {
  readonly transport: ConversationTransport<TEvent, TRequest>;
  readonly authorize: ApplicationGatewayRequestAuthorizer<TContext>["authorize"];
  /** Converts a durable event into the exact resume point acknowledged by clients. */
  readonly checkpointForEvent: (event: TEvent) => TurnResumePoint;
  readonly capabilities?: Partial<Omit<ApplicationGatewayCapabilities, "protocolVersion" | "authoritativeCancellation">>;
  readonly maximumRequestBytes?: number;
  readonly conversations?: ConversationCatalog<TContext>;
  readonly approvals?: ApprovalProposalStore<TContext>;
  readonly titleGeneration?: ApplicationGatewayTitleGeneration<TContext>;
  readonly handlers?: ApplicationGatewayResourceHandlers<TContext>;
}

export interface ApplicationGateway {
  /** Mount at any application-owned path. No framework or Node request type is required. */
  handle(request: Request): Promise<Response>;
}

type GatewayStreamMessage<TEvent> =
  | { readonly type: "started"; readonly conversationId: string; readonly turnId: string; readonly mutationId: string }
  | ({ readonly type: "event" } & ApplicationGatewayEventEnvelope<TEvent>)
  | { readonly type: "terminal"; readonly result: TurnObservationResult };

const encoder = new TextEncoder();
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const EMPTY_CHECKPOINT: TurnResumePoint = {
  lastAppliedEventId: null,
  lastAppliedCursor: null,
  lastAppliedRevision: null,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

function transportStatus(error: TransportError): number {
  return ({ invalid_request: 400, unauthenticated: 401, forbidden: 403, not_found: 404,
    conflict: 409, rate_limited: 429, timeout: 504, unavailable: 503, internal_error: 500 })[error.code];
}

function failure(error: TransportError): Response {
  return json({ ok: false, error }, transportStatus(error));
}

function publicFailure(error: unknown): Response {
  if (error instanceof Response) return error;
  return json({ ok: false, error: { code: "forbidden", message: "The request is not authorized.", retryable: false } }, 403);
}

async function body<T>(request: Request, maximumBytes: number): Promise<T> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Response(null, { status: 413 });
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T; }
  catch { throw new Response(null, { status: 400 }); }
}

function sse<TEvent>(
  observation: TurnObservation<TEvent>,
  checkpointForEvent: (event: TEvent) => TurnResumePoint,
  started?: Extract<GatewayStreamMessage<TEvent>, { type: "started" }>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (message: GatewayStreamMessage<TEvent>, id?: string | null) => {
        const prefix = id ? `id: ${id}\n` : "";
        controller.enqueue(encoder.encode(`${prefix}event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`));
      };
      try {
        if (started) send(started);
        for await (const event of observation.events) {
          const checkpoint = checkpointForEvent(event);
          send({ type: "event", event, checkpoint }, checkpoint.lastAppliedCursor ?? checkpoint.lastAppliedEventId);
        }
        send({ type: "terminal", result: await observation.result });
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() { observation.disconnect(); },
  });
  return new Response(stream, { headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...(started ? {
      "x-handrail-conversation-id": started.conversationId,
      "x-handrail-turn-id": started.turnId,
      "x-handrail-mutation-id": started.mutationId,
    } : {}),
  }});
}

export function createApplicationGateway<TEvent, TRequest, TContext extends ApplicationGatewayAuthorizationContext>(
  options: ApplicationGatewayOptions<TEvent, TRequest, TContext>,
): ApplicationGateway {
  const maximumBytes = options.maximumRequestBytes ?? 1_048_576;
  const cancel = options.transport.capabilities.authoritativeCancellation;
  const capabilities: ApplicationGatewayCapabilities = Object.freeze({
    protocolVersion: APPLICATION_GATEWAY_PROTOCOL_VERSION,
    authoritativeCancellation: cancel.supported,
    attachments: options.capabilities?.attachments ?? false,
    presence: options.capabilities?.presence ?? false,
    synchronization: options.capabilities?.synchronization ?? false,
    resources: Object.freeze({ conversations: options.conversations !== undefined,
      approvals: options.approvals !== undefined, titleGeneration: options.titleGeneration !== undefined }),
  });
  return Object.freeze({
    async handle(request: Request): Promise<Response> {
      try {
        const pathname = new URL(request.url).pathname.replace(/\/+$/, "");
        const action: ApplicationGatewayAction | null = pathname.endsWith("/capabilities") ? "capabilities"
          : pathname.endsWith("/turns/start") ? "start"
          : pathname.endsWith("/turns/resume") ? "resume"
          : pathname.endsWith("/turns/cancel") ? "cancel"
          : pathname.includes("/conversations/") ? "conversations"
          : pathname.includes("/approvals/") ? "approvals"
          : pathname.endsWith("/attachments") ? "attachments"
          : pathname.endsWith("/presence") ? "presence"
          : pathname.endsWith("/synchronization") ? "synchronization"
          : pathname.endsWith("/titles/generate") ? "title_generation" : null;
        if (action === null) return new Response(null, { status: 404 });
        if ((action === "capabilities" && request.method !== "GET") ||
          (action !== "capabilities" && action !== "presence" && action !== "attachments" && request.method !== "POST")) {
          return new Response(null, { status: 405, headers: { allow: action === "capabilities" ? "GET" : "POST" } });
        }
        const authorizationContext = await options.authorize(request, action);
        if (action === "capabilities") return json({ ok: true, value: capabilities });
        if (action === "attachments" || action === "presence" || action === "synchronization") {
          const handler = options.handlers?.[action];
          return handler ? handler(request, authorizationContext) : new Response(null, { status: 501 });
        }
        if (action === "conversations") {
          if (!options.conversations) return new Response(null, { status: 501 });
          const input = await body<Record<string, unknown>>(request, maximumBytes);
          const operation = pathname.slice(pathname.lastIndexOf("/") + 1);
          const value = operation === "list" ? await options.conversations.list({ ...input, authorizationContext } as unknown as ListConversationsInput<TContext>)
            : operation === "create" ? await options.conversations.create({ ...input, authorizationContext } as unknown as CreateConversationInput<TContext>)
            : operation === "get" ? await options.conversations.get({ ...input, authorizationContext } as unknown as GetConversationInput<TContext>)
            : operation === "rename" ? await options.conversations.rename({ ...input, authorizationContext } as unknown as RenameConversationInput<TContext>)
            : operation === "clear" ? await options.conversations.clear({ ...input, authorizationContext } as unknown as ClearConversationInput<TContext>)
            : operation === "archive" ? await options.conversations.archive({ ...input, authorizationContext } as unknown as ArchiveConversationInput<TContext>)
            : operation === "restore" ? await options.conversations.restore({ ...input, authorizationContext } as unknown as RestoreConversationInput<TContext>)
            : operation === "permanent-delete" ? await options.conversations.permanentlyDelete({ ...input, authorizationContext } as unknown as PermanentlyDeleteConversationInput<TContext>)
            : null;
          return value === null ? new Response(null, { status: 404 }) : json({ ok: true, value });
        }
        if (action === "approvals") {
          if (!options.approvals) return new Response(null, { status: 501 });
          const input = await body<Record<string, unknown>>(request, maximumBytes);
          const operation = pathname.slice(pathname.lastIndexOf("/") + 1);
          const value = operation === "create" ? await options.approvals.create({ ...input, permissionContext: authorizationContext } as unknown as CreateApprovalProposalInput<TContext>)
            : operation === "get" ? await options.approvals.get({ ...input, permissionContext: authorizationContext } as unknown as GetApprovalProposalInput<TContext>)
            : operation === "list-group" ? await options.approvals.listGroup({ ...input, permissionContext: authorizationContext } as unknown as ListApprovalProposalGroupInput<TContext>)
            : operation === "transition" ? await options.approvals.transition({ ...input, permissionContext: authorizationContext } as unknown as TransitionApprovalProposalInput<TContext>)
            : null;
          return value === null && operation !== "get" ? new Response(null, { status: 404 }) : json({ ok: true, value });
        }
        if (action === "title_generation") {
          if (!options.titleGeneration) return new Response(null, { status: 501 });
          const input = await body<{ conversationId: string; idempotencyKey: string }>(request, maximumBytes);
          return json({ ok: true, value: await options.titleGeneration.generate(input, authorizationContext, request.signal) });
        }
        if (action === "start") {
          const input = await body<StartTurnInput<TRequest>>(request, maximumBytes);
          const result = await options.transport.startTurn(input);
          if (!result.ok) return failure(result.error);
          return sse(result.value.observation, options.checkpointForEvent, {
            type: "started", conversationId: result.value.conversationId,
            turnId: result.value.turnId, mutationId: result.value.mutationId,
          });
        }
        if (action === "resume") {
          const result = await options.transport.resumeTurn(await body<ResumeTurnInput>(request, maximumBytes));
          return result.ok ? sse(result.value, options.checkpointForEvent) : failure(result.error);
        }
        if (!cancel.supported) return new Response(null, { status: 501 });
        const result = await cancel.capability.cancelTurn(await body<CancelTurnInput>(request, maximumBytes));
        return result.ok ? json(result) : failure(result.error);
      } catch (error) { return publicFailure(error); }
    },
  });
}

export interface ApplicationGatewayTransportOptions<TEvent, TSynchronization = unknown> {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Supplies application-owned cookies, bearer tokens, CSRF headers, and correlation metadata. */
  readonly protectedRequest?: (input: RequestInit & { readonly url: string }) => Promise<RequestInit> | RequestInit;
  readonly decodeEvent?: (value: unknown) => TEvent;
  readonly capabilities?: ApplicationGatewayCapabilities;
  /** Application-specific durable sync adapter, enabled only when the server also negotiates it. */
  readonly synchronization?: TSynchronization;
}

export type ApplicationGatewayAttachmentSource = Blob;

export interface ApplicationGatewayPresenceClient {
  publish(conversationId: string, kind: "upsert" | "leave", record: PresenceRecord): Promise<void>;
  subscribe(conversationId: string, signal?: AbortSignal): AsyncIterable<LivePresenceEnvelope>;
}

function createGatewayPresenceClient<TEvent>(options: ApplicationGatewayTransportOptions<TEvent>): ApplicationGatewayPresenceClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const urlFor = (conversationId: string) => `${options.baseUrl.replace(/\/+$/, "")}/presence?conversationId=${encodeURIComponent(conversationId)}`;
  return Object.freeze({
    async publish(conversationId: string, kind: "upsert" | "leave", record: PresenceRecord) {
      const url = urlFor(conversationId);
      const initial: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, record }) };
      const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
      if (!response.ok) throw new TypeError("Presence publish failed");
    },
    subscribe(conversationId: string, signal?: AbortSignal) {
      const url = urlFor(conversationId);
      return (async function* () {
        const initial: RequestInit = { method: "GET", ...(signal ? { signal } : {}) };
        const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
        if (!response.ok || !response.body) throw new TypeError("Presence subscription failed");
        for await (const frame of parseServerSentEvents(response.body)) {
          if (frame.data) yield JSON.parse(frame.data) as LivePresenceEnvelope;
        }
      })();
    },
  });
}

function createGatewayAttachmentUploadAdapter<TEvent>(
  options: ApplicationGatewayTransportOptions<TEvent>,
  capability: Exclude<ApplicationGatewayCapabilities["attachments"], false>,
): AttachmentUploadAdapter<ApplicationGatewayAttachmentSource> | null {
  const uploadUrl = capability.uploadUrl;
  if (!uploadUrl || typeof FormData === "undefined") return null;
  const fetcher = options.fetch ?? globalThis.fetch;
  return {
    async upload(request) {
      if (request.metadata.byteSize > capability.maximumBytesPerFile ||
        !capability.acceptedMediaTypes.some((accepted) => accepted.endsWith("/*")
          ? request.metadata.mediaType.startsWith(accepted.slice(0, -1)) : accepted === request.metadata.mediaType)) {
        throw new TypeError("Attachment does not satisfy negotiated gateway limits");
      }
      const url = new URL(uploadUrl, options.baseUrl).toString();
      const form = new FormData();
      form.set("file", request.source, request.metadata.filename ?? "attachment");
      form.set("idempotencyKey", request.idempotencyKey);
      form.set("kind", request.metadata.kind ?? "image");
      const initial: RequestInit = { method: "POST", body: form, signal: request.signal };
      const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
      if (!response.ok) throw new TypeError("Attachment upload failed");
      request.onProgress({ uploadedBytes: request.metadata.byteSize, totalBytes: request.metadata.byteSize });
      const result = await response.json() as { readonly ok?: boolean; readonly value?: unknown };
      if (!result.ok) throw new TypeError("Attachment upload failed");
      const value = result.value as Partial<AttachmentReference> | undefined;
      if (!value || typeof value.attachment_id !== "string" || typeof value.content_ref !== "string" ||
        value.media_type !== request.metadata.mediaType || value.byte_size !== request.metadata.byteSize) {
        throw new TypeError("Attachment gateway returned an invalid reference");
      }
      return Object.freeze({ attachment_id: value.attachment_id, content_ref: value.content_ref,
        media_type: value.media_type, byte_size: value.byte_size,
        ...(typeof value.filename === "string" ? { filename: value.filename } : {}) });
    },
  };
}

export async function negotiateApplicationGatewayCapabilities(
  options: Pick<ApplicationGatewayTransportOptions<unknown>, "baseUrl" | "fetch" | "protectedRequest">,
): Promise<ApplicationGatewayCapabilities> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/capabilities`;
  const initial: RequestInit = { method: "GET" };
  const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
  if (!response.ok) throw new TypeError("Application gateway capability negotiation failed");
  const result = await response.json() as { readonly ok?: boolean; readonly value?: ApplicationGatewayCapabilities };
  if (!result.ok || result.value?.protocolVersion !== APPLICATION_GATEWAY_PROTOCOL_VERSION) {
    throw new TypeError("Application gateway returned an incompatible protocol version");
  }
  return Object.freeze(result.value);
}

type WithoutAuthorization<T> = Omit<T, "authorizationContext" | "permissionContext">;

export interface ApplicationGatewayResourceClient {
  listConversations(input: WithoutAuthorization<ListConversationsInput<unknown>>): Promise<ListConversationsResult>;
  createConversation(input: WithoutAuthorization<CreateConversationInput<unknown>>): Promise<CreateConversationResult>;
  getConversation(input: WithoutAuthorization<GetConversationInput<unknown>>): Promise<GetConversationResult>;
  renameConversation(input: WithoutAuthorization<RenameConversationInput<unknown>>): Promise<RenameConversationResult>;
  clearConversation(input: WithoutAuthorization<ClearConversationInput<unknown>>): Promise<ClearConversationResult>;
  archiveConversation(input: WithoutAuthorization<ArchiveConversationInput<unknown>>): Promise<ArchiveConversationResult>;
  restoreConversation(input: WithoutAuthorization<RestoreConversationInput<unknown>>): Promise<RestoreConversationResult>;
  permanentlyDeleteConversation(input: WithoutAuthorization<PermanentlyDeleteConversationInput<unknown>>): Promise<PermanentlyDeleteConversationResult>;
  createApproval(input: WithoutAuthorization<CreateApprovalProposalInput<unknown>>): Promise<ConversationApprovalProposalRecord>;
  getApproval(input: WithoutAuthorization<GetApprovalProposalInput<unknown>>): Promise<ConversationApprovalProposalRecord | null>;
  listApprovalGroup(input: WithoutAuthorization<ListApprovalProposalGroupInput<unknown>>): Promise<readonly ConversationApprovalProposalRecord[]>;
  transitionApproval(input: WithoutAuthorization<TransitionApprovalProposalInput<unknown>>): Promise<ConversationApprovalProposalRecord>;
  generateTitle(input: { readonly conversationId: string; readonly idempotencyKey: string }): Promise<string>;
}

/** Typed, cross-platform resource client paired with the application gateway. */
export function createApplicationGatewayResourceClient(
  options: Pick<ApplicationGatewayTransportOptions<unknown>, "baseUrl" | "fetch" | "protectedRequest">,
): ApplicationGatewayResourceClient {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const invoke = async <T>(path: string, input: unknown): Promise<T> => {
    const url = `${base}${path}`;
    const initial: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) };
    const response = await fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
    const result = await response.json() as { readonly ok?: boolean; readonly value?: T; readonly error?: { readonly message?: string } };
    if (!response.ok || !result.ok) throw new TypeError(result.error?.message ?? "Application gateway request failed");
    return result.value as T;
  };
  const client: ApplicationGatewayResourceClient = {
    listConversations: (input) => invoke<ListConversationsResult>("/conversations/list", input),
    createConversation: (input) => invoke<CreateConversationResult>("/conversations/create", input),
    getConversation: (input) => invoke<GetConversationResult>("/conversations/get", input),
    renameConversation: (input) => invoke<RenameConversationResult>("/conversations/rename", input),
    clearConversation: (input) => invoke<ClearConversationResult>("/conversations/clear", input),
    archiveConversation: (input) => invoke<ArchiveConversationResult>("/conversations/archive", input),
    restoreConversation: (input) => invoke<RestoreConversationResult>("/conversations/restore", input),
    permanentlyDeleteConversation: (input) => invoke<PermanentlyDeleteConversationResult>("/conversations/permanent-delete", input),
    createApproval: (input) => invoke<ConversationApprovalProposalRecord>("/approvals/create", input),
    getApproval: (input) => invoke<ConversationApprovalProposalRecord | null>("/approvals/get", input),
    listApprovalGroup: (input) => invoke<readonly ConversationApprovalProposalRecord[]>("/approvals/list-group", input),
    transitionApproval: (input) => invoke<ConversationApprovalProposalRecord>("/approvals/transition", input),
    generateTitle: (input) => invoke<string>("/titles/generate", input),
  };
  return Object.freeze(client);
}

async function readGatewayStream<TEvent>(
  response: Response,
  decodeEvent: (value: unknown) => TEvent,
  started: (value: Extract<GatewayStreamMessage<TEvent>, { type: "started" }>) => void,
  disconnectRequest: () => void,
): Promise<TurnObservation<TEvent>> {
  if (!response.ok || response.body === null) throw response;
  let resolveResult!: (result: TurnObservationResult) => void;
  const result = new Promise<TurnObservationResult>((resolve) => { resolveResult = resolve; });
  let checkpoint = EMPTY_CHECKPOINT;
  const events = (async function* () {
    let terminal = false;
    try {
      for await (const frame of parseServerSentEvents(response.body!)) {
        if (!frame.data) continue;
        const message = JSON.parse(frame.data) as GatewayStreamMessage<unknown>;
        if (message.type === "started") started(message);
        else if (message.type === "event") { checkpoint = message.checkpoint; yield decodeEvent(message.event); }
        else if (message.type === "terminal") { terminal = true; resolveResult(message.result); }
      }
      if (!terminal) resolveResult({ status: "disconnected", checkpoint });
    } catch { resolveResult({ status: "disconnected", checkpoint }); }
  })();
  return { events, result, disconnect() {
    disconnectRequest();
    resolveResult({ status: "disconnected", checkpoint });
  } };
}

/** Browser and React-Native-compatible transport for an application-owned gateway. */
export function createApplicationGatewayTransport<TEvent = unknown, TRequest = unknown, TSynchronization = unknown>(
  options: ApplicationGatewayTransportOptions<TEvent, TSynchronization>,
): ConversationTransport<TEvent, TRequest, AttachmentUploadAdapter<ApplicationGatewayAttachmentSource>, ApplicationGatewayPresenceClient, TSynchronization> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const decode = options.decodeEvent ?? ((value: unknown) => value as TEvent);
  const invoke = async (path: string, payload: unknown, signal?: AbortSignal): Promise<Response> => {
    const url = `${base}${path}`;
    const initial: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), ...(signal ? { signal } : {}) };
    return fetcher(url, await options.protectedRequest?.({ url, ...initial }) ?? initial);
  };
  const cancellation = {
    async cancelTurn(input: CancelTurnInput): Promise<TransportResult<AuthoritativeCancelTurnResult>> {
      const response = await invoke("/turns/cancel", input);
      return response.json() as Promise<TransportResult<AuthoritativeCancelTurnResult>>;
    },
  };
  const negotiated = options.capabilities;
  const attachmentUpload = negotiated?.attachments
    ? createGatewayAttachmentUploadAdapter(options, negotiated.attachments)
    : null;
  const capabilities: ConversationTransportCapabilities<AttachmentUploadAdapter<ApplicationGatewayAttachmentSource>, ApplicationGatewayPresenceClient, TSynchronization> = {
    authoritativeCancellation: negotiated?.authoritativeCancellation === true
      ? { supported: true, capability: cancellation }
      : { supported: false },
    documentInput: { supported: false }, attachmentUpload: attachmentUpload
      ? { supported: true, capability: attachmentUpload }
      : { supported: false },
    presence: negotiated?.presence === true
      ? { supported: true, capability: createGatewayPresenceClient(options) }
      : { supported: false },
    synchronization: negotiated?.synchronization === true && options.synchronization !== undefined
      ? { supported: true, capability: options.synchronization }
      : { supported: false },
  };
  return Object.freeze({
    capabilities,
    async startTurn(input: StartTurnInput<TRequest>): Promise<TransportResult<TurnHandle<TEvent>>> {
      try {
        const connection = new AbortController();
        const response = await invoke("/turns/start", input, connection.signal);
        if (!response.ok) return await response.json() as TransportResult<TurnHandle<TEvent>>;
        const observation = await readGatewayStream(response, decode, () => undefined, () => connection.abort());
        return { ok: true, value: {
          conversationId: response.headers.get("x-handrail-conversation-id") ?? input.conversationId,
          turnId: response.headers.get("x-handrail-turn-id") ?? input.conversationTurnId,
          mutationId: response.headers.get("x-handrail-mutation-id") ?? input.mutationId,
          observation,
        } };
      } catch { return { ok: false, error: { code: "unavailable", message: "The application gateway is unavailable.", retryable: true } }; }
    },
    async resumeTurn(input: ResumeTurnInput): Promise<TransportResult<TurnObservation<TEvent>>> {
      try {
        const connection = new AbortController();
        const response = await invoke("/turns/resume", input, connection.signal);
        if (!response.ok) return await response.json() as TransportResult<TurnObservation<TEvent>>;
        return { ok: true, value: await readGatewayStream(response, decode, () => undefined, () => connection.abort()) };
      } catch { return { ok: false, error: { code: "unavailable", message: "The application gateway is unavailable.", retryable: true } }; }
    },
  });
}
