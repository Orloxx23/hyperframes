/**
 * Subtle "working" indicator for in-flight requests. Used between
 * tool calls when the model is still reasoning.
 */

import type { ReactNode } from "react";

export interface LoaderProps {
  label?: ReactNode;
}

export function Loader({ label = "Working…" }: LoaderProps) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-neutral-500 px-1">
      <span className="inline-flex h-2 w-2">
        <span className="absolute inline-flex h-2 w-2 rounded-full bg-studio-accent opacity-75 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-studio-accent" />
      </span>
      <span>{label}</span>
    </div>
  );
}
