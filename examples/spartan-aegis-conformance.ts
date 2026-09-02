import { runHandrailAssistantConformance,
  type HandrailAssistantConformanceAdapter } from "@handrail/ai/conformance";

/**
 * Spartan's qualification environment supplies these probes against its mounted
 * `/api/assistant/aegis` endpoint and isolated Postgres schema. The shared suite,
 * rather than Aegis-specific assertions, defines the reusable production gate.
 */
declare function createAegisQualificationAdapter(input: {
  readonly endpoint: string;
  readonly resetFixture: () => Promise<void>;
}): HandrailAssistantConformanceAdapter;
declare const resetAegisQualificationDatabase: () => Promise<void>;

const report = await runHandrailAssistantConformance(createAegisQualificationAdapter({
  endpoint: "http://127.0.0.1:3000/api/assistant/aegis",
  resetFixture: resetAegisQualificationDatabase,
}));

if (!report.passed) throw new Error("Aegis did not conform");
