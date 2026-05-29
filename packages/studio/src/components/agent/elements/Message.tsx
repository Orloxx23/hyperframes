/**
 * Role-aware message bubble.
 *
 * Like AI Elements' <Message>: user messages float right, assistant
 * messages span the full column. We omit the avatar prop for now since
 * the editor has a single user identity — easy to add later.
 */

import type { ReactNode } from "react";

export interface MessageProps {
  role: "user" | "assistant" | "system";
  children: ReactNode;
}

export function Message({ role, children }: MessageProps) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3 py-2 rounded-lg bg-studio-accent/15 border border-studio-accent/30 text-[12px] text-neutral-100 whitespace-pre-wrap leading-relaxed">
          {children}
        </div>
      </div>
    );
  }
  if (role === "system") {
    return (
      <div className="text-[11px] text-neutral-500 italic px-2 leading-relaxed">{children}</div>
    );
  }
  // assistant
  return <div className="flex flex-col gap-1.5">{children}</div>;
}

export interface MessageContentProps {
  children: ReactNode;
}

/** Plain text body inside an assistant Message. Preserves whitespace. */
export function MessageContent({ children }: MessageContentProps) {
  return (
    <div className="text-[12px] text-neutral-200 whitespace-pre-wrap leading-relaxed">
      {children}
    </div>
  );
}
