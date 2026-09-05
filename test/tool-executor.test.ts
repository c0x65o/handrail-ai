import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  BoundedToolExecutor,
  CITATION_LIMITS,
  InMemoryToolExecutionLedger,
  ToolRegistry,
  parseChatRequest,
  type ApplicationToolExecutor,
  type ApplicationToolPolicy,
  type ApplicationToolResult,
  type AiDiagnosticEvent,
  type BoundedToolExecutorLimits,
  type ToolDefinition,
} from "../src/index.js";

interface TestContext {
  readonly actor: string;
}

const context: TestContext = { actor: "test-user" };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function definition(name = "lookup"): ToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function assertProtocolResult(result: ApplicationToolResult, tool: ToolDefinition): void {
  const parsed = parseChatRequest({
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    continuation_of: "request_before_tools",
    messages: [{ role: "user", content: [{ type: "text", text: "run the tool" }] }],
    tools: [tool],
    tool_results: [result],
    generation: { max_output_tokens: 100, temperature: 0 },
    correlation_hints: {},
  });
  expect(parsed.tool_results[0]).toBe(result);
  expect(result.content.length).toBeGreaterThan(0);
}

function setup(
  applicationExecutor: ApplicationToolExecutor<TestContext>,
  options: {
    policy?: ApplicationToolPolicy<TestContext>;
    limits?: Partial<BoundedToolExecutorLimits>;
    ledger?: InMemoryToolExecutionLedger;
    name?: string;
    diagnostics?: (event: AiDiagnosticEvent) => void;
  } = {},
) {
  const tool = definition(options.name);
  const registry = new ToolRegistry<ApplicationToolExecutor<TestContext>, undefined>();
  registry.register({ definition: tool, executor: applicationExecutor });
  const policy =
    options.policy ??
    vi.fn<ApplicationToolPolicy<TestContext>>(() => ({
      outcome: "allow",
    }));
  const bounded = new BoundedToolExecutor({
    registry,
    policy,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.ledger === undefined ? {} : { ledger: options.ledger }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });
  const discoveredTools = registry.discover({ context: undefined });
  const execute = (
    toolCallId: string,
    arguments_: unknown = { query: "weather" },
    signal?: AbortSignal,
  ) =>
    bounded.execute({
      call: { tool_call_id: toolCallId, name: tool.name, arguments: arguments_ },
      discoveredTools,
      applicationContext: context,
      ...(signal === undefined ? {} : { signal }),
    });
  return { bounded, discoveredTools, execute, policy, registry, tool };
}

