export const PRESENCE_PARTICIPANT_KINDS = [
  "human",
  "assistant",
  "system",
] as const;

export const PRESENCE_STATES = [
  "online",
  "active",
  "idle",
  "offline",
] as const;

export const ASSISTANT_ACTIVITIES = [
  "thinking",
  "responding",
  "using_tool",
] as const;

export const PRESENCE_LIMITS = { identifierLength: 256 } as const;

declare const opaquePresenceValue: unique symbol;
type OpaqueString<Name extends string> = string & {
  readonly [opaquePresenceValue]: Name;
};

export type PresenceParticipantId = OpaqueString<"PresenceParticipantId">;
export type PresenceDeviceId = OpaqueString<"PresenceDeviceId">;
export type PresenceSessionId = OpaqueString<"PresenceSessionId">;
export type PresenceTimestamp = OpaqueString<"PresenceTimestamp">;
export type PresenceRecordKey = OpaqueString<"PresenceRecordKey">;

export type PresenceParticipantKind =
  (typeof PRESENCE_PARTICIPANT_KINDS)[number];
export type PresenceState = (typeof PRESENCE_STATES)[number];
export type AssistantActivity = (typeof ASSISTANT_ACTIVITIES)[number];

/**
 * A provider-neutral, ephemeral observation for one participant session.
 *
 * Presence records are snapshots/events for live UI coordination, not durable
 * conversation facts. They must be excluded from ConversationEventStore
 * checkpoints and authoritative replay. A consumer may separately retain a
 * last-known record as a non-authoritative UI hint.
 *
 * `session_id` identifies one independently addressable connection lifetime.
 * `device_id`, when available, additionally keeps sessions on different
 * devices distinct even if their session identifiers happen to match.
 */
export interface PresenceRecord {
  readonly participant_id: PresenceParticipantId;
  readonly device_id?: PresenceDeviceId;
  readonly session_id: PresenceSessionId;
  readonly participant_kind: PresenceParticipantKind;
  readonly state: PresenceState;
  readonly assistant_activity?: AssistantActivity;
  readonly typing: boolean;
  readonly updated_at: PresenceTimestamp;
  readonly expires_at: PresenceTimestamp;
  readonly typing_expires_at?: PresenceTimestamp;
}

export interface PresenceClock {
  (): number;
}

export interface PresenceTimeOptions {
  /** Returns Unix epoch milliseconds. It is invoked once per helper call. */
  readonly clock?: PresenceClock;
}

export interface PresenceParticipantSummary {
  readonly participant_id: PresenceParticipantId;
  readonly participant_kind: PresenceParticipantKind;
  readonly state: Exclude<PresenceState, "offline">;
  readonly assistant_activity?: AssistantActivity;
  readonly typing: boolean;
  readonly updated_at: PresenceTimestamp;
  readonly record_count: number;
  /** Live session records in deterministic record-key order. */
  readonly records: readonly PresenceRecord[];
}

export class PresenceValidationError extends TypeError {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "PresenceValidationError";
    this.path = path;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

const ALLOWED_RECORD_FIELDS = new Set([
  "participant_id",
  "device_id",
  "session_id",
  "participant_kind",
  "state",
  "assistant_activity",
  "typing",
  "updated_at",
  "expires_at",
  "typing_expires_at",
]);

const PARTICIPANT_KINDS = new Set<string>(PRESENCE_PARTICIPANT_KINDS);
const STATES = new Set<string>(PRESENCE_STATES);
const ACTIVITIES = new Set<string>(ASSISTANT_ACTIVITIES);

interface ParsedTimestamp {
  readonly value: PresenceTimestamp;
  readonly milliseconds: number;
}

const expectObject = (value: unknown): Record<string, unknown> => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new PresenceValidationError("presence", "must be a plain object");
  }
  return value as Record<string, unknown>;
};

const requireField = (
  input: Record<string, unknown>,
  field: string,
): unknown => {
  if (!Object.hasOwn(input, field)) {
    throw new PresenceValidationError(field, "is required");
  }
  return input[field];
};

