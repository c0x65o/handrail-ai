import {
  PROVIDER_CONTEXT_CHECKPOINT_VERSION,
  createProviderContextFingerprint,
  parseProviderContextIdempotencyKey,
  type ProviderContextCheckpoint,
  type ProviderContextCheckpointStore,
  type ProviderContextCheckpointStoreLimits,
  type ProviderContextFingerprint,
} from "../src/index.js";

export type ProviderContextCheckpointStoreConformanceFactory = (
  limits?: Partial<ProviderContextCheckpointStoreLimits>,
) => ProviderContextCheckpointStore;

export interface ProviderContextCheckpointStoreConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/** Framework-neutral behavior shared by host checkpoint-store adapters. */
export function providerContextCheckpointStoreConformanceCases(
  createStore: ProviderContextCheckpointStoreConformanceFactory,
): readonly ProviderContextCheckpointStoreConformanceCase[] {
  return [
    {
      name: "loads empty scopes and saves immutable input snapshots",
      run: async () => {
        const store = createStore();
        const contextFingerprint = fingerprint("model-a");
        const signal = activeSignal();
        equal(await store.load(loadInput("conversation-a", contextFingerprint, signal)), null);
        const emptyInvalidation = await store.invalidate({
          ...loadInput("conversation-a", contextFingerprint, signal),
          expected_version: null,
          idempotency_key: idempotencyKey("invalidate-empty"),
        });
        deepEqual(emptyInvalidation, {
          conversation_id: "conversation-a",
          context_fingerprint: contextFingerprint,
          invalidated: false,
          store_version: null,
        });

        const mutableCheckpoint = checkpoint(
          "conversation-a",
          contextFingerprint,
          "checkpoint-original",
          "b3JpZ2luYWw",
        );
        const pending = store.save({
          ...loadInput("conversation-a", contextFingerprint, signal),
          checkpoint: mutableCheckpoint,
          expected_version: null,
          idempotency_key: idempotencyKey("save-original"),
        });
        (mutableCheckpoint.history_position as { event_id: string | null }).event_id =
          "event-mutated";
        (mutableCheckpoint as { opaque_state: string }).opaque_state = "bXV0YXRlZA";

        const saved = await pending;
        equal(saved.store_version, 1);
        equal(saved.checkpoint.checkpoint_id, "checkpoint-original");
        equal(saved.checkpoint.opaque_state, "b3JpZ2luYWw");
        equal(saved.checkpoint.history_position.event_id, "event-1");
        assert(Object.isFrozen(saved), "Saved records must be frozen.");
        assert(Object.isFrozen(saved.checkpoint), "Saved checkpoints must be frozen.");
        assert(
          Object.isFrozen(saved.checkpoint.history_position),
          "Saved history positions must be frozen.",
        );

        let mutationRejected = false;
        try {
          Object.defineProperty(saved.checkpoint.history_position, "revision", {
            value: 99,
          });
        } catch {
          mutationRejected = true;
        }
        assert(mutationRejected, "Nested returned-record mutation must be rejected.");
        const loaded = await store.load(loadInput("conversation-a", contextFingerprint, signal));
        assert(loaded !== null, "Saved checkpoint must load.");
        equal(loaded.checkpoint.history_position.revision, 1);
        assert(loaded !== saved, "Loads must return a cloned record.");
        assert(loaded.checkpoint !== saved.checkpoint, "Loads must clone checkpoints.");
      },
    },
    {
      name: "enforces versions and stable idempotency replay",
      run: async () => {
        const store = createStore();
        const contextFingerprint = fingerprint("model-versioned");
        const firstInput = {
          ...loadInput("conversation-versioned", contextFingerprint, activeSignal()),
          checkpoint: checkpoint(
            "conversation-versioned",
            contextFingerprint,
            "checkpoint-v1",
            "djE",
          ),
          expected_version: null,
          idempotency_key: idempotencyKey("save-version-one"),
        };
        const first = await store.save(firstInput);
        const second = await store.save({
          ...loadInput("conversation-versioned", contextFingerprint, activeSignal()),
          checkpoint: checkpoint(
            "conversation-versioned",
            contextFingerprint,
            "checkpoint-v2",
            "djI",
          ),
          expected_version: 1,
          idempotency_key: idempotencyKey("save-version-two"),
        });
        equal(second.store_version, 2);

        const retry = await store.save(firstInput);
        deepEqual(retry, first);
        equal(retry.store_version, 1);
        const current = await requiredLoad(store, "conversation-versioned", contextFingerprint);
        equal(current.store_version, 2);
        equal(current.checkpoint.checkpoint_id, "checkpoint-v2");

        await rejectsWithCode(
          store.save({
            ...firstInput,
            checkpoint: checkpoint(
              "conversation-versioned",
              contextFingerprint,
              "checkpoint-conflict",
              "Y29uZmxpY3Q",
            ),
          }),
          "idempotency_conflict",
        );
        await rejectsWithCode(
          store.save({
            ...loadInput("conversation-versioned", contextFingerprint, activeSignal()),
            checkpoint: checkpoint(
              "conversation-versioned",
              contextFingerprint,
              "checkpoint-stale",
              "c3RhbGU",
            ),
            expected_version: 1,
            idempotency_key: idempotencyKey("save-stale"),
          }),
          "version_conflict",
        );
        equal(
          (await requiredLoad(store, "conversation-versioned", contextFingerprint))
            .checkpoint.checkpoint_id,
          "checkpoint-v2",
        );
      },
    },
    {
      name: "invalidates safely while isolating conversations and fingerprints",
      run: async () => {
        const store = createStore();
        const fingerprintA = fingerprint("model-isolated-a");
        const fingerprintB = fingerprint("model-isolated-b");
        await Promise.all([
          saveInitial(store, "conversation-a", fingerprintA, "scope-a"),
          saveInitial(store, "conversation-b", fingerprintA, "scope-b"),
          saveInitial(store, "conversation-a", fingerprintB, "scope-c"),
        ]);
        const invalidationInput = {
          ...loadInput("conversation-a", fingerprintA, activeSignal()),
          expected_version: 1,
          idempotency_key: idempotencyKey("invalidate-scope-a"),
        };
        const invalidated = await store.invalidate(invalidationInput);
        deepEqual(invalidated, {
          conversation_id: "conversation-a",
          context_fingerprint: fingerprintA,
          invalidated: true,
          store_version: 2,
        });
        equal(await store.load(loadInput("conversation-a", fingerprintA, activeSignal())), null);
        assert(
          await store.load(loadInput("conversation-b", fingerprintA, activeSignal())) !== null,
          "A different conversation must remain present.",
        );
        assert(
          await store.load(loadInput("conversation-a", fingerprintB, activeSignal())) !== null,
          "A different fingerprint must remain present.",
        );

        await rejectsWithCode(
          store.save({
            ...loadInput("conversation-a", fingerprintA, activeSignal()),
            checkpoint: checkpoint("conversation-a", fingerprintA, "stale", "c3RhbGU"),
            expected_version: 1,
            idempotency_key: idempotencyKey("stale-after-invalidate"),
          }),
          "version_conflict",
        );
        const recreated = await store.save({
          ...loadInput("conversation-a", fingerprintA, activeSignal()),
          checkpoint: checkpoint("conversation-a", fingerprintA, "recreated", "bmV3"),
          expected_version: null,
          idempotency_key: idempotencyKey("recreate-after-invalidate"),
        });
        equal(recreated.store_version, 3);
        deepEqual(await store.invalidate(invalidationInput), invalidated);
        equal(
          (await requiredLoad(store, "conversation-a", fingerprintA)).checkpoint
            .checkpoint_id,
          "recreated",
        );
      },
    },
    {
      name: "rejects already-aborted and asynchronously aborted operations without mutation",
      run: async () => {
        const store = createStore();
        const contextFingerprint = fingerprint("model-abort");
        const alreadyAborted = new AbortController();
        alreadyAborted.abort("private cancellation reason");
        await rejectsWithCode(
          store.load(loadInput("conversation-abort", contextFingerprint, alreadyAborted.signal)),
          "cancelled",
        );
        await rejectsWithCode(
          store.save({
            ...loadInput("conversation-abort", contextFingerprint, alreadyAborted.signal),
            checkpoint: checkpoint(
              "conversation-abort",
              contextFingerprint,
              "never-saved",
              "bmV2ZXI",
            ),
            expected_version: null,
            idempotency_key: idempotencyKey("never-saved"),
          }),
          "cancelled",
        );

        const asynchronouslyAborted = new AbortController();
        const pending = store.save({
          ...loadInput(
            "conversation-abort",
            contextFingerprint,
            asynchronouslyAborted.signal,
          ),
          checkpoint: checkpoint(
            "conversation-abort",
            contextFingerprint,
            "async-never-saved",
            "bmV2ZXI",
          ),
          expected_version: null,
          idempotency_key: idempotencyKey("async-never-saved"),
        });
        asynchronouslyAborted.abort("provider input must not escape");
        await rejectsWithCode(pending, "cancelled");
        equal(
          await store.load(
            loadInput("conversation-abort", contextFingerprint, activeSignal()),
          ),
          null,
        );

        await saveInitial(store, "conversation-abort", contextFingerprint, "saved");
        await rejectsWithCode(
          store.invalidate({
            ...loadInput("conversation-abort", contextFingerprint, alreadyAborted.signal),
            expected_version: 1,
            idempotency_key: idempotencyKey("aborted-invalidate"),
          }),
          "cancelled",
        );
        assert(
          await store.load(
            loadInput("conversation-abort", contextFingerprint, activeSignal()),
          ) !== null,
          "An aborted invalidation must not mutate retained state.",
        );
      },
    },
  ];
}

