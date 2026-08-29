import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ApprovalProposalStoreError,
  InMemoryApprovalProposalStore,
  type ApprovalProposalStore,
} from "../src/index.js";
import { approvalProposalStoreConformanceCases } from "./approval-proposal-store-conformance.js";

describe("InMemoryApprovalProposalStore conformance", () => {
  for (const testCase of approvalProposalStoreConformanceCases(
    (options) => new InMemoryApprovalProposalStore({
      authorize: options.authorize,
      clock: { now: options.now },
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    }),
  )) {
    it(testCase.name, testCase.run);
  }
});

describe("ApprovalProposalStore public contract", () => {
  it("exports a host-implementable contract and normalized errors", () => {
    const store: ApprovalProposalStore<string> =
      new InMemoryApprovalProposalStore({ authorize: () => "allow" });
    expectTypeOf(store.create).toBeFunction();
    expectTypeOf(store.get).toBeFunction();
    expectTypeOf(store.listGroup).toBeFunction();
    expectTypeOf(store.transition).toBeFunction();

    const error = new ApprovalProposalStoreError("version_conflict", "transition");
    expect(error).toMatchObject({
      name: "ApprovalProposalStoreError",
      code: "version_conflict",
      operation: "transition",
      retryable: true,
    });
    expect(error.message).not.toContain("proposal-private");
  });

  it("requires valid bounded configuration", () => {
    expect(
      () =>
        new InMemoryApprovalProposalStore({
          authorize: () => "allow",
          limits: { maxProposals: 0 },
        }),
    ).toThrow(TypeError);
  });
});
