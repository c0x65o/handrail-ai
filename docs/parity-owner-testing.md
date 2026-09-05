# SDK parity: owner testing handoff

**Latest synchronization update:** [0.2.8 package and validation](synchronization-fix-2026-09-05.md). Older installation evidence below remains historical.

Previous candidate: **@handrail/ai-assistant 0.2.7, 5683009ec79b**; shared Dart
client **0.1.1**. This is the current local, unpublished integration in the AI
Chatbot group: Mills Family Office web/mobile, Spartan Cyber ERP web/mobile,
and Handrail AI Assistant SDK. No commit, push, PR, publication or deployment has
been performed for this goal.

## What is qualified

Both web manifests and locks pin the same archive. Four separate clean installs
(development and production for each host), with scripts enabled, passed on Node
22.23.1/npm 10.9.8. All 24 JavaScript exports loaded and all 317 archive files
matched in every install. Both mobile vendors retain the same 13 shared Dart
files and provenance. SDK typecheck/builds, both scoped host compiles and targeted
Dart analyses passed in the preceding implementation checkpoints.

The [current checklist](parity-readiness.md) separates automated SDK/SQL/HTTP/
widget evidence from live acceptance. The detailed work log records test names,
counts and boundaries; it contains earlier candidates as history. Do not sum its
repeated test runs or treat simulated providers as live billing evidence.

Mills live browser surface check passed: visible Vault login, existing assistant,
SDK switch, loaded SDK conversation controls and return to legacy, with zero
page errors or same-origin 5xx responses. Task run
`a8d716d1-a9ef-4273-8b9d-8b05999720ee`. This check did not send a provider request.


**Current live execution blocker:** the Mills text/reload task
`1681e6cd-1d9c-4e97-a7dc-ba30a20ea742` admitted an SDK turn but failed before
provider dispatch. SQL records the assistant and durable SDK turn as failed;
the server log identifies `failureStage=configuration`, `ai_unavailable`.
The running process lacks `APP_AI_PROVIDER` and `OPENAI_MODEL`, although the
web repo's dev OpenAI capability is enabled, validates successfully and specifies
`gpt-6-astra`. Full Handrail startup timed out. Reapplying that unchanged model
through the typed capability action and restarting web did not restore those
values. This needs Handrail runtime env reconciliation before a reply can be
qualified. No API key was copied, changed or exposed. The SDK's 200 SSE admission
response is not evidence that a provider operation ran or was billed.

## Start and compare the two modes

Run against the current development servers and their full migration journals.
Do not point mobile clients at an older deployed server and treat missing routes
as a result for this candidate.

| Surface | Navigation | SDK mode | Existing mode |
| --- | --- | --- | --- |
| Mills web | Sign in, open Family Assistant; `/assistant` opens its drawer | **Try new UI** | **Use legacy UI** |
| Spartan web | Sign in and open **Ask Aegis** | **Try new UI** | **Use legacy** |
| Mills mobile | Sign in and open Assistant | **Try SDK** | **Use legacy** |
| Spartan mobile | Sign in and open Ask Aegis | **Try SDK** | **Use legacy** |

Current managed web addresses are
`https://h-0de106f56f5870e7.dev.handrail-daas.com/` (Mills) and
`https://h-fdb12fdf27ff56e0.dev.handrail-daas.com/` (Spartan).
They are development routes with service lifetimes, not permanent release URLs.
The local loopback equivalents are ports 4113 and 4185. Development databases
were started non-destructively and both web services passed startup health checks.
Mills' health check initially passed while login failed because PostgreSQL was
stopped; a health response alone does not establish usability.

Keep `MILLS_HANDRAIL_AI_MODE=dual_write` and
`AEGIS_HANDRAIL_AI_MODE=dual_write`. The existing UI remains the default. Mills
also has `MILLS_HANDRAIL_AI_CLIENT=legacy`; use the visible switches for comparison.
`legacy_only` disables the relevant SDK gateway. Native mode preferences are
account-scoped and persist. Switching presentation does not cancel admitted work;
use Stop/end controls and wait for an authoritative outcome before comparing an
operation that could otherwise be applied twice.

## Approvals and business logic

Each server controls its SDK policy with `MILLS_HANDRAIL_AI_APPROVALS` or
`AEGIS_HANDRAIL_AI_APPROVALS`: `required` by default, or `automatic`. A browser
cannot select its own approval policy. Restart the dev server after changing the
policy, and settle unfinished work before a policy change. Automatic mode still
checks the application's actor/tenant/domain rules and records durable intent
before execution. Uncertain side effects stop rather than being dispatched again.

