import type { PresenceControllerAdapter } from "../presence/controller.js";
import type {
  ConversationPresenceStreamUpdate,
  SubscribePresenceSuccess,
} from "../sync/types.js";
import type { ApplicationGatewayPresenceClient } from "../transports/application-gateway.js";

/**
 * Adapts the application gateway's compact live-delivery API to the standard
 * cross-platform PresenceController contract. Presence remains ephemeral and
 * never enters conversation event history.
 */
export function createApplicationGatewayPresenceAdapter(
  client: ApplicationGatewayPresenceClient,
): PresenceControllerAdapter {
  return Object.freeze({
    async publishPresence(input) {
      await client.publish(
        input.conversationId,
        input.record.state === "offline" ? "leave" : "upsert",
        input.record,
      );
      return Object.freeze({ status: "published" as const, record: input.record });
    },
    async subscribePresence(input): Promise<SubscribePresenceSuccess> {
      const controller = new AbortController();
      const updates = (async function* (): AsyncIterable<ConversationPresenceStreamUpdate> {
        for await (const envelope of client.subscribe(input.conversationId, controller.signal)) {
          yield Object.freeze({ status: "presence" as const, record: envelope.record });
        }
      })();
      return Object.freeze({
        status: "subscribed" as const,
        subscription: Object.freeze({
          updates,
          close() { controller.abort(); },
        }),
      });
    },
  });
}
