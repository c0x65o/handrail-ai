# Package rename: `@handrail/ai` to `@handrail/ai-assistant`

Version `0.2.0` establishes `@handrail/ai-assistant` as the canonical package
identity. This is a name change, not a merge with the separate
`@handrail/chat` SDK.

Existing applications may keep an immutable `@handrail/ai` commit while they
remain in their rollback window. A migrating application changes its manifest
dependency key, every public import, and its lockfile atomically. It must not
install both names. Public subpaths and exported symbol names remain unchanged
in `0.2.0` so the import prefix is the only required source edit.

Use `scripts/adopt.mjs migrate-package <host> --write`, regenerate the host's
lockfile with its existing package manager, and run
`scripts/adopt.mjs check <host>`. The command intentionally does not select a
release SHA, run package installation, or convert server/UI architecture.

The first canonical release is `0.2.0`. Renaming a dependency key while it
still resolves an older package version is not a completed migration, even if
npm places that Git artifact under the new directory name. The conformance gate
rejects that state. Commit and review the `0.2.x` artifact first, then update
each host manifest and lockfile atomically.
