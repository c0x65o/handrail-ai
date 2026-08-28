import { URL, fileURLToPath } from "node:url";
import path from "node:path";

import { build } from "vite";

const fixtureDirectory = fileURLToPath(
  new URL("../test/fixtures/vite-consumer/", import.meta.url),
);

const result = await build({
  configFile: false,
  root: fixtureDirectory,
  logLevel: "warn",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: path.join(fixtureDirectory, "consumer.tsx"),
      formats: ["es"],
      fileName: "consumer",
    },
    minify: false,
    target: "es2022",
    write: false,
  },
});

const outputs = Array.isArray(result) ? result : [result];
const bundledCode = outputs
  .flatMap((output) => output.output)
  .filter((output) => output.type === "chunk")
  .map((output) => output.code)
  .join("\n");

if (bundledCode.length === 0) {
  throw new Error("Vite produced no JavaScript chunks for the @handrail/ai consumer fixture");
}

if (!bundledCode.includes("parseChatRequest")) {
  throw new Error("Vite consumer bundle did not retain the public protocol entry point");
}

if (!bundledCode.includes("createConversationStore")) {
  throw new Error("Vite consumer bundle did not retain the headless conversation store");
}

if (!bundledCode.includes("IndexedDBConversationEventStore")) {
  throw new Error("Vite consumer bundle did not retain the opt-in browser entry point");
}

if (!bundledCode.includes("IndexedDBConversationSyncStateStore")) {
  throw new Error("Vite consumer bundle did not retain the sync-state browser entry point");
}

if (!bundledCode.includes("reactSubpathElement")) {
  throw new Error("Vite consumer bundle did not retain the React subpath consumer");
}

for (const recipe of [
  "ChatDialogRecipe",
  "ChatTabsRecipe",
  "ChatDrawerRecipe",
  "ChatLauncherRecipe",
  "FullPageChatRecipe",
  "CustomHooksChatRecipe",
]) {
  if (!bundledCode.includes(recipe)) {
    throw new Error(`Vite consumer bundle did not retain the ${recipe} presentation`);
  }
}

if (!bundledCode.includes("renderReactPresentationRecipes")) {
  throw new Error("Vite consumer bundle did not render the React presentation recipes");
}

const nodeRuntimeDependency = bundledCode.match(
  /\bBuffer\s*\.|\bprocess\.env\b|(?:from\s*|import\s*\()?["']node:/u,
)?.[0];
if (nodeRuntimeDependency) {
  const dependencyOffset = bundledCode.indexOf(nodeRuntimeDependency);
  const dependencyContext = bundledCode.slice(
    Math.max(0, dependencyOffset - 60),
    dependencyOffset + nodeRuntimeDependency.length + 60,
  );
  throw new Error(
    `Vite consumer bundle retained the Node runtime dependency ${JSON.stringify(nodeRuntimeDependency)} near ${JSON.stringify(dependencyContext)}`,
  );
}
