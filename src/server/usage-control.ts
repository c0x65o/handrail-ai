import {
  parseNormalizedUsageReceipt,
  type NormalizedUsageReceipt,
} from "../usage.js";

export const AI_RUNTIME_USAGE_API_VERSION = "v1" as const;

export interface AIRuntimeUsageClientOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly serviceEnvId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly retryLimit?: number;
}

export interface AIRuntimeReservationRequest {
  readonly tokens?: number;
  readonly output_tokens?: number;
  readonly provider_cost?: string;
  readonly expires_in_seconds?: number;
}

export interface AIRuntimeAdmissionInput {
  readonly idempotency_key: string;
  readonly provider: string;
  readonly model: string;
  readonly credential_mode?: "handrail_managed" | "customer_provided";
  readonly runtime_session_id?: string;
  readonly client_request_id?: string;
  readonly trace_id?: string;
  readonly reservation?: AIRuntimeReservationRequest;
}

export interface AIRuntimePolicyDecision {
  readonly id: string;
  readonly policy_id: string | null;
  readonly policy_version: number | null;
  readonly enforcement_mode: "observe" | "warn" | "deny";
  readonly decision: "allow" | "warn" | "deny";
  readonly reason_code: string;
  readonly created_at: string;
}

export interface AIRuntimeAdmissionResult {
  readonly contract_version: typeof AI_RUNTIME_USAGE_API_VERSION;
  readonly replayed: boolean;
  readonly request: {
    readonly id: string;
    readonly status: string;
    readonly project_id: string;
    readonly capability_id: string;
    readonly service_id: string;
    readonly environment: string;
    readonly provider: string;
    readonly model: string;
  };
  readonly policy_decision: AIRuntimePolicyDecision;
  readonly reservation: Readonly<Record<string, unknown>> | null;
}

export interface AIRuntimeSettlementResult {
  readonly contract_version: typeof AI_RUNTIME_USAGE_API_VERSION;
  readonly request: Readonly<Record<string, unknown>>;
  readonly reservation: Readonly<Record<string, unknown>> | null;
  readonly accepted_receipts: number;
  readonly replayed_receipts: number;
}

export class AIRuntimeUsageClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, options: { status: number; code: string; retryable: boolean }) {
    super(message);
    this.name = "AIRuntimeUsageClientError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

export class AIRuntimePreflightDeniedError extends AIRuntimeUsageClientError {
  readonly result: AIRuntimeAdmissionResult;

  constructor(result: AIRuntimeAdmissionResult) {
    super(`AI Runtime preflight denied: ${result.policy_decision.reason_code}`, {
      status: 403,
      code: result.policy_decision.reason_code,
      retryable: false,
    });
    this.name = "AIRuntimePreflightDeniedError";
    this.result = result;
  }
}

export interface AIRuntimeUsageClient {
  admit(input: AIRuntimeAdmissionInput): Promise<AIRuntimeAdmissionResult>;
  settle(input: {
    readonly requestId: string;
    readonly receipts: readonly NormalizedUsageReceipt[];
    readonly requestStatus?: "succeeded" | "failed" | "cancelled";
  }): Promise<AIRuntimeSettlementResult>;
}

function required(value: string, label: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`${label} is required`);
  return normalized;
}

function withoutTrailingSlash(value: string): string {
  return required(value, "AI Runtime apiUrl").replace(/\/+$/u, "");
}

async function responseError(response: Response): Promise<AIRuntimeUsageClientError> {
  let body: { error?: unknown; code?: unknown } = {};
  try { body = await response.json() as typeof body; } catch { /* error bodies may be empty */ }
  return new AIRuntimeUsageClientError(
    typeof body.error === "string" ? body.error : `AI Runtime request failed with HTTP ${response.status}`,
    {
      status: response.status,
      code: typeof body.code === "string" ? body.code : "ai_runtime_http_error",
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    },
  );
}

export function createAIRuntimeUsageClient(options: AIRuntimeUsageClientOptions): AIRuntimeUsageClient {
  const apiUrl = withoutTrailingSlash(options.apiUrl);
  const token = required(options.token, "AI Runtime token");
  const serviceEnvId = required(options.serviceEnvId, "AI Runtime serviceEnvId");
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("AI Runtime fetch implementation is required");
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 10_000);
  const retryLimit = Math.max(0, Math.min(5, options.retryLimit ?? 2));

  const request = async <T>(path: string, init: RequestInit, { retry = false } = {}): Promise<T> => {
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("AI Runtime request timed out")), timeoutMs);
      try {
        const response = await fetcher(`${apiUrl}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Handrail-API-Contract-Version": AI_RUNTIME_USAGE_API_VERSION,
            ...(init.headers || {}),
          },
          signal: controller.signal,
        });
        if (response.ok) return await response.json() as T;
        const error = await responseError(response);
        if (!retry || !error.retryable || attempt >= retryLimit) throw error;
      } catch (error) {
        if (!retry || attempt >= retryLimit || (error instanceof AIRuntimeUsageClientError && !error.retryable)) throw error;
      } finally {
        clearTimeout(timeout);
      }
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, 100 * (2 ** (attempt - 1)))));
    }
  };

  return Object.freeze({
    async admit(input: AIRuntimeAdmissionInput): Promise<AIRuntimeAdmissionResult> {
      const result = await request<AIRuntimeAdmissionResult>("/requests", {
        method: "POST",
        body: JSON.stringify({
          service_env_id: serviceEnvId,
          idempotency_key: required(input.idempotency_key, "AI Runtime idempotency_key"),
          provider: required(input.provider, "AI Runtime provider"),
          model: required(input.model, "AI Runtime model"),
          credential_mode: input.credential_mode ?? "customer_provided",
          ...(input.runtime_session_id ? { runtime_session_id: input.runtime_session_id } : {}),
          ...(input.client_request_id ? { client_request_id: input.client_request_id } : {}),
          ...(input.trace_id ? { trace_id: input.trace_id } : {}),
          ...(input.reservation ? { reservation: input.reservation } : {}),
        }),
      }, { retry: true });
      if (result.policy_decision?.decision === "deny") throw new AIRuntimePreflightDeniedError(result);
      return result;
    },

    async settle({ requestId, receipts, requestStatus }: {
      readonly requestId: string;
      readonly receipts: readonly NormalizedUsageReceipt[];
      readonly requestStatus?: "succeeded" | "failed" | "cancelled";
    }): Promise<AIRuntimeSettlementResult> {
      const normalized = receipts.map((receipt) => parseNormalizedUsageReceipt(receipt));
      if (normalized.length === 0 && !requestStatus) throw new TypeError("At least one AI Runtime usage receipt or a terminal request status is required");
      return request<AIRuntimeSettlementResult>(`/requests/${encodeURIComponent(required(requestId, "AI Runtime requestId"))}/receipts`, {
        method: "POST",
        body: JSON.stringify({ receipts: normalized, ...(requestStatus ? { request_status: requestStatus } : {}) }),
      }, { retry: true });
    },
  });
}

export function createAIRuntimeUsageClientFromEnv(env: Record<string, string | undefined> = process.env): AIRuntimeUsageClient | null {
  if (env.HANDRAIL_AI_RUNTIME_ENABLED !== "true") return null;
  const apiUrl = env.HANDRAIL_AI_RUNTIME_API_URL;
  const token = env.HANDRAIL_AI_RUNTIME_TOKEN;
  const serviceEnvId = env.HANDRAIL_AI_RUNTIME_SERVICE_ENV_ID;
  if (!apiUrl || !token || !serviceEnvId) return null;
  return createAIRuntimeUsageClient({ apiUrl, token, serviceEnvId });
}
