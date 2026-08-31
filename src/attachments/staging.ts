import type { AttachmentReference } from "../protocol.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";

export interface AttachmentBlobStore {
  put(input: { readonly key: string; readonly bytes: Uint8Array; readonly mediaType: string; readonly expiresAt: string }): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}
export interface StagedAttachmentRecord {
  readonly attachmentId: string; readonly contentRef: string; readonly blobKey: string;
  readonly ownerScopeId: string; readonly conversationId: string; readonly idempotencyKey: string;
  readonly fingerprint: string; readonly mediaType: string; readonly byteSize: number; readonly filename?: string;
  readonly createdAt: string; readonly expiresAt: string; readonly consumedAt: string | null;
}
export interface AttachmentStagingMetadataStore {
  getByIdempotency(ownerScopeId: string, conversationId: string, idempotencyKey: string): Promise<StagedAttachmentRecord | null>;
  getByContentRef(contentRef: string): Promise<StagedAttachmentRecord | null>;
  create(record: StagedAttachmentRecord): Promise<"created" | "conflict">;
  markConsumed(contentRef: string, consumedAt: string): Promise<void>;
  listExpired(before: string, limit: number): Promise<readonly StagedAttachmentRecord[]>;
  delete(contentRef: string): Promise<void>;
}
export interface AttachmentStagingLimits {
  readonly maximumBytes: number; readonly acceptedMediaTypes: readonly string[];
  readonly ttlMilliseconds: number; readonly cleanupBatchSize?: number;
}
export interface AttachmentStagingOptions {
  readonly blobs: AttachmentBlobStore; readonly metadata: AttachmentStagingMetadataStore;
  readonly limits: AttachmentStagingLimits; readonly diagnostics?: AiDiagnosticSink; readonly now?: () => number;
  readonly createId?: () => string;
}
export class AttachmentStagingError extends Error {
  constructor(readonly code: "invalid_input" | "forbidden" | "conflict" | "not_found" | "expired" | "unavailable") {
    super(({ invalid_input: "The attachment is invalid.", forbidden: "The attachment is not authorized.",
      conflict: "The attachment upload conflicts with retained identity.", not_found: "The attachment was not found.",
      expired: "The attachment expired.", unavailable: "Attachment storage is unavailable." })[code]);
    this.name = "AttachmentStagingError";
  }
}
function acceptable(mediaType: string, accepted: readonly string[]): boolean {
  return accepted.some((value) => value.endsWith("/*") ? mediaType.startsWith(value.slice(0, -1)) : value === mediaType);
}
function safeId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(value)) throw new AttachmentStagingError("invalid_input"); return value;
}
function reference(record: StagedAttachmentRecord): AttachmentReference {
  return { attachment_id: record.attachmentId, content_ref: record.contentRef,
    media_type: record.mediaType as AttachmentReference["media_type"], byte_size: record.byteSize,
    ...(record.filename ? { filename: record.filename } : {}) };
}

/** Application-owned expiring binary staging; durable documents retain metadata and opaque refs only. */
export function createAttachmentStagingService(options: AttachmentStagingOptions) {
  const now = options.now ?? Date.now, createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  const { maximumBytes, acceptedMediaTypes, ttlMilliseconds } = options.limits;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 1_000) {
    throw new TypeError("Attachment staging limits are invalid");
  }
  const owns = (record: StagedAttachmentRecord, ownerScopeId: string, conversationId: string) =>
    record.ownerScopeId === ownerScopeId && record.conversationId === conversationId;
  return Object.freeze({
    async stage(input: { readonly ownerScopeId: string; readonly conversationId: string; readonly idempotencyKey: string;
      readonly fingerprint: string; readonly mediaType: string; readonly filename?: string; readonly bytes: Uint8Array }): Promise<AttachmentReference> {
      const ownerScopeId = safeId(input.ownerScopeId), conversationId = safeId(input.conversationId);
      safeId(input.idempotencyKey); safeId(input.fingerprint);
      if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > maximumBytes ||
        !acceptable(input.mediaType, acceptedMediaTypes)) throw new AttachmentStagingError("invalid_input");
      const existing = await options.metadata.getByIdempotency(ownerScopeId, conversationId, input.idempotencyKey);
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) throw new AttachmentStagingError("conflict");
        if (Date.parse(existing.expiresAt) <= now()) throw new AttachmentStagingError("expired");
        return reference(existing);
      }
      const attachmentId = safeId(`att_${createId()}`), contentRef = safeId(`blob_${createId()}`), blobKey = safeId(`attachments/${contentRef}`);
      const createdAt = new Date(now()).toISOString(), expiresAt = new Date(now() + ttlMilliseconds).toISOString();
      const record: StagedAttachmentRecord = { attachmentId, contentRef, blobKey, ownerScopeId, conversationId,
        idempotencyKey: input.idempotencyKey, fingerprint: input.fingerprint, mediaType: input.mediaType,
        byteSize: input.bytes.byteLength, ...(input.filename ? { filename: input.filename } : {}), createdAt, expiresAt, consumedAt: null };
      try {
        await options.blobs.put({ key: blobKey, bytes: input.bytes, mediaType: input.mediaType, expiresAt });
        if (await options.metadata.create(record) !== "created") {
          await options.blobs.delete(blobKey);
          const winner = await options.metadata.getByIdempotency(ownerScopeId, conversationId, input.idempotencyKey);
          if (winner?.fingerprint === input.fingerprint && Date.parse(winner.expiresAt) > now()) return reference(winner);
          throw new AttachmentStagingError("conflict");
        }
        emitAiDiagnostic(options.diagnostics, { domain: "attachment", operation: "stage", phase: "succeeded", conversationId });
        return reference(record);
      } catch (error) { if (error instanceof AttachmentStagingError) throw error;
        emitAiDiagnostic(options.diagnostics, { domain: "attachment", operation: "stage", phase: "failed",
          conversationId, code: "unavailable", retryable: true }); throw new AttachmentStagingError("unavailable"); }
    },
    async resolve(input: { readonly ownerScopeId: string; readonly conversationId: string; readonly contentRef: string }) {
      const record = await options.metadata.getByContentRef(safeId(input.contentRef));
      if (!record) throw new AttachmentStagingError("not_found");
      if (!owns(record, safeId(input.ownerScopeId), safeId(input.conversationId))) throw new AttachmentStagingError("forbidden");
      if (Date.parse(record.expiresAt) <= now()) throw new AttachmentStagingError("expired");
      const bytes = await options.blobs.get(record.blobKey); if (!bytes) throw new AttachmentStagingError("not_found");
      return Object.freeze({ record, bytes });
    },
    async consume(input: { readonly ownerScopeId: string; readonly conversationId: string; readonly contentRef: string }) {
      const resolved = await this.resolve(input); await options.metadata.markConsumed(input.contentRef, new Date(now()).toISOString());
      await options.blobs.delete(resolved.record.blobKey); return resolved.record;
    },
    async cleanupExpired() {
      const records = await options.metadata.listExpired(new Date(now()).toISOString(), options.limits.cleanupBatchSize ?? 100);
      for (const record of records) { await options.blobs.delete(record.blobKey); await options.metadata.delete(record.contentRef); }
      return records.length;
    },
  });
}
