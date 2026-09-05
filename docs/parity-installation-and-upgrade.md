# Current parity candidate: installation and upgrade

This is a local, unpublished 0.2.7 candidate. It does not authorize deployment or
replace live provider, browser, device, or billing qualification.

Both web hosts use `file:vendor/handrail-ai-assistant-0.2.7-parity.5683009ec79b.tgz`.
Its SHA-256 is
`5683009ec79b0fde28bfd119737fa68ea8985155ba27d0b990b3cf7fecfe2102`.
The host manifests, lockfiles, archive and provenance file must travel together.
The filename/version alone is not an immutable release identity; verify the hash.

## Installation evidence

The current **5683009ec79b** candidate passed all four clean installs on
2026-09-05. This includes the shared web/native voice workspace observers,
voice tool activity and read receipts, and client replacement cleanup.

On Node 22.23.1/npm 10.9.8, isolated copies of each host's current manifest,
lockfile, scripts and referenced archive passed both commands:

```sh
npm ci --include=dev --no-audit --no-fund --prefer-offline
npm ci --omit=dev --no-audit --no-fund --prefer-offline
```

Development and production used separate empty install directories. Scripts were
enabled, including Spartan's existing financial-package patch. In every install,
all 24 JavaScript package export entry points loaded and all 317 package files
matched the archive. See [machine-readable evidence](parity-install-evidence.json).
This proves package installation/imports, not a production application build or
provider connectivity. Any subsequent SDK artifact change needs this check again.

## Database ownership and order

The SDK supplies `handrailPostgresSchemaV1` and
`PostgresAiPersistence.migrate()` from its Postgres persistence export. The
published schema version is 1. These APIs supply SDK tables; application plugins
continue to own their business tables and domain constraints.

The hosts have journaled copies of that schema:

| Host | Required migrations | Existing deployment command |
| --- | --- | --- |
| Mills web | 0096 SDK storage; 0098 domain proposal executing/failed statuses, plus all intervening host migrations | `npm run db:migrate` |
| Spartan web | 0108 SDK storage and 0109 attachment storage, plus all other host migrations | `npm run db:migrate` after the server build; `npm run db:migrate:dev` for a configured development environment |

Use each host's full migration journal in order. Do not apply only these numbered
files to a production database. Run a single authorized migration job before
starting the updated application workers. The SDK's `migrate()` executes its
idempotent statements sequentially; it is not an application-wide deployment
lock or a guarantee that concurrent migration jobs are safe. No database command
was run against a deployed host during this qualification.

Both hosts now have checks comparing their actual migration output with the
installed SDK's columns, constraints, and indexes. They also verify that applying
the SDK schema over the host schema preserves a retained execution document.
Mills additionally checks its SDK-storage migration journal, repeated application,
empty-schema rollback/reapplication, and atomic synchronized event admission.

## Compatibility while preserving both assistant modes

All workers sharing an SDK execution/outbox scope must run the compatible
candidate together. Drain older active runs before upgrading. Earlier SDK workers
can ignore committed execution claims or fail to understand delivered outbox
records. Returning the UI to the existing assistant is supported; rolling an old
SDK worker over new SDK records is a different operation and is not a supported
fallback without a compatibility patch.

Keep stable execution and receipt IDs and retain their claim/result/delivery
records for as long as the originating work can replay. Missing completed results
remain uncertain; deleting claims or choosing a fresh ID is not recovery.
See [integration compatibility](integration-migration.md) for the precise ledger,
fingerprint and usage-outbox rules. Mills' 0098 down migration refuses to remove
execution status support while executing/failed proposals remain.

Mobile apps use the vendored shared Dart client and the host's protected APIs;
they do not migrate the host database. Upgrade the server's routes and storage
before enabling a new SDK mobile capability. Keep the existing mobile assistant
mode available for comparison. Voice recovery requires the matching Mills call
status/end routes; an older server is not proof that a saved call has ended.

Publishing the SDK, committing/pushing repository changes, changing deployed
configuration, and deploying either host still require the owner's authorization.
