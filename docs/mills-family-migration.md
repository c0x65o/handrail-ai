# Mills Family ERP integration reference

This adapter removes generic AI transport, conversation, tool-loop, and UI glue without moving household domain authority into `@handrail/ai-assistant`. Mills keeps its Zod schemas, request-scoped session, household authorization, domain services, proposal persistence, confirmation side effects, and audit rules.

## Minimal tool hookup

Mills' existing `AssistantToolRuntime` is structurally compatible with `createMillsFamilyPlugin`; the ERP does not need to depend on SDK types in its domain layer.

```ts
import { createMillsFamilyPlugin } from "@handrail/ai-assistant/adapters/mills-family";

const millsPlugin = createMillsFamilyPlugin({
  runtime: createAssistantToolRuntime(dependencies),
  proposalToolNames: ["create_task", "update_asset"],
  policy: enforceAuthenticatedHousehold,
  propose: ({ proposal, applicationContext, toolCallId }) =>
    millsProposalStore.stage({ proposal, session: applicationContext.session, toolCallId }),
  presentationFor: (name, kind) => ({
    label: kind === "proposal" ? "Review proposed change" : name,
    rendererKey: `mills.${name}.${kind}`,
  }),
});
```

The explicit `proposalToolNames` list is a fail-closed catalog assertion. A declared proposal tool must return a proposal, and a read tool that unexpectedly returns one is rejected. The adapter has no confirmed-mutation callback: `propose` may only durably stage the unchanged Mills proposal. Mills' existing confirmation endpoint remains the sole mutation authority and must retain authorization plus idempotency checks.

The advertised JSON Schema is validated by the bounded Handrail executor before dispatch. Mills' runtime must still parse with its existing Zod schema and repeat household/role authorization at execution time. Tool definitions and client renderer metadata may cross the gateway; sessions, policies, executors, and proposal payload internals may not.

Read outcomes become application-tool outputs with normalized citations. Supply `citationRecords` when Mills needs richer or multiple sources; the default maps the existing single citation and converts internal application routes to safe opaque `mills:` locators rather than public URLs.

## Rollback-safe migration

1. Snapshot tool names for representative roles and compare the legacy runtime with `millsPlugin.registrations`. Block rollout on missing, additional, or role-inappropriate tools.
2. Run the same tool runtime through the plugin while the legacy provider loop remains authoritative. Compare normalized read outputs, citations, denials, and proposed payloads without executing confirmations.
3. Compose the protected server through `createHandrailAssistant`. Use
   `conversationCatalogFor`, `approvalStoreFor`, and `attachmentUpload: false`
   only as migration seams while Mills retains those authorities. Keep Mills
   stores primary; reconciliation reports identify divergence and never
   overwrite it.
4. Use `HandrailAssistantLauncher` as the default web surface with
   `presentation="page"` inside the existing drawer, Mills theme tokens, the
   protected request wrapper, and Mills' authorized uploader. Use
   `@handrail/ai-assistant/react/headless` only for a deliberately custom host
   experience.
5. Cut reads to the new durable stores only after event identity, ordering, proposal, attachment, and catalog reconciliation converges. Retain a per-tenant rollback switch through the observation window.
6. Delete legacy generic code only after production parity evidence. Do not delete Zod/domain schemas, authorization, proposal confirmation, audit, retention, or household-scoped persistence.

## Required qualification evidence

- Tool discovery parity for each representative household role and denial of cross-household access.
- Schema rejection both before dispatch and at the Mills runtime boundary.
- Proposal-only action tests plus exactly-once confirmation under retry, reconnect, and concurrent approval attempts.
- Image/PDF authorization and rendering, citation targeting, transcription/voice capability negotiation, copy/retry/Stop, and redacted error behavior.
- Starting and switching conversations during active streams; launcher Running, Done/unread, and Error transitions.
- Durable reconnect/cancellation, multi-device event convergence, distributed activity/presence, and multi-instance failover.
- Correlated diagnostics for gateway, provider/upstream/retry, tool/MCP, approval, persistence, attachment, activity, and presence failures without prompts, credentials, or private proposal data.

Record the legacy files and lines retired in the rollout report. Count only code made unreachable after the rollback observation period; shared adapters and retained Mills domain/security code are not removal. The Mills qualification seam must pin one immutable reviewed artifact and record its exact lockfile integrity; preserve the preceding reviewed artifact and the legacy routes for rollback until parity converges.

## 0.2 qualification record

The 0.2 candidate moves Mills server composition to the high-level
`createHandrailAssistant` path. The SDK owns the generic gateway,
synchronization, durable turn wrapper, canonical activity lifecycle, presence,
and durable AI Runtime usage outbox. Mills' transitional provider adapter keeps
the existing provider behavior, Zod/domain validation, request-scoped Handrail
connector, household policy, proposal persistence, citations, and confirmed
mutation execution.

Mills cannot reconstruct an opaque user session token after restart and must
not persist it. The SDK therefore recovers pending work when that trusted
session scope is next authenticated. Hosts with safely enumerable
service-scoped contexts may also provide `recoveryContexts` for boot-time
recovery.

The browser now renders `HandrailAssistantLauncher` directly. The former
758-line `MillsHandrailAiWorkspace` and its 352-line component test are removed,
along with most custom client bootstrap and synchronization code. These are
qualification-source reductions, not a production retirement claim: the
legacy selector and server path remain available until the immutable 0.2
artifact is pinned and the observation gates close.

The checked-in Mills manifest remains on `@handrail/ai` 0.1.91 while the 0.2
candidate is tested from a local package. It must move to
`@handrail/ai-assistant` only with the real reviewed 0.2 commit SHA and matching
lockfile metadata. The conformance checker rejects aliasing the old artifact
under the new name.
