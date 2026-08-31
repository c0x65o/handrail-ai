import { useEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import type { ConversationMessageRecord } from "../conversation/state.js";

export interface MessageClipboard { writeText(text: string): Promise<void>; }
export type MessageCopyStatus = "idle" | "copied" | "error";

export function conversationMessageText(message: ConversationMessageRecord): string {
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

export interface CopyMessageButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onError"> {
  readonly message: ConversationMessageRecord;
  readonly clipboard?: MessageClipboard;
  readonly copiedLabel?: string;
  readonly errorLabel?: string;
  readonly resetAfterMs?: number;
  readonly onStatusChange?: (status: MessageCopyStatus) => void;
}

/** Reusable accessible copy action with bounded, non-content feedback. */
export function CopyMessageButton({ message, clipboard = globalThis.navigator?.clipboard,
  copiedLabel = "Message copied.", errorLabel = "Message could not be copied.",
  resetAfterMs = 2_000, onStatusChange, children = "Copy", type = "button", ...props
}: CopyMessageButtonProps) {
  const [status, setStatus] = useState<MessageCopyStatus>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  const publish = (next: MessageCopyStatus) => {
    setStatus(next); onStatusChange?.(next);
    if (timer.current !== null) clearTimeout(timer.current);
    if (next !== "idle") timer.current = setTimeout(() => publish("idle"), resetAfterMs);
  };
  const copy = async () => {
    try {
      const text = conversationMessageText(message);
      if (!clipboard || text.length === 0) throw new TypeError("Clipboard is unavailable");
      await clipboard.writeText(text); publish("copied");
    } catch { publish("error"); }
  };
  return <><button {...props} type={type} onClick={(event) => {
    props.onClick?.(event); if (!event.defaultPrevented) void copy();
  }}>{children}</button><span role="status" aria-live="polite" className="hr-message-action-status">
    {status === "copied" ? copiedLabel : status === "error" ? errorLabel : ""}
  </span></>;
}
