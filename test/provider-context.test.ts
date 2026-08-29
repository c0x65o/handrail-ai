import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PROVIDER_CONTEXT_CHECKPOINT_VERSION,
  PROVIDER_CONTEXT_CONTRACT_VERSION,
  PROVIDER_CONTEXT_ERROR_CODES,
  PROVIDER_CONTEXT_INVALIDATION_REASONS,
  PROVIDER_CONTEXT_LIMITS,
  PROVIDER_CONTEXT_UNSUPPORTED_REASONS,
  ProviderContextOperationError,
  ProviderContextValidationError,
  assessProviderContextCheckpoint,
  createProviderContextFingerprint,
  normalizeProviderContextError,
  parseProviderContextCheckpoint,
  parseProviderContextCapabilityDescriptor,
  parseProviderContextCompactionRequest,
  parseProviderContextCompactionResult,
  parseProviderContextMeasurementRequest,
  parseProviderContextMeasurementResult,
  parseProviderContextSafeError,
  providerContextSafeError,
  type ProviderContextCapability,
  type ProviderContextFingerprintInput,
} from "../src/index.js";

const fingerprintInput = (
  overrides: Partial<ProviderContextFingerprintInput> = {},
): ProviderContextFingerprintInput => ({
  model: { provider_id: "example", model_id: "model-v1" },
  instructions: ["Be concise.\nUse citations."],
  tools: [{
    name: "lookup",
    description: "Look up a record.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
    },
  }],
  generation: { max_output_tokens: 512, temperature: 0.25 },
  provider_settings: { reasoning: { effort: "medium" }, top_p: 0.9 },
  ...overrides,
});

const fingerprint = () => createProviderContextFingerprint(fingerprintInput());
const history = (revision = 7, eventId: string | null = "event-7") => ({
  conversation_id: "conversation-1",
  revision,
  event_id: eventId,
});
const checkpoint = (overrides: Record<string, unknown> = {}) => ({
  version: PROVIDER_CONTEXT_CHECKPOINT_VERSION,
  provider_id: "example",
  checkpoint_id: "checkpoint-1",
  format: "opaque-v1",
  opaque_state: "cHJvdmlkZXItc3RhdGU",
  context_fingerprint: fingerprint(),
  history_position: history(),
  ...overrides,
});
const measurement = (overrides: Record<string, unknown> = {}) => ({
  status: "measured",
  context_fingerprint: fingerprint(),
  history_position: history(),
  input_tokens: 4_000,
  context_window_tokens: 16_000,
  ...overrides,
});

describe("provider-context fingerprint", () => {
  it("is stable across equivalent instruction, tool-order, and object-key normalization", () => {
    const baseline = fingerprint();
    const equivalent = createProviderContextFingerprint({
      provider_settings: { top_p: 0.9, reasoning: { effort: "medium" } },
      generation: { temperature: 0.25, max_output_tokens: 512 },
      tools: [
        {
          input_schema: {
            required: ["id"],
            properties: { id: { minLength: 1, type: "string" } },
            type: "object",
          },
          description: "Look up a record.",
          name: "lookup",
        },
      ],
      instructions: ["  Be   concise.\r\n Use citations.  "],
      model: { model_id: "model-v1", provider_id: "example" },
    });

    expect(equivalent).toBe(baseline);
    expect(baseline).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(baseline)).not.toContain("Be concise");
  });

  it.each([
    ["model", fingerprintInput({ model: { provider_id: "example", model_id: "model-v2" } })],
    ["instructions", fingerprintInput({ instructions: ["Be expansive."] })],
    ["tools", fingerprintInput({ tools: [{
      name: "lookup_other",
      description: "Look up a record.",
      input_schema: { type: "object" },
    }] })],
    ["generation", fingerprintInput({ generation: { max_output_tokens: 256, temperature: 0.25 } })],
    ["provider settings", fingerprintInput({ provider_settings: { reasoning: { effort: "high" } } })],
  ])("changes when %s changes", (_label, changed) => {
    expect(createProviderContextFingerprint(changed)).not.toBe(fingerprint());
  });

  it("bounds inputs and rejects credentials or request payloads as settings", () => {
    expect(() => createProviderContextFingerprint(fingerprintInput({
      instructions: Array.from({ length: PROVIDER_CONTEXT_LIMITS.instructions + 1 }, () => "x"),
    }))).toThrow(/instructions.*at most/);
    expect(() => createProviderContextFingerprint(fingerprintInput({
      instructions: ["x".repeat(PROVIDER_CONTEXT_LIMITS.instructionLength + 1)],
    }))).toThrow(/instructions.*1-/);
    expect(() => createProviderContextFingerprint(fingerprintInput({
      provider_settings: { api_key: "sk-sensitive-value" },
    }))).toThrow(/api_key.*sensitive/);
    expect(() => createProviderContextFingerprint(fingerprintInput({
      provider_settings: { provider_request: { messages: [] } },
    }))).toThrow(/provider_request.*provider-native/);
  });
});

