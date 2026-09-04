import {
  createDirectProviderTransport,
  type DirectProviderTransport,
  type ProviderAdapter,
} from "@handrail/ai-assistant";
import {
  createManagedRuntimeTransport,
  type ManagedRuntimeFetch,
  type ManagedRuntimeHeadersProvider,
  type ManagedRuntimeTransport,
  type ManagedRuntimeUsageReceiptIdentityProvider,
} from "@handrail/ai-assistant/server/managed";

interface TrustedAttributionIds {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
}

/**
 * Build this only on an application-owned trusted server. The injected adapter
 * is created through one of the provider-specific package subpaths.
 */
export function createTrustedDirectTransport(
  adapter: ProviderAdapter,
  ids: TrustedAttributionIds,
): DirectProviderTransport {
  return createDirectProviderTransport({
    adapter,
    createContext(input, provider) {
      const requestIdentity = `request-${input.idempotencyKey}`;
      return {
        request_id: requestIdentity,
        trace_id: `trace-${input.idempotencyKey}`,
        turn_id: `turn-${input.idempotencyKey}`,
        attribution: {
          organization: {
            id: ids.organizationId,
            source: "server_derived",
            trust: "authoritative",
          },
          project: {
            id: ids.projectId,
            source: "server_derived",
            trust: "authoritative",
          },
          service_environment: {
            id: ids.environmentId,
            source: "server_derived",
            trust: "authoritative",
          },
          known_user: { id: null, source: "server_derived", trust: "authoritative" },
          session: { id: null, source: "server_derived", trust: "authoritative" },
          automation: { id: null, source: "server_derived", trust: "authoritative" },
        },
        correlation_hints: input.request.correlation_hints,
        ...(input.request.metadata === undefined
          ? {}
          : { metadata: input.request.metadata }),
        usage: {
          usage_receipt_id: `usage-${provider.provider_id}-${input.idempotencyKey}`,
          logical_request_id: requestIdentity,
          attempt: { id: `attempt-${input.idempotencyKey}`, index: 0 },
          continuation: { id: `continuation-${input.idempotencyKey}`, index: 0 },
          source: "provider",
          quality: "reported",
        },
      };
    },
  });
}

interface TrustedManagedDependencies {
  readonly baseUrl: URL;
  readonly fetch: ManagedRuntimeFetch;
  readonly getHeaders: ManagedRuntimeHeadersProvider;
  readonly createUsageReceiptIdentity?: ManagedRuntimeUsageReceiptIdentityProvider;
}

/**
 * Header acquisition and fetch policy are injected by trusted-server
 * infrastructure. This example performs no request by constructing a transport.
 */
export function createTrustedManagedTransport(
  dependencies: TrustedManagedDependencies,
): ManagedRuntimeTransport {
  return createManagedRuntimeTransport({
    baseUrl: dependencies.baseUrl,
    fetch: dependencies.fetch,
    getHeaders: dependencies.getHeaders,
    ...(dependencies.createUsageReceiptIdentity === undefined
      ? {}
      : { createUsageReceiptIdentity: dependencies.createUsageReceiptIdentity }),
  });
}
