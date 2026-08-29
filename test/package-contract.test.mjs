import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import path from "node:path";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

test("declares the React subpath as an optional peer boundary", () => {
  assert.deepEqual(packageJson.exports["./react"], {
    types: "./dist/react/index.d.ts",
    import: "./dist/react/index.js",
    default: "./dist/react/index.js",
  });
  assert.equal(packageJson.peerDependencies.react, ">=18");
  assert.deepEqual(packageJson.peerDependenciesMeta.react, { optional: true });
  assert.equal(packageJson.sideEffects, false);
});

test("declares managed runtime support as an explicit trusted-server boundary", () => {
  assert.deepEqual(packageJson.exports["./server/managed"], {
    types: "./dist/server/managed.d.ts",
    import: "./dist/server/managed.js",
    default: "./dist/server/managed.js",
  });
});

test("declares OpenAI as an explicit opt-in provider boundary", () => {
  assert.deepEqual(packageJson.exports["./providers/openai"], {
    types: "./dist/providers/openai.d.ts",
    import: "./dist/providers/openai.js",
    default: "./dist/providers/openai.js",
  });
  assert.equal(packageJson.dependencies.openai, undefined);
});

test("declares Anthropic as an explicit opt-in provider boundary", () => {
  assert.deepEqual(packageJson.exports["./providers/anthropic"], {
    types: "./dist/providers/anthropic.d.ts",
    import: "./dist/providers/anthropic.js",
    default: "./dist/providers/anthropic.js",
  });
  assert.equal(packageJson.dependencies["@anthropic-ai/sdk"], undefined);
});

test("declares Gemini as an explicit opt-in provider boundary", () => {
  assert.deepEqual(packageJson.exports["./providers/gemini"], {
    types: "./dist/providers/gemini.d.ts",
    import: "./dist/providers/gemini.js",
    default: "./dist/providers/gemini.js",
  });
  assert.equal(packageJson.dependencies["@google/genai"], undefined);
  assert.equal(packageJson.dependencies["@google/generative-ai"], undefined);
});

test("declares xAI as an explicit opt-in provider boundary", () => {
  assert.deepEqual(packageJson.exports["./providers/xai"], {
    types: "./dist/providers/xai.d.ts",
    import: "./dist/providers/xai.js",
    default: "./dist/providers/xai.js",
  });
  assert.equal(packageJson.dependencies.openai, undefined);
  assert.equal(packageJson.dependencies.xai, undefined);
  assert.equal(packageJson.dependencies["@xai-org/xai-sdk"], undefined);
});

test("resolves every public ESM export from the built package", async () => {
  for (const exportName of Object.keys(packageJson.exports)) {
    const target = packageJson.exports[exportName].import;
    const moduleUrl = pathToFileURL(path.join(packageRoot, target)).href;
    const imported = await import(moduleUrl);
    assert.equal(typeof imported, "object", `${exportName} ESM export`);
  }
});

test("exports citation records and normalization from the built core entry", async () => {
  const moduleUrl = pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href;
  const imported = await import(moduleUrl);
  assert.deepEqual(imported.CITATION_SOURCE_TYPES, ["web", "document", "tool"]);
  assert.equal(typeof imported.normalizeCitationRecords, "function");
  assert.equal(typeof imported.deduplicateCitationRecords, "function");
});

test("exports the approval proposal store contract from the built core entry", async () => {
  const moduleUrl = pathToFileURL(
    path.join(packageRoot, packageJson.exports["."].import),
  ).href;
  const imported = await import(moduleUrl);
  assert.equal(typeof imported.InMemoryApprovalProposalStore, "function");
  assert.equal(typeof imported.ApprovalProposalStoreError, "function");
  assert.equal(typeof imported.APPROVAL_PROPOSAL_STORE_LIMITS, "object");
});

test("imports core and browser entries when React resolution is unavailable", () => {
  const loaderUrl = new URL("./fixtures/reject-react-loader.mjs", import.meta.url);
  const entryUrls = [".", "./browser"].map((exportName) =>
    pathToFileURL(
      path.join(packageRoot, packageJson.exports[exportName].import),
    ).href,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-loader",
      fileURLToPath(loaderUrl),
      "--input-type=module",
      "--eval",
      `await Promise.all(${JSON.stringify(entryUrls)}.map((entry) => import(entry)));`,
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );

  assert.equal(
    result.status,
    0,
    `React-free entry import failed:\n${result.stderr || result.stdout}`,
  );
});

test("dry pack contains only intended package assets", () => {
  const output = execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const [{ files }] = JSON.parse(output);
  const packedFiles = new Set(files.map(({ path: filePath }) => filePath));

  for (const expected of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/browser/index.js",
    "dist/browser/index.d.ts",
    "dist/react/index.js",
    "dist/react/index.d.ts",
    "dist/server/managed.js",
    "dist/server/managed.d.ts",
    "dist/providers/openai.js",
    "dist/providers/openai.d.ts",
    "dist/providers/anthropic.js",
    "dist/providers/anthropic.d.ts",
    "dist/providers/gemini.js",
    "dist/providers/gemini.d.ts",
    "dist/providers/xai.js",
    "dist/providers/xai.d.ts",
  ]) {
    assert.ok(packedFiles.has(expected), `missing packed file ${expected}`);
  }

  for (const filePath of packedFiles) {
    assert.doesNotMatch(filePath, /^(?:scripts|src|test)\//u);
    assert.doesNotMatch(
      filePath,
      /\.(?:css|less|sass|scss|eot|otf|ttf|woff2?)$/u,
    );
    assert.match(filePath, /^(?:dist\/|LICENSE$|README\.md$|package\.json$)/u);
  }
});
