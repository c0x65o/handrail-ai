// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useConversationApprovals, type ConversationApprovalResources } from "../src/react-headless/index.js";
import type { ConversationApprovalProposalRecord } from "../src/conversation/state.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function proposal(id: string): ConversationApprovalProposalRecord {
  return { proposal_id: id, status: "pending", proposal_version: 1 } as never;
}
afterEach(cleanup);

describe("headless approval state", () => {
  it.each(["success", "failure"])("ignores late %s after a conversation changes without remounting", async (outcome) => {
    const old = deferred<readonly ConversationApprovalProposalRecord[]>();
    const resources: ConversationApprovalResources = {
      listApprovalGroup: async ({ groupId }) => groupId === "a" ? old.promise : [proposal("b-action")],
      transitionApproval: vi.fn(),
    };
    const view = renderHook(({ id }) => useConversationApprovals(resources, id), { initialProps: { id: "a" as string | null } });
    view.rerender({ id: "b" });
    await act(async () => {});
    expect(view.result.current.proposals[0]?.proposal_id).toBe("b-action");
    await act(async () => { if (outcome === "success") old.resolve([proposal("old-action")]); else old.reject(new Error("Old failure")); });
    expect(view.result.current.proposals[0]?.proposal_id).toBe("b-action");
    expect(view.result.current.error).toBeNull();
    view.rerender({ id: null });
    expect(view.result.current.proposals).toEqual([]);
  });

  it.each(["success", "failure"])("isolates a pending decision's %s and busy state when credentials change", async (outcome) => {
    const pending = deferred<ConversationApprovalProposalRecord>();
    const first: ConversationApprovalResources = { listApprovalGroup: async () => [proposal("old")], transitionApproval: () => pending.promise };
    const second: ConversationApprovalResources = { listApprovalGroup: async () => [proposal("new")], transitionApproval: vi.fn() };
    const view = renderHook(({ resources }) => useConversationApprovals(resources, "same-id"), { initialProps: { resources: first } });
    await act(async () => {});
    let decision!: Promise<void>;
    act(() => { decision = view.result.current.decide(proposal("old"), "confirmed"); });
    expect(view.result.current.busy).toBe("old");
    view.rerender({ resources: second });
    expect(view.result.current.busy).toBeNull();
    await act(async () => {});
    await act(async () => { if (outcome === "success") pending.resolve({ ...proposal("old"), status: "confirmed" }); else pending.reject(new Error("Old decision failed")); await decision; });
    expect(view.result.current.proposals.map((item) => item.proposal_id)).toEqual(["new"]);
    expect(view.result.current.error).toBeNull();
  });

  it("retains the returned failed action while a refresh is pending and prevents duplicate clicks", async () => {
    const pending = deferred<ConversationApprovalProposalRecord>();
    const refresh = deferred<readonly ConversationApprovalProposalRecord[]>();
    const transitionApproval = vi.fn(() => pending.promise);
    let reads = 0;
    const resources: ConversationApprovalResources = { transitionApproval,
      listApprovalGroup: async () => ++reads === 1 ? [proposal("action")] : refresh.promise };
    const view = renderHook(() => useConversationApprovals(resources, "a"));
    await act(async () => {});
    let decision!: Promise<void>;
    act(() => { decision = view.result.current.decide(proposal("action"), "confirmed"); void view.result.current.decide(proposal("action"), "confirmed"); });
    expect(transitionApproval).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve({ ...proposal("action"), status: "failed", proposal_version: 4 }); await decision; });
    expect(view.result.current.proposals).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(view.result.current.busy).toBeNull();
    expect(reads).toBe(2);
    view.unmount();
    await act(async () => { refresh.resolve([proposal("stale")]); });
  });
});
