import {
  AI_RUNTIME_PROTOCOL_VERSION,
  InMemoryConversationCatalog,
  InMemoryConversationEventStore,
  createApplicationGateway,
  createAttachmentUploader,
  type ConversationId,
  type ConversationTransport,
  type StreamEvent,
  type TurnObservation,
} from "@handrail/ai";
import {
  createHandrailAiClient,
  type HandrailAiClient,
} from "@handrail/ai/client";
import {
  createAssistantGatewayAuthorizer,
  type AssistantGatewayAuthorizationContext,
} from "@handrail/ai/server/assistant-context";

export interface GoldenRequest { readonly prompt: string }
interface Principal { readonly principalId: string; readonly accountId: string }
interface ToolContext { readonly accountId: string; readonly permissions: readonly string[] }
type AuthorizationContext = AssistantGatewayAuthorizationContext<Principal, ToolContext>;
export type GoldenClient = HandrailAiClient<StreamEvent, GoldenRequest, Record<string, never>>;

let conversationSequence = 0;
let timestampSequence = 0;
const catalog = new InMemoryConversationCatalog<AuthorizationContext>({
  authorize: ({ authorizationContext }) => authorizationContext.principal.accountId === "account-7"
    ? "allow" : "deny",
  createConversationId: () => `conversation-${++conversationSequence}`,
  clock: { now: () => new Date(Date.UTC(2026, 8, 1, 12, 0, timestampSequence++)).toISOString() as never },
});

const authorize = createAssistantGatewayAuthorizer<Principal, ToolContext>({
  resolvePrincipal(request) {
    // Replace this example session check with the application's cookie/JWT verifier.
    if (request.headers.get("x-example-session") !== "authenticated") {
      throw new Error("unauthenticated");
    }
    return { principalId: "user-42", accountId: "account-7" };
  },
  buildContext({ principal }) {
    // These values come from trusted application storage, never from the turn body.
    return {
      attribution: {
        organizationId: principal.accountId,
        projectId: "support-assistant",
        serviceEnvironmentId: "development",
        sessionId: "session-9",
      },
      model: {
        instructions: ["Answer questions about the signed-in account."],
        profile: { displayName: "Ada", plan: "Pro" },
      },
      tools: { accountId: principal.accountId, permissions: ["invoices:read"] },
      presence: { participantId: principal.principalId, sessionId: "session-9", participantKind: "human" },
    };
  },
});

function observation(context: AuthorizationContext, requestId: string): TurnObservation<StreamEvent> {
  const profile = context.assistant.model.profile;
  const name = typeof profile?.displayName === "string" ? profile.displayName : "there";
  const frames: StreamEvent[] = [
    { type: "response.started", protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: requestId, trace_id: `trace-${requestId}`, sequence: 0,
      attribution: context.assistant.attribution },
    { type: "response.text.delta", protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: requestId, trace_id: `trace-${requestId}`, sequence: 1,
      delta: `Hello ${name}. This response crossed the authenticated gateway.` },
    { type: "response.completed", protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
      request_id: requestId, trace_id: `trace-${requestId}`, sequence: 2, outcome: "stop" },
  ];
  return {
    events: { async *[Symbol.asyncIterator]() { yield* frames; } },
    result: Promise.resolve({ status: "completed", checkpoint: {
      lastAppliedEventId: `${requestId}:2`, lastAppliedCursor: `${requestId}:2`, lastAppliedRevision: 2,
    } }),
    disconnect() {},
  };
}

function transportFor(context: AuthorizationContext): ConversationTransport<StreamEvent, GoldenRequest> {
  return {
    capabilities: {
      authoritativeCancellation: { supported: false }, documentInput: { supported: false },
      attachmentUpload: { supported: false }, presence: { supported: false },
      synchronization: { supported: false },
    },
    async startTurn(input) {
      const turnId = `provider-${input.idempotencyKey}`;
      return { ok: true, value: { conversationId: input.conversationId, mutationId: input.mutationId,
        turnId, observation: observation(context, turnId) } };
    },
    async resumeTurn() {
      return { ok: false, error: { code: "not_found", message: "Turn is no longer active.", retryable: false } };
    },
  };
}

export const goldenGateway = createApplicationGateway({
  authorize,
  transportFor,
  conversations: catalog,
  checkpointForEvent: (event: StreamEvent) => ({
    lastAppliedEventId: `${event.request_id}:${event.sequence}`,
    lastAppliedCursor: `${event.request_id}:${event.sequence}`,
    lastAppliedRevision: event.sequence,
  }),
});

/** In-process Fetch adapter; replace only this function with the deployed HTTPS endpoint. */
const gatewayFetch: typeof globalThis.fetch = (input, init) =>
  goldenGateway.handle(new Request(input, init));

const protectedRequest = (input: RequestInit) => {
  const headers = new Headers(input.headers);
  headers.set("x-example-session", "authenticated");
  return { ...input, headers };
};

export const goldenUploader = createAttachmentUploader<Blob>({
  async upload({ idempotencyKey, metadata }) {
    return { attachment_id: `attachment-${idempotencyKey}`, content_ref: `opaque-${idempotencyKey}`,
      media_type: metadata.mediaType, byte_size: metadata.byteSize };
  },
});

export function goldenComposer() {
  return { uploader: goldenUploader, createRequest: ({ text }: { readonly text: string }) => ({ prompt: text }) };
}

export async function createGoldenClient(mode: "single" | "multiple"): Promise<GoldenClient> {
  const common = {
    baseUrl: "https://app.example.test/api/ai",
    fetch: gatewayFetch,
    protectedRequest,
    decodeEvent: (value: unknown) => value as StreamEvent,
    buildRequest: ({ content }: { readonly content: string }) => ({ prompt: content }),
    startActivityPolling: false,
  };
  return mode === "single"
    ? createHandrailAiClient({ ...common, conversations: {
        mode: "single", conversationId: "support" as ConversationId,
        clientId: "browser-single" as never, eventStore: new InMemoryConversationEventStore(),
      } })
    : createHandrailAiClient({ ...common, conversations: {
        mode: "multiple", clientId: "browser-multiple" as never,
        eventStoreFor: () => new InMemoryConversationEventStore(), authorize: () => "allow",
      } });
}
