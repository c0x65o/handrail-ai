// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StyledChatPreset, StyledChatPresetStyles, installToolRendererPlugins } from "../src/react-styled/index.js";

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
});
