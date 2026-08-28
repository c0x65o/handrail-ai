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

test("resolves every public ESM export from the built package", async () => {
  for (const exportName of [".", "./browser", "./react"]) {
    const target = packageJson.exports[exportName].import;
    const moduleUrl = pathToFileURL(path.join(packageRoot, target)).href;
    const imported = await import(moduleUrl);
    assert.equal(typeof imported, "object", `${exportName} ESM export`);
  }
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
