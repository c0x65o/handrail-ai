import { describe, expect, it } from "vitest";

import * as handrailAi from "../src/index.js";

describe("package entry point", () => {
  it("loads as an ESM module", () => {
    expect(handrailAi).toBeTypeOf("object");
  });
});
