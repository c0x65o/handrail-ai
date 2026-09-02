import type { ConversationApprovalProposalRecord } from "../conversation/state.js";
import type { DecideApprovalInput } from "../conversation/approval-coordinator.js";
import type { ApplicationGatewayResourceClient } from "../transports/application-gateway.js";
import type {
  ApprovalReviewProposalLoader,
  ApprovalReviewTransitionHandler,
} from "./approval-review.js";

export interface ApplicationGatewayApprovalReviewAdapter<TPermissionContext> {
  readonly loadProposals: ApprovalReviewProposalLoader<TPermissionContext>;
  readonly transitionHandler: ApprovalReviewTransitionHandler<TPermissionContext>;
}

/**
 * Binds the approval review UI to protected gateway transitions. Proposal
 * discovery remains explicit because the proposal store intentionally exposes
 * no unbounded list operation; hosts usually load the indexed rows from their
 * conversation projection.
 */
export function createApplicationGatewayApprovalReviewAdapter<TPermissionContext>(
  client: ApplicationGatewayResourceClient,
  loadProposals: ApprovalReviewProposalLoader<TPermissionContext>,
): ApplicationGatewayApprovalReviewAdapter<TPermissionContext> {
  return Object.freeze({
    loadProposals,
    transitionHandler: async (input: DecideApprovalInput<TPermissionContext>) => {
      if (input.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      const result = await client.transitionApproval({
        conversationId: input.conversationId,
        proposalId: input.proposalId,
        expectedVersion: input.expectedVersion,
        status: input.decision === "confirm" ? "confirmed" :
          input.decision === "reject" ? "rejected" : "expired",
        idempotencyKey: input.idempotencyKey,
        idempotencyFingerprint: input.idempotencyFingerprint,
        ...(input.decisionReason === undefined ? {} : { decisionReason: input.decisionReason }),
      });
      return result as ConversationApprovalProposalRecord;
    },
  });
}
