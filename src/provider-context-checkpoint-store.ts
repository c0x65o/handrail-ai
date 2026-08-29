import {
  PROVIDER_CONTEXT_LIMITS,
  ProviderContextValidationError,
  parseProviderContextCheckpoint,
  parseProviderContextIdempotencyKey,
  type ProviderContextCheckpoint,
  type ProviderContextFingerprint,
  type ProviderContextIdempotencyKey,
} from "./provider-context.js";

export const PROVIDER_CONTEXT_CHECKPOINT_STORE_LIMITS = Object.freeze({
  maxCheckpointSerializedBytes: PROVIDER_CONTEXT_LIMITS.checkpointSerializedBytes,
  maxCheckpoints: 1_000,
  maxIdempotencyRecords: 2_000,
} as const);

export interface ProviderContextCheckpointStoreLimits {
  /** Per-checkpoint limit, including the complete validated opaque envelope. */
  readonly maxCheckpointSerializedBytes: number;
  /** Maximum retained conversation/fingerprint slots, including invalidated tombstones. */
  readonly maxCheckpoints: number;
  /** Maximum retained retry results. The in-memory adapter evicts the oldest first. */
  readonly maxIdempotencyRecords: number;
}

export interface LoadProviderContextCheckpointInput {
  readonly conversation_id: string;
  readonly context_fingerprint: ProviderContextFingerprint;
  readonly signal: AbortSignal;
}

export interface SaveProviderContextCheckpointInput
  extends LoadProviderContextCheckpointInput {
  readonly checkpoint: ProviderContextCheckpoint;
  /** `null` means no checkpoint is currently present. Versions start at one. */
  readonly expected_version: number | null;
  readonly idempotency_key: ProviderContextIdempotencyKey;
}

export interface InvalidateProviderContextCheckpointInput
  extends LoadProviderContextCheckpointInput {
  /** `null` means no checkpoint is currently present. */
  readonly expected_version: number | null;
  readonly idempotency_key: ProviderContextIdempotencyKey;
}

export interface ProviderContextCheckpointRecord {
  readonly conversation_id: string;
  readonly context_fingerprint: ProviderContextFingerprint;
  readonly checkpoint: ProviderContextCheckpoint;
  readonly store_version: number;
}

export interface ProviderContextCheckpointInvalidationResult {
  readonly conversation_id: string;
  readonly context_fingerprint: ProviderContextFingerprint;
  readonly invalidated: boolean;
  /** The scope version, or `null` when the scope has never retained a checkpoint. */
  readonly store_version: number | null;
}

/**
 * Storage-neutral persistence boundary for optional provider acceleration data.
 *
 * Implementations must atomically enforce versions and idempotency. They retain
 * only validated `ProviderContextCheckpoint` envelopes plus the minimal metadata
 * needed for scoping, versions, invalidation, and bounded retry replay. Canonical
 * events and provider inputs never cross this boundary.
 */
export interface ProviderContextCheckpointStore {
  load(
    input: LoadProviderContextCheckpointInput,
  ): Promise<ProviderContextCheckpointRecord | null>;
  save(
    input: SaveProviderContextCheckpointInput,
  ): Promise<ProviderContextCheckpointRecord>;
  invalidate(
    input: InvalidateProviderContextCheckpointInput,
  ): Promise<ProviderContextCheckpointInvalidationResult>;
}

export type ProviderContextCheckpointStoreOperation =
  | "load"
  | "save"
  | "invalidate";

export type ProviderContextCheckpointStoreErrorCode =
  | "invalid_input"
  | "checkpoint_too_large"
  | "version_conflict"
  | "idempotency_conflict"
  | "cancelled"
  | "unavailable";

const STORE_ERROR_DEFINITIONS: Readonly<Record<
  ProviderContextCheckpointStoreErrorCode,
  { readonly message: string; readonly retryable: boolean }
>> = Object.freeze({
  invalid_input: {
    message: "The provider-context checkpoint-store request is invalid.",
    retryable: false,
  },
  checkpoint_too_large: {
    message: "The provider-context checkpoint exceeds the configured size limit.",
    retryable: false,
  },
  version_conflict: {
    message: "The provider-context checkpoint version has changed.",
    retryable: true,
  },
  idempotency_conflict: {
    message: "The checkpoint-store idempotency key was reused for a different request.",
    retryable: false,
  },
  cancelled: {
    message: "The provider-context checkpoint-store operation was cancelled.",
    retryable: false,
  },
  unavailable: {
    message: "The provider-context checkpoint store is temporarily unavailable.",
    retryable: true,
  },
});

