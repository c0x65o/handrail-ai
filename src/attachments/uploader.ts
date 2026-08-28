import {
  AI_RUNTIME_PROTOCOL_VERSION,
  parseChatRequest,
  type AttachmentReference,
} from "../protocol.js";
import {
  AttachmentUploadAdapterError,
  AttachmentUploadValidationError,
  type AttachmentSelection,
  type AttachmentUploadAdapter,
  type AttachmentUploadFailure,
  type AttachmentUploadItem,
  type AttachmentUploadMetadata,
  type AttachmentUploadProgress,
  type AttachmentUploaderListener,
  type AttachmentUploaderOptions,
  type AttachmentUploaderSnapshot,
} from "./types.js";

export const ATTACHMENT_UPLOAD_MAX_CONCURRENCY = 16 as const;

interface InternalItem<TSource> {
  source: TSource;
  item: AttachmentUploadItem;
  controller: AbortController | null;
  runToken: number;
}

const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

function metadataFrom(selection: AttachmentUploadMetadata): AttachmentUploadMetadata {
  return selection.filename === undefined
    ? { mediaType: selection.mediaType, byteSize: selection.byteSize }
    : {
        mediaType: selection.mediaType,
        byteSize: selection.byteSize,
        filename: selection.filename,
      };
}

function referenceFixture(metadata: AttachmentUploadMetadata): AttachmentReference {
  return metadata.filename === undefined
    ? {
        attachment_id: "att_validation",
        content_ref: "ref_validation",
        media_type: metadata.mediaType,
        byte_size: metadata.byteSize,
      }
    : {
        attachment_id: "att_validation",
        content_ref: "ref_validation",
        media_type: metadata.mediaType,
        byte_size: metadata.byteSize,
        filename: metadata.filename,
      };
}

function validateProtocolReference(value: unknown): AttachmentReference {
  const parsed = parseChatRequest({
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    continuation_of: null,
    messages: [
      {
        role: "user",
        content: [{ type: "image", attachment: value }],
      },
    ],
    tools: [],
    tool_results: [],
    generation: { max_output_tokens: 1, temperature: 0 },
    correlation_hints: {},
  });
  const part = parsed.messages[0]?.content[0];
  if (part?.type !== "image") {
    throw new AttachmentUploadValidationError("Attachment reference is invalid");
  }
  return part.attachment;
}

function validateOpaqueKey(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) ||
    /^(?:data|blob|https?):/i.test(value) ||
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    throw new AttachmentUploadValidationError(
      `${field} must be a safe opaque identifier of at most 256 characters`,
    );
  }
}

function validateSelection<TSource>(selection: AttachmentSelection<TSource>): void {
  if (selection === null || typeof selection !== "object") {
    throw new AttachmentUploadValidationError("Attachment selection must be an object");
  }
  validateOpaqueKey(selection.fingerprint, "fingerprint");
  validateOpaqueKey(selection.idempotencyKey, "idempotencyKey");
  try {
    validateProtocolReference(referenceFixture(metadataFrom(selection)));
  } catch {
    throw new AttachmentUploadValidationError(
      "Attachment media type, byte size, or filename is invalid",
    );
  }
}

function validateAdapterResult(
  value: unknown,
  requested: AttachmentUploadMetadata,
): AttachmentReference {
  let reference: AttachmentReference;
  try {
    reference = validateProtocolReference(value);
  } catch {
    throw new AttachmentUploadValidationError("Attachment adapter result is unsafe");
  }

  if (
    reference.media_type !== requested.mediaType ||
    reference.byte_size !== requested.byteSize ||
    reference.filename !== requested.filename
  ) {
    throw new AttachmentUploadValidationError(
      "Attachment adapter result does not match the requested identity",
    );
  }
  return Object.freeze(
    reference.filename === undefined
      ? {
          attachment_id: reference.attachment_id,
          content_ref: reference.content_ref,
          media_type: reference.media_type,
          byte_size: reference.byte_size,
        }
      : {
          attachment_id: reference.attachment_id,
          content_ref: reference.content_ref,
          media_type: reference.media_type,
          byte_size: reference.byte_size,
          filename: reference.filename,
        },
  );
}

