import { URL, fileURLToPath } from "node:url";
import path from "node:path";

import { build } from "vite";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

async function bundle(entry) {
  const result = await build({
    configFile: false,
    root: packageRoot,
    logLevel: "warn",
    build: {
      lib: {
        entry: path.join(packageRoot, entry),
        formats: ["es"],
        fileName: "consumer",
      },
      minify: false,
      target: "es2022",
      write: false,
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  return outputs
    .flatMap((output) => output.output)
    .filter((output) => output.type === "chunk")
    .map((output) => output.code)
    .join("\n");
}

function assertBrowserSafe(code, label) {
  const nodeRuntimeDependency = code.match(
    /\bBuffer\s*\.|\bprocess\.env\b|(?:from\s*|import\s*\()?["']node:/u,
  )?.[0];
  if (nodeRuntimeDependency) {
    throw new Error(
      `${label} retained Node runtime dependency ${JSON.stringify(nodeRuntimeDependency)}`,
    );
  }
}

const attachmentBundle = await bundle(
  "test/fixtures/browser-attachment-uploader.ts",
);
if (
  !attachmentBundle.includes("intakeFileInputImages") ||
  !attachmentBundle.includes("browser-intake:") ||
  !attachmentBundle.includes("createAttachmentUploader")
) {
  throw new Error(
    "Vite did not retain the opt-in browser attachment intake and uploader fixture",
  );
}
assertBrowserSafe(attachmentBundle, "Browser attachment fixture");

const storeOnlyBundle = await bundle(
  "test/fixtures/vite-consumer/browser-store-only.ts",
);
if (!storeOnlyBundle.includes("IndexedDBConversationEventStore")) {
  throw new Error("Vite did not retain the requested IndexedDB browser export");
}
for (const attachmentMarker of [
  "browser-intake:",
  "unsupported_type",
  "intakeFileInputImages",
]) {
  if (storeOnlyBundle.includes(attachmentMarker)) {
    throw new Error(
      `Vite failed to tree-shake browser attachment marker ${JSON.stringify(attachmentMarker)}`,
    );
  }
}
assertBrowserSafe(storeOnlyBundle, "IndexedDB-only browser fixture");
