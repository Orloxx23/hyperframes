/**
 * Custom in-process tools exposed to Claude via the Agent SDK's MCP server.
 *
 * Why MCP-shaped tools (and not the older raw JSON schema): the Agent SDK
 * only registers custom tools via `createSdkMcpServer`. Tools are typed
 * with Zod and surface to Claude as `mcp__hf__<name>`.
 *
 * The handler return shape is the MCP `CallToolResult`:
 *
 *   { content: [{type:"text", text:"..."}], isError?: boolean }
 *
 * Returning `isError: true` lets the agent see the failure and recover
 * (try a different path, ask the user, etc.) instead of crashing the
 * whole `query()` call.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  isSafePath,
  walkDir,
  type ResolvedProject,
  type StudioApiAdapter,
} from "@hyperframes/core/studio-api";
import { getStockApiKey, STOCK_PROVIDERS, type StockProvider } from "./credentials.js";
import {
  download as downloadStockAsset,
  formatSearchResults,
  search as searchStockMedia,
} from "./stockMedia.js";
import { analyzeVideo, FFmpegMissingError, summarizeKeyframePayload } from "./videoAnalysis.js";
import { createProjectSkill, createUserSkill } from "./skills.js";
import { transcribe } from "../whisper/transcribe.js";
import { loadTranscript, type Word } from "../whisper/normalize.js";

// Mirror of @modelcontextprotocol/sdk's CallToolResult — that package is a
// peerDep of the Agent SDK and not directly in our dep tree, so we keep a
// minimal structural copy here rather than pull it in. The `image` variant
// lets multimodal tools (analyze_video) return frames Claude can see.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface CallToolResult {
  [k: string]: unknown;
  content: ContentBlock[];
  isError?: boolean;
}

/** Server / tool naming surfaces to Claude as `mcp__hf__<tool>`. */
export const MCP_SERVER_NAME = "hf";
export const ALLOWED_TOOL_NAMES = [
  `mcp__${MCP_SERVER_NAME}__list_files`,
  `mcp__${MCP_SERVER_NAME}__read_file`,
  `mcp__${MCP_SERVER_NAME}__write_file`,
  `mcp__${MCP_SERVER_NAME}__lint`,
  `mcp__${MCP_SERVER_NAME}__search_stock_media`,
  `mcp__${MCP_SERVER_NAME}__download_stock_asset`,
  `mcp__${MCP_SERVER_NAME}__export_video`,
  `mcp__${MCP_SERVER_NAME}__analyze_video`,
  `mcp__${MCP_SERVER_NAME}__render_and_review`,
  `mcp__${MCP_SERVER_NAME}__transcribe_audio`,
  `mcp__${MCP_SERVER_NAME}__create_skill`,
];

export interface BuildToolServerOpts {
  projectDir: string;
  /**
   * Notify callback fired on every tool invocation. The SSE bridge uses
   * this to forward `tool_start` / `tool_result` events out to the UI
   * (the Agent SDK's `SDKAssistantMessage` only surfaces tool USES, not
   * raw start/end timings).
   */
  onToolEvent?: (event: ToolEvent) => void;
  /**
   * Studio API adapter — required for the `export_video` tool. When
   * omitted the export tool is registered but always returns an error
   * (keeps the SDK happy without crashing).
   */
  adapter?: StudioApiAdapter;
  /** Resolved active project — required by `export_video` to compute outputs. */
  project?: ResolvedProject;
}

export interface ToolEvent {
  type: "tool_start" | "tool_result";
  name: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
}

/**
 * Group word-level whisper output into phrase-level chunks for the agent.
 * Breaks a phrase when:
 *   - the gap between two consecutive words exceeds `maxPauseMs`, or
 *   - the current word ends a sentence (`.`, `?`, `!`, ...), or
 *   - the current phrase already holds `maxWords` words.
 *
 * Exported for unit testing.
 */