const normalizeIdentifier = <TIdentifier extends string>(
  value: unknown,
  path: string,
): TIdentifier => {
  if (typeof value !== "string") {
    throw new PresenceValidationError(path, "must be a string identifier");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new PresenceValidationError(path, "must not be empty");
  }
  if (normalized.length > PRESENCE_LIMITS.identifierLength) {
    throw new PresenceValidationError(
      path,
      `must be at most ${PRESENCE_LIMITS.identifierLength} characters`,
    );
  }
  if (!IDENTIFIER_PATTERN.test(normalized)) {
    throw new PresenceValidationError(
      path,
      "must use letters, numbers, dot, underscore, colon, at-sign, or hyphen",
    );
  }
  return normalized as TIdentifier;
};

const parseTimestamp = (value: unknown, path: string): ParsedTimestamp => {
  if (typeof value !== "string") {
    throw new PresenceValidationError(path, "must be a UTC timestamp string");
  }
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    throw new PresenceValidationError(
      path,
      "must be an RFC 3339 UTC timestamp with at most millisecond precision",
    );
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new PresenceValidationError(path, "must be a valid UTC timestamp");
  }
  const parsed = new Date(milliseconds);
  if (
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3]) ||
    parsed.getUTCHours() !== Number(match[4]) ||
    parsed.getUTCMinutes() !== Number(match[5]) ||
    parsed.getUTCSeconds() !== Number(match[6])
  ) {
    throw new PresenceValidationError(path, "must be a valid UTC timestamp");
  }
  return {
    value: parsed.toISOString() as PresenceTimestamp,
    milliseconds,
  };
};

const normalizeEnum = <TValue extends string>(
  value: unknown,
  path: string,
  allowed: ReadonlySet<string>,
): TValue => {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new PresenceValidationError(
      path,
      `must be one of ${[...allowed].join(", ")}`,
    );
  }
  return value as TValue;
};

const normalizeBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new PresenceValidationError(path, "must be a boolean");
  }
  return value;
};

/** Strictly validates and canonicalizes one untrusted presence record. */
export const normalizePresenceRecord = (input: unknown): PresenceRecord => {
  const record = expectObject(input);
  for (const field of Object.keys(record)) {
    if (!ALLOWED_RECORD_FIELDS.has(field)) {
      throw new PresenceValidationError(field, "is not a supported field");
    }
  }

  const participantId = normalizeIdentifier<PresenceParticipantId>(
    requireField(record, "participant_id"),
    "participant_id",
  );
  const sessionId = normalizeIdentifier<PresenceSessionId>(
    requireField(record, "session_id"),
    "session_id",
  );
  const participantKind = normalizeEnum<PresenceParticipantKind>(
    requireField(record, "participant_kind"),
    "participant_kind",
    PARTICIPANT_KINDS,
  );
  const state = normalizeEnum<PresenceState>(
    requireField(record, "state"),
    "state",
    STATES,
  );
  const typing = normalizeBoolean(
    requireField(record, "typing"),
    "typing",
  );
  const updatedAt = parseTimestamp(
    requireField(record, "updated_at"),
    "updated_at",
  );
  const expiresAt = parseTimestamp(
    requireField(record, "expires_at"),
    "expires_at",
  );
  if (expiresAt.milliseconds <= updatedAt.milliseconds) {
    throw new PresenceValidationError(
      "expires_at",
      "must be later than updated_at",
    );
  }

  let deviceId: PresenceDeviceId | undefined;
  if (Object.hasOwn(record, "device_id")) {
    deviceId = normalizeIdentifier<PresenceDeviceId>(
      record.device_id,
      "device_id",
    );
  }

  let assistantActivity: AssistantActivity | undefined;
  if (Object.hasOwn(record, "assistant_activity")) {
    assistantActivity = normalizeEnum<AssistantActivity>(
      record.assistant_activity,
      "assistant_activity",
      ACTIVITIES,
    );
    if (participantKind !== "assistant") {
      throw new PresenceValidationError(
        "assistant_activity",
        "is valid only for assistant participants",
      );
    }
  }

  let typingExpiresAt: ParsedTimestamp | undefined;
  if (typing) {
    typingExpiresAt = parseTimestamp(
      requireField(record, "typing_expires_at"),
      "typing_expires_at",
    );
    if (typingExpiresAt.milliseconds <= updatedAt.milliseconds) {
      throw new PresenceValidationError(
        "typing_expires_at",
        "must be later than updated_at",
      );
    }
  } else if (Object.hasOwn(record, "typing_expires_at")) {
    throw new PresenceValidationError(
      "typing_expires_at",
      "must be omitted when typing is false",
    );
  }

  if (state === "offline" && typing) {
    throw new PresenceValidationError(
      "typing",
      "must be false when state is offline",
    );
  }
  if (state === "offline" && assistantActivity !== undefined) {
    throw new PresenceValidationError(
      "assistant_activity",
      "must be omitted when state is offline",
    );
  }

  return {
    participant_id: participantId,
    ...(deviceId === undefined ? {} : { device_id: deviceId }),
    session_id: sessionId,
    participant_kind: participantKind,
    state,
    ...(assistantActivity === undefined
      ? {}
      : { assistant_activity: assistantActivity }),
    typing,
    updated_at: updatedAt.value,
    expires_at: expiresAt.value,
    ...(typingExpiresAt === undefined
      ? {}
      : { typing_expires_at: typingExpiresAt.value }),
  };
};

