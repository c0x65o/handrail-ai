# @handrail/ai

`@handrail/ai` is a headless-first TypeScript SDK for provider-neutral chat
state, durable event replay, streaming transports, bounded application tools,
image attachment references, retries and cancellation, and normalized usage
output. UI is optional: the core runtime has no React or styling dependency.

Node.js 20 or newer is required for package tooling and trusted-server use.

## Supported entry points

| Import | Purpose | Runtime boundary |
| --- | --- | --- |
| `@handrail/ai` | Protocol, conversation runtime/store, event-store and sync contracts, direct transport, tools, presence, retry, and usage APIs | Runtime-neutral core; direct-provider construction is trusted-server only |
| `@handrail/ai/browser` | IndexedDB event store and browser image intake/upload helpers | Browser only |
| `@handrail/ai/react` | Optional unstyled React bindings and accessible composable primitives | Browser/React; React is an optional peer |
| `@handrail/ai/server/managed` | Optional Handrail AI Runtime v1 streaming transport | Trusted server only |
| `@handrail/ai/providers/openai` | OpenAI provider adapter | Trusted server only |
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
image intake/removal, and send, Stop, and Retry controls. Presentation close or
tab-hide handlers only change local visibility; authoritative cancellation is
reserved for the explicit Stop action. The fake transport and uploader are
deterministic and perform no network, provider, or Handrail control-plane call.

The SDK injects no CSS, fonts, branding, layout, or theme. Every `app-*` class
in the recipes is a consumer-owned placeholder. Responsive layout, breakpoints,
drawer/launcher placement, and all visual styling remain the host application's
responsibility.

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

An image `content_ref` is an opaque identifier matching
`AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR`; it is neither a URL nor image bytes.
The durable conversation log stores safe attachment metadata, not binary data,
browser `File` objects, signed URLs, provider-native blocks, or secrets. A host
owns intake, upload, authorization, retention, and resolution to provider input.
The browser entry point supplies intake/upload helpers, but support is usable
only when a negotiated transport or application adapter supplies the matching
capability. MIME, byte, and count limits are exported with the protocol.

### Tools

Tool discovery does not authorize execution. `ToolRegistry` exposes only
definitions selected for the current context; `BoundedToolExecutor` separately
applies schema validation, application policy, time/concurrency/result limits,
and a `ToolExecutionLedger`. Production ledgers must make a repeated tool-call
ID return the first execution promise/result. `runToolLoop` adds bounded
continuations and records public lifecycle evidence, but the application still
owns tool side effects and external approval.

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

The SDK intentionally does not supply an application database, cross-device
event service, production tool ledger, file/object storage, attachment access
policy, provider credential store, managed-token issuer, pricing catalog,
billing system, or Handrail control-plane client. React presentation is
optional and unstyled. MCP tools may be adapted through a separately versioned
connector; this package does not absorb ownership of that connector.

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
