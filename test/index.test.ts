import { describe, expect, it } from "vitest";

import * as handrailAi from "../src/index.js";

describe("package entry point", () => {
  it("loads as an ESM module", () => {
    expect(handrailAi).toBeTypeOf("object");
  });

  it("exports the storage-neutral conversation catalog contract helpers", () => {
    expect(handrailAi.CONVERSATION_CATALOG_LIMITS).toBeTypeOf("object");
    expect(handrailAi.parseConversationCatalogDescriptor).toBeTypeOf("function");
    expect(handrailAi.paginateConversationCatalogDescriptors).toBeTypeOf("function");
    expect(handrailAi.authorizeConversationCatalogRequest).toBeTypeOf("function");
    expect(handrailAi.ConversationCatalogError).toBeTypeOf("function");
  });
});
