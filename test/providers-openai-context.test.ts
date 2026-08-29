import { describe, expect, it, vi } from "vitest";

import {
  PROVIDER_CONTEXT_CHECKPOINT_VERSION,
  PROVIDER_CONTEXT_CONTRACT_VERSION,
  PROVIDER_CONTEXT_LIMITS,
  createProviderContextFingerprint,
  normalizeProviderContextError,
  parseProviderContextIdempotencyKey,
  type ProviderContextCheckpoint,
  type ProviderContextCompactionRequest,
  type ProviderContextHistoryPosition,
  type ProviderContextMeasurementRequest,
} from "../src/index.js";
import {
  createOpenAIProviderAdapter,
  type OpenAIProviderContextCompactRequest,
  type OpenAIProviderContextInput,
  type OpenAIProviderContextMeasureRequest,
  type OpenAIProviderContextRequestOptions,
} from "../src/providers/openai.js";

async function* emptyStream(): AsyncGenerator<unknown> {}

const input = (
  overrides: Partial<OpenAIProviderContextInput> = {},
): OpenAIProviderContextInput => ({
  instructions: ["  Be concise.\r\nUse tools.  "],
  messages: [{ role: "user", content: [{ type: "text", text: "Private prompt" }] }],
  tools: [{
    name: "lookup",
    description: "Look up a value.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  }],
  tool_results: [{
    tool_call_id: "call-1",
    name: "lookup",
    content: [{ type: "json", value: { result: "Private result" } }],
    is_error: false,
  }],
  generation: { max_output_tokens: 256, temperature: 0.2 },
  provider_settings: { reasoning: { effort: "medium" }, top_p: 0.9 },
  ...overrides,
});

const history = (
  revision = 4,
  eventId: string | null = "event-4",
): ProviderContextHistoryPosition => ({
  conversation_id: "conversation-1",
  revision,
  event_id: eventId,
});

const fingerprint = (value = input()) => createProviderContextFingerprint({
  model: { provider_id: "openai", model_id: "gpt-fixture" },
  instructions: value.instructions,
  tools: value.tools,
  generation: value.generation,
  ...(value.provider_settings === undefined
    ? {}
    : { provider_settings: value.provider_settings }),
});

const checkpoint = (
  contextFingerprint = fingerprint(),
  position = history(),
  overrides: Record<string, unknown> = {},
): ProviderContextCheckpoint => ({
  version: PROVIDER_CONTEXT_CHECKPOINT_VERSION,
  provider_id: "openai",
  checkpoint_id: "checkpoint-1",
  format: "responses-compaction-v1",
  opaque_state: "b3BhcXVlLXByb3ZpZGVyLXN0YXRl",
  context_fingerprint: contextFingerprint,
  history_position: position,
  ...overrides,
} as ProviderContextCheckpoint);

const measurementRequest = (
  value = input(),
  overrides: Partial<ProviderContextMeasurementRequest<OpenAIProviderContextInput>> = {},
): ProviderContextMeasurementRequest<OpenAIProviderContextInput> => ({
  input: value,
  context_fingerprint: fingerprint(value),
  history_position: history(),
  checkpoint: null,
  signal: new AbortController().signal,
  ...overrides,
});

const compactionRequest = (
  value = input(),
  overrides: Partial<ProviderContextCompactionRequest<OpenAIProviderContextInput>> = {},
): ProviderContextCompactionRequest<OpenAIProviderContextInput> => ({
  ...measurementRequest(value),
  idempotency_key: parseProviderContextIdempotencyKey("compact:conversation-1:4"),
  target_input_tokens: 1_000,
  ...overrides,
});

const measured = (
  contextFingerprint = fingerprint(),
  position = history(),
  overrides: Record<string, unknown> = {},
) => ({
  status: "measured",
  context_fingerprint: contextFingerprint,
  history_position: position,
  input_tokens: 2_400,
  context_window_tokens: 128_000,
  ...overrides,
});

async function safeFailure(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected provider-context operation to reject");
  } catch (error) {
    return normalizeProviderContextError(error);
  }
}

function adapterOptions(overrides: Record<string, unknown> = {}) {
  return {
    model: "gpt-fixture",
    request: () => emptyStream(),
    ...overrides,
  };
}

describe("OpenAI provider-context capability", () => {
  it("is explicitly unsupported unless both injected operations are configured", () => {
    const unconfigured = createOpenAIProviderAdapter(adapterOptions());
    const partial = createOpenAIProviderAdapter(adapterOptions({
      measure_context: async () => measured(),
    }));
    const configured = createOpenAIProviderAdapter(adapterOptions({
      measure_context: async () => measured(),
      compact_context: async () => ({
        status: "unchanged",
        checkpoint: null,
        measurement: measured(),
      }),
    }));

    expect(unconfigured.provider_context).toEqual({
      supported: false,
      reason: "compaction_not_configured",
    });
    expect(partial.provider_context).toEqual({
      supported: false,
      reason: "compaction_not_configured",
    });
    expect(configured.provider_context).toMatchObject({
      supported: true,
      version: PROVIDER_CONTEXT_CONTRACT_VERSION,
    });
  });

  it("projects every canonical field, model identity, checkpoint, fingerprint, and exact signal", async () => {
    let projected: OpenAIProviderContextMeasureRequest | undefined;
    let requestOptions: OpenAIProviderContextRequestOptions | undefined;
    const canonicalInput = input();
    const contextFingerprint = fingerprint(canonicalInput);
    const position = history();
    const existingCheckpoint = checkpoint(contextFingerprint, history(3, "event-3"));
    const controller = new AbortController();
    const measureContext = vi.fn(async (
      request: OpenAIProviderContextMeasureRequest,
      options: OpenAIProviderContextRequestOptions,
    ) => {
      projected = request;
      requestOptions = options;
      return measured(contextFingerprint, position);
    });
    const adapter = createOpenAIProviderAdapter(adapterOptions({
      measure_context: measureContext,
      compact_context: async () => ({
        status: "unchanged",
        checkpoint: null,
        measurement: measured(),
      }),
    }));
    if (!adapter.provider_context.supported) throw new Error("expected support");

    const result = await adapter.provider_context.measure(measurementRequest(
      canonicalInput,
      { checkpoint: existingCheckpoint, signal: controller.signal },
    ));

    expect(projected).toEqual({
      model: "gpt-fixture",
      instructions: canonicalInput.instructions,
      messages: canonicalInput.messages,
      tool_results: canonicalInput.tool_results,
      tools: canonicalInput.tools,
      generation: canonicalInput.generation,
      provider_settings: canonicalInput.provider_settings,
      context_fingerprint: contextFingerprint,
      history_position: position,
      checkpoint: existingCheckpoint,
    });
    expect(projected?.context_fingerprint).toBe(createProviderContextFingerprint({
      model: { provider_id: "openai", model_id: "gpt-fixture" },
      instructions: ["Be concise.\nUse tools."],
      tools: canonicalInput.tools,
      generation: canonicalInput.generation,
      provider_settings: canonicalInput.provider_settings,
    }));
    expect(requestOptions?.signal).toBe(controller.signal);
    expect(result).toEqual(measured(contextFingerprint, position));
  });

  it("accepts compacted and unchanged results and normalizes bounded opaque checkpoints", async () => {
    const contextFingerprint = fingerprint();
    const position = history();
    const compactedCheckpoint = checkpoint(contextFingerprint, position);
    const compactContext = vi.fn(async () => ({
      status: "compacted",
      checkpoint: compactedCheckpoint,
      measurement: measured(contextFingerprint, position, { input_tokens: 900 }),
    }));
    const adapter = createOpenAIProviderAdapter(adapterOptions({
      measure_context: async () => measured(),
      compact_context: compactContext,
    }));
    if (!adapter.provider_context.supported) throw new Error("expected support");

    const compacted = await adapter.provider_context.compact(compactionRequest());
    expect(compacted.status).toBe("compacted");
    if (compacted.status !== "compacted") throw new Error("expected compacted");
    expect(compacted.checkpoint).toEqual(compactedCheckpoint);
    expect(Object.isFrozen(compacted.checkpoint)).toBe(true);
    expect(Object.isFrozen(compacted.checkpoint.history_position)).toBe(true);

    const secondAdapter = createOpenAIProviderAdapter(adapterOptions({
      measure_context: async () => measured(),
      compact_context: async () => ({
        status: "unchanged",
        checkpoint: checkpoint(contextFingerprint, history(3, "event-3")),
        measurement: measured(contextFingerprint, position),
      }),
    }));
    if (!secondAdapter.provider_context.supported) throw new Error("expected support");
    await expect(secondAdapter.provider_context.compact(compactionRequest())).resolves.toMatchObject({
      status: "unchanged",
      measurement: { input_tokens: 2_400 },
    });
  });

  it.each([
    ["unsafe token count", measured(fingerprint(), history(), { input_tokens: Number.MAX_SAFE_INTEGER + 1 })],
    ["mismatched fingerprint", measured(createProviderContextFingerprint({
      model: { provider_id: "openai", model_id: "gpt-other" },
      instructions: input().instructions,
      tools: input().tools,
      generation: input().generation,
      provider_settings: input().provider_settings,
    }))],
    ["mismatched history", measured(fingerprint(), history(5, "event-5"))],
    ["extra provider output", { ...measured(), raw_response: { secret: true } }],
  ])("rejects malformed or inconsistent measurement output: %s", async (_label, response) => {
    const adapter = createOpenAIProviderAdapter(adapterOptions({
      measure_context: async () => response,
      compact_context: async () => ({
        status: "unchanged",
        checkpoint: null,
        measurement: measured(),
      }),
    }));
    if (!adapter.provider_context.supported) throw new Error("expected support");
    expect(await safeFailure(adapter.provider_context.measure(measurementRequest()))).toEqual({
      code: "internal_failure",
      message: "Provider-context processing failed.",
      retryable: false,
    });
  });

  it("rejects malformed, mismatched, extra-field, and oversized compacted checkpoints", async () => {
    const invalidCheckpoints = [
      checkpoint(fingerprint(), history(), { provider_id: "other" }),
      checkpoint(fingerprint(), history(3, "event-3")),
      checkpoint(fingerprint(), history(), { prompt: "private" }),
      checkpoint(fingerprint(), history(), {
        opaque_state: "a".repeat(PROVIDER_CONTEXT_LIMITS.checkpointOpaqueStateLength + 1),
      }),
    ];

    for (const invalidCheckpoint of invalidCheckpoints) {
      const adapter = createOpenAIProviderAdapter(adapterOptions({
        measure_context: async () => measured(),
        compact_context: async () => ({
          status: "compacted",
          checkpoint: invalidCheckpoint,
          measurement: measured(),
        }),
      }));
      if (!adapter.provider_context.supported) throw new Error("expected support");
      expect(await safeFailure(adapter.provider_context.compact(compactionRequest()))).toMatchObject({
        code: "internal_failure",
        retryable: false,
      });
    }
  });

  it.each([
    [408, "deadline_exceeded", true],
    [429, "provider_unavailable", true],
    [503, "provider_unavailable", true],
    [400, "invalid_request", false],
    [409, "idempotency_conflict", false],
  ] as const)("maps upstream status %i to fixed safe error %s", async (status, code, retryable) => {
    const adapter = createOpenAIProviderAdapter(adapterOptions({
      measure_context: async () => {
        throw {
          status,
          message: "raw sk-sensitive-value",
          body: { prompt: "Private prompt", tool_result: "Private result" },
          headers: { authorization: "Bearer raw-secret" },
        };
      },
      compact_context: async () => ({
        status: "unchanged",
        checkpoint: null,
        measurement: measured(),
      }),
    }));
    if (!adapter.provider_context.supported) throw new Error("expected support");

    const failure = await safeFailure(adapter.provider_context.measure(measurementRequest()));
    expect(failure).toMatchObject({ code, retryable });
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain("sensitive");
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("authorization");
  });

  it("memoizes repeated identical compactions without retaining canonical content", async () => {
    let projected: OpenAIProviderContextCompactRequest | undefined;
    const compactContext = vi.fn(async (request: OpenAIProviderContextCompactRequest) => {
      projected = request;
      return {
        status: "compacted",
        checkpoint: checkpoint(),
        measurement: measured(fingerprint(), history(), { input_tokens: 900 }),
      };
    });
    const adapter = createOpenAIProviderAdapter(adapterOptions({
      measure_context: async () => measured(),
      compact_context: compactContext,
    }));
    if (!adapter.provider_context.supported) throw new Error("expected support");
    const request = compactionRequest();

    const first = await adapter.provider_context.compact(request);
    const second = await adapter.provider_context.compact(request);

    expect(compactContext).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    expect(projected).toMatchObject({
      idempotency_key: request.idempotency_key,
      target_input_tokens: 1_000,
      model: "gpt-fixture",
    });
  });

  it("rejects conflicting reuse of an idempotency key permanently", async () => {
    const compactContext = vi.fn(async () => ({
      status: "unchanged",
      checkpoint: null,
      measurement: measured(),
    }));
    const adapter = createOpenAIProviderAdapter(adapterOptions({
      measure_context: async () => measured(),
      compact_context: compactContext,
    }));
    if (!adapter.provider_context.supported) throw new Error("expected support");
    await adapter.provider_context.compact(compactionRequest());

    const changed = input({
      messages: [{ role: "user", content: [{ type: "text", text: "Different prompt" }] }],
    });
    const failure = await safeFailure(adapter.provider_context.compact(compactionRequest(changed)));

    expect(failure).toEqual({
      code: "idempotency_conflict",
      message: "The idempotency key conflicts with another compaction.",
      retryable: false,
    });
    expect(compactContext).toHaveBeenCalledOnce();
  });

  it("rejects pre-aborted calls without invoking either upstream operation", async () => {
    const measureContext = vi.fn(async () => measured());
    const compactContext = vi.fn(async () => ({
      status: "unchanged",
      checkpoint: null,
      measurement: measured(),
    }));
    const adapter = createOpenAIProviderAdapter(adapterOptions({
      measure_context: measureContext,
      compact_context: compactContext,
    }));
    if (!adapter.provider_context.supported) throw new Error("expected support");
    const controller = new AbortController();
    controller.abort("private cancellation reason");

    expect(await safeFailure(adapter.provider_context.measure(measurementRequest(input(), {
      signal: controller.signal,
    })))).toMatchObject({ code: "cancelled", retryable: false });
    expect(await safeFailure(adapter.provider_context.compact(compactionRequest(input(), {
      signal: controller.signal,
    })))).toMatchObject({ code: "cancelled", retryable: false });
    expect(measureContext).not.toHaveBeenCalled();
    expect(compactContext).not.toHaveBeenCalled();
  });

  it("propagates the exact signal and normalizes cancellation during upstream work", async () => {
    const controller = new AbortController();
    let upstreamSignal: AbortSignal | undefined;
    const measureContext = vi.fn((
      _request: OpenAIProviderContextMeasureRequest,
      options: OpenAIProviderContextRequestOptions,
    ) => {
      upstreamSignal = options.signal;
      return new Promise(() => undefined);
    });
    const adapter = createOpenAIProviderAdapter(adapterOptions({
      measure_context: measureContext,
      compact_context: async () => ({
        status: "unchanged",
        checkpoint: null,
        measurement: measured(),
      }),
    }));
    if (!adapter.provider_context.supported) throw new Error("expected support");
    const pending = adapter.provider_context.measure(measurementRequest(input(), {
      signal: controller.signal,
    }));
    await vi.waitFor(() => expect(measureContext).toHaveBeenCalledOnce());
    controller.abort({ raw: "private abort object" });

    expect(upstreamSignal).toBe(controller.signal);
    expect(await safeFailure(pending)).toEqual({
      code: "cancelled",
      message: "The provider-context operation was cancelled.",
      retryable: false,
    });
  });
});
