import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (relativePath) =>
  readFileSync(path.join(packageRoot, relativePath), "utf8");

assert.doesNotThrow(() => read("dist/index.d.ts"), "build declarations are required");
execFileSync(
  process.execPath,
  [
    path.join(packageRoot, "node_modules/typescript/bin/tsc"),
    "-p",
    path.join(packageRoot, "examples/tsconfig.json"),
  ],
  { cwd: packageRoot, stdio: "inherit" },
);

const readme = read("README.md");
const headless = read("examples/headless-runtime.ts");
const trustedServer = read("examples/trusted-server-transports.ts");
const reactPresentations = read("examples/react-presentations.tsx");

for (const packageEntry of [
  "@handrail/ai",
  "@handrail/ai/browser",
  "@handrail/ai/react",
  "@handrail/ai/server/managed",
  "@handrail/ai/providers/openai",
  "@handrail/ai/providers/anthropic",
  "@handrail/ai/providers/gemini",
  "@handrail/ai/providers/xai",
]) {
  assert.ok(readme.includes(`\`${packageEntry}\``), `README documents ${packageEntry}`);
}

for (const lifecycleApi of [
  "createConversationRuntime",
  "restoreActiveTurn",
  "resumeTurn",
  "observe",
  "sendMessage",
  "stopObserving",
  "cancelTurn",
  "destroy",
  "BoundedToolExecutor",
  "runToolLoop",
  "NormalizedUsageReceipt",
]) {
  assert.ok(readme.includes(lifecycleApi), `README documents ${lifecycleApi}`);
  assert.ok(headless.includes(lifecycleApi), `headless example checks ${lifecycleApi}`);
}

assert.doesNotMatch(readme, /currently scaffolded|will be added separately/iu);
assert.match(
  readme,
  /Browser\s+and mobile code must call that application server\./u,
);
assert.match(
  readme,
  /Never put provider\s+credentials, managed tokens, or authorization headers in client code/iu,
);

for (const [label, contents] of [
  ["README", readme],
  ["headless example", headless],
  ["trusted-server example", trustedServer],
  ["React presentation example", reactPresentations],
]) {
  assert.doesNotMatch(contents, /\bbearer\s+[a-z0-9._~+/=-]{8,}/iu, `${label} has no bearer value`);
  assert.doesNotMatch(contents, /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/imu, `${label} has no key-like value`);
  assert.doesNotMatch(
    contents,
    /-----begin (?:rsa |ec |openssh )?private key-----/iu,
    `${label} has no private key material`,
  );
}

for (const clientOnlyBoundary of [
  /authorization/iu,
  /getHeaders/u,
  /api[_-]?key/iu,
  /managed[_-]?token/iu,
]) {
  assert.doesNotMatch(
    headless,
    clientOnlyBoundary,
    "runtime-neutral headless example contains no client credential plumbing",
  );
}

assert.match(trustedServer, /createDirectProviderTransport/u);
assert.match(trustedServer, /createManagedRuntimeTransport/u);

for (const recipe of [
  "ChatDialogRecipe",
  "ChatTabsRecipe",
  "ChatDrawerRecipe",
  "ChatLauncherRecipe",
  "FullPageChatRecipe",
  "CustomHooksChatRecipe",
]) {
  assert.ok(reactPresentations.includes(recipe), `React example checks ${recipe}`);
  assert.ok(readme.includes(recipe), `README documents ${recipe}`);
}

assert.doesNotMatch(reactPresentations, /import\s+["'][^"']+\.(?:css|scss|sass|less)["']/u);
assert.doesNotMatch(reactPresentations, /<style\b|document\.(?:body|documentElement)\.style/iu);