For each host, compare its existing read tools first, then a bounded mutation on
appropriate test records. For the revenue-account example, use the accounting
plugin that exposes products/services, invoice history, journal entries and P&L.
Verify actual records and journal totals as well as the assistant's explanation.
The SDK coordinates execution and evidence; it does not supply or replace those
business tools or make a month-to-month P&L comparison sufficient accounting proof.

## Acceptance sequence still to run

1. In each existing and SDK mode, send a read-only request and verify the response,
   citations/attachments where supported, and retained history after reload.
2. In SDK mode, start a long tool request and reload during execution. The reopened
   thread must show server activity and finish once, without a second execution.
3. Start two independent SDK threads. Close the panel/disconnect while one finishes.
   Reopen and verify its completion/unread marker. Read it and verify that only
   that thread's marker clears. Repeat after logging in on another device.
4. Exercise Stop, network interruption, retry and a known tool failure. Confirm
   terminal status from the server and confirm no duplicate domain side effects.
5. Test `required` policy: approve, reject, and Stop while waiting. Test
   `automatic` policy on bounded test data: execution continues to dependent reads
   without repeated confirmation; failures stop dependent changes.
6. Check collapsed tool counts, expanded details and the short current summary.
   Host developers can hide/replace details using SDK presentation options.
7. In Mills mobile, test microphone permission denial, recorded speech, live
   voice, navigation during a call, reconnect and explicit end. An unconfirmed
   remote end must remain uncertain. Read visible completed activity and verify
   the matching voice receipt clears; late tool outcomes must become unread again.
8. Correlate a known provider operation with Handrail usage and retry its delivery.
   Verify stable receipt identity, attribution and one charge. Repeat for each
   supported audio operation only after the audio receipt contract is established.

## Explicit limitations and external dependencies

- **Full live parity and readiness to release are not signed off.** Real provider,
  microphone/device, concurrent browser and worker restart checks remain distinct
  from the passing automated fixtures.
- Mills web observes current/background voice calls but does not add a WebRTC
  call-start or per-call read-acknowledgement UI. Mills mobile supplies those call
  controls and visible read receipts. Opening a web thread clears text read state,
  not a voice receipt. Spartan has no declared realtime voice capability.
- Audio provider evidence is durable, attributed and deduplicated, but **it is not
  yet a billed Handrail receipt**. The available OpenAI capability KB defines
  credentials/models, not Handrail modality/duration/pricing/receipt acceptance.
  KB searches for audio returned no contract. Supply that authoritative contract
  before mapping retained evidence into the outbox; do not invent token prices
  or convert seconds into tokens. Text outbox tests do not prove audio billing.
- Mills has a dev-only Config task, **Verify assistant legacy and SDK web modes**,
  running `NODE_ENV=development node scripts/qa-assistant-parity.mjs mills` in
  isolation with Vault injection. By default it tests login and switching/bootstrap only. The optional `text=true`
  task parameter sends one live read-only SDK prompt and reloads before checking
  its answer; it incurs ordinary provider usage. It does not exercise domain tools. The matching Spartan script accepts
  `spartan` and `PLAYWRIGHT_CORE_PATH` if Playwright is supplied externally.
  Handrail's task-configuration tool currently rejects Spartan as outside this
  run's config scope despite the group authorization. No Spartan task was created.
- When replacing this local candidate inside an already-used development checkout,
  restart Vite and invalidate its generated `node_modules/.vite/deps*` cache if it
  serves stale exports. The first real Mills browser check found exactly that
  failure; the generated cache was moved aside and the service restarted.
- Required database migration order, worker compatibility and retention are in
  [installation and upgrade](parity-installation-and-upgrade.md). No staging or
  production database migration was performed. Legacy UI fallback remains available;
  rolling an old SDK worker over newer execution records is not an equivalent rollback.

Publishing, committing/pushing, PR creation and deployment remain separate
owner-authorized steps after the remaining acceptance work. The checked-in
handoff files may be newer than documentation embedded in the unchanged archive;
the artifact hash and executable package bytes remain the qualification identity.

## Follow-up platform audit

The SDK's `docs/parity-platform-dependencies.md` now records the primary Handrail
receipt contract, exact schema/pricing limitations, and current runtime/config
blockers. Recorded transcription already queues v1 receipts; realtime voice
currently retains evidence only and still needs receipt delivery. Neither path
has verified audio-specific billing. The Mills runtime still lacks its generated
provider/model, and Spartan task creation is still rejected despite current group
configuration permission. No platform code or credentials were changed.
