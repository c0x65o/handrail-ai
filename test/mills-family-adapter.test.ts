import { describe, expect, it, vi } from "vitest";
import { createMillsFamilyPlugin, MILLS_FAMILY_ADAPTER_VERSION } from "../src/adapters/mills-family.js";

const schema = { type: "object", properties: {}, additionalProperties: false } as const;
const signal = new AbortController().signal;

describe("Mills Family checked adapter", () => {
  it("keeps Mills validation and authorization in its runtime and stages mutations as proposals", async () => {
    const execute = vi.fn(async ({ name }: { name: string }) => name === "get_household"
      ? { kind: "read" as const, data: { householdId: "household-1" }, citation: {
        sourceType: "household", sourceId: "household-1", label: "Mills household",
        locator: "/households/household-1",
      } }
      : { kind: "proposal" as const, proposal: { proposalId: "proposal-1", action: "create_task" } });
    const propose = vi.fn(async () => ({ proposalId: "proposal-1" }));
    const plugin = createMillsFamilyPlugin({
      runtime: { definitions: [
        { type: "function", name: "get_household", description: "Read household", parameters: schema },
        { type: "function", name: "create_task", description: "Propose task", parameters: schema },
      ], execute },
      proposalToolNames: ["create_task"],
      propose,
      policy: () => ({ outcome: "allow" }),
      presentationFor: (_name, kind) => ({
        label: kind === "proposal" ? "Task proposal" : "Household",
        rendererKey: kind === "proposal" ? "mills.task.proposal" : "mills.household",
      }),
    });
    const source = await plugin.registrations(undefined);
    const registrations = [];
    for await (const registration of source) registrations.push(registration);
    const read = registrations.find((item) => item.definition.name === "get_household")!;
    const action = registrations.find((item) => item.definition.name === "create_task")!;
    const reportActivity = vi.fn();
    const applicationContext = { session: { userId: "user-1", householdId: "household-1" },
      requestId: "request-1", conversationId: "conversation-1", interaction: "text_chat" as const };

    await expect(read.executor({}, { applicationContext, definition: read.definition,
      signal, toolCallId: "read-1" })).resolves.toEqual(expect.objectContaining({
      type: "handrail.application_tool_output",
      content: { householdId: "household-1" },
      citation_records: expect.objectContaining({ citations: [expect.objectContaining({
        target: { type: "tool_result", tool_call_id: "read-1" },
      })] }),
    }));
    await expect(action.executor({}, { applicationContext, definition: action.definition,
      signal, toolCallId: "action-1", reportActivity })).resolves.toEqual({ proposalId: "proposal-1" });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      session: applicationContext.session, requestId: "request-1", conversationId: "conversation-1",
    }));
    expect(propose).toHaveBeenCalledWith(expect.objectContaining({
      proposal: { proposalId: "proposal-1", action: "create_task" },
      applicationContext, toolName: "create_task", toolCallId: "action-1",
    }));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ reportActivity }));
    expect(plugin.approvals).toEqual([expect.objectContaining({ toolName: "create_task", mode: "never" })]);
    expect(plugin.presentations).toEqual([
      expect.objectContaining({ toolName: "get_household", rendererKey: "mills.household" }),
      expect.objectContaining({ toolName: "create_task", rendererKey: "mills.task.proposal" }),
    ]);
    expect(plugin.adapterVersion).toBe(MILLS_FAMILY_ADAPTER_VERSION);
  });

  it("rejects catalog mismatches and never treats an undisclosed action as executable", async () => {
    expect(() => createMillsFamilyPlugin({
      runtime: { definitions: [], execute: vi.fn() }, proposalToolNames: ["missing"],
      propose: vi.fn(), policy: () => ({ outcome: "allow" }),
    })).toThrow('Unknown Mills proposal tool "missing"');

    const plugin = createMillsFamilyPlugin({
      runtime: { definitions: [{ type: "function", name: "read_only", description: "Read", parameters: schema }],
        execute: async () => ({ kind: "proposal" as const, proposal: { dangerous: true } }) },
      proposalToolNames: [], propose: vi.fn(), policy: () => ({ outcome: "allow" }),
    });
    const source = await plugin.registrations(undefined);
    const registrations = [];
    for await (const registration of source) registrations.push(registration);
    const read = registrations[0]!;
    await expect(read.executor({}, { applicationContext: { session: {} }, definition: read.definition,
      signal, toolCallId: "call-1" })).rejects.toThrow("undisclosed proposal tool");
  });
});
