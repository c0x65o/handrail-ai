import { describe, expect, it } from "vitest";

import { createGoldenClient } from "../examples/golden-authenticated-app.js";
import { runGoldenHeadlessClient } from "../examples/golden-headless-client.js";

describe("authenticated integration golden paths", () => {
  it("runs an authenticated headless turn with server-owned model context", async () => {
    await expect(runGoldenHeadlessClient()).resolves.toBe(
      "Hello Ada. This response crossed the authenticated gateway.",
    );
  });

  it("creates and opens catalog conversations through multiple mode", async () => {
    const client = await createGoldenClient("multiple");
    try {
      const created = await client.resources.createConversation({
        title: "Golden thread",
        idempotencyKey: "golden-create-1" as never,
      });
      const runtime = await client.workspace!.open({
        conversationId: created.descriptor.conversationId,
        authorizationContext: {},
      });
      await runtime.sendMessage({
        content: "Hello",
        request: client.buildRequest({ content: "Hello" }),
      });

      expect(client.workspace!.getSnapshot()).toMatchObject({
        selectedConversationId: created.descriptor.conversationId,
        threads: [{ conversationId: created.descriptor.conversationId, turnStatus: "completed" }],
      });
      expect(runtime.getSnapshot().messages.at(-1)?.content[0]?.text).toContain("Hello Ada");
    } finally {
      await client.dispose();
    }
  });
});
