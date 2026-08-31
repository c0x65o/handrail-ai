import { describe, expect, it, vi } from "vitest";

import {
  APPLICATION_GATEWAY_PROTOCOL_VERSION,
  createHandrailAiClient,
  InMemoryConversationEventStore,
  type ApplicationGatewayCapabilities,
} from "../src/client/index.js";
import type { AttachmentUploadAdapter, ConversationCatalog } from "../src/index.js";

const capabilities: ApplicationGatewayCapabilities = Object.freeze({
  protocolVersion: APPLICATION_GATEWAY_PROTOCOL_VERSION,
  authoritativeCancellation: false,
  attachments: false,
  presence: false,
  activity: false,
  synchronization: false,
  resources: Object.freeze({
    conversations: false,
    approvals: false,
    titleGeneration: false,
  }),
});

describe("createHandrailAiClient", () => {
  it("assembles the standard headless client graph and application request builder", async () => {
    const eventStoreFor = vi.fn(() => new InMemoryConversationEventStore());
    const client = await createHandrailAiClient<unknown, {
      readonly prompt: string;
      readonly attachmentCount: number;
    }, { readonly actorId: string }>({
      baseUrl: "https://app.test/ai",
      capabilities,
      runtime: {
        clientId: "client_web" as never,
        deviceId: "device_browser" as never,
        eventStoreFor,
        authorize: () => "allow",
      },
      buildRequest: ({ content, attachments }) => ({
        prompt: content,
        attachmentCount: attachments.length,
      }),
      startActivityPolling: false,
    });

    expect(client.registry).not.toBeNull();
    expect(client.workspace).not.toBeNull();
    expect(client.activity).toBeNull();
    expect(client.attachmentUpload).toBeNull();
    expect(client.presence).toBeNull();
    expect(client.synchronization).toBeNull();
    const typedCatalog: ConversationCatalog<{ readonly actorId: string }> = client.catalog;
    const typedUpload: AttachmentUploadAdapter<Blob> | null = client.attachmentUpload;
    expect(typedCatalog).toBe(client.catalog);
    expect(typedUpload).toBeNull();
    expect(client.buildRequest({ content: "hello", attachments: [{ id: "a" }] }))
      .toEqual({ prompt: "hello", attachmentCount: 1 });
    expect(eventStoreFor).not.toHaveBeenCalled();
    await expect(client.markActivityRead("conversation-1")).resolves.toBeUndefined();
    await client.dispose();
  });

  it("rejects ambiguous runtime ownership", async () => {
    await expect(createHandrailAiClient({
      baseUrl: "https://app.test/ai",
      capabilities,
      createRuntime: vi.fn(),
      authorizeRuntime: () => "allow",
      runtime: {
        clientId: "client_web" as never,
        eventStoreFor: () => new InMemoryConversationEventStore(),
        authorize: () => "allow",
      },
    })).rejects.toThrow("createRuntime and authorizeRuntime must be configured together");
  });
});
