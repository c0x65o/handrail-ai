import type {
  ApprovalProposalStore, CreateApprovalProposalInput, GetApprovalProposalInput,
  ListApprovalProposalGroupInput, TransitionApprovalProposalInput,
} from "./approval-proposal-store.js";
import type { ConversationApprovalProposalRecord } from "./state.js";

export interface DualWriteApprovalProposalStoreOptions<TPermissionContext> {
  readonly primary: ApprovalProposalStore<TPermissionContext>;
  readonly shadow: ApprovalProposalStore<TPermissionContext>;
  readonly onShadowError?: (input: { readonly operation: "create" | "transition"; readonly proposalId: string }) => void;
}

export type ApprovalProposalReconciliationResult =
  | { readonly status: "converged" }
  | { readonly status: "missing_primary" | "missing_shadow" | "divergent" };

/** Primary proposal state remains authoritative until explicit cutover. */
export class DualWriteApprovalProposalStore<TPermissionContext> implements ApprovalProposalStore<TPermissionContext> {
  constructor(readonly options: DualWriteApprovalProposalStoreOptions<TPermissionContext>) {}
  async create(input: CreateApprovalProposalInput<TPermissionContext>): Promise<ConversationApprovalProposalRecord> {
    const result = await this.options.primary.create(input);
    try { await this.options.shadow.create(input); }
    catch { this.options.onShadowError?.({ operation: "create", proposalId: input.proposalId }); }
    return result;
  }
  get(input: GetApprovalProposalInput<TPermissionContext>): Promise<ConversationApprovalProposalRecord | null> {
    return this.options.primary.get(input);
  }
  listGroup(input: ListApprovalProposalGroupInput<TPermissionContext>): Promise<readonly ConversationApprovalProposalRecord[]> {
    return this.options.primary.listGroup(input);
  }
  async transition(input: TransitionApprovalProposalInput<TPermissionContext>): Promise<ConversationApprovalProposalRecord> {
    const result = await this.options.primary.transition(input);
    try { await this.options.shadow.transition(input); }
    catch { this.options.onShadowError?.({ operation: "transition", proposalId: input.proposalId }); }
    return result;
  }
  async reconcile(input: GetApprovalProposalInput<TPermissionContext>): Promise<ApprovalProposalReconciliationResult> {
    const [primary, shadow] = await Promise.all([this.options.primary.get(input), this.options.shadow.get(input)]);
    if (!primary && !shadow) return Object.freeze({ status: "converged" });
    if (!primary) return Object.freeze({ status: "missing_primary" });
    if (!shadow) return Object.freeze({ status: "missing_shadow" });
    return Object.freeze({ status: JSON.stringify(primary) === JSON.stringify(shadow) ? "converged" : "divergent" });
  }
}
