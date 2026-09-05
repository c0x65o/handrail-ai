# Mills and Spartan SDK parity readiness

Goal: preserve legacy and SDK modes in both applications and reach demonstrated
behavioral parity for owner testing. This checklist is incomplete until each
requirement has evidence from the relevant SDK and host paths. Passing unit
tests alone does not establish live host parity.

**Latest package:** [0.2.8 synchronization fixes](synchronization-fix-2026-09-05.md); earlier package evidence below is retained as history.

## Current qualification status — 2026-09-05

The current source and packaged integrations have substantial automated evidence.
**Live parity is not signed off.** The goal is blocked on the verified external dependencies in [the platform handoff](parity-platform-dependencies.md). Use [owner testing instructions](parity-owner-testing.md)
for the exact mode switches, remaining runtime checks and external dependencies.
The chronological work log below includes superseded candidates and gaps that
later checkpoints close; this table is the current summary.

| Requirement | Current evidence | Remaining acceptance |
| --- | --- | --- |
| Server-owned text state across disconnect/reload/cancel/recovery | Real SDK gateway/client fixtures exercise disconnected work, reopening before/after completion, canonical terminal races, activity-write repair and another send without duplicate provider execution. Runtime, reconciler, cancellation and sync tests passed. | Real browser reload during a provider/tool run in each host; deployed worker restart. |
| Independent threads and persistent unread state | Ordered activity projection, background workspace observers, server read markers and shared native recovery pass targeted tests. Voice has a separate authorized workspace feed and lifecycle/read evidence. | Two actual concurrent host threads and cross-device completion/read checks. |
| Short activity summary and tool counts with optional details | High-level and host tool loops persist lifecycle events. Default collapsed/expanded/hidden/custom presentations are tested. Web/native voice summaries retain last-known activity on refresh failure. | Owner review of real long-running business workflows and presentation. |
| Project-controlled approvals and bounded multi-step execution | Both mounted host SDK routes cover required and automatic policies through existing domain executors. Required mode resumes after decisions. Durable intent/result ledgers reject changed requests and prevent redispatch of uncertain side effects. | Real provider selection of domain tools, representative bulk changes and domain result validation. |
| Flexible UI and shared infrastructure | Mills uses the standard launcher; Spartan retains its custom presentation on SDK headless bindings. Both mobile apps use the vendored shared Dart client. Client replacement and late bootstrap cleanup are tested. | Real browser/device polish and host-specific business parity. |
| Speech-to-text and realtime voice | Mills recorded audio has durable provider-operation replay and usage evidence. Mills mobile realtime has durable call ownership, explicit uncertain termination, approval review, tool activity and visible read acknowledgements; SQL/HTTP/Dart/widget tests passed. | Real microphone/provider/device acceptance. Web voice workspace is observational; per-call review/acknowledgement is in Mills mobile. Spartan declares no realtime voice capability. |
| Attributed durable Handrail usage | Text receipt outbox/retry/deduplication and host attribution have automated evidence. Actual audio/text/cache/duration evidence is durably retained for supported Mills audio paths. | Live Handrail receipt/deduplication proof. Audio evidence is **not** yet a supported billed receipt: authoritative modality/duration/pricing/acceptance contract is missing. |
| Schema/migrations/compatibility | SDK schema V1 matches host migration output; reapplication retains execution records. Single migration job and compatible shared workers are documented. | Confirm migration journals in the exact environment under test; no staging/production migration or rollout performed. |
| Both web modes | Protected host gateway/domain fixtures and scoped compiles passed. Existing/SDK switches remain. Both local web services now start after restoring their managed databases. | Mills real browser login, legacy/SDK bootstrap and fallback now passed. Spartan authenticated browser and both host provider flows remain acceptance work; health endpoints alone are insufficient. |
| Both mobile modes | Account-scoped Try SDK / Use legacy selectors, protected transports, pending journals and recovery have targeted HTTP/widget/Dart analysis evidence. | Real device login, background/reload/voice behavior against current servers. |
| Reproducible candidate | Both web hosts pin **0.2.7 / 5683009ec79b**. Four clean dev/production installs passed, with all 24 JS exports imported and all 317 package files matching. Shared Dart 0.1.1 source/provenance matches in both mobile vendors. | Publish/release only after owner approval; archive, manifests, lockfiles and provenance must remain together. |

## Work log

- 2026-09-04: All five repository worktrees were clean at goal start. Earlier
  SDK timeout/progress patches are present. No applicable AGENTS.md found in
  inspected repository/ancestor paths. SDK Coverage Q&A search in the preceding
  review returned no matching decisions.
- Source finding: `withDurableActivity` published completion from an observer's
  result promise. Disconnected observers were skipped, and replay could mark a
  completed conversation unread again. Move lifecycle notifications to durable
  status writes, independent of observers. This is one fix, not full parity.
- Validation: `vitest run test/durable-application-transport.test.ts
  test/server-assistant.test.ts --maxWorkers=1` passed (13 tests); package
  `npm run typecheck` passed.
- Next source finding: the high-level provider tool loop returns tool results
  to the model, but its `tools.execute` path does not append the shared
  discovered/started/result-recorded lifecycle used by the lower-level loop.
  Accurate persisted tool counts/details need this lifecycle wired before UI
  counts are presented as authoritative. Approval rejection/expiry must also
  settle the displayed tool state. Verify synchronized-client ordering.

## Owner testing handoff

See [current owner testing instructions](parity-owner-testing.md),
[installation and upgrade](parity-installation-and-upgrade.md), and
[clean-install evidence](parity-install-evidence.json). The remaining live and
billing checks are explicit acceptance work, not passing results inferred from mocks.

## Continued implementation evidence

- High-level tools now persist requested/discovered/started/approval/result events
  with stable identities. Concurrent delivery and history pagination tests pass.
  Confirmed and rejected approvals settle the expected execution/result state.
- Styled defaults show one collapsible count/status panel; hosts can hide it or
  replace its rendering. Existing styled suite passes (16 tests); new activity
  UI suite passed (3 tests). These are SDK tests, not host browser evidence.
- Workspace and single-client recovery previously awaited the entire resumed
  run before exposing the conversation. Recovery now runs in the background;
  tests cover opening during recovery, background unread completion, and errors.
- Built-in server-backed multiple runtimes now poll canonical events independently
  of provider frames through the serialized mutation boundary. Runtime tests pass
  (33), including temporary failure/retry, tool state without frames, and cleanup.
  Custom event stores are not automatically polled.
- Server assistant/lifecycle/bulk, client bootstrap, and workspace targeted batch
  passes (19 tests). Package typecheck passed after fixing a test reducer's type
  inference. Scoped lint identified one unused initialization, now removed;
  scoped lint rerun passed.
- Mills and Spartan Coverage Q&A searches for "assistant" returned no matches.
- Still inspect remote activity versus open-thread state merging, reconciliation
  after activity write failure, and stale status writes from competing turns.
  Single-client recovery is now covered using the real runtime and gateway with
  an intentionally pending fetch; bootstrap returns the running conversation.
  Host integrations, voice/usage, migrations, mobile and handoff remain incomplete.

- Further host inventory: both web UIs already use built-in multiple-conversation
  client assembly (without a custom event store), so they will receive canonical
  polling after adopting the SDK candidate. Both hosts still wrap their domain
  service tool loops inside a custom provider; the new SDK tool lifecycle hook
  alone does not instrument those legacy loops. This must be closed explicitly.
- Spartan's `conversationStatuses` overwrites server activity with open-thread
  local status, and SDK `useConversationLauncherBinding` excludes server status
  and unread for all open threads. Both need a shared resolution contract that
  distinguishes a new local admission from older remote status; do not merely OR
  running booleans or let an old terminal record erase a newer pending send.
- Mills qualification document is stale: it describes 0.1.91 while the manifest
  pins `@handrail/ai-assistant` commit 8468d21f93a5b60ebc710e473c0477554316abe6.
  Spartan pins 4d191e22a9d0e47af35141dbd5235c55b7f37f38 (documented 0.2.3).
  Keep manifest/lockfile immutable pin policy and update final handoff truthfully.
- Current final package typecheck passed again; runtime suite 33, bootstrap suite
  8 (including pending gateway recovery), workspace 3, server assistant 5,
  lifecycle 2, bulk 2, styled 16 have passed in bounded sequential runs.

## Activity ordering and open-thread state (continued)

- High-level lifecycle and tool summary writes now carry canonical turn identity
  and admission revision. The existing JSON activity schema accepts these fields
  without a new table migration. Older/custom records are still readable, with
  weaker timestamp/local-state fallback when turn identity is absent.
- Postgres activity upsert retains terminal state and cleared read markers for
  the same turn and rejects records for older admitted turns. In-memory client
  activity applies the same ordering across live delivery and polling snapshots.
- `projectConversationActivity` and `useConversationActivitySnapshot` are the
  shared open/unopened-thread projection. Default launchers and both default
  thread pickers now use it, including unopened catalog status. Spartan's custom
  list still needs adoption when its SDK candidate dependency is installed.
- Targeted activity/projection/Postgres-foundation/server suites pass (27 tests).
  The Postgres ordering test uses a document CAS double, not live PostgreSQL.
  Styled suite passes (17 tests), including same-turn server completion/unread
  replacing a disconnected open runtime's running indicator and clearing unread.
- Still needed: durable activity reconciliation when the activity write itself
  fails after the durable run status succeeds; a default chat's inline summary
  must use the same resolved state as the launcher; final scoped lint/typecheck
  for these edits; actual host candidate adoption and end-to-end testing.

- Activity polling now preserves live updates received while a snapshot request
  was pending, including older gateway records without turn identity. Manual
  refresh replaces its existing timer, and stop prevents late requests from
  publishing. Activity suite passes (11 tests). SDK typecheck and scoped lint
  passed for the activity-ordering/default-picker changes; final polling typecheck and scoped lint passed.
- Canonical event completion is still observer-projected: after retry exhaustion,
  a disconnected runtime may remain locally active even if the activity index
  reports completion. Server frame-to-canonical-event reconciliation is the next
  material state gap to resolve, alongside activity delivery failure recovery.
  Do not treat the newly accurate launcher as proof of full runtime recovery.

- Next reconciliation implementation can reuse the existing runtime projector:
  runtime already records a `turn.status_changed` queued event with
  `metadata.handrail_runtime.transport_turn_id` before observing frames. A trusted
  server reconciler can recover that mapping from durable turn identity (the
  high-level durable transport uses canonical `conversationTurnId`), replay stored
  frames through the runtime's existing deduplication, and persist terminal state.
  It must handle concurrent browser projection, absent mapping after early
  disconnect, canonical terminal races, cancellation, and replay without a new
  provider call or duplicate usage capture. Validate before choosing this design.

## Server transcript reconciliation (continued)

- Added `server/reconcile-conversation.ts`: terminal durable output is projected
  through the shared runtime with a transport that cannot start provider work.
  It binds missing transport identity after an early disconnect, replays stored
  frames with existing deduplication, and handles concurrent projectors. Actual
  durable worker failure/cancellation can supply runtime terminal facts without
  synthesizing provider usage; success requires retained completion evidence.
- `createHandrailAssistant` invokes reconciliation on durable status changes,
  authorized catalog-list reads, and authorized synchronization operations.
  The same path repairs a failed activity write while keeping read markers.
  Catalog failures emit diagnostics without hiding otherwise accessible threads;
  synchronization failures prevent returning falsely current state.
- Runtime now respects a terminal canonical winner when observation/rebase races
  server projection, preserves the winning assistant message ID, and recovers
  cancellation reason from persisted state after reload.
- Integration testing exposed two existing sync defects: payload turn validation
  assumed provider request ID equals canonical turn ID; stale-revision proposals
  reached batch validation before returning a revision conflict. Both fixed.
  A lower preliminary revision can still be stale, so atomic store append remains
  authoritative in that case (existing regression retained).
- Reconciler suite passes (7): direct early-disconnect recovery, concurrent
  projection, missing-frame failure/cancellation, cancellation winning provider
  completion, rejection of missing success evidence, and real SDK client/gateway
  recovery followed by another send with exactly one new provider execution.
  The gateway fixture injects an activity write failure and verifies repair plus
  read-marker preservation. This is in-process, in-memory evidence, not live-host
  or live-Postgres evidence.
- Runtime suite (33), cancellation suite (9), gateway sync (2), and event-store
  sync suite (7) pass in targeted runs. Final package typecheck and scoped lint pass.
- Next: explicit disconnect-during-running gateway test (not just a preloaded
  terminal record), receipt replay/outbox evidence under reconciliation, inline
  status consistency, then candidate installation into both hosts and domain
  tool-loop lifecycle/activity integration. Broader voice/migrations/mobile and
  owner handoff remain incomplete.

## Disconnect and usage recovery qualification (2026-09-04)

- Real SDK gateway/client tests now stop observation after partial output, dispose
  the browser client, and reopen both before and after server completion. Both
  paths retain one assistant message and one provider execution per requested
  turn. Reopening while running explicitly verifies a successful resume response.
- SSE readers are cancelled when observation stops, including fetch adapters
  which do not close their body when their request signal aborts. Early iterator
  exit releases the reader and cancels unread response data.
- Resume resolves retained frame IDs/cursors independently of canonical
  conversation revision. Canonical revisions include user and tool events, so
  comparing them with provider frame sequence caused valid resumes to return 400.
- Disconnect checkpoint proposals are accepted only when the referenced retained
  frame already has canonical, resume-safe evidence. Unknown frames, unapplied
  frames, future revisions, and forged status changes are rejected.
- Terminal reconciliation recaptures the stored provider receipt before returning
  even when the transcript is already complete. Receipt links are idempotent.
  A failed outbox write can be retried without inventing usage or answer text.
- Postgres usage acknowledgement retains a delivered receipt identity instead of
  deleting it. Replayed capture and late network failures cannot requeue delivered
  receipts. A simulated lost acknowledgement retries the identical payload and
  models one remote acceptance. Live Handrail billing evidence remains pending.
- Current summary uses the same turn ordering as the launcher and thread picker;
  a lagging running summary disappears when canonical completion arrives.
- These checks use in-memory persistence and simulated provider/telemetry. They
  establish SDK integration behavior, not live-host or live-database parity.

## Candidate host qualification (2026-09-04, continued)

- Packed SDK 0.2.5 after successful package typecheck, scoped lint and build.
  Local archive `/tmp/handrail-sdk-parity-candidate/handrail-ai-assistant-0.2.5.tgz`
  has SHA-256 `5fcc724fa9182fb63909149818906f8b0e03e5f8e46af0c0338ece1a16214081`.
  Both web repositories now have that archive extracted into their installed SDK
  package, retaining the old package's nested dependency graph (requirements
  match). Originals are backed up under the same temporary directory as
  `mills-original-ai-assistant` and `spartan-original-ai-assistant`.
  Their package manifests and lockfiles remain unchanged. A reviewed immutable
  SDK revision and host lockfile updates are still necessary before shipment.
- Mills gateway baseline passed 10 tests on its original installed 0.2.1 package.
  Candidate execution exposed one-based citation order in the Mills adapter.
  The runtime requires zero-based contiguous citations; replay stopped after
  answer text and never reached completion. Fixed the emitted order. The test
  now asserts canonical completion and citation/message linkage, and waits for
  the independent durable lifecycle callback. All 10 gateway tests pass, plus
  7 client/mode-switch tests. Scoped host compile passes.
- Spartan custom UI now consumes `useConversationActivitySnapshot` instead of
  overwriting server activity with local open-thread status. Added the shared
  collapsible ToolActivity component and current summary/progress rendering.
  Its 5 UI tests pass, including remote completion/read while the open runtime
  still says running. Scoped host compile passes. These new UI exports require
  the candidate; the old checked-in SDK pin cannot compile the new imports.
- Both hosts have `tsconfig.handrail-ai-qualification.json` for repeatable scoped
  compilation. Host integration docs now contain exact mode controls, candidate
  identity, local restore instructions and explicit release dependencies.
- SDK evidence for this continuation: reconciliation/gateway suite 14 passing
  (including invalid checkpoint cases); durable transport 9; Postgres foundation
  8; SSE cancellation 2; styled preset 18; shared activity projection 5. Package
  typecheck and scoped lint passed. Simulated telemetry acknowledgement loss
  proves identical retry payload and retained delivery identity; it is not proof
  of live Handrail billing settlement.

Next unfinished work:

1. Add a real high-level Spartan gateway/client fixture (existing tests do not
   instantiate createSpartanAegisAssistant). Exercise actual host reload flows.
2. Bridge both domain tool loops to shared SDK lifecycle/progress and project
   approval policy. Currently neither high-level host provider invokes the SDK's
   supplied tools.execute; the panel cannot count every actual domain call yet.
3. Verify that canonical terminal synchronization stops a stuck local observer
   and clears composer.isSending, not just the launcher/summary. Inspect runtime
   synchronize plus ongoing observation cleanup before claiming full state parity.
4. Inventory/consolidate voice and mobile, validate migration upgrade/recovery
   contracts, preserve legacy fallback and finish reproducible owner handoff.
5. Recheck old stored Mills citation batches during upgrade: this patch corrects
   newly emitted batches; already-retained one-based batches may need an explicit
   compatibility path. Do not silently rewrite historical canonical evidence.

Final scoped lint passed in both edited web hosts. No mobile files or project configuration were changed in this continuation.
Runtime (33), cancellation (9), event-store synchronization (7), and gateway synchronization (2) regression tests also pass against the final SDK source in this continuation.

