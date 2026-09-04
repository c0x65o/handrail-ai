import { createApplicationGateway } from "@handrail/ai-assistant";
import { createApplicationGatewayExpressMiddleware } from "@handrail/ai-assistant/server/application-gateway";

// `transport` is the trusted server's provider/managed transport. Authentication
// remains application-owned. Mount after express.json({limit:"1mb"}) and the
// application's session/auth middleware:
declare const transport: NonNullable<Parameters<typeof createApplicationGateway>[0]["transport"]>;
declare const app: { use(path: string, middleware: unknown): void };

const gateway = createApplicationGateway({
  transport,
  authorize: async (request) => {
    // Resolve the server session and authorize the requested conversation here.
    if (!request.headers.get("x-example-user")) throw new Error("unauthorized");
    return { principalId: request.headers.get("x-example-user")! };
  },
  checkpointForEvent: () => ({ lastAppliedEventId: null, lastAppliedCursor: null, lastAppliedRevision: null }),
  capabilities: { attachments: { maximumFiles: 5, maximumBytesPerFile: 10_000_000, acceptedMediaTypes: ["image/*", "application/pdf"], uploadUrl: "/api/ai/uploads" } },
});

app.use("/api/ai", createApplicationGatewayExpressMiddleware(gateway, { origin: "https://app.example.com" }));
