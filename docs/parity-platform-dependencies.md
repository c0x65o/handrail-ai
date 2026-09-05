# SDK parity: remaining platform dependencies

Read-only platform audit, 2026-09-05. The SDK candidate remains
`5683009ec79b0fde28bfd119737fa68ea8985155ba27d0b990b3cf7fecfe2102`.
This note is a concrete handoff; it is not permission to edit, deploy or publish
Handrail or Telemetry. Their repositories are outside the three-project edit
scope of this goal. Platform source was inspected through Handrail's explicitly
provided read-only `source=handrail` tools.

## 1. Mills generated development environment

The web service `3ccdfb88-5fca-47ad-a18a-85c08fd890c2` is correctly bound to repo
`11d64d24-119e-4500-ac6b-dadb3a102a7a`. Its dev OpenAI capability is enabled,
validates successfully and declares `APP_AI_PROVIDER` and `OPENAI_MODEL` as
available generated environment keys. The configured model is `gpt-6-astra`.
The running supervised Node process still lacks both keys after a typed update
that reapplied the unchanged model and a service restart. A full development
startup timed out while connecting.

The real SDK text attempt is preserved in task
`1681e6cd-1d9c-4e97-a7dc-ba30a20ea742`. Its domain message and SDK durable turn
are failed, with `ai_unavailable` and provider `failureStage=configuration`.
There was no successful provider reply. The passing browser mode-switch task is
`a8d716d1-a9ef-4273-8b9d-8b05999720ee`; it proves login/bootstrap only.

Platform source at revision `9cab30c311a8cc28c927f5edff7f9a9f818f08cd`:

- `src/server/runtime/service-runtime.js:565–578` builds local environment rows;
  a capability-generation exception becomes an empty array at line 575.
- `src/server/services/project-capabilities.js:5889–5919` reconciles service-bound
  AI Runtime identities before constructing generated environment rows.
- `src/server/services/project-capabilities.js:6074–6082` omits the OpenAI
  capability's rows when credential resolution yields no API key.

These are candidate failure boundaries, not proof of which internal branch ran.
Diagnose them in the Handrail runtime with secret-safe error classification.
Do not copy a Codex worker credential or hardcode a provider/model into the app
as a substitute for its declared capability.

Acceptance: the supervised app receives its declared provider/model plus its
proper platform-managed AI Runtime binding; the existing `text=true` dev task
returns exactly one answer after reload; correlate the invocation with a durable
Telemetry/Handrail receipt. A capability metadata row or a health 200 alone is
insufficient.

## 2. Spartan group configuration scope

Fresh `handrail_current_context` identifies AI Chatbot members as Mills and
Spartan with `allow_config_changes=true`, and SDK with it false. Nevertheless,
`handrail_configure_project_task` again rejects the reviewed, isolated,
dev-only Spartan browser task as outside the Codex run's config scope.
`list_project_tasks` confirms no parity task was created. The web service can be
started through the supported group-scoped service tool and passes health.

Reconcile the task tool's group authorization with the current context, preserving
the SDK project's prohibition on configuration changes. Then create the reviewed
`verify-assistant-parity-web` task using Spartan's existing dev Vault profile and
`scripts/qa-assistant-parity.mjs spartan`. Its default flow sends no provider
request and changes no domain records. Do not repurpose an unrelated working task
or retrieve credentials through an unsupported route.

## 3. Audio telemetry and pricing contract

The platform's `docs/AI_RUNTIME_USAGE_CONTROL.md:9–21` requires a version 1
receipt for each invocation, explicitly including transcription. Lines 30–37
make binding/token setup platform-owned. Lines 41–50 make price snapshots and
unknown-cost treatment platform-owned. `docs/AI_RUNTIME_BOUNDARIES.md:21–29`
retains pricing and billing ownership in Handrail.

The implementation at the same platform revision confirms a concrete limitation:
`src/server/services/ai-runtime-usage.js:14–15,237–265` allows only aggregate input,
cached input, optional cache-write input, output, reasoning and total token
quantities. Extra modality/duration token fields are rejected. Its cost function
at lines 77–102 uses aggregate per-million token prices; it has no audio/text
modality or duration calculation. Targeted source/migration searches found no
realtime/transcription audio model price entries. This is not proof about the
live price database, which was not queried.

Current host behavior must be described separately:

- Recorded Mills transcription already queues existing v1 token/unavailable
  receipts through the durable outbox, and separately retains provider audio
  evidence. This is not evidence of correct audio-specific pricing.
- Mills realtime `captureMillsRealtimeUsage` currently retains durable,
  attributed, deduplicated provider evidence only. It does not enqueue a
  Telemetry receipt. This remains an explicit implementation gap against the
  platform's every-invocation requirement.

Required platform decision/work: establish how real audio/text/cache/duration
quantities travel through receipt validation, durable Telemetry intake and
Handrail's immutable price/settlement ledger. Then implement that approved
projection and durable delivery in the SDK/hosts, including replay and a crash
between evidence retention and receipt enqueue. Do not claim pricing parity by
inventing seconds-to-tokens conversions, treating unknown cost as zero, or
adding fields that current intake rejects. Sending an aggregate receipt alone
would not prove the requested audio billing behavior.

## Goal status

The same external runtime/configuration dependencies have persisted across three
consecutive goal turns. The latest resumption verified the unchanged three-project
AI Chatbot scope, the running Mills web process, and the absence of its generated
`APP_AI_PROVIDER` and `OPENAI_MODEL` settings. Both host archives still match the
qualified `5683009ec79b` candidate. Prior Spartan action and platform source evidence
above remain unresolved; no additional provider/device/billing acceptance is claimed.

The goal is **blocked, not complete**. Resume when Handrail runtime configuration
and Spartan task authorization are repaired, and the audio receipt/pricing boundary
can be implemented through authorized platform/Telemetry work. The local SDK and
host changes, tests, immutable install evidence and owner testing instructions are
preserved. No commit, push, PR, publication or deployment was performed.
