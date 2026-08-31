# @handrail/ai

`@handrail/ai` is a headless-first TypeScript SDK for provider-neutral chat
state, durable event replay, streaming transports, bounded application tools,
provider-neutral image and PDF attachment references, structured citations,
optional provider-context compaction, conversation lifecycle contracts, speech,
retries and cancellation, and normalized usage output. UI is optional: the core
runtime has no React or styling dependency.

Node.js 20 or newer is required for package tooling and trusted-server use.

## Supported entry points

| Import | Purpose | Runtime boundary |
| --- | --- | --- |
| `@handrail/ai` | Protocol, conversation runtime/store/catalog, citations, provider-context, approval, transcription, realtime voice, web-search, event-store and sync contracts, tools, presence, retry, and usage APIs | Runtime-neutral core; direct-provider construction and side effects are trusted-server only |
| `@handrail/ai/browser` | IndexedDB stores plus generalized image/PDF attachment intake, audio capture, and WebRTC voice helpers | Browser only; no provider credentials or server-side tool execution |
| `@handrail/ai/client` | Application-gateway transport and language-neutral wire types | Browser, React Native, and other Fetch/stream clients |
| `@handrail/ai/react` | Optional unstyled React bindings and accessible composition seams for chat, citations, conversation picking, approvals, transcription, and realtime voice | Browser/React; React is an optional peer |
| `@handrail/ai/react/styled` | Optional responsive styled launcher/dialog/drawer/page preset | Browser/React; theme variables and renderers are application-owned |
| `@handrail/ai/server/application-gateway` | Express-compatible adapter for the web-standard streaming gateway | Trusted application server only |
| `@handrail/ai/server/application` | One-call trusted assembly for plugins, MCP connectors, policy, approvals, bounded tools, runtime, and gateway routing | Trusted application server only |
| `@handrail/ai/server/managed` | Optional Handrail AI Runtime v1 streaming transport | Trusted server only |
| `@handrail/ai/server/trusted-server` | Framework-neutral request protection contracts | Trusted server only |
| `@handrail/ai/connectors/mcp` | Injected-client MCP tool-plugin/discovery adapter | Optional connector boundary |
| `@handrail/ai/persistence/postgres` | Injected-client reference Postgres persistence | Optional database boundary |
| `@handrail/ai/providers/openai` | OpenAI Chat Completions and Responses adapters, including hosted/deferred tool projection | Trusted server only |
| `@handrail/ai/providers/openai/transcription` | OpenAI transcription capability | Trusted server only |
| `@handrail/ai/providers/openai/realtime` | OpenAI realtime bootstrap, event normalization, and session authority | Trusted server only |
| `@handrail/ai/providers/anthropic` | Anthropic provider adapter | Trusted server only |
| `@handrail/ai/providers/gemini` | Gemini provider adapter | Trusted server only |
| `@handrail/ai/providers/xai` | xAI provider adapter | Trusted server only |

The provider subpaths accept application-injected request functions rather than
installing provider SDKs. This keeps the application in control of provider SDK
versions, server configuration, and credential resolution.

## Headless quickstart

Supply a `ConversationTransport` and a `ConversationEventStore`, then create one
runtime per conversation. `createConversationRuntime` hydrates its store by
replaying durable history before it resolves; it does not start a network
observation. The process-local store below is suitable for examples and tests.
Use an application-owned durable adapter in production (or
`IndexedDBConversationEventStore` from `@handrail/ai/browser` for local browser
persistence).

```ts
import {
  InMemoryConversationEventStore,
  createConversationRuntime,
  type ConversationClientId,
  type ConversationId,
  type ConversationState,
  type ConversationTransport,
} from "@handrail/ai";

declare const transport: ConversationTransport<unknown, AppRequest>;
declare const request: AppRequest;
declare function render(state: ConversationState): void;
declare function showCount(count: number): void;
interface AppRequest { readonly prompt: string }

const runtime = await createConversationRuntime({
  conversationId: "conversation-42" as ConversationId,
  clientId: "web-7" as ConversationClientId,
  eventStore: new InMemoryConversationEventStore(),
  transport,
});

const unobserve = runtime.observe((state) => render(state));
const unselect = runtime.store.select(
  (state) => state.messages.length,
  (messageCount) => showCount(messageCount),
);

try {
  await runtime.restoreActiveTurn();
  await runtime.sendMessage({ content: "Hello", request });
} finally {
  unselect();
  unobserve();
  runtime.destroy();
}
```

