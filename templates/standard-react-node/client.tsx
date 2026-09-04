import { HandrailAssistantLauncher } from "@handrail/ai-assistant/react/styled";

import { protectedAssistantRequest } from "./host/auth.js";

/** Standard multi-conversation UI. Theme and labels are host-owned branding. */
export function AssistantLauncher() {
  return <HandrailAssistantLauncher
    endpoint="/api/assistant"
    protectedRequest={protectedAssistantRequest}
    title="Assistant"
    trigger="Ask assistant"
    theme={{ mode: "system" }}
  />;
}
