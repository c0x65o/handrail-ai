# Spartan Aegis integration reference

This is a migration seam, not a rewrite of Spartan's business domain. It was derived from the current Aegis implementation in `src/server/aegis` and `src/client/features/aegis-assistant`. Spartan may consume the adapter directly or through a pinned integration artifact while the release is being qualified.

## Keep domain ownership in Spartan

- Keep read definitions, source labels, actor/company filtering, and execution in `tools.ts` and `tool-catalog.ts`.
- Keep Zod action descriptors, validation, actor summaries, and side effects in `actions.ts` and the domain action modules.
- Keep the rule that action tools create proposals rather than performing an unconfirmed mutation. Map descriptors to `createToolPlugin({ registrations, policy, approvals, presentations })`; `summarizeForActor` becomes the safe approval summary.
- Keep repository authorization and company scoping before tool discovery and again before execution. Pass only the resulting actor-authorized definitions into `createDeferredToolDiscoveryPlan`.
- Keep Aegis-specific system instructions, tool-call budget (currently 75), transcript bound (currently 30), output bound, and source semantics as application policy. The authoritative source is Spartan `src/server/aegis/provider.ts` (`MAX_TOOL_CALLS = 75`, audited 2026-08-30). Inject these values from Spartan configuration so a future application-policy change does not require an SDK release.

## Move generic machinery to handrail-ai

| Existing Aegis concern | Reusable handrail-ai boundary |
| --- | --- |
| `provider.ts` Responses loop and normalized stream | `createOpenAIResponsesProviderAdapter` plus `runToolLoop({ limits: { maxTotalToolCalls: 75 } })`; configure `maximumInputMessages: 30` |
| `tool-catalog.ts` namespace projection | `createDeferredToolDiscoveryPlan`; Spartan supplies stable namespace membership |
| `handrail-bridge.ts` MCP discovery/execution glue | `@handrail/ai/connectors/mcp` |
| routes, protected request plumbing, cancellation, replay | `createDurableApplicationTransport` behind `createApplicationGateway` plus `@handrail/ai/server/application-gateway` |
| thread/event/catalog persistence | `PostgresConversationEventStore`, `PostgresConversationCatalog`, `PostgresDurableApplicationTurnStore`, `PostgresConversationActivityStore`, and `PostgresConversationSyncStateStore` |
| action request persistence and confirmation UI | approval proposal store and plugin approval presentation |
| bespoke launcher/dialog/transcript/composer | unstyled `@handrail/ai/react` or optional `@handrail/ai/react/styled` |
| typing animation and multi-device state | `createAssistantActivityTransport`, live presence delivery/pub-sub, and protected activity; never the durable event log |
| browser API wrappers | `@handrail/ai/client`; Flutter uses `flutter/handrail_ai_client` |

## Minimal plugin mapping

```ts
const aegisPlugin = createDescriptorToolPlugin({
  pluginId: "spartan.aegis.erp",
  version: "1.0.0",
  displayName: "Spartan Aegis ERP",
  descriptors: [...readDescriptors, ...proposalDescriptors],
  policy: enforceCompanyAndActionPolicy,
});

const application = await createAiApplication({
  plugins: [aegisPlugin],
  connectors: [optionalHandrailMcpConnector],
  installContext: undefined,
  policy: enforceCompanyAndActionPolicy,
  toolLoopLimits: { maxTotalToolCalls: spartanPolicy.maxToolCalls },
});
```

Registration conversion must retain the Zod parser as the execution trust boundary. JSON Schema is only model guidance. The executor receives validated arguments and calls the unchanged domain service. Never serialize the executor, policy, actor context, or approval summarizer to clients/providers.

## Hosted search compatibility

The existing provider sends `web_search`, deferred `namespace` function tools, and `tool_search`, uses `store:false`, retains reasoning items, permits no parallel calls, and validates the returned namespace/name against its advertised set. Preserve all of those properties. `projectOpenAIResponsesTools` produces the same deferred layout from the actor-filtered plan and includes hosted web search when configured. For a model without tool search, it intentionally exposes only the plan's bounded eager tools; it does not silently send all 89 schemas. OpenAI documents namespace tools, `defer_loading`, hosted/client tool search, and web search in the [Responses API reference](https://developers.openai.com/api/reference/cli/resources/beta/subresources/responses).

Configure `createOpenAIResponsesProviderAdapter` with
`toolChoice: (invocation) => invocation.continuation_of ? "auto" : "required"`,
`includeReasoningEncryptedContent: true`, and the application-selected
`reasoningEffort`. This preserves Spartan's first-turn grounding rule while
allowing a continuation to finish in prose, and retains the encrypted reasoning
item required by a `store:false` tool continuation.

## Suggested cutover

