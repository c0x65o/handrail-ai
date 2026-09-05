# Mills and Spartan SDK parity readiness

Goal: preserve legacy and SDK modes in both applications and reach demonstrated
behavioral parity for owner testing. This checklist is incomplete until each
requirement has evidence from the relevant SDK and host paths. Passing unit
tests alone does not establish live host parity.

## Requirements and current evidence

| Requirement | Current evidence / remaining work |
| --- | --- |
| Server-owned state independent of browser connections | Activity now follows durable writer status changes. Tests cover completion/failure/cancellation without observers and no repeated lifecycle notifications on replay. Need host reload/disconnect/recovery evidence and reconciliation after activity delivery failure. |
| Reload/reconnect accurately reattaches without duplicate work | Durable replay/lease primitives exist. Verify high-level clients and both host modes, including mobile. |
| Multiple running threads and persistent read markers | Workspace and activity stores exist. Verify remote/open-thread state merging and completion/read behavior across reloads and devices. |
| One summary, tool counts, optional collapsible details | Persisted tool lifecycle and collapsed/expanded/hidden/custom counts panel implemented. SDK tests cover continuations, approval waiting/rejection, duplicate execution replay, and hidden private data. Host adoption and real long-tool flows remain unverified. |
| Optional project approvals and bounded bulk work | Mills and Spartan mounted SDK paths now support required (default) and automatic project policies through existing domain executors. SQL/replay tests cover immutable intent, uncertain dispatch, policy evidence, and partial interruption. Required-mode continuation after external human confirmation and real financial workflows remain unqualified. |
| Flexible UI with reusable execution fundamentals | Styled/headless APIs exist. Ensure replacing/hiding presentation preserves execution and telemetry. |
| Speech-to-text and realtime voice | Separate SDK adapters/controls exist. Inventory both hosts and consolidate supported paths, including telemetry and cleanup. |
| Durable attributed usage without duplicate charges | Chat usage outbox exists. Need host runtime evidence and supported voice/transcription coverage. |
| SDK migrations and version compatibility | Schema V1 plus migrate method exist. Review upgrade locking/history/compatibility and host migration ordering. |
| Mills web integration with both modes | Protected high-level gateway and legacy route are qualified with simulated provider/domain flows; UI retains Try new UI / Use legacy UI. Final live provider/browser and migration evidence remain pending. |
| Spartan web integration with both modes | Protected mounted gateway tests cover both approval modes, actual SQL action persistence, usage attribution, canonical completion, and failure after streamed progress. UI retains Try new UI / Use legacy. Final live provider/browser and migration evidence remain pending. |
| Mills and Spartan mobile integration | Shared Dart canonical recovery and stable new-turn admission now pass actual SDK HTTP gateway tests with a simulated provider. Both native apps now vendor the Dart candidate and expose authenticated SDK client factories; targeted cookie/session tests passed. Mills now wires its SDK repository, secure pending storage, activity and legacy/SDK selector into the existing screen. Spartan now also wires its SDK repository, account-scoped journal, activity and persisted selector into the rich phone/tablet screen. Full real device/host qualification remains outstanding. |
| Reproducible adoption and test instructions | Both web hosts now vendor the same immutable 0.2.6 candidate with provenance and matching file dependencies/lock integrity. Fresh production/dev installs passed for the earlier 0.2.5 candidate; subsequent 0.2.6 candidates have matching dependency contracts, archive byte comparisons and scoped host compilation. Final clean-install proof must use the final artifact. Migration/live runtime sign-off and final mobile instructions remain pending. No commits/pushes/PRs or releases authorized by this goal. |

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

## Owner testing handoff (pending)

Add exact URLs/navigation, mode switches, supported feature differences, tested
SDK/dependency versions, migrations, test outputs, and known limitations here
after host integration and runtime validation. Do not describe readiness as
complete while any material row above remains unverified.

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
