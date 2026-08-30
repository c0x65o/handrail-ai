import { describe, expect, it } from "vitest";

import {
  createDeferredToolDiscoveryPlan,
  findDeferredTool,
  findDeferredToolNamespace,
  type ToolDefinition,
} from "../src/index.js";

const tool = (name: string): ToolDefinition => ({
  name,
  description: `Tool ${name}`,
  input_schema: { type: "object", properties: {}, additionalProperties: false },
});

describe("deferred tool discovery", () => {
  it("keeps a large actor-filtered catalog deferred by stable namespaces", () => {
    const tools = Array.from({ length: 89 }, (_, index) => tool(`erp_tool_${index}`));
    const plan = createDeferredToolDiscoveryPlan({
      tools,
      namespaces: Array.from({ length: 9 }, (_, namespaceIndex) => ({
        name: `erp_${namespaceIndex}`,
        description: `ERP namespace ${namespaceIndex}`,
        toolNames: tools
          .slice(namespaceIndex * 10, Math.min((namespaceIndex + 1) * 10, tools.length))
          .map((item) => item.name),
      })),
      includeUnassigned: false,
    });

    expect(plan.toolCount).toBe(89);
    expect(plan.eagerTools).toHaveLength(0);
    expect(findDeferredToolNamespace(plan, "erp_8")?.tools).toHaveLength(9);
    expect(findDeferredTool(plan, "erp_tool_88")?.name).toBe("erp_tool_88");
  });

  it("rejects namespace references that are not in the filtered catalog", () => {
    expect(() => createDeferredToolDiscoveryPlan({
      tools: [tool("allowed")],
      namespaces: [{
        name: "private_tools",
        description: "Private tools",
        toolNames: ["not_authorized"],
      }],
    })).toThrow(/undiscovered tool/u);
  });

  it("bounds eager fallback projection", () => {
    expect(() => createDeferredToolDiscoveryPlan({
      tools: [tool("one"), tool("two")],
      namespaces: [],
      maximumEagerTools: 1,
    })).toThrow(/maximumEagerTools/u);
  });
});
