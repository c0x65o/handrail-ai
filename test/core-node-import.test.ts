import { afterEach, describe, expect, it, vi } from "vitest";

const guardedBrowserGlobals = [
  "indexedDB",
  "File",
  "Blob",
  "DataTransfer",
] as const;
const originalDescriptors = new Map(
  guardedBrowserGlobals.map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
const urlDescriptor = Object.getOwnPropertyDescriptor(globalThis, "URL");

function guardBrowserGlobals(): void {
  for (const name of guardedBrowserGlobals) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw new Error(`Module accessed ${name} eagerly.`);
      },
    });
  }
  const originalUrl = urlDescriptor?.value as typeof URL | undefined;
  if (originalUrl !== undefined) {
    Object.defineProperty(globalThis, "URL", {
      configurable: true,
      value: new Proxy(originalUrl, {
        get(target, property, receiver) {
          if (property === "createObjectURL") {
            throw new Error("Module accessed URL.createObjectURL eagerly.");
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    });
  }
}

afterEach(() => {
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  if (urlDescriptor === undefined) Reflect.deleteProperty(globalThis, "URL");
  else Object.defineProperty(globalThis, "URL", urlDescriptor);
});

describe("core package entry in Node", () => {
  it("imports without reading browser attachment or persistence globals", async () => {
    guardBrowserGlobals();
    vi.resetModules();

    await expect(import("../src/index.js")).resolves.toBeTypeOf("object");
  });

  it("imports the opt-in browser entry without eagerly reading browser globals", async () => {
    guardBrowserGlobals();
    vi.resetModules();

    await expect(import("../src/browser/index.js")).resolves.toBeTypeOf("object");
  });
});
