import {
  normalizeCitationRecords,
  type CitationRecordSet,
  type CitationSourceType,
} from "../citations.js";
import type { JsonSchemaObject, JsonValue } from "../protocol.js";
import type {
  ApplicationToolExecutor,
  ApplicationToolOutput,
  ApplicationToolPolicy,
} from "../tools/executor.js";
import { createToolPlugin, type ToolPlugin, type ToolPluginPresentation } from "../tools/plugin.js";

export const MILLS_FAMILY_ADAPTER_VERSION = "handrail.mills-family.v1" as const;

export interface MillsFamilyToolDefinition {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly strict?: boolean;
}

export interface MillsFamilyReadOutcome<TCitation = unknown> {
  readonly kind: "read";
  readonly data: unknown;
  readonly citation: TCitation;
}

export interface MillsFamilyExternalOutcome {
  readonly kind: "external";
  readonly data: unknown;
}

export interface MillsFamilyProposalOutcome<TProposal = unknown> {
  readonly kind: "proposal";
  readonly proposal: TProposal;
}

export type MillsFamilyToolOutcome<TProposal = unknown, TCitation = unknown> =
  | MillsFamilyReadOutcome<TCitation>
  | MillsFamilyExternalOutcome
  | MillsFamilyProposalOutcome<TProposal>;

export interface MillsFamilyToolRuntime<TSession, TProposal = unknown, TCitation = unknown> {
  readonly definitions: readonly MillsFamilyToolDefinition[];
  execute(input: {
    readonly name: string;
    readonly arguments: unknown;
    readonly session: TSession;
    readonly requestId?: string;
    readonly conversationId?: string;
    readonly interaction?: "text_chat" | "realtime_voice";
    readonly reportActivity?: import("../tools/executor.js").ApplicationToolActivityReporter;
  }): Promise<MillsFamilyToolOutcome<TProposal, TCitation>>;
}

export interface MillsFamilyApplicationContext<TSession> {
  readonly session: TSession;
  readonly requestId?: string;
  readonly conversationId?: string;
  readonly interaction?: "text_chat" | "realtime_voice";
}

export interface MillsFamilyCitationLike {
  readonly sourceType: string;
  readonly sourceId: string;
  readonly label: string;
  readonly locator?: string;
}

export interface MillsFamilyProposalInput<TSession, TProposal> {
  readonly proposal: TProposal;
  readonly applicationContext: MillsFamilyApplicationContext<TSession>;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly signal: AbortSignal;
}

export interface MillsFamilyPluginOptions<TSession, TProposal = unknown, TCitation = MillsFamilyCitationLike> {
  readonly runtime: MillsFamilyToolRuntime<TSession, TProposal, TCitation>;
  /** Explicit because Mills intentionally exposes proposal and read tools through the same definition shape. */
  readonly proposalToolNames: readonly string[];
  /** Persists or stages a proposal only. Confirmed mutation execution remains Mills-owned. */
  readonly propose: (input: MillsFamilyProposalInput<TSession, TProposal>) =>
    ApplicationToolOutput | Promise<ApplicationToolOutput>;
  readonly policy: ApplicationToolPolicy<MillsFamilyApplicationContext<TSession>>;
  readonly citationRecords?: (
    citation: TCitation,
    input: { readonly toolName: string; readonly toolCallId: string },
  ) => CitationRecordSet;
  readonly presentationFor?: (
    toolName: string,
    kind: "read" | "proposal",
  ) => Omit<ToolPluginPresentation, "toolName"> | undefined;
}

/**
 * Wrap Mills' existing request-scoped runtime without importing ERP code. AJV
 * validates the advertised schema first; Mills' own Zod/runtime validation and
 * household authorization remain authoritative inside runtime.execute.
 */
export function createMillsFamilyPlugin<TSession, TProposal = unknown, TCitation = MillsFamilyCitationLike>(
  options: MillsFamilyPluginOptions<TSession, TProposal, TCitation>,
): ToolPlugin<
  ApplicationToolExecutor<MillsFamilyApplicationContext<TSession>>,
  MillsFamilyApplicationContext<TSession>,
  undefined,
  MillsFamilyApplicationContext<TSession>
