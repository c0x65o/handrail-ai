import { describe, expect, it, vi } from "vitest";
import { DualWriteApprovalProposalStore, InMemoryApprovalProposalStore, type ApprovalProposalStore } from "../src/index.js";

describe("dual-write proposal adoption", () => {
  it("keeps primary authoritative and repairs shadow creation on an idempotent retry", async () => {
    const now = () => "2026-08-30T12:00:00.000Z" as never;
    const primary = new InMemoryApprovalProposalStore({ authorize: () => "allow", clock: { now } });
    const shadowInner = new InMemoryApprovalProposalStore({ authorize: () => "allow", clock: { now } });
    let fail = true;
    const shadow: ApprovalProposalStore = {
      create(input) { if (fail) { fail = false; throw new Error("shadow unavailable"); } return shadowInner.create(input); },
      get: (input) => shadowInner.get(input), listGroup: (input) => shadowInner.listGroup(input),
      transition: (input) => shadowInner.transition(input),
    };
    const onShadowError = vi.fn();
    const store = new DualWriteApprovalProposalStore({ primary, shadow, onShadowError });
    const request = { permissionContext: undefined, proposalId: "proposal-dual" as never, turnId: "turn-dual" as never,
      toolCallId: "call-dual" as never, toolName: "issue_invoice",
      reviewedArguments: { type: "redacted_json" as const, value: { invoiceId: "invoice-dual" } },
      expiresAt: "2026-08-30T12:05:00.000Z" as never,
      attribution: { actor: { type: "system" as const }, source: { type: "runtime" as const } },
      idempotencyKey: "proposal-dual", idempotencyFingerprint: "proposal-dual-fingerprint" };
    await expect(store.create(request)).resolves.toMatchObject({ status: "pending" });
    expect(onShadowError).toHaveBeenCalledOnce();
    await expect(store.reconcile({ permissionContext: undefined, proposalId: request.proposalId })).resolves.toEqual({ status: "missing_shadow" });
    await expect(store.create(request)).resolves.toMatchObject({ status: "pending" });
    await expect(store.reconcile({ permissionContext: undefined, proposalId: request.proposalId })).resolves.toEqual({ status: "converged" });
  });
});
