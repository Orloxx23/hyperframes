/**
 * Collapsible "Thinking" block.
 *
 * Mirrors AI Elements' <Reasoning>: the assistant's adaptive-thinking
 * summary lives behind a disclosure so it doesn't drown the main text.
 * Auto-opens while streaming; collapses once the assistant's text starts
 * to keep the chat dense.
 */

import { useState, type ReactNode } from "react";

export interface ReasoningProps {
  /** Open while the assistant is still streaming thinking content. */
  streaming?: boolean;
  children: ReactNode;
}

export function Reasoning({ streaming, children }: ReasoningProps) {
  const [openManual, setOpenManual] = useState<boolean | null>(null);
  const open = openManual ?? Boolean(streaming);

  return (
    <div className="text-[11px] rounded-md border border-neutral-800/60 bg-neutral-900/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpenManual(!open)}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-neutral-900 transition-colors text-left"
      >
        <ThinkingIcon spinning={Boolean(streaming)} />
        <span className="text-neutral-400 font-medium">
          {streaming ? "Thinking…" : "Thought process"}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-neutral-600 ml-auto transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="px-2.5 py-1.5 border-t border-neutral-800/60 text-[10px] text-neutral-500 whitespace-pre-wrap leading-relaxed max-h-48 overflow-auto font-mono">
          {children}
        </div>
      )}
    </div>
  );
}

function ThinkingIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-neutral-500 flex-shrink-0 ${spinning ? "animate-pulse" : ""}`}
      aria-hidden="true"
    >
      <path d="M9.663 17h4.673M12 3v1M3 12h1M20 12h1M5.6 5.6l.7.7M18.4 5.6l-.7.7" />
      <path d="M9 17a6 6 0 1 1 6 0v2H9v-2z" />
    </svg>
  );
}