export function groupWordsIntoPhrases(
  words: Word[],
  opts: { maxPauseMs?: number; maxWords?: number } = {},
): Array<{ start: number; end: number; text: string }> {
  const maxPauseSec = (opts.maxPauseMs ?? 700) / 1000;
  const maxWords = opts.maxWords ?? 18;
  const sentenceEnd = /[.!?]["')\]]?$/;
  const out: Array<{ start: number; end: number; text: string }> = [];
  let cur: { start: number; end: number; tokens: string[] } | null = null;

  const flush = () => {
    if (!cur) return;
    out.push({ start: cur.start, end: cur.end, text: cur.tokens.join(" ").trim() });
    cur = null;
  };

  for (const w of words) {
    if (!cur) {
      cur = { start: w.start, end: w.end, tokens: [w.text] };
      continue;
    }
    const pause = w.start - cur.end;
    if (pause > maxPauseSec || cur.tokens.length >= maxWords) {
      flush();
      cur = { start: w.start, end: w.end, tokens: [w.text] };
      continue;
    }
    cur.tokens.push(w.text);
    cur.end = w.end;
    if (sentenceEnd.test(w.text)) flush();
  }
  flush();
  return out;
}

function fmtSeconds(s: number): string {
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(2).padStart(5, "0")}`;
}

function resolveSafe(projectDir: string, relPath: string): string {
  if (relPath.includes("\0")) throw new Error("path contains null bytes");
  const abs = resolvePath(projectDir, relPath);
  if (!isSafePath(projectDir, abs)) throw new Error(`path escapes project: ${relPath}`);
  return abs;
}

function textOk(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

function textErr(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function buildToolServer(opts: BuildToolServerOpts) {
  const projectDir = opts.projectDir;
  const emit = (event: ToolEvent) => opts.onToolEvent?.(event);

  const listFiles = tool(
    "list_files",
    "List every file in the active project as a tree. Returns relative paths " +
      "separated by newlines. Always use this first to understand the project " +
      "layout before reading or editing. Excludes node_modules, .git, " +
      "and .thumbnails.",
    {},
    async () => {
      emit({ type: "tool_start", name: "list_files", input: {} });
      try {
        const files = walkDir(projectDir);
        const out = files.length === 0 ? "(project is empty)" : files.sort().join("\n");
        emit({ type: "tool_result", name: "list_files", output: out, isError: false });
        return textOk(out);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "list_files", output: msg, isError: true });
        return textErr(msg);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const readFile = tool(
    "read_file",
    "Read a single file from the active project. Use this for HTML " +
      "compositions, CSS, JS, JSON configs (hyperframes.json, meta.json), " +
      "and anything else the user wants to inspect or edit. Path is " +
      "relative to the project root.",
    {
      path: z
        .string()
        .min(1)
        .describe('Project-relative path, e.g. "index.html" or "compositions/intro.html".'),
    },
    async (args) => {
      emit({ type: "tool_start", name: "read_file", input: args });
      try {
        const abs = resolveSafe(projectDir, args.path);
        if (!existsSync(abs)) throw new Error(`file not found: ${args.path}`);
        const stat = statSync(abs);
        if (stat.isDirectory()) throw new Error(`path is a directory: ${args.path}`);
        // 5MB ceiling — anything larger is almost certainly a binary asset.
        if (stat.size > 5 * 1024 * 1024) {
          throw new Error(
            `file too large (${stat.size} bytes): ${args.path}. Reference by path instead.`,
          );
        }
        const content = readFileSync(abs, "utf-8");
        emit({
          type: "tool_result",
          name: "read_file",
          output: `(read ${content.length} bytes)`,
          isError: false,
        });
        return textOk(content);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "read_file", output: msg, isError: true });
        return textErr(msg);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const writeFile = tool(
    "write_file",
    "Overwrite (or create) a file in the active project. The Studio preview " +
      "reloads automatically when files change. Use this to apply edits, add " +
      "new compositions, or write new helpers. If the parent directory " +
      "doesn't exist it is created. Path is relative to the project root.",
    {
      path: z.string().min(1).describe("Project-relative target path."),
      content: z
        .string()
        .describe(
          "Full UTF-8 contents to write. The previous file content is replaced — there is no patch mode.",
        ),
    },
    async (args) => {
      emit({
        type: "tool_start",
        name: "write_file",
        input: { path: args.path, size: args.content.length },
      });
      try {
        const abs = resolveSafe(projectDir, args.path);
        const parent = dirname(abs);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        writeFileSync(abs, args.content, "utf-8");
        const result = `Wrote ${args.content.length} bytes to ${args.path}`;
        emit({ type: "tool_result", name: "write_file", output: result, isError: false });
        return textOk(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "write_file", output: msg, isError: true });
        return textErr(msg);
      }
    },
  );

  const lint = tool(
    "lint",
    "Run the Hyperframes linter against index.html and report findings. " +
      "Use after non-trivial edits to catch broken composition structure, " +
      "missing timelines, etc.",
    {},
    async () => {
      emit({ type: "tool_start", name: "lint", input: {} });
      try {
        const indexPath = resolvePath(projectDir, "index.html");
        if (!existsSync(indexPath)) {
          const msg = "No index.html in project — nothing to lint.";
          emit({ type: "tool_result", name: "lint", output: msg, isError: false });
          return textOk(msg);
        }
        const html = readFileSync(indexPath, "utf-8");
        const { lintHyperframeHtml } = await import("@hyperframes/core/lint");
        const result = lintHyperframeHtml(html, { filePath: "index.html" });
        const out =
          result.findings.length === 0
            ? "Lint passed — no findings."
            : result.findings
                .map(
                  (f) => `[${f.severity}] ${f.message}${f.fixHint ? ` (fix: ${f.fixHint})` : ""}`,
                )
                .join("\n");
        emit({ type: "tool_result", name: "lint", output: out, isError: false });
        return textOk(out);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "lint", output: msg, isError: true });
        return textErr(msg);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const searchStock = tool(
    "search_stock_media",
    "Search Pexels, Unsplash, or Pixabay for stock photos or videos that " +
      "match a query. Each result includes a `download:` URL the user (or " +
      "you, via `download_stock_asset`) can fetch into the project. " +
      "Unsplash only has photos. Choose a provider explicitly; if the " +
      "preferred one is not configured the tool returns an error listing " +
      "the configured providers so you can retry.",
    {
      query: z.string().min(1).describe("Natural-language search query, e.g. 'sunset beach'."),
      kind: z.enum(["photo", "video"]).describe("Asset type — photo or video."),
      provider: z
        .enum(["pexels", "unsplash", "pixabay"])
        .describe(
          "Which provider to search. Must be configured (the user pastes their own API key in Studio settings).",
        ),
      per_page: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many results to return (default 6, max 20)."),
      orientation: z
        .enum(["landscape", "portrait", "square"])
        .optional()
        .describe(
          "Preferred orientation. Pexels/Unsplash/Pixabay all support landscape and portrait.",
        ),
    },
    async (args) => {
      emit({ type: "tool_start", name: "search_stock_media", input: args });
      try {
        if (!getStockApiKey(args.provider as StockProvider)) {
          const available = STOCK_PROVIDERS.filter((p) => getStockApiKey(p));
          const hint =
            available.length === 0
              ? "No stock-media providers are configured. Ask the user to paste an API key in Studio → AI panel → Settings → Stock media."
              : `Configured providers: ${available.join(", ")}.`;
          throw new Error(`${args.provider} is not configured. ${hint}`);
        }
        const results = await searchStockMedia({
          provider: args.provider as StockProvider,
          query: args.query,
          kind: args.kind,
          perPage: args.per_page,
          orientation: args.orientation,
        });
        const text = formatSearchResults(results);
        emit({
          type: "tool_result",
          name: "search_stock_media",
          output: `(${results.length} results)`,
          isError: false,
        });
        return textOk(text);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "search_stock_media", output: msg, isError: true });
        return textErr(msg);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const downloadStock = tool(
    "download_stock_asset",
    "Download a stock asset returned by `search_stock_media` into the " +
      "project. Pass the `download:` URL verbatim from the search result " +
      "and a project-relative destination path (typically under `assets/`). " +
      "For Unsplash this also triggers the API-required download tracking. " +
      "Parent directories are created automatically.",
    {
      url: z.string().url().describe("`download:` URL copied from a `search_stock_media` result."),
      destination_path: z
        .string()
        .min(1)
        .describe("Project-relative path, e.g. 'assets/hero.jpg' or 'assets/clip.mp4'."),
    },
    async (args) => {
      emit({ type: "tool_start", name: "download_stock_asset", input: args });
      try {
        const abs = resolveSafe(projectDir, args.destination_path);
        const { buffer, meta } = await downloadStockAsset(args.url);
        const parent = dirname(abs);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        writeFileSync(abs, buffer);
        const result = `Downloaded ${meta.bytes} bytes (${meta.contentType ?? "unknown type"}) to ${args.destination_path}`;
        emit({ type: "tool_result", name: "download_stock_asset", output: result, isError: false });
        return textOk(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "download_stock_asset", output: msg, isError: true });
        return textErr(msg);
      }
    },
  );

  const adapter = opts.adapter;
  const project = opts.project;
  const exportVideo = tool(
    "export_video",
    "Render the active project (or a specific composition) to a video " +
      "file. The render runs asynchronously in the background — this tool " +
      "returns immediately with a job id, expected output path, and a " +
      "hint that the user can track progress in the Studio's Renders " +
      "panel. Sensible defaults: mp4 + standard quality + 30fps + auto " +
      "resolution. Pass overrides only when the user asks for them.",
    {
      format: z.enum(["mp4", "webm", "mov"]).optional().describe("Output container. Default mp4."),
      quality: z
        .enum(["draft", "standard", "high"])
        .optional()
        .describe("Render quality preset. Default standard."),
      fps: z
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe("Frames per second. Common: 24, 30, 60. Default 30."),
      resolution: z
        .enum(["landscape", "portrait", "landscape-4k", "portrait-4k", "square", "square-4k"])
        .optional()
        .describe(
          "Output preset. Omit to render at the composition's authored dimensions (recommended).",
        ),
      composition: z
        .string()
        .optional()
        .describe(
          "Render a sub-composition file (project-relative path, e.g. 'compositions/intro.html') instead of index.html.",
        ),
    },
    async (args) => {
      emit({ type: "tool_start", name: "export_video", input: args });
      try {
        if (!adapter || !project) {
          throw new Error(
            "Video export is not available in this context. Run the agent through the Studio's chat panel.",
          );
        }
        const format = args.format ?? "mp4";
        const quality = args.quality ?? "standard";
        const fps = args.fps ?? 30;

        const now = new Date();
        const datePart = now.toISOString().slice(0, 10);
        const timePart = now.toTimeString().slice(0, 8).replace(/:/g, "-");
        const jobId = `${project.id}_${datePart}_${timePart}`;
        const FORMAT_EXT: Record<string, string> = {
          mp4: ".mp4",
          webm: ".webm",
          mov: ".mov",
        };
        const ext = FORMAT_EXT[format] ?? ".mp4";

        const rendersDir = adapter.rendersDir(project);
        if (!existsSync(rendersDir)) mkdirSync(rendersDir, { recursive: true });
        const outputPath = join(rendersDir, `${jobId}${ext}`);

        if (args.composition) {
          // Guard project escape for the composition arg, mirroring the HTTP
          // route's check. The agent shouldn't be able to render arbitrary
          // host paths.
          resolveSafe(projectDir, args.composition);
        }

        adapter.startRender({
          project,
          outputPath,
          format,
          fps: { num: fps, den: 1 },
          quality,
          jobId,
          ...(args.resolution ? { outputResolution: args.resolution } : {}),
          ...(args.composition ? { composition: args.composition } : {}),
        });

        const result = [
          `Export started.`,
          `  jobId: ${jobId}`,
          `  format: ${format}, quality: ${quality}, fps: ${fps}${args.resolution ? `, resolution: ${args.resolution}` : ""}`,
          args.composition ? `  composition: ${args.composition}` : null,
          `  output: ${outputPath}`,
          ``,
          `Progress is shown in the Studio's Renders panel. The render runs in the background — you can keep editing.`,
        ]
          .filter(Boolean)
          .join("\n");
        emit({ type: "tool_result", name: "export_video", output: result, isError: false });
        return textOk(result);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "export_video", output: msg, isError: true });
        return textErr(msg);
      }
    },
  );

  const analyzeVideoTool = tool(
    "analyze_video",
    "Extract a small set of representative keyframes (downscaled JPEG) and " +
      "structural metadata from a video file uploaded into the project. Use " +
      "this when the user wants you to analyze a reference video's visual " +
      "style, animation patterns, palette, or composition — typically as a " +
      "first step before authoring a reusable skill via `create_skill`. " +
      "Returns a text summary followed by the frames inline so you can see " +
      "them directly. Path is project-relative.",
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Project-relative path to a video file, e.g. 'assets/intro.mp4'. " +
            "Common containers (.mp4, .mov, .webm) are supported.",
        ),
      max_frames: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Override the auto-picked frame count. Defaults to 6 (≤10s), 10 (≤60s), or 14 (longer). Max 20.",
        ),
    },
    async (args) => {
      emit({ type: "tool_start", name: "analyze_video", input: args });
      try {
        const abs = resolveSafe(projectDir, args.path);
        if (!existsSync(abs)) throw new Error(`file not found: ${args.path}`);
        const { metadata, frames } = await analyzeVideo(
          abs,
          args.max_frames !== undefined ? { maxFrames: args.max_frames } : {},
        );
        const { totalBytes, approxInputTokens } = summarizeKeyframePayload(frames);

        const timestamps = frames
          .map((f, i) => `  ${i + 1}. t=${(f.timestampMs / 1000).toFixed(2)}s`)
          .join("\n");
        const summary = [
          `Video: ${args.path}`,
          `  duration: ${(metadata.durationMs / 1000).toFixed(2)}s`,
          `  resolution: ${metadata.width}x${metadata.height}`,
          `  fps: ${metadata.fps}`,
          `  codec: ${metadata.codec}`,
          `Keyframes (${frames.length}):`,
          timestamps,
        ].join("\n");

        const content: ContentBlock[] = [{ type: "text", text: summary }];
        for (const frame of frames) {
          content.push({
            type: "image",
            data: frame.buffer.toString("base64"),
            mimeType: "image/jpeg",
          });
        }

        emit({
          type: "tool_result",
          name: "analyze_video",
          output: `(${frames.length} frames, ${(totalBytes / 1024).toFixed(0)} KiB, ~${approxInputTokens} input tokens)`,
          isError: false,
        });
        return { content };
      } catch (e) {
        const msg =
          e instanceof FFmpegMissingError ? e.message : e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "analyze_video", output: msg, isError: true });
        return textErr(msg);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const renderAndReview = tool(
    "render_and_review",
    "Render the active project to a video and immediately analyze the " +
      "resulting frames so you can see how the composition actually looks. " +
      "SYNCHRONOUS: blocks until the render completes (typically 10s–2min " +
      "depending on duration), then returns metadata plus downscaled " +
      "keyframes inline. Use this only when the user explicitly asks you " +
      "to review, check, or verify how the video turned out — don't run it " +
      "automatically after every edit (it's expensive). Defaults: draft " +
      "quality + 15fps for fast turnaround.",
    {
      quality: z
        .enum(["draft", "standard", "high"])
        .optional()
        .describe("Render quality. Default 'draft' for fast review."),
      fps: z
        .number()
        .int()
        .min(1)
        .max(120)
        .optional()
        .describe("Frames per second for the review render. Default 15 (lower = faster)."),
      composition: z
        .string()
        .optional()
        .describe(
          "Render a sub-composition (project-relative path, e.g. 'compositions/intro.html') instead of index.html.",
        ),
      max_frames: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(
          "Number of keyframes to extract from the resulting video. Defaults to auto (6–14 based on duration).",
        ),
      timeout_seconds: z
        .number()
        .int()
        .min(10)
        .max(600)
        .optional()
        .describe("Maximum seconds to wait for the render to finish. Default 300 (5 min)."),
    },
    async (args) => {
      emit({ type: "tool_start", name: "render_and_review", input: args });
      try {
        if (!adapter || !project) {
          throw new Error(
            "Render and review is not available in this context. Run the agent through the Studio's chat panel.",
          );
        }
        const quality = args.quality ?? "draft";
        const fps = args.fps ?? 15;
        const timeoutMs = (args.timeout_seconds ?? 300) * 1000;

        const now = new Date();
        const datePart = now.toISOString().slice(0, 10);
        const timePart = now.toTimeString().slice(0, 8).replace(/:/g, "-");
        const jobId = `${project.id}_review_${datePart}_${timePart}`;

        const rendersDir = adapter.rendersDir(project);
        if (!existsSync(rendersDir)) mkdirSync(rendersDir, { recursive: true });
        const outputPath = join(rendersDir, `${jobId}.mp4`);

        if (args.composition) {
          resolveSafe(projectDir, args.composition);
        }

        const jobState = adapter.startRender({
          project,
          outputPath,
          format: "mp4",
          fps: { num: fps, den: 1 },
          quality,
          jobId,
          ...(args.composition ? { composition: args.composition } : {}),
        });

        const startedAt = Date.now();
        while (jobState.status === "rendering") {
          if (Date.now() - startedAt > timeoutMs) {
            throw new Error(
              `render timed out after ${Math.round(timeoutMs / 1000)}s (last progress: ${Math.round(jobState.progress)}%${jobState.stage ? `, stage: ${jobState.stage}` : ""})`,
            );
          }
          await new Promise<void>((r) => setTimeout(r, 500));
        }

        if (jobState.status === "failed") {
          throw new Error(`render failed: ${jobState.error ?? "(no error message)"}`);
        }
        if (!existsSync(jobState.outputPath)) {
          throw new Error(
            `render reported complete but output file is missing: ${jobState.outputPath}`,
          );
        }

        const { metadata, frames } = await analyzeVideo(
          jobState.outputPath,
          args.max_frames !== undefined ? { maxFrames: args.max_frames } : {},
        );
        const { totalBytes, approxInputTokens } = summarizeKeyframePayload(frames);

        const timestamps = frames
          .map((f, i) => `  ${i + 1}. t=${(f.timestampMs / 1000).toFixed(2)}s`)
          .join("\n");
        const summary = [
          `Render review`,
          `  jobId: ${jobId}`,
          `  output: ${jobState.outputPath}`,
          `  quality: ${quality}, fps: ${fps}${args.composition ? `, composition: ${args.composition}` : ""}`,
          `  duration: ${(metadata.durationMs / 1000).toFixed(2)}s`,
          `  resolution: ${metadata.width}x${metadata.height}`,
          `  codec: ${metadata.codec}`,
          `Keyframes (${frames.length}):`,
          timestamps,
        ].join("\n");

        const content: ContentBlock[] = [{ type: "text", text: summary }];
        for (const frame of frames) {
          content.push({
            type: "image",
            data: frame.buffer.toString("base64"),
            mimeType: "image/jpeg",
          });
        }

        emit({
          type: "tool_result",
          name: "render_and_review",
          output: `(${frames.length} frames, ${(totalBytes / 1024).toFixed(0)} KiB, ~${approxInputTokens} input tokens)`,
          isError: false,
        });
        return { content };
      } catch (e) {
        const msg =
          e instanceof FFmpegMissingError ? e.message : e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "render_and_review", output: msg, isError: true });
        return textErr(msg);
      }
    },
  );

  const transcribeAudioTool = tool(
    "transcribe_audio",
    "Transcribe an audio or video file in the project to word-level " +
      "timestamps, then return phrase-level segments (text + start/end in " +
      "seconds) so you understand WHAT is said and WHEN. Use this when the " +
      "user wants to sync animations to narration, build captions, time " +
      "scene cuts to spoken phrases, or just understand a clip's content. " +
      "Writes `transcript.json` next to the input file (the same convention " +
      "the `hyperframes transcribe` CLI uses) so other tools / compositions " +
      "can read it. First run may take a minute to download a whisper model; " +
      "subsequent runs reuse the cache.",
    {
      path: z
        .string()
        .min(1)
        .describe(
          "Project-relative path to an audio (.mp3, .wav, .m4a, .aac, .ogg, .flac) or " +
            "video (.mp4, .webm, .mov, .mkv, .avi) file.",
        ),
      language: z
        .string()
        .min(2)
        .max(5)
        .optional()
        .describe("ISO 639-1 language hint, e.g. 'en', 'es'. Omit to let whisper auto-detect."),
      model: z
        .string()
        .optional()
        .describe(
          "Whisper model name (default 'small.en'). Bigger = more accurate but slower: " +
            "tiny.en, base.en, small.en, medium.en, large-v3. Use a non-.en variant for " +
            "non-English audio.",
        ),
      max_phrase_pause_ms: z
        .number()
        .int()
        .min(100)
        .max(5000)
        .optional()
        .describe("Pause between words (in ms) that starts a new phrase. Default 700ms."),
      max_phrase_words: z
        .number()
        .int()
        .min(1)
        .max(60)
        .optional()
        .describe("Hard cap on words per phrase before forcing a break. Default 18."),
    },
    async (args) => {
      emit({ type: "tool_start", name: "transcribe_audio", input: args });
      try {
        const abs = resolveSafe(projectDir, args.path);
        if (!existsSync(abs)) throw new Error(`file not found: ${args.path}`);
        const outDir = dirname(abs);

        const transcribeOpts: Parameters<typeof transcribe>[2] = {};
        if (args.model) transcribeOpts.model = args.model;
        if (args.language) transcribeOpts.language = args.language;

        const result = await transcribe(abs, outDir, transcribeOpts);
        const { words } = loadTranscript(result.transcriptPath);
        const phrases = groupWordsIntoPhrases(words, {
          maxPauseMs: args.max_phrase_pause_ms ?? 700,
          maxWords: args.max_phrase_words ?? 18,
        });

        const relTranscript = result.transcriptPath.startsWith(projectDir)
          ? result.transcriptPath.slice(projectDir.length).replace(/^[\\/]+/, "")
          : result.transcriptPath;

        const phraseLines = phrases
          .map(
            (p, i) =>
              `  ${String(i + 1).padStart(2, " ")}. [${fmtSeconds(p.start)} → ${fmtSeconds(p.end)}] ${p.text}`,
          )
          .join("\n");

        const summary = [
          `Transcript: ${args.path}`,
          `  duration: ${result.durationSeconds.toFixed(2)}s`,
          `  words: ${result.wordCount}`,
          `  phrases: ${phrases.length}`,
          result.speechOnsetSeconds != null
            ? `  speech onset: ${result.speechOnsetSeconds.toFixed(2)}s`
            : null,
          `  saved: ${relTranscript}`,
          ``,
          phrases.length > 0 ? "Phrases:" : "(no speech detected)",
          phraseLines,
        ]
          .filter(Boolean)
          .join("\n");

        emit({
          type: "tool_result",
          name: "transcribe_audio",
          output: `(${result.wordCount} words, ${phrases.length} phrases, ${result.durationSeconds.toFixed(1)}s)`,
          isError: false,
        });
        return textOk(summary);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "transcribe_audio", output: msg, isError: true });
        return textErr(msg);
      }
    },
  );

  const createSkill = tool(
    "create_skill",
    "Author a new Hyperframes skill (markdown with YAML frontmatter) that " +
      "captures a reusable style, runtime, or workflow. Use after analyzing " +
      "a reference (e.g. via `analyze_video`) to crystallize patterns the " +
      "agent should follow in future requests. Skills appear in the Studio " +
      "Skills panel where the user enables them per-project. Default scope " +
      "is `user` (~/.claude/skills/) so the skill is reusable across every " +
      "project. The `description` is what the model uses to decide when to " +
      "activate the skill — keep it specific and orthogonal to other skills.",
    {
      name: z
        .string()
        .min(1)
        .max(60)
        .describe("Display name. Becomes the slug after lowercasing/kebab-casing."),
      description: z
        .string()
        .min(1)
        .max(500)
        .describe(
          "Single-line summary the model sees in the skill registry. " +
            "Be specific about when to use it: 'cinematic kinetic typography intros with bold sans-serif and stagger animations'.",
        ),
      body: z
        .string()
        .min(1)
        .describe(
          "Full markdown body (without frontmatter). Recommended sections: Principles, Patterns, Templates. " +
            "End with 1–2 concrete HTML/CSS templates a future agent can adapt.",
        ),
      scope: z
        .enum(["user", "project"])
        .optional()
        .describe(
          "Where to write the skill. Default 'user' (~/.claude/skills/, reusable everywhere).",
        ),
    },
    async (args) => {
      emit({
        type: "tool_start",
        name: "create_skill",
        input: { name: args.name, scope: args.scope ?? "user", body_size: args.body.length },
      });
      try {
        const scope = args.scope ?? "user";
        const result =
          scope === "project"
            ? createProjectSkill(projectDir, {
                name: args.name,
                description: args.description,
                body: args.body,
              })
            : createUserSkill({
                name: args.name,
                description: args.description,
                body: args.body,
              });
        const locationHint =
          result.scope === "user"
            ? `~/.claude/skills/${result.dirName}/SKILL.md`
            : `<project>/.claude/skills/${result.dirName}/SKILL.md`;
        const output = [
          `Wrote ${result.scope} skill "${result.dirName}".`,
          `  path: ${locationHint}`,
          ``,
          `Tell the user it appears (disabled by default) in the Studio Skills panel — they can toggle it on whenever they want this style applied.`,
        ].join("\n");
        emit({ type: "tool_result", name: "create_skill", output, isError: false });
        return textOk(output);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: "tool_result", name: "create_skill", output: msg, isError: true });
        return textErr(msg);
      }
    },
  );

  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      listFiles,
      readFile,
      writeFile,
      lint,
      searchStock,
      downloadStock,
      exportVideo,
      analyzeVideoTool,
      renderAndReview,
      transcribeAudioTool,
      createSkill,
    ],
  });
}
