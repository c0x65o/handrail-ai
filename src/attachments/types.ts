import type {
  AttachmentMimeType,
  AttachmentReference,
} from "../protocol.js";

export type AttachmentUploadKind = "image" | "document";

export interface AttachmentUploadMetadata {
  /** Required for documents; omitted legacy image metadata is normalized to image. */
  readonly kind?: AttachmentUploadKind;
  readonly mediaType: AttachmentMimeType;
  readonly byteSize: number;
  readonly filename?: string;
}

export interface NormalizedAttachmentUploadMetadata
  extends Omit<AttachmentUploadMetadata, "kind"> {
  readonly kind: AttachmentUploadKind;
}

export interface AttachmentUploadProgress {
  readonly uploadedBytes: number;
  readonly totalBytes: number;
}

export interface AttachmentUploadRequest<TSource = unknown> {
  /** Host-owned binary data. The core SDK never inspects or serializes it. */
  readonly source: TSource;
  readonly metadata: AttachmentUploadMetadata;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: AttachmentUploadProgress) => void;
}

/** Storage-neutral boundary implemented by the host or a negotiated transport. */
export interface AttachmentUploadAdapter<TSource = unknown> {
  upload(request: AttachmentUploadRequest<TSource>): Promise<AttachmentReference>;
}

export interface AttachmentSelection<TSource = unknown>
  extends AttachmentUploadMetadata {
  /** Host-computed stable identity for suppressing repeated selection. */
  readonly fingerprint: string;
  /** Stable across retries of this item. */
  readonly idempotencyKey: string;
  readonly source: TSource;
}

export type AttachmentUploadStatus =
  | "queued"
  | "uploading"
  | "ready"
  | "failed"
  | "cancelled";

export type AttachmentUploadFailureCode = "upload_failed" | "invalid_result";

export interface AttachmentUploadFailure {
  readonly code: AttachmentUploadFailureCode;
  /** Deliberately generic so adapter/provider details cannot cross this boundary. */
  readonly message: string;
  readonly retryable: boolean;
}

interface AttachmentUploadItemBase extends NormalizedAttachmentUploadMetadata {
  readonly id: string;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly status: AttachmentUploadStatus;
}

export interface QueuedAttachmentUploadItem extends AttachmentUploadItemBase {
  readonly status: "queued";
  readonly progress: AttachmentUploadProgress;
}

export interface UploadingAttachmentUploadItem extends AttachmentUploadItemBase {
  readonly status: "uploading";
  readonly progress: AttachmentUploadProgress;
}

export interface ReadyAttachmentUploadItem extends AttachmentUploadItemBase {
  readonly status: "ready";
  readonly progress: AttachmentUploadProgress;
  readonly reference: AttachmentReference;
}

export interface FailedAttachmentUploadItem extends AttachmentUploadItemBase {
  readonly status: "failed";
  readonly progress: AttachmentUploadProgress;
  readonly error: AttachmentUploadFailure;
}

export interface CancelledAttachmentUploadItem extends AttachmentUploadItemBase {
  readonly status: "cancelled";
  readonly progress: AttachmentUploadProgress;
}

export type AttachmentUploadItem =
  | QueuedAttachmentUploadItem
  | UploadingAttachmentUploadItem
  | ReadyAttachmentUploadItem
  | FailedAttachmentUploadItem
  | CancelledAttachmentUploadItem;

export interface AttachmentUploaderSnapshot {
  readonly items: readonly AttachmentUploadItem[];
  readonly activeCount: number;
  readonly queuedCount: number;
}

export interface AttachmentUploaderOptions {
  /** Integer from 1 through ATTACHMENT_UPLOAD_MAX_CONCURRENCY. */
  readonly concurrency?: number;
  /** Selected images retained by this queue; defaults to the protocol request limit. */
  readonly maxImageCount?: number;
  /** Selected documents retained by this queue; defaults to the protocol request limit. */
  readonly maxDocumentCount?: number;
}

export type AttachmentUploaderListener = (
  snapshot: AttachmentUploaderSnapshot,
) => void;

/**
 * The only thrown adapter error classification understood by the uploader.
 * Other thrown values are normalized as permanent failures.
 */
export class AttachmentUploadAdapterError extends Error {
  readonly retryable: boolean;

  constructor(options: { readonly retryable: boolean; readonly cause?: unknown }) {
    super("Attachment upload adapter failed", { cause: options.cause });
    this.name = "AttachmentUploadAdapterError";
    this.retryable = options.retryable;
  }
}

export class AttachmentUploadValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentUploadValidationError";
  }
}
