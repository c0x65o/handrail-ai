import { describe, expect, it, vi } from "vitest";
import { createSpartanAegisRegistrations, SPARTAN_AEGIS_TOOL_LOOP_LIMITS } from "../examples/spartan-aegis-adapter.js";

const schema = { type: "object" as const, properties: {}, additionalProperties: false };

describe("Spartan Aegis checked adapter", () => {
  it("keeps reads executable and actions behind Spartan validation plus confirmation", async () => {
    const validate = vi.fn(() => ({}));
    const execute = vi.fn(async () => ({ posted: true }));
    const actor = { companyId: "company-1" };
    const bridge = createSpartanAegisRegistrations({
      actor,
      readDefinitions: [{ name: "get_invoices", description: "Read invoices", parameters: schema }],
      runReadTool: async () => ({ invoices: [] }),
      actionRegistry: {
        catalogFunctions: () => [{ name: "propose_invoice", description: "Propose invoice", parameters: schema }],
        validate,
        summarizeForActor: async () => "Create invoice",
        execute,
      },
      actionExecutionContext: { requestId: "request-1" },
    });
    expect(bridge.registrations.map((item) => item.definition.name)).toEqual([
      "get_invoices", "propose_invoice",
    ]);
    expect(await bridge.policy({ applicationContext: actor, arguments: {},
      definition: bridge.registrations[0]!.definition, signal: new AbortController().signal,
      toolCallId: "read-1" })).toEqual({ outcome: "allow" });
    expect(await bridge.policy({ applicationContext: actor, arguments: {},
      definition: bridge.registrations[1]!.definition, signal: new AbortController().signal,
      toolCallId: "action-1" })).toEqual({ outcome: "external_approval_required" });
    expect(validate).toHaveBeenCalledWith("propose_invoice", {});
    expect(execute).not.toHaveBeenCalled();
    expect(SPARTAN_AEGIS_TOOL_LOOP_LIMITS.maxTotalToolCalls).toBe(8);
  });
});
