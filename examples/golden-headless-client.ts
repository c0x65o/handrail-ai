import { createGoldenClient } from "./golden-authenticated-app.js";

/** Complete authenticated headless path: gateway negotiation, runtime, send, cleanup. */
export async function runGoldenHeadlessClient(): Promise<string> {
  const client = await createGoldenClient("single");
  try {
    const runtime = client.conversation;
    if (runtime === null) throw new Error("single conversation was not created");
    await runtime.sendMessage({
      content: "What plan am I on?",
      request: client.buildRequest({ content: "What plan am I on?" }),
    });
    return runtime.getSnapshot().messages.at(-1)?.content.map((part) => part.text).join("") ?? "";
  } finally {
    await client.dispose();
  }
}