describe("provider-context checkpoint records", () => {
  it("parses only the versioned, bounded, JSON-safe opaque record", () => {
    const parsed = parseProviderContextCheckpoint(checkpoint());
    expect(parsed).toEqual(checkpoint());
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.history_position)).toBe(true);
  });

  it("rejects prompts, instructions, raw tools/results, credentials, native objects, and arbitrary metadata", () => {
    for (const extra of [
      { prompt: "private prompt" },
      { instructions: "hidden instructions" },
      { tools: [{ name: "unsafe" }] },
      { tool_results: [{ result: "private" }] },
      { credentials: { api_key: "secret" } },
      { provider_response: { id: "response-1" } },
      { metadata: { arbitrary: true } },
    ]) {
      expect(() => parseProviderContextCheckpoint(checkpoint(extra))).toThrow(
        ProviderContextValidationError,
      );
    }
    expect(() => parseProviderContextCheckpoint(checkpoint({
      opaque_state: "raw prompt text",
    }))).toThrow(/base64url/);
    expect(() => parseProviderContextCheckpoint(checkpoint({
      opaque_state: { response: "native" },
    }))).toThrow(/string/);
    expect(() => parseProviderContextCheckpoint(checkpoint({
      opaque_state: `x${"a".repeat(PROVIDER_CONTEXT_LIMITS.checkpointOpaqueStateLength)}`,
    }))).toThrow(/1-/);
  });

  it("assesses fingerprint, provider, history, version, and corrupt invalidation reasons", () => {
    const expected = {
      provider_id: "example",
      context_fingerprint: fingerprint(),
      history_position: history(8, "event-8"),
    };
    expect(assessProviderContextCheckpoint(checkpoint(), expected).valid).toBe(true);
    expect(assessProviderContextCheckpoint(checkpoint({ provider_id: "other" }), expected)).toEqual({
      valid: false, reason: "checkpoint_rejected",
    });
    expect(assessProviderContextCheckpoint(checkpoint({ context_fingerprint: createProviderContextFingerprint(
      fingerprintInput({ instructions: ["changed"] }),
    ) }), expected)).toEqual({ valid: false, reason: "context_fingerprint_changed" });
    expect(assessProviderContextCheckpoint(checkpoint({ history_position: history(9, "event-9") }), expected)).toEqual({
      valid: false, reason: "canonical_history_rewound",
    });
    expect(assessProviderContextCheckpoint(checkpoint({ history_position: history(8, "different") }), expected)).toEqual({
      valid: false, reason: "canonical_history_changed",
    });
    expect(assessProviderContextCheckpoint(checkpoint({ version: 2 }), expected)).toEqual({
      valid: false, reason: "version_unsupported",
    });
    expect(assessProviderContextCheckpoint({ nope: true }, expected)).toEqual({
      valid: false, reason: "checkpoint_corrupt",
    });
  });
});

