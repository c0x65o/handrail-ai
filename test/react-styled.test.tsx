// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StyledChatLauncher, StyledChatPreset, StyledChatPresetStyles, installToolRendererPlugins } from "../src/react-styled/index.js";

describe("styled React preset", () => {
  it("installs renderer plugins by stable keys without exposing server executors", () => {
    const renderer = () => <span>Invoice</span>;
    expect(installToolRendererPlugins([{
      pluginId: "spartan.erp", version: "1.0.0",
      renderers: { "spartan.invoice.result": renderer },
      toolRendererKeys: { "spartan.invoice.lookup": "spartan.invoice.result" },
    }])).toEqual({
      renderers: { "spartan.invoice.result": renderer },
      toolRendererKeys: { "spartan.invoice.lookup": "spartan.invoice.result" },
    });
  });
  it("renders an accessible responsive chat surface without changing headless primitives", () => {
    const { container } = render(<><StyledChatPresetStyles/><StyledChatPreset title="Aegis" layout="drawer" conversationPicker={<button>Threads</button>} approvals={<section>Approval required</section>} citations={<aside>Sources</aside>}/></>);
    expect(screen.getByRole("heading", { name: "Aegis" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Conversation transcript" })).toBeTruthy();
    expect(screen.getByRole("textbox").getAttribute("placeholder")).toBe("Message…");
    expect(screen.getByLabelText("Attach files")).toBeTruthy();
    expect(screen.getByText("Approval required")).toBeTruthy();
    expect(container.querySelector("[data-layout=drawer]")).toBeTruthy();
    expect(container.querySelector("style[data-handrail-ai-preset]")?.textContent).toContain("prefers-reduced-motion");
  });
  it("binds completion and unread workspace state to the launcher button", () => {
    const snapshot = { selectedConversationId: "second", runningCount: 0, errorCount: 0,
      unreadCount: 1, threads: [] } as never;
    const { container } = render(<StyledChatLauncher title="Aegis" workspace={{ getSnapshot: () => snapshot,
      subscribe: () => () => undefined }}/>);
    const trigger = container.querySelector<HTMLButtonElement>(".hr-chat__launcher-trigger")!;
    expect(trigger.dataset.turnStatus).toBe("completed");
    expect(trigger.dataset.unreadCount).toBe("1");
    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "Aegis" })).toBeTruthy();
  });
});
