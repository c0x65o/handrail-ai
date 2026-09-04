import { describe, expect, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  InMemoryConversationEventStore,
  createToolPlugin,
  parseChatRequest,
  type ApplicationToolExecutor,
  type AuthoritativeAttribution,
  type ChatRequest,
  type ConversationClientId,
  type ConversationId,
  type ConversationTransport,
  type StartTurnInput,
  type StreamEvent,
  type TurnHandle,
  type TransportResult,
} from "../src/index.js";
import { createAiApplication } from "../src/server/application.js";

const attribution: AuthoritativeAttribution = {
  organization: { id: "org", source: "server_derived", trust: "authoritative" },
  project: { id: "project", source: "server_derived", trust: "authoritative" },
  service_environment: { id: "test", source: "server_derived", trust: "authoritative" },
  known_user: { id: "user", source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

class ToolThenTextTransport implements ConversationTransport<StreamEvent, ChatRequest> {
  readonly capabilities = {
    authoritativeCancellation: { supported: false }, documentInput: { supported: false },
    attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
  } as const;
  calls = 0;

  async startTurn(input: StartTurnInput<ChatRequest>): Promise<TransportResult<TurnHandle<StreamEvent>>> {
    this.calls += 1;
    const requestId = `request-${this.calls}`;
    const frames: StreamEvent[] = [{
      type: "response.started", protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: requestId,
      trace_id: `trace-${this.calls}`, sequence: 0, attribution,
    }, ...(this.calls === 1 ? [{
      type: "response.tool_call" as const, protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: requestId,
      trace_id: `trace-${this.calls}`, sequence: 1, tool_call_id: "call-1", name: "spartan.invoice.lookup",
      arguments: { id: "invoice-1" },
    }] : [{
      type: "response.text.delta" as const, protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: requestId,
      trace_id: `trace-${this.calls}`, sequence: 1, delta: "Paid",
    }]), {
      type: "response.completed", protocol_version: AI_RUNTIME_PROTOCOL_VERSION, request_id: requestId,
      trace_id: `trace-${this.calls}`, sequence: 2, outcome: this.calls === 1 ? "tool_calls" : "stop",
    }];
    return { ok: true, value: {
      conversationId: input.conversationId, mutationId: input.mutationId, turnId: input.conversationTurnId,
      observation: {
        events: { async *[Symbol.asyncIterator]() { yield* frames; } },
        result: Promise.resolve({ status: "completed", checkpoint: {
          lastAppliedEventId: `${requestId}:2`, lastAppliedCursor: `${requestId}:2`, lastAppliedRevision: 2,
        } }),
        disconnect() {},
      },
    } };
  }
  async resumeTurn(): Promise<never> { throw new Error("unexpected resume"); }
}

describe("trusted AI application assembly", () => {
  it("enforces fixed plugin approval modes without consulting project policy", async () => {
    const execute = vi.fn<ApplicationToolExecutor>(async () => ({ ok: true }));
    const tool = (name: string) => ({ definition: { name, description: name,
        input_schema: { type: "object" as const, properties: {}, additionalProperties: false } }, executor: execute });
    const plugin = createToolPlugin({ pluginId: "fixed.approvals", version: "1.0.0",
      displayName: "Fixed approvals", registrations: [tool("fixed.always"), tool("fixed.never")],
      approvals: [
        { toolName: "fixed.always", mode: "always", summarize: () => "Always review" },
        { toolName: "fixed.never", mode: "never", summarize: () => "No plugin review" },
      ] });
    const approvalPolicy = vi.fn(() => "allow_without_approval" as const);
    const app = await createAiApplication({ plugins: [plugin], installContext: undefined,
      policy: () => ({ outcome: "allow" }), approvalPolicy });
    const discovery = { context: undefined };
    await expect(app.executeTool({ call: { tool_call_id: "always", name: "fixed.always", arguments: {} },
      discovery, applicationContext: {} })).resolves.toMatchObject({ status: "external_approval_required" });
    await expect(app.executeTool({ call: { tool_call_id: "never", name: "fixed.never", arguments: {} },
      discovery, applicationContext: {} })).resolves.toMatchObject({ status: "completed" });
    expect(approvalPolicy).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("separates project approval settings from tool authorization", async () => {
    type ProjectContext = { readonly projectId: string; readonly requireApprovals: boolean };
    const execute = vi.fn<ApplicationToolExecutor<ProjectContext>>(async () => ({ updated: true }));
    const plugin = createToolPlugin<ApplicationToolExecutor<ProjectContext>, undefined, undefined, ProjectContext>({
      pluginId: "accounting.bulk", version: "1.0.0", displayName: "Bulk accounting",
      registrations: [{ definition: { name: "accounting.bulk_update", description: "Bulk update",
        input_schema: { type: "object", properties: {}, additionalProperties: false } }, executor: execute }],
      approvals: [{ toolName: "accounting.bulk_update", mode: "policy",
        summarize: () => "Apply the reviewed accounting updates" }],
    });
    const approvalPolicy = vi.fn((input: import("../src/server/application.js").ApplicationApprovalPolicyInput<ProjectContext>) =>
      input.applicationContext.requireApprovals ? "require_approval" as const : "allow_without_approval" as const);
    const app = await createAiApplication({ plugins: [plugin], installContext: undefined,
      policy: () => ({ outcome: "allow" }), approvalPolicy });
    const tools = app.discover({ context: undefined });

    await expect(app.executeTool({ call: { tool_call_id: "bulk-required", name: "accounting.bulk_update",
      arguments: {} }, discovery: { context: undefined },
      applicationContext: { projectId: "controlled", requireApprovals: true } }))
      .resolves.toMatchObject({ status: "external_approval_required" });
    await expect(app.executeTool({ call: { tool_call_id: "bulk-direct", name: "accounting.bulk_update",
      arguments: {} }, discovery: { context: undefined },
      applicationContext: { projectId: "trusted", requireApprovals: false } }))
      .resolves.toMatchObject({ status: "completed", result: { is_error: false } });
    expect(tools).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(approvalPolicy).toHaveBeenCalledTimes(2);
  });

  it.each(["deny", "external_approval_required"] as const)("preserves host %s when project approvals are disabled", async (outcome) => {
    const execute = vi.fn<ApplicationToolExecutor>(async () => ({ updated: true }));
    const approvalPolicy = vi.fn(() => "allow_without_approval" as const);
    const plugin = createToolPlugin({ pluginId: "bulk.authorization", version: "1.0.0", displayName: "Bulk",
      registrations: [{ definition: { name: "bulk", description: "Bulk update", input_schema: { type: "object" } },
        executor: execute }],
      approvals: [{ toolName: "bulk", mode: "policy", summarize: () => "Update products" }],
    });
    const app = await createAiApplication({ plugins: [plugin], installContext: undefined,
      policy: () => ({ outcome }), approvalPolicy });
    const result = await app.executeTool({ call: { tool_call_id: outcome, name: "bulk", arguments: {} },
      discovery: { context: undefined }, applicationContext: {} });
    expect(result).toMatchObject(outcome === "deny"
      ? { status: "completed", result: { is_error: true } }
      : { status: "external_approval_required" });
    expect(execute).not.toHaveBeenCalled();
    expect(approvalPolicy).not.toHaveBeenCalled();
  });

  it("installs a plugin once, exposes a data-only catalog, and runs its bounded tool loop", async () => {
    const diagnostics: import("../src/index.js").AiDiagnosticEvent[] = [];
    const execute = vi.fn<ApplicationToolExecutor<{ companyId: string }>>(async ({ id }, context) => ({
      id: String(id ?? ""), companyId: context.applicationContext.companyId,
    }));
    const pluginPolicy = vi.fn(() => ({ outcome: "allow" as const }));
    const summarize = vi.fn(() => "Look up invoice");
    const plugin = createToolPlugin<ApplicationToolExecutor<{ companyId: string }>, { role: string }, undefined, { companyId: string }>({
      pluginId: "spartan.erp", version: "1.0.0", displayName: "Spartan ERP",
      registrations: [{
        definition: { name: "spartan.invoice.lookup", description: "Lookup", input_schema: {
          type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false,
        } },
        executor: execute,
        discover: ({ role }) => role === "finance",
      }],
      policy: pluginPolicy,
      approvals: [{ toolName: "spartan.invoice.lookup", mode: "policy", summarize, rendererKey: "spartan.invoice.approval" }],
      presentations: [{ toolName: "spartan.invoice.lookup", label: "Invoice", rendererKey: "spartan.invoice.result" }],
    });
    const hostPolicy = vi.fn(() => ({ outcome: "allow" as const }));
    const app = await createAiApplication({ plugins: [plugin], installContext: undefined, policy: hostPolicy,
      diagnostics: (event) => diagnostics.push(event),
      executorLimits: { maxConcurrency: 1 }, toolLoopLimits: { maxTotalToolCalls: 4 } });

    expect(app.discover({ context: { role: "viewer" } })).toEqual([]);
    const catalog = app.catalog({ context: { role: "finance" } });
    expect(catalog.plugins[0]).toMatchObject({
      pluginId: "spartan.erp",
      tools: [{ name: "spartan.invoice.lookup" }],
      approvals: [{ rendererKey: "spartan.invoice.approval" }],
      presentations: [{ rendererKey: "spartan.invoice.result" }],
    });
    expect(JSON.stringify(catalog)).not.toContain("summarize");
    expect(JSON.stringify(catalog)).not.toContain("executor");

    const transport = new ToolThenTextTransport();
    const runtime = await app.createRuntime({
      conversationId: "conversation-assembly" as ConversationId,
      clientId: "client-assembly" as ConversationClientId,
      eventStore: new InMemoryConversationEventStore(), transport,
    });
    const tools = app.discover({ context: { role: "finance" } });
    const request = parseChatRequest({
      protocol_version: AI_RUNTIME_PROTOCOL_VERSION, continuation_of: null,
      messages: [{ role: "user", content: [{ type: "text", text: "Check it" }] }],
      tools, tool_results: [], generation: { max_output_tokens: 128, temperature: 0 },
      correlation_hints: {}, metadata: {},
    });
    const result = await app.run({
      runtime, initialTurn: runtime.sendMessage({ content: "Check it", request }), request,
      discovery: { context: { role: "finance" } }, applicationContext: { companyId: "company-1" },
    });

    expect(result).toMatchObject({ status: "completed", outcome: "stop", totalToolCalls: 1 });
    expect(execute).toHaveBeenCalledOnce();
    expect(hostPolicy).toHaveBeenCalledOnce();
    expect(pluginPolicy).toHaveBeenCalledOnce();
    expect(summarize).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "tool", phase: "started", toolName: "spartan.invoice.lookup" }),
      expect.objectContaining({ domain: "tool", phase: "succeeded", toolName: "spartan.invoice.lookup" }),
    ]));

    const direct = await app.executeTool({
      call: { tool_call_id: "direct-call", name: "spartan.invoice.lookup", arguments: { id: "invoice-2" } },
      discovery: { context: { role: "finance" } },
      applicationContext: { companyId: "company-2" },
    });
    expect(direct).toMatchObject({
      status: "completed",
      result: { tool_call_id: "direct-call", name: "spartan.invoice.lookup", is_error: false },
    });
    expect(execute).toHaveBeenLastCalledWith(
      { id: "invoice-2" },
      expect.objectContaining({ toolCallId: "direct-call", applicationContext: { companyId: "company-2" } }),
    );

    const undiscovered = await app.executeTool({
      call: { tool_call_id: "hidden-call", name: "spartan.invoice.lookup", arguments: { id: "invoice-3" } },
      discovery: { context: { role: "viewer" } },
      applicationContext: { companyId: "company-2" },
    });
    expect(undiscovered).toMatchObject({
      status: "completed",
      result: { tool_call_id: "hidden-call", is_error: true },
    });
  });
});