The complete credential-free example at
[`examples/headless-runtime.ts`](./examples/headless-runtime.ts) is checked
against the built package declarations. It also demonstrates:

- an injected fake streaming transport and event store;
- automatic hydration, `restoreActiveTurn`, and explicit `resumeTurn`;
- `observe`, `getSnapshot`, and selector subscriptions;
- text plus an opaque image attachment reference;
- `ToolRegistry`, `BoundedToolExecutor`, and `runToolLoop` with explicit limits,
  application policy, and an idempotent execution ledger;
- `stopObserving` versus authoritative `cancelTurn`;
- cleanup and deduplicated `NormalizedUsageReceipt` consumption.

`sendMessage` durably records the local message and attachment facts, while its
`request` is the provider-neutral transport input. The checked example keeps
the protocol image's `content_ref` opaque and records only attachment metadata
in conversation history.

## Unstyled React presentation recipes

The checked [`examples/react-presentations.tsx`](./examples/react-presentations.tsx)
uses the public `@handrail/ai` and `@handrail/ai/react` declarations to compose
one credential-free headless runtime as six presentations:

- `ChatDialogRecipe` for a modal;
- `ChatTabsRecipe` for a tab panel;
- `ChatDrawerRecipe` for a side drawer;
- `ChatLauncherRecipe` for a floating disclosure;
- `FullPageChatRecipe` from semantic chat primitives; and
- `CustomHooksChatRecipe` from native application markup plus hooks/selectors.

The recipes include named transcripts, live status, presence and typing,
image/PDF intake and removal, and send, Stop, and Retry controls. Presentation close or
tab-hide handlers only change local visibility; authoritative cancellation is
reserved for the explicit Stop action. The fake transport and uploader are
deterministic and perform no network, provider, or Handrail control-plane call.

The unstyled entry injects no CSS, fonts, branding, layout, or theme. Applications
that want a ready surface can import the one-component `HandrailChat` (runtime,
uploader, and request builder in; complete chat surface out) or `StyledChatPreset` and
`StyledChatPresetStyles` from `@handrail/ai/react/styled`; every visual can still
be replaced through the unstyled entry, CSS custom properties, slots, and tool
result renderer keys.

## Application-owned gateway and mobile clients

`createApplicationGateway` exposes protected capability, start, resume, and
authoritative cancellation endpoints as web-standard `Request`/`Response`
handling. `createApplicationGatewayTransport` supplies the matching browser or
React Native transport, including protected-request hooks and negotiated Blob
uploads. The server does not depend on Express; the optional structural adapter
and [`examples/trusted-server-application-gateway-express.ts`](./examples/trusted-server-application-gateway-express.ts)
show an Express mount. `createApplicationGatewayResourceClient` adds typed
conversation lifecycle, approval, synchronization, and title APIs; attachment,
presence, and turn streaming remain negotiated transport capabilities.

See [`docs/wire-protocol.md`](./docs/wire-protocol.md) for the language-neutral
contract and `flutter/handrail_ai_client` for the tested Dart implementation.
See [`docs/platform-contracts.md`](./docs/platform-contracts.md) for security,
compatibility, package boundaries, and production persistence guidance. The
read-only Spartan Aegis mapping is in
[`docs/spartan-aegis-migration.md`](./docs/spartan-aegis-migration.md).

## Direct/BYOK and managed operation

Both credential modes belong on an application-owned trusted server. Browser
and mobile code must call that application server. Never put provider
credentials, managed tokens, or authorization headers in client code, public
configuration, logs, telemetry, source control, or client-visible responses.

### Direct/BYOK on a trusted server

Create one of the four provider adapters on the trusted server, then inject it
into `createDirectProviderTransport`. The host supplies authoritative request,
trace, tenant attribution, and usage-attempt identities. It also resolves
opaque attachment references before provider-native input is constructed.