describe("measurement and compaction contracts", () => {
  it("strictly parses bounded measurement results", () => {
    expect(parseProviderContextMeasurementResult(measurement())).toEqual(measurement());
    expect(parseProviderContextMeasurementResult(measurement({ input_tokens: 20_000 }))).toMatchObject({
      input_tokens: 20_000,
      context_window_tokens: 16_000,
    });
    for (const invalid of [
      measurement({ input_tokens: -1 }),
      measurement({ input_tokens: Number.MAX_SAFE_INTEGER + 1, context_window_tokens: null }),
      measurement({ extra: true }),
    ]) expect(() => parseProviderContextMeasurementResult(invalid)).toThrow(ProviderContextValidationError);
  });

  it("requires cancellation and validates compaction idempotency inputs", () => {
    const signal = new AbortController().signal;
    const base = {
      input: { ephemeral: true },
      context_fingerprint: fingerprint(),
      history_position: history(),
      checkpoint: null,
      signal,
    };
    const measured = parseProviderContextMeasurementRequest(base, (value) => value as { ephemeral: boolean });
    expect(measured.signal).toBe(signal);
    const compacted = parseProviderContextCompactionRequest({
      ...base,
      idempotency_key: "compact:conversation-1:7",
      target_input_tokens: 2_000,
    }, (value) => value as { ephemeral: boolean });
    expect(compacted.idempotency_key).toBe("compact:conversation-1:7");
    expect(compacted.target_input_tokens).toBe(2_000);
    expectTypeOf(compacted.signal).toEqualTypeOf<AbortSignal>();

    expect(() => parseProviderContextMeasurementRequest({ ...base, signal: undefined }, (value) => value)).toThrow(/signal/);
    for (const idempotency_key of ["", "contains spaces", "x".repeat(PROVIDER_CONTEXT_LIMITS.idempotencyKeyLength + 1)]) {
      expect(() => parseProviderContextCompactionRequest({
        ...base, idempotency_key, target_input_tokens: 2_000,
      }, (value) => value)).toThrow(/idempotency_key/);
    }
  });

  it("parses exact compaction result variants and checks checkpoint association", () => {
    expect(parseProviderContextCompactionResult({
      status: "compacted", checkpoint: checkpoint(), measurement: measurement(),
    }).status).toBe("compacted");
    expect(parseProviderContextCompactionResult({
      status: "unchanged", checkpoint: null, measurement: measurement(),
    }).status).toBe("unchanged");
    expect(parseProviderContextCompactionResult({
      status: "invalidated",
      reason: "checkpoint_expired",
      context_fingerprint: fingerprint(),
      history_position: history(),
    })).toMatchObject({ status: "invalidated", reason: "checkpoint_expired" });
    expect(() => parseProviderContextCompactionResult({
      status: "compacted",
      checkpoint: checkpoint({ history_position: history(6, "event-6") }),
      measurement: measurement(),
    })).toThrow(/measured context/);
  });

  it("narrows supported and unsupported capabilities", async () => {
    const supportedDescriptor = parseProviderContextCapabilityDescriptor({
      supported: true,
      version: PROVIDER_CONTEXT_CONTRACT_VERSION,
    });
    const unsupportedDescriptor = parseProviderContextCapabilityDescriptor({
      supported: false,
      reason: "provider_not_supported",
    });
    if (supportedDescriptor.supported) expect(supportedDescriptor.version).toBe(PROVIDER_CONTEXT_CONTRACT_VERSION);
    if (!unsupportedDescriptor.supported) expect(unsupportedDescriptor.reason).toBe("provider_not_supported");
    expect(() => parseProviderContextCapabilityDescriptor({
      supported: false,
      reason: "provider_not_supported",
      adapter: {},
    })).toThrow(/adapter.*not a supported field/);

    const unsupported: ProviderContextCapability<{ value: string }> = {
      supported: false,
      reason: "model_not_supported",
    };
    const supported: ProviderContextCapability<{ value: string }> = {
      supported: true,
      version: PROVIDER_CONTEXT_CONTRACT_VERSION,
      async measure(request) {
        expectTypeOf(request.signal).toEqualTypeOf<AbortSignal>();
        return parseProviderContextMeasurementResult(measurement());
      },
      async compact() {
        return parseProviderContextCompactionResult({
          status: "unchanged", checkpoint: null, measurement: measurement(),
        });
      },
    };
    if (unsupported.supported) throw new Error("unreachable");
    expect(unsupported.reason).toBe("model_not_supported");
    if (!supported.supported) throw new Error("unreachable");
    expectTypeOf(supported.compact).toBeFunction();
    await expect(supported.measure({
      input: { value: "ephemeral" },
      context_fingerprint: fingerprint(),
      history_position: history(),
      checkpoint: null,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: "measured" });
  });
});

describe("provider-context safe errors", () => {
  it("normalizes only fixed bounded public messages and never leaks unknown errors", () => {
    expect(normalizeProviderContextError(new ProviderContextOperationError("provider_unavailable"))).toEqual(
      providerContextSafeError("provider_unavailable"),
    );
    const normalized = normalizeProviderContextError(new Error("secret prompt and sk-sensitive-value"));
    expect(normalized).toEqual(providerContextSafeError("internal_failure"));
    expect(JSON.stringify(normalized)).not.toMatch(/secret prompt|sk-sensitive/);
    expect(normalized.message.length).toBeLessThanOrEqual(PROVIDER_CONTEXT_LIMITS.safeErrorMessageLength);

    const controller = new AbortController();
    controller.abort();
    expect(normalizeProviderContextError(new Error("anything"), controller.signal).code).toBe("cancelled");
    expect(() => parseProviderContextSafeError({
      ...providerContextSafeError("internal_failure"),
      message: "provider said: private prompt",
    })).toThrow(/fixed safe message/);
  });

  it("exports frozen bounded vocabularies", () => {
    expect(PROVIDER_CONTEXT_ERROR_CODES).toContain("internal_failure");
    expect(PROVIDER_CONTEXT_INVALIDATION_REASONS).toContain("canonical_history_changed");
    expect(PROVIDER_CONTEXT_UNSUPPORTED_REASONS).toContain("provider_not_supported");
    expect(Object.isFrozen(PROVIDER_CONTEXT_LIMITS)).toBe(true);
    expect(Object.isFrozen(PROVIDER_CONTEXT_ERROR_CODES)).toBe(true);
  });
});
