import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";

import { CitationItem, CitationList } from "../src/react/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("React citation package boundary", () => {
  it("exports both citation primitives from the optional React entry", () => {
    expect(typeof CitationList).toBe("object");
    expect(typeof CitationItem).toBe("object");
  });

  it("imports no styles or provider adapters", () => {
    for (const relativePath of [
      "src/react/citations.tsx",
      "src/react/primitive-context.ts",
    ]) {
      const source = readFileSync(path.join(packageRoot, relativePath), "utf8");
      expect(source).not.toMatch(
        /(?:from\s+|import\s*)["'][^"']*\.(?:css|less|sass|scss)["']/u,
      );
      expect(source).not.toMatch(/(?:^|\/)providers(?:\/|["'])/mu);
    }
  });
});
