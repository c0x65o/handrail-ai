import { describe, expect, it, vi } from "vitest";

import { postgres, type PostgresPoolLike } from "../src/postgres/index.js";
import { createHandrailAssistant, type HandrailAssistantAuthorizationContext,
  type HandrailAssistantProvider } from "../src/server/assistant.js";
import type { ConversationTransport } from "../src/transports/types.js";
import type { ChatRequest, StreamEvent } from "../src/protocol.js";
import { createToolPlugin } from "../src/tools/plugin.js";
import type { ApplicationToolExecutor } from "../src/tools/executor.js";
import { InMemoryConversationEventStore } from "../src/conversation/event-store.js";
import { InMemoryApprovalProposalStore } from "../src/conversation/approval-proposal-store.js";
import { InMemoryConversationCatalog } from "../src/conversation/in-memory-catalog.js";
import { InMemoryToolExecutionLedger } from "../src/tools/executor.js";
import { InMemoryDurableApplicationTurnStore } from "../src/transports/durable.js";
import type { PostgresAssistantPersistence, PostgresAssistantPersistenceBundle } from "../src/postgres/index.js";
import { parseConversationEvent } from "../src/conversation/events.js";

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
        attribution: {
          organization: { id: "org", source: "server_derived", trust: "authoritative" },
          project: { id: "project", source: "server_derived", trust: "authoritative" },
          service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
          known_user: { id: request.headers.get("x-user")!, source: "server_derived", trust: "authoritative" },
          session: { id: null, source: "server_derived", trust: "authoritative" },
          automation: { id: null, source: "server_derived", trust: "authoritative" },
        },
      }),
      persistence: postgres(pool),
      provider: {
        metadata: { provider_id: "test", model_id: "test-model", capabilities: {
          streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
          document_input: { supported: false }, citation_projection: { supported: true },
          provider_context: { supported: false, reason: "provider_not_supported" }, context_window_tokens: null, max_output_tokens: null,
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
    const first = await capability("alice");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, value: { resources: { titleGeneration: true },
      assistant: { id: "aegis", version: "handrail.assistant.v1",
        provider: { provider_id: "test", model_id: "test-model" } } } });
    expect((await capability("bob")).status).toBe(200);
    expect((await capability("alice")).status).toBe(200);
    expect(scopes).toEqual(["tenant-a/alice", "tenant-a/bob"]);
  });

  it("owns approval creation and audit, trusts authenticated decisions, and executes exactly once", async () => {
    type Context = HandrailAssistantAuthorizationContext;
    const context = (request: Request): Context => ({ principalId: request.headers.get("x-user") ?? "alice",
      tenantId: "tenant", scopeId: "alice", attribution: {
        organization: { id: "org", source: "server_derived", trust: "authoritative" },
        project: { id: "project", source: "server_derived", trust: "authoritative" },
        service_environment: { id: "env", source: "server_derived", trust: "authoritative" },
        known_user: { id: "alice", source: "server_derived", trust: "authoritative" },
        session: { id: null, source: "server_derived", trust: "authoritative" },
        automation: { id: null, source: "server_derived", trust: "authoritative" },
      } });
    const events = new InMemoryConversationEventStore();
    const approvals = new InMemoryApprovalProposalStore<Context>({ authorize: () => "allow" });
    const catalog = new InMemoryConversationCatalog<Context>({ authorize: () => "allow",
      createConversationId: () => "conversation-approved" as never });
    const durableTurns = new InMemoryDurableApplicationTurnStore();
    const bundle = { events, approvals, catalog, durableTurns, toolLedger: new InMemoryToolExecutionLedger(),
      usageReceiptSink: null, usageAdmissions: null } as unknown as PostgresAssistantPersistenceBundle<Context>;
    const persistence = { attachmentLimits: { maximumBytes: 1_000, acceptedMediaTypes: ["text/plain"],
      ttlMilliseconds: 60_000 }, persistence: {}, forScope: () => bundle } as unknown as PostgresAssistantPersistence;
    let exposed: Parameters<HandrailAssistantProvider<Context>["createTransport"]>[0]["tools"] | undefined;
    let executions = 0;
    const plugin = createToolPlugin<ApplicationToolExecutor<Context>, Context, Context, Context>({
      pluginId: "test.approval", version: "1.0.0", displayName: "Approval test",
      registrations: [{ definition: { name: "dangerous", description: "Dangerous operation",
        input_schema: { type: "object" } }, discover: () => true,
        executor: () => { executions += 1; return { done: true }; } }],
    });
    const assistant = await createHandrailAssistant<Context>({ id: "approval-test", authorize: async (request) => context(request),
      persistence, tools: [plugin], toolPolicy: () => ({ outcome: "external_approval_required" }),
      provider: { metadata: { provider_id: "test", model_id: "test", capabilities: {
        streaming: true, text: true, tool_calls: true, parallel_tool_calls: false, reasoning: false,
        document_input: { supported: false }, provider_context: { supported: false, reason: "provider_not_supported" },
        context_window_tokens: null, max_output_tokens: null } },
      createTransport(input) { exposed = input.tools; return transport; } } });
    await catalog.create({ authorizationContext: context(new Request("https://example.test")),
      idempotencyKey: "create-approved" as never });
    await events.append({ conversationId: "conversation-approved" as never, expectedRevision: null, events: [
      parseConversationEvent({ version: 1, event_id: "message-title", conversation_id: "conversation-approved",
        revision: 1, occurred_at: "2026-09-02T00:00:00.000Z", actor: { type: "user", id: "alice" },
        source: { type: "runtime" }, payload: { type: "message.created", message_id: "message-title",
          role: "user", content: [{ type: "text", text: "  Delete   record 42 safely  " }] } }),
    ] });
    await assistant.handle(new Request("https://example.test/capabilities", { headers: { "x-user": "alice" } }));
    const title = await assistant.handle(new Request("https://example.test/titles/generate", { method: "POST",
      headers: { "x-user": "alice", "content-type": "application/json" }, body: JSON.stringify({
        conversationId: "conversation-approved", idempotencyKey: "title-approved",
      }) }));
    expect(await title.json()).toMatchObject({ ok: true, value: "Delete record 42 safely" });
    const call = { tool_call_id: "call-approved", name: "dangerous", arguments: { id: "42" } };
    expect((await exposed!.execute(call, new AbortController().signal)).status).toBe("external_approval_required");
    const pending = exposed!.awaitApproval({ conversationId: "conversation-approved", turnId: "turn-approved",
      call, signal: new AbortController().signal });
    let proposalId = "";
    await vi.waitFor(async () => {
      const retained = await events.read({ conversationId: "conversation-approved" as never });
      const created = retained.entries.find(({ event }) => event.payload.type === "approval.proposal_created");
      proposalId = created?.event.payload.type === "approval.proposal_created" ? created.event.payload.proposal_id : "";
      expect(proposalId).not.toBe("");
    });
    expect(executions).toBe(0);
    const decision = await assistant.handle(new Request("https://example.test/approvals/transition", {
      method: "POST", headers: { "x-user": "alice", "content-type": "application/json" }, body: JSON.stringify({
        conversationId: "conversation-approved", proposalId, expectedVersion: 1, status: "confirmed",
        idempotencyKey: "confirm-approved", idempotencyFingerprint: "confirm-approved",
        attribution: { actor: { type: "system" }, source: { type: "import" } },
      }),
    }));
    expect(decision.status).toBe(200);
    expect(await pending).toMatchObject({ status: "completed", result: { is_error: false } });
    expect(executions).toBe(1);
    const audit = await events.read({ conversationId: "conversation-approved" as never });
    expect(audit.entries.some(({ event }) => event.payload.type === "approval.proposal_status_changed" &&
      event.payload.status === "confirmed" && event.actor.type === "user" && event.actor.id === "alice" &&
      event.source.type === "runtime")).toBe(true);
  });
});
