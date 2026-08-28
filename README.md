# @handrail/ai

Provider-neutral TypeScript primitives and runtime tooling for building AI
applications with Handrail.

This package is currently scaffolded for development. Its public protocol,
provider adapter, managed client, and tool-loop APIs will be added separately.

## Normalized usage receipts

`NormalizedUsageReceipt` is a browser-safe telemetry and authoritative
attribution output contract. A receipt identifies one provider invocation while
retaining the conversation, turn, logical request, retry attempt, and tool
continuation identities needed for safe deduplication. Token quantities and
exact base-10 provider costs explicitly distinguish reported, estimated, and
unavailable values; a known zero is never represented as unknown.

Receipts do not price or settle usage. Pricing, ledgers, credits, billing
mutation, metering settlement, databases, Handrail control-plane calls, and
production-runtime changes are reserved for a later convergence loop.

## Image attachment references

Chat messages may mix text with provider-neutral image references:

```ts
const message = {
  role: "user",
  content: [
    { type: "text", text: "What is shown here?" },
    {
      type: "image",
      attachment: {
        attachment_id: "att_01K3QW8KJQH9T0A7N4R2M6P5XC",
        content_ref: "ref_upload_01K3QW8Q2Q4JE8H5J3RB9SNMVA",
        media_type: "image/png",
        byte_size: 248_123,
        filename: "photo.png",
      },
      alt_text: "A parcel beside the front door",
    },
  ],
};
```

`content_ref` is an opaque identifier matching the exported
`AI_RUNTIME_CONTENT_REFERENCE_GRAMMAR`; it is not a URL or embedded image. A
trusted host or transport resolves it before constructing provider-native
input. The durable protocol never carries binary data, browser file objects,
signed URLs, provider SDK blocks, or secrets. Supported MIME types and all
image byte/count limits are exported alongside the protocol.

## Requirements

- Node.js 20 or newer

## Development

```sh
npm install
npm run build
npm run typecheck
npm test
npm run lint
npm run pack:dry-run
```

## License

Copyright (c) Handrail. All rights reserved. See [LICENSE](./LICENSE).
