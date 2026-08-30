import { describe, expect, it, vi } from "vitest";

import {
  BoundedToolExecutor,
  ToolRegistry,
  WEB_SEARCH_LIMITS,
  WebSearchError,
  WebSearchService,
  createWebSearchCitationRecords,
  createWebSearchToolRegistration,
  type ApplicationToolExecutor,
  type WebSearchAdapter,
  type WebSearchExecutionContext,
  type WebSearchUrlPolicyInput,
} from "../src/index.js";

interface TestContext {
  readonly accountId: string;
}

const NOW = 1_000_000;

function executionContext(
  signal: AbortSignal = new AbortController().signal,
  deadlineAt = NOW + 1_000,
): WebSearchExecutionContext<TestContext> {
  return {
    applicationContext: { accountId: "account_1" },
    signal,
    deadlineAt,
  };
}

function input(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query: "bounded web search",
    max_results: 5,
    idempotency_key: "search-key-1",
    ...overrides,
  };
}

function adapterResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_id: "source_1",
    title: "Result one",
    snippet: "A bounded provider-neutral result.",
    url: "https://example.com/result",
    ...overrides,
  };
}

function setup(
  adapter: WebSearchAdapter = { search: vi.fn(async () => ({ results: [adapterResult()] })) },
  overrides: Partial<ConstructorParameters<typeof WebSearchService<TestContext>>[0]> = {},
) {
  const authorize = vi.fn(async () => true);
  const validateUrl = vi.fn(async () => true);
  const acceptResult = vi.fn(async () => true);
  const service = new WebSearchService<TestContext>({
    adapter,
    authorize,
    validateUrl,
    acceptResult,
    now: () => NOW,
    ...overrides,
  });
  return { service, authorize, validateUrl, acceptResult };
}

async function expectCode(operation: Promise<unknown>, code: string): Promise<WebSearchError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(WebSearchError);
    expect(error).toMatchObject({ code });
    return error as WebSearchError;
  }
  throw new Error("Expected web search to fail");
}