function initialProgress(totalBytes: number): AttachmentUploadProgress {
  return { uploadedBytes: 0, totalBytes };
}

function normalizedFailure(error: unknown): AttachmentUploadFailure {
  if (error instanceof AttachmentUploadValidationError) {
    return {
      code: "invalid_result",
      message: "The attachment service returned an invalid result.",
      retryable: false,
    };
  }
  return {
    code: "upload_failed",
    message: "The attachment could not be uploaded.",
    retryable:
      error instanceof AttachmentUploadAdapterError && error.retryable === true,
  };
}

export class AttachmentUploader<TSource = unknown> {
  readonly #adapter: AttachmentUploadAdapter<TSource>;
  readonly #concurrency: number;
  readonly #items = new Map<string, InternalItem<TSource>>();
  readonly #listeners = new Set<AttachmentUploaderListener>();
  #activeCount = 0;
  #nextId = 1;
  #disposed = false;

  constructor(
    adapter: AttachmentUploadAdapter<TSource>,
    options: AttachmentUploaderOptions = {},
  ) {
    const concurrency = options.concurrency ?? 3;
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      concurrency > ATTACHMENT_UPLOAD_MAX_CONCURRENCY
    ) {
      throw new AttachmentUploadValidationError(
        `concurrency must be an integer from 1 through ${ATTACHMENT_UPLOAD_MAX_CONCURRENCY}`,
      );
    }
    this.#adapter = adapter;
    this.#concurrency = concurrency;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  getSnapshot(): AttachmentUploaderSnapshot {
    const items = [...this.#items.values()].map((entry) =>
      Object.freeze({
        ...entry.item,
        progress: Object.freeze({ ...entry.item.progress }),
        ...(entry.item.status === "ready"
          ? { reference: Object.freeze({ ...entry.item.reference }) }
          : {}),
      }) as AttachmentUploadItem,
    );
    return Object.freeze({
      items: Object.freeze(items),
      activeCount: this.#disposed ? 0 : this.#activeCount,
      queuedCount: items.filter((item) => item.status === "queued").length,
    });
  }

  subscribe(listener: AttachmentUploaderListener): () => void {
    this.#assertUsable();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  enqueue(selection: AttachmentSelection<TSource>): string {
    this.#assertUsable();
    validateSelection(selection);

    for (const entry of this.#items.values()) {
      if (entry.item.fingerprint === selection.fingerprint) return entry.item.id;
    }

    const id = `attachment-upload-${this.#nextId}`;
    this.#nextId += 1;
    const metadata = metadataFrom(selection);
    const item: AttachmentUploadItem = {
      id,
      fingerprint: selection.fingerprint,
      idempotencyKey: selection.idempotencyKey,
      ...metadata,
      attempt: 0,
      status: "queued",
      progress: initialProgress(metadata.byteSize),
    };
    this.#items.set(id, {
      source: selection.source,
      item,
      controller: null,
      runToken: 0,
    });
    this.#emit();
    this.#pump();
    return id;
  }

  cancel(id: string): boolean {
    this.#assertUsable();
    const entry = this.#items.get(id);
    if (!entry || (entry.item.status !== "queued" && entry.item.status !== "uploading")) {
      return false;
    }
    entry.item = {
      ...entry.item,
      status: "cancelled",
    };
    entry.runToken += 1;
    entry.controller?.abort();
    this.#emit();
    this.#pump();
    return true;
  }

  retry(id: string): boolean {
    this.#assertUsable();
    const entry = this.#items.get(id);
    if (
      !entry ||
      entry.item.status !== "failed" ||
      !entry.item.error.retryable
    ) {
      return false;
    }
    const { error: previousError, ...item } = entry.item;
    void previousError;
    entry.item = {
      ...item,
      status: "queued",
      progress: initialProgress(entry.item.byteSize),
    };
    this.#emit();
    this.#pump();
    return true;
  }

  remove(id: string): boolean {
    this.#assertUsable();
    const entry = this.#items.get(id);
    if (!entry) return false;
    entry.runToken += 1;
    entry.controller?.abort();
    this.#items.delete(id);
    this.#emit();
    this.#pump();
    return true;
  }

  getReadyReferences(itemIds?: readonly string[]): readonly AttachmentReference[] {
    const entries = itemIds === undefined
      ? [...this.#items.values()]
      : itemIds.flatMap((id) => {
          const entry = this.#items.get(id);
          return entry === undefined ? [] : [entry];
        });
    return Object.freeze(
      entries.flatMap((entry) =>
        entry.item.status === "ready" ? [entry.item.reference] : [],
      ),
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entry of this.#items.values()) {
      entry.runToken += 1;
      entry.controller?.abort();
    }
    this.#items.clear();
    this.#listeners.clear();
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AttachmentUploadValidationError("Attachment uploader is disposed");
    }
  }

  #emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observer failures do not alter upload lifecycle state.
      }
    }
  }

  #pump(): void {
    if (this.#disposed) return;
    while (this.#activeCount < this.#concurrency) {
      const entry = [...this.#items.values()].find(
        (candidate) => candidate.item.status === "queued",
      );
      if (!entry) return;
      void this.#upload(entry);
    }
  }

  async #upload(entry: InternalItem<TSource>): Promise<void> {
    const controller = new AbortController();
    const token = entry.runToken + 1;
    entry.runToken = token;
    entry.controller = controller;
    this.#activeCount += 1;
    entry.item = {
      ...entry.item,
      attempt: entry.item.attempt + 1,
      status: "uploading",
    };
    this.#emit();

    const metadata = metadataFrom(entry.item);
    const reportProgress = (progress: AttachmentUploadProgress): void => {
      if (
        this.#disposed ||
        entry.runToken !== token ||
        entry.item.status !== "uploading" ||
        progress.totalBytes !== entry.item.byteSize ||
        !Number.isFinite(progress.uploadedBytes) ||
        !Number.isInteger(progress.uploadedBytes) ||
        progress.uploadedBytes < entry.item.progress.uploadedBytes ||
        progress.uploadedBytes > entry.item.byteSize
      ) {
        return;
      }
      entry.item = {
        ...entry.item,
        progress: {
          uploadedBytes: progress.uploadedBytes,
          totalBytes: progress.totalBytes,
        },
      };
      this.#emit();
    };

    try {
      const result = await this.#adapter.upload({
        source: entry.source,
        metadata,
        idempotencyKey: entry.item.idempotencyKey,
        signal: controller.signal,
        onProgress: reportProgress,
      });
      if (
        this.#disposed ||
        entry.runToken !== token ||
        entry.item.status !== "uploading"
      ) {
        return;
      }
      const reference = validateAdapterResult(result, metadata);
      entry.item = {
        ...entry.item,
        status: "ready",
        progress: {
          uploadedBytes: entry.item.byteSize,
          totalBytes: entry.item.byteSize,
        },
        reference,
      };
      this.#emit();
    } catch (error) {
      if (
        this.#disposed ||
        entry.runToken !== token ||
        entry.item.status !== "uploading"
      ) {
        return;
      }
      entry.item = {
        ...entry.item,
        status: "failed",
        error: normalizedFailure(error),
      };
      this.#emit();
    } finally {
      if (entry.controller === controller) entry.controller = null;
      this.#activeCount -= 1;
      if (!this.#disposed) {
        this.#emit();
        this.#pump();
      }
    }
  }
}

export function createAttachmentUploader<TSource = unknown>(
  adapter: AttachmentUploadAdapter<TSource>,
  options?: AttachmentUploaderOptions,
): AttachmentUploader<TSource> {
  return new AttachmentUploader(adapter, options);
}
