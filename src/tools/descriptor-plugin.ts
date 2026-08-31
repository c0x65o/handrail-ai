import type { JsonObject, JsonSchemaObject, JsonValue } from "../protocol.js";
import type { ApplicationToolExecutor, ApplicationToolExecutorContext, ApplicationToolPolicy } from "./executor.js";
import { createToolPlugin, type ToolPlugin, type ToolPluginPresentation } from "./plugin.js";

export interface DescriptorToolBase<TDiscoveryContext, TParsed> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  /** Keep Zod or another application validator authoritative. */
  readonly parse: (input: JsonObject) => TParsed;
  readonly available?: (context: TDiscoveryContext) => boolean;
  readonly tags?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly presentation?: Omit<ToolPluginPresentation, "toolName">;
}

export interface ReadDescriptorTool<TApplicationContext, TDiscoveryContext, TParsed>
  extends DescriptorToolBase<TDiscoveryContext, TParsed> {
  readonly kind: "read";
  readonly read: (input: TParsed, context: ApplicationToolExecutorContext<TApplicationContext>) => JsonValue | Promise<JsonValue>;
}

export interface ProposalDescriptorTool<TApplicationContext, TDiscoveryContext, TParsed>
  extends DescriptorToolBase<TDiscoveryContext, TParsed> {
  readonly kind: "proposal";
  /** This operation may create a proposal only; confirmation remains host-owned. */
  readonly propose: (input: TParsed, context: ApplicationToolExecutorContext<TApplicationContext>) => JsonValue | Promise<JsonValue>;
  readonly summarize: (input: TParsed, context: TApplicationContext) => string | Promise<string>;
  readonly approvalRendererKey?: string;
}

export type DescriptorTool<TApplicationContext, TDiscoveryContext> =
  | ReadDescriptorTool<TApplicationContext, TDiscoveryContext, unknown>
  | ProposalDescriptorTool<TApplicationContext, TDiscoveryContext, unknown>;

export interface CreateDescriptorToolPluginOptions<TApplicationContext, TDiscoveryContext> {
  readonly pluginId: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly descriptors: readonly DescriptorTool<TApplicationContext, TDiscoveryContext>[];
  readonly policy?: ApplicationToolPolicy<TApplicationContext>;
}

/**
 * Wrap existing application descriptors without replacing their validation,
 * authorization predicates, actor context, or proposal/confirmation model.
 */
export function createDescriptorToolPlugin<TApplicationContext, TDiscoveryContext>(
  options: CreateDescriptorToolPluginOptions<TApplicationContext, TDiscoveryContext>,
): ToolPlugin<ApplicationToolExecutor<TApplicationContext>, TDiscoveryContext, undefined, TApplicationContext> {
  const names = new Set<string>();
  for (const descriptor of options.descriptors) {
    if (names.has(descriptor.name)) throw new TypeError(`Duplicate descriptor "${descriptor.name}"`);
    names.add(descriptor.name);
  }
  return createToolPlugin({
    pluginId: options.pluginId, version: options.version, displayName: options.displayName,
    ...(options.description ? { description: options.description } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    registrations: options.descriptors.map((descriptor) => ({
      definition: { name: descriptor.name, description: descriptor.description, input_schema: descriptor.inputSchema },
      executor: async (input, context) => {
        const parsed = descriptor.parse(input);
        return descriptor.kind === "read"
          ? descriptor.read(parsed, context)
          : descriptor.propose(parsed, context);
      },
      ...(descriptor.available ? { discover: descriptor.available } : {}),
      ...(descriptor.tags ? { tags: descriptor.tags } : {}),
      ...(descriptor.capabilities ? { capabilities: descriptor.capabilities } : {}),
    })),
    approvals: options.descriptors.filter((descriptor): descriptor is ProposalDescriptorTool<TApplicationContext, TDiscoveryContext, unknown> => descriptor.kind === "proposal")
      .map((descriptor) => ({
        toolName: descriptor.name, mode: "never" as const,
        summarize: (input: JsonObject, context: unknown) => descriptor.summarize(descriptor.parse(input), context as TApplicationContext),
        ...(descriptor.approvalRendererKey ? { rendererKey: descriptor.approvalRendererKey } : {}),
      })),
    presentations: options.descriptors.flatMap((descriptor) => descriptor.presentation
      ? [{ toolName: descriptor.name, ...descriptor.presentation }] : []),
  });
}

export interface ToolDiscoveryParityResult {
  readonly matches: boolean;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
}

export function compareToolDiscoveryParity(expected: readonly string[], actual: readonly { readonly name: string }[]): ToolDiscoveryParityResult {
  const wanted = new Set(expected), received = new Set(actual.map((tool) => tool.name));
  const missing = [...wanted].filter((name) => !received.has(name)).sort();
  const unexpected = [...received].filter((name) => !wanted.has(name)).sort();
  return Object.freeze({ matches: missing.length === 0 && unexpected.length === 0,
    missing: Object.freeze(missing), unexpected: Object.freeze(unexpected) });
}