/** A deterministic error that contains no checkpoint, provider, or host details. */
export class ProviderContextCheckpointStoreError extends Error {
  readonly code: ProviderContextCheckpointStoreErrorCode;
  readonly operation: ProviderContextCheckpointStoreOperation;
  readonly retryable: boolean;

  constructor(
    code: ProviderContextCheckpointStoreErrorCode,
    operation: ProviderContextCheckpointStoreOperation,
  ) {
    const definition = STORE_ERROR_DEFINITIONS[code];
    super(definition.message);
    this.name = "ProviderContextCheckpointStoreError";
    this.code = code;
    this.operation = operation;
    this.retryable = definition.retryable;
  }
}

export interface InMemoryProviderContextCheckpointStoreOptions {
  readonly limits?: Partial<ProviderContextCheckpointStoreLimits>;
}

interface CheckpointSlot {
  readonly version: number;
  readonly checkpoint: ProviderContextCheckpoint | null;
}

interface SaveIdempotencyRecord {
  readonly operation: "save";
  readonly signature: string;
  readonly result: ProviderContextCheckpointRecord;
}

interface InvalidateIdempotencyRecord {
  readonly operation: "invalidate";
  readonly signature: string;
  readonly result: ProviderContextCheckpointInvalidationResult;
}

type IdempotencyRecord = SaveIdempotencyRecord | InvalidateIdempotencyRecord;

interface LoadSnapshot {
  readonly conversationId: string;
  readonly fingerprint: ProviderContextFingerprint;
  readonly signal: AbortSignal;
}

interface SaveSnapshot extends LoadSnapshot {
  readonly checkpoint: ProviderContextCheckpoint;
  readonly checkpointBytes: number;
  readonly expectedVersion: number | null;
  readonly idempotencyKey: ProviderContextIdempotencyKey;
  readonly signature: string;
}

interface InvalidateSnapshot extends LoadSnapshot {
  readonly expectedVersion: number | null;
  readonly idempotencyKey: ProviderContextIdempotencyKey;
  readonly signature: string;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const UTF8_ENCODER = new TextEncoder();
const MAX_CONFIGURED_RECORDS = 1_000_000;

/**
 * Bounded process-local reference adapter for tests, examples, and development.
 *
 * It is not durable persistence. Scope slots and idempotency results use
 * deterministic least-recently-mutated/FIFO eviction respectively, and all
 * retained state is lost with the instance or process.
 */
export class InMemoryProviderContextCheckpointStore
  implements ProviderContextCheckpointStore
{
  readonly #limits: Readonly<ProviderContextCheckpointStoreLimits>;
  readonly #slots = new Map<string, CheckpointSlot>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(options: InMemoryProviderContextCheckpointStoreOptions = {}) {
    this.#limits = resolveLimits(options.limits);
  }

  async load(
    input: LoadProviderContextCheckpointInput,
  ): Promise<ProviderContextCheckpointRecord | null> {
    const snapshot = snapshotLoad(input, "load");
    await asyncBoundary(snapshot.signal, "load");
    const mutationBoundary = this.#mutationTail;
    await mutationBoundary;
    throwIfCancelled(snapshot.signal, "load");
    const slot = this.#slots.get(scopeKey(snapshot));
    if (slot?.checkpoint === null || slot === undefined) return null;
    return cloneCheckpointRecord({
      conversation_id: snapshot.conversationId,
      context_fingerprint: snapshot.fingerprint,
      checkpoint: slot.checkpoint,
      store_version: slot.version,
    });
  }

  async save(
    input: SaveProviderContextCheckpointInput,
  ): Promise<ProviderContextCheckpointRecord> {
    const snapshot = snapshotSave(input);
    if (snapshot.checkpointBytes > this.#limits.maxCheckpointSerializedBytes) {
      throw new ProviderContextCheckpointStoreError("checkpoint_too_large", "save");
    }
    await asyncBoundary(snapshot.signal, "save");
    return this.#enqueue(snapshot.signal, "save", () => this.#save(snapshot));
  }

