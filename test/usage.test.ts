import { describe, expect, it } from "vitest";

import {
  NORMALIZED_USAGE_RECEIPT_LIMITS,
  NORMALIZED_USAGE_RECEIPT_VERSION,
  NormalizedUsageReceiptValidationError,
  isNormalizedUsageReceipt,
  parseNormalizedUsageReceipt,
  projectProviderUsageToReceipt,
  type AuthoritativeAttribution,
  type ProviderUsage,
  type ProviderUsageReceiptContext,
} from "../src/index.js";

type Fixture = Record<string, unknown>;

const attribution: AuthoritativeAttribution = {
  organization: { id: "org_1", source: "server_derived", trust: "authoritative" },
  project: { id: "project_1", source: "server_derived", trust: "authoritative" },
  service_environment: {
    id: "environment_1",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: { id: "user_1", source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

const receipt = (): Fixture => ({
  version: NORMALIZED_USAGE_RECEIPT_VERSION,
  usage_receipt_id: "usage_1",
  conversation_id: "conversation_1",
  turn_id: "turn_1",
  logical_request_id: "logical_1",
  trace_id: "trace_1",
  attempt: { id: "attempt_1", index: 0 },
  continuation: { id: "continuation_1", index: 0 },
  provider_id: "openai",
  model_id: "gpt-5.1-mini",
  attribution,
  source: "provider",
  terminal_status: "completed",
  tokens: {
    input_tokens: { status: "reported", value: 100 },
    cached_input_tokens: { status: "reported", value: 25 },
    output_tokens: { status: "reported", value: 40 },
    reasoning_tokens: { status: "reported", value: 10 },
    total_tokens: { status: "reported", value: 140 },
  },
  provider_cost: {
    status: "reported",
    amount: "0.0012300",
    currency: "USD",
  },
});

const context = (
  overrides: Partial<ProviderUsageReceiptContext> = {},
): ProviderUsageReceiptContext => ({
  usage_receipt_id: "usage_1",
  conversation_id: "conversation_1",
  turn_id: "turn_1",
  logical_request_id: "logical_1",
  trace_id: "trace_1",
  attempt: { id: "attempt_1", index: 0 },
  continuation: { id: "continuation_1", index: 0 },
  provider_id: "fake-provider",
  model_id: "fake-model-v1",
  attribution,
  source: "provider",
  quality: "reported",
  terminal_status: "completed",
  ...overrides,
});

const providerUsage = (
  overrides: Partial<ProviderUsage> = {},
): ProviderUsage => ({
  input_tokens: 100,
  cached_input_tokens: 25,
  output_tokens: 40,
  reasoning_tokens: 10,
  total_tokens: 140,
  provider_cost: { known: true, amount: "0.0012300", currency: "USD" },
  ...overrides,
});

describe("normalized usage receipts", () => {
  it("strictly parses a receipt without changing exact decimal strings", () => {
    const fixture = receipt();
    const parsed = parseNormalizedUsageReceipt(fixture);

    expect(parsed).toBe(fixture);
    expect(parsed.provider_cost).toEqual({
      status: "reported",
      amount: "0.0012300",
      currency: "USD",
    });
    expect(isNormalizedUsageReceipt(fixture)).toBe(true);
  });

  it("preserves known zero separately from unavailable cost", () => {
    const knownZero = {
      ...receipt(),
      provider_cost: { status: "reported", amount: "0.0000", currency: "USD" },
    };
    const unavailable = {
      ...receipt(),
      provider_cost: { status: "unavailable" },
    };

    expect(parseNormalizedUsageReceipt(knownZero).provider_cost).toEqual(
      knownZero.provider_cost,
    );
    expect(parseNormalizedUsageReceipt(unavailable).provider_cost).toEqual({
      status: "unavailable",
    });
  });

  it("keeps reported, estimated, and unavailable quantity semantics explicit", () => {
    const fixture = receipt();
    fixture.tokens = {
      input_tokens: { status: "estimated", value: 0 },
      cached_input_tokens: { status: "unavailable" },
      output_tokens: { status: "reported", value: 5 },
      reasoning_tokens: { status: "unavailable" },
      total_tokens: { status: "estimated", value: 5 },
    };
    fixture.provider_cost = {
      status: "estimated",
      amount: "0",
      currency: "USD",
    };

    expect(parseNormalizedUsageReceipt(fixture)).toBe(fixture);
  });

  it("enforces total, cached-input subset, and reasoning subset invariants", () => {
    const invalidTokens = [
      { total_tokens: { status: "reported", value: 141 } },
      { cached_input_tokens: { status: "reported", value: 101 } },
      { reasoning_tokens: { status: "reported", value: 41 } },
    ];

    for (const replacement of invalidTokens) {
      const fixture = receipt();
      fixture.tokens = { ...(fixture.tokens as Fixture), ...replacement };
      expect(() => parseNormalizedUsageReceipt(fixture)).toThrow(
        NormalizedUsageReceiptValidationError,
      );
    }
  });

  it("requires totals to become unavailable together and rejects known subsets without parents", () => {
    const partialTotals = receipt();
    partialTotals.tokens = {
      ...(partialTotals.tokens as Fixture),
      input_tokens: { status: "unavailable" },
    };
    expect(() => parseNormalizedUsageReceipt(partialTotals)).toThrow(
      /must be available together/,
    );

    const knownSubset = receipt();
    knownSubset.tokens = {
      input_tokens: { status: "unavailable" },
      cached_input_tokens: { status: "reported", value: 0 },
      output_tokens: { status: "unavailable" },
      reasoning_tokens: { status: "unavailable" },
      total_tokens: { status: "unavailable" },
    };
    expect(() => parseNormalizedUsageReceipt(knownSubset)).toThrow(
      /cached_input_tokens.*input_tokens is unavailable/,
    );
  });

  it("distinguishes retries and tool continuations under one logical request", () => {
    const first = projectProviderUsageToReceipt(providerUsage(), context());
    const continuation = projectProviderUsageToReceipt(
      providerUsage(),
      context({
        usage_receipt_id: "usage_2",
        continuation: { id: "continuation_2", index: 1 },
      }),
    );
    const retry = projectProviderUsageToReceipt(
      providerUsage(),
      context({
        usage_receipt_id: "usage_3",
        attempt: { id: "attempt_2", index: 1 },
        continuation: { id: "continuation_3", index: 0 },
      }),
    );

    expect([first, continuation, retry].map((item) => item.logical_request_id)).toEqual([
      "logical_1",
      "logical_1",
      "logical_1",
    ]);
    expect(new Set([first.usage_receipt_id, continuation.usage_receipt_id, retry.usage_receipt_id])).toHaveLength(3);
    expect(continuation.continuation.index).toBe(1);
    expect(retry.attempt.index).toBe(1);
  });

  it("links the authoritative attribution snapshot and does not retain its reference", () => {
    const parsed = projectProviderUsageToReceipt(providerUsage(), context());

    expect(parsed.attribution).toEqual(attribution);
    expect(parsed.attribution).not.toBe(attribution);
    expect(parsed.attribution.organization).not.toBe(attribution.organization);
  });

  it("losslessly projects every ProviderUsage field", () => {
    const usage = providerUsage();
    const parsed = projectProviderUsageToReceipt(usage, context());

    expect(parsed.tokens).toEqual({
      input_tokens: { status: "reported", value: usage.input_tokens },
      cached_input_tokens: {
        status: "reported",
        value: usage.cached_input_tokens,
      },
      output_tokens: { status: "reported", value: usage.output_tokens },
      reasoning_tokens: { status: "reported", value: usage.reasoning_tokens },
      total_tokens: { status: "reported", value: usage.total_tokens },
    });
    expect(parsed.provider_cost).toEqual({
      status: "reported",
      amount: "0.0012300",
      currency: "USD",
    });
  });

  it("projects estimated and unavailable provider values without inventing zero", () => {
    const estimated = projectProviderUsageToReceipt(
      providerUsage({ provider_cost: { known: true, amount: "0", currency: "USD" } }),
      context({ quality: "estimated" }),
    );
    const unavailable = projectProviderUsageToReceipt(
      providerUsage({ provider_cost: { known: false } }),
      context(),
    );

    expect(estimated.tokens.input_tokens.status).toBe("estimated");
    expect(estimated.provider_cost).toEqual({
      status: "estimated",
      amount: "0",
      currency: "USD",
    });
    expect(unavailable.provider_cost).toEqual({ status: "unavailable" });
  });

  it("rejects unsafe numbers and malformed exact decimal costs", () => {
    for (const amount of ["-1", ".1", "01.2", "1e-3", "NaN", 0.1]) {
      const fixture = receipt();
      fixture.provider_cost = { status: "reported", amount, currency: "USD" };
      expect(() => parseNormalizedUsageReceipt(fixture)).toThrow(/amount/);
    }

    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      const fixture = receipt();
      fixture.tokens = {
        ...(fixture.tokens as Fixture),
        cached_input_tokens: { status: "reported", value },
      };
      expect(() => parseNormalizedUsageReceipt(fixture)).toThrow(
        /non-negative safe integer/,
      );
    }
  });

  it("bounds receipt, provider, model, attribution, and currency strings", () => {
    const cases: Array<[string, Fixture]> = [
      [
        "logical_request_id",
        {
          ...receipt(),
          logical_request_id: "x".repeat(
            NORMALIZED_USAGE_RECEIPT_LIMITS.identifierLength + 1,
          ),
        },
      ],
      [
        "provider_id",
        {
          ...receipt(),
          provider_id: "x".repeat(
            NORMALIZED_USAGE_RECEIPT_LIMITS.providerIdLength + 1,
          ),
        },
      ],
      [
        "model_id",
        {
          ...receipt(),
          model_id: "x".repeat(
            NORMALIZED_USAGE_RECEIPT_LIMITS.modelIdLength + 1,
          ),
        },
      ],
      [
        "organization",
        {
          ...receipt(),
          attribution: {
            ...attribution,
            organization: {
              ...attribution.organization,
              id: "x".repeat(
                NORMALIZED_USAGE_RECEIPT_LIMITS.identifierLength + 1,
              ),
            },
          },
        },
      ],
      [
        "currency",
        {
          ...receipt(),
          provider_cost: { status: "reported", amount: "1", currency: "USDX" },
        },
      ],
    ];

    for (const [path, fixture] of cases) {
      expect(() => parseNormalizedUsageReceipt(fixture)).toThrow(
        new RegExp(path),
      );
    }
  });

  it("rejects credentials and all provider-native or arbitrary payload fields", () => {
    for (const forbidden of [
      { credentials: { api_key: "redacted" } },
      { headers: { authorization: "redacted" } },
      { provider_request: {} },
      { provider_response: {} },
      { native_payload: {} },
      { metadata: { debug: true } },
    ]) {
      expect(() =>
        parseNormalizedUsageReceipt({ ...receipt(), ...forbidden }),
      ).toThrow(/not a supported field/);
    }

    expect(() =>
      parseNormalizedUsageReceipt({
        ...receipt(),
        model_id: "sk-secretmaterial1234",
      }),
    ).toThrow(/credential material/);
  });

  it("rejects malformed, open, or non-authoritative receipts", () => {
    const malformed = [
      null,
      [],
      { ...receipt(), version: 2 },
      { ...receipt(), terminal_status: "running" },
      { ...receipt(), attempt: { id: "attempt_1", index: -1 } },
      {
        ...receipt(),
        attribution: {
          ...attribution,
          project: { ...attribution.project, trust: "client_supplied" },
        },
      },
      {
        ...receipt(),
        tokens: {
          ...(receipt().tokens as Fixture),
          input_tokens: { status: "unavailable", value: 0 },
        },
      },
    ];

    for (const fixture of malformed) {
      expect(isNormalizedUsageReceipt(fixture)).toBe(false);
      expect(() => parseNormalizedUsageReceipt(fixture)).toThrow(
        NormalizedUsageReceiptValidationError,
      );
    }
  });
});
