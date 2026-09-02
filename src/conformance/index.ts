export const HANDRAIL_ASSISTANT_CONFORMANCE_VERSION = "handrail.assistant-conformance.v1" as const;

export interface HandrailAssistantConformanceEvidence {
  readonly authIsolation: {
    readonly ownerCanRead: boolean;
    readonly intruderCanRead: boolean;
  };
  readonly toolDenial: {
    readonly denied: boolean;
    readonly sideEffectCount: number;
  };
  readonly replay: {
    readonly originalEventIds: readonly string[];
    readonly replayedEventIds: readonly string[];
  };
  readonly cancellation: {
    readonly requested: boolean;
    readonly terminalStatus: "cancelled" | "completed" | "failed";
    readonly emittedAfterTerminal: number;
  };
  readonly attachments: {
    readonly ownerResolved: boolean;
    readonly intruderResolved: boolean;
    readonly bytesMatch: boolean;
  };
  readonly approvals: {
    readonly executedBeforeConfirmation: boolean;
    readonly confirmed: boolean;
    readonly executionCount: number;
  };
  readonly usageAccounting: {
    readonly providerInvocations: number;
    readonly durableAdmissions: number;
    readonly durableReceipts: number;
    readonly duplicateReceiptIds: number;
    readonly undeliveredReceipts: number;
  };
}

export interface HandrailAssistantConformanceAdapter {
  /** Each probe must use isolated identities and fresh conversation/turn IDs. */
  authIsolation(): Promise<HandrailAssistantConformanceEvidence["authIsolation"]>;
  toolDenial(): Promise<HandrailAssistantConformanceEvidence["toolDenial"]>;
  replay(): Promise<HandrailAssistantConformanceEvidence["replay"]>;
  cancellation(): Promise<HandrailAssistantConformanceEvidence["cancellation"]>;
  attachments(): Promise<HandrailAssistantConformanceEvidence["attachments"]>;
  approvals(): Promise<HandrailAssistantConformanceEvidence["approvals"]>;
  usageAccounting(): Promise<HandrailAssistantConformanceEvidence["usageAccounting"]>;
}

export interface HandrailAssistantConformanceReport {
  readonly version: typeof HANDRAIL_ASSISTANT_CONFORMANCE_VERSION;
  readonly passed: true;
  readonly evidence: HandrailAssistantConformanceEvidence;
}

export class HandrailAssistantConformanceError extends Error {
  constructor(readonly check: keyof HandrailAssistantConformanceEvidence, message: string) {
    super(`${check}: ${message}`);
    this.name = "HandrailAssistantConformanceError";
  }
}

function requireCheck(check: keyof HandrailAssistantConformanceEvidence, condition: boolean, message: string): void {
  if (!condition) throw new HandrailAssistantConformanceError(check, message);
}

/** Framework-neutral suite shared by SDK CI and application qualification tests. */
export async function runHandrailAssistantConformance(
  adapter: HandrailAssistantConformanceAdapter,
): Promise<HandrailAssistantConformanceReport> {
  const authIsolation = await adapter.authIsolation();
  requireCheck("authIsolation", authIsolation.ownerCanRead && !authIsolation.intruderCanRead,
    "conversation authority crossed an authenticated scope");

  const toolDenial = await adapter.toolDenial();
  requireCheck("toolDenial", toolDenial.denied && toolDenial.sideEffectCount === 0,
    "a denied tool produced a side effect");

  const replay = await adapter.replay();
  requireCheck("replay", replay.originalEventIds.length > 0 &&
    JSON.stringify(replay.originalEventIds) === JSON.stringify(replay.replayedEventIds),
  "resume did not replay the exact durable event identity sequence");

  const cancellation = await adapter.cancellation();
  requireCheck("cancellation", cancellation.requested && cancellation.terminalStatus === "cancelled" &&
    cancellation.emittedAfterTerminal === 0, "authoritative cancellation did not settle exactly once");

  const attachments = await adapter.attachments();
  requireCheck("attachments", attachments.ownerResolved && !attachments.intruderResolved && attachments.bytesMatch,
    "attachment staging or authorization is not scope-safe");

  const approvals = await adapter.approvals();
  requireCheck("approvals", !approvals.executedBeforeConfirmation && approvals.confirmed &&
    approvals.executionCount === 1, "approval did not gate exactly one execution");

  const usageAccounting = await adapter.usageAccounting();
  requireCheck("usageAccounting", usageAccounting.providerInvocations === usageAccounting.durableAdmissions &&
    usageAccounting.providerInvocations === usageAccounting.durableReceipts &&
    usageAccounting.duplicateReceiptIds === 0 && usageAccounting.undeliveredReceipts === 0,
  "provider invocations, admissions, receipts, and outbox delivery disagree");

  return Object.freeze({ version: HANDRAIL_ASSISTANT_CONFORMANCE_VERSION, passed: true,
    evidence: Object.freeze({ authIsolation, toolDenial, replay, cancellation, attachments, approvals, usageAccounting }) });
}
