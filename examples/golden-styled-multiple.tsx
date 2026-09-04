import { HandrailChatWorkspaceLauncher, StyledChatPresetStyles } from "@handrail/ai-assistant/react/styled";
import { goldenComposer, type GoldenClient } from "./golden-authenticated-app.js";

async function createConversation(client: GoldenClient) {
  const result = await client.resources.createConversation({
    title: "New conversation",
    idempotencyKey: crypto.randomUUID() as never,
  });
  return { conversationId: result.descriptor.conversationId, authorizationContext: {} };
}

/** Built-in picker, background turns, unread/error badges, and lifecycle ownership. */
export function GoldenMultipleChat({ client }: { readonly client: GoldenClient }) {
  if (client.workspace === null) throw new Error("Create the client in multiple mode");
  return <>
    <StyledChatPresetStyles/>
    <HandrailChatWorkspaceLauncher
      title="Account assistant"
      workspace={client.workspace}
      composerForConversation={() => goldenComposer()}
      createConversation={() => createConversation(client)}
      theme={{ mode: "system" }}
    />
  </>;
}