export function checkpoint(
  conversationId: string,
  contextFingerprint: ProviderContextFingerprint,
  checkpointId: string,
  opaqueState: string,
): ProviderContextCheckpoint {
  return {
    version: PROVIDER_CONTEXT_CHECKPOINT_VERSION,
    provider_id: "example",
    checkpoint_id: checkpointId,
    format: "opaque-v1",
    opaque_state: opaqueState,
    context_fingerprint: contextFingerprint,
    history_position: {
      conversation_id: conversationId,
      revision: 1,
      event_id: "event-1",
    },
  };
}

export function fingerprint(modelId: string): ProviderContextFingerprint {
  return createProviderContextFingerprint({
    model: { provider_id: "example", model_id: modelId },
    instructions: [],
    tools: [],
    generation: { max_output_tokens: 100, temperature: 0 },
  });
}

function loadInput(
  conversationId: string,
  contextFingerprint: ProviderContextFingerprint,
  signal: AbortSignal,
) {
  return {
    conversation_id: conversationId,
    context_fingerprint: contextFingerprint,
    signal,
  } as const;
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

function idempotencyKey(value: string) {
  return parseProviderContextIdempotencyKey(value);
}

async function saveInitial(
  store: ProviderContextCheckpointStore,
  conversationId: string,
  contextFingerprint: ProviderContextFingerprint,
  suffix: string,
) {
  return store.save({
    ...loadInput(conversationId, contextFingerprint, activeSignal()),
    checkpoint: checkpoint(
      conversationId,
      contextFingerprint,
      `checkpoint-${suffix}`,
      "b3BhcXVl",
    ),
    expected_version: null,
    idempotency_key: idempotencyKey(`save-${suffix}`),
  });
}

async function requiredLoad(
  store: ProviderContextCheckpointStore,
  conversationId: string,
  contextFingerprint: ProviderContextFingerprint,
) {
  const loaded = await store.load(
    loadInput(conversationId, contextFingerprint, activeSignal()),
  );
  assert(loaded !== null, "Expected a retained checkpoint.");
  return loaded;
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    equal((error as { readonly code?: unknown }).code, code);
    return;
  }
  throw new Error(`Expected rejection with code ${code}.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}

function deepEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`);
  }
}