  async invalidate(
    input: InvalidateProviderContextCheckpointInput,
  ): Promise<ProviderContextCheckpointInvalidationResult> {
    const snapshot = snapshotInvalidate(input);
    await asyncBoundary(snapshot.signal, "invalidate");
    return this.#enqueue(
      snapshot.signal,
      "invalidate",
      () => this.#invalidate(snapshot),
    );
  }

  #save(snapshot: SaveSnapshot): ProviderContextCheckpointRecord {
    const replay = this.#idempotency.get(snapshot.idempotencyKey);
    if (replay !== undefined) {
      if (replay.operation !== "save" || replay.signature !== snapshot.signature) {
        throw new ProviderContextCheckpointStoreError("idempotency_conflict", "save");
      }
      return cloneCheckpointRecord(replay.result);
    }

    const key = scopeKey(snapshot);
    const current = this.#slots.get(key);
    assertExpectedVersion(current, snapshot.expectedVersion, "save");
    const nextVersion = (current?.version ?? 0) + 1;
    const retainedCheckpoint = parseProviderContextCheckpoint(snapshot.checkpoint);
    const result = freezeCheckpointRecord({
      conversation_id: snapshot.conversationId,
      context_fingerprint: snapshot.fingerprint,
      checkpoint: retainedCheckpoint,
      store_version: nextVersion,
    });

    if (current === undefined && this.#slots.size >= this.#limits.maxCheckpoints) {
      this.#evictOldestSlot();
    }
    this.#touchSlot(key, Object.freeze({
      version: nextVersion,
      checkpoint: retainedCheckpoint,
    }));
    this.#rememberIdempotency(snapshot.idempotencyKey, Object.freeze({
      operation: "save",
      signature: snapshot.signature,
      result,
    }));
    return cloneCheckpointRecord(result);
  }

  #invalidate(
    snapshot: InvalidateSnapshot,
  ): ProviderContextCheckpointInvalidationResult {
    const replay = this.#idempotency.get(snapshot.idempotencyKey);
    if (replay !== undefined) {
      if (
        replay.operation !== "invalidate" ||
        replay.signature !== snapshot.signature
      ) {
        throw new ProviderContextCheckpointStoreError(
          "idempotency_conflict",
          "invalidate",
        );
      }
      return cloneInvalidationResult(replay.result);
    }

    const key = scopeKey(snapshot);
    const current = this.#slots.get(key);
    assertExpectedVersion(current, snapshot.expectedVersion, "invalidate");
    const invalidated = current?.checkpoint !== null && current !== undefined;
    let storeVersion = current?.version ?? null;
    if (invalidated && current !== undefined) {
      storeVersion = current.version + 1;
      this.#touchSlot(key, Object.freeze({
        version: storeVersion,
        checkpoint: null,
      }));
    }
    const result = freezeInvalidationResult({
      conversation_id: snapshot.conversationId,
      context_fingerprint: snapshot.fingerprint,
      invalidated,
      store_version: storeVersion,
    });
    this.#rememberIdempotency(snapshot.idempotencyKey, Object.freeze({
      operation: "invalidate",
      signature: snapshot.signature,
      result,
    }));
    return cloneInvalidationResult(result);
  }

  #enqueue<T>(
    signal: AbortSignal,
    operation: "save" | "invalidate",
    mutate: () => T,
  ): Promise<T> {
    const result = this.#mutationTail.then(() => {
      throwIfCancelled(signal, operation);
      return mutate();
    });
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #touchSlot(key: string, slot: CheckpointSlot): void {
    this.#slots.delete(key);
    this.#slots.set(key, slot);
  }

  #evictOldestSlot(): void {
    const oldest = this.#slots.keys().next().value as string | undefined;
    if (oldest !== undefined) this.#slots.delete(oldest);
  }

  #rememberIdempotency(
    key: ProviderContextIdempotencyKey,
    record: IdempotencyRecord,
  ): void {
    if (this.#idempotency.size >= this.#limits.maxIdempotencyRecords) {
      const oldest = this.#idempotency.keys().next().value as string | undefined;
      if (oldest !== undefined) this.#idempotency.delete(oldest);
    }
    this.#idempotency.set(key, record);
  }
}

