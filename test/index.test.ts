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

  it("exports the headless approval coordinator", () => {
    expect(handrailAi.createApprovalCoordinator).toBeTypeOf("function");
    expect(handrailAi.APPROVAL_COORDINATOR_LIMITS).toBeTypeOf("object");
  });

  it("exports conversation title generation through the core entry point", () => {
    expect(handrailAi.CONVERSATION_TITLE_GENERATION_LIMITS).toBeTypeOf("object");
    expect(handrailAi.DEFAULT_CONVERSATION_TITLE).toBe("New conversation");
    expect(handrailAi.createConversationTitleGenerationContext).toBeTypeOf(
      "function",
    );
    expect(handrailAi.ConversationTitleGenerationService).toBeTypeOf("function");
    expect(handrailAi.ConversationTitleGenerationError).toBeTypeOf("function");
  });

  it("exports the provider-neutral realtime voice contract", () => {
    expect(handrailAi.REALTIME_VOICE_CONTRACT_VERSION).toBe(
      "handrail.realtime-voice.v1",
    );
    expect(handrailAi.parseRealtimeVoiceBootstrapRequest).toBeTypeOf("function");
    expect(handrailAi.createRealtimeVoiceClientSession).toBeTypeOf("function");
    expect(handrailAi.createIdempotentRealtimeVoiceSessionAuthority).toBeTypeOf(
      "function",
    );
  });
});
