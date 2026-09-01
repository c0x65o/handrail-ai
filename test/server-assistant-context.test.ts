import { describe, expect, it, vi } from "vitest";

import {
  SERVER_ASSISTANT_CONTEXT_VERSION,
  createAssistantGatewayAuthorizer,
  createServerAssistantContext,
  serverAssistantInstructions,
} from "../src/server/assistant-context.js";

const attribution = {
  organizationId: "org-1",
  projectId: "project-1",
  serviceEnvironmentId: "production",
  sessionId: "session-1",
};

describe("server-owned assistant context", () => {
  it("keeps authority, model disclosure, tools, presence, and client hints separate", () => {
    const context = createServerAssistantContext({
      principal: { principalId: "user-1", companyId: "company-1" },
      attribution,
      model: {
        instructions: ["Help with the signed-in account."],
        profile: { displayName: "Ada", plan: "pro" },
      },
      tools: { companyId: "company-1", permissions: ["invoices:read"] },
      presence: { participantId: "user-1", sessionId: "session-1", participantKind: "human" },
      clientCorrelationHints: {
        known_user: { external_id: "attacker-claimed-user", source: "client", trust: "untrusted_correlation_hint" },
      },
    });

    expect(context.version).toBe(SERVER_ASSISTANT_CONTEXT_VERSION);
    expect(context.attribution.known_user).toEqual({
      id: "user-1", source: "server_derived", trust: "authoritative",
    });
    expect(context.clientCorrelationHints.known_user?.external_id).toBe("attacker-claimed-user");
    expect(context.tools).toEqual({ companyId: "company-1", permissions: ["invoices:read"] });
    expect(serverAssistantInstructions(context)).toBe(
      "Help with the signed-in account.\n\n" +
      'Server-authoritative user context (JSON): {"displayName":"Ada","plan":"pro"}',
    );
    expect(serverAssistantInstructions(context)).not.toContain("attacker-claimed-user");
  });

  it("authenticates first and builds every downstream context from that principal", async () => {
    const resolvePrincipal = vi.fn(() => ({ principalId: "server-user", companyId: "company-1" }));
    const buildContext = vi.fn(({ principal }) => ({
      attribution,
      model: { profile: { companyId: principal.companyId } },
      tools: { companyId: principal.companyId },
    }));
    const authorize = createAssistantGatewayAuthorizer({ resolvePrincipal, buildContext });
    const request = new Request("https://app.test/ai/turns/start", {
      method: "POST",
      body: JSON.stringify({ principalId: "client-attacker" }),
    });

    const result = await authorize(request, "start");

    expect(resolvePrincipal).toHaveBeenCalledWith(request, "start");
    expect(buildContext).toHaveBeenCalledWith(expect.objectContaining({
      principal: { principalId: "server-user", companyId: "company-1" },
      action: "start",
    }));
    expect(result.principalId).toBe("server-user");
    expect(result.assistant.attribution.known_user.id).toBe("server-user");
    expect(result.assistant.model.profile).toEqual({ companyId: "company-1" });
  });

  it("bounds model-visible profile and instructions", () => {
    expect(() => createServerAssistantContext({
      principal: { principalId: "user-1" }, attribution, tools: {},
      model: { instructions: [""] },
    })).toThrow("model instructions are invalid");
    expect(() => createServerAssistantContext({
      principal: { principalId: "user-1" }, attribution, tools: {},
      model: { profile: { oversized: "x".repeat(17_000) } },
    })).toThrow("model profile is too large");
  });
});
