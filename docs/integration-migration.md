# Integration migration

The integration conveniences are additive. Existing low-level runtime,
transport, gateway, React primitive, and CSS-variable APIs remain supported.

## Recommended migrations

- Replace high-level `runtime` configuration with
  `conversations: { mode: "multiple", ... }` without changing its event-store
  factory or authorization policy.
- For applications that never expose threads, use `mode: "single"` and consume
  `client.conversation`; remove local registry/workspace assembly.
- Replace independently assembled principal, attribution, profile, tool, and
  presence objects with `createAssistantGatewayAuthorizer`. Keep profile fields
  minimal and server-resolved.
- Move preset color/radius/font overrides into `theme` when typed configuration
  is useful. Existing CSS variables continue to work and override defaults.

## Intentionally deferred boundaries

- Authentication schemes, user/profile databases, authorization and retention
  policy remain application-owned; the SDK coordinates their outputs but
  cannot infer them.
- Model context is explicit rather than automatic. The SDK will not disclose a
  principal or profile to a provider unless the host places approved fields in
  `model` and uses them in its provider adapter.
- A separate published UI package would permit arbitrary large renderer
  dependencies without affecting the core install. This release instead
  removes the only styled-only runtime dependency and retains the existing
  subpath for compatibility.
- The built-in safe Markdown renderer is intentionally bounded. Applications
  needing tables, math, raw HTML, or plugins should provide
  `renderMessageContent` and own that dependency/security policy.