## Host tool observation and pending-send completion (continued)

- The previous goal turn made concrete source changes and produced passing host
  and SDK checks; classified as progress, not a blocked/wait turn.
- Runtime synchronization now detaches observations for canonically terminal
  turns. Tests cover a hanging local send resolving completed, cancelled, or
  failed after synchronization, without starting another provider operation.
- High-level providers receive `toolActivity.observe`. This shared migration seam
  records actual dispatch lifecycle, short summary/progress and generic outcome
  while returning domain values unchanged. It does not replace host policy or
  side-effect idempotency. New applications continue to use SDK tool plugins.
- Mills provider forwards actual call IDs through this observer and through its
  shared application wrapper. The wrapper retains citation metadata for repeated
  calls inside the bounded provider run. The high-level gateway no longer emits
  an extra synthetic tool call for each proposal after the provider finishes;
  proposal review stays on its existing authorized approval resource.
- Spartan service forwards both domain and connector dispatch through the same
  observer when invoked by the SDK gateway. Returned safe error results are
  counted as failed; successful proposal preparation is a completed tool call,
  with confirmation still represented by the existing action proposal.
- Expanded the existing mounted high-level Spartan test in `tests/aegis.test.ts`
  (found via its feature-router composition). It exercises a real read tool,
  SQL-backed canonical completion/tool history/citations, and attributed receipt
  submission to a fake telemetry receiver. Targeted test passes. This supersedes
  the earlier note that no high-level host fixture existed.
- Mills gateway + plugin checks passed (13 at that point), followed by targeted
  real provider and stable-call replay checks (2 passed). Its gateway verifies
  a completed actual read tool and summary. The provider test verifies two
  stable call IDs and retains proposal-only side effects. Scoped production
  compile passed in both web hosts; final tests/lint listed below.

### Mobile inventory findings

- Mills mobile is Flutter with a native assistant repository/screen, recording
  through `record`, and WebRTC voice through `flutter_webrtc`. Its live voice
  client sends SDP to the authenticated primary server, keeping provider secrets
  and the tool sideband server-owned. Chat still uses the primary legacy API;
  no SDK gateway selector/adapter is present.
- Spartan mobile is Flutter with `AegisWorkspaceRepository`, conversation and
  messaging controllers. It currently uses the legacy JSON API, local isSending
  state, and has no speech/voice package declared. `replaceWorkspace` ignores
  incoming state while sending. SDK gateway integration and native mode selection
  remain outstanding in both mobile repositories; no mobile files changed yet.

Next material items remain project-controlled approvals/bulk continuation with
shared idempotency, old stored Mills citation compatibility, supported voice
usage and cleanup, mobile integration, migration qualification, and live host
reload/disconnect/multiple-thread evidence. No release/publish/deploy authorized.

Final checks for this continuation: SDK runtime/assistant/bulk/observer batch
passed 46 tests (36/5/2/3). SDK package typecheck and scoped lint passed. Mills
and Spartan scoped lints passed. Spartan scoped typecheck includes its real
service/gateway plus mounted gateway test and passed. Mills scoped typecheck
was expanded to include the provider and plugin tests; an incomplete test tool
definition was corrected to declare `type: function` before the final rerun.

Final Mills scoped typecheck passed. Refreshed both local web installations with the final built candidate, SHA-256 `5e6b15a3bdd41e13cd8600dfdce4bd458569805bd0c421467f6674c9806f2227`; original package backups and production pins remain intact.

Read the latest Handrail context for all three AI Chatbot projects while preparing runtime qualification; explicit group repository/config permissions match the supplied scope. Context/tool results are retained in this thread's tool store (`context-mills`, `context-spartan`, `context-sdk`). Mills declares Postgres and private object storage; resource specs are retained as `resources-mills` and `resources-spartan`. No resource/config mutation or deployment was performed. Further runtime qualification must use declared resources and environment-specific authoritative QA profiles.

## Resumed after authentication rotation: approval truthfulness and dispatch safety

- Verified the active goal and existing workspace changes; continued the approval
  investigation without restarting prior work. No commits/pushes/releases.
- Mills' provider previously always told the model that proposals were accepted
  for automatic application. Both SDK gateway compositions actually persisted
  them as pending. Gateway requests now select `require_confirmation`; provider
  instructions and tool outputs explicitly report awaiting confirmation and
  `applied: false`. Legacy text routes still queue automatic application after the
  response, now explicitly described as deferred. Realtime voice retains its
  immediate execution semantics. This fixes misleading model context; it does
  not yet provide project-controlled automatic bulk execution.
- Mills provider/gateway suites passed 37 tests, scoped qualification TypeScript
  compile and touched-file lint passed. The existing bounded provider test now
  exercises both mutation policies and proves no mutation executes while pending.
- Found a prerequisite for automatic bulk safety: SDK Postgres tool execution
  previously held a transaction across the external callback and inserted only
  completion. A crash after an external commit could roll back the ledger and
  permit duplicate execution. It now commits a durable admission document before
  dispatch, retaining that claim through callback failure and completion rollback.
  A later worker refuses uncertain work instead of rerunning it. Completed old
  results remain readable. Same-ID protection does not solve host-generated new
  call IDs for the same intent or changed arguments under a reused ID.
- New dispatch tests cover external effects followed by failure, completion-write
  rollback, lost acknowledgements at admission and completion, competing workers,
  and tenant isolation. Bounded bulk/persistence/dispatch batch passed 13 tests.
  SQL integration qualification and final validation continue below.
- Project policy wiring, durable intent/argument binding and domain outcome
  reconciliation remain material prerequisites before enabling automatic host
  bulk mutation. Mobile, voice/usage, migration qualification, historical Mills
  citations, live runtime evidence, and immutable release pins remain open.

Final validation for this continuation: PGlite integration passed (1), including
real SQL migration replay, external commit followed by completion rollback,
retained claims, suppressed retries, and legacy completion reuse. SDK package
TypeScript check and scoped lint passed; executor/foundation/assistant batch
passed 34 tests. Added exact development dependency `@electric-sql/pglite@0.5.4`
and its lockfile entry so the SQL check is reproducible. SDK build/package passed.
Both local web installations now use candidate SHA-256
`88f454c80c58411bfc7a396d4dad87f557f9c09f585e36d6d2f49446149fccfa`;
production immutable pins and original package backups remain unchanged. Mills
scoped typecheck passed again against the refreshed candidate. Spartan final
checks continue below.

Next implementation entry point: `src/tools/executor.ts` currently reuses cached
and concurrent calls by tool-call ID before verifying that the name/arguments
match the original call; `PostgresToolExecutionLedger` also keys only by tenant
and call ID. Bind immutable request identity before using that fast path. Then
wire project policy into the host-owned proposal/confirmation services with
explicit policy-origin audit evidence and stable intent identity. Avoid merely
changing approval UI or declaring the observer an execution ledger. Mills'
`completeMessage` supports only a global confirmed/proposed status; mixed policy
outcomes require truthful per-proposal persistence or an equivalent domain seam.
Spartan already durably claims action requests before dispatch, but currently
stages each request with a random execution key; preserve existing actor checks
when adding a policy-approved path. No automatic mutation policy enabled yet.

Spartan final scoped TypeScript compile passed against the rebuilt candidate;
its mounted SDK gateway qualification passed again (1 selected test, 68 skipped).
This continuation passed 86 targeted tests in total across the SDK and both web
hosts. Both mobile worktrees remain unchanged. Goal remains active; the next
implementation work is the immutable execution binding and host project-policy
integration described above, not a release or deployment step.

## Immutable retry requests and independent execution scopes

- Previous goal turn was progress: corrected Mills mutation status, added durable
  dispatch admission, qualified SQL rollback, and refreshed the web candidate.
  Latest Handrail/native objective remains active and unchanged.
- SDK bounded execution now binds cached and concurrent calls to canonical JSON
  containing provider call ID, tool name and arguments. Different arguments or
  names cannot reuse a result or dispatch under the same execution identity.
  Property ordering is normalized; array order is significant. Input is copied
  before asynchronous authorization. Oversized IDs cannot alias a retained prefix.
- In-memory ledgers retain the binding; Postgres admission documents retain its
  SHA-256 digest. Missing bindings on old directly addressed rows cannot validate
  a new bound request. Custom ledgers must honor the new optional fingerprint
  argument; old adapters accepting extra arguments silently are not qualified.
- Default Postgres ledgers now separate persistence scopes. High-level tool calls
  receive an executionKey from scope/conversation/turn/provider-call identity,
  while protocol IDs stay unchanged. Bounded executors receive executionKey in
  their context for domain idempotency. Two conversations using the same local
  provider call ID now execute independently; retrying the original reuses it.
- Compatibility: new scope-derived keys do not migrate historical unscoped
  entries. Drain/reconcile historical active work before upgrading all workers;
  do not resume old mutations under new keys. This prerequisite is documented in
  integration-migration.md. Providers must still issue unique canonical call IDs
  within each conversation and supply call location to get turn-aware keys.
- Bounded executor/bulk/approval tests passed (25/2/6). SQL and final compile checks
  continue below. Realtime tool bridge (9) and application assembly (5) passed
  after argument binding, before the final executionKey addition; rerun relevant
  checks for that final addition before final candidate qualification.

Final SDK validation for retry binding/scope changes: package TypeScript check
passed. Final bounded/bulk/approval batch passed 33 tests; realtime bridge,
application assembly, high-level assistant and Postgres foundation passed 27.
PGlite integration passed with scope isolation as well as digest/legacy binding
checks and real rollback. The dispatch fault-injection suite also passed (6).
Scoped lint passed. These are controlled SDK/SQL tests, not live billing or
browser parity evidence.

Next concrete host work: Mills already has an authorized mutation executor and
`PostgresAiPersistence` in its gateway options, plus a canonicalJson helper. Add
an explicit server-controlled SDK mutation mode (default requires confirmation;
optional automatic mode) and a provider proposal-resolution callback that runs
before the next model step. In automatic mode, use a stable turn/proposal ordinal
as the intent key, bind the validated proposal through getOrExecuteTool's new
fingerprint argument, and call the existing mutation executor with the same
stable domain idempotency key. Preserve role/household checks. Return the actual
result to the model before dependent reads; record policy-origin execution in
the retained result/domain audit and persist confirmed proposals only when they
were actually applied. Required mode stays pending. Verify automatic update then
read, denied/cancelled dispatch, immutable retry and partial failure with real
host/provider fixtures. Do not merely change confirmation labels.

Built and installed the final candidate for this continuation in both local web
workspaces: SHA-256
`ed8c1c26017f4c44833aa4da0b1e93033e2c86563acd3a7d39de2034416f5712`.
Production pins/lockfiles were not changed. Mills provider/plugin qualification
passed 31 tests against this candidate. SDK production compile and build passed;
no new host production source was edited in this continuation. Spartan's mounted
gateway test is the final local integration check recorded below.

Spartan's mounted SDK gateway qualification passed against the final candidate
(1 selected test, 68 skipped). Goal remains active. Next work is the concrete
Mills project-controlled mutation continuation above, followed by Spartan policy
integration and the remaining mobile/voice/runtime qualification requirements.

## Mills project-controlled mutation continuation

- Previous goal turn made concrete progress on immutable retry binding and scope
  separation. Verified the latest native/Handrail goal is unchanged and active.
- Added `MILLS_HANDRAIL_AI_APPROVALS=required|automatic` (default required), parsed
  on the server and wired into the high-level SDK composition. No deployed
  project configuration changed. Legacy text routes keep their existing deferred
  automatic application; external connectors keep their own approval policies.
- In automatic SDK mode, the Mills provider now resolves each proposal before its
  next model step. Existing Mills mutation services still own role/household,
  argument, version, transaction and domain audit behavior. The SDK Postgres ledger
  owns dispatch admission, immutable intent binding and result recovery. Intent
  keys use turn/proposal ordinal, so provider-generated call IDs can change on
  recovery without repeating the same domain write.
- Ledger results retain policy ID, actor, conversation/turn/proposal/call identity,
  original proposal and domain result. Message completion records policy origin
  in Mills audit metadata. Confirmed status is saved only when the provider's
  proposal list matches the actions actually applied. Error/uncertain outcomes
  abort the provider loop, rather than permitting further dependent mutations.
- Required-mode intents retain their policy too when persistent SDK integration
  is present. A policy change during unfinished work conflicts with the retained
  intent; it cannot turn an applied action into a new pending proposal or silently
  bypass a prior confirmation requirement. Legacy standalone transports without
  a mutation ledger can still prepare pending proposals, but cannot auto-apply.
- New real-provider-loop/PGlite tests verify write then read in automatic mode,
  unchanged data in required mode, same-intent recovery across provider call IDs,
  changed-intent rejection, policy changes in both directions, current-role
  denial, cancellation before dispatch, partial external failure, and returned
  domain errors. The mounted high-level gateway fixture now exercises both modes
  and verifies pending/confirmed persistence and policy audit input.
- Validation: config/resolver/gateway batch passed 71 tests before the additional
  policy-change cases; final resolver/gateway batch passed 20 tests (9/11).
  Existing provider suite passed 27 with the new callback path. Expanded scoped
  TypeScript qualification includes server index/config and imported composition;
  it passed after adding a missing strict flag to a test tool definition. Scoped
  lint passed. SDK candidate remains ed8c1c26017f4c44833aa4da0b1e93033e2c86563acd3a7d39de2034416f5712.
- Required Mills mode still retains the existing proposal-response workflow;
  confirmation runs on the existing domain route. Same-provider-turn pause/resume
  across that external confirmation is not qualified yet. Review this explicitly
  alongside approval activity labels; do not claim the new automatic path proves
  all required-approval continuation behavior.
- Next concrete project work: implement Spartan's equivalent SDK-only policy path
  through its existing action request claim/execute/settle services, preserving
  actor availability checks and distinguishing project-policy authorization from
  a user confirmation. Then close remaining approval/state qualification and
  mobile/voice/runtime requirements. Reproducible clean-install adoption remains
  open: current web manifests still pin old SDK commits while local node_modules
  use the reviewed candidate. Consider a reproducible vendored candidate artifact
  if repository instructions permit it, instead of leaving owner testing dependent
  on a manual node_modules replacement or requiring a premature published release.


### Resumed Mills interruption qualification

- Completed the previously unfinished Mills checks. The final gateway/resolver
  batch passed 23 tests. Two targeted real-store/PGlite tests verified retained
  failure text; expanded scoped tsc and scoped lint passed. An earlier tsc run
  caught a test helper typo (`consume` instead of `collect`), corrected before
  the successful rerun. The previous log's lint assertion was premature; this
  resumed run supplies the actual passing lint result.
- Mutation resolution now retains whether changes may have applied, including
  recovered results and uncertain prior dispatch. If a later operation fails,
  Mills emits a non-retryable error and saves a partial-change warning. Cancellation
  after dispatch saves the same warning; all saved cancellation text no longer
  claims no changes occurred. Domain effects are not rolled back by cancellation.
  Original exceptions remain in host diagnostics. The two transport regression
  cases cover provider failure and cancellation after a completed mutation.
- SDK candidate unchanged (ed8c1c26017f4c44833aa4da0b1e93033e2c86563acd3a7d39de2034416f5712).
  No live provider/deployment claims. Goal remains active.
- Next unfinished work is Spartan's SDK-only approval policy. Current service.ts
  proposeAction (~341) always creates pending action requests with random execution
  keys. confirmAction/settleActionConfirmation (~551/599) already claim rows and
  run registry authorization. Extend that mechanism with explicit project-policy
  audit origin and stable SDK intent; do not disguise automatic execution as a
  user click. Gateway calls service.send (~652 and ~1038). Then address the
  already documented required-approval continuation, reproducible dependency,
  mobile, voice/telemetry, migration, and real runtime evidence gaps.

### Spartan SDK approval policy qualification

- Added `AEGIS_HANDRAIL_AI_APPROVALS=required|automatic` (default required), wired
  config -> product services -> mounted high-level SDK gateway -> Aegis service.
  Legacy service requests retain required confirmation. No deployed settings changed.
- `handrail-ai-action-policy.ts` wraps domain proposals in SDK Postgres durable
  dispatch. Keys bind company/principal/thread/original SDK turn/proposal ordinal;
  fingerprints include original message, validated arguments, summary, membership,
  and policy. Recovered results are reused; changed intent/policy and uncertain
  dispatch fail closed. The resolver stops all later actions after a dispatch error.
- Automatic actions still create Aegis action rows, claim pending-to-executing,
  revalidate with the domain registry, and retain display-safe results. Their
  authorization is `project_policy` with policy/actor/time evidence, not a user
  confirmation; confirmedAt remains null. The result reaches the provider loop
  before dependent tools. Provider instructions now match required vs automatic.
- Provider failure/cancellation after auto dispatch preserves completed action
  rows and saves a review warning. The surfaced failure is non-retryable. Actual
  causes remain host diagnostics. Gateway failure/cancel frame sequence now follows
  already-emitted text frames rather than always using sequence 1.
- Evidence: mounted gateway tests passed in both policies; 2 real-store partial
  interruption tests passed; streamed progress followed by failure passed canonical
  replay (1 test). SDK policy/PGlite plus existing provider continuation suites
  passed 20 tests. Legacy pending-proposal and confirmation-executes-once tests
  passed (2). Final expanded scoped tsc and scoped ESLint passed; diff check clean.
  Test executors/model responses are simulated; live financial/provider correctness
  remains unproven. Early fixture failures were corrected (required note missing;
  actor gained SDK context fields so matching now checks authoritative identity).
