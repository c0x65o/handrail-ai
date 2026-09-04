import { HandrailChat, StyledChatPresetStyles } from "@handrail/ai-assistant/react/styled";
import { goldenComposer, type GoldenClient } from "./golden-authenticated-app.js";

/** Styled UI stays optional: this file is the only layer importing the styled entry. */
export function GoldenSingleChat({ client }: { readonly client: GoldenClient }) {
  if (client.conversation === null) throw new Error("Create the client in single mode");
  return <>
    <StyledChatPresetStyles/>
    <HandrailChat
      title="Account assistant"
      runtime={client.conversation}
      composer={goldenComposer()}
      theme={{ mode: "system", colors: { accent: "#3659e3" }, radii: { panel: "20px" } }}
    />
  </>;
}
