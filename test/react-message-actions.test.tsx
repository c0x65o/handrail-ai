// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CopyMessageButton, Message, conversationMessageText } from "../src/react/index.js";

const message = {
  message_id: "message-1", role: "assistant", created_at: null, attribution: null,
  attachments: [], content: [{ type: "text", text: "Hello" }, { type: "text", text: " world" }],
} as never;

describe("CopyMessageButton", () => {
  it("copies only textual message content and announces success", async () => {
    const writeText = vi.fn(async () => undefined);
    expect(conversationMessageText(message)).toBe("Hello world");
    render(<CopyMessageButton message={message} clipboard={{ writeText }}/>);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hello world"));
    expect(screen.getByRole("status").textContent).toBe("Message copied.");
  });

  it("renders historical message attachments with an optional custom renderer", () => {
    const attached = { ...message, attachments: [{ attachment_id: "attachment-1",
      media_type: "application/pdf", filename: "invoice.pdf" }] } as never;
    const { rerender } = render(<Message message={attached}/>);
    expect(screen.getByRole("list", { name: "Message attachments" }).textContent).toContain("invoice.pdf");
    rerender(<Message message={attached} renderAttachment={(attachment) =>
      <a href={`#${attachment.attachment_id}`}>Open attachment</a>}/>);
    expect(screen.getByRole("link", { name: "Open attachment" }).getAttribute("href"))
      .toBe("#attachment-1");
  });
});
