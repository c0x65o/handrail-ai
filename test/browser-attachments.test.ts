import { describe, expect, it, vi } from "vitest";

import {
  BrowserImageIntakeValidationError,
  fingerprintBrowserImage,
  intakeClipboardImages,
  intakeDroppedImages,
  intakeFileInputImages,
  type BrowserImageIntakeOptions,
} from "../src/browser/index.js";
import type { AttachmentUploadRequest } from "../src/attachments/index.js";
import { enqueueFileInputImages } from "./fixtures/browser-attachment-uploader.js";

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
