import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  CONVERSATION_CATALOG_LIMITS,
  ConversationCatalogError,
  authorizeConversationCatalogRequest,
  compareConversationCatalogDescriptors,
  createConversationCatalogCursor,
  normalizeConversationCatalogError,
  paginateConversationCatalogDescriptors,
  parseArchiveConversationInput,
  parseClearConversationInput,
  parseConversationCatalogCapabilities,
  parseConversationCatalogCursor,
  parseConversationCatalogDescriptor,
  parseConversationCatalogIdempotencyKey,
  parseConversationCatalogMetadata,
  parseConversationCatalogOrder,
  parseConversationCatalogPageSize,
  parseConversationCatalogTitle,
  parseConversationCatalogVersion,
  parseCreateConversationInput,
  parseGetConversationInput,
  parseListConversationsInput,
  parsePermanentlyDeleteConversationInput,
  parseRenameConversationInput,
  parseRestoreConversationInput,
  type ArchiveConversationResult,
  type ConversationCatalog,
  type ConversationCatalogAuthorizationRequest,
  type ConversationCatalogCapability,
  type ConversationCatalogDescriptor,
  type ConversationCatalogMetadata,
  type PermanentlyDeleteConversationResult,
  type SupportedConversationCatalogCapability,
  type UnsupportedConversationCatalogCapability,
} from "../src/conversation/catalog.js";

const CREATED = "2026-08-01T00:00:00.000Z";

function descriptor(
  conversationId: string,
  updatedAt = CREATED,
  overrides: Record<string, unknown> = {},
): ConversationCatalogDescriptor {
  return parseConversationCatalogDescriptor({
    conversationId,
    title: `Conversation ${conversationId}`,
    createdAt: CREATED,
    updatedAt,
    version: 1,
    lifecycle: "active",
    archivedAt: null,
    metadata: { labels: ["durable"] },
    ...overrides,
  });
}

function expectInvalid(run: () => unknown): void {
  expect(run).toThrowError(
    expect.objectContaining({
      name: "ConversationCatalogError",
      code: "invalid_input",
      message: "The conversation catalog request is invalid.",
    }),
  );
}

