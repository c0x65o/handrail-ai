import type {
  AuthoritativeAttribution,
  CorrelationHints,
  JsonObject,
} from "../protocol.js";
import type {
  ApplicationGatewayAction,
  ApplicationGatewayAuthorizationContext,
} from "../transports/application-gateway.js";

export const SERVER_ASSISTANT_CONTEXT_VERSION =
  "handrail.server-assistant-context.v1" as const;

export const SERVER_ASSISTANT_CONTEXT_LIMITS = Object.freeze({
  identifierLength: 256,
  instructionCount: 32,
  instructionLength: 8_192,
  modelProfileBytes: 16_384,
} as const);

export interface ServerAssistantPrincipal
  extends ApplicationGatewayAuthorizationContext {
  /** Stable server-authenticated principal identity. Never accept this from a turn body. */
  readonly principalId: string;
}

export interface ServerAssistantAttributionScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly serviceEnvironmentId: string;
  readonly sessionId?: string | null;
  readonly automationId?: string | null;
}

/** Data intentionally disclosed to the model. Do not place secrets in this object. */
export interface ServerAssistantModelContext {
  readonly instructions?: readonly string[];
  readonly profile?: JsonObject;
}

/** Optional UI presence identity. It is not authorization or model context. */
export interface ServerAssistantPresenceIdentity {
  readonly participantId: string;
  readonly sessionId: string;
  readonly deviceId?: string;
  readonly participantKind?: "human" | "automation";
}

export interface CreateServerAssistantContextInput<
  TPrincipal extends ServerAssistantPrincipal,
  TToolContext,
> {
  /** Authenticated by the host before this function is called. */
  readonly principal: TPrincipal;
  readonly attribution: ServerAssistantAttributionScope;
  readonly model?: ServerAssistantModelContext;
  /** Server-owned data passed to tool policy/execution, never serialized for the model. */
  readonly tools: TToolContext;
  readonly presence?: ServerAssistantPresenceIdentity;
  /** Client values remain untrusted correlation hints and never become attribution. */
  readonly clientCorrelationHints?: CorrelationHints;
}

export interface ServerAssistantContext<
  TPrincipal extends ServerAssistantPrincipal,
  TToolContext,
> {
  readonly version: typeof SERVER_ASSISTANT_CONTEXT_VERSION;
  readonly principal: TPrincipal;
  readonly attribution: AuthoritativeAttribution;
  readonly model: Readonly<Required<Pick<ServerAssistantModelContext, "instructions">> &
    Pick<ServerAssistantModelContext, "profile">>;
  readonly tools: TToolContext;
  readonly presence: ServerAssistantPresenceIdentity | null;
  readonly clientCorrelationHints: Readonly<CorrelationHints>;
}

export interface AssistantGatewayAuthorizationContext<
  TPrincipal extends ServerAssistantPrincipal,
  TToolContext,
> extends ApplicationGatewayAuthorizationContext {
  readonly principal: TPrincipal;
  readonly assistant: ServerAssistantContext<TPrincipal, TToolContext>;
}

export interface AssistantGatewayContextBuildInput<
  TPrincipal extends ServerAssistantPrincipal,
> {
  readonly principal: TPrincipal;
  readonly request: Request;
  readonly action: ApplicationGatewayAction;
}

export interface AssistantGatewayAuthorizerOptions<
  TPrincipal extends ServerAssistantPrincipal,
  TToolContext,
