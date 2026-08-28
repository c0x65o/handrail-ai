import {
  AI_RUNTIME_IMAGE_MIME_TYPES,
  AI_RUNTIME_PROTOCOL_LIMITS,
  createAttachmentUploader,
  type AttachmentUploadAdapter,
} from "@handrail/ai";
import {
  intakeFileInputImages,
  type BrowserAttachmentSource,
  type BrowserImageIntakeResult,
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