export const parsePresenceRecord = normalizePresenceRecord;

export const isPresenceRecord = (input: unknown): input is PresenceRecord => {
  try {
    normalizePresenceRecord(input);
    return true;
  } catch (error) {
    if (error instanceof PresenceValidationError) {
      return false;
    }
    throw error;
  }
};

export const createPresenceRecordKey = (
  participantId: string,
  sessionId: string,
  deviceId?: string,
): PresenceRecordKey => {
  const normalizedParticipantId =
    normalizeIdentifier<PresenceParticipantId>(
      participantId,
      "participant_id",
    );
  const normalizedSessionId = normalizeIdentifier<PresenceSessionId>(
    sessionId,
    "session_id",
  );
  const normalizedDeviceId =
    deviceId === undefined
      ? null
      : normalizeIdentifier<PresenceDeviceId>(deviceId, "device_id");
  return JSON.stringify([
    normalizedParticipantId,
    normalizedDeviceId,
    normalizedSessionId,
  ]) as PresenceRecordKey;
};

export const getPresenceRecordKey = (
  record: Pick<PresenceRecord, "participant_id" | "device_id" | "session_id">,
): PresenceRecordKey =>
  createPresenceRecordKey(
    record.participant_id,
    record.session_id,
    record.device_id,
  );

const lexicalCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const recordFingerprint = (record: PresenceRecord): string =>
  JSON.stringify([
    record.participant_id,
    record.device_id ?? null,
    record.session_id,
    record.participant_kind,
    record.state,
    record.assistant_activity ?? null,
    record.typing,
    record.updated_at,
    record.expires_at,
    record.typing_expires_at ?? null,
  ]);

const compareRecords = (left: PresenceRecord, right: PresenceRecord): number => {
  const timestampDifference =
    Date.parse(left.updated_at) - Date.parse(right.updated_at);
  if (timestampDifference !== 0) {
    return timestampDifference;
  }
  // An equal-timestamp offline tombstone must not lose to a live observation.
  if (left.state === "offline" && right.state !== "offline") {
    return 1;
  }
  if (right.state === "offline" && left.state !== "offline") {
    return -1;
  }
  return lexicalCompare(recordFingerprint(left), recordFingerprint(right));
};

/**
 * Merges snapshots by composite record identity. Newer `updated_at` values win.
 * Equal timestamps resolve independently of input order: offline wins first,
 * then the lexicographically greatest canonical record value wins.
 */
export const mergePresenceRecords = (
  current: readonly unknown[],
  updates: readonly unknown[],
): PresenceRecord[] => {
  const merged = new Map<PresenceRecordKey, PresenceRecord>();
  for (const input of [...current, ...updates]) {
    const candidate = normalizePresenceRecord(input);
    const key = getPresenceRecordKey(candidate);
    const existing = merged.get(key);
    if (existing === undefined || compareRecords(candidate, existing) > 0) {
      merged.set(key, candidate);
    }
  }
  return [...merged.entries()]
    .sort(([left], [right]) => lexicalCompare(left, right))
    .map(([, record]) => record);
};

const readNow = (options: PresenceTimeOptions): number => {
  const now = (options.clock ?? Date.now)();
  if (!Number.isFinite(now)) {
    throw new PresenceValidationError(
      "clock",
      "must return finite Unix epoch milliseconds",
    );
  }
  return now;
};

