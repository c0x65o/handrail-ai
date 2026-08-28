import type { AttachmentSelection } from "../attachments/types.js";
import {
  AI_RUNTIME_IMAGE_MIME_TYPES,
  AI_RUNTIME_PROTOCOL_LIMITS,
  type ImageMimeType,
} from "../protocol.js";

export const BROWSER_IMAGE_INTAKE_REJECTION_REASONS = [
  "unsupported_type",
  "too_large",
  "count_overflow",
  "duplicate",
  "empty_file",
] as const;

export type BrowserImageIntakeRejectionReason =
  (typeof BROWSER_IMAGE_INTAKE_REJECTION_REASONS)[number];

/** The browser-owned binary value forwarded unchanged to AttachmentUploader. */
export type BrowserAttachmentSource = Blob;

export interface BrowserObjectUrlApi {
  createObjectURL(source: Blob): string;
  revokeObjectURL(url: string): void;
}

export interface BrowserImagePreviewOptions {
  /** Defaults lazily to the browser's URL static methods. */
  readonly objectUrlApi?: BrowserObjectUrlApi;
}

export interface BrowserImageIntakeOptions {
  /** Exact protocol image MIME types to accept. Wildcards are not supported. */
  readonly acceptedMediaTypes: readonly ImageMimeType[];
  /** Positive integer no greater than the protocol's per-image byte limit. */
  readonly maxFileBytes: number;
  /** Positive integer limiting selections after existingSelectionCount. */
  readonly maxSelectionCount: number;
  /** Fingerprints already held by the caller and therefore treated as duplicates. */
  readonly existingFingerprints?: Iterable<string>;
  /** Existing selections that count toward maxSelectionCount. Defaults to zero. */
  readonly existingSelectionCount?: number;
  /** Opt in to object-URL previews, optionally with an injected URL API. */
  readonly previews?: boolean | BrowserImagePreviewOptions;
}

export interface BrowserImageIntakeRejection {
  readonly source: BrowserAttachmentSource;
  readonly filename?: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly fingerprint: string;
  readonly reason: BrowserImageIntakeRejectionReason;
}

export interface BrowserImagePreview {
  readonly fingerprint: string;
  readonly url: string;
  /** Idempotently revokes this preview's object URL. */
  revoke(): void;
}

export interface BrowserImageIntakeResult {
  readonly selections: readonly AttachmentSelection<BrowserAttachmentSource>[];
  readonly rejections: readonly BrowserImageIntakeRejection[];
  readonly previews: readonly BrowserImagePreview[];
  /** Idempotently revokes every preview URL created by this intake operation. */
  dispose(): void;
}

export interface BrowserDropImageIntakeResult extends BrowserImageIntakeResult {
  /** True only when this drop operation produced at least one accepted selection. */
  readonly shouldPreventDefault: boolean;
}

export class BrowserImageIntakeValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "BrowserImageIntakeValidationError";
  }
}

interface ValidatedOptions {
  readonly acceptedMediaTypes: ReadonlySet<ImageMimeType>;
  readonly maxFileBytes: number;
  readonly maxSelectionCount: number;
  readonly existingFingerprints: ReadonlySet<string>;
  readonly existingSelectionCount: number;
  readonly previews: false | BrowserImagePreviewOptions;
}

const PROTOCOL_IMAGE_MIME_TYPES = new Set<string>(AI_RUNTIME_IMAGE_MIME_TYPES);
const UNSAFE_FILENAME_CHARACTERS = '<>:"/\\|?*';
const CREDENTIAL_VALUE_PATTERNS = [
  /\bbearer\s+[a-z0-9._~+/=-]{8,}/i,
  /(?:^|[^a-z0-9])sk-[a-z0-9_-]{8,}\b/i,
  /-----begin (?:rsa |ec |openssh )?private key-----/i,
] as const;