The checked
[`examples/trusted-server-transports.ts`](./examples/trusted-server-transports.ts)
accepts a `ProviderAdapter` from the host and builds the direct transport
without a live provider call or credential literal. Provider-specific adapter
factories are available from the four `@handrail/ai/providers/*` entry points
listed above.

The direct transport supports authoritative cancellation for active turns in
the current server process. It deliberately has no provider replay store, so a
host requiring reconnect or cross-process resume must supply that durable
server boundary rather than treating local disconnection as provider
cancellation.

### Optional managed runtime on a trusted server

`createManagedRuntimeTransport` from `@handrail/ai/server/managed` calls the
public Handrail AI Runtime v1 endpoint. Its `fetch` and per-request `getHeaders`
dependencies must be injected by trusted-server infrastructure so rotation and
authorization policy stay outside browser/mobile bundles. The checked trusted
server example accepts both dependencies instead of embedding either.

The managed transport keeps resume snapshots in a process-local map as its fast
path and backward-compatible fallback. Cross-instance restoration after a
refresh or process restart requires an optional trusted-server
`turnStateStore`, which durably retains only the validated replay identity and
canonical request body. The transport negotiates authoritative cancellation,
attachment upload, presence, and synchronization as unsupported. Applications
must inspect `transport.capabilities` and provide host adapters where required;
unsupported capabilities must not be inferred from method names or UI state.

## Lifecycle and consistency contracts

### Durable history and multi-device synchronization

Conversation events are durable, ordered facts. A `ConversationEventStore`
must atomically append contiguous revisions, reject conflicting writes, and
return the original fact for an identical retry. Checkpoints compact replay;
they do not replace the canonical event log. The reference in-memory adapter is
not durable.

Multi-device persistence and delivery remain host responsibilities. Implement
`ConversationEventStore` against application storage and, when devices need to
converge, provide a `ConversationSyncAdapter` to exchange canonical event
envelopes. Retry with stable event IDs, client mutation IDs, idempotency keys,
and logical request/attempt identities. Replayed or redelivered facts must be
idempotent; never retry a side effect under a fresh identity merely because a
connection ended.

Presence and typing are ephemeral signals. They are intentionally outside the
durable log and may expire, coalesce, or disappear across disconnects. Do not
reconstruct authoritative messages or turn state from presence records.

### Disconnect, resume, retry, and cancellation

- `stopObserving(turnId)` interrupts only this runtime's local stream
  observation. Durable history is unchanged and the remote turn may continue.
- `resumeTurn(turnId)` reconnects from the latest durable checkpoint when the
  transport can replay that turn. `restoreActiveTurn()` finds the durable
  nonterminal turn after hydration and attempts the same recovery.
- Runtime retries are bounded and reuse the original idempotency identity.
  Transports and servers must make duplicate start/resume operations safe.
- `cancelTurn(turnId, reason)` requests authoritative cancellation only when
  the negotiated capability supports it. Check its structured result:
  `unsupported` and `failed` both mean the remote operation may still run.
- `destroy()` disconnects observations, releases subscriptions, and makes the
  runtime unusable. It is cleanup, not an authoritative remote cancellation.

### Attachments

`AttachmentReference` and conversation content represent images and documents
with provider-neutral metadata. Document support currently begins with
`application/pdf`. Every `content_ref` is an opaque identifier matching
`AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR`; it is neither a URL nor binary content.
Durable conversation events retain only bounded metadata such as kind, media
type, byte size, dimensions/page count, and the opaque reference. Binary image
or document contents, browser `File` objects, signed URLs, and provider-native
blocks never belong in SDK durable metadata.

The host owns binary resolution, file/object storage, authorization, access
revocation, and retention. It must apply the exported MIME, byte, and per-request
count limits before upload and again at trusted resolution. `AttachmentUploader`
adds bounded concurrency, progress reporting, retry of explicitly retryable
failures, and cancellation. Browser helpers include `intakeFileInputImages`,
`intakeDroppedImages`, `intakeClipboardImages`, `intakeFileInputPdfs`, and
`intakeDroppedPdfs`; they validate and fingerprint selections without turning
local files into durable conversation data.

