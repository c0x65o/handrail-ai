# AI Assistant 0.2 rollout qualification

Updated: 2026-09-04

This record separates source/API qualification from immutable release and
runtime rollout. A local packed candidate proves code compatibility but is not
a production package pin.

## Readiness matrix

| Target | Standard server | Standard UI | Recovery / telemetry | Compile and focused behavior | Immutable 0.2 pin | Status |
| --- | --- | --- | --- | --- | --- | --- |
| SDK | `createHandrailAssistant` | styled default + headless escape | durable outbox, worker, trusted-context recovery | passed | no release commit | candidate qualified |
| Mills Family Office | high-level composition | page presentation of standard launcher | trusted-session recovery; SDK outbox | passed | still `@handrail/ai` 0.1.91 | architecture qualified; release blocked |
| Spartan Cyber ERP | high-level Aegis adapter | standard launcher is default; legacy rollback | trusted-session recovery, Postgres pub-sub, authoritative receipt test | passed | still `@handrail/ai` 0.1.91 | architecture qualified; release blocked |
| Remaining projects | standard template required | styled default unless documented headless exception | Handrail binding + same outbox contract | not run | not installed | not started |

Both real consumers pass the source architecture findings of
`handrail-ai-assistant check`. They intentionally fail its package, immutable
source, lockfile, and legacy-name findings until a real reviewed 0.2 commit SHA
exists. The migration command has been run in preview mode and reports only the
expected manifest/import rewrite set. Do not use an alias or fabricated SHA to
make the gate green.

## Verification evidence

SDK candidate:

- `npm run typecheck`
- `npx vitest run test/react-styled.test.tsx` — 13 passed
- `npx vitest run test/server-assistant.test.ts` — 4 passed
- `npx vitest run test/postgres-assistant-foundation.test.ts` — 5 passed
- `npm run check:adoption-tool` — 3 passed
- `npm run check:package-contract` — 30 passed
- `npm run check:vite-consumer` — passed

Mills real consumer:

- `npm run typecheck` — passed
- `npx vitest run src/server/assistant/handrail-ai-gateway.test.ts` — 10 passed
- `npx vitest run src/server/assistant/handrail-ai-gateway-postgres.test.ts` — 4 passed
- source conformance findings for high-level server, automatic telemetry,
  recovery/shutdown, and standard styled UI — passed

Spartan real consumer:

- `npm run typecheck` — passed
- `npm test -- --run tests/aegis.test.ts` — 69 passed
- `npm test -- --run tests/aegis-handrail-ai-ui.test.ts` — 1 passed
- `npm test -- --run tests/aegis-handrail-ai-postgres-live-delivery.test.ts` — 1 passed
- `npm test -- --run tests/aegis-auth-composition.test.ts` — 2 passed
- `npm test -- --run tests/aegis-close.test.ts` — 14 passed
- focused default-client configuration test — passed
- source conformance findings for high-level server, automatic telemetry,
  recovery/shutdown, and standard styled UI — passed

The mounted Spartan high-level test sends reported provider usage through the
actual SDK durable receipt path and verifies the Telemetry URL plus authoritative
organization, project, service environment, user, session, provider, model,
conversation, turn, and token values. SDK tests prove transient retry, startup
drain, durable attempt retention, acknowledgement, and permanent-failure
dead-letter behavior. The supplied Handrail AI Runtime report screenshots prove
runtime receipt visibility for Mills and Spartan; post-release observation must
still cover successful, failed, and cancelled traffic over time.

## Release gate

The next authorized release operator must:

1. review the SDK diff and create the immutable 0.2 release commit/tag;
2. record its full 40-character SHA and package integrity;
3. run the migration CLI with `--write` in Mills, regenerate its lockfile, clean
   install, rerun the listed Mills checks, and rerun conformance;
4. repeat only after Mills is green for Spartan, then rerun the listed Spartan
   checks and conformance;
5. publish `docs/adoption-standard.md` to the Handrail Knowledge Base and record
   entry ID/revision here;
6. perform a staging rollback rehearsal and compare AI Runtime invocation and
   receipt counts before any broader batch begins.

No commit, push, tag, deployment, Knowledge Base publication, or production
observation was performed by this qualification run.

## Bounded remaining rollout

After Mills and Spartan are immutable-pin and runtime qualified:

1. select two low-risk applications with different auth/tool shapes;
2. scaffold or migrate them with the CLI, allowing only the documented host
   seams;
3. stop on any conformance, auth isolation, usage, recovery, or rollback gap;
4. if both pass, proceed in batches of five;
5. start no later batch until every project in the previous batch has an
   approved SHA, clean lock, UI mode, test record, receipt parity, and rollback
   result.

Track each application as `not_started`, `integrating`, `shadowing`,
`qualified`, `rolled_back`, or `blocked`. Approximately thirty installations
are an inventory target; completed evidence, not dependency count, is the
rollout outcome.

## Open external gates

- Immutable package release: blocked by the explicit no-commit/no-push
  constraint for this run.
- Consumer dependency rename and clean lockfiles: depend on that immutable SHA.
- Handrail KB publication: no KB write API is available in this Dev Chat. The
  canonical source is ready, and guarded workflow-improvement proposal
  `c54f01ee-e497-4866-872f-886e42598c23` records the publication gap.
- Staging/runtime observation and the remaining-project inventory: require
  deployment/release authority and project selection beyond the three repos in
  the AI Chatbot group.
