import type { ConversationId, ConversationRevision } from "./events.js";
import type {
  AppendConversationEventsInput, AppendConversationEventsResult, ConversationEventCheckpoint,
  ConversationEventCheckpointStore, ConversationEventStore, ReadConversationEventsInput, ReadConversationEventsResult,
  WriteConversationEventCheckpointResult,
} from "./event-store.js";

export interface DualWriteConversationEventStoreOptions {
  readonly primary: ConversationEventStore;
  readonly shadow: ConversationEventStore;
  readonly reconciliationPageSize?: number;
  readonly onShadowError?: (input: { readonly operation: "append" | "checkpoint"; readonly conversationId: ConversationId }) => void;
}

export type ConversationEventReconciliationResult =
  | { readonly status: "converged"; readonly repairedEvents: number; readonly revision: ConversationRevision | null }
  | { readonly status: "divergent"; readonly revision: ConversationRevision; readonly primaryEventId: string; readonly shadowEventId: string };

/** Primary remains authoritative; shadow failures are observable and rollback-safe. */
export class DualWriteConversationEventStore implements ConversationEventStore {
  readonly checkpoints?: ConversationEventCheckpointStore;
  readonly #pageSize: number;
  constructor(readonly options: DualWriteConversationEventStoreOptions) {
    this.#pageSize = options.reconciliationPageSize ?? 100;
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 1_000) throw new TypeError("reconciliationPageSize is invalid");
    if (options.primary.checkpoints) this.checkpoints = {
      read: (conversationId: ConversationId) => options.primary.checkpoints!.read(conversationId),
      write: (checkpoint: ConversationEventCheckpoint) => this.writeCheckpoint(checkpoint),
    };
  }

  async append(input: AppendConversationEventsInput): Promise<AppendConversationEventsResult> {
    const result = await this.options.primary.append(input);
    try { await this.options.shadow.append(input); }
    catch { this.options.onShadowError?.({ operation: "append", conversationId: input.conversationId }); }
    return result;
  }
  read(input: ReadConversationEventsInput): Promise<ReadConversationEventsResult> { return this.options.primary.read(input); }
  getLatestRevision(conversationId: ConversationId): Promise<ConversationRevision | null> {
    return this.options.primary.getLatestRevision(conversationId);
  }

  async reconcile(conversationId: ConversationId): Promise<ConversationEventReconciliationResult> {
    const primary = await this.all(this.options.primary, conversationId);
    const shadow = await this.all(this.options.shadow, conversationId);
    const shared = Math.min(primary.length, shadow.length);
    for (let index = 0; index < shared; index += 1) {
      const left = primary[index]!.event, right = shadow[index]!.event;
      if (JSON.stringify(left) !== JSON.stringify(right)) return Object.freeze({ status: "divergent" as const,
        revision: left.revision, primaryEventId: left.event_id, shadowEventId: right.event_id });
    }
    if (shadow.length > primary.length) {
      const left = primary.at(-1)?.event ?? shadow[primary.length]!.event;
      return Object.freeze({ status: "divergent" as const, revision: left.revision,
        primaryEventId: left.event_id, shadowEventId: shadow[primary.length]!.event.event_id });
    }
    const missing = primary.slice(shadow.length).map((entry) => entry.event);
    for (let index = 0; index < missing.length; index += this.#pageSize) {
      const batch = missing.slice(index, index + this.#pageSize);
      await this.options.shadow.append({ conversationId,
        expectedRevision: (batch[0]!.revision - 1 || null) as ConversationRevision | null, events: batch });
    }
    return Object.freeze({ status: "converged" as const, repairedEvents: missing.length,
      revision: primary.at(-1)?.event.revision ?? null });
  }

  private async all(store: ConversationEventStore, conversationId: ConversationId) {
    const entries = [];
    let revision: ConversationRevision | undefined;
    for (;;) {
      const page = await store.read({ conversationId, ...(revision === undefined ? {} : { after: { revision } }), limit: this.#pageSize });
      entries.push(...page.entries);
      if (!page.hasMore || page.entries.length === 0) return entries;
      revision = page.entries.at(-1)!.event.revision;
    }
  }

  private async writeCheckpoint(checkpoint: ConversationEventCheckpoint): Promise<WriteConversationEventCheckpointResult> {
    const result = await this.options.primary.checkpoints!.write(checkpoint);
    try { await this.options.shadow.checkpoints?.write(checkpoint); }
    catch { this.options.onShadowError?.({ operation: "checkpoint", conversationId: checkpoint.conversationId }); }
    return result;
  }
}