Document behavior is negotiated, never inferred from an adapter class, method,
or UI control. Inspect `ProviderModelCapabilities` and its `document_input`
field, the matching transport capability, MIME list, count/byte bounds, and
`requires_host_resolution` before enabling PDF submission.

| Adapter | Current PDF/document behavior | Provider-context compaction |
| --- | --- | --- |
| OpenAI | Supported only when `OpenAIProviderAdapterOptions.document_input` explicitly configures `application/pdf` and a trusted host supplies `resolve_document_reference`; otherwise unsupported | Supported only when both injected measurement and compaction operations are configured |
| Anthropic | Explicitly unsupported by the built-in adapter | Explicitly unsupported |
| Gemini | Explicitly unsupported by the built-in adapter | Explicitly unsupported |
| xAI | Explicitly unsupported by the built-in adapter | Explicitly unsupported |

These declarations describe the built-in adapters, not every upstream model or
future host adapter. A host may supply another adapter, but callers must still
negotiate its declared capability rather than assuming support from API
presence.

#### `imageIntake` to `attachmentIntake` migration

The React composer migration is source-compatible. Use `attachmentIntake` for
generalized image/PDF selection. When both options are supplied,
`attachmentIntake` takes precedence. When `attachmentIntake` is omitted, the
existing image-only `imageIntake` behavior remains available; no immediate
versioned migration is required. The checked
[`examples/react-presentations.tsx`](./examples/react-presentations.tsx) uses
the generalized option.

### Structured citations and provenance

`CitationSource`, `Citation`, and `CitationRecordSet` are bounded,
provider-neutral records. Sources have a stable ID, `web`, `document`, or
`tool` type, a label, and an optional safe public URL or opaque locator.
Citations provide stable identity and deterministic order while linking a
source to an assistant message or tool result. Normalization validates public
URLs, rejects credential-bearing locators, and deduplicates deterministically.

Provider adapters and application tools project only normalized records; raw
annotations and provider-native payloads are not durable provenance. Runtime
turns persist normalized citation/source events alongside their target facts.
Optional `CitationList` and `CitationItem` React seams are accessible,
unstyled, and accept host render/activation policy; the React-free citation
model remains in `@handrail/ai`.

### Provider-context measurement and compaction

`ProviderContextCapability` and `ProviderContextCheckpointStore` are optional
provider-input acceleration boundaries. They are distinct from event-log
checkpoints: provider-context checkpoints never replace, truncate, summarize,
or otherwise mutate canonical conversation history. The canonical event log
remains the source of truth and is always sufficient to rebuild a turn after a
checkpoint is invalidated or discarded.

`ConversationRuntime` uses provider context only when a host supplies
`ConversationRuntimeProviderContextOptions` through `providerContext` and the
negotiated capability reports
`supported: true`. The fingerprint covers provider/model identity,
instructions, tools, generation settings, and relevant provider settings. It
binds a bounded opaque checkpoint to an exact canonical history position;
fingerprint or history drift, rewind, expiry, corruption, provider rejection,
or version mismatch invalidates the checkpoint. Checkpoints must not contain
prompts, instructions, tool definitions/results, credentials, or native
requests/responses.

Measurement, compaction, checkpoint save/invalidation, and runtime retries are
bounded. Stable idempotency keys and optimistic store versions make retries
safe, and the same abort signal defines cancellation across measurement,
compaction, persistence, and the subsequent turn start.
`InMemoryProviderContextCheckpointStore` is a bounded, non-durable reference
adapter. The OpenAI adapter's `createOpenAIProviderContextCapability` supports
this contract only when both host-injected measurement and compaction request
functions are configured. The built-in Anthropic, Gemini, and xAI adapters
explicitly report unsupported; use a host-supplied adapter to add support
elsewhere.

### Conversation catalog and runtime ownership

