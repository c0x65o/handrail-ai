import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ProtocolValidationError,
  ToolRegistry,
  type ToolDefinition,
  type ToolDiscoveryAdapter,
  type ToolRegistration,
} from "../src/index.js";

interface DiscoveryContext {
  readonly role: "guest" | "member" | "admin";
}

type Executor = (input: unknown) => Promise<unknown>;

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function registration(
  name: string,
  overrides: Partial<ToolRegistration<Executor, DiscoveryContext>> = {},
): ToolRegistration<Executor, DiscoveryContext> {
  return {
    definition: tool(name),
    executor: async (input) => input,
    ...overrides,
  };
}

describe("ToolRegistry", () => {
  it("rejects duplicate names and keeps deterministic catalog ordering", () => {
    const registry = new ToolRegistry<Executor, DiscoveryContext>();
    registry.register(registration("weather")).register(registration("calendar"));

    expect(registry.list().map(({ name }) => name)).toEqual(["calendar", "weather"]);
    expect(() => registry.register(registration("weather"))).toThrow(
      'Tool "weather" is already registered',
    );
    expect(registry.list().map(({ name }) => name)).toEqual(["calendar", "weather"]);
  });

  it("resolves executors, unregisters tools, and reports missing removals", async () => {
    const executor: Executor = async (input) => ({ input });
    const registry = new ToolRegistry<Executor, DiscoveryContext>();
    registry.register(registration("lookup", { executor }));

    expect(registry.get("lookup")?.executor).toBe(executor);
    expect(await registry.get("lookup")?.executor("value")).toEqual({ input: "value" });
    expect(registry.unregister("lookup")).toBe(true);
    expect(registry.unregister("lookup")).toBe(false);
    expect(registry.get("lookup")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("filters by available capabilities, requested tags, and application context", () => {
    const registry = new ToolRegistry<Executor, DiscoveryContext>();
    registry
      .register(registration("public-search", { tags: ["search"] }))
      .register(
        registration("member-search", {
          tags: ["search", "account"],
          capabilities: ["customer-data"],
          discover: ({ role }) => role !== "guest",
        }),
      )
      .register(
        registration("admin-audit", {
          capabilities: ["customer-data", "audit"],
          discover: ({ role }) => role === "admin",
        }),
      );

    expect(
      registry.discover({ context: { role: "guest" }, tags: ["search"] }).map(({ name }) => name),
    ).toEqual(["public-search"]);
    expect(
      registry
        .discover({
          context: { role: "member" },
          capabilities: ["customer-data"],
          tags: ["search"],
        })
        .map(({ name }) => name),
    ).toEqual(["member-search", "public-search"]);
    expect(
      registry
        .discover({
          context: { role: "admin" },
          capabilities: ["audit", "customer-data"],
        })
        .map(({ name }) => name),
    ).toEqual(["admin-audit", "member-search", "public-search"]);
  });

  it("populates atomically through a provider-neutral discovery adapter", async () => {
    class FakeAdapter implements ToolDiscoveryAdapter<Executor, DiscoveryContext, string> {
      registrations(prefix: string): ToolRegistration<Executor, DiscoveryContext>[] {
        return [registration(`${prefix}-two`), registration(`${prefix}-one`)];
      }
    }

    const registry = new ToolRegistry<Executor, DiscoveryContext>();
    await registry.registerAdapter(new FakeAdapter(), "adapter");

    expect(registry.list().map(({ name }) => name)).toEqual(["adapter-one", "adapter-two"]);

    const duplicateAdapter: ToolDiscoveryAdapter<Executor, DiscoveryContext, undefined> = {
      registrations: () => [registration("new-tool"), registration("adapter-one")],
    };
    await expect(registry.registerAdapter(duplicateAdapter, undefined)).rejects.toThrow(
      'Tool "adapter-one" is already registered',
    );
    expect(registry.get("new-tool")).toBeUndefined();
  });

  it("returns immutable definition snapshots detached from registration inputs", () => {
    const definition = tool("mutable-source");
    const tags = ["search"];
    const registry = new ToolRegistry<Executor, DiscoveryContext>();
    registry.register(registration("ignored", { definition, tags }));

    definition.description = "changed outside";
    definition.input_schema.properties = {};
    tags.push("changed-outside");

    const catalog = registry.list();
    expect(catalog[0]?.description).toBe("mutable-source description");
    expect(catalog[0]?.input_schema.properties).toEqual({ query: { type: "string" } });
    expect(registry.get("mutable-source")?.tags).toEqual(["search"]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[0])).toBe(true);
    expect(Object.isFrozen(catalog[0]?.input_schema)).toBe(true);
    expect(() => (catalog as ToolDefinition[]).push(tool("another"))).toThrow(TypeError);
    expect(() => {
      (catalog[0] as ToolDefinition).description = "mutated";
    }).toThrow(TypeError);
  });

  it("serializes only public definitions from discovery catalogs", () => {
    const executor = Object.assign(async () => undefined, { apiKey: "executor-secret" });
    const providerClient = { token: "provider-secret" };
    const opaqueState = { privateKey: "opaque-secret" };
    const input = {
      ...registration("safe-tool", { executor }),
      credentials: { bearer: "credential-secret" },
      providerClient,
      privateMetadata: opaqueState,
    };
    const registry = new ToolRegistry<Executor, DiscoveryContext>();
    registry.register(input);

    const serialized = JSON.stringify(
      registry.discover({ context: { role: "member" }, capabilities: [] }),
    );
    expect(JSON.parse(serialized)).toEqual([tool("safe-tool")]);
    expect(serialized).not.toContain("executor-secret");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("opaque-secret");
    expect(serialized).not.toContain("credential-secret");
    expect(JSON.stringify(registry.get("safe-tool"))).not.toContain("executor-secret");
  });

  it("reuses protocol ToolDefinition validation", () => {
    const registry = new ToolRegistry<Executor, DiscoveryContext>();
    const invalid = {
      name: "invalid",
      description: "invalid root schema",
      input_schema: { type: "string" },
    };

    expect(() =>
      registry.register({ definition: invalid as unknown as ToolDefinition, executor: async () => null }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      registry.register({ definition: invalid as unknown as ToolDefinition, executor: async () => null }),
    ).toThrow(/\$tool\.input_schema\.type/);
  });

  it("exports the generic public contracts from the package entry point", () => {
    expectTypeOf<ToolRegistry<Executor, DiscoveryContext>>().toBeObject();
    expectTypeOf<ToolRegistration<Executor, DiscoveryContext>["executor"]>().toEqualTypeOf<Executor>();
  });
});