describe("WebSearchService", () => {
  it("canonicalizes, validates, deduplicates by URL and source ID, and retains first-seen order", async () => {
    const adapter: WebSearchAdapter = {
      search: vi.fn(async () => ({
        results: [
          adapterResult({
            source_id: "first",
            title: " First result ",
            url: "HTTPS://EXAMPLE.COM:443/path?z=2&a=1#section",
          }),
          adapterResult({ source_id: "duplicate-url", url: "https://example.com/path?a=1&z=2" }),
          adapterResult({ source_id: "first", url: "https://other.example/item" }),
          adapterResult({
            source_id: "redirected",
            title: "Redirected result",
            url: "https://start.example/item",
            redirect_urls: [
              "https://middle.example/item",
              "https://FINAL.example:443/item#ignored",
            ],
          }),
        ],
      })),
    };
    const { service, validateUrl, acceptResult } = setup(adapter);

    const output = await service.search(input(), executionContext());

    expect(output.results).toEqual([
      {
        source_id: "first",
        title: "First result",
        snippet: "A bounded provider-neutral result.",
        url: "https://example.com/path?a=1&z=2",
      },
      {
        source_id: "redirected",
        title: "Redirected result",
        snippet: "A bounded provider-neutral result.",
        url: "https://final.example/item",
        redirect_urls: [
          "https://middle.example/item",
          "https://final.example/item",
        ],
      },
    ]);
    expect(output.sources).toEqual([
      { source_id: "first", type: "web", label: "First result", locator: output.results[0]?.url },
      {
        source_id: "redirected",
        type: "web",
        label: "Redirected result",
        locator: output.results[1]?.url,
      },
    ]);
    expect(validateUrl).toHaveBeenCalledTimes(6);
    expect(acceptResult).toHaveBeenCalledTimes(4);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.results)).toBe(true);
    expect(Object.keys(output.results[0] ?? {})).toEqual(["source_id", "title", "snippet", "url"]);
  });

  it("projects accepted sources into shared citation records in stable order", async () => {
    const { service } = setup({
      search: async () => ({
        results: [adapterResult(), adapterResult({ source_id: "source_2", url: "https://two.example" })],
      }),
    });
    const output = await service.search(input(), executionContext());
    const records = createWebSearchCitationRecords(output, {
      type: "tool_result",
      tool_call_id: "call_search" as never,
    });

    expect(records.citations.map(({ citation_id, source_id, order }) => ({
      citation_id,
      source_id,
      order,
    }))).toEqual([
      { citation_id: "web_search:source_1", source_id: "source_1", order: 0 },
      { citation_id: "web_search:source_2", source_id: "source_2", order: 1 },
    ]);
  });

  it.each([
    ["unsafe scheme", "javascript:alert(1)"],
    ["userinfo", "https://user:password@example.com"],
    ["credential query", "https://example.com/?access_token=secret-value"],
    ["localhost", "http://service.localhost/path"],
    ["private IPv4", "http://10.1.2.3/path"],
    ["loopback IPv4", "http://127.0.0.1/path"],
    ["loopback IPv6", "http://[::1]/path"],
    ["private IPv6", "http://[fc00::1]/path"],
    ["non-public IPv6", "http://[2001:db8::1]/path"],
    ["malformed URL", "not a URL"],
  ])("rejects %s adapter URLs before host acceptance", async (_label, url) => {
    const { service, validateUrl } = setup({
      search: async () => ({ results: [adapterResult({ url })] }),
    });
    await expectCode(service.search(input(), executionContext()), "invalid_response");
    expect(validateUrl).not.toHaveBeenCalled();
  });

  it("requires host validation for the original URL, every redirect, and DNS-resolved targets", async () => {
    const validateUrl = vi.fn(async ({ url }: WebSearchUrlPolicyInput<TestContext>) =>
      url !== "https://blocked.example/final"
    );
    const adapter = { search: vi.fn(async () => ({ results: [adapterResult({
      url: "https://public-name.example/start",
      redirect_urls: ["https://allowed.example/middle", "https://blocked.example/final"],
    })] })) };
    const { service, acceptResult } = setup(adapter, { validateUrl });

    await expectCode(service.search(input(), executionContext()), "result_denied");
    expect(validateUrl.mock.calls.map(([call]) => [call.purpose, call.url])).toEqual([
      ["result", "https://public-name.example/start"],
      ["redirect", "https://allowed.example/middle"],
      ["redirect", "https://blocked.example/final"],
    ]);
    expect(acceptResult).not.toHaveBeenCalled();
  });

  it.each([
    ["oversized query", input({ query: "x".repeat(WEB_SEARCH_LIMITS.queryUtf8Bytes + 1) })],
    ["oversized request count", input({ max_results: WEB_SEARCH_LIMITS.requestedResults + 1 })],
    ["missing idempotency key", { query: "search", max_results: 1 }],
    ["extra request field", input({ provider: "native" })],
    ["non-plain request", Object.assign(Object.create({ inherited: true }), input())],
  ])("rejects %s before authorization", async (_label, request) => {
    const { service, authorize } = setup();
    await expectCode(service.search(request, executionContext()), "invalid_request");
    expect(authorize).not.toHaveBeenCalled();
  });

  it.each([
    ["provider-only field", adapterResult({ provider_rank: 1 })],
    ["oversized title", adapterResult({ title: "x".repeat(WEB_SEARCH_LIMITS.titleUtf8Bytes + 1) })],
    ["oversized snippet", adapterResult({ snippet: "x".repeat(WEB_SEARCH_LIMITS.snippetUtf8Bytes + 1) })],
    ["oversized URL", adapterResult({ url: `https://example.com/${"x".repeat(WEB_SEARCH_LIMITS.urlUtf8Bytes)}` })],
    ["malformed result", { source_id: "source_1", title: "missing fields" }],
  ])("rejects %s without exposing adapter material", async (_label, result) => {
    const { service } = setup({ search: async () => ({ results: [result] }) });
    const error = await expectCode(service.search(input(), executionContext()), "invalid_response");
    const serialized = JSON.stringify(error);
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects raw response envelopes without retaining or exposing them", async () => {
    const { service } = setup({
      search: async () => ({ results: [adapterResult()], raw_response: "private raw material" }),
    });
    const error = await expectCode(service.search(input(), executionContext()), "invalid_response");
    expect(JSON.stringify(error)).not.toContain("private raw material");
    expect(JSON.stringify(error)).not.toContain("raw_response");
    expect(error).not.toHaveProperty("cause");
  });

  it("rejects oversized result arrays and total serialized output", async () => {
    const tooMany = Array.from(
      { length: WEB_SEARCH_LIMITS.adapterResults + 1 },
      (_, index) => adapterResult({ source_id: `source_${index}`, url: `https://${index}.example.com` }),
    );
    const first = setup({ search: async () => ({ results: tooMany }) });
    await expectCode(first.service.search(input(), executionContext()), "invalid_response");

    const second = setup(
      { search: async () => ({ results: [adapterResult({ snippet: "x".repeat(100) })] }) },
      { limits: { totalSerializedUtf8Bytes: 64 } },
    );
    await expectCode(second.service.search(input({ idempotency_key: "size-key" }), executionContext()), "invalid_response");
  });

  it("denies authorization before adapter execution", async () => {
    const adapter = { search: vi.fn(async () => ({ results: [] })) };
    const authorize = vi.fn(async () => false);
    const { service } = setup(adapter, { authorize });

    await expectCode(service.search(input(), executionContext()), "authorization_denied");
    expect(authorize).toHaveBeenCalledOnce();
    expect(adapter.search).not.toHaveBeenCalled();
  });

  it("maps authorization, policy, and adapter failures to safe public errors", async () => {
    const secret = { raw_response: "raw-secret", provider_client: { token: "sdk-secret" } };
    const authorization = setup(undefined, { authorize: async () => { throw secret; } });
    const authError = await expectCode(
      authorization.service.search(input({ idempotency_key: "auth-fail" }), executionContext()),
      "authorization_unavailable",
    );
    expect(JSON.stringify(authError)).not.toContain("secret");

    const adapter = setup({ search: async () => { throw Object.assign(new Error("secret"), secret); } });
    const adapterError = await expectCode(
      adapter.service.search(input({
        query: "confidential merger details",
        idempotency_key: "adapter-fail",
      }), executionContext()),
      "adapter_unavailable",
    );
    expect(adapterError).not.toHaveProperty("cause");
    expect(JSON.stringify(adapterError)).not.toContain("secret");
    expect(JSON.stringify(adapterError)).not.toContain("confidential merger details");

    const policy = setup(undefined, { acceptResult: async () => { throw secret; } });
    await expectCode(
      policy.service.search(input({ idempotency_key: "policy-fail" }), executionContext()),
      "policy_unavailable",
    );
  });

  it("composes caller cancellation and the bounded deadline", async () => {
    const started = vi.fn();
    const adapter: WebSearchAdapter = {
      search: ({ signal }) => new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(new Error("private abort reason")), { once: true });
      }),
    };
    const cancelled = setup(adapter);
    const caller = new AbortController();
    const cancelledOperation = cancelled.service.search(
      input({ idempotency_key: "cancel-key" }),
      executionContext(caller.signal),
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    caller.abort("private caller reason");
    await expectCode(cancelledOperation, "cancelled");

    const timed = setup(adapter, { limits: { timeoutMs: 25 } });
    await expectCode(
      timed.service.search(
        input({ idempotency_key: "timeout-key" }),
        executionContext(new AbortController().signal, NOW + 10),
      ),
      "timeout",
    );
  });

  it("coalesces concurrent and retry calls while rejecting conflicting key reuse", async () => {
    let release: ((value: unknown) => void) | undefined;
    const adapter = { search: vi.fn(() => new Promise((resolve) => { release = resolve; })) };
    const { service, authorize } = setup(adapter);
    const first = service.search(input(), executionContext());
    const concurrent = service.search(input(), executionContext());
    await vi.waitFor(() => expect(adapter.search).toHaveBeenCalledOnce());
    release?.({ results: [adapterResult()] });

    const [firstOutput, concurrentOutput] = await Promise.all([first, concurrent]);
    const retry = await service.search(input(), executionContext());
    expect(concurrentOutput).toBe(firstOutput);
    expect(retry).toBe(firstOutput);
    expect(adapter.search).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledOnce();

    await expectCode(
      service.search(input({ query: "different query" }), executionContext()),
      "idempotency_conflict",
    );
    expect(adapter.search).toHaveBeenCalledOnce();
  });
});