const resolveTypingAt = (
  record: PresenceRecord,
  now: number,
): PresenceRecord => {
  if (
    !record.typing ||
    Date.parse(record.typing_expires_at as PresenceTimestamp) > now
  ) {
    return record;
  }
  return {
    participant_id: record.participant_id,
    ...(record.device_id === undefined ? {} : { device_id: record.device_id }),
    session_id: record.session_id,
    participant_kind: record.participant_kind,
    state: record.state,
    ...(record.assistant_activity === undefined
      ? {}
      : { assistant_activity: record.assistant_activity }),
    typing: false,
    updated_at: record.updated_at,
    expires_at: record.expires_at,
  };
};

const normalizeMany = (records: readonly unknown[]): PresenceRecord[] =>
  records.map(normalizePresenceRecord);

const sortByRecordKey = (records: PresenceRecord[]): PresenceRecord[] =>
  records.sort((left, right) =>
    lexicalCompare(getPresenceRecordKey(left), getPresenceRecordKey(right)),
  );

/** Removes fully expired records and independently clears elapsed typing. */
export const pruneExpiredPresenceRecords = (
  records: readonly unknown[],
  options: PresenceTimeOptions = {},
): PresenceRecord[] => {
  const now = readNow(options);
  return sortByRecordKey(
    normalizeMany(records)
      .filter((record) => Date.parse(record.expires_at) > now)
      .map((record) => resolveTypingAt(record, now)),
  );
};

const selectActiveAt = (
  records: readonly unknown[],
  now: number,
): PresenceRecord[] =>
  sortByRecordKey(
    normalizeMany(records)
      .filter(
        (record) =>
          record.state !== "offline" && Date.parse(record.expires_at) > now,
      )
      .map((record) => resolveTypingAt(record, now)),
  );

/** Selects live, non-offline session records in deterministic key order. */
export const selectActivePresenceRecords = (
  records: readonly unknown[],
  options: PresenceTimeOptions = {},
): PresenceRecord[] => selectActiveAt(records, readNow(options));

/** Selects every live session for one participant without collapsing devices. */
export const selectActivePresenceByParticipant = (
  records: readonly unknown[],
  participantId: string,
  options: PresenceTimeOptions = {},
): PresenceRecord[] => {
  const normalizedParticipantId =
    normalizeIdentifier<PresenceParticipantId>(
      participantId,
      "participant_id",
    );
  return selectActiveAt(records, readNow(options)).filter(
    (record) => record.participant_id === normalizedParticipantId,
  );
};

const STATE_PRIORITY: Readonly<
  Record<Exclude<PresenceState, "offline">, number>
> = { idle: 1, online: 2, active: 3 };

/** Aggregates live sessions while retaining the independently keyed records. */
export const summarizePresence = (
  records: readonly unknown[],
  options: PresenceTimeOptions = {},
): PresenceParticipantSummary[] => {
  const active = selectActiveAt(records, readNow(options));
  const grouped = new Map<PresenceParticipantId, PresenceRecord[]>();
  for (const record of active) {
    const participantRecords = grouped.get(record.participant_id) ?? [];
    participantRecords.push(record);
    grouped.set(record.participant_id, participantRecords);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => lexicalCompare(left, right))
    .map(([participantId, participantRecords]) => {
      const freshest = participantRecords.reduce((selected, record) =>
        compareRecords(record, selected) > 0 ? record : selected,
      );
      const state = participantRecords.reduce<Exclude<PresenceState, "offline">>(
        (selected, record) => {
          const recordState = record.state as Exclude<PresenceState, "offline">;
          return STATE_PRIORITY[recordState] > STATE_PRIORITY[selected]
            ? recordState
            : selected;
        },
        "idle",
      );
      const activityRecord = participantRecords
        .filter((record) => record.assistant_activity !== undefined)
        .reduce<PresenceRecord | undefined>(
          (selected, record) =>
            selected === undefined || compareRecords(record, selected) > 0
              ? record
              : selected,
          undefined,
        );
      return {
        participant_id: participantId,
        participant_kind: freshest.participant_kind,
        state,
        ...(activityRecord?.assistant_activity === undefined
          ? {}
          : { assistant_activity: activityRecord.assistant_activity }),
        typing: participantRecords.some((record) => record.typing),
        updated_at: freshest.updated_at,
        record_count: participantRecords.length,
        records: participantRecords,
      };
    });
};