`ConversationCatalog` is a storage-neutral lifecycle contract. Its `list`,
`create`, `get`, `rename`, `clear`, `archive`, `restore`, and
`permanentlyDelete` operations specify pagination/ordering, bounded metadata,
capability checks, optimistic versions, idempotency, and
authorization-before-disclosure hooks without requiring a database.
`InMemoryConversationCatalog` is a bounded, process-local reference for tests
and development; it is non-durable. Persistence, authorization, and the
separate content-clearing operation are host-supplied.

`ConversationTitleGenerationService` invokes an optional bounded host title
hook and falls back deterministically to sanitized first-user text or
`DEFAULT_CONVERSATION_TITLE`; catalog titles are labels, not transcript
storage. Hosts should use `ConversationRuntimeRegistry` (or an equivalent
host coordinator) to maintain one `ConversationRuntime` per open conversation,
share concurrent `open` calls, and clean up runtimes across `release`, archive,
clear, deletion, and `dispose`. `ConversationPickerRoot` and its companion
primitives plus `useConversationPicker` provide optional accessible, unstyled
composition; they do not add storage, authorization, or a database.

### Tools

Tool discovery does not authorize execution. `ToolRegistry` exposes only
definitions selected for the current context; `BoundedToolExecutor` separately
applies schema validation, application policy, time/concurrency/result limits,
and a `ToolExecutionLedger`. Production ledgers must make a repeated tool-call
ID return the first execution promise/result. `runToolLoop` adds bounded
continuations and records public lifecycle evidence, but the application still
owns tool side effects and approval policy.

### Durable human approval

Approval proposals move through `pending`, `confirmed`, `rejected`, `expired`,
`executing`, `executed`, and `failed` statuses. Proposals may carry a group ID,
an expiration, an optimistic version, and either bounded redacted reviewed
arguments or an opaque host reference/digest to sensitive arguments. Never put
sensitive tool inputs into proposal metadata or audit events.

`ApprovalProposalStore` is host-persistable;
`InMemoryApprovalProposalStore` is bounded and non-durable.
`createApprovalCoordinator` performs permission-checked, versioned,
idempotent confirm/reject/expire decisions for one proposal or a group.
`createApprovalExecutionCoordinator` lets `BoundedToolExecutor` resume only an
exact confirmed proposal, re-authorize it, verify its argument binding, claim
execution, and record a terminal result. Stable proposal, decision, and
execution identities make confirm, reject, claim, settlement, retries, and
restart/resume idempotent; a failed execution can be explicitly reclaimed
through a new version. Expired, mismatched, stale, rejected, or unauthorized
proposals cannot execute.

Model output and tool discovery never authorize side effects. The trusted host
must perform permission checks at proposal reads/decisions and again before
execution. `ApprovalReviewRoot` and its companion primitives plus
`useApprovalReview` expose accessible unstyled review/grouping seams; they do
not execute tools or decide permissions.

### Transcription

`TranscriptionCapability` accepts one bounded, validated opaque audio reference
with negotiated format/size/duration limits, an abort signal, and a stable
idempotency key. A trusted host resolves bytes only for the operation and maps
failures to safe errors. Retries must reuse the logical identity; cancellation
does not authorize a retry under a new identity. The OpenAI implementation is
available from `@handrail/ai/providers/openai/transcription` through
`createOpenAITranscriptionCapability` with injected resolution and request
functions.

`createBrowserAudioCaptureController` and `intakeBrowserAudio` provide bounded
browser capture/intake without provider credentials. `TranscriptionControlsRoot`
and its optional unstyled companion primitives coordinate capture, host upload,
negotiated transcription, retry, cancellation, and host-owned transcript
application. The credential-free checked recipe is
[`examples/react-transcription.tsx`](./examples/react-transcription.tsx).

### Realtime voice

The provider-neutral realtime contract negotiates WebRTC audio, interruption,
and server-tool capabilities. The host owns an authenticated bootstrap endpoint
and returns only short-lived opaque browser authorization and connection data.
`createBrowserRealtimeVoiceController` manages client media/session state; it
does not receive provider credentials or server tool callbacks. Credentials
and realtime server-side tool execution must stay off clients.

