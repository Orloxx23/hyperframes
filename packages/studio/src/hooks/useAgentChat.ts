/**
 * Drives the in-Studio AI chat against the local server.
 *
 * Two auth paths are exposed:
 *   - "claude-code": uses the user's Claude Code subscription (the SDK
 *     reads its own credentials). Detected via `authStatus.claudeCode.ready`.
 *   - "api-key": uses an Anthropic API key the user pasted in settings.
 *
 * The user picks via the settings modal; preference persists to
 * localStorage. "auto" lets the server decide (subscription if ready, else
 * api-key).
 *
 * The server tracks per-project sessionIds for `resume:` continuity, so we
 * don't ship message history from the client — only the new message.
 */

import { useCallback, useRef, useState } from "react";
import { useMountEffect } from "./useMountEffect";
import { useSkillsApi } from "./useSkillsApi";

export type { CatalogEntry, InstalledSkill, SkillScope } from "./useSkillsApi";

export interface ChatTextBlock {
  type: "text";
  text: string;
}

export interface ChatToolBlock {
  type: "tool";
  id: string;
  name: string;
  partialInput: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
}

export interface ChatThinkingBlock {
  type: "thinking";
  text: string;
  /** False once any non-thinking event arrives — used to stop the spinner. */
  streaming: boolean;
}

export type AssistantBlock = ChatTextBlock | ChatToolBlock | ChatThinkingBlock;

export interface ChatUserAttachment {
  kind: "element";
  label: string;
}

export type ChatMessage =
  | { id: string; role: "user"; text: string; attachment?: ChatUserAttachment }
  | { id: string; role: "assistant"; blocks: AssistantBlock[] };

export type AuthMode = "auto" | "claude-code" | "api-key";

export type StockProvider = "pexels" | "unsplash" | "pixabay";

export interface ProviderStatus {
  configured: boolean;
  source: "env" | "file" | "none";
  addedAt?: string;
}

export interface AuthStatus {
  preferredSource: "claude-code" | "api-key" | "none";
  claudeCode: {
    cliInstalled: boolean;
    credentialsLikelyPresent: boolean;
    ready: boolean;
    configDir: string;
    cliPath?: string;
  };
  apiKey: ProviderStatus;
  stockMedia?: {
    pexels: ProviderStatus;
    unsplash: ProviderStatus;
    pixabay: ProviderStatus;
  };
}

const AUTH_MODE_LS_KEY = "hf-studio:agent-auth-mode";

function readStoredAuthMode(): AuthMode {
  try {
    const raw = localStorage.getItem(AUTH_MODE_LS_KEY);
    if (raw === "claude-code" || raw === "api-key" || raw === "auto") return raw;
  } catch {
    /* ignore */
  }
  return "auto";
}

function writeStoredAuthMode(mode: AuthMode): void {
  try {
    localStorage.setItem(AUTH_MODE_LS_KEY, mode);
  } catch {
    /* ignore */
  }
}

let _idSeq = 0;
function nextId(): string {
  return `m-${Date.now()}-${++_idSeq}`;
}

interface UseAgentChatOptions {
  projectId: string;
  activeCompPath: string | null;
}

