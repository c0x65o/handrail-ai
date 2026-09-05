# Voice activity across conversations

Voice calls and text turns are independent. The SDK's voice workspace observers
read call lifecycle, tool counts and completion/unread evidence. They never run a
provider operation, cancel a text turn, acknowledge voice results, or update text
read receipts. Hosts authorize the requested conversations and supply transport.

## Default web UI

Pass stable `voiceActivity` options to `HandrailAssistantLauncher`:

```tsx
const voiceActivity = useMemo(() => ({ readPage: readAuthorizedVoicePage }), []);
return <HandrailAssistantLauncher endpoint="/assistant" clientId={accountScopedClientId}
  voiceActivity={voiceActivity} />;
```

`readPage({conversationIds, after, signal})` returns `{calls, next}`. Calls contain
`conversationId`, `callId`, `status`, `counts` (total/running/completed/failed) and
`unread`. The cursor contains conversationId/callId. No provider reference, tool
arguments, business result or read token belongs in this feed. The host should
use its authenticated, uncached transport and honor the AbortSignal.

The launcher discovers the active authorized catalog, polls even while its panel
is closed, and disposes observation when its client changes or it unmounts. Change
clientId or remount when account/environment/permission context changes. Mills
binds its client ID to household, user and role. Prior client UI, uploaders and
observation are discarded during replacement; a late bootstrap client is disposed
before catalog work begins.

Default summaries appear on the launcher and Threads control, plus each thread.
They distinguish active calls, unconfirmed termination, unread results and
unresolved tool outcomes. Failed refreshes retain evidence, report a retry message
and label active counts as last reported. `onWorkingChange` includes known active
voice calls in addition to text work; voice never enables text cancellation.
`renderVoiceActivity(input)` replaces the summary; return null to hide it.
The input exposes summary, snapshot and optional conversationId.

This feed is observational. Selecting/opening a web thread clears only its text
read marker. Voice receipts require displaying the particular call's retained
activity and acknowledging its token through the host's authorized call endpoint.
Mills currently supplies that detailed review/acknowledgement in its mobile voice
sheet. Web workspace summaries do not imply a WebRTC session or mark calls read.

## Headless and custom presentation

`RealtimeWorkspaceMonitor` is exported from the core SDK. It supplies
getSnapshot/subscribe, refresh, start, setConversations and dispose. Provide
loadConversationIds for SDK-owned catalog discovery, or setConversations for a
host-owned list (the two modes cannot be mixed). Lower-level workspace components
accept a monitor as voiceActivity; the host owns starting/disposing that monitor.
`useRealtimeWorkspaceActivity` is exported from React and react-headless.
`summarizeRealtimeWorkspace(snapshot, conversationId?)` supplies the default
summary counters. `RealtimeWorkspaceActivity` is the reusable styled renderer.

Defaults are a 3-second interval, a 15-second request timeout, 100 conversation IDs
per request and 100 total feed pages. Input catalogs are bounded at 10,000 IDs;
page size is at most 50 calls. Missing/repeated/foreign/regressed or truncated
feeds preserve the prior complete snapshot rather than publishing partial idle
state. Requests are serialized and cancellable; scope changes/disposal ignore
late results even when an injected loader ignores abort. Catalog failures also
retain evidence. These limits surface a refresh error; they do not claim that an
unobserved call has stopped.

The Dart package supplies the corresponding HandrailRealtimeWorkspaceMonitor.
Mills mobile uses it for account-scoped background voice markers and keeps its
visible call-token acknowledgements separate. Spartan has no declared realtime
voice capability; vendoring these primitives does not enable one.

No new schema migration is required. The PostgresRealtimeWorkspaceActivityStore
reads existing SDK call/activity/read documents for explicitly authorized scopes.
