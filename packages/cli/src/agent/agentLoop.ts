/**
 * In-Studio agent loop powered by `@anthropic-ai/claude-agent-sdk`.
 *
 * Why the Agent SDK (not the raw Anthropic SDK we used before): the Agent
 * SDK transparently supports both auth paths the user expects:
 *
 *   - **Claude Code subscription** (Pencil-style). User runs `claude /login`
 *     once, then this loop runs without any API key. Billing pulls from
 *     their Pro/Max subscription.
 *   - **API key**. We inject it via `options.env.ANTHROPIC_API_KEY` and
 *     the SDK uses it.
 *
 * The SDK spawns Claude Code as a subprocess and streams `SDKMessage`
 * back. We adapt those into the same `AgentEvent` shape the frontend was
 * already consuming, so the UI doesn't need to know the runtime changed.
 *
 * NOTE: We deliberately disable every built-in Claude Code tool and only
 * expose our own MCP-shaped Hyperframes tools (`list_files`, `read_file`,
 * `write_file`, `lint`). The agent does not need `bash`, `web_search`, or
 * Claude Code's file editor — we own the project filesystem here.
 */

import { delimiter, dirname } from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import type { ResolvedProject, StudioApiAdapter } from "@hyperframes/core/studio-api";
import { ALLOWED_TOOL_NAMES, MCP_SERVER_NAME, buildToolServer } from "./tools.js";
import { buildSystemPromptText } from "./systemPrompt.js";
import { detectAuthStatus } from "./authDetect.js";
import { enabledSkillNames } from "./skills.js";

const MAX_TURNS = 30;
const MODEL = "claude-opus-4-7";

export type AuthMode = "claude-code" | "api-key";

export type AgentEvent =
  | { type: "init"; sessionId: string; apiKeySource?: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string; input?: unknown }
  | { type: "tool_input_delta"; id: string; partial: string }
  | { type: "tool_input_complete"; id: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | {
      type: "turn_complete";
      stopReason: string | null;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
      };
      totalCostUsd?: number;
      durationMs?: number;
    }
  | { type: "error"; message: string; recoverable: boolean };

export interface RunAgentTurnOptions {
  authMode: AuthMode;
  /** Required when `authMode === "api-key"`. */
  apiKey?: string;
  projectDir: string;
  projectId: string;
  activeCompPath?: string | null;
  userMessage: string;
  /**
   * SessionId from a previous turn — passed to `resume:` so the SDK
   * continues the same conversation. Omit for a fresh thread.
   */
  resumeSessionId?: string | null;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
  /**
   * Studio API adapter + resolved project. Passed through to the tool
   * server so MCP tools that need access to the studio backend (e.g.
   * `export_video`) can talk to it directly.
   */
  adapter?: StudioApiAdapter;
  project?: ResolvedProject;
}

export interface RunAgentTurnResult {
  /** New sessionId emerged from this turn, or null on early failure. */
  sessionId: string | null;
  stopReason: string | null;
}

