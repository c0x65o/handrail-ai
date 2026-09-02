import { describe, expect, it } from "vitest";

import { postgres, type PostgresPoolLike } from "../src/postgres/index.js";
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext } from "../src/server/assistant.js";
import type { ConversationTransport } from "../src/transports/types.js";
import type { ChatRequest, StreamEvent } from "../src/protocol.js";

const pool: PostgresPoolLike = {
  async query<TRow extends Record<string, unknown>>() { return { rows: [] as TRow[], rowCount: 0 }; },
  async connect() { throw new Error("not used"); },
};

const transport: ConversationTransport<StreamEvent, ChatRequest> = {
  capabilities: {
    authoritativeCancellation: { supported: false }, documentInput: { supported: false },
    attachmentUpload: { supported: false }, presence: { supported: false }, synchronization: { supported: false },
  },
  async startTurn() { throw new Error("not used"); },
  async resumeTurn() { throw new Error("not used"); },
};

describe("createHandrailAssistant", () => {
  it("derives isolated persistence and transports only from authenticated context", async () => {
    const scopes: string[] = [];
    const assistant = await createHandrailAssistant({
      id: "aegis",
      instructions: "Protect the customer.",
      authorize: (request): HandrailAssistantAuthorizationContext => ({
        principalId: request.headers.get("x-user")!, tenantId: "tenant-a", scopeId: request.headers.get("x-user")!,
      }),
      persistence: postgres(pool),
      provider: {
        metadata: { provider_id: "test", model_id: "test-model", capabilities: {
          streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
          document_input: { supported: false }, citation_projection: { supported: true },
          provider_context: { supported: false }, context_window_tokens: null, max_output_tokens: null,
        } },
        createTransport(input) {
          scopes.push(`${input.context.tenantId}/${input.context.scopeId}`);
          expect(input.instructions).toEqual(["Protect the customer."]);
          return transport;
        },
      },
    });

    const capability = (user: string) => assistant.handle(new Request("https://example.test/api/assistant/aegis/capabilities", {
      headers: { "x-user": user },
    }));
    expect((await capability("alice")).status).toBe(200);
    expect((await capability("bob")).status).toBe(200);
    expect((await capability("alice")).status).toBe(200);
    expect(scopes).toEqual(["tenant-a/alice", "tenant-a/bob"]);
  });
});
