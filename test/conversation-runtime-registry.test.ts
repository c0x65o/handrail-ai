import { describe, expect, it, vi } from "vitest";

import {
  CONVERSATION_RUNTIME_REGISTRY_LIMITS,
  ConversationRuntimeRegistry,
  InMemoryConversationCatalog,
  parseConversationCatalogIdempotencyKey,
  parseConversationCatalogVersion,
  type ConversationCatalogAuthorizer,
  type ConversationCatalogIdempotencyKey,
  type ConversationCatalogVersion,
  type ConversationId,
  type ConversationRuntime,
  type ConversationRuntimeRegistryPolicy,
} from "../src/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function id(value: string): ConversationId {
  return value as ConversationId;
}

function key(value: string): ConversationCatalogIdempotencyKey {
  return parseConversationCatalogIdempotencyKey(value);
}

function version(value: number): ConversationCatalogVersion {
  return parseConversationCatalogVersion(value);
}

function runtime(label: string) {
  const destroy = vi.fn();
  return {
    label,
    destroy,
    value: { label, destroy } as unknown as ConversationRuntime<unknown>,
  };
}

const allowCatalog: ConversationCatalogAuthorizer<string> = () => "allow";

function catalog() {
  let timestamp = 0;
  return new InMemoryConversationCatalog<string>({
    authorize: allowCatalog,
    clock: {
      now: () => `2026-08-01T00:00:${String(timestamp++).padStart(2, "0")}.000Z` as never,
    },
    createConversationId: () => id(`generated-${timestamp}`),
  });
}

async function createConversation(
  target: ReturnType<typeof catalog>,
  conversationId: string,
) {
  return target.create({
    authorizationContext: "host",
    conversationId: id(conversationId),
    idempotencyKey: key(`create-${conversationId}`),
  });
}

const allowPolicy: ConversationRuntimeRegistryPolicy<string> = () => "allow";

function expectRegistryCode(promise: Promise<unknown>, code: string) {
  return expect(promise).rejects.toMatchObject({
    name: "ConversationRuntimeRegistryError",
    code,
  });
}

