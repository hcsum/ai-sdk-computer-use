import { useEffect, useRef, type RefObject } from "react";

/** How close to the bottom still counts as "following the stream". */
const FOLLOW_THRESHOLD_PX = 64;

/**
 * Keeps a scroll container pinned to the bottom as content arrives, but only
 * while the reader is actually at the bottom. Scrolling up is a deliberate act
 * — reading back through a long run — and must not be undone by the next token.
 */
export function useScrollToBottom(): [
  RefObject<HTMLDivElement | null>,
  RefObject<HTMLDivElement | null>,
] {
  const containerRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const isFollowingRef = useRef(true);

  useEffect(() => {
    const container = containerRef.current;
    const end = endRef.current;
    if (!container || !end) return;

    const updateFollowing = () => {
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      isFollowingRef.current = distanceFromBottom <= FOLLOW_THRESHOLD_PX;
    };

    // Content growth only. Attribute mutations are presentation — a selection
    // ring, one of motion's inline transform steps — and scrolling on those
    // means a click on a message yanks the transcript to the bottom.
    const observer = new MutationObserver(() => {
      if (!isFollowingRef.current) return;
      end.scrollIntoView({ behavior: "instant", block: "end" });
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    container.addEventListener("scroll", updateFollowing, { passive: true });

    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", updateFollowing);
    };
  }, []);

  return [containerRef, endRef];
}
