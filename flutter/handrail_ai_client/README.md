# handrail_ai_client

Flutter/Dart headless client for the application-hosted Handrail AI wire protocol. It negotiates PDF/document, attachment, cancellation, presence, activity, synchronization, and resource capabilities; creates/lists/loads/renames/archives/restores threads; starts, resumes, and cancels SSE turns; uploads attachments; reviews approvals; generates titles; reads/marks cross-device launcher activity; and publishes/subscribes to typing presence. `HandrailConversationState.apply` provides immutable typed state for text, tools, approvals, citations, attachments, and turn status.

The package deliberately has no Flutter widget dependency. Build fully custom Material/Cupertino UI from the state model, or wrap it in an application-owned widget kit. Authentication remains application-owned through `protectedHeaders`; provider credentials, server executors, actor/company context, and attachment bytes never enter durable client state.

Intentional native difference: the TypeScript package includes optional React styled primitives and renderer plugins; Dart stays headless and exposes typed state/streams for application-owned Material or Cupertino widgets. Browser `Blob` upload becomes `List<int>` multipart upload. Gateway protocol, resume checkpoints, terminal outcomes, approvals, activity, presence, and concurrent-workspace semantics remain aligned.
