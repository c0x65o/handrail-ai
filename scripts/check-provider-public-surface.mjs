import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stdout } from "node:process";
import { URL, fileURLToPath } from "node:url";

const distDirectory = fileURLToPath(new URL("../dist", import.meta.url));

function declarationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? declarationFiles(path)
      : entry.name.endsWith(".d.ts")
        ? [path]
        : [];
  });
}

const files = declarationFiles(distDirectory);
assert(files.length > 0, "build declarations before checking the public surface");

const runtimeNeutralFiles = files.filter(
  (path) =>
    !/[\\/]react[\\/]/u.test(path) &&
    !/[\\/]server[\\/]/u.test(path) &&
    !/[\\/]transports[\\/](?:managed-runtime|sse)\.d\.ts$/u.test(path) &&
    !/[\\/]providers[\\/](?!index\.d\.ts$)[^\\/]+\.d\.ts$/u.test(path),
);
const runtimeNeutralDeclarations = runtimeNeutralFiles
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
const runtimeNeutralDeclarationCode = runtimeNeutralDeclarations
  .replace(/\/\*[\s\S]*?\*\//gu, "")
  .replace(/\/\/[^\n]*/gu, "");
const packageEntry = readFileSync(join(distDirectory, "index.d.ts"), "utf8");
const openAIEntry = readFileSync(
  join(distDirectory, "providers", "openai.d.ts"),
  "utf8",
);
const openAIContextEntry = readFileSync(
  join(distDirectory, "providers", "openai-context.d.ts"),
  "utf8",
);
const anthropicEntry = readFileSync(
  join(distDirectory, "providers", "anthropic.d.ts"),
  "utf8",
);
const geminiEntry = readFileSync(
  join(distDirectory, "providers", "gemini.d.ts"),
  "utf8",
);
const xaiEntry = readFileSync(
  join(distDirectory, "providers", "xai.d.ts"),
  "utf8",
);
const managedEntry = readFileSync(
  join(distDirectory, "server", "managed.d.ts"),
  "utf8",
);

assert.match(
  packageEntry,
  /export \* from ["']\.\/providers\/index\.js["'];/,
  "the package entry point must export the provider adapter contract",
);
assert.match(
  packageEntry,
  /export \* from ["']\.\/transports\/index\.js["'];/,
  "the package entry point must export the conversation transport contract",
);
assert.match(
  packageEntry,
  /export \* from ["']\.\/provider-context\.js["'];/,
  "the package entry point must export only the provider-neutral context contract",
);
assert.match(
  openAIEntry,
  /export declare (?:class OpenAIProviderAdapter|function createOpenAIProviderAdapter)/,
  "the opt-in OpenAI entry must export its provider adapter",
);
assert.match(
  openAIEntry,
  /export \* from ["']\.\/openai-context\.js["'];/,
  "the opt-in OpenAI entry must export its SDK-independent context boundary",
);
assert.match(
  openAIContextEntry,
  /export declare function createOpenAIProviderContextCapability/,
  "the opt-in OpenAI context boundary must expose capability construction",
);
assert.match(
  anthropicEntry,
  /export declare (?:class AnthropicProviderAdapter|function createAnthropicProviderAdapter)/,
  "the opt-in Anthropic entry must export its provider adapter",
);
assert.match(
  geminiEntry,
  /export declare (?:class GeminiProviderAdapter|function createGeminiProviderAdapter)/,
  "the opt-in Gemini entry must export its provider adapter",
);
assert.match(
  xaiEntry,
  /export declare (?:class XAIProviderAdapter|function createXAIProviderAdapter)/,
  "the opt-in xAI entry must export its provider adapter",
);
assert.match(
  managedEntry,
  /export \* from ["']\.\.\/transports\/managed-runtime\.js["'];/,
  "the trusted-server managed entry must export ManagedRuntimeTransport",
);
assert.doesNotMatch(
  packageEntry,
  /providers\/(?:openai|anthropic|gemini|xai)/,
  "the core package entry must not export concrete provider adapters",
);

const declarationsCheckedForSdkImports =
  `${runtimeNeutralDeclarations}\n${openAIEntry}\n${openAIContextEntry}\n${anthropicEntry}\n${geminiEntry}\n${xaiEntry}\n${managedEntry}`;
const externalImports = [
  ...declarationsCheckedForSdkImports.matchAll(/from ["']([^"']+)["']/g),
]
  .map((match) => match[1])
  .filter((specifier) => specifier && !specifier.startsWith("."));
assert.deepEqual(
  externalImports,
  [],
  `public declarations must not import SDK types: ${externalImports.join(", ")}`,
);

const forbiddenMarkers = [
  /\bOpenAI\b/,
  /\bAnthropic\b/,
  /\bGemini\b/,
  /\bGoogleGenerativeAI\b/,
  /\bxAI\b/,
  /\bChatCompletionChunk\b/,
  /\bMessageStreamEvent\b/,
  /\bGenerateContentResponse\b/,
  /\braw_(?:request|response|error)\b/,
  /\b(?:provider|native|sdk)_chunk\b/,
  /\bfetch\b/,
  /\bResponse\b/,
  /\bEventSource\b/,
  /\bNodeJS\b/,
  /\bBuffer\b/,
  /\bcredentials?\b/i,
];

for (const marker of forbiddenMarkers) {
  assert.doesNotMatch(
    runtimeNeutralDeclarationCode,
    marker,
    `public declarations contain provider-native marker ${marker.source}`,
  );
}

stdout.write(
  `checked ${runtimeNeutralFiles.length} neutral and ${files.length - runtimeNeutralFiles.length} opt-in declaration files\n`,
);