The trusted-server OpenAI entry provides `createOpenAIRealtimeServer` for
authenticated bootstrap, normalized events, and authoritative hangup/cleanup.
`createIdempotentRealtimeVoiceSessionAuthority` makes hangup terminal and
idempotent. A host must invoke authoritative hangup even after local microphone
or peer-connection cleanup, and must bound duration/idle time, revoke provider
resources, stop local media, and make cleanup safe to repeat.
`createRealtimeVoiceServerToolBridge` keeps server tools behind registered
session capabilities, bounded parsing/execution, approval and permission hooks,
idempotent call bindings, cancellation, and safe results; client events are
untrusted requests, not authorization. `RealtimeVoiceControlsRoot` and its
optional unstyled companion controls are shown in
[`examples/react-realtime-voice.tsx`](./examples/react-realtime-voice.tsx).

### Bounded web search

`WebSearchService` orchestrates one injected trusted-server `WebSearchAdapter`.
The SDK does not operate, deploy, or credential an external search provider.
The host authorizes each query, owns HTTP/provider SDK behavior, validates every
result and redirect URL (including DNS/private-network policy), and applies its
result policy. The service enforces bounded query/result/payload sizes,
deadlines, timeouts, cancellation, and bounded idempotency retention; it
deterministically deduplicates accepted source IDs and effective URLs.

`createWebSearchToolRegistration` exposes the service as an optional bounded
tool, and `createWebSearchCitationRecords` projects accepted results into
normalized ordered citations. The credential-free
[`examples/protected-web-search.mjs`](./examples/protected-web-search.mjs)
uses a deterministic injected adapter and performs no external search or other
live network operation.

### Versioned trusted-server request protection

`TRUSTED_SERVER_REQUEST_PROTECTION_VERSION` and
`createTrustedServerRequestProtectorV1` define a framework-neutral protected
request pipeline. Hosts inject origin validation, authentication,
authorization, rate limiting, idempotency reservation/settlement, concurrency
leases, deadlines/cancellation, deterministic public errors, and a bounded
terminal-retention hook. The hook receives public identifiers and outcomes,
not request/result bodies, credentials, or sensitive inputs. These contracts do
not mandate a web framework, database, network topology, or deployment model.

### Normalized usage outputs

`NormalizedUsageReceipt` represents one provider invocation and preserves the
conversation, turn, logical request, retry attempt, and tool-continuation
identities needed for deduplication. Deduplicate by `usage_receipt_id`. Token
and exact base-10 cost fields distinguish `reported`, `estimated`, and
`unavailable`; a known zero is not unknown, and cost strings must not be
converted to floating point.

Receipts are telemetry and attribution outputs, not settlement. Pricing,
metering settlement, credits, billing, ledgers, databases, and Handrail
control-plane policy remain owned by a later Handrail convergence loop and are
not implemented as authoritative behavior in this package.

## Host-supplied boundaries

Deployment, file/object storage, authentication implementation, provider
credentials, external-service operation, databases, application-specific
authorization/retention policy, cross-device delivery, and production side
effect ledgers remain host-owned and outside this package. The SDK does not
mandate a web framework or infrastructure. It also does not supply a managed
token issuer, pricing catalog, billing system, or Handrail control-plane
client. MCP tools may be adapted through a separately versioned connector; this
package does not absorb ownership of that connector.

Durable metadata, checkpoints, catalog rows, approval/audit records, usage
records, errors, logs, and telemetry must not retain binary image/document
contents, audio, transcripts, prompts, credentials, hidden instructions,
sensitive tool inputs/results, or provider-native internals. Canonical
conversation events may retain host-selected user-visible message content as
the conversation itself; that explicit product retention is separate from SDK
operational metadata and remains governed by host authorization and retention
policy. Opaque references are identifiers, not permission to copy referenced
content into metadata. Do not log any of the sensitive values listed above.

The React entry is optional and unstyled, while the core remains React-free.
All linked examples are deterministic, credential-free repository examples;
none deploys infrastructure, operates an external service, or performs a live
provider request.

## Development

```sh
npm install
npm run build
npm run check:examples
npm run check:package-contract
npm run check:vite-consumer
npm run typecheck
npm test
npm run lint
npm run pack:dry-run
```

## License

Copyright (c) Handrail. All rights reserved. See [LICENSE](./LICENSE).
