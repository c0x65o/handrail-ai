/** @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttachmentUploadAdapterError,
  createAttachmentUploader,
  createConversationStore,
  type AttachmentReference,
  type AttachmentUploadRequest,
  type ConversationId,
  type ConversationRuntime,
  type ConversationRuntimeTurnResult,
} from "../src/index.js";
import {
  ConversationProvider,
  useConversationComposer,
  type ConversationComposerResult,
  type UseConversationComposerOptions,
} from "../src/react/index.js";

afterEach(() => cleanup());

const completed = (status: ConversationRuntimeTurnResult["status"] = "completed") => ({
  turnId: "turn_composer",
  status,
  checkpoint: {
    lastAppliedEventId: null,
    lastAppliedCursor: null,
    lastAppliedRevision: null,
  },
}) as ConversationRuntimeTurnResult;

function fakeRuntime<TRequest>(conversationId = "conversation_composer") {
  const store = createConversationStore(conversationId as ConversationId);
  const sendMessage = vi.fn<ConversationRuntime<TRequest>["sendMessage"]>();
  sendMessage.mockResolvedValue(completed());
  const runtime = {
    store,
    getSnapshot: store.getSnapshot,
    observe(observer: Parameters<ConversationRuntime<TRequest>["observe"]>[0]) {
      return store.subscribe(() => observer(store.getSnapshot()));
    },
    sendMessage,
    resumeTurn: vi.fn(),
    restoreActiveTurn: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ConversationRuntime<TRequest>;
  return { runtime, sendMessage };
}

function wrapper<TRequest>(runtime: ConversationRuntime<TRequest>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <ConversationProvider runtime={runtime}>{children}</ConversationProvider>;
  };
}

function file(name: string, type = "image/png", contents = "image"): File {
  return new File([contents], name, { type, lastModified: 1_700_000_000_000 });
}

function fileList(...files: File[]): FileList {
  return Object.assign([...files], {
    item(index: number) {
      return files[index] ?? null;
    },
  }) as unknown as FileList;
}

function fileItem(source: File): DataTransferItem {
  return {
    kind: "file",
    type: source.type,
    getAsFile: () => source,
  } as DataTransferItem;
}

function itemList(...items: DataTransferItem[]): DataTransferItemList {
  return Object.assign([...items], {
    item(index: number) {
      return items[index] ?? null;
    },
  }) as unknown as DataTransferItemList;
}

function reference(request: AttachmentUploadRequest<Blob>): AttachmentReference {
  const suffix = request.idempotencyKey.slice(-8);
  return {
    attachment_id: `att_${suffix}`,
    content_ref: `ref_${suffix}`,
    media_type: request.metadata.mediaType,
    byte_size: request.metadata.byteSize,
    ...(request.metadata.filename === undefined
      ? {}
      : { filename: request.metadata.filename }),
  };
}

function immediateUploader() {
  return createAttachmentUploader<Blob>({
    async upload(request) {
      return reference(request);
    },
  });
}

function objectUrls() {
  const revoked: string[] = [];
  let next = 0;
  return {
    revoked,
    api: {
      createObjectURL() {
        next += 1;
        return `blob:composer-${next}`;
      },
      revokeObjectURL(url: string) {
        revoked.push(url);
      },
    },
  };
}

function keyEvent(overrides: Record<string, unknown> = {}) {
  return {
    key: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
    preventDefault: vi.fn(),
    ...overrides,
  };
}

describe("useConversationComposer", () => {
  it("sends text, manages typing, keeps Enter opt-in and IME-safe, and uses injected cancel", async () => {
    const { runtime, sendMessage } = fakeRuntime<{ model: string }>();
    const uploader = immediateUploader();
    const presence = {
      noteActivity: vi.fn(),
      setTyping: vi.fn(),
      stopTyping: vi.fn(),
      switchConversation: vi.fn(),
    };
    const onCancel = vi.fn();
    const { result, rerender } = renderHook(
      ({ enterBehavior }: { enterBehavior: "newline" | "send" }) =>
        useConversationComposer({
          uploader,
          presence,
          request: { model: "test" },
          enterBehavior,
          onCancel,
          imageIntake: { previews: false },
        }),
      {
        initialProps: {
          enterBehavior: "newline" as "newline" | "send",
        },
        wrapper: wrapper(runtime),
      },
    );

    act(() => result.current.setDraft("hello"));
    expect(result.current.canSend).toBe(true);
    expect(presence.noteActivity).toHaveBeenCalled();
    expect(presence.setTyping).toHaveBeenCalledWith(true);

    const newline = keyEvent();
    act(() => result.current.getTextareaProps().onKeyDown(newline as never));
    expect(newline.preventDefault).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();

    rerender({ enterBehavior: "send" });
    act(() => result.current.getTextareaProps().onCompositionStart({} as never));
    const composing = keyEvent();
    act(() => result.current.getTextareaProps().onKeyDown(composing as never));
    expect(sendMessage).not.toHaveBeenCalled();
    act(() => result.current.getTextareaProps().onCompositionEnd({} as never));

    const sending = keyEvent();
    act(() => result.current.getTextareaProps().onKeyDown(sending as never));
    expect(sending.preventDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.draft).toBe(""));
    expect(sendMessage).toHaveBeenCalledWith({
      content: "hello",
      attachments: [],
      request: { model: "test" },
    });
    expect(presence.stopTyping).toHaveBeenCalledWith("send");

    act(() => result.current.getTextareaProps().onBlur());
    expect(presence.stopTyping).toHaveBeenCalledWith("blur");
    await expect(result.current.cancel()).resolves.toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("accepts paste, picker, and drop images and sends a ready image-only message", async () => {
    const { runtime, sendMessage } = fakeRuntime<{ refs: readonly string[] }>();
    const uploader = immediateUploader();
    const urls = objectUrls();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      createRequest: ({ attachments }) => ({
        refs: attachments.map((attachment) => attachment.content_ref),
      }),
      imageIntake: { previews: { objectUrlApi: urls.api } },
    }), { wrapper: wrapper(runtime) });

    const pasted = file("paste.png", "image/png", "pasted");
    const picked = file("picker.jpg", "image/jpeg", "picked");
    const dropped = file("drop.webp", "image/webp", "dropped");
    const pastePreventDefault = vi.fn();
    act(() => result.current.getTextareaProps().onPaste({
      clipboardData: { items: itemList(fileItem(pasted)) },
      preventDefault: pastePreventDefault,
    } as never));
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(picked) },
    } as never));
    const dropPreventDefault = vi.fn();
    act(() => result.current.getDropProps().onDrop({
      dataTransfer: {
        items: itemList(fileItem(dropped)),
        files: fileList(dropped),
      },
      preventDefault: dropPreventDefault,
    } as never));

    expect(pastePreventDefault).toHaveBeenCalledOnce();
    expect(dropPreventDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(result.current.attachments.map(({ status }) => status)).toEqual([
      "ready",
      "ready",
      "ready",
    ]));
    expect(result.current.draft).toBe("");
    expect(result.current.canSend).toBe(true);

    await act(() => result.current.submit());
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: [],
      attachments: [
        expect.objectContaining({ filename: "paste.png" }),
        expect.objectContaining({ filename: "picker.jpg" }),
        expect.objectContaining({ filename: "drop.webp" }),
      ],
      request: { refs: expect.any(Array) },
    }));
    expect(result.current.attachments).toEqual([]);
    expect(urls.revoked).toEqual([
      "blob:composer-1",
      "blob:composer-2",
      "blob:composer-3",
    ]);
  });

  it("gates pending and failed uploads, then supports retry and removal", async () => {
    let resolvePending: ((value: AttachmentReference) => void) | undefined;
    const attempts = new Map<string, number>();
    const uploader = createAttachmentUploader<Blob>({
      upload(request) {
        const name = request.metadata.filename ?? "";
        const attempt = (attempts.get(name) ?? 0) + 1;
        attempts.set(name, attempt);
        if (name === "retry.png" && attempt === 1) {
          return Promise.reject(new AttachmentUploadAdapterError({ retryable: true }));
        }
        if (name === "pending.png") {
          return new Promise<AttachmentReference>((resolve, reject) => {
            resolvePending = resolve;
            request.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return Promise.resolve(reference(request));
      },
    });
    const { runtime } = fakeRuntime<undefined>();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      imageIntake: { previews: false },
    }), { wrapper: wrapper(runtime) });

    act(() => result.current.getFileInputProps().onChange({
      currentTarget: {
        files: fileList(file("retry.png"), file("pending.png")),
      },
    } as never));
    await waitFor(() => expect(result.current.attachments.map(({ status }) => status)).toEqual([
      "failed",
      "uploading",
    ]));
    expect(result.current.canSend).toBe(false);
    expect(result.current.errors).toContainEqual(expect.objectContaining({
      source: "upload",
      retryable: true,
    }));

    const [failed, pending] = result.current.attachments;
    expect(failed).toBeDefined();
    expect(pending).toBeDefined();
    act(() => {
      expect(result.current.retryAttachment(failed!.id)).toBe(true);
    });
    await waitFor(() => expect(result.current.attachments[0]?.status).toBe("ready"));
    act(() => {
      expect(result.current.removeAttachment(pending!.id)).toBe(true);
    });
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    expect(result.current.canSend).toBe(true);
    expect(resolvePending).toBeDefined();
  });

  it("retains recoverable input after failure and clears only after success", async () => {
    const { runtime, sendMessage } = fakeRuntime<undefined>();
    sendMessage
      .mockResolvedValueOnce({
        ...completed("failed"),
        error: { code: "provider_failed", message: "Try again.", retryable: true },
      })
      .mockResolvedValueOnce(completed());
    const uploader = immediateUploader();
    const urls = objectUrls();
    const { result } = renderHook(() => useConversationComposer({
      uploader,
      imageIntake: { previews: { objectUrlApi: urls.api } },
    }), { wrapper: wrapper(runtime) });

    act(() => result.current.setDraft("recover me"));
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(file("recover.png")) },
    } as never));
    await waitFor(() => expect(result.current.canSend).toBe(true));

    await act(() => result.current.submit());
    expect(result.current.draft).toBe("recover me");
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.errors).toContainEqual(expect.objectContaining({
      source: "send",
      code: "provider_failed",
    }));
    expect(urls.revoked).toEqual([]);

    await act(() => result.current.submit());
    expect(result.current.draft).toBe("");
    expect(result.current.attachments).toEqual([]);
    expect(urls.revoked).toEqual(["blob:composer-1"]);
  });

  it("cleans up previews and typing across conversation switches and unmount", async () => {
    const { runtime } = fakeRuntime<undefined>("conversation_one");
    const uploader = immediateUploader();
    const urls = objectUrls();
    const presence = {
      noteActivity: vi.fn(),
      setTyping: vi.fn(),
      stopTyping: vi.fn(),
      switchConversation: vi.fn(),
    };
    const firstId = "conversation_one" as ConversationId;
    const secondId = "conversation_two" as ConversationId;
    const { result, rerender, unmount } = renderHook(
      ({ conversationId }: { conversationId: ConversationId }) =>
        useConversationComposer({
          uploader,
          presence,
          conversationId,
          imageIntake: { previews: { objectUrlApi: urls.api } },
        }),
      {
        initialProps: { conversationId: firstId },
        wrapper: wrapper(runtime),
      },
    );
    act(() => result.current.setDraft("typing"));
    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(file("first.png")) },
    } as never));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));

    rerender({ conversationId: secondId });
    await waitFor(() => expect(result.current.attachments).toEqual([]));
    expect(urls.revoked).toEqual(["blob:composer-1"]);
    expect(presence.stopTyping).toHaveBeenCalledWith("conversation_switch");
    expect(presence.switchConversation).toHaveBeenCalledWith(secondId);

    act(() => result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(file("second.png")) },
    } as never));
    await waitFor(() => expect(result.current.attachments).toHaveLength(1));
    unmount();
    expect(urls.revoked).toEqual(["blob:composer-1", "blob:composer-2"]);
    expect(presence.stopTyping).toHaveBeenCalledWith("destroy");
  });

  it("isolates two composer drafts and upload ownership on one runtime and uploader", async () => {
    const { runtime, sendMessage } = fakeRuntime<undefined>();
    const uploader = immediateUploader();
    const first = renderHook(() => useConversationComposer({
      uploader,
      imageIntake: { previews: false },
    }), { wrapper: wrapper(runtime) });
    const second = renderHook(() => useConversationComposer({
      uploader,
      imageIntake: { previews: false },
    }), { wrapper: wrapper(runtime) });

    act(() => first.result.current.setDraft("first draft"));
    act(() => second.result.current.setDraft("second draft"));
    const sameMetadata = file("same.png", "image/png", "same");
    act(() => first.result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(sameMetadata) },
    } as never));
    act(() => second.result.current.getFileInputProps().onChange({
      currentTarget: { files: fileList(sameMetadata) },
    } as never));
    await waitFor(() => {
      expect(first.result.current.canSend).toBe(true);
      expect(second.result.current.canSend).toBe(true);
    });
    expect(uploader.getSnapshot().items).toHaveLength(2);

    await act(() => first.result.current.submit());
    expect(first.result.current.draft).toBe("");
    expect(first.result.current.attachments).toEqual([]);
    expect(second.result.current.draft).toBe("second draft");
    expect(second.result.current.attachments).toHaveLength(1);
    expect(uploader.getSnapshot().items).toHaveLength(1);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("preserves the generic request type in the public option contract", () => {
    type Request = { readonly model: string };
    const options = {} as UseConversationComposerOptions<Request>;
    const composer = {} as ConversationComposerResult;
    expect(options).toBeDefined();
    expect(composer).toBeDefined();
  });
});
