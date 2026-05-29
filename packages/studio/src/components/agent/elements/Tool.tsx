/**
 * Tool-call display, modeled on AI Elements' <Tool>.
 *
 * Composition:
 *
 *   <Tool state="running" name="write_file">
 *     <ToolHeader />                               (auto-rendered from props)
 *     <ToolContent>
 *       <ToolInput  json={input} />
 *       <ToolOutput error={isError}>{result}</ToolOutput>
 *     </ToolContent>
 *   </Tool>
 *
 * The header is clickable to expand/collapse the input + output sections.
 * Defaults to collapsed unless the call is still running (so the user
 * sees what's happening as it streams).
 */

import { useState, type ReactNode } from "react";

export type ToolState = "pending" | "running" | "done" | "error";

export interface ToolProps {
  name: string;
  /** Drives the dot color + label. */
  state: ToolState;
  /** Optional short summary shown next to the name when collapsed. */
  summary?: string;
  children: ReactNode;
  /** Force open or closed; otherwise we manage internally. */
  defaultOpen?: boolean;
}

export function Tool({ name, state, summary, children, defaultOpen }: ToolProps) {
  // Auto-open while running; auto-collapse once done so the chat stays
  // dense. The user can still toggle explicitly.
  const [open, setOpen] = useState<boolean>(
    defaultOpen ?? (state === "running" || state === "pending"),
  );

  const dotColor =
    state === "running" || state === "pending"
      ? "text-studio-accent"
      : state === "error"
        ? "text-red-400"
        : "text-emerald-400";

  return (
    <div className="text-[11px] rounded-md border border-neutral-800 bg-neutral-900/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 hover:bg-neutral-900 transition-colors text-left"
      >
        <span className={`font-mono ${dotColor}`} aria-hidden="true">
          ●
        </span>
        <span className="font-mono text-neutral-300 flex-shrink-0">{name}</span>
        {summary && (
          <span className="text-neutral-600 font-mono truncate flex-1 min-w-0">
            {summary.length > 80 ? `${summary.slice(0, 80)}…` : summary}
          </span>
        )}
        <Chevron open={open} />
      </button>
      {open && children}
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-neutral-600 flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export interface ToolContentProps {
  children: ReactNode;
}

export function ToolContent({ children }: ToolContentProps) {
  return (
    <div className="border-t border-neutral-800/60 divide-y divide-neutral-800/60">{children}</div>
  );
}

export interface ToolInputProps {
  value: unknown;
}

/** Pretty-prints the tool input as JSON inside a code block. */
export function ToolInput({ value }: ToolInputProps) {
  if (value == null || (typeof value === "object" && Object.keys(value as object).length === 0)) {
    return null;
  }
  const text = typeof value === "string" ? value : safeStringify(value, 2);
  return (
    <div className="px-2.5 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-neutral-600 mb-1">Input</div>
      <pre className="text-[10px] text-neutral-400 font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">
        {text}
      </pre>
    </div>
  );
}

export interface ToolOutputProps {
  children?: ReactNode;
  error?: boolean;
}

/** Tool result body. Collapses if `children` is empty. */
export function ToolOutput({ children, error }: ToolOutputProps) {
  if (children == null || children === "") return null;
  const text = typeof children === "string" ? children : String(children);
  const display = text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text;
  return (
    <div className="px-2.5 py-1.5">
      <div
        className={`text-[9px] uppercase tracking-wide mb-1 ${
          error ? "text-red-400" : "text-neutral-600"
        }`}
      >
        {error ? "Error" : "Output"}
      </div>
      <pre
        className={`text-[10px] font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto ${
          error ? "text-red-300" : "text-neutral-400"
        }`}
      >
        {display}
      </pre>
    </div>
  );
}

function safeStringify(value: unknown, space: number): string {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    return String(value);
  }
}
