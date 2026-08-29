import { describe, expect, it } from "vitest";

import {
  CITATION_ATTACHMENT_TARGET_TYPES,
  CITATION_LIMITS,
  CITATION_SAFE_WEB_SCHEMES,
  CITATION_SOURCE_TYPES,
  CitationValidationError,
  deduplicateCitationRecords,
  isCitation,
  isCitationSource,
  normalizeCitation,
  normalizeCitationRecords,
  normalizeCitationSource,
} from "../src/citations.js";

const webSource = (overrides: Record<string, unknown> = {}) => ({
  source_id: "source-web",
  type: "web",
  label: "Public reference",
  locator: "https://example.com/reference",
  ...overrides,
});

const citation = (overrides: Record<string, unknown> = {}) => ({
  citation_id: "citation-1",
  source_id: "source-web",
  order: 0,
  target: { type: "assistant_message", message_id: "message-1" },
  ...overrides,
});

describe("provider-neutral citation records", () => {
  it("exports the bounded provider-neutral vocabulary", () => {
    expect(CITATION_SOURCE_TYPES).toEqual(["web", "document", "tool"]);
    expect(CITATION_ATTACHMENT_TARGET_TYPES).toEqual([
      "assistant_message",
      "tool_result",
    ]);
    expect(CITATION_SAFE_WEB_SCHEMES).toEqual(["http:", "https:"]);
    expect(CITATION_LIMITS.sourcesPerRecordSet).toBeGreaterThan(0);
    expect(CITATION_LIMITS.citationsPerRecordSet).toBeGreaterThan(0);
    expect(Object.isFrozen(CITATION_SOURCE_TYPES)).toBe(true);
    expect(Object.isFrozen(CITATION_ATTACHMENT_TARGET_TYPES)).toBe(true);
    expect(Object.isFrozen(CITATION_SAFE_WEB_SCHEMES)).toBe(true);
    expect(Object.isFrozen(CITATION_LIMITS)).toBe(true);
  });

  it("normalizes valid web, document, and tool sources", () => {
    expect(
      normalizeCitationSource(
        webSource({
          source_id: "  source-web  ",
          label: "  Public reference  ",
          locator: "HTTPS://EXAMPLE.COM:443/reference?q=1#section",
        }),
      ),
    ).toEqual({
      source_id: "source-web",
      type: "web",
      label: "Public reference",
      locator: "https://example.com/reference?q=1#section",
    });
    expect(
      normalizeCitationSource({
        source_id: "source-document",
        type: "document",
        label: "Employee handbook",
        locator: "handbook.pdf#page=12",
      }),
    ).toEqual({
      source_id: "source-document",
      type: "document",
      label: "Employee handbook",
      locator: "handbook.pdf#page=12",
    });
    expect(
      normalizeCitationSource({
        source_id: "source-tool",
        type: "tool",
        label: "Catalog lookup",
        locator: "catalog:result-7",
      }),
    ).toEqual({
      source_id: "source-tool",
      type: "tool",
      label: "Catalog lookup",
      locator: "catalog:result-7",
    });
    expect(isCitationSource(webSource())).toBe(true);
  });

  it("normalizes explicit assistant-message and tool-result targets", () => {
    expect(normalizeCitation(citation())).toEqual(citation());
    expect(
      normalizeCitation(
        citation({
          citation_id: "citation-tool",
          target: { type: "tool_result", tool_call_id: "tool-call-1" },
        }),
      ),
    ).toEqual({
      citation_id: "citation-tool",
      source_id: "source-web",
      order: 0,
      target: { type: "tool_result", tool_call_id: "tool-call-1" },
    });
    expect(isCitation(citation())).toBe(true);
  });

  it("retains first-seen collection order while removing exact duplicates", () => {
    const records = deduplicateCitationRecords(
      [
        webSource({ source_id: "source-b", label: "Source B" }),
        webSource({ source_id: "source-a", label: "Source A" }),
        webSource({ source_id: " source-b ", label: " Source B " }),
      ],
      [
        citation({ citation_id: "citation-b", source_id: "source-b", order: 9 }),
        citation({ citation_id: "citation-a", source_id: "source-a", order: 0 }),
        citation({ citation_id: " citation-b ", source_id: "source-b", order: 9 }),
      ],
    );

    expect(records.sources.map((source) => source.source_id)).toEqual([
      "source-b",
      "source-a",
    ]);
    expect(records.citations.map((item) => item.citation_id)).toEqual([
      "citation-b",
      "citation-a",
    ]);
    expect(records.citations.map((item) => item.order)).toEqual([9, 0]);
  });

  it("rejects conflicting reuse of source and citation identities", () => {
    expect(() =>
      deduplicateCitationRecords(
        [webSource(), webSource({ label: "Different source" })],
        [],
      ),
    ).toThrow(/sources.*conflicts with an earlier record/);
    expect(() =>
      deduplicateCitationRecords(
        [webSource()],
        [citation(), citation({ order: 1 })],
      ),
    ).toThrow(/citations.*conflicts with an earlier record/);
  });

  it("rejects malformed identifiers, orders, targets, and source links", () => {
    for (const [field, value] of [
      ["source_id", "source/unsafe"],
      ["source_id", ""],
      ["citation_id", "citation unsafe"],
    ] as const) {
      const action = field === "source_id"
        ? () => normalizeCitationSource(webSource({ [field]: value }))
        : () => normalizeCitation(citation({ [field]: value }));
      expect(action).toThrow(new RegExp(field));
    }
    for (const order of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => normalizeCitation(citation({ order }))).toThrow(/order/);
    }
    expect(() =>
      normalizeCitation(citation({ target: { type: "tool_result", result_id: "r1" } })),
    ).toThrow(/tool_call_id/);
    expect(() => normalizeCitation(citation({ target: { type: "message" } }))).toThrow(
      /target\.type/,
    );
    expect(() => normalizeCitationRecords({ sources: [webSource()], citations: [
      citation({ source_id: "missing-source" }),
    ] })).toThrow(/source_id.*same record set/);
    expect(isCitation(citation({ order: -1 }))).toBe(false);
  });

  it("rejects unsafe, credentialed, local, and private web locators", () => {
    const unsafeLocators = [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:password@example.com/",
      "https://example.com/reference?access_token=secret-value",
      "https://example.com/reference#api_key=secret-value",
      "https://localhost/reference",
      "https://docs.localhost/reference",
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://10.0.0.1/",
      "http://169.254.1.1/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[fe80::1]/",
      "http://[fc00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "not a URL",
    ];
    for (const locator of unsafeLocators) {
      expect(
        () => normalizeCitationSource(webSource({ locator })),
        locator,
      ).toThrow(CitationValidationError);
    }
  });

  it("enforces record counts, string limits, and total serialized UTF-8 bytes", () => {
    expect(() =>
      deduplicateCitationRecords(
        Array.from(
          { length: CITATION_LIMITS.sourcesPerRecordSet + 1 },
          (_, index) => webSource({ source_id: `source-${index}` }),
        ),
        [],
      ),
    ).toThrow(/at most .* records/);
    expect(() =>
      deduplicateCitationRecords(
        [webSource()],
        Array.from(
          { length: CITATION_LIMITS.citationsPerRecordSet + 1 },
          (_, index) => citation({ citation_id: `citation-${index}` }),
        ),
      ),
    ).toThrow(/at most .* records/);
    expect(() =>
      normalizeCitationSource(
        webSource({ source_id: "s".repeat(CITATION_LIMITS.identifierLength + 1) }),
      ),
    ).toThrow(/at most .* characters/);
    expect(() =>
      normalizeCitationSource(
        webSource({ label: "l".repeat(CITATION_LIMITS.labelLength + 1) }),
      ),
    ).toThrow(/at most .* characters/);
    expect(() =>
      normalizeCitationSource(
        webSource({ locator: `https://example.com/${"l".repeat(CITATION_LIMITS.locatorLength)}` }),
      ),
    ).toThrow(/at most .* characters/);

    const oversizedSources = Array.from(
      { length: CITATION_LIMITS.sourcesPerRecordSet },
      (_, index) => ({
        source_id: `document-${index}`,
        type: "document",
        label: "😀".repeat(CITATION_LIMITS.labelLength / 2),
        locator: `d${"x".repeat(CITATION_LIMITS.locatorLength - 1)}`,
      }),
    );
    expect(() => deduplicateCitationRecords(oversizedSources, [])).toThrow(
      /serialize to at most .* UTF-8 bytes/,
    );
  });

  it("rejects provider-native markers, unknown fields, and non-JSON objects", () => {
    for (const extra of [
      { provider: "openai" },
      { annotations: [] },
      { raw_snippet: "native text" },
      { response_block: {} },
      { metadata: { hidden: true } },
    ]) {
      expect(() => normalizeCitationSource({ ...webSource(), ...extra })).toThrow(
        /not a supported field/,
      );
    }
    expect(() => normalizeCitationSource(new Date())).toThrow(/plain JSON object/);
    expect(() => normalizeCitationSource(Object.assign(webSource(), {
      locator: { url: "https://example.com", provider: "native" },
    }))).toThrow(/locator.*string/);
    expect(() => normalizeCitationSource({
      source_id: "source-document",
      type: "document",
      label: "Document",
      locator: "document.pdf?token=secret-value",
    })).toThrow(/credential parameters/);
    const withSymbol = webSource() as Record<PropertyKey, unknown>;
    withSymbol[Symbol("native")] = "payload";
    expect(() => normalizeCitationSource(withSymbol)).toThrow(/string-named/);
    const withGetter = { ...webSource() };
    Object.defineProperty(withGetter, "label", { enumerable: true, get: () => "label" });
    expect(() => normalizeCitationSource(withGetter)).toThrow(/JSON data field/);
    const sourcesWithMarker = [webSource()];
    Object.assign(sourcesWithMarker, { provider_native: "hidden" });
    expect(() => deduplicateCitationRecords(sourcesWithMarker, [])).toThrow(
      /not a supported array field/,
    );
  });

  it("returns cloned deeply immutable records resistant to caller mutation", () => {
    const sourceInput = webSource();
    const citationInput = citation();
    const records = normalizeCitationRecords({
      sources: [sourceInput],
      citations: [citationInput],
    });

    sourceInput.label = "mutated input";
    (citationInput.target as Record<string, unknown>).message_id = "mutated-input";
    expect(records.sources[0]?.label).toBe("Public reference");
    expect(records.citations[0]?.target).toEqual({
      type: "assistant_message",
      message_id: "message-1",
    });
    expect(Object.isFrozen(records)).toBe(true);
    expect(Object.isFrozen(records.sources)).toBe(true);
    expect(Object.isFrozen(records.sources[0])).toBe(true);
    expect(Object.isFrozen(records.citations)).toBe(true);
    expect(Object.isFrozen(records.citations[0])).toBe(true);
    expect(Object.isFrozen(records.citations[0]?.target)).toBe(true);
    expect(() => {
      (records.sources as unknown as unknown[]).push(webSource());
    }).toThrow();
    expect(() => {
      (records.citations[0]?.target as unknown as Record<string, unknown>).type = "tool_result";
    }).toThrow();
  });
});
