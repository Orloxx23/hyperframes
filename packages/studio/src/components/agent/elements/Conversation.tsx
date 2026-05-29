/**
 * Auto-scrolling conversation container.
 *
 * Mirrors the design of Vercel's AI Elements <Conversation>: track whether
 * the user is "anchored to the bottom" (within a small threshold) and only
 * auto-scroll when they are. If they scroll up to re-read, we stop
 * following the stream and show a floating "↓ Latest" button so they can
 * re-anchor at will.
 *
 * Pure presentational component — children render messages, this only
 * owns scroll behaviour.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface ConversationProps {
  children: ReactNode;
  /**
   * Dependency that signals "new content arrived". Whenever this changes,
   * the component checks if the user was anchored and (if so) scrolls to
   * the bottom. Pass `messages.length` or a similar lightweight token.
   */
  trackedBy: number;
  /** Px from the bottom that still counts as "anchored". */
  anchorThresholdPx?: number;
  className?: string;
}

export function Conversation({
  children,
  trackedBy,
  anchorThresholdPx = 64,
  className = "",
}: ConversationProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [anchored, setAnchored] = useState(true);

  const updateAnchored = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAnchored(distanceFromBottom <= anchorThresholdPx);
  }, [anchorThresholdPx]);

  // Re-anchor on every new content tick, but only if the user is at the
  // bottom right now. Avoids the "yanks you down while reading" trap.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!anchored) return;
    const el = scrollerRef.current;
    if (!el) return;
    // Use requestAnimationFrame so layout settles before we scroll —
    // otherwise scrollHeight may still reflect the pre-render layout.
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [trackedBy, anchored]);

  const jumpToBottom = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setAnchored(true);
  }, []);

  return (
    <div className={`relative flex-1 min-h-0 ${className}`}>
      <div
        ref={scrollerRef}
        onScroll={updateAnchored}
        className="absolute inset-0 overflow-y-auto px-3 py-3 space-y-3"
      >
        {children}
      </div>

      {!anchored && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 h-7 px-3 rounded-full text-[11px] font-medium bg-neutral-900 text-neutral-200 border border-neutral-700 shadow-lg hover:bg-neutral-800 flex items-center gap-1.5"
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
          Latest
        </button>
      )}
    </div>
  );
}