> {
  /** Resolve and authenticate using server-controlled request/session state. */
  readonly resolvePrincipal: (
    request: Request,
    action: ApplicationGatewayAction,
  ) => TPrincipal | Promise<TPrincipal>;
  /** Resolve profile/tool/presence context from authoritative application data. */
  readonly buildContext: (
    input: AssistantGatewayContextBuildInput<TPrincipal>,
  ) => Omit<CreateServerAssistantContextInput<TPrincipal, TToolContext>, "principal"> |
    Promise<Omit<CreateServerAssistantContextInput<TPrincipal, TToolContext>, "principal">>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const ENCODER = new TextEncoder();

function identifier(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 ||
    value.length > SERVER_ASSISTANT_CONTEXT_LIMITS.identifierLength ||
    !IDENTIFIER.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function authoritative(id: string) {
  return Object.freeze({ id, source: "server_derived", trust: "authoritative" } as const);
}

function optionalAuthoritative(id: string | null | undefined) {
  return Object.freeze({
    id: id == null ? null : identifier(id, "attribution identifier"),
    source: "server_derived",
    trust: "authoritative",
  } as const);
}

function cloneJson(value: JsonObject): JsonObject {
  const serialized = JSON.stringify(value);
  if (ENCODER.encode(serialized).byteLength > SERVER_ASSISTANT_CONTEXT_LIMITS.modelProfileBytes) {
    throw new TypeError("model profile is too large");
  }
  return JSON.parse(serialized) as JsonObject;
}

function instructions(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (values.length > SERVER_ASSISTANT_CONTEXT_LIMITS.instructionCount ||
    values.some((value) => typeof value !== "string" || value.length === 0 ||
      value.length > SERVER_ASSISTANT_CONTEXT_LIMITS.instructionLength)) {
    throw new TypeError("model instructions are invalid");
  }
  return Object.freeze([...values]);
}

function correlationHints(value: CorrelationHints | undefined): Readonly<CorrelationHints> {
  if (value === undefined) return Object.freeze({});
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, hint]) => [
    key,
    Object.freeze({ ...hint }),
  ])) as CorrelationHints);
}

/**
 * Construct the one server-owned context used by gateway routing, provider
 * attribution, model personalization, tool policy, and optional presence.
 * Client hints are retained in a deliberately separate, untrusted field.
 */
export function createServerAssistantContext<
  TPrincipal extends ServerAssistantPrincipal,
  TToolContext,
>(input: CreateServerAssistantContextInput<TPrincipal, TToolContext>):
ServerAssistantContext<TPrincipal, TToolContext> {
  const principalId = identifier(input.principal.principalId, "principalId");
  const scope = input.attribution;
  const modelInstructions = instructions(input.model?.instructions);
  const profile = input.model?.profile === undefined
    ? undefined
    : Object.freeze(cloneJson(input.model.profile));
  const presence = input.presence === undefined ? null : Object.freeze({
    participantId: identifier(input.presence.participantId, "presence participantId"),
    sessionId: identifier(input.presence.sessionId, "presence sessionId"),
    ...(input.presence.deviceId === undefined ? {} : {
      deviceId: identifier(input.presence.deviceId, "presence deviceId"),
    }),
    ...(input.presence.participantKind === undefined ? {} : {
      participantKind: input.presence.participantKind,
    }),
  });
  return Object.freeze({
    version: SERVER_ASSISTANT_CONTEXT_VERSION,
    principal: input.principal,
    attribution: Object.freeze({
      organization: authoritative(identifier(scope.organizationId, "organizationId")),
      project: authoritative(identifier(scope.projectId, "projectId")),
      service_environment: authoritative(identifier(scope.serviceEnvironmentId, "serviceEnvironmentId")),
      known_user: optionalAuthoritative(principalId),
      session: optionalAuthoritative(scope.sessionId),
      automation: optionalAuthoritative(scope.automationId),
    }),
    model: Object.freeze({ instructions: modelInstructions, ...(profile === undefined ? {} : { profile }) }),
    tools: input.tools,
    presence,
    clientCorrelationHints: correlationHints(input.clientCorrelationHints),
  });
}

/**
 * Produce explicit provider instructions from only the model-visible portion.
 * Attribution, tool context, presence, and correlation hints are never included.
 */
export function serverAssistantInstructions(
  context: ServerAssistantContext<ServerAssistantPrincipal, unknown>,
): string | undefined {
  const parts = [...context.model.instructions];
  if (context.model.profile !== undefined) {
    parts.push(`Server-authoritative user context (JSON): ${JSON.stringify(context.model.profile)}`);
  }
  return parts.length === 0 ? undefined : parts.join("\n\n");
}

/** Build an application-gateway authorizer whose returned identity is server-owned. */
export function createAssistantGatewayAuthorizer<
  TPrincipal extends ServerAssistantPrincipal,
  TToolContext,
>(options: AssistantGatewayAuthorizerOptions<TPrincipal, TToolContext>): (
  request: Request,
  action: ApplicationGatewayAction,
) => Promise<AssistantGatewayAuthorizationContext<TPrincipal, TToolContext>> {
  return async (request, action) => {
    const principal = await options.resolvePrincipal(request, action);
    const input = await options.buildContext({ principal, request, action });
    const assistant = createServerAssistantContext({ principal, ...input });
    return Object.freeze({ principalId: principal.principalId, principal, assistant });
  };
}
