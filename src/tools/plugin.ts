import { parseToolDefinition, type JsonObject, type ToolDefinition } from "../protocol.js";
import type {
  ApplicationToolExecutor,
  ApplicationToolPolicy,
} from "./executor.js";
import type {
  ToolDiscoveryAdapter,
  ToolRegistration,
  ToolRegistrationSource,
} from "./registry.js";

export const TOOL_PLUGIN_CONTRACT_VERSION = "handrail.tool-plugin.v1" as const;

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
const PLUGIN_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const RENDERER_KEY = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/u;

export type ToolPluginApprovalMode = "never" | "always" | "policy";

export interface ToolPluginApprovalPresentation<TContext = unknown> {
  readonly toolName: string;
  readonly mode: ToolPluginApprovalMode;
  /** Safe, user-visible summary. Sensitive arguments must be omitted or redacted. */
  readonly summarize: (
    arguments_: JsonObject,
    context: TContext,
  ) => string | Promise<string>;
  readonly rendererKey?: string;
}

/**
 * Cross-platform presentation metadata. `rendererKey` is a stable lookup key;
 * executable React/native renderers stay in the client package and never cross
 * a server or persistence boundary.
 */
export interface ToolPluginPresentation {
  readonly toolName: string;
  readonly label: string;
  readonly description?: string;
  readonly rendererKey: string;
}

export interface ToolPluginDefinition<
  TExecutor = ApplicationToolExecutor,
  TDiscoveryContext = unknown,
  TInstallContext = unknown,
  TPolicyContext = unknown,
  TApprovalContext = unknown,
> {
  readonly contractVersion?: typeof TOOL_PLUGIN_CONTRACT_VERSION;
  readonly pluginId: string;
  readonly version: string;
  readonly displayName: string;
  readonly description?: string;
  readonly registrations:
    | readonly ToolRegistration<TExecutor, TDiscoveryContext>[]
    | ((context: TInstallContext) =>
        | ToolRegistrationSource<TExecutor, TDiscoveryContext>
        | Promise<ToolRegistrationSource<TExecutor, TDiscoveryContext>>);
  /** Optional plugin-wide execution policy composed by the trusted host. */
  readonly policy?: ApplicationToolPolicy<TPolicyContext>;
  readonly approvals?: readonly ToolPluginApprovalPresentation<TApprovalContext>[];
  readonly presentations?: readonly ToolPluginPresentation[];
}

export interface ToolPlugin<
  TExecutor = ApplicationToolExecutor,
  TDiscoveryContext = unknown,
  TInstallContext = unknown,
  TPolicyContext = unknown,
  TApprovalContext = unknown,
> extends ToolDiscoveryAdapter<TExecutor, TDiscoveryContext, TInstallContext> {
  readonly contractVersion: typeof TOOL_PLUGIN_CONTRACT_VERSION;
  readonly pluginId: string;
  readonly version: string;
  readonly identity: string;
  readonly displayName: string;
  readonly description?: string;
  readonly policy?: ApplicationToolPolicy<TPolicyContext>;
  readonly approvals: readonly ToolPluginApprovalPresentation<TApprovalContext>[];
  readonly presentations: readonly ToolPluginPresentation[];
}

