import { describe, expect, it, vi } from "vitest";

import {
  BrowserImageIntakeValidationError,
  BrowserPdfIntakeValidationError,
  fingerprintBrowserImage,
  fingerprintBrowserDocument,
  fingerprintBrowserPdf,
  intakeClipboardImages,
  intakeDroppedImages,
  intakeDroppedPdfs,
  intakeFileInputImages,
  intakeFileInputDocuments,
  intakeFileInputPdfs,
  type BrowserImageIntakeOptions,
  type BrowserPdfIntakeOptions,
} from "../src/browser/index.js";
import type { AttachmentUploadRequest } from "../src/attachments/index.js";
import {
  enqueueFileInputImages,
  enqueueFileInputPdfs,
} from "./fixtures/browser-attachment-uploader.js";

interface FakeFileOptions {
  readonly lastModified?: number;
}

function fakeFile(
  name: string,
  type: string,
  size: number,
  options: FakeFileOptions = {},
): File {
  return {
    name,
    type,
    size,
    lastModified: options.lastModified ?? 1_700_000_000_000,
    arrayBuffer() {
      throw new Error("intake must not read file contents");
    },
    bytes() {
      throw new Error("intake must not read file contents");
    },
    slice() {
      throw new Error("intake must not read file contents");
    },
    stream() {
      throw new Error("intake must not read file contents");
    },
    text() {
      throw new Error("intake must not read file contents");
    },
  } as unknown as File;
}

function fakeBlob(type: string, size: number): Blob {
  return {
    type,
    size,
    arrayBuffer() {
      throw new Error("intake must not read blob contents");
    },
    bytes() {
      throw new Error("intake must not read blob contents");
    },
    slice() {
      throw new Error("intake must not read blob contents");
    },
    stream() {
      throw new Error("intake must not read blob contents");
    },
    text() {
      throw new Error("intake must not read blob contents");
    },
  } as unknown as Blob;
}

function fileList(...files: File[]): FileList {
  return Object.assign([...files], {
    item(index: number) {
      return files[index] ?? null;
    },
  }) as unknown as FileList;
}

function fileItem(file: File): DataTransferItem {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => file,
  } as DataTransferItem;
}

function stringItem(type = "text/plain"): DataTransferItem {
  return {
    kind: "string",
    type,
    getAsFile: () => null,
  } as DataTransferItem;
}

function itemList(...items: DataTransferItem[]): DataTransferItemList {
  return Object.assign([...items], {
    item(index: number) {
      return items[index] ?? null;
    },
  }) as unknown as DataTransferItemList;
}

function dataTransfer(
  items: DataTransferItemList,
  files: FileList,
): DataTransfer {
  return { items, files } as DataTransfer;
}

const options = (
  overrides: Partial<BrowserImageIntakeOptions> = {},
): BrowserImageIntakeOptions => ({
  acceptedMediaTypes: ["image/png", "image/jpeg", "image/webp"],
  maxFileBytes: 1_000,
  maxSelectionCount: 4,
  ...overrides,
});

const pdfOptions = (
  overrides: Partial<BrowserPdfIntakeOptions> = {},
): BrowserPdfIntakeOptions => ({
  maxFileBytes: 1_000,
  maxSelectionCount: 2,
  ...overrides,
});

