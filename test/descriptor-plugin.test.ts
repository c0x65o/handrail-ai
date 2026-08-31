import { describe, expect, it, vi } from "vitest";
import {
  BoundedToolExecutor, ToolRegistry, compareToolDiscoveryParity, createDescriptorToolPlugin,
  type ApplicationToolExecutor,
} from "../src/index.js";

interface Actor { readonly companyId: string; readonly role: "admin" | "viewer" }

describe("legacy descriptor plugin adoption", () => {
  it("preserves validation, role discovery, company authorization, and proposal-only actions", async () => {
    const propose = vi.fn(async (input: unknown, context: { applicationContext: Actor }) => ({
      proposalId: "proposal-1", companyId: context.applicationContext.companyId,
      requestedCompanyId: typeof input === "object" && input !== null && "companyId" in input ? String(input.companyId) : "",
    }));
    const plugin = createDescriptorToolPlugin<Actor, Actor>({
      pluginId: "spartan.aegis", version: "1.0.0", displayName: "Aegis",
      descriptors: [{
        kind: "read", name: "get_invoice", description: "Read invoice", inputSchema: { type: "object" },
        parse: (input) => input, available: () => true,
        read: async (_input, context) => ({ companyId: context.applicationContext.companyId }),
      }, {
        kind: "proposal", name: "issue_invoice", description: "Propose issue", inputSchema: {
          type: "object", properties: { companyId: { type: "string" } }, required: ["companyId"], additionalProperties: false,
        },
        parse: (input) => {
          if (typeof input.companyId !== "string") throw new TypeError("Zod validation failed");
          return { companyId: input.companyId };
        },
        available: (actor) => actor.role === "admin",
        propose,
        summarize: () => "Issue invoice proposal",
      }],
      policy: ({ applicationContext, arguments: input }) => input.companyId !== undefined && input.companyId !== applicationContext.companyId
        ? { outcome: "deny" } : { outcome: "allow" },
    });
    const registry = new ToolRegistry<ApplicationToolExecutor<Actor>, Actor>();
    await registry.registerAdapter(plugin, undefined);
    expect(compareToolDiscoveryParity(["get_invoice"], registry.discover({ context: { companyId: "a", role: "viewer" } }))).toEqual({
      matches: true, missing: [], unexpected: [],
    });
    expect(compareToolDiscoveryParity(["get_invoice", "issue_invoice"], registry.discover({ context: { companyId: "a", role: "admin" } })).matches).toBe(true);

    const executor = new BoundedToolExecutor({ registry, policy: plugin.policy!, limits: { maxConcurrency: 1 } });
    const discoveredTools = registry.discover({ context: { companyId: "a", role: "admin" } });
    const denied = await executor.execute({ call: { tool_call_id: "cross-company", name: "issue_invoice", arguments: { companyId: "b" } },
      discoveredTools, applicationContext: { companyId: "a", role: "admin" } });
    expect(denied).toMatchObject({ is_error: true });
    expect(propose).not.toHaveBeenCalled();
    const allowed = await executor.execute({ call: { tool_call_id: "same-company", name: "issue_invoice", arguments: { companyId: "a" } },
      discoveredTools, applicationContext: { companyId: "a", role: "admin" } });
    expect(allowed).toMatchObject({ is_error: false });
    expect(propose).toHaveBeenCalledOnce();
  });
});
