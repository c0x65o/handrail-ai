import {
  AI_RUNTIME_PROTOCOL_LIMITS,
  parseChatRequest,
  type ChatRequest,
} from "../protocol.js";

/** Schema version for a durable managed-runtime replay record. */
export const MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION = 1 as const;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Runtime-neutral state required to reopen one managed-runtime turn exactly.
 *
 * The record is limited to durable replay identity and canonical request data.
 * `serializedBody` is retained byte-for-byte and must equal the JSON
 * serialization of `request`.
 */
export interface ManagedRuntimeTurnStateRecord {
  readonly schemaVersion: typeof MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION;
  readonly conversationId: string;
  /** Remote managed-runtime request/turn identifier. */
  readonly turnId: string;
  /** Caller-owned durable conversation turn identifier. */
  readonly conversationTurnId: string;
  readonly mutationId: string;
  readonly request: ChatRequest;
  readonly serializedBody: string;
  readonly idempotencyKey: string;
}

export interface ManagedRuntimeTurnStateStoreConflictDetails {
  readonly code: "replay_identity_conflict";
  readonly conversationId: string;
  readonly turnId: string;
}

/** A deterministic conflict; the attempted save must not replace stored state. */
export class ManagedRuntimeTurnStateStoreConflictError extends Error {
  readonly code = "replay_identity_conflict" as const;
  readonly conversationId: string;
  readonly turnId: string;

  constructor(
    message: string,
    details: ManagedRuntimeTurnStateStoreConflictDetails,
  ) {
    super(message);
    this.name = "ManagedRuntimeTurnStateStoreConflictError";
    this.conversationId = details.conversationId;
    this.turnId = details.turnId;
  }
}

export type ManagedRuntimeTurnStateStoreOperation = "load" | "save";

/** A storage availability failure that may be safe for the caller to retry. */
export class ManagedRuntimeTurnStateStoreUnavailableError extends Error {
  readonly operation: ManagedRuntimeTurnStateStoreOperation;
  readonly retryable: boolean;

  constructor(
    operation: ManagedRuntimeTurnStateStoreOperation,
    message: string,
    retryable = true,
  ) {
    super(message);
    this.name = "ManagedRuntimeTurnStateStoreUnavailableError";
    this.operation = operation;
    this.retryable = retryable;
  }
}

/**
 * Trusted-server persistence boundary for managed-runtime replay identity.
 *
 * Implementations must validate both saved and loaded values with
 * `parseManagedRuntimeTurnStateRecord` and must return defensive clones. A save
 * for an existing conversationId/turnId is idempotent only when every field is
 * identical. Otherwise it atomically throws
 * ManagedRuntimeTurnStateStoreConflictError without replacing stored state.
 */
export interface ManagedRuntimeTurnStateStore {
  load(
    conversationId: string,
    turnId: string,
  ): Promise<ManagedRuntimeTurnStateRecord | null>;
  save(
    record: ManagedRuntimeTurnStateRecord,
  ): Promise<ManagedRuntimeTurnStateRecord>;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError("Managed runtime turn state must be a JSON object.");
  }
  return value as UnknownRecord;
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > AI_RUNTIME_PROTOCOL_LIMITS.identifierLength
  ) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${AI_RUNTIME_PROTOCOL_LIMITS.identifierLength} characters.`,
    );
  }
  return value;
}

/**
 * Validates and defensively clones an untrusted durable record.
 *
 * This parser also proves that the retained body is the exact canonical JSON
 * serialization of the retained ChatRequest.
 */
export function parseManagedRuntimeTurnStateRecord(
  value: unknown,
): ManagedRuntimeTurnStateRecord {
  const source = record(value);
  const fields = [
    "schemaVersion",
    "conversationId",
    "turnId",
    "conversationTurnId",
    "mutationId",
    "request",
    "serializedBody",
    "idempotencyKey",
  ] as const;
  const allowed = new Set<string>(fields);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) {
      throw new TypeError(`Managed runtime turn state field ${key} is not supported.`);
    }
  }
  for (const field of fields) {
    if (!Object.hasOwn(source, field)) {
      throw new TypeError(`Managed runtime turn state field ${field} is required.`);
    }
  }

  if (source.schemaVersion !== MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION) {
    throw new TypeError(
      `Managed runtime turn state schemaVersion must equal ${MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION}.`,
    );
  }

  const conversationId = identifier(source.conversationId, "conversationId");
  const turnId = identifier(source.turnId, "turnId");
  const conversationTurnId = identifier(
    source.conversationTurnId,
    "conversationTurnId",
  );
  const mutationId = identifier(source.mutationId, "mutationId");
  if (
    typeof source.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY.test(source.idempotencyKey)
  ) {
    throw new TypeError(
      "idempotencyKey must contain 1-128 letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }
  if (typeof source.serializedBody !== "string") {
    throw new TypeError("serializedBody must be a string.");
  }

  const validatedRequest = parseChatRequest(source.request);
  const request = JSON.parse(JSON.stringify(validatedRequest)) as ChatRequest;
  parseChatRequest(request);
  const canonicalBody = JSON.stringify(request);
  if (source.serializedBody !== canonicalBody) {
    throw new TypeError(
      "serializedBody must exactly match the canonical ChatRequest serialization.",
    );
  }

  return {
    schemaVersion: MANAGED_RUNTIME_TURN_STATE_SCHEMA_VERSION,
    conversationId,
    turnId,
    conversationTurnId,
    mutationId,
    request,
    serializedBody: source.serializedBody,
    idempotencyKey: source.idempotencyKey,
  };
}
