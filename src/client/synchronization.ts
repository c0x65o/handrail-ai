import type { ApplicationGatewayPresenceClient, ApplicationGatewayResourceClient } from "../transports/application-gateway.js";
import type {
  ConversationSyncAdapter,
  ConversationSyncSubscription,
  ConversationSyncUpdate,
  AppendMutationsInput,
  PullSnapshotInput,
  ReadSinceInput,
  PublishPresenceInput,
  PublishPresenceResult,
  SubscribePresenceInput,
  SubscribePresenceResult,
  SubscribeSinceInput,
  SubscribeSinceResult,
} from "../sync/types.js";
import { createApplicationGatewayPresenceAdapter } from "./presence.js";

export interface ApplicationGatewaySyncAdapterOptions {
  readonly resources: Pick<ApplicationGatewayResourceClient, "pullSnapshot" | "readSince" | "appendMutations">;
  readonly presence?: ApplicationGatewayPresenceClient;
  readonly pollingMilliseconds?: number;
}

function interval(value: number | undefined): number {
  const resolved = value ?? 1_000;
  if (!Number.isSafeInteger(resolved) || resolved < 100 || resolved > 300_000) {
    throw new TypeError("pollingMilliseconds is invalid");
  }
  return resolved;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** Cross-platform gateway sync adapter; protected polling is the convergence path. */
export function createApplicationGatewaySyncAdapter(
  options: ApplicationGatewaySyncAdapterOptions,
): ConversationSyncAdapter {
  const pollingMilliseconds = interval(options.pollingMilliseconds);
  const presence = options.presence ? createApplicationGatewayPresenceAdapter(options.presence) : null;
  const subscribeSince = async (input: SubscribeSinceInput): Promise<SubscribeSinceResult> => {
    const controller = new AbortController();
    const updates = (async function* (): AsyncIterable<ConversationSyncUpdate> {
      let afterRevision = input.afterRevision;
      while (!controller.signal.aborted) {
        try {
          const result = await options.resources.readSince({ conversationId: input.conversationId, afterRevision });
          if (result.status !== "events") { yield result; return; }
          if (result.events.length > 0) {
            yield result;
            afterRevision = result.revision;
            if (result.hasMore) continue;
          }
        } catch {
          yield Object.freeze({ status: "temporarily_unavailable" as const,
            message: "Conversation synchronization is temporarily unavailable.",
            retryAfterMilliseconds: pollingMilliseconds });
        }
        await delay(pollingMilliseconds, controller.signal);
      }
    })();
    const subscription: ConversationSyncSubscription = Object.freeze({ updates, close: () => controller.abort() });
    return Object.freeze({ status: "subscribed" as const, subscription });
  };
  return Object.freeze({
    pullSnapshot: (input: PullSnapshotInput) => options.resources.pullSnapshot(input),
    readSince: (input: ReadSinceInput) => options.resources.readSince(input),
    appendMutations: (input: AppendMutationsInput) => options.resources.appendMutations(input),
    subscribeSince,
    publishPresence: (input: PublishPresenceInput): Promise<PublishPresenceResult> => presence
      ? presence.publishPresence(input) : Promise.resolve({ status: "unauthorized",
        message: "Presence is not available." }),
    subscribePresence: (input: SubscribePresenceInput): Promise<SubscribePresenceResult> => presence
      ? presence.subscribePresence(input) : Promise.resolve({ status: "unauthorized",
        message: "Presence is not available." }),
  });
}