describe("BoundedToolExecutor", () => {
  it("executes a discovered tool and returns a bounded protocol result", async () => {
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(
      async (arguments_, executionContext) => ({
        answer: typeof arguments_.query === "string" ? arguments_.query : "",
        actor: executionContext.applicationContext.actor,
      }),
    );
    const { execute, policy, tool } = setup(applicationExecutor);

    const output = await execute("call_valid");

    expect(output).toEqual({
      tool_call_id: "call_valid",
      name: "lookup",
      content: [{ type: "json", value: { answer: "weather", actor: "test-user" } }],
      is_error: false,
    });
    expect(policy).toHaveBeenCalledOnce();
    expect(applicationExecutor).toHaveBeenCalledOnce();
    expect(applicationExecutor.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    assertProtocolResult(output, tool);
  });

  it("gives long-running tools the trusted host activity reporter", async () => {
    const reportActivity = vi.fn();
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async (_arguments, execution) => {
      await execution.reportActivity?.({ summary: "Reviewing revenue accounts",
        progress: { completed: 18, total: 43, unit: "products" } });
      return { updated: 18 };
    });
    const { bounded, discoveredTools, tool } = setup(applicationExecutor);
    await bounded.execute({ call: { tool_call_id: "call_progress", name: tool.name,
      arguments: { query: "revenue" } }, discoveredTools, applicationContext: context, reportActivity });
    expect(reportActivity).toHaveBeenCalledWith({ summary: "Reviewing revenue accounts",
      progress: { completed: 18, total: 43, unit: "products" } });
  });

  it.each(["completed", "cancelled", "timed_out"])("ignores late progress after a tool is %s", async (terminal) => {
    vi.useFakeTimers();
    try {
      const reportActivity = vi.fn();
      const started = deferred<void>();
      const finish = deferred<void>();
      let report: import("../src/tools/executor.js").ApplicationToolActivityReporter | undefined;
      const { bounded, discoveredTools, tool } = setup(async (_arguments, execution) => {
        report = execution.reportActivity;
        await report?.({ summary: "Updating products" });
        started.resolve();
        await finish.promise;
        return { updated: true };
      });
      const controller = new AbortController();
      const pending = bounded.execute({ call: { tool_call_id: `late-${terminal}`, name: tool.name,
        arguments: { query: "revenue" } }, discoveredTools, applicationContext: context,
        signal: controller.signal, reportActivity });
      await started.promise;
      if (terminal === "completed") finish.resolve();
      else if (terminal === "cancelled") controller.abort();
      else await vi.advanceTimersByTimeAsync(30_001);
      const result = await pending;
      expect(result.is_error).toBe(terminal !== "completed");
      await report?.({ summary: "Stale running update" });
      expect(reportActivity).toHaveBeenCalledOnce();
      finish.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a progress delivery failure without failing a successful mutation", async () => {
    const diagnostics = vi.fn();
    const { bounded, discoveredTools, tool } = setup(async (_arguments, execution) => {
      await execution.reportActivity?.({ summary: "Products updated" });
      return { updated: true };
    }, { diagnostics });
    const result = await bounded.execute({ call: { tool_call_id: "failed-progress", name: tool.name,
      arguments: { query: "revenue" } }, discoveredTools, applicationContext: context,
      reportActivity: async () => { throw new Error("Activity store unavailable"); } });
    expect(result.is_error).toBe(false);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      domain: "activity", code: "activity_update_failed" }));
  });

  it("normalizes and stably deduplicates an explicit trusted citation projection", async () => {
    const source = {
      source_id: "source_weather",
      type: "web" as const,
      label: "Weather source",
      locator: "https://example.com/weather",
    };
    const citation = {
      citation_id: "citation_weather",
      source_id: "source_weather",
      order: 0,
      target: { type: "tool_result" as const, tool_call_id: "call_cited" },
    };
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async () => ({
      type: "handrail.application_tool_output",
      content: { forecast: "sunny" },
      citation_records: {
        sources: [source, { ...source }],
        citations: [citation, { ...citation, target: { ...citation.target } }],
      },
    }));
    const { execute, tool } = setup(applicationExecutor);

    const output = await execute("call_cited");
    const retry = await execute("call_cited");

    expect(output).toEqual({
      tool_call_id: "call_cited",
      name: "lookup",
      content: [{ type: "json", value: { forecast: "sunny" } }],
      is_error: false,
      citation_records: {
        sources: [source],
        citations: [citation],
      },
    });
    expect(retry).toBe(output);
    expect(applicationExecutor).toHaveBeenCalledOnce();
    expect(Object.isFrozen(output.citation_records)).toBe(true);
    assertProtocolResult(output, tool);
  });

  it("does not treat citations embedded in ordinary JSON output as authoritative", async () => {
    const { execute } = setup(async () => ({
      citations: [{ provider_native: true }],
      value: "ordinary content",
    }));

    const output = await execute("call_ordinary_json");

    expect(output).not.toHaveProperty("citation_records");
    expect(output.content).toEqual([{
      type: "json",
      value: { citations: [{ provider_native: true }], value: "ordinary content" },
    }]);
  });

  it("converts malformed, unsafe, mismatched, provider-native, and oversized citations to one safe error", async () => {
    const validCitation = {
      citation_id: "citation_1",
      source_id: "source_1",
      order: 0,
      target: { type: "tool_result", tool_call_id: "call_invalid_citations" },
    };
    const cases: readonly unknown[] = [
      { sources: [], citations: "not-an-array" },
      {
        sources: [{
          source_id: "source_1",
          type: "web",
          label: "Private",
          locator: "http://127.0.0.1/private",
        }],
        citations: [validCitation],
      },
      {
        sources: [{
          source_id: "source_1",
          type: "web",
          label: "Native",
          provider_payload: { annotation: "private provider data" },
        }],
        citations: [validCitation],
      },
      {
        sources: [{ source_id: "source_1", type: "tool", label: "Mismatch" }],
        citations: [{
          ...validCitation,
          target: { type: "tool_result", tool_call_id: "call_other" },
        }],
      },
      {
        sources: Array.from(
          { length: CITATION_LIMITS.sourcesPerRecordSet + 1 },
          (_, index) => ({
            source_id: `source_${index}`,
            type: "tool",
            label: `Source ${index}`,
          }),
        ),
        citations: [validCitation],
      },
      {
        sources: Array.from({ length: CITATION_LIMITS.sourcesPerRecordSet }, (_, index) => ({
          source_id: `source_${index}`,
          type: "web",
          label: "x".repeat(CITATION_LIMITS.labelLength),
          locator: `https://example.com/${"a".repeat(1_980)}${index}`,
        })),
        citations: Array.from(
          { length: CITATION_LIMITS.citationsPerRecordSet },
          (_, index) => ({
            citation_id: `citation_${index}`,
            source_id: `source_${index % CITATION_LIMITS.sourcesPerRecordSet}`,
            order: index,
            target: { type: "tool_result", tool_call_id: "call_invalid_citations" },
          }),
        ),
      },
    ];

    for (const [index, citationRecords] of cases.entries()) {
      const { execute } = setup(async () => ({
        type: "handrail.application_tool_output",
        content: "private content must not leak",
        citation_records: citationRecords,
      } as never));
      const output = await execute("call_invalid_citations");
      expect(output, `case ${index}`).toEqual({
        tool_call_id: "call_invalid_citations",
        name: "lookup",
        content: [{ type: "text", text: "Tool returned an invalid or unsafe result." }],
        is_error: true,
      });
      expect(JSON.stringify(output)).not.toContain("private");
    }
  });

  it("rejects unknown and undiscovered tools before policy or execution", async () => {
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async () => "unused");
    const { bounded, policy, tool } = setup(applicationExecutor);

    const undiscovered = await bounded.execute({
      call: { tool_call_id: "call_undiscovered", name: tool.name, arguments: { query: "x" } },
      discoveredTools: [],
      applicationContext: context,
    });
    const unknownTool = definition("missing");
    const unknown = await bounded.execute({
      call: { tool_call_id: "call_unknown", name: "missing", arguments: { query: "x" } },
      discoveredTools: [unknownTool],
      applicationContext: context,
    });

    expect(undiscovered.is_error).toBe(true);
    expect(unknown.is_error).toBe(true);
    expect(undiscovered.content).toEqual([
      { type: "text", text: "Tool is unavailable for this call." },
    ]);
    expect(policy).not.toHaveBeenCalled();
    expect(applicationExecutor).not.toHaveBeenCalled();
    assertProtocolResult(undiscovered, tool);
    assertProtocolResult(unknown, unknownTool);
  });

  it("validates arguments against the registered JSON Schema before authorization", async () => {
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async () => "unused");
    const { execute, policy, tool } = setup(applicationExecutor);

    const output = await execute("call_invalid_arguments", { query: 42 });

    expect(output.content).toEqual([
      { type: "text", text: "Tool arguments did not match the declared schema." },
    ]);
    expect(output.is_error).toBe(true);
    expect(policy).not.toHaveBeenCalled();
    expect(applicationExecutor).not.toHaveBeenCalled();
    assertProtocolResult(output, tool);
  });

  it("uses application policy as the authorization boundary for denial", async () => {
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async () => "unused");
    const policy = vi.fn<ApplicationToolPolicy<TestContext>>(() => ({ outcome: "deny" }));
    const { execute, tool } = setup(applicationExecutor, { policy });

    const output = await execute("call_denied");

    expect(policy).toHaveBeenCalledOnce();
    expect(policy.mock.calls[0]?.[0].arguments).toEqual({ query: "weather" });
    expect(applicationExecutor).not.toHaveBeenCalled();
    expect(output.content).toEqual([
      { type: "text", text: "Tool execution was denied by application policy." },
    ]);
    assertProtocolResult(output, tool);
  });

  it("diagnoses disclosure, validation, and policy failures without arguments", async () => {
    const diagnostics: AiDiagnosticEvent[] = [];
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async () => "unused");
    const policy = vi.fn<ApplicationToolPolicy<TestContext>>(() => ({ outcome: "deny" }));
    const { bounded, discoveredTools, tool } = setup(applicationExecutor, {
      policy,
      diagnostics: (event) => diagnostics.push(event),
    });

    await bounded.execute({
      call: { tool_call_id: "call_hidden", name: tool.name, arguments: { query: "secret prompt" } },
      discoveredTools: [],
      applicationContext: context,
    });
    await bounded.execute({
      call: { tool_call_id: "call_invalid", name: tool.name, arguments: { query: 42 } },
      discoveredTools,
      applicationContext: context,
    });
    await bounded.execute({
      call: { tool_call_id: "call_denied_safe", name: tool.name, arguments: { query: "secret prompt" } },
      discoveredTools,
      applicationContext: context,
    });

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "validation", code: "tool_unavailable", toolCallId: "call_hidden" }),
      expect.objectContaining({ domain: "validation", code: "invalid_arguments", toolCallId: "call_invalid" }),
      expect.objectContaining({ domain: "policy", code: "policy_denied", toolCallId: "call_denied_safe" }),
    ]));
    expect(JSON.stringify(diagnostics)).not.toContain("secret prompt");
  });

  it("pauses external-approval-required calls without invoking the tool", async () => {
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async () => "unused");
    const policy = vi.fn<ApplicationToolPolicy<TestContext>>(() => ({
      outcome: "external_approval_required",
    }));
    const { execute, tool } = setup(applicationExecutor, { policy });

    const output = await execute("call_approval");

    expect(policy).toHaveBeenCalledOnce();
    expect(applicationExecutor).not.toHaveBeenCalled();
    expect(output.content).toEqual([
      { type: "text", text: "Tool execution requires external approval." },
    ]);
    assertProtocolResult(output, tool);
  });

  it("times out, aborts the application signal, and returns without exposing internals", async () => {
    let applicationSignal: AbortSignal | undefined;
    const applicationExecutor: ApplicationToolExecutor<TestContext> = async (_, executionContext) => {
      applicationSignal = executionContext.signal;
      return await new Promise(() => undefined);
    };
    const { execute, tool } = setup(applicationExecutor, { limits: { timeoutMs: 10 } });

    const output = await execute("call_timeout");

    expect(applicationSignal?.aborted).toBe(true);
    expect(output.content).toEqual([{ type: "text", text: "Tool execution timed out." }]);
    assertProtocolResult(output, tool);
  });

  it("honors caller cancellation and propagates it to the application executor", async () => {
    let applicationSignal: AbortSignal | undefined;
    const started = deferred<void>();
    const applicationExecutor: ApplicationToolExecutor<TestContext> = async (_, executionContext) => {
      applicationSignal = executionContext.signal;
      started.resolve(undefined);
      return await new Promise(() => undefined);
    };
    const abort = new AbortController();
    const { execute, tool } = setup(applicationExecutor);

    const pending = execute("call_abort", { query: "x" }, abort.signal);
    await started.promise;
    abort.abort(new Error("private cancellation detail"));
    const output = await pending;

    expect(applicationSignal?.aborted).toBe(true);
    expect(output.content).toEqual([{ type: "text", text: "Tool execution was cancelled." }]);
    expect(JSON.stringify(output)).not.toContain("private cancellation detail");
    assertProtocolResult(output, tool);
  });

  it("never exceeds the configured application-tool concurrency", async () => {
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const applicationExecutor: ApplicationToolExecutor<TestContext> = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve();
        });
      });
      return "done";
    };
    const { execute, tool } = setup(applicationExecutor, { limits: { maxConcurrency: 2 } });

    const pending = [1, 2, 3, 4].map((index) => execute(`call_concurrency_${index}`));
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0, 2).forEach((release) => release());
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases.splice(0, 2).forEach((release) => release());
    const outputs = await Promise.all(pending);

    expect(maximum).toBe(2);
    outputs.forEach((output) => assertProtocolResult(output, tool));
  });

  it("rejects oversized, deeply nested, circular, credential, and native-client output", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const cases: Array<{ id: string; output: unknown; limits?: Partial<BoundedToolExecutorLimits> }> = [
      { id: "oversized", output: "x".repeat(500), limits: { maxResultBytes: 100 } },
      { id: "deep", output: { one: { two: { three: true } } }, limits: { maxResultDepth: 3 } },
      { id: "circular", output: circular },
      { id: "credential", output: { api_key: "sk-secretvalue123" } },
      { id: "native", output: { client: { endpoint: "private" } } },
    ];

    for (const testCase of cases) {
      const applicationExecutor = async () => testCase.output as never;
      const { execute, tool } = setup(applicationExecutor, {
        ...(testCase.limits === undefined ? {} : { limits: testCase.limits }),
      });
      const output = await execute(`call_${testCase.id}`);
      expect(output.content, testCase.id).toEqual([
        { type: "text", text: "Tool returned an invalid or unsafe result." },
      ]);
      expect(JSON.stringify(output)).not.toContain("secretvalue");
      assertProtocolResult(output, tool);
    }
  });

  it("redacts thrown secret-bearing errors and arbitrary error properties", async () => {
    const applicationExecutor: ApplicationToolExecutor<TestContext> = async () => {
      throw Object.assign(new Error("Bearer secret-token-value"), {
        apiKey: "sk-secretvalue123",
        nativeClient: { token: "also-private" },
      });
    };
    const { execute, tool } = setup(applicationExecutor);

    const output = await execute("call_throw");
    const serialized = JSON.stringify(output);

    expect(output.content).toEqual([{ type: "text", text: "Tool execution failed." }]);
    expect(serialized).not.toContain("secret-token-value");
    expect(serialized).not.toContain("secretvalue");
    expect(serialized).not.toContain("also-private");
    expect(serialized).not.toContain("stack");
    assertProtocolResult(output, tool);
  });

  it("suppresses concurrent and completed duplicate tool_call_id execution", async () => {
    const completion = deferred<string>();
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(
      async () => completion.promise,
    );
    const ledger = new InMemoryToolExecutionLedger();
    const { execute, policy, tool } = setup(applicationExecutor, { ledger });

    const first = execute("call_duplicate");
    const concurrent = execute("call_duplicate");
    await vi.waitFor(() => expect(applicationExecutor).toHaveBeenCalledOnce());
    completion.resolve("cached");
    const [firstOutput, concurrentOutput] = await Promise.all([first, concurrent]);
    const completedOutput = await execute("call_duplicate");

    expect(applicationExecutor).toHaveBeenCalledOnce();
    expect(policy).toHaveBeenCalledOnce();
    expect(concurrentOutput).toBe(firstOutput);
    expect(completedOutput).toBe(firstOutput);
    assertProtocolResult(firstOutput, tool);
  });

  it("rejects changed arguments during execution and after result reuse across executor instances", async () => {
    const completion = deferred<string>();
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async () => completion.promise);
    const ledger = new InMemoryToolExecutionLedger();
    const first = setup(applicationExecutor, { ledger });
    const pending = first.execute("bound", { query: "original" });
    await vi.waitFor(() => expect(applicationExecutor).toHaveBeenCalledOnce());
    expect((await first.execute("bound", { query: "changed" })).is_error).toBe(true);
    completion.resolve("original result");
    const result = await pending;
    const second = setup(applicationExecutor, { ledger });
    expect(await second.execute("bound", { query: "original" })).toBe(result);
    expect((await second.execute("bound", { query: "changed" })).is_error).toBe(true);
    const renamed = setup(applicationExecutor, { ledger, name: "different_tool" });
    expect((await renamed.execute("bound", { query: "original" })).is_error).toBe(true);
    expect(applicationExecutor).toHaveBeenCalledOnce();
  });

  it("does not alias an oversized call ID to a previously completed prefix", async () => {
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async () => "result");
    const { execute } = setup(applicationExecutor);
    const prefix = "c".repeat(256);
    expect((await execute(prefix)).is_error).toBe(false);
    expect((await execute(`${prefix}different`)).is_error).toBe(true);
    expect(applicationExecutor).toHaveBeenCalledOnce();
  });

  it("snapshots the request before asynchronous authorization", async () => {
    const allow = deferred<void>();
    const applicationExecutor = vi.fn<ApplicationToolExecutor<TestContext>>(async (arguments_) => arguments_.query as string);
    const { execute } = setup(applicationExecutor, { policy: async () => { await allow.promise; return { outcome: "allow" }; } });
    const arguments_ = { query: "original" };
    const pending = execute("snapshot", arguments_);
    arguments_.query = "changed while authorizing";
    allow.resolve();
    const result = await pending;
    expect(result.is_error).toBe(false);
    expect(applicationExecutor.mock.calls[0]?.[0]).toEqual({ query: "original" });
    expect((await execute("snapshot", arguments_)).is_error).toBe(true);
  });

  it("treats JSON property ordering as the same request but preserves array ordering", async () => {
    const registry = new ToolRegistry<ApplicationToolExecutor<TestContext>, undefined>();
    const execute = vi.fn<ApplicationToolExecutor<TestContext>>(async () => "result");
    const tool: ToolDefinition = { name: "structured", description: "structured input",
      input_schema: { type: "object", additionalProperties: true } };
    registry.register({ definition: tool, executor: execute });
    const bounded = new BoundedToolExecutor({ registry, policy: () => ({ outcome: "allow" }) });
    const call = (arguments_: unknown) => bounded.execute({
      call: { tool_call_id: "structured", name: tool.name, arguments: arguments_ },
      discoveredTools: registry.discover({ context: undefined }), applicationContext: context,
    });
    const result = await call({ rows: [1, 2], nested: { a: 1, b: 2 } });
    expect(await call({ nested: { b: 2, a: 1 }, rows: [1, 2] })).toBe(result);
    expect((await call({ rows: [2, 1], nested: { a: 1, b: 2 } })).is_error).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("exports the public executor, policy, ledger, call, and limit contracts", () => {
    expectTypeOf<BoundedToolExecutor<TestContext>>().toBeObject();
    expectTypeOf<InMemoryToolExecutionLedger>().toMatchTypeOf<{
      getOrCreate: (
        id: string,
        execute: () => Promise<ApplicationToolResult>,
      ) => Promise<ApplicationToolResult>;
    }>();
  });
});
