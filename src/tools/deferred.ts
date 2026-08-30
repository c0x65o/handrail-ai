import { parseToolDefinition, type ToolDefinition } from "../protocol.js";

export const DEFERRED_TOOL_DISCOVERY_VERSION = "handrail.deferred-tools.v1" as const;

const NAMESPACE_NAME = /^[a-z][a-z0-9_]{0,63}$/u;

export interface ToolNamespaceDefinition {
  readonly name: string;
  readonly description: string;
  readonly toolNames: readonly string[];
  /** Deferred namespaces expose metadata first and schemas only after selection. */
  readonly deferred?: boolean;
}

export interface ResolvedToolNamespace {
  readonly name: string;
  readonly description: string;
  readonly deferred: boolean;
  readonly tools: readonly ToolDefinition[];
}

export interface DeferredToolDiscoveryPlan {
  readonly version: typeof DEFERRED_TOOL_DISCOVERY_VERSION;
  readonly eagerTools: readonly ToolDefinition[];
  readonly namespaces: readonly ResolvedToolNamespace[];
  readonly toolCount: number;
}

export interface CreateDeferredToolDiscoveryPlanOptions {
  readonly tools: readonly ToolDefinition[];
  readonly namespaces: readonly ToolNamespaceDefinition[];
  /** Tools not assigned to a namespace are eager. Defaults to true. */
  readonly includeUnassigned?: boolean;
  /** Bound on eagerly projected schemas. Defaults to 16. */
  readonly maximumEagerTools?: number;
  /** Bound on all discovered tools. Defaults to 256. */
  readonly maximumTotalTools?: number;
}

function boundedInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 1_024) {
    throw new TypeError(`${name} must be an integer between 1 and 1024`);
  }
  return resolved;
}

/**
 * Builds a deterministic provider-neutral namespace plan from an already
 * actor/capability-filtered tool list. It never expands authorization: a
 * namespace may only reference definitions present in `tools`.
 */
export function createDeferredToolDiscoveryPlan(
  options: CreateDeferredToolDiscoveryPlanOptions,
): DeferredToolDiscoveryPlan {
  const maximumEager = boundedInteger(options.maximumEagerTools, 16, "maximumEagerTools");
  const maximumTotal = boundedInteger(options.maximumTotalTools, 256, "maximumTotalTools");
  if (options.tools.length > maximumTotal) {
    throw new TypeError("Discovered tool catalog exceeds maximumTotalTools");
  }
  const definitions = new Map<string, ToolDefinition>();
  for (const definition of options.tools) {
    const parsed = Object.freeze(parseToolDefinition(definition));
    if (definitions.has(parsed.name)) throw new TypeError(`Duplicate tool "${parsed.name}"`);
    definitions.set(parsed.name, parsed);
  }

  const assigned = new Set<string>();
  const namespaceNames = new Set<string>();
  const namespaces = options.namespaces.map((namespace, namespaceIndex) => {
    if (!NAMESPACE_NAME.test(namespace.name)) {
      throw new TypeError(`namespaces[${namespaceIndex}].name has an invalid format`);
    }
    if (namespaceNames.has(namespace.name)) throw new TypeError("Duplicate tool namespace");
    namespaceNames.add(namespace.name);
    if (
      typeof namespace.description !== "string" ||
      namespace.description.trim().length === 0 ||
      namespace.description.length > 1_024
    ) {
      throw new TypeError(`namespaces[${namespaceIndex}].description is invalid`);
    }
    if (namespace.toolNames.length === 0) {
      throw new TypeError(`namespaces[${namespaceIndex}] must contain at least one tool`);
    }
    const names = new Set<string>();
    const tools = namespace.toolNames.map((toolName) => {
      if (names.has(toolName)) throw new TypeError("Duplicate tool within namespace");
      names.add(toolName);
      const definition = definitions.get(toolName);
      if (definition === undefined) {
        throw new TypeError(`Namespace references undiscovered tool "${toolName}"`);
      }
      if (assigned.has(toolName)) throw new TypeError(`Tool "${toolName}" belongs to multiple namespaces`);
      assigned.add(toolName);
      return definition;
    });
    return Object.freeze({
      name: namespace.name,
      description: namespace.description.trim(),
      deferred: namespace.deferred ?? true,
      tools: Object.freeze(tools),
    });
  });

  const eagerTools = [
    ...namespaces.filter((namespace) => !namespace.deferred).flatMap((namespace) => namespace.tools),
    ...(options.includeUnassigned === false
      ? []
      : [...definitions.values()].filter((definition) => !assigned.has(definition.name))),
  ];
  if (eagerTools.length > maximumEager) {
    throw new TypeError("Eager tool projection exceeds maximumEagerTools");
  }

  return Object.freeze({
    version: DEFERRED_TOOL_DISCOVERY_VERSION,
    eagerTools: Object.freeze(eagerTools),
    namespaces: Object.freeze(namespaces),
    toolCount: definitions.size,
  });
}

export function findDeferredToolNamespace(
  plan: DeferredToolDiscoveryPlan,
  name: string,
): ResolvedToolNamespace | null {
  return plan.namespaces.find((namespace) => namespace.name === name) ?? null;
}

export function findDeferredTool(
  plan: DeferredToolDiscoveryPlan,
  name: string,
): ToolDefinition | null {
  return plan.eagerTools.find((tool) => tool.name === name) ??
    plan.namespaces.flatMap((namespace) => namespace.tools).find((tool) => tool.name === name) ??
    null;
}
