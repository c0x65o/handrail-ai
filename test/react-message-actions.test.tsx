// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CopyMessageButton, conversationMessageText } from "../src/react/index.js";

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
});
