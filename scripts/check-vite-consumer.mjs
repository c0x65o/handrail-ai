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
  build: {
    lib: {
      entry: path.join(fixtureDirectory, "consumer.ts"),
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

const nodeRuntimeDependency = bundledCode.match(/\b(?:Buffer|process)\b|node:/u)?.[0];
if (nodeRuntimeDependency) {
  throw new Error(
    `Vite consumer bundle retained the Node runtime dependency ${JSON.stringify(nodeRuntimeDependency)}`,
  );
}