> & { readonly adapterVersion: typeof MILLS_FAMILY_ADAPTER_VERSION } {
  const proposals = new Set(options.proposalToolNames);
  const definitions = new Map(options.runtime.definitions.map((definition) => [definition.name, definition]));
  if (definitions.size !== options.runtime.definitions.length) {
    throw new TypeError("Mills tool runtime contains duplicate definitions");
  }
  for (const name of proposals) {
    if (!definitions.has(name)) throw new TypeError(`Unknown Mills proposal tool "${name}"`);
  }

  const registrations = options.runtime.definitions.map((definition) => {
    const kind = proposals.has(definition.name) ? "proposal" as const : "read" as const;
    const executor: ApplicationToolExecutor<MillsFamilyApplicationContext<TSession>> = async (
      arguments_, context,
    ) => {
      const application = context.applicationContext;
      const outcome = await options.runtime.execute({
        name: definition.name,
        arguments: arguments_,
        session: application.session,
        ...(application.requestId === undefined ? {} : { requestId: application.requestId }),
        ...(application.conversationId === undefined ? {} : { conversationId: application.conversationId }),
        ...(application.interaction === undefined ? {} : { interaction: application.interaction }),
        ...(context.reportActivity === undefined ? {} : { reportActivity: context.reportActivity }),
      });
      if (outcome.kind === "proposal") {
        if (kind !== "proposal") throw new TypeError("Mills runtime returned a proposal for an undisclosed proposal tool");
        return options.propose({ proposal: outcome.proposal, applicationContext: application,
          toolName: definition.name, toolCallId: context.toolCallId, signal: context.signal });
      }
      if (kind === "proposal") throw new TypeError("Mills proposal tool returned a non-proposal outcome");
      const content = jsonValue(outcome.data, `Mills tool ${definition.name} output`);
      if (outcome.kind === "external") return content;
      const citationRecords = options.citationRecords
        ? options.citationRecords(outcome.citation, { toolName: definition.name, toolCallId: context.toolCallId })
        : defaultCitationRecords(outcome.citation as MillsFamilyCitationLike, definition.name, context.toolCallId);
      return { type: "handrail.application_tool_output" as const, content,
        citation_records: citationRecords };
    };
    return {
      definition: { name: definition.name, description: definition.description,
        input_schema: jsonSchema(definition.parameters) },
      executor,
      tags: [kind === "proposal" ? "mills-proposal" : "mills-read"],
    };
  });

  const presentation = (name: string, kind: "read" | "proposal") => {
    const value = options.presentationFor?.(name, kind);
    return value ? [{ toolName: name, ...value }] : [];
  };
  const plugin = createToolPlugin({
    pluginId: "mills.family.erp", version: "1.0.0", displayName: "Mills Family ERP",
    registrations,
    policy: options.policy,
    approvals: [...proposals].map((toolName) => ({ toolName, mode: "never" as const,
      summarize: () => `Review proposed ${toolName} change in Mills Family ERP.` })),
    presentations: options.runtime.definitions.flatMap((definition) =>
      presentation(definition.name, proposals.has(definition.name) ? "proposal" : "read")),
  });
  return Object.freeze({ ...plugin, adapterVersion: MILLS_FAMILY_ADAPTER_VERSION });
}

function jsonSchema(value: Readonly<Record<string, unknown>>): JsonSchemaObject {
  return jsonValue(value, "Mills tool parameters") as JsonSchemaObject;
}

function jsonValue(value: unknown, label: string): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError();
    return JSON.parse(serialized) as JsonValue;
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
}

function identifier(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._:@-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return (normalized || fallback).slice(0, 256);
}

function sourceType(citation: MillsFamilyCitationLike): CitationSourceType {
  if (citation.locator?.startsWith("https://") || citation.locator?.startsWith("http://")) return "web";
  return /document|attachment|file/iu.test(citation.sourceType) ? "document" : "tool";
}

function citationLocator(citation: MillsFamilyCitationLike): string | undefined {
  const locator = citation.locator?.trim();
  if (!locator) return undefined;
  if (locator.startsWith("https://") || locator.startsWith("http://")) return locator;
  // ERP citations often contain application routes. Citation records deliberately
  // use provider-neutral opaque locators instead of turning those routes into URLs.
  return `mills:${locator.replace(/^\/+|[^A-Za-z0-9._:@/?#&=-]+/gu, "_")}`;
}

function defaultCitationRecords(
  citation: MillsFamilyCitationLike,
  toolName: string,
  toolCallId: string,
): CitationRecordSet {
  const sourceId = identifier(`mills.${citation.sourceType}.${citation.sourceId}`, "mills.source") as never;
  const citationId = identifier(`mills.${toolCallId}.${citation.sourceId}`, "mills.citation") as never;
  const locator = citationLocator(citation);
  return normalizeCitationRecords({
    sources: [{ source_id: sourceId, type: sourceType(citation), label: citation.label,
      ...(locator ? { locator } : {}) }],
    citations: [{ citation_id: citationId, source_id: sourceId, order: 1,
      target: { type: "tool_result", tool_call_id: identifier(toolCallId, "tool-call") } }],
  });
}
