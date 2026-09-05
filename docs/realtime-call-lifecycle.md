# Durable realtime call lifecycle

`PostgresRealtimeCallStore` is a server-only store exported from
`@handrail/ai-assistant/persistence/postgres`. Scope it by environment and
authenticated owner; authorize conversation ownership on every HTTP use. Remote
provider references are private server data and must not be accepted from clients.
The existing SDK `handrail_ai_documents` migration supports the `realtime_call`
kind; no application-domain DDL or provider credential is supplied by this store.

1. `admit` binds one call identity to its conversation/settings fingerprint.
   Only a newly admitted call should proceed to creation. Unknown commit failures
   do not authorize a new provider call; a later read retains the original claim.
2. Commit `beginCreation` before invoking the provider. An end request that wins
   before this claim ends the call without external dispatch. A lost creation-claim
   acknowledgement is uncertain and must not be retried as a new call.
3. Persist the provider reference with `attachProviderCall` before accepting the
   SDP answer or connecting tool control. Check the returned state: a concurrent
   end request remains ending, and an expired worker remains uncertain. Neither
   transition grants permission to continue running tools.
4. Use `createRealtimeCallLease` from the root SDK export to maintain a worker
   lease. Its signal aborts on a failed renewal or at the last confirmed deadline
   when storage stalls. Renewals do not overlap; late replies cannot revive a
   closed lease. Connect this signal to provider setup/control and approval waits.
5. An authenticated end request first commits `requestEnd`, then uses the stored
   reference with the host provider adapter. Only confirmed remote termination
   permits `confirmEnded`. A missing reference after creation began remains ending
   or uncertain; it is not evidence that the provider was never called.
6. Another worker can read the same record and retry termination. Expired leases
   project as uncertain, never idle/ended and never permission to recreate the call.
   `list` provides bounded keyset pages for server-owned recovery/status queries.

The store and lease controller do not by themselves attach a conversation turn,
publish activity/unread markers, end a provider call, settle domain proposals or
deliver usage. Hosts must compose these primitives with the SDK conversation/usage
facilities and their authorized provider/domain adapters. A deployment must include
those connections before claiming reload-safe voice behavior.

Validation includes real SQL races between provider attachment and cancellation,
worker/owner/environment isolation, lease expiry, changed bindings, lost admission
and termination acknowledgements, bounded pagination and late heartbeat replies.
These are shared infrastructure tests, not proof of live provider termination.

## Durable tool activity

`PostgresRealtimeToolActivityStore` composes an owner-scoped call store and a call
ID. It records a tool's stable ID, name, running/completed/failed status and server
timestamps in the existing SDK documents table. Its display records contain no
arguments or business results and never authorize tool dispatch. The host still
uses its execution ledger and current call/session authorization.

Record running before dispatch. Only the owning worker of an active call may
introduce a new tool. Duplicate callbacks return the retained state, names cannot
be rebound, and terminal outcomes cannot be reversed. A previously started tool
can settle after call termination because remote hangup cannot undo a dispatched
action. Unknown write acknowledgements propagate; retrying the same activity
callback does not increase the count.

`summary()` derives counts from unique persisted tool records. `list()` supplies
bounded keyset detail pages (50 by default, maximum 100); hosts can omit detail
queries or provide a custom presentation. A count in running means a start has
no saved terminal outcome. For an ended or uncertain call, render it as unresolved
work requiring review, not proof that a worker is still running. This API does not
yet connect voice completion to a conversation workspace's unread marker.


The shared Dart `HandrailRealtimeActivityMonitor` now consumes a protected
summary/detail reader. It keeps details off by default, joins overlapping polls,
retains bounded page windows, rejects scope/count/outcome regressions, ignores
late reads after disposal or a details-mode change, and keeps saved counts on
failure. Hosts choose their presentation. Mills mobile connects it to the voice
sheet, with counts, optional collapsed details and saved-call selection. Ending
or losing contact with a call does not turn missing tool outcomes into success.
This still does not publish voice completion into workspace unread state.

## Completion read receipts

`PostgresRealtimeToolActivityStore.readState()` returns saved counts, unread state
and a `readToken`. A token is available only after a dispatched call has confirmed
remote termination. `markRead(token)` acknowledges that displayed lifecycle
version and the displayed total/completed/failed counts. The token is bound to
the call's tenant/owner scope; it is not an execution approval.

Read receipts use the existing SDK documents table. Duplicate acknowledgements
are idempotent, older receipts cannot roll the marker backwards, and a terminal
tool outcome arriving after acknowledgement makes the call unread again. A lost
acknowledgement response can be retried with the same token. Do not synthesize a
token from a newer state that the user has not viewed.

Hosts must authorize both reads and acknowledgement writes. Mills exposes the
read state on its protected activity GET and accepts the displayed token at
POST `/api/v1/ai/realtime/calls/:callId/activity/read`, with conversation ownership
and CSRF checks. It never uses these records to alter a text turn or run a tool.

Client acknowledgement of actually visible activity and conversation-workspace
aggregation still need wiring. The current mobile model ignores the new optional
response fields; it does not yet mark a voice call read or display its unread
state in the conversation list. This server API alone is not completion of the
cross-thread unread requirement.
