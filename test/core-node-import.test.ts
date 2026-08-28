import { afterEach, describe, expect, it, vi } from "vitest";

const indexedDBDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "indexedDB",
);

afterEach(() => {
  if (indexedDBDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "indexedDB");
  } else {
    Object.defineProperty(globalThis, "indexedDB", indexedDBDescriptor);
  }
});

describe("core package entry in Node", () => {
  it("imports without reading the IndexedDB browser global", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get() {
        throw new Error("Core entry accessed indexedDB eagerly.");
      },
    });
    vi.resetModules();

    await expect(import("../src/index.js")).resolves.toBeTypeOf("object");
  });
});