function validateOptions(options: BrowserImageIntakeOptions): ValidatedOptions {
  if (options === null || typeof options !== "object") {
    throw new BrowserImageIntakeValidationError("options must be an object");
  }
  if (options.acceptedMediaTypes.length === 0) {
    throw new BrowserImageIntakeValidationError(
      "acceptedMediaTypes must contain at least one protocol image MIME type",
    );
  }
  const acceptedMediaTypes = new Set<ImageMimeType>();
  for (const mediaType of options.acceptedMediaTypes) {
    if (!PROTOCOL_IMAGE_MIME_TYPES.has(mediaType)) {
      throw new BrowserImageIntakeValidationError(
        `acceptedMediaTypes contains unsupported MIME type ${JSON.stringify(mediaType)}`,
      );
    }
    acceptedMediaTypes.add(mediaType);
  }
  if (
    !Number.isSafeInteger(options.maxFileBytes) ||
    options.maxFileBytes < AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMinBytes ||
    options.maxFileBytes > AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes
  ) {
    throw new BrowserImageIntakeValidationError(
      `maxFileBytes must be an integer from ${AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMinBytes} through ${AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes}`,
    );
  }
  if (!Number.isSafeInteger(options.maxSelectionCount) || options.maxSelectionCount < 1) {
    throw new BrowserImageIntakeValidationError(
      "maxSelectionCount must be a positive integer",
    );
  }
  const existingSelectionCount = options.existingSelectionCount ?? 0;
  if (!Number.isSafeInteger(existingSelectionCount) || existingSelectionCount < 0) {
    throw new BrowserImageIntakeValidationError(
      "existingSelectionCount must be a non-negative integer",
    );
  }

  let previews: false | BrowserImagePreviewOptions = false;
  if (options.previews === true) previews = {};
  else if (options.previews !== undefined && options.previews !== false) {
    if (options.previews === null || typeof options.previews !== "object") {
      throw new BrowserImageIntakeValidationError(
        "previews must be a boolean or preview options object",
      );
    }
    previews = options.previews;
  }

  return {
    acceptedMediaTypes,
    maxFileBytes: options.maxFileBytes,
    maxSelectionCount: options.maxSelectionCount,
    existingFingerprints: new Set(options.existingFingerprints ?? []),
    existingSelectionCount,
    previews,
  };
}

function opaqueHash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second ^= second >>> 13;
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/**
 * Returns a metadata-derived opaque identity without reading the Blob contents.
 * Files with the same browser metadata intentionally collapse within intake.
 */
export function fingerprintBrowserImage(source: BrowserAttachmentSource): string {
  const file = source as Blob & {
    readonly name?: unknown;
    readonly lastModified?: unknown;
  };
  const name = typeof file.name === "string" ? file.name : "";
  const lastModified =
    typeof file.lastModified === "number" && Number.isFinite(file.lastModified)
      ? file.lastModified
      : 0;
  const identity = JSON.stringify([name, source.type, source.size, lastModified]);
  return `browser-image:${opaqueHash(identity)}`;
}

function normalizedFilename(
  source: BrowserAttachmentSource,
  fingerprint: string,
): string | undefined {
  const name = (source as Blob & { readonly name?: unknown }).name;
  if (typeof name !== "string" || name.length === 0) return undefined;
  const sanitized = [...name]
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 31 ||
        codePoint === 127 ||
        UNSAFE_FILENAME_CHARACTERS.includes(character)
        ? "_"
        : character;
    })
    .join("")
    .slice(0, AI_RUNTIME_PROTOCOL_LIMITS.attachmentFilenameLength);
  if (
    sanitized.length === 0 ||
    sanitized === "." ||
    sanitized === ".." ||
    CREDENTIAL_VALUE_PATTERNS.some((pattern) => pattern.test(sanitized))
  ) {
    return `image-${fingerprint.slice("browser-image:".length)}.bin`;
  }
  return sanitized;
}

function rejection(
  source: BrowserAttachmentSource,
  fingerprint: string,
  reason: BrowserImageIntakeRejectionReason,
): BrowserImageIntakeRejection {
  const filename = normalizedFilename(source, fingerprint);
  return Object.freeze(
    filename === undefined
      ? {
          source,
          mediaType: source.type,
          byteSize: source.size,
          fingerprint,
          reason,
        }
      : {
          source,
          filename,
          mediaType: source.type,
          byteSize: source.size,
          fingerprint,
          reason,
        },
  );
}

function selection(
  source: BrowserAttachmentSource,
  fingerprint: string,
  mediaType: ImageMimeType,
): AttachmentSelection<BrowserAttachmentSource> {
  const filename = normalizedFilename(source, fingerprint);
  const base = {
    source,
    fingerprint,
    idempotencyKey: `browser-intake:${fingerprint.slice("browser-image:".length)}`,
    mediaType,
    byteSize: source.size,
  };
  return Object.freeze(filename === undefined ? base : { ...base, filename });
}

function browserObjectUrlApi(): BrowserObjectUrlApi {
  const candidate = globalThis.URL as unknown as Partial<BrowserObjectUrlApi>;
  if (
    typeof candidate?.createObjectURL !== "function" ||
    typeof candidate.revokeObjectURL !== "function"
  ) {
    throw new BrowserImageIntakeValidationError(
      "Object-URL previews require an injected objectUrlApi or browser URL support",
    );
  }
  return candidate as BrowserObjectUrlApi;
}