export function useAgentChat({ projectId, activeCompPath }: UseAgentChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authMode, setAuthModeState] = useState<AuthMode>(() => readStoredAuthMode());
  const abortRef = useRef<AbortController | null>(null);

  const refreshAuthStatus = useCallback(async (): Promise<AuthStatus | null> => {
    try {
      const res = await fetch("/api/credentials");
      const data = (await res.json()) as AuthStatus;
      setAuthStatus(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  useMountEffect(() => {
    void refreshAuthStatus();
  });

  const setAuthMode = useCallback((mode: AuthMode) => {
    writeStoredAuthMode(mode);
    setAuthModeState(mode);
  }, []);

  const saveAnthropicKey = useCallback(
    async (apiKey: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const result = await putCredentialKey("/api/credentials/anthropic", apiKey);
      if (result.ok) setAuthStatus(result.status);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    [],
  );

  const clearAnthropicKey = useCallback(async () => {
    await fetch("/api/credentials/anthropic", { method: "DELETE" });
    await refreshAuthStatus();
  }, [refreshAuthStatus]);

  const saveStockKey = useCallback(
    async (
      provider: StockProvider,
      apiKey: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const result = await putCredentialKey(`/api/credentials/stock/${provider}`, apiKey);
      if (result.ok) setAuthStatus(result.status);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    },
    [],
  );

  const clearStockKey = useCallback(
    async (provider: StockProvider) => {
      await fetch(`/api/credentials/stock/${provider}`, { method: "DELETE" });
      await refreshAuthStatus();
    },
    [refreshAuthStatus],
  );

  // Skills API lives in its own hook to keep this file under the LOC budget.
  const skillsApi = useSkillsApi(projectId);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const clearConversation = useCallback(async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setError(null);
    // Reset the server-side resume pointer so the next turn starts a new
    // Claude Code session instead of continuing the prior one.
    try {
      await fetch(`/api/projects/${projectId}/agent/conversation`, { method: "DELETE" });
    } catch {
      /* server-side state is in-memory; if the request fails we'll just
         reuse the old sessionId on the next turn — not catastrophic */
    }
  }, [projectId]);

  function updateLastAssistant(
    setMsgs: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
    mutator: (blocks: AssistantBlock[]) => AssistantBlock[],
  ): void {
    setMsgs((current) => {
      const next = current.slice();
      for (let i = next.length - 1; i >= 0; i--) {
        const m = next[i];
        if (m.role === "assistant") {
          next[i] = { ...m, blocks: mutator(m.blocks) };
          return next;
        }
      }
      return current;
    });
  }

  const send = useCallback(
    async (
      text: string,
      options?: { messageForServer?: string; attachment?: ChatUserAttachment },
    ) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      const serverMessage = options?.messageForServer?.trim() || trimmed;

      setError(null);
      const userId = nextId();
      const assistantId = nextId();
      setMessages((m) => [
        ...m,
        {
          id: userId,
          role: "user",
          text: trimmed,
          ...(options?.attachment ? { attachment: options.attachment } : {}),
        },
        { id: assistantId, role: "assistant", blocks: [] },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

      try {
        const res = await fetch(`/api/projects/${projectId}/agent/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
          body: JSON.stringify({
            message: serverMessage,
            activeCompPath,
            authMode,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
        }
        if (!res.body) throw new Error("response has no body");

        await consumeSSE(res.body, controller.signal, (event, data) => {
          handleAgentEvent(event, data, { setMessages, updateLastAssistant });
        });
      } catch (err) {
        if (!controller.signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [projectId, activeCompPath, authMode, streaming],
  );

  return {
    messages,
    streaming,
    error,
    authStatus,
    authMode,
    setAuthMode,
    send,
    abort,
    clearConversation,
    refreshAuthStatus,
    saveAnthropicKey,
    clearAnthropicKey,
    saveStockKey,
    clearStockKey,
    ...skillsApi,
  };
}

// ── Credentials PUT helper ──────────────────────────────────────────────────

/**
 * PUT an API key and return either the refreshed AuthStatus or a user-friendly
 * error. Tolerant of servers that respond with non-JSON (e.g. an outdated dev
 * server that hasn't been restarted since a route was added — Hono returns
 * "404 Not Found" as plain text, which would otherwise surface as the
 * confusing "Unexpected non-whitespace character after JSON" parse error).
 */
async function putCredentialKey(
  endpoint: string,
  apiKey: string,
): Promise<{ ok: true; status: AuthStatus } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const raw = await res.text();
  let parsed: unknown = null;
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    const errMessage =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { error?: unknown }).error === "string"
        ? (parsed as { error: string }).error
        : res.status === 404
          ? `Endpoint not found (${endpoint}). If you just upgraded Hyperframes, restart the dev server.`
          : `HTTP ${res.status}: ${raw.slice(0, 200) || res.statusText}`;
    return { ok: false, error: errMessage };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Server returned an unexpected response (not JSON)." };
  }
  return { ok: true, status: parsed as AuthStatus };
}

// ── SSE consumer ────────────────────────────────────────────────────────────

async function consumeSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const lines = frame.split("\n");
        let eventName = "message";
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith("event: ")) eventName = line.slice(7).trim();
          else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
        }
        if (dataLines.length === 0) continue;
        try {
          const parsed = JSON.parse(dataLines.join("\n"));
          onEvent(eventName, parsed);
        } catch {
          /* malformed — skip */
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

// ── Server-event reducer ────────────────────────────────────────────────────

interface AgentEventCtx {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  updateLastAssistant: (
    setMsgs: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
    mutator: (blocks: AssistantBlock[]) => AssistantBlock[],
  ) => void;
}

function handleAgentEvent(event: string, data: unknown, ctx: AgentEventCtx): void {
  switch (event) {
    case "text_delta": {
      const d = (data as { delta: string }).delta;
      ctx.updateLastAssistant(ctx.setMessages, (blocks) => {
        // Mark any in-flight thinking block as finished — assistant text
        // means the model moved past the reasoning phase.
        const next = blocks.map((b) =>
          b.type === "thinking" && b.streaming ? { ...b, streaming: false } : b,
        );
        const last = next[next.length - 1];
        if (last && last.type === "text") {
          return next.slice(0, -1).concat({ ...last, text: last.text + d });
        }
        return next.concat({ type: "text", text: d });
      });
      return;
    }
    case "thinking_delta": {
      const d = (data as { delta: string }).delta;
      ctx.updateLastAssistant(ctx.setMessages, (blocks) => {
        const last = blocks[blocks.length - 1];
        if (last && last.type === "thinking" && last.streaming) {
          return blocks.slice(0, -1).concat({ ...last, text: last.text + d });
        }
        return blocks.concat({ type: "thinking", text: d, streaming: true });
      });
      return;
    }
    case "tool_start": {
      const d = data as { id: string; name: string; input?: unknown };
      ctx.updateLastAssistant(ctx.setMessages, (blocks) => {
        // The SDK emits both a stream_event `content_block_start` (for the
        // tool_use block) AND our tool-handler `onToolEvent`. They may
        // arrive in either order. Dedupe by name: if there's a matching
        // tool block without a result yet, keep it; otherwise append.
        const lastTool = [...blocks].reverse().find((b) => b.type === "tool" && b.result == null);
        if (
          lastTool &&
          lastTool.type === "tool" &&
          (lastTool.name === d.name || lastTool.name.endsWith(`__${d.name}`))
        ) {
          return blocks;
        }
        return blocks.concat({
          type: "tool",
          id: d.id,
          name: d.name,
          partialInput: d.input ? JSON.stringify(d.input) : "",
          input: d.input,
        });
      });
      return;
    }
    case "tool_input_delta": {
      const d = data as { id: string; partial: string };
      ctx.updateLastAssistant(ctx.setMessages, (blocks) =>
        blocks.map((b) =>
          b.type === "tool" && b.id === d.id
            ? { ...b, partialInput: b.partialInput + d.partial }
            : b,
        ),
      );
      return;
    }
    case "tool_input_complete": {
      const d = data as { id: string; input: unknown };
      ctx.updateLastAssistant(ctx.setMessages, (blocks) =>
        blocks.map((b) => (b.type === "tool" && b.id === d.id ? { ...b, input: d.input } : b)),
      );
      return;
    }
    case "tool_result": {
      const d = data as { id: string; name: string; content: string; isError: boolean };
      ctx.updateLastAssistant(ctx.setMessages, (blocks) => {
        // tool_result IDs from the tool-handler callback don't match the
        // SDK's tool_use_id, so match by name + the most-recent
        // result-less tool block of that name.
        const target = [...blocks]
          .reverse()
          .find(
            (b) =>
              b.type === "tool" &&
              b.result == null &&
              (b.name === d.name || b.name.endsWith(`__${d.name}`)),
          );
        if (!target || target.type !== "tool") return blocks;
        return blocks.map((b) =>
          b === target ? { ...b, result: d.content, isError: d.isError } : b,
        );
      });
      return;
    }
    case "init":
    case "turn_complete":
    case "iteration_start":
      return;
    case "done": {
      // Final flush — close any thinking spinner that never received text.
      ctx.updateLastAssistant(ctx.setMessages, (blocks) =>
        blocks.map((b) => (b.type === "thinking" && b.streaming ? { ...b, streaming: false } : b)),
      );
      return;
    }
    case "error": {
      const d = data as { message?: string };
      ctx.updateLastAssistant(ctx.setMessages, (blocks) =>
        blocks.concat({
          type: "text",
          text: `\n\n_Error: ${d.message ?? "unknown"}_`,
        }),
      );
      return;
    }
    default:
      return;
  }
}
