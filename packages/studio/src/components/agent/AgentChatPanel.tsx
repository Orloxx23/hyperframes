import { useEffect, useRef, useState } from "react";
import {
  useAgentChat,
  type AssistantBlock,
  type AuthMode,
  type AuthStatus,
  type ChatMessage,
} from "../../hooks/useAgentChat";
import {
  Conversation,
  Loader,
  Message,
  MessageContent,
  PromptInput,
  Reasoning,
  Tool,
  ToolContent,
  ToolInput,
  ToolOutput,
  type ToolState,
} from "./elements";
import { useDomEditContext } from "../../contexts/DomEditContext";
import { useStudioContext } from "../../contexts/StudioContext";
import { buildElementAgentPrompt, type DomEditSelection } from "../editor/domEditing";
import { readTagSnippetByTarget } from "../../utils/sourcePatcher";
import { SettingsModal } from "./SettingsModal";
import { CloseIcon, GearIcon, SparkleIcon } from "./icons";

export interface AgentChatPanelProps {
  projectId: string;
  activeCompPath: string | null;
  onClose: () => void;
}

export function AgentChatPanel({ projectId, activeCompPath, onClose }: AgentChatPanelProps) {
  const chat = useAgentChat({ projectId, activeCompPath });
  const [input, setInput] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  const { domEditSelection } = useDomEditContext();
  const { currentTime } = useStudioContext();

  const [pickerActive, setPickerActive] = useState(false);
  const [attachedSelection, setAttachedSelection] = useState<DomEditSelection | null>(null);
  const [attachedSnippet, setAttachedSnippet] = useState<string | undefined>();
  const pickerBaselineRef = useRef<HTMLElement | null>(null);

  const claudeReady = chat.authStatus?.claudeCode.ready ?? false;
  const apiKeyConfigured = chat.authStatus?.apiKey.configured ?? false;
  const anyConfigured = claudeReady || apiKeyConfigured;

  // Auto-open settings the first time the chat has no auth set up. After
  // that it's manual — the user might be intentionally disconnected.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (chat.authStatus && !anyConfigured) setShowSettings(true);
  }, [chat.authStatus, anyConfigured]);

  // While picker mode is on, any new canvas selection (against the baseline
  // captured at activation) is treated as the user's pick. We use the
  // existing DomEdit selection plumbing instead of layering a second
  // hit-test on the iframe.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!pickerActive) return;
    if (!domEditSelection) return;
    if (domEditSelection.element === pickerBaselineRef.current) return;
    const picked = domEditSelection;
    setAttachedSelection(picked);
    setAttachedSnippet(undefined);
    setPickerActive(false);

    const targetPath = picked.sourceFile || activeCompPath || "index.html";
    void (async () => {
      try {
        const res = await fetch(
          `/api/projects/${projectId}/files/${encodeURIComponent(targetPath)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as { content?: string };
        const html = data.content;
        const snippet = typeof html === "string" ? readTagSnippetByTarget(html, picked) : undefined;
        setAttachedSnippet(snippet);
      } catch {
        // Runtime outerHTML is used as fallback when we build the prompt.
      }
    })();
  }, [pickerActive, domEditSelection, projectId, activeCompPath]);

  // Escape cancels an in-flight pick.
  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (!pickerActive) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerActive(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [pickerActive]);

  const togglePicker = () => {
    if (pickerActive) {
      setPickerActive(false);
      return;
    }
    pickerBaselineRef.current = domEditSelection?.element ?? null;
    setPickerActive(true);
  };

  const clearAttachment = () => {
    setAttachedSelection(null);
    setAttachedSnippet(undefined);
  };

  const handleSubmit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");

    if (!attachedSelection) {
      await chat.send(text);
      return;
    }

    const tagSnippet = attachedSnippet ?? attachedSelection.element.outerHTML;
    const wrapped = buildElementAgentPrompt({
      selection: attachedSelection,
      currentTime,
      tagSnippet,
      userInstruction: text,
    });
    const attachmentLabel = describeSelection(attachedSelection);
    clearAttachment();
    await chat.send(text, {
      messageForServer: wrapped,
      attachment: { kind: "element", label: attachmentLabel },
    });
  };

  // Conversation tracks scroll position itself; we just give it a tick
  // that changes every time the chat surface mutates so it can decide
  // whether to follow the bottom.
  const conversationTick =
    chat.messages.length +
    chat.messages.reduce((acc, m) => acc + (m.role === "assistant" ? m.blocks.length : 0), 0);

  // Show a Loader between the last assistant block and the composer when
  // the model is mid-flight but hasn't streamed any visible content yet
  // (typically the gap between tool_result and the next text_delta).
  const lastMsg = chat.messages[chat.messages.length - 1];
  const lastBlock =
    lastMsg && lastMsg.role === "assistant" ? lastMsg.blocks[lastMsg.blocks.length - 1] : null;
  const showStandaloneLoader =
    chat.streaming &&
    (!lastBlock ||
      (lastBlock.type === "tool" && lastBlock.result != null) ||
      (lastBlock.type === "thinking" && !lastBlock.streaming));

  return (
    <aside className="flex flex-col h-full w-[380px] bg-neutral-950 border-l border-neutral-800 flex-shrink-0">
      <header className="h-10 px-3 flex items-center justify-between border-b border-neutral-800 flex-shrink-0">
        <div className="flex items-center gap-2">
          <SparkleIcon />
          <span className="text-[11px] font-medium text-neutral-200">AI editor</span>
          {chat.streaming && <span className="text-[10px] text-studio-accent">working…</span>}
        </div>
        <div className="flex items-center gap-1">
          <ActiveSourceBadge status={chat.authStatus} authMode={chat.authMode} />
          <button
            type="button"
            onClick={() => void chat.clearConversation()}
            disabled={chat.messages.length === 0 || chat.streaming}
            className="h-6 px-2 text-[10px] rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900 disabled:opacity-40"
            title="Clear conversation"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setShowSettings(true)}
            className="h-6 w-6 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900"
            title="Settings"
            aria-label="Settings"
          >
            <GearIcon />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="h-6 w-6 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900"
            title="Close"
            aria-label="Close chat"
          >
            <CloseIcon />
          </button>
        </div>
      </header>

      <Conversation trackedBy={conversationTick}>
        {chat.messages.length === 0 && !chat.streaming && (
          <EmptyState configured={anyConfigured} onConfigure={() => setShowSettings(true)} />
        )}
        {chat.messages.map((m) => (
          <MessageRow key={m.id} message={m} />
        ))}
        {showStandaloneLoader && <Loader />}
        {chat.error && (
          <div className="text-[11px] text-red-400 px-2 py-1.5 rounded bg-red-950/30 border border-red-900/50">
            {chat.error}
          </div>
        )}
      </Conversation>

      <footer className="border-t border-neutral-800 p-3 flex-shrink-0">
        <PromptInput
          value={input}
          onChange={setInput}
          onSubmit={handleSubmit}
          onStop={chat.abort}
          streaming={chat.streaming}
          disabled={!anyConfigured}
          placeholder={
            anyConfigured ? "Tell the agent what to edit…" : "Connect Claude to start editing"
          }
          footnote={
            pickerActive
              ? "Click any element in the preview to attach it Â· Esc to cancel"
              : "Enter to send Â· Shift+Enter for newline Â· Claude Opus 4.7"
          }
          attachment={
            attachedSelection ? (
              <AttachedElementChip
                label={describeSelection(attachedSelection)}
                onClear={clearAttachment}
              />
            ) : pickerActive ? (
              <PickerHintChip onCancel={() => setPickerActive(false)} />
            ) : null
          }
          leadingActions={
            <PickerButton
              active={pickerActive}
              hasAttachment={attachedSelection != null}
              onClick={togglePicker}
            />
          }
        />
      </footer>

      {showSettings && (
        <SettingsModal
          status={chat.authStatus}
          authMode={chat.authMode}
          setAuthMode={chat.setAuthMode}
          onRefresh={chat.refreshAuthStatus}
          onSaveKey={chat.saveAnthropicKey}
          onClearKey={chat.clearAnthropicKey}
          onSaveStockKey={chat.saveStockKey}
          onClearStockKey={chat.clearStockKey}
          listSkills={chat.listSkills}
          setSkillEnabled={chat.setSkillEnabled}
          createSkill={chat.createSkill}
          fetchCatalog={chat.fetchCatalog}
          installSkill={chat.installSkill}
          onClose={() => setShowSettings(false)}
        />
      )}
    </aside>
  );
}

function EmptyState({ configured, onConfigure }: { configured: boolean; onConfigure: () => void }) {
  if (!configured) {
    return (
      <div className="px-2 py-6 text-center">
        <p className="text-[12px] text-neutral-300 font-medium mb-1">
          Connect your AI subscription or key
        </p>
        <p className="text-[11px] text-neutral-500 mb-4">
          Use your Claude Code subscription, or paste an Anthropic API key. Your credentials stay on
          this machine.
        </p>
        <button
          type="button"
          onClick={onConfigure}
          className="h-8 px-3 rounded-md text-[11px] font-medium bg-studio-accent text-neutral-950 hover:bg-studio-accent/90"
        >
          Connect
        </button>
      </div>
    );
  }
  return (
    <div className="px-2 py-6 text-center">
      <p className="text-[12px] text-neutral-300 font-medium mb-1">Ready</p>
      <p className="text-[11px] text-neutral-500">
        Describe what you want to change. The agent reads, edits, and lints the project directly.
      </p>
      <div className="mt-4 grid gap-1.5 text-left">
        {[
          "Add a fade-in title that says 'Hello' in the first 2 seconds",
          "Change the background color to a warm gradient",
          "Run lint and fix anything broken",
        ].map((s) => (
          <button
            key={s}
            type="button"
            className="text-[11px] text-neutral-400 hover:text-neutral-200 px-2.5 py-1.5 rounded-md border border-neutral-800 hover:border-neutral-700 hover:bg-neutral-900 text-left"
            onClick={(e) => {
              const input = e.currentTarget
                .closest("aside")
                ?.querySelector("textarea") as HTMLTextAreaElement | null;
              if (input) {
                input.value = s;
                input.focus();
                input.dispatchEvent(new Event("input", { bubbles: true }));
              }
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function ActiveSourceBadge({
  status,
  authMode,
}: {
  status: AuthStatus | null;
  authMode: AuthMode;
}) {
  if (!status) return null;
  const claudeReady = status.claudeCode.ready;
  const apiKey = status.apiKey.configured;
  let label: string;
  let tone: "connected" | "off";
  if (authMode === "claude-code" || (authMode === "auto" && claudeReady)) {
    label = "Claude Code";
    tone = claudeReady ? "connected" : "off";
  } else if (authMode === "api-key" || (authMode === "auto" && apiKey)) {
    label = "API key";
    tone = apiKey ? "connected" : "off";
  } else {
    label = "Disconnected";
    tone = "off";
  }
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
        tone === "connected"
          ? "bg-emerald-950/40 text-emerald-300 border border-emerald-900/50"
          : "bg-amber-950/30 text-amber-300 border border-amber-900/40"
      }`}
      title={`auth: ${authMode}`}
    >
      {label}
    </span>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <Message role="user">
        {message.attachment && (
          <div className="mb-1.5 -mx-0.5 flex items-center gap-1 text-[10px] text-studio-accent">
            <TargetIcon />
            <span className="truncate">{message.attachment.label}</span>
          </div>
        )}
        {message.text}
      </Message>
    );
  }
  return (
    <Message role="assistant">
      {message.blocks.map((b, i) => (
        <AssistantBlockView key={`${message.id}-${i}`} block={b} />
      ))}
    </Message>
  );
}

