/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useSmartTranscriptFollow } from "../src/react/index.js";

function Harness(): ReactNode {
  const [version, setVersion] = useState(1);
  const follow = useSmartTranscriptFollow({ contentVersion: version, thresholdPixels: 40 });
  return <>
    <section aria-label="Transcript" ref={follow.transcriptRef} onScroll={follow.onScroll}/>
    <button onClick={() => setVersion((value) => value + 1)}>Append</button>
    {follow.hasNewContent && !follow.following
      ? <button aria-label="Jump to latest message" onClick={() => follow.scrollToLatest()}>New</button>
      : null}
  </>;
}

afterEach(() => vi.restoreAllMocks());

describe("smart transcript following", () => {
  it("follows growth only while pinned and exposes an explicit jump when the reader scrolls up", () => {
    render(<Harness/>);
    const transcript = screen.getByRole("region", { name: "Transcript" });
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, value: 1000 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 800 },
    });
    const scrollTo = vi.fn();
    Object.defineProperty(transcript, "scrollTo", { configurable: true, value: scrollTo });

    fireEvent.scroll(transcript);
    fireEvent.click(screen.getByRole("button", { name: "Append" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "auto" });

    scrollTo.mockClear();
    transcript.scrollTop = 300;
    fireEvent.scroll(transcript);
    fireEvent.click(screen.getByRole("button", { name: "Append" }));
    expect(scrollTo).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeTruthy();

    act(() => screen.getByRole("button", { name: "Jump to latest message" }).click());
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });
});