function nonEmpty(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maximum} characters`);
  }
  return value.trim();
}

function immutableRegistration<TExecutor, TContext>(
  registration: ToolRegistration<TExecutor, TContext>,
): ToolRegistration<TExecutor, TContext> {
  return Object.freeze({
    ...registration,
    definition: parseToolDefinition(registration.definition),
    ...(registration.tags === undefined ? {} : { tags: Object.freeze([...registration.tags]) }),
    ...(registration.capabilities === undefined
      ? {}
      : { capabilities: Object.freeze([...registration.capabilities]) }),
  });
}

function validateUniqueToolMetadata<T extends { readonly toolName: string }>(
  values: readonly T[],
  field: string,
  toolNames: ReadonlySet<string>,
): readonly T[] {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const toolName = nonEmpty(value.toolName, `${field}[${index}].toolName`, 128);
    if (!toolNames.has(toolName)) {
      throw new TypeError(`${field}[${index}] references an unregistered tool`);
    }
    if (seen.has(toolName)) throw new TypeError(`${field} contains duplicate tool metadata`);
    seen.add(toolName);
  }
  return Object.freeze([...values]);
}

/** Create one immutable, versioned tool plugin with validated public metadata. */
export function createToolPlugin<
  TExecutor = ApplicationToolExecutor,
  TDiscoveryContext = unknown,
  TInstallContext = unknown,
  TPolicyContext = unknown,
  TApprovalContext = unknown,
>(
  definition: ToolPluginDefinition<
    TExecutor,
    TDiscoveryContext,
    TInstallContext,
    TPolicyContext,
    TApprovalContext
  >,
): ToolPlugin<
  TExecutor,
  TDiscoveryContext,
  TInstallContext,
  TPolicyContext,
  TApprovalContext
> {
  if (
    definition.contractVersion !== undefined &&
    definition.contractVersion !== TOOL_PLUGIN_CONTRACT_VERSION
  ) {
    throw new TypeError("Unsupported tool plugin contract version");
  }
  const pluginId = nonEmpty(definition.pluginId, "pluginId", 128);
  if (!PLUGIN_ID.test(pluginId)) throw new TypeError("pluginId has an invalid format");
  const version = nonEmpty(definition.version, "version", 64);
  if (!PLUGIN_VERSION.test(version)) throw new TypeError("version must be semantic version text");
  const displayName = nonEmpty(definition.displayName, "displayName");
  const description = definition.description === undefined
    ? undefined
    : nonEmpty(definition.description, "description", 1_024);

  const fixed: readonly ToolRegistration<TExecutor, TDiscoveryContext>[] | null =
    Array.isArray(definition.registrations)
      ? Object.freeze(
          (definition.registrations as readonly ToolRegistration<TExecutor, TDiscoveryContext>[])
            .map((registration) => immutableRegistration(registration)),
        )
      : null;
  const fixedToolNames = new Set(fixed?.map((item) => item.definition.name) ?? []);
  const approvals = fixed === null
    ? Object.freeze([...(definition.approvals ?? [])])
    : validateUniqueToolMetadata(definition.approvals ?? [], "approvals", fixedToolNames);
  const presentations = fixed === null
    ? Object.freeze([...(definition.presentations ?? [])])
    : validateUniqueToolMetadata(definition.presentations ?? [], "presentations", fixedToolNames);

  for (const [index, presentation] of presentations.entries()) {
    nonEmpty(presentation.label, `presentations[${index}].label`, 160);
    if (!RENDERER_KEY.test(presentation.rendererKey)) {
      throw new TypeError(`presentations[${index}].rendererKey has an invalid format`);
    }
  }
  for (const [index, approval] of approvals.entries()) {
    if (!["never", "always", "policy"].includes(approval.mode)) {
      throw new TypeError(`approvals[${index}].mode is invalid`);
    }
    if (typeof approval.summarize !== "function") {
      throw new TypeError(`approvals[${index}].summarize must be a function`);
    }
    if (approval.rendererKey !== undefined && !RENDERER_KEY.test(approval.rendererKey)) {
      throw new TypeError(`approvals[${index}].rendererKey has an invalid format`);
    }
  }

  const registrations = async (
    context: TInstallContext,
  ): Promise<ToolRegistrationSource<TExecutor, TDiscoveryContext>> => {
    if (fixed !== null) return fixed;
    const source = await (definition.registrations as Exclude<
      ToolPluginDefinition<TExecutor, TDiscoveryContext, TInstallContext>["registrations"],
      readonly ToolRegistration<TExecutor, TDiscoveryContext>[]
    >)(context);
    return source;
  };

  return Object.freeze({
    contractVersion: TOOL_PLUGIN_CONTRACT_VERSION,
    pluginId,
    version,
    identity: `${pluginId}@${version}`,
    displayName,
    ...(description === undefined ? {} : { description }),
    ...(definition.policy === undefined ? {} : { policy: definition.policy }),
    approvals,
    presentations,
    registrations,
  });
}

export interface ToolPluginCatalogEntry {
  readonly pluginId: string;
  readonly version: string;
  readonly identity: string;
  readonly displayName: string;
  readonly description?: string;
  readonly tools: readonly ToolDefinition[];
  readonly approvals: readonly ToolPluginApprovalPresentation[];
  readonly presentations: readonly ToolPluginPresentation[];
}

/**
 * Trusted-host coordinator for plugin lifecycle and atomic installation into a
 * ToolRegistry. Registering a different version under an existing plugin ID is
 * explicit: unregister the old plugin and rebuild the host registry first.
 */
export class ToolPluginRegistry<
  TExecutor = ApplicationToolExecutor,
  TDiscoveryContext = unknown,
  TInstallContext = unknown,
> {
  readonly #plugins = new Map<string, ToolPlugin<TExecutor, TDiscoveryContext, TInstallContext>>();

  register(plugin: ToolPlugin<TExecutor, TDiscoveryContext, TInstallContext>): this {
    if (this.#plugins.has(plugin.pluginId)) {
      throw new TypeError(`Tool plugin "${plugin.pluginId}" is already registered`);
    }
    this.#plugins.set(plugin.pluginId, plugin);
    return this;
  }

  unregister(pluginId: string): boolean {
    return this.#plugins.delete(pluginId);
  }

  get(pluginId: string): ToolPlugin<TExecutor, TDiscoveryContext, TInstallContext> | undefined {
    return this.#plugins.get(pluginId);
  }

  list(): readonly ToolPlugin<TExecutor, TDiscoveryContext, TInstallContext>[] {
    return Object.freeze([...this.#plugins.values()].sort((left, right) =>
      left.pluginId.localeCompare(right.pluginId)));
  }

  asDiscoveryAdapter(): ToolDiscoveryAdapter<TExecutor, TDiscoveryContext, TInstallContext> {
    return {
      registrations: async (context) => {
        const registrations: ToolRegistration<TExecutor, TDiscoveryContext>[] = [];
        const names = new Set<string>();
        for (const plugin of this.list()) {
          const source = await plugin.registrations(context);
          for await (const registration of source) {
            if (names.has(registration.definition.name)) {
              throw new TypeError(`Duplicate plugin tool "${registration.definition.name}"`);
            }
            names.add(registration.definition.name);
            registrations.push(registration);
          }
        }
        return registrations;
      },
    };
  }
}