describe("browser image intake", () => {
  it("extracts pasted file items without reading them and ignores clipboard text", () => {
    const image = fakeFile("pasted.png", "image/png", 120);
    const result = intakeClipboardImages(
      itemList(stringItem(), fileItem(image)),
      options(),
    );

    expect(result.rejections).toEqual([]);
    expect(result.selections).toHaveLength(1);
    expect(result.selections[0]).toMatchObject({
      source: image,
      filename: "pasted.png",
      mediaType: "image/png",
      byteSize: 120,
    });
    expect(result.selections[0]?.fingerprint).toMatch(
      /^browser-image:[a-f0-9]{16}$/,
    );
    expect(result.selections[0]?.idempotencyKey).toMatch(
      /^browser-intake:[a-f0-9]{16}$/,
    );
  });

  it("preserves accepted file-picker order while reporting mixed non-images", () => {
    const first = fakeFile("first.png", "image/png", 10);
    const text = fakeFile("notes.txt", "text/plain", 20);
    const second = fakeFile("second.jpg", "image/jpeg", 30);

    const result = intakeFileInputImages(
      fileList(first, text, second),
      options(),
    );

    expect(result.selections.map((entry) => entry.source)).toEqual([
      first,
      second,
    ]);
    expect(result.selections.map((entry) => entry.filename)).toEqual([
      "first.png",
      "second.jpg",
    ]);
    expect(result.rejections).toEqual([
      expect.objectContaining({
        source: text,
        filename: "notes.txt",
        reason: "unsupported_type",
      }),
    ]);
  });

  it("applies byte and count limits before accepting later files", () => {
    const oversized = fakeFile("large.png", "image/png", 101);
    const accepted = fakeFile("accepted.png", "image/png", 50);
    const overflow = fakeFile("overflow.jpg", "image/jpeg", 50);

    const result = intakeFileInputImages(
      fileList(oversized, accepted, overflow),
      options({ maxFileBytes: 100, maxSelectionCount: 1 }),
    );

    expect(result.selections.map((entry) => entry.source)).toEqual([accepted]);
    expect(result.rejections.map((entry) => entry.reason)).toEqual([
      "too_large",
      "count_overflow",
    ]);
    expect(result.rejections.map((entry) => entry.source)).toEqual([
      oversized,
      overflow,
    ]);
  });

  it("suppresses duplicates in source order and against existing fingerprints", () => {
    const existing = fakeFile("existing.png", "image/png", 10);
    const first = fakeFile("same.png", "image/png", 20);
    const duplicate = fakeFile("same.png", "image/png", 20);
    const distinct = fakeFile("same.png", "image/png", 20, { lastModified: 2 });

    const result = intakeFileInputImages(
      fileList(existing, first, duplicate, distinct),
      options({ existingFingerprints: [fingerprintBrowserImage(existing)] }),
    );

    expect(result.selections.map((entry) => entry.source)).toEqual([
      first,
      distinct,
    ]);
    expect(result.rejections.map((entry) => entry.reason)).toEqual([
      "duplicate",
      "duplicate",
    ]);
    expect(result.rejections.map((entry) => entry.source)).toEqual([
      existing,
      duplicate,
    ]);
  });

  it("extracts dropped files in item order and recommends consuming an accepted drop", () => {
    const first = fakeFile("first.webp", "image/webp", 10);
    const second = fakeFile("second.png", "image/png", 20);
    const transfer = dataTransfer(
      itemList(stringItem(), fileItem(first), fileItem(second)),
      fileList(second, first),
    );

    const result = intakeDroppedImages(transfer, options());

    expect(result.selections.map((entry) => entry.source)).toEqual([
      first,
      second,
    ]);
    expect(result.shouldPreventDefault).toBe(true);
  });

  it("does not recommend preventDefault when a drop has no accepted file", () => {
    const text = fakeFile("notes.txt", "text/plain", 10);
    const tooLarge = fakeFile("large.png", "image/png", 101);
    const result = intakeDroppedImages(
      dataTransfer(
        itemList(fileItem(text), fileItem(tooLarge)),
        fileList(text, tooLarge),
      ),
      options({ maxFileBytes: 100 }),
    );

    expect(result.selections).toEqual([]);
    expect(result.rejections.map((entry) => entry.reason)).toEqual([
      "unsupported_type",
      "too_large",
    ]);
    expect(result.shouldPreventDefault).toBe(false);
  });

  it("revokes each preview exactly once through item and aggregate cleanup", () => {
    const first = fakeFile("first.png", "image/png", 10);
    const second = fakeFile("second.png", "image/png", 20);
    const created: Blob[] = [];
    const revoked: string[] = [];
    const objectUrlApi = {
      createObjectURL(source: Blob) {
        created.push(source);
        return `blob:test-${created.length}`;
      },
      revokeObjectURL(url: string) {
        revoked.push(url);
      },
    };

    const result = intakeFileInputImages(fileList(first, second),
      options({ previews: { objectUrlApi } }),
    );

    expect(created).toEqual([first, second]);
    expect(result.previews.map((preview) => preview.url)).toEqual([
      "blob:test-1",
      "blob:test-2",
    ]);
    result.previews[0]?.revoke();
    result.previews[0]?.revoke();
    result.dispose();
    result.dispose();
    expect(revoked).toEqual(["blob:test-1", "blob:test-2"]);
  });

  it("feeds accepted browser sources into AttachmentUploader through the fixture", () => {
    const image = fakeFile("upload.png", "image/png", 40);
    const requests: AttachmentUploadRequest<Blob>[] = [];
    const fixture = enqueueFileInputImages(fileList(image), {
      async upload(request) {
        requests.push(request);
        const reference = {
          attachment_id: "att_browser_fixture",
          content_ref: "ref_browser_fixture",
          media_type: request.metadata.mediaType,
          byte_size: request.metadata.byteSize,
        };
        return request.metadata.filename === undefined
          ? reference
          : { ...reference, filename: request.metadata.filename };
      },
    });

    expect(fixture.intake.selections).toHaveLength(1);
    expect(fixture.uploadIds).toEqual(["attachment-upload-1"]);
    expect(requests[0]).toMatchObject({
      source: image,
      metadata: {
        filename: "upload.png",
        mediaType: "image/png",
        byteSize: 40,
      },
    });
  });

  it("rejects wildcard and out-of-protocol intake configuration", () => {
    const files = fileList(fakeFile("image.png", "image/png", 10));
    expect(() =>
      intakeFileInputImages(files, {
        ...options(),
        acceptedMediaTypes: ["image/*" as "image/png"],
      }),
    ).toThrow(BrowserImageIntakeValidationError);
    expect(() =>
      intakeFileInputImages(
        files,
        options({ maxFileBytes: Number.MAX_SAFE_INTEGER }),
      ),
    ).toThrow(BrowserImageIntakeValidationError);
  });

  it("does not consult object-URL APIs unless previews are requested", () => {
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    try {
      intakeFileInputImages(
        fileList(fakeFile("image.png", "image/png", 10)),
        options(),
      );
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      createObjectURL.mockRestore();
    }
  });
});