function snapshotLoad(
  input: LoadProviderContextCheckpointInput,
  operation: ProviderContextCheckpointStoreOperation,
): LoadSnapshot {
  const source = inputRecord(input, operation, [
    "conversation_id",
    "context_fingerprint",
    "signal",
  ]);
  return Object.freeze({
    conversationId: parseConversationId(source.conversation_id, operation),
    fingerprint: parseFingerprint(source.context_fingerprint, operation),
    signal: parseSignal(source.signal, operation),
  });
}

function snapshotSave(input: SaveProviderContextCheckpointInput): SaveSnapshot {
  const operation = "save" as const;
  const source = inputRecord(input, operation, [
    "conversation_id",
    "context_fingerprint",
    "signal",
    "checkpoint",
    "expected_version",
    "idempotency_key",
  ]);
  const base = snapshotLoadFields(source, operation);
  const checkpoint = parseCheckpoint(source.checkpoint, operation);
  if (
    checkpoint.history_position.conversation_id !== base.conversationId ||
    checkpoint.context_fingerprint !== base.fingerprint
  ) {
    throw new ProviderContextCheckpointStoreError("invalid_input", operation);
  }
  const expectedVersion = parseExpectedVersion(source.expected_version, operation);
  const idempotencyKey = parseIdempotencyKey(source.idempotency_key, operation);
  const serializedCheckpoint = JSON.stringify(checkpoint);
  return Object.freeze({
    ...base,
    checkpoint,
    checkpointBytes: UTF8_ENCODER.encode(serializedCheckpoint).byteLength,
    expectedVersion,
    idempotencyKey,
    signature: JSON.stringify({
      operation,
      conversation_id: base.conversationId,
      context_fingerprint: base.fingerprint,
      expected_version: expectedVersion,
      checkpoint: serializedCheckpoint,
    }),
  });
}

function snapshotInvalidate(
  input: InvalidateProviderContextCheckpointInput,
): InvalidateSnapshot {
  const operation = "invalidate" as const;
  const source = inputRecord(input, operation, [
    "conversation_id",
    "context_fingerprint",
    "signal",
    "expected_version",
    "idempotency_key",
  ]);
  const base = snapshotLoadFields(source, operation);
  const expectedVersion = parseExpectedVersion(source.expected_version, operation);
  const idempotencyKey = parseIdempotencyKey(source.idempotency_key, operation);
  return Object.freeze({
    ...base,
    expectedVersion,
    idempotencyKey,
    signature: JSON.stringify({
      operation,
      conversation_id: base.conversationId,
      context_fingerprint: base.fingerprint,
      expected_version: expectedVersion,
    }),
  });
}

function snapshotLoadFields(
  source: Record<string, unknown>,
  operation: ProviderContextCheckpointStoreOperation,
): LoadSnapshot {
  return Object.freeze({
    conversationId: parseConversationId(source.conversation_id, operation),
    fingerprint: parseFingerprint(source.context_fingerprint, operation),
    signal: parseSignal(source.signal, operation),
  });
}

function inputRecord(
  value: unknown,
  operation: ProviderContextCheckpointStoreOperation,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new ProviderContextCheckpointStoreError("invalid_input", operation);
  }
  const source = value as Record<string, unknown>;
  if (
    Object.getOwnPropertySymbols(source).length > 0 ||
    Object.keys(source).some((key) => !fields.includes(key)) ||
    fields.some((key) => !Object.hasOwn(source, key)) ||
    Object.values(Object.getOwnPropertyDescriptors(source)).some(
      (descriptor) => !descriptor.enumerable || !("value" in descriptor),
    )
  ) {
    throw new ProviderContextCheckpointStoreError("invalid_input", operation);
  }
  return source;
}

function parseConversationId(
  value: unknown,
  operation: ProviderContextCheckpointStoreOperation,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > PROVIDER_CONTEXT_LIMITS.identifierLength ||
    !IDENTIFIER.test(value)
  ) {
    throw new ProviderContextCheckpointStoreError("invalid_input", operation);
  }
  return value;
}

function parseFingerprint(
  value: unknown,
  operation: ProviderContextCheckpointStoreOperation,
): ProviderContextFingerprint {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) {
    throw new ProviderContextCheckpointStoreError("invalid_input", operation);
  }
  return value as ProviderContextFingerprint;
}

