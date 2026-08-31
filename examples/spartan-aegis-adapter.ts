import type {
  ApplicationToolExecutor,
  ApplicationToolPolicy,
  JsonObject,
  JsonSchemaObject,
  JsonValue,
  ToolRegistration,
} from "../src/index.js";

/** Structural shapes implemented by Spartan's existing AEGIS_TOOL_DEFINITIONS and AEGIS_ACTION_REGISTRY. */
export interface SpartanAegisFunctionDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchemaObject;
}
export interface SpartanAegisActionRegistry<TActor, TExecutionContext> {
  catalogFunctions(actor: TActor): readonly SpartanAegisFunctionDefinition[];
  validate(name: string, args: unknown): Record<string, unknown>;
  summarizeForActor(actor: TActor, name: string, args: unknown): Promise<string>;
  execute(actor: TActor, context: TExecutionContext, name: string, args: unknown): Promise<unknown>;
}

export interface SpartanAegisAdapterOptions<TActor, TExecutionContext> {
  readonly actor: TActor;
  readonly readDefinitions: readonly SpartanAegisFunctionDefinition[];
  readonly runReadTool: (name: string, input: unknown) => Promise<unknown>;
  readonly actionRegistry: SpartanAegisActionRegistry<TActor, TExecutionContext>;
  readonly actionExecutionContext: TExecutionContext;
}

function jsonResult(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return null;
  return JSON.parse(encoded) as JsonValue;
}

/**
 * Checked migration seam for Spartan's current definitions and action registry.
 * Zod validation, actor filtering, summaries, confirmation, and side effects
 * remain in Spartan. Handrail only supplies discovery/execution plumbing.
 */
export function createSpartanAegisRegistrations<TActor, TExecutionContext>(
  options: SpartanAegisAdapterOptions<TActor, TExecutionContext>,
): {
  readonly registrations: readonly ToolRegistration<ApplicationToolExecutor<TActor>, TActor>[];
  readonly policy: ApplicationToolPolicy<TActor>;
} {
  const actionDefinitions = options.actionRegistry.catalogFunctions(options.actor);
  const actionNames = new Set(actionDefinitions.map((definition) => definition.name));
  const registrations = [...options.readDefinitions, ...actionDefinitions].map((definition) => {
    const action = actionNames.has(definition.name);
    const executor: ApplicationToolExecutor<TActor> = async (args) => jsonResult(action
      ? await options.actionRegistry.execute(options.actor, options.actionExecutionContext,
          definition.name, options.actionRegistry.validate(definition.name, args))
      : await options.runReadTool(definition.name, args));
    return {
      definition: {
        name: definition.name,
        description: definition.description,
        input_schema: definition.parameters,
      },
      executor,
      discover: (actor: TActor) => actor === options.actor,
      tags: [action ? "spartan-action" : "spartan-read"],
    } satisfies ToolRegistration<ApplicationToolExecutor<TActor>, TActor>;
  });
  const policy: ApplicationToolPolicy<TActor> = ({ definition, arguments: args }) => {
    if (!actionNames.has(definition.name)) return { outcome: "allow" };
    // Re-run Spartan's Zod boundary before a proposal is persisted. Execution
    // occurs only after ApprovalExecutionCoordinator supplies confirmed evidence.
    options.actionRegistry.validate(definition.name, args as JsonObject);
    return { outcome: "external_approval_required" };
  };
  return Object.freeze({ registrations: Object.freeze(registrations), policy });
}

export const SPARTAN_AEGIS_TOOL_LOOP_LIMITS = Object.freeze({
  maxIterations: 8,
  maxTotalToolCalls: 8,
  maxElapsedMs: 120_000,
  parallelism: 1,
});
