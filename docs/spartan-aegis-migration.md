# Spartan Aegis integration reference

This is a migration seam, not a rewrite of Spartan's business domain. It was derived from the current Aegis implementation in `src/server/aegis` and `src/client/features/aegis-assistant`; the Spartan repository is not modified by this package.

## Keep domain ownership in Spartan

- Keep read definitions, source labels, actor/company filtering, and execution in `tools.ts` and `tool-catalog.ts`.
- Keep Zod action descriptors, validation, actor summaries, and side effects in `actions.ts` and the domain action modules.
- Keep the rule that action tools create proposals rather than performing an unconfirmed mutation. Map descriptors to `createToolPlugin({ registrations, policy, approvals, presentations })`; `summarizeForActor` becomes the safe approval summary.
- Keep repository authorization and company scoping before tool discovery and again before execution. Pass only the resulting actor-authorized definitions into `createDeferredToolDiscoveryPlan`.
- Keep Aegis-specific system instructions, tool-call budget (currently four), transcript bound (currently 30), output bound, and source semantics as application policy.

## Move generic machinery to handrail-ai

| Existing Aegis concern | Reusable handrail-ai boundary |
| --- | --- |
| `provider.ts` Responses loop and normalized stream | `createOpenAIResponsesProviderAdapter` plus `projectOpenAIResponsesTools`; retain Spartan's bounded multi-call policy around tool results |
| `tool-catalog.ts` namespace projection | `createDeferredToolDiscoveryPlan`; Spartan supplies stable namespace membership |
| `handrail-bridge.ts` MCP discovery/execution glue | `@handrail/ai/connectors/mcp` |
| routes, protected request plumbing, cancellation, replay | `createApplicationGateway` plus `@handrail/ai/server/application-gateway` |
| thread/event/catalog persistence | conversation contracts plus `@handrail/ai/persistence/postgres` |
| action request persistence and confirmation UI | approval proposal store and plugin approval presentation |
| bespoke launcher/dialog/transcript/composer | unstyled `@handrail/ai/react` or optional `@handrail/ai/react/styled` |
| typing animation and multi-device state | ephemeral live presence delivery; never the durable event log |
| browser API wrappers | `@handrail/ai/client`; Flutter uses `flutter/handrail_ai_client` |

## Minimal plugin mapping

```ts
const aegisPlugin = createToolPlugin({
  pluginId: "spartan.aegis.erp",
  version: "1.0.0",
  displayName: "Spartan Aegis ERP",
  registrations: ({ actor }) => actorAuthorizedDescriptors(actor).map(toRegistration),
  policy: enforceCompanyAndActionPolicy,
  approvals: actionDescriptors.map((action) => ({
    toolName: action.name,
    mode: "always",
    summarize: (args, actor) => action.summarizeForActor(actor, args),
    rendererKey: `spartan.aegis.approval.${action.name}`,
  })),
});
```

Registration conversion must retain the Zod parser as the execution trust boundary. JSON Schema is only model guidance. The executor receives validated arguments and calls the unchanged domain service. Never serialize the executor, policy, actor context, or approval summarizer to clients/providers.

## Hosted search compatibility

The existing provider sends `web_search`, deferred `namespace` function tools, and `tool_search`, uses `store:false`, retains reasoning items, permits no parallel calls, and validates the returned namespace/name against its advertised set. Preserve all of those properties. `projectOpenAIResponsesTools` produces the same deferred layout from the actor-filtered plan and includes hosted web search when configured. For a model without tool search, it intentionally exposes only the plan's bounded eager tools; it does not silently send all 89 schemas. OpenAI documents namespace tools, `defer_loading`, hosted/client tool search, and web search in the [Responses API reference](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses).

## Suggested cutover

1. Wrap existing descriptors as one plugin and assert that the discovered name set is identical for representative roles.
2. Replace only namespace projection, preserving provider code and golden request tests.
3. Put the current routes behind the gateway transport and dual-write canonical events while the existing workspace response remains authoritative.
4. Migrate the client to the headless runtime, then the styled preset or a Spartan-owned UI. Keep old routes during rollback.
5. Cut persistence reads over after event/revision, proposal, attachment, and catalog reconciliation. Remove duplicated generic code only after parity tests.

Required parity tests cover every role's discovered tools, denied cross-company access, proposal-only actions, idempotent confirmation, four-call budget, hosted web citations, attachment limits, archive/restore/new threads, stream reconnect, cancellation, and multi-device convergence.
