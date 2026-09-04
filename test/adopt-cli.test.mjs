import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../scripts/adopt.mjs", import.meta.url));
const approved = "git+https://github.com/c0x65o/handrail-sdk-ai-assistant-js.git#0123456789abcdef0123456789abcdef01234567";

function host() {
  const root = mkdtempSync(join(tmpdir(), "handrail-ai-adopt-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ dependencies: { "@handrail/ai": approved } }, null, 2)}\n`);
  writeFileSync(join(root, "src", "assistant.tsx"), [
    'import { createHandrailAssistant } from "@handrail/ai/server/assistant";',
    'import { usageFromEnvironment } from "@handrail/ai/server/usage-control";',
    'import { HandrailAssistantLauncher } from "@handrail/ai/react/styled";',
    "void createHandrailAssistant; void usageFromEnvironment; void HandrailAssistantLauncher;",
    "const lifecycle = { recoverPendingOnContext: true, flushUsage: true, stopUsageWorker: true };",
    "void lifecycle;",
  ].join("\n"));
  return root;
}

function writeCanonicalLock(root) {
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify({
    name: "host",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@handrail/ai-assistant": approved } },
      "node_modules/@handrail/ai-assistant": { version: "0.2.0", resolved: approved },
    },
  }, null, 2)}\n`);
}

test("migrates the package identity and imports only with --write", () => {
  const root = host();
  execFileSync(process.execPath, [cli, "migrate-package", root, "--write"]);
  writeCanonicalLock(root);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"))).dependencies["@handrail/ai-assistant"], approved);
  assert.doesNotMatch(readFileSync(join(root, "src", "assistant.tsx"), "utf8"), /@handrail\/ai(?:["/])/u);
  assert.equal(spawnSync(process.execPath, [cli, "check", root]).status, 0);
});

test("scaffolds the standard server and styled client only into an empty target", () => {
  const parent = mkdtempSync(join(tmpdir(), "handrail-ai-scaffold-"));
  const target = join(parent, "assistant");
  execFileSync(process.execPath, [cli, "scaffold", target]);
  expectFile(join(target, "server.ts"), "createHandrailAssistant");
  expectFile(join(target, "client.tsx"), "HandrailAssistantLauncher");
  writeFileSync(join(target, "owned.txt"), "keep");
  assert.notEqual(spawnSync(process.execPath, [cli, "scaffold", target]).status, 0);
});

function expectFile(path, content) {
  assert.match(readFileSync(path, "utf8"), new RegExp(content, "u"));
}

test("fails conformance for an unpinned or incomplete host", () => {
  const root = host();
  writeFileSync(join(root, "package.json"), '{"dependencies":{"@handrail/ai-assistant":"latest"}}\n');
  assert.equal(spawnSync(process.execPath, [cli, "check", root]).status, 1);
});
