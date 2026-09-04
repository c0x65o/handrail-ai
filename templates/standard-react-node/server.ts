import { createHandrailAssistant } from "@handrail/ai-assistant/server/assistant";
import { usageFromEnvironment } from "@handrail/ai-assistant/server/usage-control";
import { openaiResponses } from "@handrail/ai-assistant/providers/openai";
import { postgres } from "@handrail/ai-assistant/persistence/postgres";

import { pool } from "./host/database.js";
import { authorizeAssistantRequest, recoveryContexts } from "./host/identity.js";
import { domainTools, toolPolicy } from "./host/tools.js";

/**
 * Standard server composition. The imported ./host modules are the only
 * application-owned seams: identity/context, tools/policy, and persistence.
 */
export const assistant = await createHandrailAssistant({
  id: "replace-with-stable-assistant-id",
  authorize: authorizeAssistantRequest,
  provider: openaiResponses({
    apiKey: process.env.OPENAI_API_KEY!,
    model: process.env.OPENAI_MODEL!,
  }),
  persistence: postgres(pool),
  usage: usageFromEnvironment(),
  recoveryContexts,
  tools: domainTools,
  toolPolicy,
});

await assistant.recoverPending();
await assistant.flushUsage();

export async function stopAssistant(): Promise<void> {
  await assistant.flushUsage();
  assistant.stopUsageWorker();
}
