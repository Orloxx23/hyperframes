/**
 * Composer for the chat. Mirrors AI Elements' <PromptInput>:
 *   - auto-resizing textarea
 *   - Enter to submit, Shift+Enter for newline
 *   - submit / stop button swaps based on the streaming state
 *   - footnote slot for keyboard-hint text
 */

import { useEffect, useRef, type ReactNode } from "react";

export interface PromptInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void | Promise<void>;
  onStop?: () => void;
  streaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  footnote?: ReactNode;
  /** Rendered above the textarea row — used for attachment chips, picker hints, etc. */
  attachment?: ReactNode;
  /** Rendered as a leading icon-button row above the textarea (e.g. element picker). */
  leadingActions?: ReactNode;
}

const MAX_TEXTAREA_HEIGHT = 160;

export function PromptInput({
  value,
  onChange,
  onSubmit,
  onStop,
  streaming,
  disabled,
  placeholder,
  footnote,
  attachment,
  leadingActions,
}: PromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-resize: snap height to scrollHeight up to a cap, then scroll.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  const submit = async () => {
    if (disabled || streaming) return;
    if (!value.trim()) return;
    await onSubmit();
  };

  const canSend = !disabled && !streaming && value.trim().length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      {attachment}
      {leadingActions && <div className="flex items-center gap-1">{leadingActions}</div>}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          rows={2}
          disabled={disabled}
          className="flex-1 resize-none bg-neutral-900 border border-neutral-800 rounded-md px-2.5 py-2 text-[12px] text-neutral-100 placeholder-neutral-600 focus:border-studio-accent focus:outline-none disabled:opacity-60 leading-relaxed"
          style={{ maxHeight: MAX_TEXTAREA_HEIGHT }}
        />
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="h-9 px-3 rounded-md text-[11px] font-medium bg-red-900/40 text-red-200 border border-red-800/50 hover:bg-red-900/60"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            className="h-9 px-3 rounded-md text-[11px] font-medium bg-studio-accent text-neutral-950 hover:bg-studio-accent/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            <SendIcon />
            Send
          </button>
        )}
      </div>
      {footnote && <p className="text-[10px] text-neutral-600 px-0.5">{footnote}</p>}
    </div>
  );
}

function SendIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  );
}
