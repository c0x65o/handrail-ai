import { describe, expect, it } from "vitest";
import { createInitialConversationState, parseConversationEvent, reduceConversationEvent,
  projectConversationActivity, type ConversationState, type ConversationWorkspaceSnapshot,
  type ConversationRuntime, type ConversationActivityRecord } from "../src/index.js";

function workspace(ids: string[], completed = false, unread = false): ConversationWorkspaceSnapshot {
  const payloads = ids.flatMap((turnId, index) => {
    const events: object[] = [{ type: "turn.started", turn_id: turnId, input_message_ids: ["input"] }];
    if (index < ids.length - 1 || completed) events.push({ type: "turn.completed", turn_id: turnId, outcome: "stop", output_message_ids: [] });
    return events;
  });
  const state = payloads.reduce<ConversationState>((state, payload, index) => reduceConversationEvent(state, parseConversationEvent({
    version: 1, event_id: `e${index}`, conversation_id: "conversation", revision: index + 1,
    occurred_at: "2026-09-04T00:00:00.000Z", actor: { type: "assistant" }, source: { type: "runtime" }, payload,
  })), createInitialConversationState("conversation" as never));
  return { selectedConversationId: null, runningCount: completed ? 0 : 1, errorCount: 0, unreadCount: unread ? 1 : 0,
    threads: [{ conversationId: "conversation" as never, runtime: { getSnapshot: () => state } as ConversationRuntime<unknown>,
      turnStatus: completed ? "completed" : "running", unread, revision: state.revision }] };
}
const remote = (turnId: string, turnStatus: ConversationActivityRecord["turnStatus"], unread = false): ConversationActivityRecord =>
  ({ conversationId: "conversation", turnId, turnStatus, unread });

describe("shared conversation activity projection", () => {
  it("shows server completion and unread while an open disconnected runtime still says running", () => {
    expect(projectConversationActivity(workspace(["first"]), [remote("first", "completed", true)]))
      .toEqual([remote("first", "completed", true)]);
  });
  it("uses the persisted read marker even when a background runtime still says unread", () => {
    expect(projectConversationActivity(workspace(["first"], true, true), [remote("first", "completed")])[0]?.unread).toBe(false);
  });
  it("keeps a newly admitted turn running when the server index still represents an older turn", () => {
    expect(projectConversationActivity(workspace(["first", "second"]), [remote("first", "completed", true)])[0])
      .toMatchObject({ turnId: "second", turnStatus: "running", unread: false });
  });
  it("shows newer server work and retains independently running unopened threads", () => {
    const other = { ...remote("other", "running"), conversationId: "other" };
    expect(projectConversationActivity(workspace(["first"], true), [remote("second", "running"), other]))
      .toEqual([remote("second", "running"), other]);
  });
  it("does not revive a locally completed turn from an older running index", () => {
    expect(projectConversationActivity(workspace(["first"], true, true), [remote("first", "running")])[0])
      .toMatchObject({ turnStatus: "completed", unread: true });
  });
});
