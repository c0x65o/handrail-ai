import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ATTACHMENT_UPLOAD_MAX_CONCURRENCY,
  AttachmentUploadAdapterError,
  AttachmentUploadValidationError,
  createAttachmentUploader,
  type AttachmentSelection,
  type AttachmentUploadAdapter,
  type AttachmentUploadRequest,
} from "../src/attachments/index.js";
import {
  AI_RUNTIME_PROTOCOL_LIMITS,
  type AttachmentReference,
} from "../src/protocol.js";

interface OpaqueBinary {
  readonly bytes: Uint8Array;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const source = (value: number): OpaqueBinary => ({
  bytes: new Uint8Array([value]),
});

const selection = (
  fingerprint: string,
  overrides: Partial<AttachmentSelection<OpaqueBinary>> = {},
): AttachmentSelection<OpaqueBinary> => ({
  source: source(1),
  fingerprint,
  idempotencyKey: `idem:${fingerprint}`,
  mediaType: "image/png",
  byteSize: 128,
  filename: "image.png",
  ...overrides,
} as AttachmentSelection<OpaqueBinary>);

const reference = (
  suffix: string,
  overrides: Partial<AttachmentReference> = {},
): AttachmentReference => ({
  attachment_id: `att_${suffix}`,
  content_ref: `ref_${suffix}`,
  media_type: "image/png",
  byte_size: 128,
  filename: "image.png",
  ...overrides,
});

const documentSelection = (
  fingerprint: string,
  overrides: Partial<AttachmentSelection<OpaqueBinary>> = {},
): AttachmentSelection<OpaqueBinary> => ({
  source: source(2),
  fingerprint,
  idempotencyKey: `idem:${fingerprint}`,
  kind: "document",
  mediaType: "application/pdf",
  byteSize: 256,
  filename: "document.pdf",
  ...overrides,
} as AttachmentSelection<OpaqueBinary>);

const documentReference = (
  suffix: string,
  overrides: Partial<AttachmentReference> = {},
): AttachmentReference => ({
  attachment_id: `att_${suffix}`,
  content_ref: `ref_${suffix}`,
  media_type: "application/pdf",
  byte_size: 256,
  filename: "document.pdf",
  ...overrides,
});

async function waitFor(
  predicate: () => boolean,
  message = "condition",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

describe("AttachmentUploader", () => {
  it("keeps the adapter source generic and free of a browser-specific source requirement", () => {
    expectTypeOf<AttachmentUploadRequest<OpaqueBinary>["source"]>().toEqualTypeOf<OpaqueBinary>();
    expectTypeOf<AttachmentUploadAdapter<OpaqueBinary>["upload"]>().parameter(0).toMatchTypeOf<{
      source: OpaqueBinary;
      signal: AbortSignal;
      idempotencyKey: string;
    }>();
  });

  it("uploads successfully, reports progress, and forwards validated request identity", async () => {
    const requests: AttachmentUploadRequest<OpaqueBinary>[] = [];
    const uploader = createAttachmentUploader<OpaqueBinary>({
      async upload(request) {
        requests.push(request);
        request.onProgress({ uploadedBytes: 64, totalBytes: 128 });
        return reference("success");
      },
    });
    const snapshots: number[] = [];
    uploader.subscribe((snapshot) => {
      const item = snapshot.items[0];
      if (item) snapshots.push(item.progress.uploadedBytes);
    });

    const id = uploader.enqueue(selection("success"));
    await waitFor(
      () => uploader.getSnapshot().items[0]?.status === "ready",
      "successful upload",
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      source: source(1),
      idempotencyKey: "idem:success",
      metadata: {
        kind: "image",
        mediaType: "image/png",
        byteSize: 128,
        filename: "image.png",
      },
    });
    expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(snapshots).toContain(64);
    expect(uploader.getSnapshot().items[0]).toMatchObject({
      id,
      status: "ready",
      attempt: 1,
      progress: { uploadedBytes: 128, totalBytes: 128 },
    });
  });

  it("uploads a PDF with normalized document metadata", async () => {
    const requests: AttachmentUploadRequest<OpaqueBinary>[] = [];
    const uploader = createAttachmentUploader<OpaqueBinary>({
      async upload(request) {
        requests.push(request);
        return documentReference("pdf");
      },
    });

    const id = uploader.enqueue(documentSelection("pdf"));
    await waitFor(
      () => uploader.getSnapshot().items[0]?.status === "ready",
      "PDF upload",
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      idempotencyKey: "idem:pdf",
      metadata: {
        kind: "document",
        mediaType: "application/pdf",
        byteSize: 256,
        filename: "document.pdf",
      },
    });
    expect(uploader.getSnapshot().items[0]).toMatchObject({
      id,
      kind: "document",
      mediaType: "application/pdf",
      status: "ready",
      reference: documentReference("pdf"),
    });
  });

  it("preserves ordering across a mixed image and PDF queue", async () => {
    const pending: Array<Deferred<AttachmentReference>> = [];
    const started: string[] = [];
    const uploader = createAttachmentUploader<OpaqueBinary>(
      {
        upload(request) {
          const operation = deferred<AttachmentReference>();
          pending.push(operation);
          started.push(`${request.metadata.kind}:${request.idempotencyKey}`);
          return operation.promise;
        },
      },
      { concurrency: 1 },
    );

    uploader.enqueue(selection("mixed-image"));
    uploader.enqueue(documentSelection("mixed-pdf"));
    expect(started).toEqual(["image:idem:mixed-image"]);

    pending[0]?.resolve(reference("mixed_image"));
    await waitFor(() => started.length === 2, "PDF queue start");
    expect(started).toEqual([
      "image:idem:mixed-image",
      "document:idem:mixed-pdf",
    ]);
    pending[1]?.resolve(documentReference("mixed_pdf"));
    await waitFor(() => uploader.getSnapshot().activeCount === 0);
    expect(uploader.getSnapshot().items.map((item) => item.kind)).toEqual([
      "image",
      "document",
    ]);
  });

  it("bounds active uploads and preserves queue order", async () => {
    const pending: Array<Deferred<AttachmentReference>> = [];
    const started: string[] = [];
    const uploader = createAttachmentUploader<OpaqueBinary>(
      {
        upload(request) {
          const operation = deferred<AttachmentReference>();
          pending.push(operation);
          started.push(request.idempotencyKey);
          return operation.promise;
        },
      },
      { concurrency: 2 },
    );

    uploader.enqueue(selection("one"));
    uploader.enqueue(selection("two"));
    uploader.enqueue(selection("three"));
    expect(started).toEqual(["idem:one", "idem:two"]);
    expect(uploader.getSnapshot()).toMatchObject({ activeCount: 2, queuedCount: 1 });

    pending[0]?.resolve(reference("one"));
    await waitFor(() => started.length === 3, "third upload to start");
    expect(started).toEqual(["idem:one", "idem:two", "idem:three"]);
    expect(uploader.getSnapshot().activeCount).toBe(2);
    pending[1]?.resolve(reference("two"));
    pending[2]?.resolve(reference("three"));
    await waitFor(() => uploader.getSnapshot().activeCount === 0);
  });

  it("suppresses duplicate fingerprints while an item remains selected", async () => {
    const operation = deferred<AttachmentReference>();
    let calls = 0;
    const uploader = createAttachmentUploader<OpaqueBinary>({
      upload() {
        calls += 1;
        return operation.promise;
      },
    });

    const first = uploader.enqueue(selection("duplicate"));
    const duplicate = uploader.enqueue(
      selection("duplicate", { source: source(2), idempotencyKey: "idem:other" }),
    );
    expect(duplicate).toBe(first);
    expect(calls).toBe(1);
    expect(uploader.getSnapshot().items).toHaveLength(1);
    operation.resolve(reference("duplicate"));
    await waitFor(() => uploader.getSnapshot().activeCount === 0);
  });

  it("retries only explicitly retryable normalized adapter failures", async () => {
    const calls = new Map<string, number>();
    const uploader = createAttachmentUploader<OpaqueBinary>({
      async upload(request) {
        const count = (calls.get(request.idempotencyKey) ?? 0) + 1;
        calls.set(request.idempotencyKey, count);
        if (request.idempotencyKey === "idem:retryable" && count === 1) {
          throw new AttachmentUploadAdapterError({
            retryable: true,
            cause: new Error("Bearer secret-token-that-must-not-leak"),
          });
        }
        if (request.idempotencyKey === "idem:permanent") {
          throw new Error("implementation stack and credentials");
        }
        return reference(request.idempotencyKey.replace("idem:", ""));
      },
    });

    const retryableId = uploader.enqueue(selection("retryable"));
    const permanentId = uploader.enqueue(selection("permanent"));
    await waitFor(
      () => uploader.getSnapshot().items.every((item) => item.status === "failed"),
      "failures",
    );
    const [retryable, permanent] = uploader.getSnapshot().items;
    expect(retryable).toMatchObject({
      error: {
        code: "upload_failed",
        message: "The attachment could not be uploaded.",
        retryable: true,
      },
    });
    expect(JSON.stringify(retryable)).not.toContain("secret-token");
    expect(permanent).toMatchObject({ error: { retryable: false } });

    expect(uploader.retry(permanentId)).toBe(false);
    expect(uploader.retry(retryableId)).toBe(true);
    await waitFor(
      () => uploader.getSnapshot().items[0]?.status === "ready",
      "retry",
    );
    expect(uploader.getSnapshot().items[0]?.attempt).toBe(2);
  });

  it("cancels queued and active work without converting aborts into failures", async () => {
    const signals: AbortSignal[] = [];
    const uploader = createAttachmentUploader<OpaqueBinary>(
      {
        upload(request) {
          signals.push(request.signal);
          return new Promise<AttachmentReference>((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      },
      { concurrency: 1 },
    );
    const activeId = uploader.enqueue(selection("active"));
    const queuedId = uploader.enqueue(selection("queued"));

    expect(uploader.cancel(queuedId)).toBe(true);
    expect(uploader.cancel(activeId)).toBe(true);
    await waitFor(() => uploader.getSnapshot().activeCount === 0, "abort settlement");
    expect(signals[0]?.aborted).toBe(true);
    expect(uploader.getSnapshot().items.map((item) => item.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(signals).toHaveLength(1);
  });

  it("removes items, aborts cleanup work, and disposes idempotently", async () => {
    const signals: AbortSignal[] = [];
    const uploader = createAttachmentUploader<OpaqueBinary>({
      upload(request) {
        signals.push(request.signal);
        return new Promise<AttachmentReference>(() => undefined);
      },
    });
    const id = uploader.enqueue(selection("remove"));
    expect(uploader.remove(id)).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    expect(uploader.getSnapshot().items).toEqual([]);
    expect(uploader.remove(id)).toBe(false);

    uploader.enqueue(selection("dispose"));
    uploader.dispose();
    uploader.dispose();
    expect(uploader.disposed).toBe(true);
    expect(uploader.getSnapshot().items).toEqual([]);
    expect(() => uploader.enqueue(selection("late"))).toThrow(
      AttachmentUploadValidationError,
    );
  });

  it("returns only ready references while other lifecycle states remain explicit", async () => {
    const pending = deferred<AttachmentReference>();
    const uploader = createAttachmentUploader<OpaqueBinary>({
      async upload(request) {
        if (request.idempotencyKey === "idem:ready") return reference("ready");
        if (request.idempotencyKey === "idem:failed") throw new Error("no");
        return pending.promise;
      },
    });
    const readyId = uploader.enqueue(selection("ready"));
    const failedId = uploader.enqueue(selection("failed"));
    const pendingId = uploader.enqueue(selection("pending"));
    await waitFor(
      () => uploader.getSnapshot().items[1]?.status === "failed",
      "ready and failed items",
    );

    expect(uploader.getReadyReferences([pendingId, failedId, readyId])).toEqual([
      reference("ready"),
    ]);
    expect(uploader.getSnapshot().items.map((item) => item.status)).toEqual([
      "ready",
      "failed",
      "uploading",
    ]);
    uploader.cancel(pendingId);
    pending.reject(new Error("cancelled"));
  });

  it.each([
    ["mismatched MIME", { media_type: "image/jpeg" }],
    ["mismatched size", { byte_size: 127 }],
    ["mismatched filename", { filename: "other.png" }],
    ["unsafe URL reference", { content_ref: "https://example.com/image.png" }],
    ["data reference", { content_ref: "data:image/png;base64,AAAA" }],
    ["credential reference", { content_ref: "ref_sk-secret-token-value" }],
    ["malformed attachment id", { attachment_id: "not-an-attachment" }],
  ])("permanently rejects an adapter result with %s", async (_label, overrides) => {
    const uploader = createAttachmentUploader<OpaqueBinary>({
      async upload() {
        return reference("unsafe", overrides as Partial<AttachmentReference>);
      },
    });
    const id = uploader.enqueue(selection(`invalid-${String(_label).replaceAll(" ", "-")}`));
    await waitFor(
      () => uploader.getSnapshot().items[0]?.status === "failed",
      "invalid result failure",
    );
    expect(uploader.getSnapshot().items[0]).toMatchObject({
      id,
      status: "failed",
      error: {
        code: "invalid_result",
        message: "The attachment service returned an invalid result.",
        retryable: false,
      },
    });
    expect(uploader.retry(id)).toBe(false);
  });

  it.each([
    ["kind/MIME", { media_type: "image/png" }],
    ["size", { byte_size: 255 }],
    ["filename", { filename: "other.pdf" }],
  ])("permanently rejects a PDF adapter result with mismatched %s", async (
    _label,
    overrides,
  ) => {
    const uploader = createAttachmentUploader<OpaqueBinary>({
      async upload() {
        return documentReference("mismatch", overrides as Partial<AttachmentReference>);
      },
    });
    const id = uploader.enqueue(documentSelection(
      `pdf-${_label.replaceAll(/[^A-Za-z0-9]/g, "-")}`,
    ));
    await waitFor(
      () => uploader.getSnapshot().items[0]?.status === "failed",
      "invalid PDF result",
    );
    expect(uploader.getSnapshot().items[0]).toMatchObject({
      id,
      status: "failed",
      error: { code: "invalid_result", retryable: false },
    });
    expect(uploader.retry(id)).toBe(false);
  });

  it("rejects unsupported and kind-mismatched MIME types before adapter invocation", () => {
    let calls = 0;
    const uploader = createAttachmentUploader<OpaqueBinary>({
      async upload() {
        calls += 1;
        return reference("unused");
      },
    });

    expect(() => uploader.enqueue(selection("unsupported", {
      mediaType: "image/bmp" as "image/png",
    }))).toThrow(AttachmentUploadValidationError);
    expect(() => uploader.enqueue({
      ...documentSelection("document-as-image"),
      kind: "image",
    } as AttachmentSelection<OpaqueBinary>)).toThrow(AttachmentUploadValidationError);
    expect(() => uploader.enqueue({
      ...selection("image-as-document"),
      kind: "document",
    } as AttachmentSelection<OpaqueBinary>)).toThrow(AttachmentUploadValidationError);
    expect(calls).toBe(0);
    expect(uploader.getSnapshot().items).toEqual([]);
  });

  it("enforces protocol byte limits and configured per-kind queue counts before upload", async () => {
    let calls = 0;
    const uploader = createAttachmentUploader<OpaqueBinary>(
      {
        async upload(request) {
          calls += 1;
          return request.metadata.kind === "image"
            ? reference("bounded")
            : documentReference("bounded");
        },
      },
      { maxImageCount: 1, maxDocumentCount: 1 },
    );

    expect(() => uploader.enqueue(selection("image-too-large", {
      byteSize: AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes + 1,
    }))).toThrow(AttachmentUploadValidationError);
    expect(() => uploader.enqueue(documentSelection("document-too-large", {
      byteSize: AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes + 1,
    }))).toThrow(AttachmentUploadValidationError);
    expect(calls).toBe(0);

    uploader.enqueue(selection("bounded-image"));
    uploader.enqueue(documentSelection("bounded-document"));
    expect(() => uploader.enqueue(selection("second-image"))).toThrow(
      AttachmentUploadValidationError,
    );
    expect(() => uploader.enqueue(documentSelection("second-document"))).toThrow(
      AttachmentUploadValidationError,
    );
    await waitFor(() => uploader.getSnapshot().activeCount === 0);
    expect(calls).toBe(2);

    expect(() => createAttachmentUploader({ async upload() {
      return reference("unused");
    } }, {
      maxImageCount: AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerRequest + 1,
    })).toThrow(AttachmentUploadValidationError);
  });

  it("keeps opaque binary data out of snapshots and forwards it only to the adapter", async () => {
    const opaqueSource = Object.freeze({ bytes: new Uint8Array([7, 8, 9]) });
    let received: OpaqueBinary | undefined;
    const uploader = createAttachmentUploader<OpaqueBinary>({
      async upload(request) {
        received = request.source;
        return reference("opaque");
      },
    });

    uploader.enqueue(selection("opaque", { source: opaqueSource }));
    await waitFor(() => uploader.getSnapshot().items[0]?.status === "ready");
    const snapshot = uploader.getSnapshot();
    expect(received).toBe(opaqueSource);
    expect(snapshot.items[0]).not.toHaveProperty("source");
    expect(JSON.stringify(snapshot)).not.toContain("bytes");
  });

  it("returns deeply frozen snapshots and references", async () => {
    const uploader = createAttachmentUploader<OpaqueBinary>({
      async upload() {
        return reference("frozen");
      },
    });
    uploader.enqueue(selection("frozen"));
    await waitFor(() => uploader.getSnapshot().items[0]?.status === "ready");

    const snapshot = uploader.getSnapshot();
    const item = snapshot.items[0];
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item?.progress)).toBe(true);
    expect(item?.status).toBe("ready");
    if (item?.status === "ready") {
      expect(Object.isFrozen(item.reference)).toBe(true);
    }
  });

  it("validates selection metadata and bounded concurrency before queueing", () => {
    const adapter: AttachmentUploadAdapter<OpaqueBinary> = {
      async upload() {
        return reference("unused");
      },
    };
    expect(
      () => createAttachmentUploader(adapter, { concurrency: 0 }),
    ).toThrow(AttachmentUploadValidationError);
    expect(
      () =>
        createAttachmentUploader(adapter, {
          concurrency: ATTACHMENT_UPLOAD_MAX_CONCURRENCY + 1,
        }),
    ).toThrow(AttachmentUploadValidationError);

    const uploader = createAttachmentUploader(adapter);
    expect(() => uploader.enqueue(selection("bad-size", { byteSize: 0 }))).toThrow(
      AttachmentUploadValidationError,
    );
    expect(() => uploader.enqueue(selection("bad-name", { filename: "../secret" }))).toThrow(
      AttachmentUploadValidationError,
    );
    expect(() => uploader.enqueue(selection("https://unsafe.example"))).toThrow(
      AttachmentUploadValidationError,
    );
  });
});