describe("ConversationRuntimeRegistry", () => {
  it("coalesces concurrent same-ID opens and isolates different IDs", async () => {
    const target = catalog();
    await Promise.all([
      createConversation(target, "same"),
      createConversation(target, "other"),
    ]);
    const constructions = new Map<string, Deferred<ConversationRuntime<unknown>>>();
    const createRuntime = vi.fn(({ conversationId }: { conversationId: ConversationId }) => {
      const operation = deferred<ConversationRuntime<unknown>>();
      constructions.set(conversationId, operation);
      return operation.promise;
    });
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
    });

    const first = registry.open({ authorizationContext: "host", conversationId: id("same") });
    const concurrent = registry.open({ authorizationContext: "host", conversationId: id("same") });
    const other = registry.open({ authorizationContext: "host", conversationId: id("other") });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(2));
    const sameRuntime = runtime("same");
    const otherRuntime = runtime("other");
    constructions.get("same")!.resolve(sameRuntime.value);
    constructions.get("other")!.resolve(otherRuntime.value);

    expect(await first).toBe(sameRuntime.value);
    expect(await concurrent).toBe(sameRuntime.value);
    expect(await other).toBe(otherRuntime.value);
    expect(await registry.open({
      authorizationContext: "host",
      conversationId: id("same"),
    })).toBe(sameRuntime.value);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it("removes failed construction so a later open can retry", async () => {
    const target = catalog();
    await createConversation(target, "retry");
    const created = runtime("retry");
    const failure = new Error("host factory failed");
    const createRuntime = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(created.value);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
    });

    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("retry"),
    })).rejects.toBe(failure);
    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("retry"),
    })).resolves.toBe(created.value);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it("releases live and pending runtimes without deleting catalog identity", async () => {
    const target = catalog();
    await Promise.all([
      createConversation(target, "live"),
      createConversation(target, "pending"),
    ]);
    const live = runtime("live");
    const late = runtime("late");
    const pending = deferred<ConversationRuntime<unknown>>();
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime: ({ conversationId }) =>
        conversationId === id("live") ? live.value : pending.promise,
    });

    await registry.open({ authorizationContext: "host", conversationId: id("live") });
    expect(await registry.release(id("live"))).toBe(true);
    expect(live.destroy).toHaveBeenCalledTimes(1);

    const opening = registry.open({ authorizationContext: "host", conversationId: id("pending") });
    await vi.waitFor(() => expect(registry.getSnapshot().pendingCount).toBe(1));
    const releasing = registry.release(id("pending"));
    pending.resolve(late.value);
    await expectRegistryCode(opening, "construction_invalidated");
    await expect(releasing).resolves.toBe(true);
    expect(late.destroy).toHaveBeenCalledTimes(1);
    await expect(target.get({
      authorizationContext: "host",
      conversationId: id("pending"),
    })).resolves.toMatchObject({ status: "found" });
    await registry.dispose();
  });

  it("clears without tombstoning and constructs a fresh runtime afterward", async () => {
    const target = catalog();
    await createConversation(target, "clearable");
    const before = runtime("before");
    const after = runtime("after");
    const createRuntime = vi.fn()
      .mockResolvedValueOnce(before.value)
      .mockResolvedValueOnce(after.value);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
    });

    await registry.open({ authorizationContext: "host", conversationId: id("clearable") });
    const cleared = await registry.clear({
      authorizationContext: "host",
      conversationId: id("clearable"),
      expectedVersion: version(1),
      idempotencyKey: key("clear-clearable"),
    });
    expect(cleared.descriptor.version).toBe(2);
    expect(before.destroy).toHaveBeenCalledTimes(1);
    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("clearable"),
    })).resolves.toBe(after.value);
    expect(registry.getSnapshot().tombstoneCount).toBe(0);
    await registry.dispose();
  });

  it("uses supplied policy for archived opens and restore", async () => {
    const target = catalog();
    await createConversation(target, "archived");
    let allowArchivedOpen = false;
    let allowRestore = false;
    const policy = vi.fn<ConversationRuntimeRegistryPolicy<string>>(({ action, descriptor }) => {
      if (action === "open" && descriptor.lifecycle === "archived") {
        return allowArchivedOpen ? "allow" : "deny";
      }
      if (action === "restore") return allowRestore ? "allow" : "deny";
      return "allow";
    });
    const activeRuntime = runtime("active");
    const archivedRuntime = runtime("archived");
    const createRuntime = vi.fn()
      .mockResolvedValueOnce(activeRuntime.value)
      .mockResolvedValueOnce(archivedRuntime.value);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: policy,
      createRuntime,
    });

    await registry.open({ authorizationContext: "host", conversationId: id("archived") });
    await expect(registry.archive({
      authorizationContext: "host",
      conversationId: id("archived"),
      expectedVersion: version(1),
      idempotencyKey: key("archive-first"),
    })).resolves.toMatchObject({ descriptor: { lifecycle: "archived", version: 2 } });
    expect(activeRuntime.destroy).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ action: "archive" }));

    await expectRegistryCode(registry.open({
      authorizationContext: "host",
      conversationId: id("archived"),
    }), "policy_denied");
    allowArchivedOpen = true;
    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("archived"),
    })).resolves.toBe(archivedRuntime.value);
    await registry.release(id("archived"));

    const restoreInput = {
      authorizationContext: "host",
      conversationId: id("archived"),
      expectedVersion: version(2),
      idempotencyKey: key("restore-archived"),
    } as const;
    await expectRegistryCode(registry.restore(restoreInput), "policy_denied");
    expect((await target.get({
      authorizationContext: "host",
      conversationId: id("archived"),
    })).descriptor.lifecycle).toBe("archived");
    allowRestore = true;
    await expect(registry.restore(restoreInput)).resolves.toMatchObject({
      descriptor: { lifecycle: "active", version: 3 },
    });
    expect(policy).toHaveBeenCalledWith(expect.objectContaining({ action: "restore" }));
    await registry.dispose();
  });

  it("tombstones permanent deletion and destroys a late stale construction", async () => {
    const target = catalog();
    await createConversation(target, "deleted");
    const pending = deferred<ConversationRuntime<unknown>>();
    const stale = runtime("stale");
    const createRuntime = vi.fn(() => pending.promise);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
    });

    const opening = registry.open({ authorizationContext: "host", conversationId: id("deleted") });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1));
    await registry.permanentlyDelete({
      authorizationContext: "host",
      conversationId: id("deleted"),
      expectedVersion: version(1),
      idempotencyKey: key("delete-deleted"),
    });
    pending.resolve(stale.value);
    await expectRegistryCode(opening, "permanently_deleted");
    expect(stale.destroy).toHaveBeenCalledTimes(1);
    expect(registry.getSnapshot()).toMatchObject({ entryCount: 1, tombstoneCount: 1 });
    await expectRegistryCode(registry.open({
      authorizationContext: "host",
      conversationId: id("deleted"),
    }), "permanently_deleted");
    expect(createRuntime).toHaveBeenCalledTimes(1);
    await registry.dispose();
    expect(stale.destroy).toHaveBeenCalledTimes(1);
  });

  it("disposes live and late runtimes exactly once and rejects further use", async () => {
    const target = catalog();
    await Promise.all([
      createConversation(target, "live"),
      createConversation(target, "late"),
    ]);
    const live = runtime("live");
    const late = runtime("late");
    const pending = deferred<ConversationRuntime<unknown>>();
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime: ({ conversationId }) =>
        conversationId === id("live") ? live.value : pending.promise,
    });
    await registry.open({ authorizationContext: "host", conversationId: id("live") });
    const opening = registry.open({ authorizationContext: "host", conversationId: id("late") });
    await vi.waitFor(() => expect(registry.getSnapshot().pendingCount).toBe(1));

    const disposing = registry.dispose();
    expect(registry.dispose()).toBe(disposing);
    expect(live.destroy).toHaveBeenCalledTimes(1);
    pending.resolve(late.value);
    await disposing;
    await expectRegistryCode(opening, "disposed");
    expect(late.destroy).toHaveBeenCalledTimes(1);
    await expectRegistryCode(registry.open({
      authorizationContext: "host",
      conversationId: id("live"),
    }), "disposed");
    await expectRegistryCode(registry.release(id("live")), "disposed");
    expect(live.destroy).toHaveBeenCalledTimes(1);
    expect(late.destroy).toHaveBeenCalledTimes(1);
  });

  it("enforces construction and retained-entry bounds without unbounded queues", async () => {
    const target = catalog();
    await Promise.all([
      createConversation(target, "one"),
      createConversation(target, "two"),
    ]);
    const first = deferred<ConversationRuntime<unknown>>();
    const firstRuntime = runtime("one");
    const secondRuntime = runtime("two");
    const createRuntime = vi.fn(({ conversationId }: { conversationId: ConversationId }) =>
      conversationId === id("one") ? first.promise : secondRuntime.value);
    const registry = new ConversationRuntimeRegistry({
      catalog: target,
      authorize: allowPolicy,
      createRuntime,
      limits: { maxEntries: 1, maxConcurrentConstructions: 1 },
    });

    const opening = registry.open({ authorizationContext: "host", conversationId: id("one") });
    await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledTimes(1));
    await expectRegistryCode(registry.open({
      authorizationContext: "host",
      conversationId: id("two"),
    }), "capacity_exhausted");
    expect(registry.getSnapshot()).toMatchObject({
      entryCount: 1,
      pendingCount: 1,
      activeConstructionCount: 1,
    });
    first.resolve(firstRuntime.value);
    await opening;
    await registry.release(id("one"));
    await expect(registry.open({
      authorizationContext: "host",
      conversationId: id("two"),
    })).resolves.toBe(secondRuntime.value);
    expect(createRuntime).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it("validates every configurable limit", () => {
    const target = catalog();
    const options = {
      catalog: target,
      authorize: allowPolicy,
      createRuntime: () => runtime("unused").value,
    };
    for (const limits of [
      { maxEntries: 0 },
      { maxEntries: CONVERSATION_RUNTIME_REGISTRY_LIMITS.entriesMaximum + 1 },
      { maxConcurrentConstructions: 0 },
      {
        maxConcurrentConstructions:
          CONVERSATION_RUNTIME_REGISTRY_LIMITS.concurrentConstructionsMaximum + 1,
      },
      { maxEntries: 1.5 },
      { unexpected: 1 },
    ]) {
      expect(() => new ConversationRuntimeRegistry({
        ...options,
        limits,
      } as never)).toThrowError(expect.objectContaining({
        name: "ConversationRuntimeRegistryError",
        code: "invalid_options",
      }));
    }
  });
});