- Other concurrent workspace work introduced record attachment migrations. Its
  test recycler initially could not truncate immutable tables; another workspace
  edit updated tests/support/pglite.ts during this turn. SDK work did not edit the
  attachment migration, production triggers, or recycler. Retried qualification
  after that fix; preserve those unrelated edits.
- Next: close clean-install reproducibility (both web manifests still pin old SDK
  commits despite installed candidate ed8c1c26017f4c44833aa4da0b1e93033e2c86563acd3a7d39de2034416f5712).
  Consider checked-in vendored candidate tarball + file dependency/lock entries,
  with exact content hash and provenance, without publishing or committing.
  Continue remaining required-approval continuation, state/mobile, voice/telemetry,
  migration compatibility, real runtime qualification and final owner handoff.
  Goal active; no commit/push/PR/release/deployment has been performed.


### Reproducible web dependency adoption

- Both web apps now include `vendor/handrail-ai-assistant-0.2.5-parity.ed8c1c26017f.tgz`
  and provenance/README files. Manifests and npm lockfiles use the relative file
  dependency. Only the root dependency reference and SDK lock entry changed;
  every other dependency resolution stayed intact. Existing SDK build executable
  and declaration files matched the candidate (263 checked); no SDK source/code
  change was required for adoption. Same candidate SHA-256 as preceding tests.
- Fresh temporary copies of both host manifests/lockfiles/vendor archives installed
  production dependencies successfully. Development installs explicitly used
  `--include=dev` because this worker defaults to production. Lifecycle scripts
  were initially disabled; Spartan's existing financial SDK postinstall patch
  and companion files were then copied and run successfully. No host source or
  configuration was changed to work around that required patch.
- The first offline Mills attempt lacked the pre-existing MCP git archive in npm
  cache; normal network-enabled install succeeded. A temporary Spartan copy first
  omitted two financial patch companion files, causing postinstall/type failures;
  copying them and rerunning the existing patch resolved those failures.
- Final evidence: all 282 SDK files in each clean install matched the archive,
  npm SHA-512 integrity verified, required SDK runtime/React/Postgres exports
  imported successfully, and both fresh scoped host TypeScript checks passed.
  Clean-check paths are retained in /tmp/handrail-sdk-parity-candidate/{mills,spartan}-clean-install-path.
  Existing workspace node_modules were not reset. Neither archive was published;
  no commits, pushes, PRs, environment changes, or deployments occurred.
- Host qualification documents now describe the actual file dependency and
  install command, replacing obsolete instructions about manually swapping
  node_modules or requiring a release before clean installation.
- Next unfinished requirements: required-approval continuation and state behavior,
  mobile adoption, supported voice/STT + telemetry, migration compatibility,
  real runtime/owner test evidence. The top checklist remains explicitly incomplete.
  Goal remains active; no blocking audit condition applies (this turn made progress).

### Shared Dart state foundation before mobile adoption

- Re-inspected both clean mobile repositories. Neither currently depends on the
  Dart SDK. Mills AssistantScreen uses local sending/load flags and its existing
  PrimaryApiTransport repository; Spartan's messaging controller ignores workspace
  refreshes while sending. Keep both existing surfaces available during adoption.
- Existing SDK Dart client had two material state gaps: observer disconnection
  became failed run state; remote activity was ignored for open conversations.
  `HandrailConversationState` now tracks observation connectivity separately,
  turn identity/revision, sequence deduplication, and superseded turns. Identified
  replay does not append duplicate text or revive completed/older turns.
- The SSE reader emits a disconnected terminal with its last checkpoint when a
  turn response ends without a terminal. Ordinary network exceptions still
  propagate and require a shared reconnect/controller integration next.
- Workspace remote replacement is atomic, keeps newer turn revisions/timestamps,
  preserves acknowledged read state against stale same-version unread responses,
  and projects server completion/read state into already-open conversations.
  Known canonical completion wins over stale same-turn running activity. Summary
  and progress are exposed on workspace entries for host UI reuse.
- Validation: scoped Dart analyze passed (one unnecessary non-null assertion was
  fixed); all 11 Dart client tests passed, including new replay, disconnection,
  remote completion/read ordering, summary/progress, stale activity and truncated
  SSE cases. Dart package source version is now 0.1.1, unpublished.
- IMPORTANT: web hosts still use the already-qualified ed8c1c26017f candidate.
  Its JS build is unchanged, but its bundled Dart client predates these changes.
  Refresh packaged candidate/provenance once native adoption is qualified; do not
  claim the existing web archive contains Dart 0.1.1. No mobile repo files changed
  yet and no production deployment, commit, push, PR, or publication occurred.
- Next concrete mobile work: provide shared canonical load/sync/reconnect
  orchestration and adapt each host's authenticated HTTP transport, then wire the
  SDK repository/mode selector into existing screens. Mills wiring is in
  lib/fixtures/fixture_mode.dart and lib/app/router.dart; credentials/CSRF reside
  in lib/api/primary_api_transport.dart and api/src boundary implementations.
  Spartan wiring is lib/main.dart and lib/src/aegis; JsonApiTransport owns auth.
  Review those transport seams before exposing protectedHeaders or SSE adapters.
  Business tools, approvals, attachment/domain views and supported voice behavior
  must remain available; a separate bare text chat is not parity.

### Shared Dart canonical recovery controller

- Added lib/src/session.dart, exported through the Dart library part. It parses
  immutable canonical snapshots, rejects foreign/replay-error/invalid active-turn
  evidence, exposes transcript and runtime state, serializes refreshes, polls
  incremental changes, and reloads through the server reducer when required.
- HandrailConversationSession resumes existing server work and reuses observation
  checkpoints without calling startTurn or appending user mutations. It renders
  canonical text, avoiding duplicate SSE replay text after snapshot load. Transient
  initial failures keep polling; synchronization failure preserves last known run
  state. Disposal ignores late HTTP results. Read acknowledgements and server
  cancellation are explicit; requested cancellation does not falsely mark idle.
- The stream client now uses HTTP AbortableRequest and a request cancellation race
  so observation disposal cannot hang waiting for response headers. It closes only
  that subscription/request, not the shared client or server run. An initial test
  found the cancellation exception escaped subscription.cancel; treating expected
  request abortion as cancelled observer cleanup fixed it. The dependency floor
  is http ^1.6.0 / Dart >=3.4.0; offline pub get succeeded.
- Evidence: 18 Dart tests passed (7 session/recovery + 11 existing/state tests).
  Scoped Dart analysis of lib/test passed. HTTP fakes use shapes checked against
  actual TypeScript gateway/catalog/sync contracts; no live native/host evidence.
- Mobile authentication inspection: Mills keeps native cookies/CSRF inside
  PrimaryApiTransport; its PrimaryApiHttpBoundary currently only buffers responses.
  Existing raw SDP method shows how authenticated raw requests are encapsulated.
  Spartan JsonApiTransport delegates to _SessionJsonApiTransport, which attaches
  its secure session store and captures response cookies; its HTTP adapter uses
  package:http. Add scoped SDK HTTP bridges preserving those protections, rather
  than exporting cookies into UI state or using an unauthenticated parallel client.
- Next unfinished point: implement shared new-turn admission/send orchestration
  (message.created + turn.started through append_mutations before gateway start),
  then native authenticated HTTP bridges, SDK repositories and accessible mode
  switching while preserving domain approvals/attachments/voice views. The mobile
  repos remain unchanged so far. Refresh the packaged Dart candidate after host
  qualification; web vendored ed8c1c26017f still contains the older Dart client.
- Goal remains active; this turn made concrete source/test progress. No deployment,
  publication, commit, push, PR, or project configuration change was performed.


### Shared Dart send admission qualified against the TypeScript gateway

- Added immutable, serializable `HandrailTurnSubmission` and session
  `prepareTurn`/`submitTurn`. Preparation refreshes canonical state and refuses a
  busy thread. Submission atomically appends the user message, staged attachment
  references and turn admission before calling start with stable mutation,
  message, turn and idempotency IDs. Identical overlapping submissions share one
  future; a different simultaneous submission is refused. Hosts persist the
  submission in account-scoped storage before sending and restore it for uncertain
  retries. SDK source does not yet supply native secure-storage adapters.
- Admission acknowledgements are checked before starting. The server verifies
  repeated mutation content, and completed canonical turns are never restarted
  by the retry path. Send errors are separate from canonical run state. Disposing
  a session cancels only observation; pending start acknowledgement is settled.
- Added test/fixtures/gateway.mjs inside the Dart package: an actual Node HTTP
  server using the built high-level SDK gateway, canonical synchronization,
  durable turn writer, event store, activity store and bounded provider transport.
  Only provider responses/persistence are simulated. No credentials, domain
  mutations, external provider calls or billable usage are used in this fixture.
- Six cross-language tests passed: atomic admission and duplicate submit/reload;
  independent concurrent threads finishing unread while disconnected with a read
  acknowledgement surviving reload; staged document reference admission; lost
  admission response; lost start response; and changed-content retry rejection.
  The loss tests recreate the Dart session from serialized submission data and
  verify one provider invocation and one saved user message. Attachment fixture
  IDs were corrected to the real att_/ref_ protocol grammar after validation
  properly rejected arbitrary IDs.
- Native app integration is the next unfinished point. Neither mobile repository
  was edited this turn. Web vendored candidate ed8c1c26017f still predates Dart
  0.1.1; refresh candidate/provenance after mobile qualification. Existing web
  automatic-approval changes and unrelated concurrent attachment work preserved.
- Full goal remains active: mobile modes, required-approval continuation, supported
  voice/transcription telemetry, migration compatibility and live protected host
  qualification are still material work. No commit/push/PR/release/deploy occurred.
- Final validation for this increment: `dart analyze lib test` passed with no
  issues; all 24 Dart tests passed sequentially (six actual-gateway, seven session,
  eleven client/state). `git diff --check` passed. The gateway fixture uses the
  existing previously qualified JS build; this increment changes Dart production
  source only, so no unrelated full host suite or SDK rebuild was run.


### Native authenticated SDK transport adoption

- Added shared `HandrailProtectedHttpClient` to the Dart SDK. It validates the
  configured gateway URL/path before asking the host for credentials, disables
  redirects, preserves AbortableRequest identity, and lets the host capture
  response session headers before returning a streaming body. The default browser
  delegate uses browser-managed credentials. Closing during authorization prevents
  a later send; failed response capture cancels the response stream.
- Both mobile repositories now vendor the exact 0.1.1 Dart candidate (nine files)
  with SHA256 provenance and local path dependency/lockfile entries. Offline
  dependency resolution succeeded in both. Byte comparison against SDK source
  passed. These sources are unpublished; web ed8c1c26017f archives still contain
  the older Dart source and have not been rewritten under the same hash name.
- Mills PrimaryApiTransport.createAssistantClient targets the existing configured
  /api/v1/assistant/handrail-ai endpoint and keeps session/CSRF cookies inside the
  primary transport. It captures coalesced rotated cookies without splitting an
  Expires date comma. Browser cookie ownership remains unchanged. Clearing or
  importing a native session invalidates old SDK clients and ignores their late
  response cookies.
- Spartan JsonApiTransport.createAssistantClient targets the configured-prefix
  /api/aegis/handrail-ai endpoint using only its internal session store. It retains
  existing 401 cleanup/authenticationRequired notification. Clearing internal
  session or receiving 401 invalidates old SDK clients; late responses cannot
  reinsert cookies after logout. Portal transport remains separate.
- Three Mills and two Spartan new focused tests passed with actual app transports
  and fake HTTP/secure storage. Scoped Flutter analysis of both touched transports
  and their tests passed after fixing two formatting/null-aware lint findings.
  SDK analysis passed; all 27 Dart tests passed (three protected HTTP, six actual
  gateway, seven session, eleven client/state). Diff whitespace checks passed in
  all three repositories. Expensive checks ran sequentially.
- This turn preserves the unrelated concurrent Spartan attachment work in
  lib/main.dart, API origin getter, attachment screens, pubspec/lock additions,
  and attachments modules/tests. It did not edit those business feature files.
- Next concrete work: mobile SDK repositories/presentation and accessible dual
  mode selection, plus account-scoped pending-submission storage. Mills existing
  AssistantRepository is in lib/repositories/read_repositories.dart; the rich
  AssistantScreen uses local _sending and must subscribe to shared authoritative
  state in SDK mode. Preserve domain proposal, attachment and voice views. Shared
  SDK state/recovery/admission must remain central instead of app-owned polling.
  Spartan composition remains lib/main.dart and lib/src/aegis. Neither new client
  factory is connected to an SDK screen yet; no usable native SDK mode claimed.
- Added docs/assistant-sdk-qualification.md to each mobile repo with current
  transport scope, dependency provenance and unfinished wiring. No production
  configuration, deployment, publication, commit, push or PR performed. Goal is
  active and this turn made concrete progress; no blocked condition occurred.
- Existing transport regression suites also passed: 27 Mills primary API tests
  and 30 Spartan API transport tests, including existing session isolation,
  cancellation, raw realtime SDP, secure storage, 401 and cookie parsing behavior.
  These were scoped to the shared authentication files changed this turn; no
  unrelated app-wide test suite was run.


### Pending-send journal and first Mills SDK conversation repository

- Added HandrailPendingTurnStore and a callback-based encrypted key-value adapter
  to the shared Dart SDK. Account namespace includes the host/API realm; native
  callers must also include user and household/company. The adapter serializes
  writes across instances in one Dart isolate, refuses pending intent replacement,
  and checks the whole submission before deletion so late acknowledgements cannot
  erase newer work. Multiple processes/isolates require an atomic database store.
- Session.sendMessage now retains intent before admission/start and removes it
  after acknowledgement; retryPendingMessage restores the saved intent. Tests
  prove account isolation, concurrent adapter serialization and late-ack behavior.
  The actual SDK HTTP gateway test proves storage failure produces no admission
  or start, and a lost start acknowledgement recovers once from the journal.
- Added SdkAssistantRepository as a part of Mills live_assistant_repository.dart
  so it reuses the existing strict domain decoders and domain failure mapping.
  SDK sessions own synchronization, running state, observation and cancellation;
  the repository fetches each selected /conversations/:id domain projection for
  existing proposal/attachment/citation presentation. Legacy getConversation
  still intentionally reads its existing single latest-conversation endpoint.
- The new repository loads catalog pages, keeps independent sessions/workspace
  state, restores saved starts, targets selected-thread cancellation/deletion,
  and delegates existing attachment reads, proposal decisions and transcription.
  Unknown SDK catalog message counts and retention expiry remain null instead of
  inventing values; legacy decoders still supply their required known values.
- A focused Mills repository test verifies multiple catalog pages, selected
  domain identity, two running conversations, cancellation staying running until
  server confirmation, and deletion of only the selected thread. It also verifies
  loading/recovery never invokes start without retained pending intent.
- This is unfinished integration, not owner-ready native SDK mode: the repository
  is not connected to AssistantScreen yet, its full send/attachment path still
  needs host qualification, and native secure-storage callbacks/mode persistence
  are not composed yet. Existing AssistantScreen local _sending must incorporate
  SDK changes; Stop must work after reload without requiring an optimistic send.
  Preserve the current rich screen and share its domain widgets across modes.
- Next concrete work: add the Mills screen subscription and legacy/SDK mode
  wrapper in /assistant routing, persist mode and pending data by authenticated
  API/user/household scope, add thread selection and a single activity summary,
  and route finalized attachment sends through SDK admission instead of legacy
  execution in SDK mode. Then implement/qualify Spartan repository/screen wiring.
  Mills attachment references must be att_<uuid>/ref_<same uuid> (gateway schema
  verified); keep upload authorization and finalization in the existing plugin.
- No commit/push/PR/deployment/publication/project configuration change occurred.
  Goal remains active; this turn made source/test progress, with no blocker.
- Final evidence for this increment: all 30 shared Dart tests passed, including
  seven actual-gateway tests and two pending-store tests. Mills SDK repository
  test plus 40 existing legacy repository tests passed (41 total). SDK analysis
  and final scoped Mills analysis passed; whitespace checks passed. Both mobile
  vendored candidates now contain ten matching source/doc/manifest files with
  updated provenance. SDK base HEAD remains 7527d886f67fb970dc58a42e9c001cd6a8d389ec.


### Mills mobile selectable SDK mode and authoritative screen state

- Added AssistantModeScreen to authenticated /assistant routing. Default remains
  legacy; Try SDK / Use legacy switch the same rich AssistantScreen between
  repositories. API/household/user-scoped FlutterSecureStorage retains the mode
  and backs the shared pending journal. Same-account session replacement rebuilds
  the protected client while preserving mode; account changes restore that
  account's own preference. Failed preference saves report that the change is
  only retained for the current visit.
- AssistantScreen now subscribes to SDK repository changes and computes running
  from local admission plus server state. A widget test caught the remaining
  legacy Stop visibility condition requiring an optimistic send; SDK Stop now
  appears for a server-active turn after reload. Server cancellation requests do
  not optimistically mark the run idle. Navigation/mode/thread changes cancel
  only the local wait and SDK observations; durable server work remains owned by
  the server. Independent sessions remain available through Conversations.
- SDK activity has one summary/count with collapsed tool-name details and a host
  showActivityDetails switch. Terminal status replaces stale running summaries.
  SDK rendering uses saved domain messages instead of briefly duplicating them
  through legacy optimistic-success insertion. Legacy presentation remains.