describe("ConversationCatalog descriptor validation", () => {
  it("parses and freezes the exact bounded durable descriptor shape", () => {
    const parsed = descriptor("conversation-1");

    expect(parsed).toEqual({
      conversationId: "conversation-1",
      title: "Conversation conversation-1",
      createdAt: CREATED,
      updatedAt: CREATED,
      version: 1,
      lifecycle: "active",
      archivedAt: null,
      metadata: { labels: ["durable"] },
    });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.metadata)).toBe(true);
    expect(Object.isFrozen(parsed.metadata.labels)).toBe(true);
  });

  it("requires consistent timestamps and lifecycle state", () => {
    expectInvalid(() => descriptor("id", "2026-07-01T00:00:00.000Z"));
    expectInvalid(() => descriptor("id", CREATED, { createdAt: "not-a-date" }));
    expectInvalid(() => descriptor("id", CREATED, { archivedAt: CREATED }));
    expectInvalid(() =>
      descriptor("id", "2026-08-02T00:00:00.000Z", {
        lifecycle: "archived",
        archivedAt: "2026-08-03T00:00:00.000Z",
      }));

    const archived = descriptor("archived", "2026-08-03T00:00:00.000Z", {
      lifecycle: "archived",
      archivedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(archived.lifecycle).toBe("archived");
  });

  it.each([
    ["messages", [{ role: "user", content: "private" }]],
    ["prompt", "private prompt"],
    ["transcript", "private transcript"],
    ["tool_inputs", { query: "private" }],
    ["toolResults", [{ secret: true }]],
    ["attachment", { data: "binary" }],
    ["content_reference", "content_ref:abc"],
    ["credential", "value"],
    ["accessToken", "value"],
    ["authorization_context", { role: "admin" }],
    ["provider_id", "native-provider-id"],
    ["providerConfig", { model: "native-model" }],
    ["model_id", "native-model"],
  ])("rejects forbidden metadata field %s", (field, value) => {
    expectInvalid(() =>
      descriptor("id", CREATED, { metadata: { [field]: value } }));
  });

  it.each([
    "Bearer super-secret-token",
    "sk-this-is-a-secret",
    "data:application/pdf;base64,AAAA",
    "blob:https://example.test/reference",
    "attachment-ref:opaque-1",
    "-----BEGIN PRIVATE KEY-----",
  ])("rejects credential or content-reference metadata values", (value) => {
    expectInvalid(() => descriptor("id", CREATED, { metadata: { label: value } }));
  });

  it("rejects extra descriptor fields even when their values look bounded", () => {
    for (const [field, value] of [
      ["messages", []],
      ["attachmentIds", []],
      ["providerNativeId", "provider-1"],
      ["credentials", "redacted"],
    ] as const) {
      expectInvalid(() => descriptor("id", CREATED, { [field]: value }));
    }
  });

  it("enforces every metadata structural bound", () => {
    expectInvalid(() =>
      parseConversationCatalogMetadata({
        ["k".repeat(CONVERSATION_CATALOG_LIMITS.metadataKeyLength + 1)]: true,
      }));
    expectInvalid(() =>
      parseConversationCatalogMetadata({
        label: "x".repeat(CONVERSATION_CATALOG_LIMITS.metadataStringLength + 1),
      }));
    expectInvalid(() =>
      parseConversationCatalogMetadata({
        list: Array.from({
          length: CONVERSATION_CATALOG_LIMITS.metadataArrayLength + 1,
        }, () => true),
      }));
    expectInvalid(() =>
      parseConversationCatalogMetadata(
        Object.fromEntries(
          Array.from(
            { length: CONVERSATION_CATALOG_LIMITS.metadataObjectKeys + 1 },
            (_, index) => [`key-${index}`, true],
          ),
        ),
      ));
    expectInvalid(() =>
      parseConversationCatalogMetadata({ a: { b: { c: { d: { e: true } } } } }));
    expectInvalid(() =>
      parseConversationCatalogMetadata({
        values: Array.from(
          { length: CONVERSATION_CATALOG_LIMITS.metadataArrayLength },
          (_, index) => ({ index, value: true, another: false, final: null }),
        ),
      }));
    expectInvalid(() =>
      parseConversationCatalogMetadata(
        Object.fromEntries(
          Array.from(
            { length: CONVERSATION_CATALOG_LIMITS.metadataObjectKeys },
            (_, index) => [
              `key-${index}`,
              "x".repeat(CONVERSATION_CATALOG_LIMITS.metadataStringLength),
            ],
          ),
        ),
      ));
    expectInvalid(() => parseConversationCatalogMetadata({ score: Infinity }));
  });
});