function createPreviews(
  selections: readonly AttachmentSelection<BrowserAttachmentSource>[],
  options: false | BrowserImagePreviewOptions,
): {
  readonly previews: readonly BrowserImagePreview[];
  readonly dispose: () => void;
} {
  if (options === false || selections.length === 0) {
    return { previews: Object.freeze([]), dispose: () => undefined };
  }
  const api = options.objectUrlApi ?? browserObjectUrlApi();
  const previews: BrowserImagePreview[] = [];

  const dispose = (): void => {
    for (const preview of previews) {
      try {
        preview.revoke();
      } catch {
        // A failing host URL API must not prevent cleanup of later previews.
      }
    }
  };

  try {
    for (const accepted of selections) {
      const url = api.createObjectURL(accepted.source);
      if (typeof url !== "string" || url.length === 0) {
        throw new BrowserImageIntakeValidationError(
          "objectUrlApi.createObjectURL must return a non-empty string",
        );
      }
      let revoked = false;
      previews.push(
        Object.freeze({
          fingerprint: accepted.fingerprint,
          url,
          revoke(): void {
            if (revoked) return;
            revoked = true;
            api.revokeObjectURL(url);
          },
        }),
      );
    }
  } catch (error) {
    dispose();
    throw error;
  }

  return { previews: Object.freeze(previews), dispose };
}

function intakeImages(
  sources: readonly BrowserAttachmentSource[],
  rawOptions: BrowserImageIntakeOptions,
): BrowserImageIntakeResult {
  const options = validateOptions(rawOptions);
  const seen = new Set(options.existingFingerprints);
  const selections: AttachmentSelection<BrowserAttachmentSource>[] = [];
  const rejections: BrowserImageIntakeRejection[] = [];

  for (const source of sources) {
    const fingerprint = fingerprintBrowserImage(source);
    const mediaType = source.type;
    if (!options.acceptedMediaTypes.has(mediaType as ImageMimeType)) {
      rejections.push(rejection(source, fingerprint, "unsupported_type"));
      continue;
    }
    if (!Number.isSafeInteger(source.size) || source.size < 1) {
      rejections.push(rejection(source, fingerprint, "empty_file"));
      continue;
    }
    if (source.size > options.maxFileBytes) {
      rejections.push(rejection(source, fingerprint, "too_large"));
      continue;
    }
    if (seen.has(fingerprint)) {
      rejections.push(rejection(source, fingerprint, "duplicate"));
      continue;
    }
    if (
      options.existingSelectionCount + selections.length >=
      options.maxSelectionCount
    ) {
      rejections.push(rejection(source, fingerprint, "count_overflow"));
      continue;
    }
    seen.add(fingerprint);
    selections.push(selection(source, fingerprint, mediaType as ImageMimeType));
  }

  const previewResult = createPreviews(selections, options.previews);
  return Object.freeze({
    selections: Object.freeze(selections),
    rejections: Object.freeze(rejections),
    previews: previewResult.previews,
    dispose: previewResult.dispose,
  });
}

function filesFromList(files: FileList): BrowserAttachmentSource[] {
  const sources: BrowserAttachmentSource[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] ?? files.item(index);
    if (file !== null && file !== undefined) sources.push(file);
  }
  return sources;
}

function filesFromItems(items: DataTransferItemList): BrowserAttachmentSource[] {
  const sources: BrowserAttachmentSource[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) sources.push(file);
  }
  return sources;
}

/** Extracts file-kind clipboard items in source order and ignores string items. */
export function intakeClipboardImages(
  items: DataTransferItemList,
  options: BrowserImageIntakeOptions,
): BrowserImageIntakeResult {
  return intakeImages(filesFromItems(items), options);
}

/** Extracts a file input's files in source order. */
export function intakeFileInputImages(
  files: FileList,
  options: BrowserImageIntakeOptions,
): BrowserImageIntakeResult {
  return intakeImages(filesFromList(files), options);
}

/** Extracts file-kind drop items and reports whether the host should consume the drop. */
export function intakeDroppedImages(
  dataTransfer: DataTransfer,
  options: BrowserImageIntakeOptions,
): BrowserDropImageIntakeResult {
  const itemFiles = filesFromItems(dataTransfer.items);
  const result = intakeImages(
    itemFiles.length > 0 ? itemFiles : filesFromList(dataTransfer.files),
    options,
  );
  return Object.freeze({
    ...result,
    shouldPreventDefault: result.selections.length > 0,
  });
}