- Finalized attachment sends in SDK mode now call SdkAssistantRepository's shared
  admission path, translating the validated UUID to att_/ref_ wire identities.
  Existing upload/finalization, citation/proposal rendering, authorized proposal
  decisions, transcription and realtime voice factories remain application-owned.
  Matching retained text/attachment intent resumes the saved submission; changed
  intent cannot overwrite it. Full mounted-host attachment/send qualification is
  still required; existing voice integrations are not new SDK telemetry proof.
- Validation: two SDK widget tests passed for mode persistence/switch-back and
  reload-running/Stop/canonical completion; the activity expansion assertion was
  added to the latter. All 68 assistant screen tests passed, including existing
  attachments, proposals, voice, navigation and role/auth behavior. Production
  scoped analysis passed; test import ordering was corrected for final analysis.
- Owner steps are now in Mills mobile docs/assistant-sdk-qualification.md. Source
  mode is selectable but no deployment or real device/provider run was performed.
  Spartan mobile still has only its authenticated client factory and vendored SDK;
  its repository/controller/screen composition is the next integration priority.
- Before final cancellation sign-off, reproduce the admission-to-durable-start
  cancellation race: the shared TypeScript admission qualifier validates message
  identity but currently lacks an explicit terminal-turn-state rejection. SDK
  retry checks terminal state, but another client may cancel between checks.
  This audit is still open; do not claim complete cancellation parity yet.
- Full goal remains active with required-approval continuation, voice/transcription
  telemetry, migration compatibility and live protected host evidence still open.
  No commit, push, PR, publication, deployment or project config change occurred.
- Final scoped analysis of the Mills route, mode wrapper, screen, repositories
  and screen tests passed with no issues. The two focused SDK widget tests passed
  again after adding explicit collapsed/expanded activity checks. The full screen
  suite's 68 passing tests remain the legacy-regression evidence for this change.
  Documentation and both native candidate README hashes were synchronized; no
  package release or web hash-named archive rewrite was performed.


### Spartan mobile selectable SDK mode and shared attachment MIME correction

- Continued from the saved Mills milestone; no restart, commit, push or deployment.
  Spartan main -> authenticated application shell -> Ask Aegis now supplies the
  protected SDK factory and principal scope. AegisModeScreen defaults to legacy,
  persists Try SDK / Use legacy with secure storage, and reuses the existing
  domain screen. Account namespace includes gateway URI and principal; no new
  company-switching contract was invented.
- AegisSdkRepository delegates domain reads, lifecycle, titles, actions and file
  downloads to the existing repository. Shared sessions own canonical recovery,
  admission/start, cancellation and activity. File staging uses SDK upload followed
  by the retained exact admission/start request. New sends cannot replace a
  pending journal; reload retries the original IDs.
- SDK controller accepts canonical domain projections while work runs and permits
  thread navigation/new threads independently. Late completion cannot change the
  selected thread or its draft. Caught and tested a delayed domain projection race:
  responses must match both navigation generation and selected thread identity.
- Default SDK screen has a single activity summary/count, collapsed safe tool-name
  details, optional hidden details, authoritative Stop, and Running/Unread thread
  labels. Legacy controller/screen paths and domain action/attachment views remain.
  Title generation retains its existing non-blocking domain endpoint.
- Closing the wrapper starts disposal of every SDK session immediately, stopping
  all timers before awaiting stream cleanup. Widget qualification caught timers
  otherwise remaining alive behind asynchronous observer cancellation. Closing
  observers or switching modes never requests server cancellation.
- Found the Dart upload client did not set the MIME type on the multipart file
  part. It now sends the caller's media type, which Spartan validates. Both native
  source vendors/provenance were refreshed and byte-verified (10 files each).
  Shared Dart analysis/all 31 tests passed, including seven actual SDK gateway
  tests with simulated provider and a new file-part MIME regression assertion.
- Five new repository tests pass. Three SDK controller/widget tests cover thread
  navigation while running, restored Stop, optional tool details and mode/account
  persistence. Eight existing controller and seventeen existing screen tests pass.
  Initial SDK widget cleanup stalled under the simulated clock; explicit async
  teardown plus immediate production timer stopping resolved it.
- Owner steps and limitations are in Spartan mobile docs/assistant-sdk-qualification.md.
  No protected deployed host/device/provider/telemetry evidence claimed. Thread
  creation retries retain their key only in the current adapter; uncertain creates
  across process recreation remain unqualified. Staged unsent uploads expire on
  the server. Required human-approval continuation, voice/STT telemetry, canonical
  admission/start cancellation and migration compatibility remain open full-goal
  work. The web packed candidate still contains the older bundled Flutter source;
  refresh its immutable filename/provenance before any coordinated release.

Final validation for the Spartan mobile continuation: scoped analysis of all eight
changed integration/test entrypoints passed. The final repository + SDK screen
batch passed all eight tests, including collapsed/expanded/hidden details and
absence of private tool arguments. Existing controller (8) and screen (17) checks
passed, plus shared Dart checks (31), for 64 distinct targeted tests. Both mobile
vendors' ten files were byte-compared to the SDK and their SHA-256 provenance
verified. Diff whitespace checks passed. Goal remains active; no live/runtime,
voice/billing, required-approval continuation or release qualification claimed.


### Canonical cancellation before delayed execution

- Previous goal turn made source and test progress; this turn continued the saved
  cancellation audit. Reproduced provider execution after a canonical cancelled
  turn through a real shared durable worker and in-memory canonical event store.
- Added exported guardCanonicalTurnExecution inside the execution boundary. It
  requires the matching canonical active turn, valid replay, running eligibility
  and no canonical cancellation request. Canonical terminal turns cannot execute.
  The outer durable transport still replays existing completed records; replay
  does not invoke the guarded provider delegate. Replay stores are disposed.
- Shared generic qualifier uses the guard. Both standalone host durable transports
  install it around their delegate; both mounted high-level hosts inherit it from
  the SDK. A Mills regression now cancels before a durable row exists, then sends
  a delayed start and verifies zero provider calls. Spartan's mounted SQL gateway
  case admits and canonically cancels first, then verifies no provider/domain
  mutation or telemetry call and retained canonical cancellation.
- SDK typecheck/build and scoped lint passed. Five new cases cover canonical
  cancelled/completed/failed/requested cancellation and completed result replay.
  These plus durable (9) and high-level assistant (5) tests pass (19 total).
  Mills gateway file passes 13 tests. Spartan mounted required/automatic,
  interrupted-auto and cancelled-before-start cases pass four tests.
- Inspected authoritative workspace SDK version 0.2.6 and base HEAD
  0e738cea0af426ea87a8c83f981cca0f01d37831. This thread did not create that commit.
  Built/packed a new immutable candidate and updated both web manifests, lockfiles
  and provenance. Current artifact: handrail-ai-assistant-0.2.6-parity.792d8d1852f5.tgz;
  SHA-256 792d8d1852f5192a9196a4dd5c1bbaf7727881c61796ac5fda89551af183c47a.
  Source tree SHA-256 6eb2e8fe57bda1412bc1ae278aa057a597d0553caa80f5cb2c40159a9ade6628.
  Includes current Flutter 0.1.1 and MIME correction; previous archive retained.
  Both installed packages were byte-compared with the extracted archive; dependency
  and peer contracts match the earlier candidate. No release/deploy/commit/push.
- The first adoption script hit the system Python's older tar API and then npm's
  bin-path normalization difference; both were corrected before adoption completed.
  An initial host check against the old installed SDK consequently failed on its
  missing export; the complete gateway suite passed after candidate installation.
- Remaining cancellation audit: durable run() reads cancellation/lease from its
  claim before awaiting requestCodec.decode(). Cancellation or lease takeover
  during a slow decode may require a fresh fenced check before invoking the
  delegate. This is not yet qualified. Full live runtime, voice/STT billing,
  required-human-approval continuation and migrations remain open goal work.

Final checks for this continuation: both host qualification TypeScript projects
and scoped host lint passed. Spartan's test initially used an unbranded numeric
expected revision; it now reads the authoritative typed revision from its event
store, and the cancelled-before-start mounted case passed again. The shared Dart
actual-HTTP-gateway batch passed all seven tests against the rebuilt JS gateway.
Total distinct targeted tests this turn: 43 (SDK TS 19, Mills 13, Spartan 4, Dart 7).
Both installed guard exports resolve; both archive SHA-256 and npm SHA-512 match;
current SDK src still matches the recorded candidate source-tree hash. Diff checks
passed. Fresh full-host npm-ci runs previously qualified the older candidate;
this turn verified unchanged dependency contracts and archive installation bytes,
not a new full-host clean-install run. Goal remains active and full completion
unproven. Next concrete work is cancellation/lease changes during request decode.


### Cancellable request preparation and lease ownership

- Previous turn made verified progress. Continued by reproducing two provider
  calls that should not happen: cancellation during requestCodec.decode(), and
  an old decoder returning after another worker took its expired lease.
- Durable transport now renews/revalidates its current attempt with CAS after
  decoding, before invoking the provider delegate. A cancelled, terminal or
  replaced attempt cannot dispatch. Retained durable replay is unchanged.
- Strengthened the cancellation test by leaving the decoder blocked. It exposed
  that merely checking after decode leaves Stop stuck running. Preparation now
  monitors cancellation/ownership, renews its lease, aborts its local wait and
  settles cancellation without needing that lookup to return. Decoders receive
  an optional second { signal } argument to clean up host input reads. Timers are
  cleared on every preparation exit. Old one-argument callbacks remain compatible.
- Four new cases cover blocked cancellation/abort signal, lease takeover, renewal
  during a pending lookup and renewal after a slow lookup. Existing active-provider
  cancellation now waits explicitly for the provider to start, avoiding an admission
  race in that older test. All 23 SDK TS tests passed: durable 13, canonical guard 5,
  and high-level assistant 5. SDK typecheck and scoped lint passed.
- Rebuilt/repacked SDK 0.2.6 and installed the same immutable candidate in both web
  hosts. Artifact: handrail-ai-assistant-0.2.6-parity.a26eb1ef6f48.tgz; SHA-256 a26eb1ef6f48c21497144719aa5d95f10a2fbfad2e19c5b4197bed740529925f.
  Source-tree SHA-256 3252ed13ce266cea682efe9cb1f2fcf759417e2f141f4d960470d4d72875d270.
  Both installed packages were byte-compared to the archive; dependency and peer
  contracts remain unchanged. No persisted-record schema change; coordinated
  worker replacement remains necessary for behavioral guarantees.
- Preliminary next audit: SDK src/providers/openai-transcription.ts and
  openai-realtime.ts have no usage/receipt hooks. Mills routes.ts already wraps
  transcription in app usage admission/settlement and its provider accepts
  recordUsage, so inspect actual reported units and persistence before replacing
  that host path. Do not infer billing parity from the existing adapter APIs.
  Shared high-level Stop before any durable turn row also needs direct HTTP
  qualification; prior orphan-stop evidence was the Mills standalone transport.
  Recovery after provider dispatch/lease loss, voice/STT billing, required approval
  continuation and migration/live-host qualification remain open goal work.

Final checks for the preparation continuation: both host scoped TypeScript
projects pass against a26eb1ef6f48. Mills stopped-before-start/second-worker cancel
cases pass (2); Spartan cancelled-before-start/cancel-and-resume cases pass (2).
All seven Dart actual-HTTP-gateway tests pass against the rebuilt SDK. Combined
with the 23 SDK TS tests, this turn passed 34 distinct targeted tests. SDK package
typecheck/build and scoped lint passed; both host archive/lock integrity hashes
and the current SDK source-tree hash were verified. The persisted schema and
legacy/SDK selectors are unchanged. No commit, push, PR, publication or deployment
was performed by this turn. Full goal completion remains unproven; next priority
is authoritative supported voice/transcription usage capture and host adoption,
with high-level pre-durable cancellation and post-dispatch recovery still listed
for qualification rather than silently treated as proven.


## Transcription response compatibility and voice billing audit

The OpenAI adapter previously requested `verbose_json` for every model and
required `language` plus `duration` even for JSON-only transcription models.
It now requests `json`, accepts text-only responses, projects one detected
language when present, and leaves multilingual/undetected language null. BCP 47
hints use a two-letter primary subtag when available. Missing provider duration
uses the trusted resolver's validated media duration for display only, never as
reported billing usage. Explicit malformed metadata still fails safely.