1. Wrap existing descriptors as one plugin and assert that the discovered name set is identical for representative roles.
2. Replace only namespace projection, preserving provider code and golden request tests.
3. Put the current routes behind the gateway transport. Wrap the application/provider transport with `createDurableApplicationTransport`; use an opaque request codec backed by Spartan-owned messages rather than storing prompt text in the turn document. Use `DualWriteConversationEventStore` and `DualWriteApprovalProposalStore`; their primary stores remain authoritative and their reconciliation methods never overwrite divergence.
4. Migrate the client to the headless runtime, then the styled preset or a Spartan-owned UI. Keep old routes during rollback.
5. Cut persistence reads over after event/revision, proposal, attachment, and catalog reconciliation. Remove duplicated generic code only after parity tests.

The checked [`examples/spartan-aegis-adapter.ts`](../examples/spartan-aegis-adapter.ts) accepts Spartan's existing `AEGIS_TOOL_DEFINITIONS`, `AegisToolExecutor.run`, and `AEGIS_ACTION_REGISTRY` structural contracts. `createSpartanAegisPlugin` maps action calls to a Spartan-owned `proposeAction` callback; it never invokes the business action executor. The checked default uses the current authoritative 75-call budget, while production should inject that value from Spartan policy.

Required parity tests cover every role's discovered tools, denied cross-company access, proposal-only actions, idempotent confirmation, configured tool-call budget, hosted web citations, attachment limits, archive/restore/new threads, stream reconnect, cancellation, and multi-device convergence.

The current Spartan qualification consumer routes new gateway turns through
`createApplicationTurnTransport` and `createDurableApplicationTransport` with
the Postgres turn store, while retaining the former transport as an explicit
rollback implementation. It stages attachment bytes in the expiring Postgres
blob store, exposes persisted activity with live SSE plus polling fallback,
publishes automatic assistant presence, and uses
`createRequestScopedMcpSession` inside the existing per-message Handrail bridge.
The `0.1.63` qualification artifact also composes
`createPostgresLivePubSubFromPool` from Spartan's existing `pg` pool, so live
launcher activity and typing/presence fan out across application instances.
The bridge is explicitly closed before the pool during shutdown; authoritative
activity snapshots and polling remain the dropped-notification recovery path.
Spartan's service remains authoritative for its Zod validation, actor/company
scope, role-filtered tools, system prompt, proposals, confirmation side effects,
hosted search/citations, and legacy records.

Spartan can now opt into the drop-in browser workspace with
`AEGIS_HANDRAIL_AI_CLIENT=handrail_ai`. The default remains `legacy`, and the
server refuses to advertise the new client unless dual-write persistence and
the protected application gateway are both available. The opt-in client uses
IndexedDB scoped to the signed-in principal, keeps background threads alive,
shows Running/Done/Error on the launcher, supports image/PDF upload, copy
actions, streamed typing state, and protected proposal confirmation. Failure
to load or negotiate the SDK leaves the legacy assistant available as the
explicit fallback. A host can inject shared activity and presence delivery
(Redis, NATS, Postgres NOTIFY, and similar) instead of the process-local
default.

This is deliberately a new-client qualification mode, not a multi-device
history cutover. Spartan legacy rows still mint message/event identities that
do not match browser-authored SDK event identities. Until the server owns one
canonical mutation/event envelope for both paths, browser transcript state is
durable on the local device only and the runtime config reports
`synchronization: "local_device"`. Do not market or enable cross-device history
convergence before that identity migration and its reconciliation tests land.

The protected gateway now includes a read-only synchronization qualification
handler over the reconciled Postgres shadow. Authorized devices can pull the
canonical snapshot and contiguous imported message/attachment/citation events;
foreign conversations and all client mutation appends fail closed. Capability
negotiation intentionally remains `false`, so the production browser cannot
mistake parity reads for a writable convergence authority. The remaining
cutover gate is unifying active-turn runtime identities with these shadow event
identities, then proving two-device convergence before changing runtime config.

Do not remove `provider.ts`, current Aegis routes, or old persistence during these steps. Cut reads over independently after the matching reconciliation report is converged. Binary attachment authorization/resolution, Zod schemas, company/actor construction, system instructions, proposal confirmation side effects, retention, and rollout flags remain Spartan-owned boundaries.

Git dependencies require the package `prepare` script because public exports point at generated `dist` files. Production should pin an immutable tag or package integrity. Spartan's qualification seam pins the locally generated `0.1.63` artifact; the prior `0.1.62` tarball and legacy transport remain available for rollback. A temporary vendored tarball is acceptable for cross-repository qualification when its source tag and lockfile integrity are reviewed together. This artifact contains the Responses grounding/reasoning request options documented above, although the provider-loop cutover remains independently gated from the client qualification switch.
