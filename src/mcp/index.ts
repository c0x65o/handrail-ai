import type { JsonObject, JsonSchemaObject, JsonValue } from "../protocol.js";
import type { ApplicationToolExecutor, ApplicationToolExecutorContext } from "../tools/executor.js";
import type { ToolDiscoveryAdapter, ToolRegistration } from "../tools/registry.js";

export const MCP_CONNECTOR_ADAPTER_VERSION = "handrail.mcp-connector.v1" as const;

export interface McpListedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonSchemaObject;
  readonly annotations?: Readonly<Record<string, JsonValue>>;
}

/** SDK-neutral MCP client subset. Keep a concrete MCP SDK in the companion/application layer. */
export interface McpConnectorClient {
  listTools(input: { readonly signal?: AbortSignal }): Promise<{ readonly tools: readonly McpListedTool[] }>;
  callTool(input: {
    readonly name: string;
    readonly arguments: JsonObject;
    /** Stable across retries; the connector must not weaken server-side idempotency. */
    readonly idempotencyKey: string;
    readonly signal: AbortSignal;
  }): Promise<JsonValue>;
}

export interface McpAuthorizationRequest<TContext> {
  readonly operation: "discover" | "execute";
  readonly toolName?: string;
  readonly context: TContext;
  readonly arguments?: JsonObject;
  readonly toolCallId?: string;
}

export interface McpConnectorAdapterOptions<TContext, TAdapterContext = TContext> {
  readonly connectorId: string;
  readonly client: McpConnectorClient;
  readonly authorize: (request: McpAuthorizationRequest<TContext | TAdapterContext>) => "allow" | "deny" | Promise<"allow" | "deny">;
  readonly executionContext: (context: ApplicationToolExecutorContext<TContext>) => TContext;
  readonly namespace?: string;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
}

function identifier(value: string, field: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(value)) throw new TypeError(`${field} is invalid`);
  return value;
}

/**
 * Separately versioned MCP-to-ToolDiscoveryAdapter bridge. Authorization runs
 * before catalog disclosure and again immediately before execution. Tool-call
 * identity is forwarded as the idempotency boundary.
 */
export function createMcpConnectorAdapter<TContext, TAdapterContext = TContext>(
  options: McpConnectorAdapterOptions<TContext, TAdapterContext>,
): ToolDiscoveryAdapter<ApplicationToolExecutor<TContext>, TContext, TAdapterContext> & {
  readonly version: typeof MCP_CONNECTOR_ADAPTER_VERSION;
  readonly connectorId: string;
} {
  const connectorId = identifier(options.connectorId, "connectorId");
  const namespace = options.namespace === undefined ? "" : `${identifier(options.namespace, "namespace")}.`;
  return Object.freeze({
    version: MCP_CONNECTOR_ADAPTER_VERSION,
    connectorId,
    async registrations(context: TAdapterContext) {
      if (await options.authorize({ operation: "discover", context }) !== "allow") return [];
      const listed = await options.client.listTools({});
      const names = new Set<string>();
      return Object.freeze(listed.tools.map((tool): ToolRegistration<ApplicationToolExecutor<TContext>, TContext> => {
        const remoteName = identifier(tool.name, "MCP tool name");
        const name = `${namespace}${remoteName}`;
        if (names.has(name)) throw new TypeError("MCP server returned duplicate tool names");
        names.add(name);
        const executor: ApplicationToolExecutor<TContext> = async (arguments_, execution) => {
          const applicationContext = options.executionContext(execution);
          if (await options.authorize({ operation: "execute", toolName: remoteName, context: applicationContext, arguments: arguments_, toolCallId: execution.toolCallId }) !== "allow") {
            throw new TypeError("MCP tool execution is not authorized");
          }
          return options.client.callTool({ name: remoteName, arguments: arguments_, idempotencyKey: execution.toolCallId, signal: execution.signal });
        };
        return {
          definition: { name, description: tool.description?.trim() || `MCP tool ${remoteName}`, input_schema: tool.inputSchema },
          executor,
          ...(options.tags ? { tags: options.tags } : {}),
          ...(options.capabilities ? { capabilities: options.capabilities } : {}),
        };
      }));
    },
  });
}
