import { describe, expect, it, vi } from "vitest";

import {
  AIRuntimePreflightDeniedError,
  createAIRuntimeUsageClient,
} from "../src/server/usage-control.js";
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
  it("injects only the server binding and normalized admission metadata", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ service_env_id: "service-env-1", idempotency_key: "logical-1", provider: "openai", model: "gpt-5.1", credential_mode: "customer_provided" });
      return new Response(JSON.stringify({ contract_version: "v1", replayed: false,
        request: { id: "request-1" }, policy_decision: { decision: "allow", reason_code: "within_policy" }, reservation: null }), { status: 201 });
    });
    const client = createAIRuntimeUsageClient({ apiUrl: "https://handrail.example/api/ai-runtime/v1", token: "server-token", serviceEnvId: "service-env-1", fetch: fetcher });
    const result = await client.admit({ idempotency_key: "logical-1", provider: "openai", model: "gpt-5.1" });
    expect(result.request.id).toBe("request-1");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("turns an authoritative pre-request denial into a typed hard stop", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ contract_version: "v1", replayed: false,
      request: { id: "request-denied" }, policy_decision: { decision: "deny", reason_code: "period_token_ceiling_exceeded" }, reservation: null }), { status: 200 }));
    const client = createAIRuntimeUsageClient({ apiUrl: "https://handrail.example/api/ai-runtime/v1", token: "server-token", serviceEnvId: "service-env-1", fetch: fetcher });
    await expect(client.admit({ idempotency_key: "logical-1", provider: "openai", model: "gpt-5.1" })).rejects.toBeInstanceOf(AIRuntimePreflightDeniedError);
  });

  it("submits validated per-invocation receipts and a terminal request status", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.receipts.map((item: { usage_receipt_id: string }) => item.usage_receipt_id)).toEqual(["receipt-1", "receipt-2"]);
      expect(body.request_status).toBe("cancelled");
      return new Response(JSON.stringify({ contract_version: "v1", request: { id: "request-1" }, reservation: null, accepted_receipts: 2, replayed_receipts: 0 }), { status: 200 });
    });
    const client = createAIRuntimeUsageClient({ apiUrl: "https://handrail.example/api/ai-runtime/v1", token: "server-token", serviceEnvId: "service-env-1", fetch: fetcher });
    const result = await client.settle({ requestId: "request-1", receipts: [receipt("receipt-1"), receipt("receipt-2")], requestStatus: "cancelled" });
    expect(result.accepted_receipts).toBe(2);
  });
});
