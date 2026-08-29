import {
  AI_RUNTIME_IMAGE_MIME_TYPES,
  AI_RUNTIME_PROTOCOL_LIMITS,
  createAttachmentUploader,
  type AttachmentUploadAdapter,
} from "@handrail/ai";
import {
  intakeFileInputImages,
  intakeFileInputPdfs,
  type BrowserAttachmentSource,
  type BrowserImageIntakeResult,
  type BrowserPdfIntakeResult,
} from "@handrail/ai/browser";

/** Minimal headless file-input-to-uploader integration for browser consumers. */
export function enqueueFileInputImages(
  files: FileList,
  adapter: AttachmentUploadAdapter<BrowserAttachmentSource>,
): {
  readonly intake: BrowserImageIntakeResult;
  readonly uploader: ReturnType<
    typeof createAttachmentUploader<BrowserAttachmentSource>
  >;
  readonly uploadIds: readonly string[];
} {
  const intake = intakeFileInputImages(files, {
    acceptedMediaTypes: AI_RUNTIME_IMAGE_MIME_TYPES,
    maxFileBytes: AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentMaxBytes,
    maxSelectionCount: AI_RUNTIME_PROTOCOL_LIMITS.imageAttachmentsPerMessage,
  });
  const uploader = createAttachmentUploader(adapter);
  const uploadIds = intake.selections.map((selection) =>
    uploader.enqueue(selection),
  );
  return { intake, uploader, uploadIds };
}

/** Minimal headless PDF file-input-to-uploader integration for browser consumers. */
export function enqueueFileInputPdfs(
  files: FileList | readonly BrowserAttachmentSource[],
  adapter: AttachmentUploadAdapter<BrowserAttachmentSource>,
): {
  readonly intake: BrowserPdfIntakeResult;
  readonly uploader: ReturnType<
    typeof createAttachmentUploader<BrowserAttachmentSource>
  >;
  readonly uploadIds: readonly string[];
} {
  const intake = intakeFileInputPdfs(files, {
    maxFileBytes: AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentMaxBytes,
    maxSelectionCount: AI_RUNTIME_PROTOCOL_LIMITS.documentAttachmentsPerMessage,
  });
  const uploader = createAttachmentUploader(adapter);
  const uploadIds = intake.selections.map((selection) =>
    uploader.enqueue(selection),
  );
  return { intake, uploader, uploadIds };
}
