import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEventHandler,
} from "react";

export interface SmartTranscriptFollowOptions {
  /** Changes whenever transcript content or streaming state changes. */
  readonly contentVersion: unknown;
  /** Distance from the bottom still considered pinned. Defaults to 48px. */
  readonly thresholdPixels?: number;
}

export interface SmartTranscriptFollowResult {
  readonly transcriptRef: (element: HTMLElement | null) => void;
  readonly onScroll: UIEventHandler<HTMLElement>;
  readonly following: boolean;
  readonly hasNewContent: boolean;
  scrollToLatest(behavior?: ScrollBehavior): void;
}

/** Follow a growing transcript without stealing a reader's scroll position. */
export function useSmartTranscriptFollow(
  options: SmartTranscriptFollowOptions,
): SmartTranscriptFollowResult {
  const threshold = options.thresholdPixels ?? 48;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError("thresholdPixels must be a non-negative finite number");
  }
  const elementRef = useRef<HTMLElement | null>(null);
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const [hasNewContent, setHasNewContent] = useState(false);

  const updateFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing(next);
    if (next) setHasNewContent(false);
  }, []);
  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = elementRef.current;
    if (!element) return;
    updateFollowing(true);
    if (typeof element.scrollTo === "function") element.scrollTo({ top: element.scrollHeight, behavior });
    else element.scrollTop = element.scrollHeight;
  }, [updateFollowing]);
  const transcriptRef = useCallback((element: HTMLElement | null) => {
    elementRef.current = element;
    if (element) updateFollowing(true);
  }, [updateFollowing]);
  const onScroll = useCallback<UIEventHandler<HTMLElement>>((event) => {
    const element = event.currentTarget;
    updateFollowing(element.scrollHeight - element.scrollTop - element.clientHeight <= threshold);
  }, [threshold, updateFollowing]);

  useLayoutEffect(() => {
    if (followingRef.current) scrollToLatest("auto");
    else if (elementRef.current) setHasNewContent(true);
  }, [options.contentVersion, scrollToLatest]);

  useEffect(() => {
    const element = elementRef.current;
    const Observer = globalThis.ResizeObserver;
    if (!element || typeof Observer !== "function") return;
    const observer = new Observer(() => {
      if (followingRef.current) scrollToLatest("auto");
      else setHasNewContent(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollToLatest]);

  return Object.freeze({ transcriptRef, onScroll, following, hasNewContent, scrollToLatest });
}