describe("ConversationCatalog input bounds", () => {
  it("normalizes titles and rejects empty, control, and oversized titles", () => {
    expect(parseConversationCatalogTitle("  Safe title  ")).toBe("Safe title");
    expectInvalid(() => parseConversationCatalogTitle("   "));
    expectInvalid(() => parseConversationCatalogTitle("bad\nline"));
    expectInvalid(() =>
      parseConversationCatalogTitle(
        "x".repeat(CONVERSATION_CATALOG_LIMITS.titleLength + 1),
      ));
  });

  it("rejects malformed and oversized identifiers and idempotency keys", () => {
    expectInvalid(() =>
      parseCreateConversationInput({
        authorizationContext: "host",
        conversationId: "has spaces",
        idempotencyKey: "create-1",
      }));
    expectInvalid(() =>
      parseGetConversationInput({
        authorizationContext: "host",
        conversationId: "x".repeat(CONVERSATION_CATALOG_LIMITS.identifierLength + 1),
      }));
    expectInvalid(() => parseConversationCatalogIdempotencyKey("bad/key"));
    expectInvalid(() =>
      parseConversationCatalogIdempotencyKey(
        "x".repeat(CONVERSATION_CATALOG_LIMITS.idempotencyKeyLength + 1),
      ));
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid expected version %s",
    (version) => expectInvalid(() => parseConversationCatalogVersion(version)),
  );

  it.each([0, -1, 1.5, CONVERSATION_CATALOG_LIMITS.pageSizeMaximum + 1])(
    "rejects invalid page size %s",
    (pageSize) => expectInvalid(() => parseConversationCatalogPageSize(pageSize)),
  );

  it("applies explicit page/order defaults and rejects malformed ordering", () => {
    expect(parseConversationCatalogPageSize()).toBe(
      CONVERSATION_CATALOG_LIMITS.pageSizeDefault,
    );
    expect(parseConversationCatalogOrder()).toEqual({
      field: "updated_at",
      direction: "desc",
    });
    expectInvalid(() =>
      parseConversationCatalogOrder({ field: "title", direction: "asc" }));
    expectInvalid(() =>
      parseConversationCatalogOrder({
        field: "updated_at",
        direction: "sideways",
      }));
    expectInvalid(() =>
      parseConversationCatalogOrder({
        field: "updated_at",
        direction: "asc",
        nulls: "first",
      }));
  });

  it("parses each operation-specific input and enforces mutation fields", () => {
    const base = {
      authorizationContext: { host: "request-context" },
      conversationId: "conversation-1",
      expectedVersion: 7,
      idempotencyKey: "mutation-1",
    };
    expect(parseCreateConversationInput({
      authorizationContext: base.authorizationContext,
      conversationId: base.conversationId,
      title: "First",
      metadata: { labels: ["one"] },
      idempotencyKey: "create-1",
    })).toMatchObject({ title: "First", idempotencyKey: "create-1" });
    expect(parseRenameConversationInput({ ...base, title: "Renamed" }))
      .toMatchObject({ expectedVersion: 7, title: "Renamed" });
    expect(parseClearConversationInput(base)).toMatchObject(base);
    expect(parseArchiveConversationInput(base)).toMatchObject(base);
    expect(parseRestoreConversationInput(base)).toMatchObject(base);
    expect(parsePermanentlyDeleteConversationInput(base)).toMatchObject(base);

    for (const parser of [
      parseClearConversationInput,
      parseArchiveConversationInput,
      parseRestoreConversationInput,
      parsePermanentlyDeleteConversationInput,
    ]) {
      expectInvalid(() => parser({ ...base, expectedVersion: undefined }));
      expectInvalid(() => parser({ ...base, idempotencyKey: undefined }));
      expectInvalid(() => parser({ ...base, unexpected: true }));
    }
  });
});

describe("ConversationCatalog deterministic keyset pagination", () => {
  const rows = [
    descriptor("conversation-c", "2026-08-03T00:00:00.000Z"),
    descriptor("conversation-b", "2026-08-02T00:00:00.000Z"),
    descriptor("conversation-a", "2026-08-02T00:00:00.000Z"),
    descriptor("conversation-d", "2026-08-01T00:00:00.000Z"),
  ];

  it("orders by the requested timestamp with an ascending ID tie-breaker", () => {
    const sorted = [...rows].sort((left, right) =>
      compareConversationCatalogDescriptors(left, right, {
        field: "updated_at",
        direction: "desc",
      }));
    expect(sorted.map(({ conversationId }) => conversationId)).toEqual([
      "conversation-c",
      "conversation-a",
      "conversation-b",
      "conversation-d",
    ]);
  });

  it("continues strictly after a cursor without duplicates or gaps", () => {
    const first = paginateConversationCatalogDescriptors(rows, {
      pageSize: 2,
      order: { field: "updated_at", direction: "desc" },
    });
    expect(first.items.map(({ conversationId }) => conversationId)).toEqual([
      "conversation-c",
      "conversation-a",
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = paginateConversationCatalogDescriptors(rows, {
      pageSize: 2,
      order: first.order,
      cursor: first.nextCursor,
    });
    expect(second.items.map(({ conversationId }) => conversationId)).toEqual([
      "conversation-b",
      "conversation-d",
    ]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("rejects malformed, oversized, non-canonical, and wrong-order cursors", () => {
    const cursor = createConversationCatalogCursor(rows[0]!, {
      field: "updated_at",
      direction: "desc",
    });
    expect(parseConversationCatalogCursor(cursor, {
      field: "updated_at",
      direction: "desc",
    })).toBe(cursor);
    expectInvalid(() => parseConversationCatalogCursor("not-a-cursor"));
    expectInvalid(() =>
      parseConversationCatalogCursor(
        "x".repeat(CONVERSATION_CATALOG_LIMITS.cursorLength + 1),
      ));
    expectInvalid(() =>
      parseConversationCatalogCursor(cursor.replace("%3A", "%3a")));
    expectInvalid(() =>
      parseConversationCatalogCursor(cursor, {
        field: "created_at",
        direction: "desc",
      }));
  });

  it("validates list filters and binds a cursor to its order", () => {
    const cursor = createConversationCatalogCursor(rows[0]!);
    expect(parseListConversationsInput({
      authorizationContext: "host",
      pageSize: 1,
      cursor,
    })).toMatchObject({ lifecycle: "active", pageSize: 1, cursor });
    expectInvalid(() =>
      parseListConversationsInput({
        authorizationContext: "host",
        lifecycle: "deleted",
      }));
    expectInvalid(() =>
      parseListConversationsInput({
        authorizationContext: "host",
        order: { field: "created_at", direction: "desc" },
        cursor,
      }));
  });
});

describe("ConversationCatalog authorization, capabilities, and safe errors", () => {
  it("invokes authorization with the exact pre-lookup shape and no record", async () => {
    const authorizationContext = { subject: "host-owned" };
    const authorize = vi.fn(async (
      request: ConversationCatalogAuthorizationRequest<typeof authorizationContext>,
    ) => {
      expect(request.action).toBe("rename");
      return "allow" as const;
    });

    await authorizeConversationCatalogRequest(authorize, {
      action: "rename",
      authorizationContext,
      conversationId: descriptor("private-record").conversationId,
    });

    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith({
      action: "rename",
      authorizationContext,
      conversationId: "private-record",
    });
    expect(Object.keys(authorize.mock.calls[0]![0])).toEqual([
      "action",
      "authorizationContext",
      "conversationId",
    ]);
    expect(authorize.mock.calls[0]![0]).not.toHaveProperty("descriptor");
    expect(authorize.mock.calls[0]![0]).not.toHaveProperty("expectedVersion");
  });

  it("normalizes denial and host exceptions without leaking context or causes", async () => {
    const secret = "host-secret-never-disclosed";
    await expect(authorizeConversationCatalogRequest(
      () => "deny",
      { action: "list", authorizationContext: { secret } },
    )).rejects.toMatchObject({ code: "forbidden", operation: "list" });
    await expect(authorizeConversationCatalogRequest(
      () => { throw new Error(secret); },
      {
        action: "get",
        authorizationContext: { secret },
        conversationId: descriptor("conversation-1").conversationId,
      },
    )).rejects.not.toHaveProperty("cause");
    try {
      await authorizeConversationCatalogRequest(
        () => { throw new Error(secret); },
        { action: "list", authorizationContext: { secret } },
      );
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("parses discriminated capabilities and narrows support", () => {
    const capabilities = parseConversationCatalogCapabilities({
      rename: { supported: true },
      clear: { supported: true },
      archive: { supported: true },
      restore: { supported: false, reason: "policy_disabled" },
      permanentDelete: { supported: false, reason: "storage_limitation" },
    });
    expect(capabilities.restore).toEqual({
      supported: false,
      reason: "policy_disabled",
    });
    expectInvalid(() =>
      parseConversationCatalogCapabilities({
        ...capabilities,
        archive: { supported: false, reason: "provider_unsupported" },
      }));
  });

  it("provides fixed normalized errors for every contract failure class", () => {
    const codes = [
      "invalid_input",
      "not_found",
      "version_conflict",
      "idempotency_conflict",
      "forbidden",
      "unsupported",
      "unavailable",
    ] as const;
    for (const code of codes) {
      const error = new ConversationCatalogError(code, "archive");
      expect(error).toMatchObject({ code, operation: "archive" });
      expect(error).not.toHaveProperty("record");
      expect(error).not.toHaveProperty("context");
      expect(error).not.toHaveProperty("cause");
      expect(error.message).not.toContain("provider");
      expect(error.message).not.toContain("credential");
    }
    const normalized = normalizeConversationCatalogError(
      new Error("database password=private provider stack"),
      "get",
    );
    expect(normalized).toMatchObject({
      code: "unavailable",
      operation: "get",
      retryable: true,
      message: "The conversation catalog is unavailable.",
    });
    expect(normalized).not.toHaveProperty("cause");
  });
});

describe("ConversationCatalog type-level lifecycle contract", () => {
  it("exposes all operations with optimistic and idempotent mutation inputs", () => {
    expectTypeOf<ConversationCatalog<string>>().toHaveProperty("list");
    expectTypeOf<ConversationCatalog<string>>().toHaveProperty("create");
    expectTypeOf<ConversationCatalog<string>>().toHaveProperty("get");
    expectTypeOf<ConversationCatalog<string>>().toHaveProperty("rename");
    expectTypeOf<ConversationCatalog<string>>().toHaveProperty("clear");
    expectTypeOf<ConversationCatalog<string>>().toHaveProperty("archive");
    expectTypeOf<ConversationCatalog<string>>().toHaveProperty("restore");
    expectTypeOf<ConversationCatalog<string>>().toHaveProperty("permanentlyDelete");

    const clear = parseClearConversationInput<string>({
      authorizationContext: "host",
      conversationId: "conversation-1",
      expectedVersion: 2,
      idempotencyKey: "clear-1",
    });
    expectTypeOf(clear.expectedVersion).toBeNumber();
    expectTypeOf(clear.idempotencyKey).toBeString();
  });

  it("distinguishes reversible archive, identity-preserving clear, and delete", () => {
    const active = descriptor("conversation-1", "2026-08-02T00:00:00.000Z", {
      version: 2,
    });
    if (active.lifecycle !== "active") throw new Error("expected active fixture");
    const archivedDescriptor = descriptor(
      "conversation-1",
      "2026-08-03T00:00:00.000Z",
      {
        lifecycle: "archived",
        archivedAt: "2026-08-03T00:00:00.000Z",
        version: 3,
      },
    );
    if (archivedDescriptor.lifecycle !== "archived") {
      throw new Error("expected archived fixture");
    }
    const archived: ArchiveConversationResult = {
      operation: "archive",
      status: "archived",
      descriptor: archivedDescriptor,
    };
    const deleted: PermanentlyDeleteConversationResult = {
      operation: "permanent_delete",
      status: "deleted",
      conversationId: active.conversationId,
      deletedVersion: parseConversationCatalogVersion(3),
    };

    expect(archived.descriptor.conversationId).toBe(active.conversationId);
    expect(archived.descriptor.lifecycle).toBe("archived");
    expect(deleted).not.toHaveProperty("descriptor");
    expect(deleted).not.toHaveProperty("archivedAt");
  });
});

function proveCapabilityNarrowing(capability: ConversationCatalogCapability): void {
  if (capability.supported) {
    expectTypeOf(capability).toEqualTypeOf<SupportedConversationCatalogCapability>();
  } else {
    expectTypeOf(capability).toEqualTypeOf<UnsupportedConversationCatalogCapability>();
    expectTypeOf(capability.reason).toBeString();
  }
}

function proveResultNarrowing(
  result: ArchiveConversationResult | PermanentlyDeleteConversationResult,
): ConversationCatalogMetadata | undefined {
  if (result.operation === "archive") {
    return result.descriptor.metadata;
  }
  expectTypeOf(result.deletedVersion).toBeNumber();
  return undefined;
}

void proveCapabilityNarrowing;
void proveResultNarrowing;
