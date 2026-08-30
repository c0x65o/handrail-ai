# Platform contracts and package boundaries

The stable contract versions introduced by this platform layer are `handrail.tool-plugin.v1`, `handrail.deferred-tools.v1`, `handrail.mcp-connector.v1`, `handrail.application-gateway.v1`, `handrail.live-presence.v1`, and Postgres schema version 1. Patch releases may add optional fields and event kinds. Breaking field meaning, removal, or wire changes require a new version string/export and a migration window.

## Boundaries

- `@handrail/ai` is provider/framework neutral: canonical events, runtime, transport/store contracts, tool plugins, deferred plans, and presence semantics.
- `@handrail/ai/client` is React-free and usable by browser/React Native environments.
- `@handrail/ai/react` remains unstyled; `@handrail/ai/react/styled` is optional and fully themeable.
- `@handrail/ai/server/application-gateway` adapts web-standard handlers to Express-like servers without depending on Express.
- `@handrail/ai/connectors/mcp` depends only on an injected MCP client subset.
- `@handrail/ai/persistence/postgres` depends only on an injected SQL client subset.
- Provider-specific payloads stay in provider entry points. Database, UI, provider, MCP, and application framework packages must never be imported by the runtime-neutral core.

## Capability negotiation

Clients call `/capabilities` before enabling cancellation, attachments, presence, or synchronization. Unsupported capabilities must not expose callable adapters. Attachment media types and byte/file limits are server authority; client checks are only UX. A protocol version mismatch fails closed.

## Security and privacy

Applications own authentication, conversation/tenant authorization, CSRF/origin checks, rate/concurrency limits, and idempotency fingerprints. Authorize discovery before revealing tool names and authorize execution immediately before the side effect. Treat schemas, tool output, web content, attachments, and persisted JSON as untrusted data. Provider keys and MCP credentials remain server-only.

Disconnecting a stream is not cancellation. Cancellation uses its own authorized, idempotent mutation. Resume only from a checkpoint durably applied on that device. Presence/typing is expiring and non-authoritative and must not enter transcripts, checkpoints, retention exports, or audit claims. Durable events, proposals, and execution results require tenant-scoped keys, atomic optimistic concurrency, defensive parsing, bounded reads, and encrypted transport/storage supplied by the host.

Postgres migrations run under an application-controlled role. Production deployments should add retention/partition policies, backups/PITR, monitoring, connection deadlines, row-level security where appropriate, and a transaction wrapper that guarantees rollback. The reference adapter never interpolates identifiers or values into data queries.