export async function runAgentTurn(opts: RunAgentTurnOptions): Promise<RunAgentTurnResult> {
  // Wire the tool MCP server. The handlers fire `onToolEvent` synchronously
  // as Claude invokes each tool, which gives us crisp UI affordances.
  const toolServer = buildToolServer({
    projectDir: opts.projectDir,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
    ...(opts.project ? { project: opts.project } : {}),
    onToolEvent: (event) => {
      const toolName = `mcp__${MCP_SERVER_NAME}__${event.name}`;
      if (event.type === "tool_start") {
        opts.emit({
          type: "tool_start",
          // We don't have the tool_use_id from the SDK at this point — use
          // a stable per-call key the UI can dedupe on.
          id: `${toolName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: toolName,
          input: event.input,
        });
      } else {
        opts.emit({
          type: "tool_result",
          id: "(latest)", // UI matches by name + recency for MVP
          name: toolName,
          content: event.output ?? "",
          isError: event.isError === true,
        });
      }
    },
  });

  // Env: pass an empty ANTHROPIC_API_KEY when on subscription mode so the
  // SDK does NOT pick up a key the user has set in their shell env and
  // accidentally bill through API credits.
  //
  // When on api-key mode, inject the key the user pasted in Settings.
  const env: Record<string, string | undefined> = { ...process.env };
  if (opts.authMode === "api-key") {
    if (!opts.apiKey) {
      opts.emit({
        type: "error",
        message: "API key auth was selected but no key is configured.",
        recoverable: false,
      });
      return { sessionId: null, stopReason: "error" };
    }
    env.ANTHROPIC_API_KEY = opts.apiKey;
  } else {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // If we discovered the `claude` binary in a non-PATH location
    // (winget, npm-global without env-refresh, etc.), prepend its
    // directory to PATH so the Agent SDK's subprocess can spawn it.
    // Otherwise the SDK fails with `claude: command not found` even
    // though our detector resolved a real binary.
    const status = detectAuthStatus();
    const cliPath = status.claudeCode.cliPath;
    if (cliPath) {
      const dir = dirname(cliPath);
      const currentPath = env.PATH ?? env.Path ?? "";
      if (!currentPath.split(delimiter).some((p) => p === dir)) {
        env.PATH = currentPath ? `${dir}${delimiter}${currentPath}` : dir;
      }
    }
  }

  const options: Options = {
    cwd: opts.projectDir,
    env,
    model: MODEL,
    maxTurns: MAX_TURNS,
    includePartialMessages: true,
    systemPrompt: buildSystemPromptText({
      projectId: opts.projectId,
      activeCompPath: opts.activeCompPath ?? null,
    }),
    mcpServers: { [MCP_SERVER_NAME]: toolServer },
    allowedTools: ALLOWED_TOOL_NAMES,
    // Disable every built-in tool — only our MCP tools should be callable.
    // The Skill tool is enabled implicitly by setting `skills` below; the SDK
    // does not require us to add it to `allowedTools`.
    tools: [],
    // Bypass interactive permission prompts since the user opted into AI
    // edits on their own project. Tool calls run automatically.
    permissionMode: "bypassPermissions",
    // Read skills from `~/.claude/skills/` (user) and `<projectDir>/.claude/skills/`
    // (project). Lets users install community skills via `npx skills add owner/repo`
    // or author their own per-project editing styles. We intentionally exclude
    // `'local'` so a stray `.claude.local.json` in the user's CWD doesn't leak
    // settings — only explicit user + project sources count.
    settingSources: ["user", "project"],
    // Honor the user's per-project enable list — Studio's Skills panel
    // writes it. `"all"` means "no curation yet, expose every discovered
    // skill"; an array means "only these are on for this project".
    skills: enabledSkillNames(opts.projectDir),
    ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    // Desktop sidecar override: when the CLI is single-file-compiled via
    // `bun --compile`, the SDK's platform-specific optional dep that ships
    // the `claude` binary isn't reachable. The desktop shell bundles the
    // binary as a Tauri resource and points us at it via this env var.
    ...(process.env.HYPERFRAMES_CLAUDE_CLI_PATH
      ? { pathToClaudeCodeExecutable: process.env.HYPERFRAMES_CLAUDE_CLI_PATH }
      : {}),
  };

  // Bridge the route's AbortController into the SDK's. The SDK uses it to
  // tear down the subprocess cleanly.
  const sdkController = new AbortController();
  if (opts.signal.aborted) sdkController.abort();
  opts.signal.addEventListener("abort", () => sdkController.abort());
  options.abortController = sdkController;

  let sessionId: string | null = opts.resumeSessionId ?? null;
  let stopReason: string | null = null;

  // Tool-use id tracking for streamed input deltas. The Agent SDK surfaces
  // raw stream events from the underlying Messages API on partial messages,
  // which is where we observe `content_block_start` + `input_json_delta`.
  const toolBlockIdByIndex = new Map<number, string>();

  try {
    const iterator = query({
      prompt: opts.userMessage,
      options,
    });
    for await (const msg of iterator) {
      if (opts.signal.aborted) break;
      handleMessage(msg, {
        emit: opts.emit,
        toolBlockIdByIndex,
        onSession: (id) => {
          sessionId = id;
        },
        onStopReason: (r) => {
          stopReason = r;
        },
      });
    }
  } catch (err) {
    if (opts.signal.aborted) {
      opts.emit({ type: "error", message: "Aborted by user.", recoverable: false });
      return { sessionId, stopReason: "aborted" };
    }
    const message = err instanceof Error ? err.message : String(err);
    opts.emit({ type: "error", message, recoverable: false });
    return { sessionId, stopReason: "error" };
  }

  return { sessionId, stopReason };
}

// ── SDK message dispatcher ─────────────────────────────────────────────────

interface DispatchCtx {
  emit: (event: AgentEvent) => void;
  toolBlockIdByIndex: Map<number, string>;
  onSession: (id: string) => void;
  onStopReason: (reason: string) => void;
}

function handleMessage(msg: SDKMessage, ctx: DispatchCtx): void {
  // The SDK message union is broad — we only handle the surfaces that
  // map onto a meaningful chat-UI affordance. Everything else falls
  // through silently.
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        ctx.onSession(msg.session_id);
        ctx.emit({
          type: "init",
          sessionId: msg.session_id,
          apiKeySource: msg.apiKeySource,
        });
      }
      return;

    case "stream_event":
      handleStreamEvent(msg.event, ctx);
      return;

    case "assistant":
      // Full assistant message — we already streamed deltas via stream_event.
      // The one thing only available here is the canonical stop_reason.
      if (msg.message?.stop_reason) ctx.onStopReason(msg.message.stop_reason);
      return;

    case "result": {
      const usage = msg.usage as
        | {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      ctx.emit({
        type: "turn_complete",
        stopReason: msg.subtype === "success" ? "end_turn" : msg.subtype,
        totalCostUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        usage: usage
          ? {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
            }
          : undefined,
      });
      return;
    }

    default:
      return;
  }
}

// Maps a raw Anthropic Messages streaming event onto our AgentEvent shape.
function handleStreamEvent(event: BetaRawMessageStreamEvent, ctx: DispatchCtx): void {
  if (event.type === "content_block_start") {
    const block = event.content_block;
    if (block.type === "tool_use") {
      ctx.toolBlockIdByIndex.set(event.index, block.id);
      ctx.emit({ type: "tool_start", id: block.id, name: block.name });
    }
    return;
  }
  if (event.type === "content_block_delta") {
    const delta = event.delta;
    if (delta.type === "text_delta") {
      ctx.emit({ type: "text_delta", delta: delta.text });
      return;
    }
    if (delta.type === "thinking_delta") {
      ctx.emit({ type: "thinking_delta", delta: delta.thinking });
      return;
    }
    if (delta.type === "input_json_delta") {
      const id = ctx.toolBlockIdByIndex.get(event.index);
      if (id) ctx.emit({ type: "tool_input_delta", id, partial: delta.partial_json });
      return;
    }
  }
}
