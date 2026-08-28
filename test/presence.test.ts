import { describe, expect, it } from "vitest";

import {
  ASSISTANT_ACTIVITIES,
  PRESENCE_PARTICIPANT_KINDS,
  PRESENCE_STATES,
  PresenceValidationError,
  createPresenceRecordKey,
  getPresenceRecordKey,
  isPresenceRecord,
  mergePresenceRecords,
  normalizePresenceRecord,
  pruneExpiredPresenceRecords,
  selectActivePresenceByParticipant,
  selectActivePresenceRecords,
  summarizePresence,
} from "../src/index.js";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");
const clock = () => NOW;

const presence = (overrides: Record<string, unknown> = {}) => ({
  participant_id: "participant-1",
  device_id: "device-1",
  session_id: "session-1",
  participant_kind: "human",
  state: "active",
  typing: false,
  updated_at: "2026-08-27T11:59:00Z",
  expires_at: "2026-08-27T12:01:00Z",
  ...overrides,
});

describe("ephemeral presence contract", () => {
  it("exports a provider-neutral public vocabulary", () => {
    expect(PRESENCE_PARTICIPANT_KINDS).toEqual([
      "human",
      "assistant",
      "system",
    ]);
    expect(PRESENCE_STATES).toEqual([
      "online",
      "active",
      "idle",
      "offline",
    ]);
    expect(ASSISTANT_ACTIVITIES).toEqual([
      "thinking",
      "responding",
      "using_tool",
    ]);
    expect(
      JSON.stringify({
        PRESENCE_PARTICIPANT_KINDS,
        PRESENCE_STATES,
        ASSISTANT_ACTIVITIES,
      }),
    ).not.toMatch(/handrail|\/api\//i);
    expect(normalizePresenceRecord(presence())).toMatchObject({
      participant_id: "participant-1",
      session_id: "session-1",
    });
  });

  it("strictly normalizes identifiers and UTC timestamps", () => {
    const normalized = normalizePresenceRecord(
      presence({
        participant_id: "  participant-1  ",
        updated_at: "2026-08-27T11:59:00Z",
        expires_at: "2026-08-27T12:01:00.1Z",
      }),
    );
    expect(normalized.participant_id).toBe("participant-1");
    expect(normalized.updated_at).toBe("2026-08-27T11:59:00.000Z");
    expect(normalized.expires_at).toBe("2026-08-27T12:01:00.100Z");
    expect(isPresenceRecord(normalized)).toBe(true);
  });

  it("rejects empty or malformed participant, device, and session identifiers", () => {
    for (const [field, value] of [
      ["participant_id", ""],
      ["participant_id", "   "],
      ["participant_id", "participant/1"],
      ["device_id", "device 1"],
      ["session_id", "session#1"],
    ] as const) {
      expect(() =>
        normalizePresenceRecord(presence({ [field]: value })),
      ).toThrow(new RegExp(field));
    }
    expect(isPresenceRecord(presence({ session_id: "" }))).toBe(false);
  });

  it("rejects malformed and inconsistent timestamps", () => {
    for (const [field, value] of [
      ["updated_at", "2026-08-27"],
      ["updated_at", "2026-08-27T11:59:00+00:00"],
      ["updated_at", "2026-02-30T11:59:00Z"],
      ["expires_at", "not-a-date"],
      ["expires_at", 123],
    ] as const) {
      expect(() =>
        normalizePresenceRecord(presence({ [field]: value })),
      ).toThrow(new RegExp(field));
    }
    expect(() =>
      normalizePresenceRecord(
        presence({ expires_at: "2026-08-27T11:58:00Z" }),
      ),
    ).toThrow(/expires_at.*later than updated_at/);
  });

  it("requires coherent assistant activity and typing expiry fields", () => {
    expect(() =>
      normalizePresenceRecord(presence({ typing: true })),
    ).toThrow(/typing_expires_at.*required/);
    expect(() =>
      normalizePresenceRecord(
        presence({ typing_expires_at: "2026-08-27T12:00:30Z" }),
      ),
    ).toThrow(/typing_expires_at.*omitted/);
    expect(() =>
      normalizePresenceRecord(presence({ assistant_activity: "thinking" })),
    ).toThrow(/assistant_activity.*assistant participants/);
    expect(() =>
      normalizePresenceRecord(
        presence({
          participant_kind: "assistant",
          assistant_activity: "singing",
        }),
      ),
    ).toThrow(/assistant_activity/);
  });

  it("keeps participant sessions and devices independently addressable", () => {
    const firstDevice = presence({ device_id: "device-1" });
    const secondDevice = presence({ device_id: "device-2" });
    const merged = mergePresenceRecords([], [firstDevice, secondDevice]);
    expect(merged).toHaveLength(2);
    expect(new Set(merged.map(getPresenceRecordKey)).size).toBe(2);
    expect(
      createPresenceRecordKey("participant-1", "session-1", "device-1"),
    ).not.toBe(
      createPresenceRecordKey("participant-1", "session-1", "device-2"),
    );
    expect(
      selectActivePresenceByParticipant(merged, "participant-1", { clock }),
    ).toHaveLength(2);
  });

  it("uses newer updates and deterministic equal-timestamp tie breaking", () => {
    const older = presence({ state: "idle" });
    const newer = presence({
      state: "active",
      updated_at: "2026-08-27T11:59:30Z",
    });
    expect(mergePresenceRecords([newer], [older])).toEqual([
      normalizePresenceRecord(newer),
    ]);

    const live = presence({ state: "active" });
    const offline = presence({ state: "offline" });
    expect(mergePresenceRecords([live], [offline])).toEqual(
      mergePresenceRecords([offline], [live]),
    );
    expect(mergePresenceRecords([live], [offline])[0]?.state).toBe("offline");

    const online = presence({ state: "online" });
    const idle = presence({ state: "idle" });
    expect(mergePresenceRecords([], [online, idle])).toEqual(
      mergePresenceRecords([], [idle, online]),
    );
  });

  it("removes offline and expired records from active selectors and summaries", () => {
    const live = presence({ participant_id: "live" });
    const offline = presence({ participant_id: "offline", state: "offline" });
    const expired = presence({
      participant_id: "expired",
      updated_at: "2026-08-27T11:58:00Z",
      expires_at: "2026-08-27T11:59:59.999Z",
    });
    expect(
      selectActivePresenceRecords([expired, offline, live], { clock }).map(
        (record) => record.participant_id,
      ),
    ).toEqual(["live"]);
    expect(
      summarizePresence([expired, offline, live], { clock }).map(
        (summary) => summary.participant_id,
      ),
    ).toEqual(["live"]);
    expect(
      pruneExpiredPresenceRecords([expired, offline, live], { clock }).map(
        (record) => record.participant_id,
      ),
    ).toEqual(["live", "offline"]);
  });

  it("expires typing independently while retaining a live presence record", () => {
    const typing = presence({
      typing: true,
      typing_expires_at: "2026-08-27T12:00:00Z",
    });
    const [selected] = selectActivePresenceRecords([typing], { clock });
    expect(selected).toMatchObject({
      participant_id: "participant-1",
      state: "active",
      typing: false,
      expires_at: "2026-08-27T12:01:00.000Z",
    });
    expect(selected).not.toHaveProperty("typing_expires_at");
  });

  it("uses an injectable clock exactly once for deterministic results", () => {
    let calls = 0;
    const fakeClock = () => {
      calls += 1;
      return NOW;
    };
    const records = [
      presence({ participant_id: "b" }),
      presence({ participant_id: "a" }),
    ];
    expect(
      summarizePresence(records, { clock: fakeClock }).map(
        (summary) => summary.participant_id,
      ),
    ).toEqual(["a", "b"]);
    expect(calls).toBe(1);
    expect(() =>
      selectActivePresenceRecords(records, { clock: () => Number.NaN }),
    ).toThrow(PresenceValidationError);
  });
});