function parseSignal(
  value: unknown,
  operation: ProviderContextCheckpointStoreOperation,
): AbortSignal {
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as AbortSignal).aborted !== "boolean" ||
    typeof (value as AbortSignal).addEventListener !== "function" ||
    typeof (value as AbortSignal).removeEventListener !== "function" ||
    typeof (value as AbortSignal).throwIfAborted !== "function"
  ) {
    throw new ProviderContextCheckpointStoreError("invalid_input", operation);
  }
  return value as AbortSignal;
}

function parseCheckpoint(
  value: unknown,
  operation: "save",
): ProviderContextCheckpoint {
  try {
    return parseProviderContextCheckpoint(value);
  } catch (error) {
    if (error instanceof ProviderContextValidationError) {
      throw new ProviderContextCheckpointStoreError("invalid_input", operation);
    }
    throw error;
  }
}

function parseIdempotencyKey(
  value: unknown,
  operation: "save" | "invalidate",
): ProviderContextIdempotencyKey {
  try {
    return parseProviderContextIdempotencyKey(value);
  } catch (error) {
    if (error instanceof ProviderContextValidationError) {
      throw new ProviderContextCheckpointStoreError("invalid_input", operation);
    }
    throw error;
  }
}

function parseExpectedVersion(
  value: unknown,
  operation: "save" | "invalidate",
): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProviderContextCheckpointStoreError("invalid_input", operation);
  }
  return value as number;
}

function assertExpectedVersion(
  current: CheckpointSlot | undefined,
  expected: number | null,
  operation: "save" | "invalidate",
): void {
  const matches = expected === null
    ? current?.checkpoint === null || current === undefined
    : current?.version === expected;
  if (!matches) {
    throw new ProviderContextCheckpointStoreError("version_conflict", operation);
  }
}

function scopeKey(input: LoadSnapshot): string {
  return `${input.conversationId}\u0000${input.fingerprint}`;
}

function freezeCheckpointRecord(
  record: ProviderContextCheckpointRecord,
): ProviderContextCheckpointRecord {
  return Object.freeze(record);
}

function cloneCheckpointRecord(
  record: ProviderContextCheckpointRecord,
): ProviderContextCheckpointRecord {
  return freezeCheckpointRecord({
    conversation_id: record.conversation_id,
    context_fingerprint: record.context_fingerprint,
    checkpoint: parseProviderContextCheckpoint(record.checkpoint),
    store_version: record.store_version,
  });
}

function freezeInvalidationResult(
  result: ProviderContextCheckpointInvalidationResult,
): ProviderContextCheckpointInvalidationResult {
  return Object.freeze(result);
}

function cloneInvalidationResult(
  result: ProviderContextCheckpointInvalidationResult,
): ProviderContextCheckpointInvalidationResult {
  return freezeInvalidationResult({ ...result });
}

async function asyncBoundary(
  signal: AbortSignal,
  operation: ProviderContextCheckpointStoreOperation,
): Promise<void> {
  throwIfCancelled(signal, operation);
  await Promise.resolve();
  throwIfCancelled(signal, operation);
}

function throwIfCancelled(
  signal: AbortSignal,
  operation: ProviderContextCheckpointStoreOperation,
): void {
  if (signal.aborted) {
    throw new ProviderContextCheckpointStoreError("cancelled", operation);
  }
}

function resolveLimits(
  limits: Partial<ProviderContextCheckpointStoreLimits> | undefined,
): Readonly<ProviderContextCheckpointStoreLimits> {
  const resolved = {
    ...PROVIDER_CONTEXT_CHECKPOINT_STORE_LIMITS,
    ...limits,
  };
  if (
    !positiveInteger(resolved.maxCheckpointSerializedBytes) ||
    resolved.maxCheckpointSerializedBytes >
      PROVIDER_CONTEXT_LIMITS.checkpointSerializedBytes
  ) {
    throw new TypeError(
      `limits.maxCheckpointSerializedBytes must be a positive integer no greater than ${PROVIDER_CONTEXT_LIMITS.checkpointSerializedBytes}`,
    );
  }
  for (const key of ["maxCheckpoints", "maxIdempotencyRecords"] as const) {
    if (!positiveInteger(resolved[key]) || resolved[key] > MAX_CONFIGURED_RECORDS) {
      throw new TypeError(
        `limits.${key} must be a positive integer no greater than ${MAX_CONFIGURED_RECORDS}`,
      );
    }
  }
  return Object.freeze(resolved);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}
