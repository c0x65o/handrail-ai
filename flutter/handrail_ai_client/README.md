# handrail_ai_client

Flutter/Dart client for the application-hosted Handrail AI wire protocol. It negotiates attachment, cancellation, presence, and synchronization capabilities; starts and resumes SSE turns; exposes all event payloads for messages, tool results, approvals, citations, and attachment state; and sends authoritative cancellation requests. Authentication remains application-owned through `protectedHeaders`.