describe("browser PDF intake", () => {
  it("accepts spreadsheet documents through the generic document API", () => {
    const spreadsheetType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" as const;
    const sheet = fakeFile("adjustments.xlsx", spreadsheetType, 120);
    const result = intakeFileInputDocuments([sheet], {
      acceptedMediaTypes: [spreadsheetType],
      maxFileBytes: 1_000,
      maxSelectionCount: 2,
    });
    expect(fingerprintBrowserDocument(sheet)).toMatch(/^browser-pdf:/);
    expect(result.rejections).toEqual([]);
    expect(result.selections[0]).toMatchObject({
      kind: "document",
      filename: "adjustments.xlsx",
      mediaType: spreadsheetType,
      byteSize: 120,
    });
  });

  it("accepts File and Blob sources without reading bytes and derives stable opaque identities", () => {
    const file = fakeFile("quarterly report.pdf", "application/pdf", 120, {
      lastModified: 123,
    });
    const blob = fakeBlob("application/pdf", 80);

    const firstFingerprint = fingerprintBrowserPdf(file);
    const result = intakeFileInputPdfs([file, blob], pdfOptions());

    expect(fingerprintBrowserPdf(file)).toBe(firstFingerprint);
    expect(result.rejections).toEqual([]);
    expect(result.selections).toHaveLength(2);
    expect(result.selections[0]).toEqual({
      source: file,
      kind: "document",
      fingerprint: firstFingerprint,
      idempotencyKey: `browser-pdf-intake:${firstFingerprint.slice("browser-pdf:".length)}`,
      mediaType: "application/pdf",
      byteSize: 120,
      filename: "quarterly report.pdf",
    });
    expect(result.selections[1]).toMatchObject({
      source: blob,
      kind: "document",
      mediaType: "application/pdf",
      byteSize: 80,
      filename: expect.stringMatching(/^document-[a-f0-9]{16}\.pdf$/),
      fingerprint: expect.stringMatching(/^browser-pdf:[a-f0-9]{16}$/),
      idempotencyKey: expect.stringMatching(/^browser-pdf-intake:[a-f0-9]{16}$/),
    });
  });

  it("returns only host-owned source plus durable metadata, with no preview or storage material", () => {
    const pdf = fakeFile("bounded.pdf", "application/pdf", 50);
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    try {
      const result = intakeFileInputPdfs(fileList(pdf), pdfOptions());
      const selection = result.selections[0]!;
      const { source, ...metadata } = selection;

      expect(source).toBe(pdf);
      expect(Object.keys(metadata).sort()).toEqual([
        "byteSize",
        "filename",
        "fingerprint",
        "idempotencyKey",
        "kind",
        "mediaType",
      ]);
      for (const forbidden of [
        "bytes",
        "data",
        "dataUrl",
        "url",
        "previewUrl",
        "content_ref",
        "contentRef",
        "storageRef",
      ]) {
        expect(metadata).not.toHaveProperty(forbidden);
        expect(result).not.toHaveProperty(forbidden);
      }
      expect(result).not.toHaveProperty("previews");
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      createObjectURL.mockRestore();
    }
  });

  it("rejects unsafe and credential-like filenames without echoing them as metadata", () => {
    const path = fakeFile("../private.pdf", "application/pdf", 10);
    const credential = fakeFile(
      "token=credential-value.pdf",
      "application/pdf",
      10,
    );
    const control = fakeFile("unsafe\u0000.pdf", "application/pdf", 10);

    const result = intakeFileInputPdfs(
      fileList(path, credential, control),
      pdfOptions(),
    );

    expect(result.selections).toEqual([]);
    expect(result.rejections.map(({ reason }) => reason)).toEqual([
      "unsafe_filename",
      "unsafe_filename",
      "unsafe_filename",
    ]);
    expect(result.rejections.every((rejection) => rejection.filename === undefined))
      .toBe(true);
  });

  it("rejects unsupported, empty, oversized, duplicate, and overflowing PDFs deterministically", () => {
    const unsupported = fakeFile("notes.txt", "text/plain", 10);
    const empty = fakeFile("empty.pdf", "application/pdf", 0);
    const oversized = fakeFile("large.pdf", "application/pdf", 101);
    const accepted = fakeFile("accepted.pdf", "application/pdf", 50);
    const duplicate = fakeFile("accepted.pdf", "application/pdf", 50);
    const overflow = fakeFile("overflow.pdf", "application/pdf", 40);

    const result = intakeFileInputPdfs(
      fileList(unsupported, empty, oversized, accepted, duplicate, overflow),
      pdfOptions({ maxFileBytes: 100, maxSelectionCount: 1 }),
    );

    expect(result.selections.map(({ source }) => source)).toEqual([accepted]);
    expect(result.rejections.map(({ source }) => source)).toEqual([
      unsupported,
      empty,
      oversized,
      duplicate,
      overflow,
    ]);
    expect(result.rejections.map(({ reason }) => reason)).toEqual([
      "unsupported_type",
      "empty_file",
      "too_large",
      "duplicate",
      "count_overflow",
    ]);
  });

  it("deduplicates mixed existing state while counting documents independently from images", () => {
    const existing = fakeFile("existing.pdf", "application/pdf", 20);
    const accepted = fakeFile("accepted.pdf", "application/pdf", 30);
    const overflow = fakeFile("overflow.pdf", "application/pdf", 40);
    const existingFingerprint = fingerprintBrowserPdf(existing);

    const result = intakeFileInputPdfs(
      fileList(existing, accepted, overflow),
      pdfOptions({
        maxSelectionCount: 2,
        existingSelectionCount: 0,
        existingSelections: [
          { fingerprint: "browser-image:existing", kind: "image" },
          { fingerprint: "legacy-image:existing" },
          { fingerprint: existingFingerprint, kind: "document" },
        ],
      }),
    );

    expect(result.selections.map(({ source }) => source)).toEqual([accepted]);
    expect(result.rejections.map(({ source, reason }) => ({ source, reason })))
      .toEqual([
        { source: existing, reason: "duplicate" },
        { source: overflow, reason: "count_overflow" },
      ]);
  });

  it("honors explicit existing fingerprints and exact existing document counts", () => {
    const duplicate = fakeFile("same.pdf", "application/pdf", 20);
    const overflow = fakeFile("new.pdf", "application/pdf", 20);
    const result = intakeFileInputPdfs(
      fileList(duplicate, overflow),
      pdfOptions({
        existingFingerprints: [fingerprintBrowserPdf(duplicate)],
        existingSelectionCount: 2,
      }),
    );

    expect(result.selections).toEqual([]);
    expect(result.rejections.map(({ reason }) => reason)).toEqual([
      "duplicate",
      "count_overflow",
    ]);
  });

  it("preserves DataTransfer item order and recommends consuming accepted PDFs", () => {
    const first = fakeFile("first.pdf", "application/pdf", 10);
    const second = fakeFile("second.pdf", "application/pdf", 20);
    const transfer = dataTransfer(
      itemList(stringItem(), fileItem(first), fileItem(second)),
      fileList(second, first),
    );

    const result = intakeDroppedPdfs(transfer, pdfOptions());

    expect(result.selections.map(({ source }) => source)).toEqual([
      first,
      second,
    ]);
    expect(result.shouldPreventDefault).toBe(true);
  });

  it("falls back to the drop FileList and recommends no preventDefault without acceptance", () => {
    const accepted = fakeFile("fallback.pdf", "application/pdf", 10);
    const fallback = intakeDroppedPdfs(
      dataTransfer(itemList(stringItem()), fileList(accepted)),
      pdfOptions(),
    );
    expect(fallback.selections.map(({ source }) => source)).toEqual([accepted]);
    expect(fallback.shouldPreventDefault).toBe(true);

    const rejected = intakeDroppedPdfs(
      dataTransfer(
        itemList(fileItem(fakeFile("notes.txt", "text/plain", 10))),
        fileList(accepted),
      ),
      pdfOptions(),
    );
    expect(rejected.selections).toEqual([]);
    expect(rejected.rejections[0]?.reason).toBe("unsupported_type");
    expect(rejected.shouldPreventDefault).toBe(false);
  });

  it("provides idempotent no-op cleanup because PDF intake owns no preview resources", () => {
    const result = intakeFileInputPdfs(
      fileList(fakeFile("clean.pdf", "application/pdf", 10)),
      pdfOptions(),
    );
    expect(() => {
      result.dispose();
      result.dispose();
    }).not.toThrow();
  });

  it("hands the original source and uploader AbortSignal to the host adapter", async () => {
    const pdf = fakeFile("abort.pdf", "application/pdf", 40);
    const requests: AttachmentUploadRequest<Blob>[] = [];
    const fixture = enqueueFileInputPdfs(fileList(pdf), {
      upload(request) {
        requests.push(request);
        request.onProgress({ uploadedBytes: 10, totalBytes: 40 });
        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    });

    expect(requests[0]).toMatchObject({
      source: pdf,
      metadata: {
        kind: "document",
        filename: "abort.pdf",
        mediaType: "application/pdf",
        byteSize: 40,
      },
    });
    expect(requests[0]?.signal.aborted).toBe(false);
    expect(fixture.uploader.getSnapshot().items[0]?.progress.uploadedBytes).toBe(10);

    expect(fixture.uploader.cancel(fixture.uploadIds[0]!)).toBe(true);
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(fixture.uploader.getSnapshot().items[0]?.status).toBe("cancelled");
    await Promise.resolve();
    fixture.uploader.dispose();
  });

  it("rejects wildcard and out-of-protocol PDF intake configuration", () => {
    const files = fileList(fakeFile("document.pdf", "application/pdf", 10));
    expect(() =>
      intakeFileInputPdfs(files, {
        ...pdfOptions(),
        acceptedMediaTypes: ["application/*" as "application/pdf"],
      }),
    ).toThrow(BrowserPdfIntakeValidationError);
    expect(() =>
      intakeFileInputPdfs(
        files,
        pdfOptions({ maxFileBytes: Number.MAX_SAFE_INTEGER }),
      ),
    ).toThrow(BrowserPdfIntakeValidationError);
    expect(() =>
      intakeFileInputPdfs(files, pdfOptions({ maxSelectionCount: 5 })),
    ).toThrow(BrowserPdfIntakeValidationError);
  });
});