function describeSelection(selection: DomEditSelection): string {
  const tag = `<${selection.tagName.toLowerCase()}>`;
  const label = selection.label?.trim();
  if (label && label.toLowerCase() !== selection.tagName.toLowerCase()) {
    return `${tag} ${label}`;
  }
  if (selection.id) return `${tag} #${selection.id}`;
  return tag;
}

function PickerButton({
  active,
  hasAttachment,
  onClick,
}: {
  active: boolean;
  hasAttachment: boolean;
  onClick: () => void;
}) {
  const title = active
    ? "Cancel element pick (Esc)"
    : hasAttachment
      ? "Replace attached element"
      : "Attach an element from the canvas";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`h-6 px-1.5 inline-flex items-center gap-1 rounded text-[10px] font-medium border transition-colors ${
        active
          ? "bg-studio-accent/20 text-studio-accent border-studio-accent/50"
          : "bg-neutral-900 text-neutral-400 border-neutral-800 hover:text-neutral-200 hover:border-neutral-700"
      }`}
    >
      <TargetIcon />
      <span>{active ? "Picking…" : "Element"}</span>
    </button>
  );
}

function AttachedElementChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-studio-accent/10 border border-studio-accent/30 text-[11px] text-studio-accent self-start max-w-full">
      <TargetIcon />
      <span className="truncate flex-1 min-w-0" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={onClear}
        title="Remove attachment"
        aria-label="Remove attached element"
        className="text-studio-accent/70 hover:text-studio-accent"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function PickerHintChip({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-neutral-900 border border-neutral-700 text-[11px] text-neutral-400 self-start animate-pulse">
      <TargetIcon />
      <span className="flex-1">Click an element in the preview…</span>
      <button
        type="button"
        onClick={onCancel}
        title="Cancel"
        aria-label="Cancel element picker"
        className="text-neutral-500 hover:text-neutral-200"
      >
        <CloseIcon />
      </button>
    </div>
  );
}

function TargetIcon() {
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
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </svg>
  );
}

function AssistantBlockView({ block }: { block: AssistantBlock }) {
  if (block.type === "text") {
    return <MessageContent>{block.text}</MessageContent>;
  }
  if (block.type === "thinking") {
    return <Reasoning streaming={block.streaming}>{block.text}</Reasoning>;
  }
  // Tool block — derive UI state from `result` / `isError`.
  const state: ToolState = block.result == null ? "running" : block.isError ? "error" : "done";
  // Trim MCP tool prefix for readability: mcp__hf__write_file â†’ write_file
  const displayName = block.name.replace(/^mcp__[^_]+__/, "");
  const summary =
    block.input != null
      ? safeJson(block.input)
      : block.partialInput
        ? block.partialInput
        : undefined;
  const inputValue = block.input ?? (block.partialInput ? block.partialInput : null);
  return (
    <Tool name={displayName} state={state} summary={summary}>
      <ToolContent>
        <ToolInput value={inputValue} />
        {block.result != null && <ToolOutput error={block.isError}>{block.result}</ToolOutput>}
      </ToolContent>
    </Tool>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