describe("web-search application tool", () => {
  it("registers as trusted-server-only and projects bounded results and citations", async () => {
    const { service } = setup();
    const registry = new ToolRegistry<ApplicationToolExecutor<TestContext>, TestContext>();
    registry.register(createWebSearchToolRegistration<TestContext, TestContext>({ service }));
    expect(registry.discover({ context: { accountId: "account_1" } })).toEqual([]);
    const discovered = registry.discover({
      context: { accountId: "account_1" },
      capabilities: ["trusted-server"],
    });
    const executor = new BoundedToolExecutor({
      registry,
      policy: async () => ({ outcome: "allow" }),
    });

    const output = await executor.execute({
      call: {
        tool_call_id: "call_web_search",
        name: "web_search",
        arguments: input({ max_results: 1 }),
      },
      discoveredTools: discovered,
      applicationContext: { accountId: "account_1" },
    });

    expect(output.is_error).toBe(false);
    expect(output.content).toEqual([{ type: "json", value: { results: [adapterResult()] } }]);
    expect(output.citation_records?.sources).toEqual([
      {
        source_id: "source_1",
        type: "web",
        label: "Result one",
        locator: "https://example.com/result",
      },
    ]);
    expect(output.citation_records?.citations[0]).toMatchObject({
      citation_id: "web_search:source_1",
      order: 0,
      target: { type: "tool_result", tool_call_id: "call_web_search" },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("provider_rank");
    expect(serialized).not.toContain("raw_response");
  });
});
