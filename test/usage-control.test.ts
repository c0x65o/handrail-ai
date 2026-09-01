import { describe, expect, it, vi } from "vitest";

import { createAIRuntimeUsageClient } from "../src/server/usage-control.js";
import { createAIRuntimeQuotaLeaseClient } from "../src/server/usage-control.js";
import { parseNormalizedUsageReceipt } from "../src/usage.js";

function receipt(id = "receipt-1") {
  return parseNormalizedUsageReceipt({
    version: 1, usage_receipt_id: id, conversation_id: "conversation-1", turn_id: "turn-1",
    logical_request_id: "logical-1", trace_id: "trace-1",
    attempt: { id: "attempt-0", index: 0 }, continuation: { id: "continuation-0", index: 0 },
    provider_id: "openai", model_id: "gpt-5.1",
    attribution: {
      organization: { id: "org-1", source: "server_derived", trust: "authoritative" },
      project: { id: "project-1", source: "server_derived", trust: "authoritative" },
      service_environment: { id: "service-env-1", source: "server_derived", trust: "authoritative" },
      known_user: { id: null, source: "server_derived", trust: "authoritative" },
      session: { id: null, source: "server_derived", trust: "authoritative" },
      automation: { id: null, source: "server_derived", trust: "authoritative" },
    },
    source: "provider", terminal_status: "completed",
    tokens: {
      input_tokens: { status: "reported", value: 10 }, cached_input_tokens: { status: "reported", value: 0 },
      output_tokens: { status: "reported", value: 5 }, reasoning_tokens: { status: "unavailable" },
      total_tokens: { status: "reported", value: 15 },
    },
    provider_cost: { status: "unavailable" },
  });
}

describe("AI Runtime usage-control client", () => {
  it("keeps admission local and observe-only so Handrail availability cannot block a provider call", async () => {
    const fetcher = vi.fn();
    const client = createAIRuntimeUsageClient({ apiUrl: "https://telemetry.example", token: "server-token", serviceEnvId: "service-env-1", fetch: fetcher });
    const result = await client.admit({ idempotency_key: "logical-1", provider: "openai", model: "gpt-5.1" });
    expect(result.request.id).toBe("logical-1");
    expect(result.policy_decision).toMatchObject({ enforcement_mode: "observe", decision: "allow", reason_code: "telemetry_observe_only" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("deduplicates local admission identities", async () => {
    const client = createAIRuntimeUsageClient({ apiUrl: "https://telemetry.example", token: "server-token", serviceEnvId: "service-env-1", fetch: vi.fn() });
    await client.admit({ idempotency_key: "logical-1", provider: "openai", model: "gpt-5.1" });
    expect((await client.admit({ idempotency_key: "logical-1", provider: "openai", model: "gpt-5.1" })).replayed).toBe(true);
  });

  it("submits validated per-invocation receipts and a terminal request status", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(_url)).toBe("https://telemetry.example/api/ai-usage/v1/receipts");
      expect(body).toMatchObject({ service_env_id: "service-env-1" });
      expect(body.receipts.map((item: { usage_receipt_id: string }) => item.usage_receipt_id)).toEqual(["receipt-1", "receipt-2"]);
      expect(body).not.toHaveProperty("request_status");
      return new Response(JSON.stringify({ accepted_count: 2, duplicate_count: 0 }), { status: 202 });
    });
    const client = createAIRuntimeUsageClient({ apiUrl: "https://telemetry.example", token: "server-token", serviceEnvId: "service-env-1", fetch: fetcher });
    const result = await client.settle({ requestId: "request-1", receipts: [receipt("receipt-1"), receipt("receipt-2")], requestStatus: "cancelled" });
    expect(result.accepted_receipts).toBe(2);
  });
});

describe("AI Runtime quota lease foundation", () => {
  it("hard-stops before the next invocation only for an explicit strict deny lease", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ lease_id: "lease-1", logical_request_id: "logical-1", enforcement_mode: "deny", decision: "deny", reason_code: "period_token_ceiling_exceeded", reserved_tokens: 0, output_token_limit: 100, strict: true, expires_at: new Date().toISOString() }), { status: 429 }));
    const client = createAIRuntimeQuotaLeaseClient({ apiUrl: "https://telemetry.example", token: "server-token", serviceEnvId: "service-env-1", fetch: fetcher });
    const lease = await client.acquire({ logicalRequestId: "logical-1", requestedTokens: 10 });
    expect(() => client.assertCanInvoke(lease)).toThrow(/preflight denied/i);
    expect(fetcher).toHaveBeenCalledWith("https://telemetry.example/api/ai-usage/v1/leases", expect.any(Object));
  });
});
