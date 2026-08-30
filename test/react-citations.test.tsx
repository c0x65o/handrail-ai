/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createConversationStore,
  createInitialConversationState,
  type Citation,
  type CitationSource,
  type ConversationId,
  type ConversationState,
} from "../src/index.js";
import {
  ChatRoot,
  CitationItem,
  CitationList,
  ConversationProvider,
} from "../src/react/index.js";

afterEach(() => cleanup());

const sources = [
  {
    source_id: "source_web",
    type: "web",
    label: "Public guide",
    locator: "https://example.com/guide",
  },
  {
    source_id: "source_document",
    type: "document",
    label: "Benefits handbook",
    locator: "document:benefits-2026",
  },
  {
    source_id: "source_tool",
    type: "tool",
    label: "Eligibility lookup",
    locator: "tool:eligibility-result",
  },
] as unknown as readonly CitationSource[];

const citations = [
  {
    citation_id: "citation_document",
    source_id: "source_document",
    order: 2,
    target: { type: "assistant_message", message_id: "message_answer" },
  },
  {
    citation_id: "citation_web",
    source_id: "source_web",
    order: 0,
    target: { type: "assistant_message", message_id: "message_answer" },
  },
  {
    citation_id: "citation_web",
    source_id: "source_web",
    order: 0,
    target: { type: "assistant_message", message_id: "message_answer" },
  },
  {
    citation_id: "citation_tool",
    source_id: "source_tool",
    order: 0,
    target: { type: "tool_result", tool_call_id: "tool_call_1" },
  },
] as unknown as readonly Citation[];

function citationState(): ConversationState {
  return {
    ...createInitialConversationState("conversation_citations" as ConversationId),
    citation_sources: sources,
    citations,
  };
}

describe("citation primitives", () => {
  it("selects assistant citations from ChatRoot in deterministic deduplicated order", () => {
    render(
      <ChatRoot state={citationState()}>
        <CitationList messageId="message_answer" aria-label="Answer sources" />
      </ChatRoot>,
    );

    const list = screen.getByRole("list", { name: "Answer sources" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.getAttribute("data-citation-id"))).toEqual([
      "citation_web",
      "citation_document",
    ]);
    expect(items[0]?.textContent).toContain("Public guide");
    expect(items[0]?.textContent).toContain("web");
    expect(items[1]?.textContent).toContain("Benefits handbook");
    expect(items[1]?.textContent).toContain("document");
  });

  it("selects tool-result citations from ConversationProvider state", () => {
    const state = citationState();
    const store = createConversationStore(state.conversation_id, state);
    const view = render(
      <ConversationProvider store={store}>
        <CitationList
          toolCallId="tool_call_1"
          renderLocator={(locator, source) => (
            <button type="button">Handle {source.type} locator {locator}</button>
          )}
        />
      </ConversationProvider>,
    );

    expect(screen.getByRole("listitem", {
      name: "Eligibility lookup, tool source",
    }).getAttribute("data-source-type")).toBe("tool");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", {
      name: "Handle tool locator tool:eligibility-result",
    })).toBeTruthy();
    view.unmount();
    store.destroy();
  });

  it("renders only checked public web locators as native keyboard-accessible links", () => {
    const unsafeSources = [
      ...sources,
      {
        source_id: "source_unsafe",
        type: "web",
        label: "Unsafe source",
        locator: "javascript:alert(1)",
      },
      {
        source_id: "source_missing",
        type: "web",
        label: "Missing locator",
      },
    ] as unknown as readonly CitationSource[];
    const unsafeCitations = [
      citations[1],
      {
        citation_id: "citation_unsafe",
        source_id: "source_unsafe",
        order: 1,
        target: { type: "assistant_message", message_id: "message_answer" },
      },
      {
        citation_id: "citation_missing",
        source_id: "source_missing",
        order: 2,
        target: { type: "assistant_message", message_id: "message_answer" },
      },
    ] as readonly Citation[];

    render(<CitationList citations={unsafeCitations} sources={unsafeSources} />);
    const link = screen.getByRole("link", { name: "Open citation: Public guide" });
    expect(link.getAttribute("href")).toBe("https://example.com/guide");
    expect(link.tabIndex).toBe(0);
    expect(screen.getByRole("listitem", {
      name: "Unsafe source, web source",
    }).querySelector("a")).toBeNull();
    expect(screen.getByRole("listitem", {
      name: "Missing locator, web source",
    }).querySelector("a")).toBeNull();
  });

  it("forwards refs and native props through list and item render overrides", () => {
    const listRef = createRef<HTMLUListElement>();
    const itemRef = createRef<HTMLLIElement>();
    const listClick = vi.fn();
    const itemClick = vi.fn();
    render(
      <CitationList
        ref={listRef}
        citations={[citations[1] as Citation]}
        sources={sources}
        data-host="list"
        onClick={listClick}
        render={(props, ref) => <ul {...props} ref={ref} data-rendered="list" />}
        renderCitation={(citation, source) => (
          <CitationItem
            ref={itemRef}
            citation={citation}
            source={source}
            data-host="item"
            onClick={itemClick}
            render={(props, ref) => <li {...props} ref={ref} data-rendered="item" />}
          />
        )}
      />,
    );

    const list = screen.getByRole("list", { name: "Citations" });
    const item = screen.getByRole("listitem", { name: "Public guide, web source" });
    fireEvent.click(item);
    expect(list.getAttribute("data-host")).toBe("list");
    expect(list.getAttribute("data-rendered")).toBe("list");
    expect(item.getAttribute("data-host")).toBe("item");
    expect(item.getAttribute("data-rendered")).toBe("item");
    expect(listRef.current).toBe(list);
    expect(itemRef.current).toBe(item);
    expect(itemClick).toHaveBeenCalledOnce();
    expect(listClick).toHaveBeenCalledOnce();
  });

  it("honors a prevented native link event before internal activation behavior", () => {
    const nativeClick = vi.fn((event: { preventDefault(): void }) => event.preventDefault());
    const activate = vi.fn();
    render(
      <CitationItem
        citation={citations[1] as Citation}
        source={sources[0] as CitationSource}
        linkProps={{ onClick: nativeClick }}
        onLocatorActivate={activate}
      />,
    );

    fireEvent.click(screen.getByRole("link", { name: "Open citation: Public guide" }));
    expect(nativeClick).toHaveBeenCalledOnce();
    expect(activate).not.toHaveBeenCalled();
  });

  it("is silent when empty and server-renders semantic unstyled markup", () => {
    const empty = render(<CitationList citations={[]} sources={[]} />);
    expect(empty.container.innerHTML).toBe("");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    empty.unmount();

    const markup = renderToString(
      <CitationList
        citations={[citations[1] as Citation, citations[0] as Citation]}
        sources={sources}
        messageId="message_answer"
      />,
    );
    expect(markup).toContain("<ul aria-label=\"Citations\"");
    expect(markup).toContain("<li aria-label=\"Public guide, web source\"");
    expect(markup).toContain("href=\"https://example.com/guide\"");
    expect(markup).toContain("Benefits handbook");
    expect(markup).not.toMatch(/<style|class=|aria-live|role="(?:alert|status)"/u);
  });
});
