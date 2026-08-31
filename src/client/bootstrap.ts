import {
  createApplicationGatewayConversationCatalog,
  createApplicationGatewayResourceClient,
  createApplicationGatewayTransport,
  negotiateApplicationGatewayCapabilities,
  type ApplicationGatewayCapabilities,
  type ApplicationGatewayResourceClient,
  type ApplicationGatewayTransportOptions,
} from "../transports/application-gateway.js";
import { PollingConversationActivity } from "../conversation/activity.js";
import { ConversationRuntimeRegistry, type ConversationRuntimeFactory,
  type ConversationRuntimeRegistryPolicy } from "../conversation/runtime-registry.js";
import { ConversationWorkspace } from "../conversation/workspace.js";
import type { ConversationTransport } from "../transports/types.js";
import type { ConversationCatalog } from "../conversation/catalog.js";

export interface HandrailAiClientBootstrapOptions<TEvent, TRequest, TAuthorizationContext, TSynchronization = unknown>
extends ApplicationGatewayTransportOptions<TEvent, TSynchronization> {
  readonly createRuntime?: ConversationRuntimeFactory<TRequest, TAuthorizationContext>;
  readonly authorizeRuntime?: ConversationRuntimeRegistryPolicy<TAuthorizationContext>;
  readonly activityPollingMilliseconds?: number;
  readonly startActivityPolling?: boolean;
}

export interface HandrailAiClient<TEvent, TRequest, TAuthorizationContext> {
  readonly capabilities: ApplicationGatewayCapabilities;
  readonly transport: ConversationTransport<TEvent, TRequest>;
  readonly resources: ApplicationGatewayResourceClient;
  readonly activity: PollingConversationActivity | null;
  readonly catalog: ConversationCatalog<unknown>;
  readonly registry: ConversationRuntimeRegistry<TRequest, TAuthorizationContext> | null;
  readonly workspace: ConversationWorkspace<TRequest, TAuthorizationContext> | null;
  markActivityRead(conversationId: string): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Negotiates once and assembles the common cross-platform client graph. Low-level
 * factories remain public for applications that need different ownership.
 */
export async function createHandrailAiClient<TEvent = unknown, TRequest = unknown,
  TAuthorizationContext = unknown, TSynchronization = unknown>(
  options: HandrailAiClientBootstrapOptions<TEvent, TRequest, TAuthorizationContext, TSynchronization>,
): Promise<HandrailAiClient<TEvent, TRequest, TAuthorizationContext>> {
  if ((options.createRuntime === undefined) !== (options.authorizeRuntime === undefined)) {
    throw new TypeError("createRuntime and authorizeRuntime must be configured together");
  }
  const capabilities = options.capabilities ?? await negotiateApplicationGatewayCapabilities(options);
  const transport = createApplicationGatewayTransport<TEvent, TRequest, TSynchronization>({ ...options, capabilities });
  const resources = createApplicationGatewayResourceClient(options);
  const activity = capabilities.activity === true && resources.listActivity
    ? new PollingConversationActivity({ load: () => resources.listActivity!(),
      ...(options.activityPollingMilliseconds === undefined ? {} : { intervalMilliseconds: options.activityPollingMilliseconds }) }) : null;
  if (activity && options.startActivityPolling !== false) activity.start();
  const catalog = createApplicationGatewayConversationCatalog(resources, capabilities);
  const registry = options.createRuntime && options.authorizeRuntime
    ? new ConversationRuntimeRegistry<TRequest, TAuthorizationContext>({
      catalog,
      createRuntime: options.createRuntime, authorize: options.authorizeRuntime,
    }) : null;
  const workspace = registry ? new ConversationWorkspace(registry) : null;
  return Object.freeze({ capabilities, transport, resources, activity, catalog, registry, workspace,
    async markActivityRead(conversationId: string) {
      if (!resources.markActivityRead) return; await resources.markActivityRead({ conversationId }); await activity?.refresh();
    },
    async dispose() { activity?.stop(); await workspace?.dispose(); } });
}