Provider contract was checked against the official [transcription reference](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
and [audio usage schema](https://developers.openai.com/api/reference/resources/audio).
The reference confirms `gpt-transcribe` is a supported model, so Mills' default
was retained. This is a response-contract fix, not live provider qualification.

Remaining concrete voice findings:

- SDK transcription and realtime adapters currently have no usage capture hook.
  Realtime `response.done` processing strips usage from the normalized event.
- The normalized receipt contract currently represents token totals/cache/
  reasoning plus provider cost; it has no duration or audio/text modality units.
  Confirm the Handrail ingestion/pricing contract before adding unsupported
  wire fields or claiming duration/audio pricing correctness.
- Mills `/transcriptions` delegates its existing provider and calls
  `beginMillsAIRuntimeUsage`. That helper buffers receipts in memory; its client
  retries HTTP three times, and route settlement logs exhausted delivery errors.
  It does not use the SDK's persistent outbox. Connect auxiliary operations
  (including transcription/title generation) to durable delivery and qualify
  restart/retry identity. The SDK chat path already uses the persistent outbox.
- Mills `responseUsage` reads token totals but drops transcription duration and
  modality detail. Full voice billing remains unfinished.
- SDK `json` changes alone do not replace Mills' existing transcription provider
  or add a voice feature to Spartan. Both existing and SDK app modes remain.

Next work remains durable auxiliary/voice capture, provider usage units and
Handrail compatibility, followed by the earlier approval, recovery and protected
runtime qualifications. No publish, deployment, commit, push or PR occurred.

Validation for the JSON compatibility patch: 42 provider adapter tests, 16 shared
transcription contract tests and 12 React transcription tests passed (70 total).
SDK package typecheck, scoped source/test lint and pack-time compile passed.
Both host archives/locks and every installed SDK file were verified against
`handrail-ai-assistant-0.2.6-parity.1bd8a9d200a3.tgz` (SHA-256
`1bd8a9d200a38c57b35873087795850ec7c7cae981b1287f97d6e6c056bb978c`).
No live provider calls were made.

Both web host scoped TypeScript qualifications passed against this candidate.


## Mills auxiliary durable delivery

Closed the HTTP-only auxiliary delivery gap identified above. Mills server
composition now supplies the existing SDK Postgres outbox and receipt sink for
transcription, title generation and legacy chat in both UI modes when telemetry
is configured. It recovers pending SQL receipts on startup and every 30 seconds,
and stops/flushes before database shutdown. Migration 0096 already provides the
required documents table; no new schema was added or deployed.

Six host client tests and one actual PGlite SQL test passed, including offline
retention, fresh-client recovery, lost acknowledgement, stable billing identity,
retained delivered receipt replay, immutable contents and environment isolation.
The receiver deduplication was simulated, not a live Handrail charge proof.
Host scoped typecheck and lint passed. SDK archive unchanged: this host change
uses the already-pinned SDK outbox APIs.

Still unfinished: audio-duration/modality receipt contract and pricing support,
SDK voice capture hooks, live Handrail delivery, and the earlier approval,
recovery and protected-runtime qualifications. Auxiliary receipt collection
before settlement still needs crash/reconciliation coverage. Do not interpret
successful delivery of existing token/unavailable receipts as full voice billing.


## Atomic cancellation before durable start

The high-level assistant now verifies canonical admission when Stop finds no
worker row, then reserves a terminal cancellation through the same atomic durable
store `create` used by turn start. If cancellation wins, a delayed start replays
cancelled without decoding or calling the provider. If start wins, ordinary
cancellation records the request and the existing worker owns settlement. Unknown
turns still return not_found and cannot reserve cancellations. Canonical terminal
projection and activity use the existing reconciliation path.

The generic durable transport exposes trusted `cancelTurnBeforeStart`; callers
must authorize and verify canonical admission before using it. Cancel reservations
retain `cancelledBeforeStart: true`, `request: null`, terminal cancelled status,
and cancellation identity in the existing V1 JSON document. No SQL schema changes
are needed. Normal codecs can still store null themselves. Older workers skip
these terminal rows, but an old start client can receive a conflict instead of
cancelled replay: use the same qualified SDK candidate on all workers for the
polished response. Do not remove cancellation records while starts can be retried.

SDK qualification: 26 tests passed across durable/canonical-start/high-level
assistant suites. The new HTTP test proves Stop without a worker row settles
canonical state, delayed start has provider calls=0, unknown turns remain unknown,
and repeated Stop does not append another terminal event. A competing normal start
uses ordinary cancellation while its decoder is pending. Package typecheck and
scoped lint passed. Test-only observation consumers were corrected to drain their
event streams before awaiting terminal results after initial timeout failures.

The older standalone Mills gateway still has a host-owned orphan-cancellation
fallback. Its creation race needs the same atomic reservation contract; current
production SDK composition uses the high-level assistant fixed above. Do not
claim every independently constructed legacy gateway is qualified by these tests.

Additional cancellation validation: the mounted Spartan HTTP test now sends Stop
instead of manually writing a cancelled canonical event, and passed against SQL
with zero provider/tools/telemetry calls. Reconciliation now preserves the durable
user cancellation reason when the browser never wrote its request event; the
HTTP test asserts both requested and final reason are user. All 14 reconciliation
tests plus the eight canonical-start tests passed; the unique SDK total for this
change is 40 tests.

Final cancellation candidate is `handrail-ai-assistant-0.2.6-parity.9dc64dd6b84d.tgz`
(SHA-256 `9dc64dd6b84d63df6e895def7580cb0f0b4049578190a37f05f43995b47f3a92`).
Both web hosts pin it with matching archive integrity and installed bytes.
Both host scoped compilations passed after the API change; final reason-preserving
reconciliation has identical public declarations and passed SDK compile/lint.
The shared Dart client passed all seven actual SDK HTTP gateway tests against
the rebuilt JS. Unique qualification total: 40 SDK TS tests, seven shared Dart
HTTP tests, and one mounted Spartan SQL/HTTP test (48). No live provider or
production execution was performed.


## Mills standalone cancellation gap closed

The previously noted standalone Mills orphan fallback now uses the shared SDK
atomic cancellation reservation. It only writes canonical cancelled after
confirming the durable outcome is cancelled; a competing live start receives
ordinary cancellation_requested and remains running until settlement. Repeating
Stop also repairs the transcript after cancellation was saved but canonical CAS
retries were exhausted.

Five targeted host gateway cases passed, including both creation orders and a
start between durable reservation and canonical publication. The live-provider
race waits for the abort signal, then proves the transcript remains nonterminal
until the provider settles. Three simulated transcript conflicts followed by
retry repair canonical state without provider execution. Host scoped compilation
and lint passed; no SDK artifact changes or deployments were needed.

Remaining goal priorities are still voice usage/Handrail pricing and live delivery,
required approval continuation, recovery after dispatched side effects, protected
host/device qualification, and final migration/clean-install readiness evidence.


## Shared approval UI navigation and polling

The default SDK approval panel now unmounts its conversation-specific state when
the selected conversation changes. A delayed read or confirmation from the old
conversation cannot replace the current conversation's cards or error state.
Changing the resource client also clears the old boundary's approval state.
Within one mounted boundary, reads are serialized and a queued refresh runs once
the outstanding read settles. Confirm/reject decisions invalidate older reads,
so an old pending snapshot cannot restore a successfully decided card.

Six new React tests cover late read success/failure, late decision success/failure,
serialized slow polling and duplicate clicks, stale pending snapshots after
confirmation, resource replacement, and cleanup. The existing standard
confirmation test also passes. This change affects the shared default web UI;
custom/native host approval presentation is unchanged.

Required human approval continuation remains a material open item. Inspection
confirmed that both mounted custom-provider integrations currently return a
pending proposal to the model immediately. Spartan publishes its approval shadow
after the provider returns, and its 90-second provider deadline currently includes
tool execution. Mills saves proposal rows during completeMessage. Correct waiting
therefore requires publishing proposals before waiting, observing the existing
domain executor's retained result without executing it twice, explicit bounded
waiting/cancellation, and accounting for human wait time in provider deadlines.
Do not claim the UI correction implements that server continuation.

Both web hosts now pin `handrail-ai-assistant-0.2.6-parity.06b3d70fb37a.tgz` (SHA-256
`06b3d70fb37a081fc6ef01d06800cdfc07e52362aa8ab2e5295f81d73cbc7268`), with matching lock integrity and installed files. SDK package
typecheck, scoped lint, and build passed. All public declarations are byte-identical
to the preceding candidate; no host TypeScript source changed in this patch.
Fresh clean-install and live browser evidence remain pending.


## Required approval continuation: shared waiting and Spartan adoption

The SDK exports waitForApplicationApproval and toolActivity.waitForApproval for
host-owned proposals. They observe authoritative pending/settled state, serialize
reads, bound the observation to the persisted expiry (and at most fifteen minutes),
and abort slow reads/activity writes on cancellation or expiry. They never create,
approve, execute, or retry a domain mutation. The observer publishes one waiting
summary and one settlement summary; the enclosing tool remains active until its
result is recorded. No schema migration is required for this added API.

Spartan SDK required mode publishes saved approval rows while the provider is still
active, observes the existing confirmation endpoint's saved result, and returns
applied=true/succeeded before allowing dependent tools. Rejection, failure, Stop,
or expiry interrupts the sequence. On interrupted observation, only an unclaimed
pending proposal is cancelled; an executing action retains its own settlement.
The wait uses the persisted proposal creation time plus fifteen minutes. Spartan's
provider deadline excludes this separately bounded human wait and resumes its
remaining active-time budget afterward. Automatic SDK mode and legacy immediate
proposal behavior are preserved. Native Spartan now enables action decisions
during SDK runs while retaining disabled composition and one decision at a time.

Qualification: eight new SDK wait cases plus three retained observer cases; two
provider deadline cases; mounted SQL/HTTP confirmation, rejection, Stop, three
automatic/cancellation cases, and a legacy proposal case (seven host cases); five
native SDK screen/controller cases and eight existing legacy controller cases.
No live provider or protected browser/device was used. Shared wait tests prove
expiry; host expiry/restart/crash recovery still needs direct qualification.
Mills required continuation still needs proposal staging before completeMessage.
The custom web hosts' approval hooks still duplicate polling state and need the
shared navigation/decision protections used by the default SDK panel.

Final approval-wait candidate: `handrail-ai-assistant-0.2.6-parity.514dcfe1e4ab.tgz`
(SHA-256 `514dcfe1e4ab91126bab56b3c6d996b36a927719a51ce71806400269b0d49518`). Both web manifests, lockfiles, provenance and installed
bytes match; final public declarations match the Spartan-compiled candidate.
SDK package typecheck, lint and build passed. The final observer also bounds
activity persistence inside the approval deadline, covered by a hung-write test.

Final qualification for this continuation: 47 unique tests passed (11 SDK wait/
observer, all 16 Spartan provider continuation cases, seven mounted/legacy host
cases, and 13 native SDK/legacy controller cases). SDK and both web host scoped
compilation, touched-source lint, and native scoped analysis passed. Host deadline
changes were checked against the full scoped provider continuation file because
that deadline also governs provider retries and ordinary continuations.


## Mills early proposal persistence

The PostgreSQL assistant store now implements stageToolProposal. It validates a
domain proposal, verifies the conversation owner, and saves an explicit immutable
proposal ID while the assistant message remains pending. Exact retries return the
same proposal, including its retained decision. Reusing the ID for another message
or arguments fails; new proposals cannot be staged after message completion.

completeMessage accepts ordered stagedProposalIds. It locks the same message used
by staging, verifies the complete identity/argument set, and preserves the saved
proposal rows rather than creating pending duplicates. Confirmed/rejected status
and expiry remain intact, and completion audit metadata reflects saved decisions.
Callers that do not pass stagedProposalIds retain the existing completion behavior.
This uses existing tables and does not require a schema migration.

Five new SQL cases cover early visibility, confirmed/rejected decisions, retries,
identity conflicts, owner isolation and mismatched final output. The four existing
SQL gateway cases also pass (nine unique tests). Scoped compilation and lint pass;
the qualification tsconfig now includes the edited SQL test file. The test fixture
uses the actual valid portal.unit.status field; its earlier abbreviated status
field was rejected by domain validation.

This is the persistence prerequisite for required approval continuation. The
Mills gateway does not yet call stageToolProposal or wait on confirmation. Both
confirmation routes currently execute using a caller idempotency key before
marking the proposal confirmed, and discard can race that execution. Next work
must coordinate one authoritative execution per proposal across the SDK and legacy
endpoints, persist/replay its outcome, handle rejection/cancellation races, then
wire staged IDs and the shared SDK wait into the provider loop. Browser/native
approval controls and result status must follow that shared execution contract.


## Mills proposal execution claims and compatibility

Migration 0098_assistant-proposal-execution expands the domain proposal constraint
to include executing and failed. The store now has claimToolProposalExecution and
settleToolProposalExecution. Claim locks the authorized owner's proposal, checks
role/reviewed version/expiry, and atomically changes proposed to executing.
Concurrent claims return one winner. Discard cannot change an executing proposal;
a discarded proposal cannot be claimed. Failed and confirmed outcomes are retained
and cannot be claimed for another execution. Settlement checks the executing
version and writes domain audit evidence.

These methods coordinate domain confirmation/discard; the existing SDK durable
tool ledger will own dispatch deduplication and retained results when the endpoints
are wired. SDK's full approval-execution coordinator requires canonical proposal/
confirmation events, which legacy Mills proposals do not currently carry. Avoid
fabricating that history to make legacy proposals pass its exact-audit checks.

Web and mobile contracts accept the new states and show Executing approved change
or Execution needs review instead of Expired. Mobile does not offer confirmation
for either state. The legacy/SDK UI selector is preserved. Migration must precede
activation of these claims, and all serving builds must understand the new status
values. The down migration refuses to drop support while executing/failed records
exist; review/reconciliation is required before downgrading the database contract.
No deployed database or project configuration was changed.

Evidence: three SQL cases cover competing claims, discard/claim ordering, terminal
failures, ownership, role, reviewed version and expiry. One additional SQL case
proves rollback is blocked without erasing the existing execution state. Two
mobile decoder cases accept executing/failed without enabling another decision.
Mills scoped compilation (now including AssistantPage) and touched-source lint
passed. Claims are not called by the confirmation endpoints yet, so this is still
a prerequisite rather than completed Mills approval continuation. Next: a shared
Mills server coordinator for both legacy and SDK confirm/discard endpoints, using
these claims plus the SDK tool ledger and a stable proposal-derived execution key;
then saved-result observation and staged-ID completion in the SDK provider path.

Final scoped Flutter analysis of the changed models, repository, screen and test passed with no issues.

## Mills required approval continuation and shared execution outcomes

Both Mills confirmation endpoints now claim the proposal before dispatch and use
one SDK ledger key derived from the proposal ID. The winning caller executes the
existing domain service; concurrent requests and later retries read its saved
result. Discard cannot win after execution is claimed. A lost acknowledgement can
repair the domain projection from the retained result. A failed or uncertain
execution requires review and is never dispatched again by confirmation. Older
already-confirmed proposals with no SDK receipt still return no execution result;
they are never executed merely to manufacture new evidence.

For new SDK turns with required approvals, Mills stages each immutable proposal
before waiting, publishes its approval activity/history, and uses the shared SDK
bounded observer to wait for the existing confirmation endpoint. Saved success
returns to the provider before dependent work. Rejection, expiry or Stop closes
only an unclaimed proposal; executing changes retain their outcome. Final message
persistence preserves the staged proposal IDs and decisions. Automatic SDK policy
and legacy automatic application remain available. Mobile already permits proposal
decisions during SDK runs; no mobile source changed in this continuation.

The SDK coordinator now preserves a host-returned executing/executed/failed record
instead of appending that execution outcome as another confirmation decision. This
avoids turning a saved failed outcome into a malformed decision-event error.

Both web repositories use `handrail-ai-assistant-0.2.6-parity.39b1edbba260.tgz`
(SHA-256 `39b1edbba260ae22c656fb3b11bf5d9a9bd4df27e0bc2b7f582c5f7e681b69c2`). Manifests, locks, provenance and installed archive files match.
This is a local candidate, not a publication or deployment. Hosts must run Mills
migration 0098 (and earlier SDK-table migration 0096) before activating the new
confirmation code. Old binaries do not understand executing/failed proposals;
changing the UI selector is distinct from downgrading the application/database.

Evidence: all 21 Mills SQL gateway cases pass, including four mounted high-level
confirm/reject/Stop/failed-action flows, one visible waiting summary, canonical
executed history, same-proposal completion, concurrent confirmation, lost ledger
acknowledgement and retained uncertain effects. Three legacy HTTP/domain tests
pass, including a staged change applied once and replayed with a different client
key, plus existing automatic/sensitive-profile behavior. All 11 mutation/provider
cases pass, including a required-confirmation result returned before subsequent
model/read rounds. SDK coordinator tests (13), SDK typecheck/build and Mills scoped
compilation pass. These providers and external failure conditions are controlled
fixtures; they do not prove live business validation, real provider behavior or
production billing.

Remaining qualification includes imported/older pending proposals that lack a
canonical proposal event, authoritative decision timestamps when confirmation
outlives observation/expiry, restart after external dispatch, stale running state,
voice/transcription billing units and durable capture, protected browser/device
flows, Spartan's custom approval polling hook, and a clean install of the final
artifact. Do not mark full parity or owner-ready completion from this milestone.

Final candidate validation for `39b1edbba260`: both scoped web compiles passed.
Spartan's six mounted required/automatic/cancellation cases passed against the
new archive. Mills touched-source lint and SDK coordinator lint passed. Current
SDK source hash, both archive hashes, and both package lock integrities were
rechecked after external workspace checkpoints and still match the qualification
record. No commit, push, PR, publication or deployment command was issued by this
agent. No expensive check remains running.

## Shared approval UI state and older proposal compatibility

`useConversationApprovals(resources, conversationId)` is now exported from the
SDK's React and React headless entry points. It owns serialized polling, queued
refresh, scope isolation across conversation/credential changes, synchronous
protection against duplicate decisions, stale-read invalidation after a decision,
and cleanup. It exposes `proposals`, `busy`, `error`, `decide` and `refresh` so hosts
can present their own cards. Unmounting stops observation; it does not cancel a
server action. The default SDK panel and Spartan's custom web panel both use it.
For example, a custom panel can call
`useConversationApprovals(client.resources, selectedConversationId)` and render
`proposals` in its own design; decisions call `decide(proposal, 'confirmed')` or
`decide(proposal, 'rejected')`. Authorization still runs on the server.

The high-level SDK can now decide older host-owned proposals that have no SDK
creation event, only when `approvalStoreFor` explicitly supplies an existing host
authority and that authority's `listGroup` proves proposal membership in the
requested authorized conversation. It delegates the decision to the existing
host store with server-derived actor attribution. It does not fabricate a tool
call or proposal event. SDK-owned proposals still require canonical creation.
The shared boundary preserves catalog permission/not-found errors, and Mills now
translates domain catalog errors into that SDK contract.

Spartan's selected conversation also remains usable when the server declares no
attachment capability. Previously its zero file-byte limit made the SDK composer
throw. It now omits attachment intake, upload controls and drop handlers when
attachments are unsupported; supported attachments retain their configured limits.

Evidence: six existing default-panel cases and five new headless cases pass,
including switching without remount, changed credentials, late decision/read
completion, duplicate clicks, and retained failed results. Two SDK HTTP cases
cover both decisions, older proposal membership, forged caller attribution and
forbidden callers. Seven rendered Spartan UI cases pass, including two new actual
selected-conversation tests with real SDK runtimes, late approvals and attachment
capability on/off. Six Mills SQL/HTTP cases pass: four ongoing required-approval
flows plus two older-proposal flows proving repeat decisions and wrong-user,
wrong-household and wrong-conversation rejection. No live provider/browser/device
or real billing claim follows from these fixtures.

Both web hosts use `handrail-ai-assistant-0.2.7-parity.ca2a24809621.tgz`
(SHA-256 `ca2a2480962120fd27f9e70cc49a359e8421b020d8146dcc3e4007b27dd602bc`), built from the repository's current 0.2.7 version. The version was
already present; this work does not publish a release. Archive bytes, manifests,
lock integrity and installed package files match. Earlier 0.2.6 and intermediate
0.2.7 artifacts remain as prior evidence. No schema change is introduced here.
The full goal remains active: interrupted execution/recovery and timestamps,
voice/transcription billing and durable capture, protected runtime qualification,
and a final clean install/owner handoff still require work.

Final validation for `ca2a24809621`: SDK typecheck/build and touched-source lint
passed; both host scoped compiles and touched-source lint passed. The final SDK
source hash is `32379eee82c065da6295eb72b770689d41bf7b7e680ed32228deb7ff47c906ef`.
Mills' six targeted SQL cases passed against this final archive. Spartan's seven
UI cases exercised the identical packaged hook before the final server-only error
mapping fix; its compile includes the final archive. No checks remain running.
No commit/push/PR, release publication or deployment command was issued.


## Immediate Mills usage capture before dependent work

Mills previously buffered provider receipts until the complete turn (or auxiliary
request) settled. With telemetry configured and the production SQL outbox
attached, `beginMillsAIRuntimeUsage().recordUsage()` now awaits the SDK outbox
write immediately. The SDK gateway likewise captures each receipt before the
provider result is validated or a dependent tool is executed. Chat rounds,
compaction, conversation titles, and recorded-audio transcription await the
callback. A failed capture stops processing; it does not trigger another provider
call or replace reported quantities with an unavailable receipt. Final settlement
can retry the same receipt identity, including after a lost acknowledgement.
Custom clients without an outbox retain their existing settlement-only behavior;
this does not add durability when telemetry is disabled or storage is absent.

The gateway also attempts host message failure finalization if its capture retry
fails, so a usage-storage failure alone does not skip clearing the running message.
This still depends on the host message store being available.

Evidence: seven usage-client/SQL tests passed, including SQL recovery without any
final settlement and duplicate delivery after a lost acknowledgement. Seven
selected provider cases passed, including waiting before tools execute and failure
of asynchronous capture for transcription, titles, and chat. Two gateway cases
passed for capture before response completion and host failure finalization after
two storage errors (16 targeted tests total). The scoped TypeScript compile
and lint of all seven touched source/test files passed.

These are local source and controlled SQL/transport checks. They do not prove live
Handrail acceptance, pricing, realtime audio usage, or production restart behavior.
No audio billing units or prices were invented. Both assistant modes and the
previous SDK candidate remain in place; no release or deployment was performed.


## Provider-reported audio evidence and capture callbacks

Added a shared OpenAI audio usage parser and optional trusted-server
`capture_usage` callbacks to the transcription and realtime adapters. Transcription
captures before output validation, including provider responses that arrive after
caller cancellation. Realtime captures response completion and input transcription
as separate operations, coalesces concurrent duplicates, rejects changed evidence,
and permits an identical retry after a failed storage write. Late final usage for
a still-tracked session is captured after hangup without reopening the session.

Evidence: 45 transcription tests, 10 parser tests, and 36 realtime tests passed
(91 total), with scoped lint, package typecheck and package build passing. Earlier
approval/UI changes remain in the SDK worktree.

The optional callback is an integration boundary, not proof of durable billing.
The two hosts still use the previous candidate; Mills' voice providers are not yet
connected to these hooks. Handrail audio/duration receipt and pricing contract,
durable evidence retention, host adoption and live usage delivery are still open.
See [audio usage integration contract](audio-usage-capture.md).


## Durable audio evidence in the existing SDK schema

Added `PostgresOpenAIAudioUsageEvidenceStore`, using a separate immutable document
kind in the existing SDK table. It validates normalized identity/attribution and
provider-reported audio usage, requires the configured service environment, and
provides bounded tenant/environment-scoped reads for reconciliation. It deliberately
does not enqueue a billing receipt or infer audio prices.

One real PGlite integration scenario passed: committed write with lost acknowledgement,
restart and identical retries, concurrent first captures, changed evidence/model
conflict, keyset reads, tenant/environment isolation and no billing outbox entry.
Scoped lint and package typecheck passed; the following candidate adoption
includes the store and capture callbacks.
Host voice wiring and the authoritative Handrail audio billing contract remain open.


## Shared audio capture candidate

Both web projects now reference `handrail-ai-assistant-0.2.7-parity.2d90a0faa5e1.tgz` with SHA-256
`2d90a0faa5e1a028bff282660a136335e6debd8880c89183f6c7248fc611fd7f`. Manifest/lockfile references, dependency contracts and installed
SDK file bytes were checked against the same archive. The SDK package typecheck,
scoped lint and package build passed. The retained approval/state/cancellation
changes are included; neither application mode was removed. Native Dart source
was unchanged by this candidate.

The candidate adds optional OpenAI transcription/realtime usage callbacks, a
parser for reported audio/text/cache/duration evidence, and SDK-owned immutable
PostgreSQL evidence storage. SDK tests cover capture/cancellation and duplicates
(91 cases), plus a real SQL scenario for restart, lost acknowledgement, concurrent
capture, immutable evidence and tenant/environment isolation. The evidence store
uses the existing SDK document table and does not submit billing receipts.

This adoption makes the APIs available; it does not yet connect Mills voice to
the evidence store or qualify audio billing. Host wiring, Handrail's audio receipt
and pricing contract, and live delivery remain open. Both host scoped compiles passed, and installed package imports for the capture
parsers and evidence store were verified in each host. No publication or
deployment was performed.


## Mills recorded-audio evidence wired to production composition

When Handrail telemetry is configured, Mills now supplies the SDK's
`PostgresOpenAIAudioUsageEvidenceStore` to its auxiliary usage client. The existing
recorded-audio provider parses the provider's `usage` object with the shared SDK
parser and awaits evidence capture before its normal receipt capture and response
validation. Recorded words and audio bytes are not included in evidence.

Both the provider's token modality details and reported duration are retained with
the request's server-derived user/session/project/environment and configured
transcription model. A first evidence-write failure stops the transcription result.
Final settlement retries the exact retained evidence before submitting the existing
receipt; it does not call the provider again. Missing audio usage remains explicitly
unavailable. Existing clients without an audio evidence sink retain their previous
behavior. This addition does not change Handrail's billing receipt wire format or
invent audio prices, and live voice billing remains unqualified.

Validation: eight auxiliary usage/unit/SQL tests, four selected provider tests and
one authenticated WAV endpoint test passed (13 total). The SQL scenario invokes the
actual Mills transcription provider with controlled HTTP responses and the actual
SDK evidence/outbox stores; it covers token details, fractional duration, failed
capture/retry, restart reads, attribution and exclusion of recorded words. Scoped
TypeScript compile and lint of all five touched source/test files passed. The
existing 0096 SDK migration creates the generic document table; no new DDL is needed
for the audio evidence document kind.

Both assistant modes remain available. Realtime is not yet wired: its current
provider handler skips completion events without tool calls, and its queued work
needs to be drained safely on shutdown. The SDK candidate remains
`handrail-ai-assistant-0.2.7-parity.2d90a0faa5e1.tgz`. No release or deployment ran.


## Mills realtime response evidence and shutdown ordering

When telemetry is configured, the Mills realtime provider now uses the SDK event
parser and audio evidence store for every `response.done`, including responses
without tools and completed, cancelled, failed or incomplete outcomes. Evidence
uses the authenticated household/user, server request, provider call/response
identity and the model actually selected in Mills' realtime request. Replayed
response evidence retains the same deterministic ID; a mismatched call identity
is rejected. This captures evidence only and does not invent a voice billing
receipt or price.

The provider awaits capture before dependent tools. It retries an evidence write
once with the same record; two failures stop queued tools and close the call.
Already-received response evidence is still drained during shutdown. Queued tools
are stopped, an already-started tool can finish, and per-call resources close once
after queued work settles. After the server marks a call stopped, it sends no further tool outputs or continuations.
Provider hangup HTTP requests now use the configured timeout. Mills' main shutdown
sequence drains realtime before flushing usage and closing shared stores, removing
the previous race between active voice work and store closure.

Validation: 12 realtime provider tests and two real SQL usage tests passed (14
cases). They cover responses without tools, every terminal response outcome,
duplicate tool events, storage retry/failure, blocked capture at shutdown, an
already-started tool at shutdown, hangup timeout, stable SQL evidence across
restarts/replays, attribution, and keeping voice evidence out of the billing queue.
The final scoped TypeScript compile (including realtime tests) and lint of all five
touched source/test files passed.

Scope and remaining qualification: Mills does not request realtime input
transcription, so only voice response usage has a known model in this path. The
recorded-audio transcription endpoint is wired separately. Both assistant modes
remain available. Live headset/browser behavior, provider control-channel closure
and billing delivery are not proven by these controlled tests. Voice mutation
approval-policy parity still needs an explicit audit; this change preserves the
existing domain execution policy. Handrail audio receipt/pricing reconciliation
remains open. The SDK candidate is unchanged; no release or deployment ran.


## Shared recording controls and selected composer (2026-09-05)

Added `useCapturedAudioTranscription` in the React entry point for applications
whose authenticated endpoint accepts a recording directly. It reuses the existing
capture/transcription coordinator, retains the completed Blob locally for a retry,
and sends the same request identity for retries of that recording. Its private
metadata is never a durable server upload reference. Reload does not preserve a
local microphone recording. Conversation changes, cancellation and unmount abort
local work and suppress late text; successful transcription releases retained audio.

`renderVoiceControls` on the styled chat/launcher receives the selected conversation
and its actual composer. The workspace remounts controls on thread changes. The
existing static `voiceControls` slot remains supported. Voice controls occupy a
full-width wrapping row above the text field. Hosts can omit or replace this UI.
`composer.acquireSubmissionBlock()` returns an idempotent release callback. While
any block is held, the button, keyboard and direct `submit()` paths reject sending;
this lets hosts finish local draft preparation without racing message submission.

SDK validation: 31 focused tests (14 composer, 16 transcription, one selected
voice-renderer test), package typecheck, scoped lint, and both pack lifecycle builds
passed. The new tests cover synchronous submit rejection, multiple blockers,
stable Blob/request identities, late-response suppression and thread disposal.
Mills host integration uses the actual installed package and authenticated endpoint
client, with a controlled capture device and HTTP responses. Six tests cover
recording/transcription submission guards, appending to an edited draft, same-key
retry, cancellation, unmount, synchronous microphone failure recovery, and the
existing host session-expiry callback.

Both web hosts use local candidate
`handrail-ai-assistant-0.2.7-parity.6cdd45f0f852.tgz` (SHA-256
`6cdd45f0f8527ee9f39e983e5440277965a16763a5ee36e0bd789d8b01d84bb4`).
Every installed package file was compared to the archive; manifests/locks and
provenance identify the same artifact. Source base is
`9724454d0be29b33e47a7004d5529e4be3681227`; source tree digest is
`0788670b50a1c3ba3847b13d0bdd4782eace9a59a31be6d5b06ea9667b34a697`.
Native Dart source is unchanged. No release, commit or deployment was performed.

Open audit finding: Mills `/transcriptions` forwards a stable idempotency key to
the provider but does not yet durably claim/replay host transcription results. Its
usage identity also currently follows the HTTP request ID. Retrying a lost HTTP
response therefore does not have demonstrated protection against repeat provider
invocation or duplicate accounting. Do not treat client same-key tests as proof of
server idempotency. Mobile realtime mutation approval policy, Handrail audio
pricing/receipt reconciliation, final clean install, and real browser/device/provider
qualification also remain open. This goal is not complete.

Both web hosts passed their scoped qualification TypeScript checks with candidate
`6cdd45f0f852`; Mills included the final voice component and six tests.


## Provider-operation claims and Mills transcription replay (2026-09-05)

The previous transcription replay finding is now patched in production composition.
The SDK adds `PostgresProviderOperationStore`, which commits a durable claim before
external dispatch, validates/minimizes JSON results, and replays completed results.
Same-key changed input raises an identity conflict. Concurrent/restarted requests
with an unresolved claim do not invoke the provider again. Lost completion
acknowledgements are repaired by reading the saved result. Lost admission
acknowledgements never grant permission to dispatch. The new record kind uses the
existing V1 document table; see audio-usage-capture.md for compatibility and limits.

Mills supplies this store to its authenticated transcription route in **both**
legacy and SDK modes, independently of telemetry being enabled. Operation identity
includes the server-selected scope, household, user and request key. The fingerprint
binds audio bytes and media type. The provider key and usage turn identity derive
from that scoped identity. Authentication, role, CSRF, audio validation and rate
limits run before replay. Completed replay bypasses provider execution and usage
capture/settlement. Different authorized users cannot read each other's result even
if they present the same request key. No raw recording is retained by this ledger;
its validated result contains transcript text.

The SDK SQL scenario passed for concurrency, restart, changed input, lost admission
and completion acknowledgements, provider failure, and tenant/environment isolation.
Two mounted Mills HTTP/SQL tests passed: existing authenticated WAV validation and
a new scenario covering concurrent requests, router restart, exactly one provider
call/usage receipt, owner isolation, rejected unauthenticated/viewer access, changed
audio and unresolved outcome replay. Seven host UI tests passed, including retrying
an uncertain status with the same recording/key. The Mills scoped TypeScript check
passed with the new route and tests.

Both hosts now use `handrail-ai-assistant-0.2.7-parity.47184f13f68e.tgz`, SHA-256
`47184f13f68e5f88a02a6f68d21cbf522bff1a4bd42fd6ef7b1267ecf2493344`, source tree
`5255efdf37f9c7c60d3f55c4cd6de49e4ce50d3b0c440b87879c4886f8bd9b63` based on
`9724454d0be29b33e47a7004d5529e4be3681227`. The two pack builds passed. Both archives,
manifest/lock contracts and all installed package files were verified. No native
Dart changes, release, deployment or commit occurred.

Remaining limit: an admitted provider call with no saved result still needs
provider/host reconciliation. The SDK does not expire its claim or infer that an
unknown outcome was free or safe to repeat. Mills returns
`transcription_outcome_uncertain`; its SDK UI explains the uncertainty and Retry
checks the same request. All workers handling this endpoint must adopt the ledger
before duplicate-request protection is claimed, and its deployment scope must stay
stable. Older workers ignore these claims. Live provider/device/Handrail billing,
mobile realtime approval policy, final clean install and broader parity qualification
remain open; the goal remains active.

Spartan passed its scoped qualification TypeScript check with candidate `47184f13f68e`.


## Voice cancellation boundary and approval integration audit (2026-09-05)

Mills realtime now checks whether its call stopped immediately after awaiting tool
preparation and before dispatching a proposed mutation. Previously a delayed tool
could return a proposal after close/shutdown and still execute that change. A
control-socket error now stops work and closes the socket instead of only logging.
Setup rejects a connection that closed before its readiness promise resolved.

A trusted-host `resolveProposal` callback can now replace immediate domain mutation
execution. It receives the proposal, a session/call-scoped tool identity and an
AbortSignal. Close/error/shutdown abort this signal; the actual shared SDK
`waitForApplicationApproval` is exercised in the cancellation test. A callback's
completed result is passed to the voice provider without executing the domain
mutation again. Callers omitting it preserve the existing executor. This callback
is **not yet wired to a voice approval policy in production**; no approval parity
claim follows from these boundary tests. An already-dispatched action is still
drained before its tool runtime is released; close cannot undo its effects.

Eighteen targeted realtime tests passed (the previous twelve plus six new cases),
including delayed proposal preparation after close/error/shutdown, a cancelled
SDK approval wait, exact completed-result use, duplicate calls and setup-close
ordering. The scoped Mills TypeScript check passed. No SDK source/package or native
source changed in this slice; candidate `47184f13f68e` remains installed.

Integration findings for the next step:

- The native voice call-creation request currently carries speaker context but no
  selected conversation or legacy/SDK mode. The route constructs a virtual
  realtime context, and its fallback mutation executor remains immediate.
- The voice sheet has no proposal review surface. The existing domain proposal
  card and confirmation route are reusable, but pending approvals must be tied to
  actual server-owned state, shown in that sheet and cancelled on hangup. Do not
  fabricate a user-authored text message from a provider-generated tool request.
- SDK `realtime/tool-bridge.ts` currently records `approval.proposal_created` without
  recording the referenced tool call. Its test checks the proposal store and actual
  execution, but never replays that event stream. The conversation reducer ignores
  an approval whose tool call is missing or unnamed. This is an apparent SDK
  projection gap to reproduce and repair before using the bridge for visible voice
  approvals. Preserve the host's reviewed/redacted argument boundary; blindly
  emitting raw provider arguments would violate the bridge's review contract.

The broader voice policy, live billing and final parity qualification remain open.

## Realtime approval recovery qualification

The SDK realtime tool bridge previously stored approval creation without a named
tool-call event. Canonical replay therefore omitted the approval even though the
proposal store could confirm and execute it. New approvals now atomically append
the named tool call and proposal, using only the host-reviewed/redacted argument
snapshot for display. Raw provider arguments remain outside these events.

For older orphaned streams, bounded replay and retained-history reads restore the
projection by linking exact copies to the original immutable approval events.
Execution audit validates the original payload, time and actor/source on every
copy, then uses the original evidence. Missing confirmation evidence, altered
review/attribution, incomplete pagination and incompatible identities fail closed.
Idempotent proposal creation is followed by a current-store read so an old pending
snapshot cannot replace a later decision. A persisted terminal turn prevents new
confirmed execution; already-completed ledger results remain replayable.

Validation: 15 realtime bridge and 6 approval execution tests pass, including
new and orphaned streams, repair before/after confirmation, original reviewer
attribution, replay after bridge recreation, altered recovery evidence, missing
confirmation, cancellation before resume, and no repeated domain invocation.
These are shared SDK tests. Mills native realtime still needs selected-conversation
and SDK-mode policy wiring plus a review surface; this patch alone does not
establish native voice parity or live provider/billing qualification.

## Mills voice message foundation (route wiring remains open)

The SQL assistant store now provides `startVoiceMessage` for authenticated, owned
conversation activity. It creates only an assistant message with explicit
`realtime_voice` metadata; it never fabricates an authenticated user utterance
from provider output. A conversation lock and stable request identity prevent
duplicate messages/audit entries. Replays return the current stored message,
including completion, without starting another response. Existing immutable
proposal staging, decisions and completion work with this message.

A targeted real PGlite/migration test passed: concurrent same-key starts create
one message, other users in the same or another household get 404, no user
message is inserted, a staged rejection appears in conversation history, and
completion plus store recreation retain the original decision. Scoped Mills
TypeScript compilation and lint passed. No route invokes this method yet; it is
the domain persistence boundary needed for the next native voice integration.

Next unfinished point: wire Mills native selected conversation and assistant
mode through the SDP route. Apply the existing server-owned required/automatic
policy using the shared approval continuation and durable domain mutation ledger;
connect a review surface during the voice sheet and persist actual voice run
state/cancellation/completion. The current realtime route still generates a
virtual conversation ID and invokes the legacy executor. Do not claim SDK voice
policy parity, automatic hangup recovery, or live billing proof from these tests.
Coverage Q&A search for Mills realtime returned no matching owner decisions.

## Mills native SDK voice policy and review integration

SDK-mode realtime SDP requests now identify the selected owned conversation and
a stable call UUID. Production enables this route policy only with
`MILLS_HANDRAIL_AI_MODE=dual_write`, using `MILLS_HANDRAIL_AI_APPROVALS`
(required by default, or automatic). Legacy requests retain their existing voice
executor. The SDK request checks ownership before constructing plugins or
starting the provider; duplicate admitted call identities return 409 instead of
starting another remote call. A server `X-Assistant-Mode: sdk` acknowledgement is
required before the native SDK client accepts the SDP answer, so an older server
cannot silently supply legacy approval behavior. The OpenAPI contract documents
these headers and response cases. No environment values were changed.

`realtime-conversation.ts` composes the existing SDK-backed mutation resolver,
durable domain confirmation ledger, and shared approval continuation with the
assistant-only voice message. Required approval waits for the real domain
decision. Automatic execution retains project-policy evidence and known applied
changes. Repeated tool identities reuse saved results; rejected, cancelled or
uncertain proposal resolution prevents further dependent work in the voice call.
Call cleanup preserves staged decisions and the final conversation summary.

Mills native passes the selected conversation only in SDK mode. Its voice sheet
shows conversation proposals and polls while open; pending changes can be
confirmed/discarded without closing the voice view. Review data is available in
the shared proposal card. Read/decision generations prevent a delayed pre-decision
refresh from restoring a stale pending proposal. Closing the sheet cancels its
local reads. The label counts conversation proposals, not all voice tool calls.

Evidence: four real SQL/migration cases cover required confirmation/rejection,
cancellation and automatic execution, result replay, one invocation and retained
history. The mounted SDK HTTP flow confirms through the existing real endpoint;
five existing realtime route cases also passed. All 19 controlled realtime
provider tests pass, including stopping the second dependent tool after a policy
failure. Seven native widget cases cover SDK voice review, retained legacy mode,
voice/speaker controls and proposals; four native transport cases cover credentials,
SDK identities, acknowledgement and shared-speaker context. The SDK voice widget
case also passes with an intentionally delayed refresh after confirmation.
Scoped Dart analysis reports no issues. These use controlled provider/WebRTC
fixtures, not a real microphone, provider session or billable account.

Remaining lifecycle work: native stop still closes local WebRTC; an explicit
authorized server hangup with durable call identity is needed for reliable remote
cleanup across workers/restarts. This voice integration does not yet publish a
canonical SDK run/activity lifecycle or recover stale pending voice messages after
a worker crash. Do not claim reload-safe voice running/unread markers or accurate
voice tool counts from the proposal panel. Close these gaps through shared SDK
lifecycle/persistence primitives, retaining domain schema/policy in Mills.

Owner test navigation (source candidate): select Try SDK in the native assistant,
open Voice on the chosen conversation, choose Just me or Shared device, then open
Conversation changes when a proposal appears. Expand Review change to inspect
its saved fields and Confirm or Discard. Use legacy returns to the prior voice
path. In automatic mode approved domain changes continue without per-change
confirmation. A repeated failed call-start identity requires checking the saved
conversation before closing/reopening voice for a new call. This is still an
active qualification candidate, not deployment approval or final readiness.

Final scoped Mills web TypeScript compilation and lint passed for the native
voice policy integration and HTTP compatibility acknowledgement. No builds or
checks remain running at this checkpoint. Next unfinished work is authoritative
remote hangup and persisted voice lifecycle/activity/recovery.

## Durable realtime call store and strict termination foundation

Both web hosts now use `vendor/handrail-ai-assistant-0.2.7-parity.6927a606ed83.tgz` with SHA-256
`6927a606ed83b3a8328ee379aeaca7e748014c529d5cce32864ba5c2577a38ac`. Manifest/lock integrity and all installed archive file
bytes match in both hosts. The SDK supplies `PostgresRealtimeCallStore` and
`createRealtimeCallLease`; see `docs/realtime-call-lifecycle.md` in the SDK.

The store separates admission from the durable claim to create a provider call.
Cancellation that wins before creation prevents dispatch. Later cancellation
remains ending until a known remote reference is terminated. Provider attachment
cannot overwrite a concurrent end request or revive an expired worker. Leases
expire to uncertain, preserving the distinction between lost control and known
remote termination. Call records remain scoped, immutable in identity, and
readable through bounded keyset pages. Heartbeats are serialized and have an
independent last-confirmed-deadline watchdog; stalled storage aborts local work
and late replies cannot revive the lease. The existing SDK documents migration
supports the new record kind; no additional domain DDL is introduced.

One real SQL integration scenario passes admission/attachment/cancellation races,
owner/environment isolation, changed bindings, worker expiry, lost commit
acknowledgements and pagination. Two controlled-clock tests pass stalled renewal,
termination conflicts, explicit close and late replies. SDK package typecheck,
scoped lint and packaging builds pass. SDK Coverage Q&A search for voice was empty.

Mills provider now exposes a strict server-only `hangupCall`: unsuccessful HTTP
responses propagate failure, local work is stopped and drained, and another
provider instance can terminate a retained reference. General shutdown still uses
best-effort cleanup. `onCallCreated` is awaited before a tool-control channel is
opened; storage failure tears down the known remote call. All 21 controlled Mills
realtime provider tests pass, including these boundaries. This callback and the
new SDK store are not yet connected to the Mills HTTP lifecycle.

Next unfinished integration: persist/claim the SDK call before provider creation,
attach the private provider reference in `onCallCreated`, bind the lease signal
to provider setup/control and approval waits, and add an ownership-checked end
route that records ending before strict remote hangup. Native End must use that
route. Domain voice history/proposals and canonical activity/unread state still
need reconciliation after worker loss; publishing these primitives alone does
not establish reload-safe native voice or live provider/billing qualification.

Both scoped web host TypeScript qualification compiles passed against candidate
`6927a606ed83`. Final clean-install and live provider/runtime evidence remain open.


### Resumed qualification: durable Mills voice end control (2026-09-05)

The unfinished HTTP lifecycle integration above is now connected in source. SDK
voice admission, provider-creation claim and private provider-reference storage
use the shared PostgresRealtimeCallStore. Lease renewals and every new tool start
reauthorize the original session. The lease abort signal stops provider setup and
local tool work. The end route persists `ending` before remote hangup and records
`ended` only after confirmation (or when provider creation never began).

`GET /api/v1/ai/realtime/calls?conversationId=<uuid>` returns owner-scoped public
call status with keyset pagination. `POST /api/v1/ai/realtime/calls/<callId>/end`
with JSON `{ "conversationId": "<uuid>" }` uses session/CSRF authorization and
allows the owner to stop a retained call after transcript deletion. It returns
200 for ended or 202 for ending. Provider references never enter these responses.
A failed remote hangup remains ending and can be retried from another worker.
The OpenAPI contract documents both routes. No additional DDL is required beyond
the existing SDK document persistence migration.

Mills mobile now requires `X-Assistant-Call-Lifecycle: 1` plus
`X-Assistant-Mode: sdk` before accepting SDK SDP. Deploy the matching backend
before testing this native candidate. Only SDK voice End uses the new route:
local audio is released first; unconfirmed termination retains the same call
identity and shows Retry ending call. SDK sheet back/close controls request
termination; drag/barrier dismissal is disabled. An explicit Close view option
allows leaving after an unconfirmed end without claiming termination. Legacy
voice behavior remains.

Controlled validation: 23 provider tests pass, including SDP-read/socket-factory
failure cleanup and cancellation during a stalled provider-reference write.
Mounted HTTP tests pass real database call persistence, owner/CSRF rejection,
repeatable end, retained ending after a failed provider hangup, and denial after
the auth adapter reports session revocation. Provider transport and auth adapter
are controlled in these tests; they are not live provider/session proofs. Five
mobile transport cases and four voice/mode widgets pass, including keeping the
sheet open after unconfirmed end and closing after a successful retry. Scoped
web TypeScript compilation/lint and touched native Dart analysis pass.

An end request which arrives before admission now proves live conversation
ownership and reserves the same call ID in SDK persistence before marking it
ended. A delayed start with that identity returns 409 without contacting the
provider. Unknown persistence outcomes remain errors; only known admission
conflicts can be reconciled by reading and ending the winning record.

Still unfinished: native status-list recovery after process restart, durable
voice activity/tool counts/unread projection, and worker-loss reconciliation of
domain voice history/proposals. No device/provider/billing delivery proof is
claimed. The shared SDK archive remains `6927a606ed83`; this checkpoint
changes the Mills host wiring and native client, not the SDK package payload.


### Shared voice-call recovery monitor and Mills native adoption (2026-09-05)

The Dart SDK now supplies HandrailRealtimeCallMonitor, public call/page models,
and immutable observation state. Hosts inject protected page reads and end
requests. The monitor serializes reads, bounds pagination/retained records,
retains unfinished evidence after failed or omitted reads, prevents lifecycle
regression from stale replies, and separates accepted end from confirmed end.
Disposal stops polling and ignores late responses. It does not resume WebRTC or
re-create provider calls. The host retains server authorization/admission duties.

Mills native creates the monitor for the selected SDK conversation when opening
the voice sheet. Saved unfinished calls are visible before microphone startup,
with End saved call and Refresh controls. New voice controls remain disabled
until a complete fresh read reports no unfinished calls; starting also rechecks.
An old backend without these endpoints therefore cannot silently start legacy
voice from this SDK sheet. These call reads are outside Mills' offline read-cache
allowlist. Legacy voice remains unchanged. Ending a retained call requires the
same session/CSRF-protected server endpoint as the current live call.

Evidence: 5 shared SDK recovery tests, 5 scoped Mills voice/mode widgets, and 6
Mills realtime transport tests pass. The recovery widget restores uncertain
server calls in a new monitor, rejects premature startup, retains accepted end,
and permits startup after confirmed termination. SDK and touched Mills Dart
analysis pass. Spartan's new vendored recovery file analyzes without issues;
analysis of its entire vendored library found only existing style information,
with no compile errors. This is controlled transport/widget evidence, not a
physical-device reboot or real provider/billing receipt.

Both native apps vendor exactly the same 11 SDK package files with per-file
SHA-256 provenance. Spartan receives the reusable SDK API; it does not gain an
unsupported realtime UI. The matching unpublished JS-package candidate is
handrail-ai-assistant-0.2.7-parity.18759f975a2c.tgz, SHA-256
18759f975a2ca3b66345f4c5acfda335f586a3fe38e71bf995d4276f047ff5ce.
Both web hosts have matching archive dependencies, lock integrity and installed
bytes; both native payloads also match the Dart files embedded in this tarball.
SDK packaging builds pass. No package version, deployment environment, published
release, Git commit, push or PR was created by this checkpoint.

Next unfinished voice requirement: reconcile the domain transcript/proposals
when a retained call is terminated by a different worker. The SDK call record can
be ended while the old domain assistant message still says voice is in progress.
The current recovery UI must not be treated as evidence that this separate
transcript state, canonical activity/tool counts or unread markers are complete.
Live host/device/usage delivery and final clean-install evidence remain open.

Both scoped web host TypeScript qualification compiles passed against candidate
`18759f975a2c`. Final clean-install and live runtime qualification remain open.


### Mills ended-voice transcript reconciliation (2026-09-05)

Mills now repairs voice transcripts from confirmed SDK call termination evidence.
Both the authenticated End route and paged status reads reconcile ended call IDs
against the owned conversation. Repair runs in a bounded domain transaction,
updates the conversation version, and writes one recovery audit per interrupted
message. Missing/deleted transcripts do not reverse remote termination.

For a still-pending voice message, repair records a failed/interrupted transcript
with explicit text that the call ended and saved changes need review. It rejects
only proposals still proposed/unclaimed. Executing, confirmed, failed and already
rejected proposals retain their status. Provider termination never proves a
mutation outcome. A normal completed voice transcript is not rewritten.

Voice completion now separately retains voiceRemoteEnded metadata. A transcript
closed with unconfirmed termination is updated when confirmation arrives. A late
original worker may complete a recovered voice message with its real result,
including existing proposal identities/decisions; an older unconfirmed signal
cannot overwrite confirmed termination or restore the uncertain wording.
Ordinary failed text messages remain ineligible for late completion.

Six scoped SQL voice cases pass, including concurrent/idempotent repair, same
household ownership isolation, unclaimed rejection, claimed-state preservation,
late settlement/completion, unconfirmed-to-confirmed history, and the unchanged
failed-text boundary. The mounted HTTP recovery test simulates a new provider
instance terminating the saved reference without the original close callback;
status read repairs the pending transcript, and a late original callback can
finish it. Provider/auth adapters are controlled; this is not live worker-kill
or device evidence. Scoped Mills TypeScript compilation and lint pass.

No SDK archive or migration changed in this checkpoint. Candidate `18759f975a2c`
remains the current shared dependency. Remaining work includes recoverable domain
projection of automatic voice execution intent/results when the original worker
never returns, canonical voice activity/tool counts/unread state, live runtime
and billing qualification, and final clean-install/release instructions. Repair
uses a review-required summary where outcomes are unresolved; it does not claim
that those business outcomes have been reconciled.


### Automatic voice intent and execution-result recovery (2026-09-05)

Mills SDK voice automatic mode now saves each immutable domain proposal and its
project-policy execution claim before invoking a mutation. The initial proposal
status is executing, so automatic mode does not briefly offer a confirmation
step. Required approvals retain their original proposed/confirmation flow.
Automatic mode uses the shared SDK claim/result ledger and the existing domain
executor; conversation context is retained. Completed receipts carry
mills.sdk.automatic.v1 plus a policy request ID, not a fabricated user
confirmation request ID. Initial policy evidence is audited before dispatch.

Voice close binds both approval modes to their existing staged proposal IDs.
Known, executing and failed proposals remain reviewable even if the original
worker cannot finalize its transcript. After confirmed call termination, the
host finds outstanding voice executions and repairs their status only from
completed SDK receipts with matching proposal, owner, execution identity,
authorization and successful result fields. Missing or malformed evidence does
not authorize redispatch or mark success. Other failed text messages retain the
existing late-completion prohibition. This checkpoint scopes the new automatic
proposal continuation to voice; text-mode automatic projection should be
reviewed separately before making a whole-assistant recovery claim.

The SDK adds getToolResults for bounded, tenant-scoped batches of up to 100 tool
identities. It returns completed entries only; absence is not a failed result.
The host first verifies conversation ownership, then reads batches and settles
only the corresponding owned proposals. No new database migration is needed.

Validation: 18 scoped Mills SQL voice/proposal/confirmation/execution cases,
11 mutation-policy cases, and 4 mounted SDK voice HTTP cases pass. A controlled
projection-write failure leaves one executed automatic change in executing state;
a fresh store recovers it without another mutation. A corrupted owner receipt is
rejected and does not alter that status. The mounted automatic-mode test completes
without any confirmation endpoint request, shows the saved change before voice
close, and replays the same tool call without a second execution. The SDK real-SQL
ledger case now also covers batch bounds, deduplication, tenant separation,
legacy completed results, and missing/uncertain entries. SDK typecheck, scoped
lint and packaging builds pass; scoped Mills compile/lint pass.

Both web hosts now pin handrail-ai-assistant-0.2.7-parity.678dde784841.tgz,
SHA-256 678dde7848416883699621f3b8460b7d6f10e113853df541d14fea825ac7c9e2.
Manifests, lock integrity and installed files match the archive. The existing
Dart files in both mobile hosts still match its embedded Dart package exactly.
No publish, commit, push, PR, deployment or project environment change occurred.

Remaining: canonical voice activity/tool counts/unread state, complete text-mode
automatic recovery qualification, live host/device and billing receipt evidence,
final clean-install proof, and the consolidated parity/testing handoff. The
controlled recovery tests do not prove real provider/device/runtime parity.

Both scoped web host TypeScript qualification compiles passed against candidate
`678dde784841`. Final clean-install and live runtime evidence remain open.

## Mills automatic text recovery checkpoint — 2026-09-05

Mills SDK text now stages automatic domain proposals before dispatch, preserving
original user-message context and using the already-qualified SDK dispatch ledger.
Message completion reuses staged IDs; a failed reply retains the saved proposal.
Protected proposal-group/history reads restore confirmed status only from valid,
completed SDK execution receipts and never execute again. Failed text messages
remain failed. Spartan source already stages action requests before automatic
project-policy execution. No Spartan source changed for this checkpoint.

Mills validation: 17 gateway tests, 18 selected SQL gateway tests, two existing
confirmation HTTP cases and one new history-reopen recovery test passed (38 total).
Scoped host TypeScript compilation passed. This does not establish live provider
or process-restart parity. SDK 678dde784841 candidate and both native vendors are
unchanged. Canonical voice activity/unread, final clean dependency installation,
protected runtime qualification and billing receipt evidence remain outstanding.

## Current candidate installation and schema verification — 2026-09-05

Four independent clean npm installs passed using current 678dde784841: Mills and
Spartan, each with development and production dependencies. All package files
match and every JavaScript entry point imports. New/expanded host SQL migration
checks pass (Mills three, Spartan one), comparing the installed SDK schema and
retaining execution evidence on reapplication. Evidence and migration/upgrade
instructions are in parity-installation-and-upgrade.md and parity-install-evidence.json.
These checks do not verify deployed migrations, provider sessions or billing.

Both host scoped qualification TypeScript checks and lint on the new/expanded
migration tests passed after this checkpoint. No SDK source, archive, mobile
vendor, deployed configuration, commit, push or PR changed in this checkpoint.

## Durable voice tool activity checkpoint — 2026-09-05

SDK `PostgresRealtimeToolActivityStore` now persists one record per tool identity
within an owned call. It prevents name rebinding and terminal reversal, handles
duplicate callbacks without counter increments, and permits a recorded in-flight
tool to settle after remote termination. Summary counts come from SQL; details
are paginated and contain only identity/name/status/timestamps. Missing outcomes
stay unresolved. Existing SDK document tables support the new kind; no DDL changed.

Mills SDK voice lifecycle now connects the provider's start/result hooks to this
store. A failed start-record write stops before domain dispatch. The protected
GET `/api/v1/ai/realtime/calls/:callId/activity?conversationId=...` returns counts;
`details=true` includes at most 50 tool records and `nextToolCallId` for paging.
The HTTP route requires SDK mode availability, an admin/member session and owned
conversation. Existing call status/end payloads are unchanged. Legacy voice has
no new activity callback. These are display records, never mutation authorization.

Evidence: SDK tool-activity and call-lifecycle SQL tests passed (2); Mills provider
suite passed (25), including callback ordering, duplicate failed-tool delivery and
stopping before dispatch when activity persistence fails; mounted SDK voice HTTP
selection passed (2), including count/detail/ownership checks. SDK typecheck,
scoped SDK lint and package builds passed; Mills scoped compilation passed.
Native rendering of counts/details, workspace voice completion/unread and genuine
browser/device/provider evidence remain open. No voice UI claim is made yet.

Both web hosts now pin `handrail-ai-assistant-0.2.7-parity.20a847660a2b.tgz`, SHA-256
`20a847660a2b4d59fef46847bdc2013cece4caf7e5d065c6fe859f1d8f4e313e`.
Installed files, manifest/lockfile identity and provenance match the archive.
The prior four clean installs qualify 678dde784841, so the new artifact needs
renewed clean-install verification once integration is finished. Both native
Dart vendors are unchanged. Nothing was committed, pushed, published or deployed.

Spartan scoped qualification compilation and Mills lint on all touched voice
source/tests also passed. The new archive contains 308 files, including the
compiled shared voice activity store. Native UI wiring is the next unfinished step.

## Shared native voice activity checkpoint — 2026-09-05

Shared Dart `HandrailRealtimeActivityMonitor` now owns polling for an authenticated
voice call's counts and optional details. It joins overlapping reads, validates
call/conversation scope, rejects count/outcome regression, retains bounded loaded
page windows and drops late replies after detail-mode changes or disposal. On
failure it preserves saved counts and reports a safe refresh error. Typed models
expose no arguments or business results.

Mills native composes the monitor through its protected transport and repository.
The voice sheet shows one selected call's counts, collapsed opt-in tool details,
and bounded saved-call selection (including ended calls). Its existing
showActivityDetails=false hides voice details while keeping counts. Interrupted,
ending and ended calls label missing outcomes unresolved. Domain proposal review
is retained. Activity reads are outside the native offline-cache allowlist.

Evidence: four shared Dart tests, one protected transport test, and three Mills
voice widgets passed (active/recovery/hidden details). Shared Dart analysis,
scoped Mills analysis and analysis of Spartan's new shared file passed. Both
mobile vendors have identical 12-file hashes and match the embedded SDK archive.
No new Spartan voice capability, project configuration, release or deployment was
introduced. Voice workspace completion/unread, live provider/device/billing proof
and renewed clean-install validation remain outstanding.

Both web manifests/locks/provenance now reference
`handrail-ai-assistant-0.2.7-parity.cf54452ea2c5.tgz`, SHA-256
`cf54452ea2c57d5760a1007f38b890167909eb599031ecfb332d1d5f4d7508e5`.
Package builds passed and installed files match the archive. Its 276 compiled
TypeScript files are byte-identical to the host-compiled 20a847 candidate; changes
in this checkpoint are mobile client source and documentation. The previous
four clean installs qualify 678dde784841, not this new archive.

## Voice completion read receipts — 2026-09-05

The SDK voice activity store now supplies readState()/markRead(token). An ended,
dispatched call is unread until its displayed lifecycle version and monotonic
tool counts are acknowledged. Tokens bind tenant/owner scope and call identity.
Duplicate receipts are idempotent; older receipts cannot roll back a read marker;
late tool outcomes make a previously read call unread again. No text activity or
execution authorization changes. Existing SDK documents hold the receipts; no DDL.

Mills activity GET now includes unread/readToken. Protected POST
`/api/v1/ai/realtime/calls/:callId/activity/read` checks ownership, CSRF, scope and
token bounds before recording it. The server returns current state, so an older
acknowledgement may return unread=true if a newer result has arrived. The OpenAPI
contract is updated. Native models continue to tolerate the additive fields.

Evidence: the SDK SQL activity test covers concurrent acknowledgements, invalid
scope/future tokens, lost write acknowledgement, late outcomes and old-token
replay. The mounted Mills voice HTTP test covers read, late completion, stale
acknowledgement, forged scope and CSRF. Both passed. SDK typecheck/scoped lint and
package builds passed; Mills scoped qualification compilation passed.
Client acknowledgements after actual visible rendering and conversation-workspace
voice activity discovery/aggregation remain unfinished. This API alone does not
complete the cross-thread unread requirement. SDK Coverage Q&A search for unread
returned no matching decisions.

Both web hosts now pin `handrail-ai-assistant-0.2.7-parity.bc15f37e420d.tgz`, SHA-256
`bc15f37e420d16c51fe46c5004d3cc99de03e548c30e9badf006c8f6f8c25e98`.
Manifests, lockfiles, provenance and installed files match. Both mobile vendors'
12 files still match the packaged shared Dart source; no native change occurred.
The prior four clean installs qualify 678dde784841, so current installation proof
must be renewed after the remaining integration. No commit, push, PR or deployment.

Spartan scoped qualification compilation and Mills lint on the changed voice
route/tests passed. The next unfinished work is client read-token handling and
voice activity/unread aggregation in conversation workspaces.

## Visible native voice read acknowledgements — 2026-09-05

The shared Dart activity monitor now validates completion tokens against the
returned call and counts, queues acknowledgements for distinct displayed tokens,
and keeps unread state until the server confirms it. Failed or disposed requests
cannot clear saved evidence. Regressed lifecycle responses cannot turn an ended
call's unread flag off. Older endpoints without receipts retain counts/details.

Mills mobile supplies the protected CSRF read request through its SDK repository.
The voice sheet acknowledges the captured token only after the summary is fully
within the visible scroll viewport on the current route while the app is resumed.
Selecting an ended call whose summary is offscreen does not mark it read. Failed
receipts display a safe message and retry on a later visible refresh. Hosts hiding
tool details still display counts and can acknowledge that displayed summary.

Evidence: nine shared Dart activity tests and SDK Dart analysis passed. The
protected Mills transport test verifies token/body/CSRF and rejects a foreign
conversation receipt. Four Mills voice widget tests pass, including offscreen and
paused visibility plus failed-receipt retry. Scoped Mills Dart analysis passes.
Both mobile vendors contain the same shared Dart source. These tests use injected
transport and widget fixtures; they are not live provider/device evidence.

Still outstanding: conversation-workspace voice discovery and completion/unread
aggregation, final clean installs of the resulting SDK archive, and protected
runtime/billing evidence. This checkpoint completes selected-call native read
receipts, not the global voice workspace requirement. Existing modes remain.

Both web hosts now pin `handrail-ai-assistant-0.2.7-parity.1c926ba41f36.tgz`, SHA-256
`1c926ba41f36190d129208189dc15a4a58b86460089b0539c9559d9feda8408d`. Package builds passed; installed package files match the archive.
Both mobile vendors' 12 files match the archive's Dart source and provenance.
All 276 compiled JS/type files are identical to the previously host-compiled
bc15f37e420d candidate; this checkpoint changes mobile source and documentation.
Spartan's scoped vendored activity analysis also passed. The earlier four clean
installs qualify 678dde784841, not this archive. No commit, push, PR or deployment.

## Authorized voice workspace feed — 2026-09-05

The SDK now supplies PostgresRealtimeWorkspaceActivityStore. Hosts provide up to
100 explicit tenant/owner/conversation scopes; the feed never infers ownership
from an ID prefix. Calls are paged by conversation ID and call ID (20 by default,
50 maximum), and evidence reads run in bounded batches of four. The whole batch
settles before returning a failure, avoiding unfinished database reads after an
error. Only call/conversation IDs, lifecycle status, tool counts and unread are
projected. Provider/worker references, settings, read tokens, tool names/arguments
and business results are excluded. Reading neither acknowledges calls nor writes
text activity. Expired calls stay uncertain, and late tool results restore unread.

Mills exposes protected GET /api/v1/ai/realtime/activity. Repeat conversationId
for each owned conversation (maximum 100); pass both afterConversationId and
afterCallId to continue its 20-call pages. All conversations are authorized first.
The route rejects missing authentication, unknown conversations, duplicate IDs
and incomplete cursors. No domain actions are executed or reconciled by this feed.
The OpenAPI contract describes the exact response and bounds.

Evidence: SDK real SQL test passes for two independent conversation scopes,
paging, tenant/owner isolation, cancelled/expired/ended behavior, retained read
receipts, late results and failed reads. SDK typecheck, scoped lint and package
builds pass. Mills mounted HTTP test passes with its existing required approval,
call lifecycle and read receipt flow plus workspace queries. Both web scoped
qualification compiles pass. This is server feed evidence, not conversation-list
rendering, live provider or deployment evidence. SDK Coverage Q&A voice search
returned zero matching decisions.

Both web hosts now pin `handrail-ai-assistant-0.2.7-parity.64eb98f43b3c.tgz`,
SHA-256 `64eb98f43b3c834d0d0dc9845b7fe507272e2bbbad1ef454571cf45ce31b7ff2`. Manifests,
locks, provenance and installed package files match. Both native vendors' 12
files still match the packaged Dart source; this checkpoint makes no native edits.
Current archive clean installs remain pending (the four prior clean installs
qualify 678dde784841).

Next unfinished work: shared client observation of this separate feed and voice
status/unread summaries in conversation lists, starting with Mills mobile and
then the shared web presentation. Text run/cancellation state and text read
receipts must remain independent. No commit, push, PR, publish or deployment.

## Native conversation-list voice activity — 2026-09-05

Shared Dart now supplies HandrailRealtimeWorkspaceMonitor plus typed page/call/
cursor models and per-conversation summaries. It observes up to 100 conversation
IDs per request, serializes paging/refreshes, bounds total pages, rejects foreign,
duplicate, missing or regressed records, and ignores late replies after scope
changes or disposal. Failed or truncated refreshes retain the previous complete
snapshot and expose a safe error. Active, end-unconfirmed, unread and unresolved
outcomes remain separate from text turn/cancellation state. This observer has no
acknowledgement or provider-operation API.

Mills mobile supplies the protected transport and account-scoped repository
observer. Its mode screen enables observation only when realtime voice is
available to an admin/member. Initial catalog load and subsequent conversation
changes update observed IDs; clearing a conversation removes it. Successful
visible-call acknowledgements refresh the workspace. The SDK conversation list
shows independent voice/text state and its icon counts unread voice calls.
Opening a thread leaves voice unread receipts untouched. Refresh failures retain
markers, show a retry message and label cached active calls as last reported.

Evidence: five shared Dart workspace tests pass (paging/concurrency/scope changes,
late disposal replies, completion/read state, invalid/truncated/regressed feeds).
Mills protected transport test, actual SDK repository test and seven SDK widget
tests pass. The repository test proves text idle/cancellation and voice activity
remain independent; the widget proves unread persists through selection and
failed refreshes. Existing mode switching, call recovery, required approval review
and visible read receipts still pass. SDK Dart analysis, scoped Mills analysis
and Spartan's scoped vendored workspace-file analysis pass. Both mobile vendors
now have 13 matching source/provenance files. Spartan has no enabled realtime
voice capability; these shared sources do not add one.

Remaining: shared web voice feed observation/presentation, final clean installs,
protected live browser/device/provider and billing evidence, and final owner
readiness handoff. These native tests use injected HTTP/provider/widget fixtures,
not a real device or provider. Existing and SDK modes are preserved. No commits,
pushes, PRs, release publishing, project configuration edits or deployments.

Both web hosts now pin `handrail-ai-assistant-0.2.7-parity.273042ed17e6.tgz`, SHA-256
`273042ed17e6858a60cffe04f0a902c75b16e1a9f21e57d60424e01c5a95d867`. Package builds pass;
manifests, lockfiles, provenance and installed files match the archive. Both
mobile vendors' 13 files match its embedded Dart source. All 278 compiled JS/type
files are byte-identical to the previously host-compiled 64eb98f43b3c candidate.
This checkpoint changes native client/integration and documentation. The four
prior clean installs qualify 678dde784841, not this new candidate.

## Shared web voice workspace and client replacement — 2026-09-05

Core SDK RealtimeWorkspaceMonitor now provides browser-safe, serialized catalog/
feed observation, request timeouts/abort, bounded paging, scope validation and
retention on missing/duplicate/regressed/failed reads. summarizeRealtimeWorkspace
separates active, unconfirmed, unread and unresolved outcomes. React and headless
exports supply useRealtimeWorkspaceActivity. Default styled launchers accept
stable voiceActivity loader options, discover the full active authorized catalog
and observe while closed. Threads/launcher summaries and per-thread rows display
independent voice status. Hosts can hide/replace them through renderVoiceActivity
or render headless state. onWorkingChange includes active voice calls; voice
never enables text cancellation or changes text read receipts.

The default launcher's old client UI is now hidden immediately when endpoint,
client/device identity or transport configuration changes. Uploader caches and
voice observers are disposed at that boundary. A client resolving after unmount
is disposed before catalog reads; failed catalog bootstrap also releases client
resources. Working callbacks clear on observer unmount. These are shared SDK
changes used by both web hosts.

Mills advertises voiceActivityAvailable only when its realtime provider/routes
and SDK lifecycle integration are configured. Its web adapter sends scoped,
uncached authenticated GETs, honors cancellation, rejects foreign records and
handles expired sessions. The standard UI supplies voice options only for that
advertised capability and admin/member roles. Its client ID includes household,
user and role. Older hosts omitting the capability default to disabled. Legacy
mode remains accessible. Spartan has no declared realtime voice integration and
does not supply a voice loader.

Evidence: six core observer tests, two headless/styled tests, three default
launcher discovery/replacement/cleanup tests, and the existing 18 styled tests
pass. SDK typecheck, scoped lint and package builds pass. Mills has six client
transport/config tests, four runtime-selection tests, two rollout route tests
and one mounted SDK voice lifecycle/approval/read test passing. Both web scoped
qualification compiles pass. The test providers/transports are injected; these
are not live browser/provider/billing results.

Both hosts pin `handrail-ai-assistant-0.2.7-parity.5683009ec79b.tgz`, SHA-256
`5683009ec79b0fde28bfd119737fa68ea8985155ba27d0b990b3cf7fecfe2102`. Manifests, locks,
provenance and installed package files match. Both native vendors' 13 files are
unchanged and match the archive's Dart source. Earlier clean-install evidence
still qualifies 678dde784841, so final clean installs must use this candidate.

Web voice workspace display is observational. It does not create a WebRTC call or
acknowledge voice results merely because a thread is selected. Mills currently
provides per-call detail review/token acknowledgements in its mobile voice sheet;
web summaries leave those receipts unread. See realtime-workspace.md for the
explicit API, bounds, lifecycle and custom-presentation contract.

Next: final installation qualification and a requirement-by-requirement owner
readiness audit, including remaining runtime access/billing evidence and exact
test instructions. No commits, pushes, PRs, project configuration edits, release
publishing or deployments occurred.

## Current candidate clean installs and first real web acceptance — 2026-09-05

- Candidate **5683009ec79b** passed all four isolated dev/production `npm ci`
  runs with scripts enabled. All 24 JS entry points load and all 317 package
  files match the archive in every install. Both native vendors' 13 files match
  current source, provenance and the archive. This supersedes older candidates'
  installation evidence without repacking unchanged executable code.
- Started existing managed development databases non-destructively and web
  services in both hosts. Spartan development startup migrations completed;
  no staging/production migration, seed/reset, publish or deployment was run
  manually. Full Mills runtime startup later timed out while connecting.
- Real Mills browser login, existing/SDK switches, SDK conversation controls and
  fallback passed in task `a8d716d1-a9ef-4273-8b9d-8b05999720ee` with no page
  errors or same-origin 5xx. Its first attempt found stale Vite optimized SDK
  exports; moving generated deps caches aside and restarting fixed that error.
- A live text/reload attempt failed before provider dispatch due to missing
  generated APP_AI_PROVIDER/OPENAI_MODEL in the actual Mills process. SQL and
  bounded server logging show a failed assistant/durable turn. Revalidating and
  reapplying the unchanged declared capability model, then restarting, did not
  repair injection. Do not repeat billable-flow acceptance until env is fixed.
- Added dev-only browser scripts to both web repos. Mills has an isolated Vault
  task with optional `text=true`; default mode sends no provider request. The
  equivalent Spartan task creation was denied by the tool's config scope check,
  despite the group's stated permission. No unsupported credential access or
  replacement of unrelated tasks was used.
- Current owner handoffs and machine-readable runtime evidence now distinguish
  installed/source evidence, passing real UI bootstrap and missing live reply/
  device/billing proof. Audio billing still requires the authoritative Handrail
  modality/duration/receipt contract. Goal remains active; this turn made progress
  and does not meet the three-consecutive-turn blocked threshold.

- Both new dev browser scripts pass syntax checks and scoped ESLint. Current
  SDK/Mills/Spartan whitespace checks pass. No typed production source changed
  in this qualification turn; the prior package compile evidence still applies.

## Primary platform dependency audit — 2026-09-05

Read-only Handrail source identified the existing v1 every-invocation receipt
contract and proved its current schema/cost function lack audio modality/duration
support. Recorded transcription already queues v1 receipts; realtime still only
retains evidence. This distinction corrects any earlier blanket description of
all audio paths. See [concrete platform handoff](parity-platform-dependencies.md).
The actual Mills process still lacks provider/model configuration; the Spartan
task tool still contradicts the current group's allowed configuration scope.
No production source, package artifact, pricing or credential change was made
in this audit turn. Prior qualified package bytes remain unchanged.
