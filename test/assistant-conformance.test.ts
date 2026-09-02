import { describe, expect, it } from "vitest";

import { HandrailAssistantConformanceError, runHandrailAssistantConformance,
  type HandrailAssistantConformanceAdapter } from "../src/conformance/index.js";

function conforming(): HandrailAssistantConformanceAdapter {
  return {
    async authIsolation() { return { ownerCanRead: true, intruderCanRead: false }; },
    async toolDenial() { return { denied: true, sideEffectCount: 0 }; },
    async replay() { return { originalEventIds: ["turn:0", "turn:1"], replayedEventIds: ["turn:0", "turn:1"] }; },
    async cancellation() { return { requested: true, terminalStatus: "cancelled", emittedAfterTerminal: 0 }; },
    async attachments() { return { ownerResolved: true, intruderResolved: false, bytesMatch: true }; },
    async approvals() { return { executedBeforeConfirmation: false, confirmed: true, executionCount: 1 }; },
    async usageAccounting() { return { providerInvocations: 2, durableAdmissions: 2, durableReceipts: 2,
      duplicateReceiptIds: 0, undeliveredReceipts: 0 }; },
  };
}

describe("shared assistant conformance suite", () => {
  it("accepts complete production evidence", async () => {
    await expect(runHandrailAssistantConformance(conforming())).resolves.toMatchObject({ passed: true });
  });

  it.each([
    ["authIsolation", async () => ({ ownerCanRead: true, intruderCanRead: true })],
    ["toolDenial", async () => ({ denied: true, sideEffectCount: 1 })],
    ["replay", async () => ({ originalEventIds: ["a"], replayedEventIds: ["b"] })],
    ["cancellation", async () => ({ requested: true, terminalStatus: "completed" as const, emittedAfterTerminal: 0 })],
    ["attachments", async () => ({ ownerResolved: true, intruderResolved: true, bytesMatch: true })],
    ["approvals", async () => ({ executedBeforeConfirmation: true, confirmed: true, executionCount: 1 })],
    ["usageAccounting", async () => ({ providerInvocations: 2, durableAdmissions: 1, durableReceipts: 2,
      duplicateReceiptIds: 0, undeliveredReceipts: 0 })],
  ] as const)("identifies a failed %s invariant", async (check, probe) => {
    const adapter = conforming() as unknown as Record<string, unknown>;
    adapter[check] = probe;
    await expect(runHandrailAssistantConformance(adapter as unknown as HandrailAssistantConformanceAdapter))
      .rejects.toMatchObject({ name: "HandrailAssistantConformanceError", check } satisfies
        Partial<HandrailAssistantConformanceError>);
  });
});
