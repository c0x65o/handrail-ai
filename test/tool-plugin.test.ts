import { describe, expect, it, vi } from "vitest";

import {
  TOOL_PLUGIN_CONTRACT_VERSION,
  ToolPluginRegistry,
  ToolRegistry,
  createToolPlugin,
  type ApplicationToolExecutor,
} from "../src/index.js";

const definition = {
  name: "lookup_customer",
  description: "Look up one customer",
  input_schema: {
    type: "object" as const,
    properties: { customerId: { type: "string" } },
    required: ["customerId"],
    additionalProperties: false,
  },
};

describe("tool plugins", () => {
  it("installs a versioned plugin into the existing ToolRegistry seam", async () => {
    const executor = vi.fn<ApplicationToolExecutor>();
    const plugin = createToolPlugin({
      pluginId: "spartan.erp",
      version: "1.2.3",
      displayName: "Spartan ERP",
      registrations: [{ definition, executor, tags: ["customers"] }],
      approvals: [{
        toolName: "lookup_customer",
        mode: "never",
        summarize: () => "Read one customer",
      }],
      presentations: [{
        toolName: "lookup_customer",
        label: "Customer",
        rendererKey: "spartan.customer-card",
      }],
    });
    expect(plugin).toMatchObject({
      contractVersion: TOOL_PLUGIN_CONTRACT_VERSION,
      identity: "spartan.erp@1.2.3",
    });

    const plugins = new ToolPluginRegistry<ApplicationToolExecutor, { actor: string }, void>();
    plugins.register(plugin);
    const tools = new ToolRegistry<ApplicationToolExecutor, { actor: string }>();
    await tools.registerAdapter(plugins.asDiscoveryAdapter(), undefined);

    expect(tools.discover({ context: { actor: "principal-1" }, tags: ["customers"] }))
      .toEqual([definition]);
    expect(plugins.list()).toEqual([plugin]);
  });

  it("loads context-dependent plugin registrations and rejects duplicate tool names", async () => {
    const first = createToolPlugin<ApplicationToolExecutor, unknown, string>({
      pluginId: "example.first",
      version: "1.0.0",
      displayName: "First",
      registrations: (tenant) => [{
        definition: { ...definition, description: `Tenant ${tenant}` },
        executor: async () => null,
      }],
    });
    const second = createToolPlugin({
      pluginId: "example.second",
      version: "1.0.0",
      displayName: "Second",
      registrations: [{ definition, executor: async () => null }],
    });
    const plugins = new ToolPluginRegistry<ApplicationToolExecutor, unknown, string>();
    plugins.register(first).register(second);
    const tools = new ToolRegistry<ApplicationToolExecutor>();
    await expect(tools.registerAdapter(plugins.asDiscoveryAdapter(), "tenant-a"))
      .rejects.toThrow(/Duplicate plugin tool/u);
  });

  it("rejects invalid identities and presentation references", () => {
    expect(() => createToolPlugin({
      pluginId: "Invalid Plugin",
      version: "1.0.0",
      displayName: "Invalid",
      registrations: [],
    })).toThrow(/pluginId/u);
    expect(() => createToolPlugin({
      pluginId: "valid.plugin",
      version: "1.0.0",
      displayName: "Valid",
      registrations: [{ definition, executor: async () => null }],
      presentations: [{
        toolName: "missing_tool",
        label: "Missing",
        rendererKey: "missing",
      }],
    })).toThrow(/unregistered tool/u);
  });
});
