/**
 * System-prompt builder for the in-Studio AI chat.
 *
 * The prompt is split into two parts so prompt caching does its job:
 *
 *   1. Frozen prefix — Hyperframes operating manual + tool conventions.
 *      Identical across every request, marked `cache_control: ephemeral`.
 *   2. Live suffix — the active project ID + a one-line state snippet.
 *      Cheap to re-render each turn.
 *
 * If the `hyperframes` skill (skills/hyperframes/SKILL.md) is reachable on
 * disk we splice its body into the frozen prefix so the agent knows the
 * full composition contract. In standalone CLI installs the skill isn't
 * bundled, so we ship a focused fallback baked in below.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";

const FALLBACK_HYPERFRAMES_SUMMARY = `
## Hyperframes — quick contract

A Hyperframes project is an HTML file (\`index.html\`) plus optional sub-compositions
under \`compositions/\`. The runtime treats one element as the **root composition**:

\`\`\`html
<div id="root"
     data-composition-id="main"
     data-start="0"
     data-duration="10"
     data-width="1920"
     data-height="1080">
  ...
</div>
\`\`\`

- Every composition must have an element with both \`data-composition-id\` and
  \`data-width\` / \`data-height\`. Studio reads dimensions from the root element.
- Animations bind to that ID via \`window.__timelines[id]\`, which holds a
  paused GSAP timeline:

  \`\`\`html
  <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
  <script>
    window.__timelines = window.__timelines || {};
    const tl = gsap.timeline({ paused: true });
    // tl.from("#title", { opacity: 0, y: -50, duration: 1 }, 0);
    window.__timelines["main"] = tl;
  </script>
  \`\`\`

- Children that act as time-bounded clips carry \`data-start\` and
  \`data-duration\` (seconds). Use \`data-track-index\` to layer.
- Image / video / audio elements use ordinary HTML — \`<video src=... muted playsinline>\`,
  \`<audio src=...>\` — with \`data-start\` and \`data-duration\` for timing.
- Do not touch \`renders/\`, \`.hyperframes/\`, or \`node_modules/\` — they are
  generated or external.

The Studio previews the project live and reloads on every \`write_file\` call.
`;

const TOOL_PROTOCOL = `
## How to use the tools

- Start with \`list_files\` to ground yourself in the project's actual layout.
  Never assume.
- \`read_file\` before editing — confirm the current state, then write the
  full replacement with \`write_file\`. There is no patch tool. Preserve
  unrelated content carefully.
- After a non-trivial structural edit, call \`lint\` to catch broken
  composition contracts (missing \`data-composition-id\`, missing
  \`window.__timelines\` entry, dimension mismatches).
- Default to small, verifiable steps. Make one cohesive change at a time so
  the user can preview it.

## Stock media

When the user asks for photos or videos you don't already have on disk,
use \`search_stock_media\` (provider: \`pexels\`, \`unsplash\`, or \`pixabay\`;
kind: \`photo\` or \`video\`). Surface a few candidates with a one-line
summary; once the user picks one — or if the prompt is concrete enough to
choose without asking — call \`download_stock_asset\` with the result's
\`download:\` URL and a project-relative path under \`assets/\` (e.g.
\`assets/hero.jpg\`). Then reference the local path in the HTML you write.

- Unsplash is photos only. Use Pexels or Pixabay for video.
- If a provider is not configured the tool returns an error naming the
  configured ones — retry against an available provider, or tell the
  user how to add the missing key (Studio → AI panel → Settings → Stock
  media).
- Credit photographers in a short comment near the inserted tag when the
  source URL is available.

## Exporting

Use \`export_video\` when the user asks to render, export, or save the
composition as a video. It kicks off an async render through the Studio's
render queue and returns immediately with a jobId — progress is visible
in the Studio's Renders panel. Defaults are mp4 + standard + 30fps + the
composition's authored size; only override when the user asks for it.

## Skills

The user may have installed additional skills (via \`npx skills add <owner/repo>\`
or hand-authored under \`~/.claude/skills/\` or \`<project>/.claude/skills/\`)
that capture editing styles, runtime helpers, or domain-specific guidance.
They surface through the \`Skill\` tool with a \`name\` + \`description\`.

- When a user request matches a skill's description (e.g. "make it cinematic"
  with a \`/cinematic\` skill installed), invoke it before composing the edit.
- Skills are advisory: read what they tell you, then apply it to the
  Hyperframes contract above. They do not replace the contract.

## Working style

- The user is editing a real video composition in front of you. Concise
  answers, no preamble. Drop the *"Great question!"* and the post-edit
  summaries — the user can see the diff.
- When the user describes a goal, propose the concrete edit and apply it.
  When the user asks a question, answer the question and stop.
- Spanish is fine if the user writes in Spanish. Match their language.
- Reply with the language used in the system prompt unless the user asks
  for a different one.
`;

interface CachedSkill {
  content: string;
  mtimeMs: number;
}

let _skillCache: CachedSkill | null = null;

function findSkillPath(): string | null {
  // Dev mode: walk up from this source file looking for /skills/hyperframes.
  // dist/ build: __dirname is in dist; walk up the same way.
  const here = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url));
    } catch {
      // CJS or pre-bundled — fall back to __dirname if available
      return typeof __dirname !== "undefined" ? __dirname : process.cwd();
    }
  })();
  const candidates: string[] = [];
  let cursor = here;
  for (let depth = 0; depth < 6; depth++) {
    candidates.push(join(cursor, "skills", "hyperframes", "SKILL.md"));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Also try a local-install location (CLI bundled skills).
  candidates.push(resolve(here, "../skills/hyperframes/SKILL.md"));

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function loadHyperframesSkill(): string {
  const path = findSkillPath();
  if (!path) return FALLBACK_HYPERFRAMES_SUMMARY;
  try {
    // Cheap mtime-based cache so we re-read after the user edits the skill
    // locally without paying a disk read on every turn.
    const stat = readFileSync(path, "utf-8");
    if (_skillCache && _skillCache.content.length === stat.length) {
      // Length-equivalent → assume same content. Re-stat would be more
      // robust but this prompt is non-critical and getting served from
      // cache anyway.
      return _skillCache.content;
    }
    _skillCache = { content: stat, mtimeMs: Date.now() };
    return stat;
  } catch {
    return FALLBACK_HYPERFRAMES_SUMMARY;
  }
}

const ROLE_HEADER = `You are an embedded video-editing assistant inside the Hyperframes Studio,
running with full read/write access to a single project on the user's local
filesystem. You can edit any file in the project to fulfill the user's
request. The Studio preview reloads automatically after each \`write_file\`.

Your job is to make concrete, visible changes — not to describe them. Use
the tools.`;

/**
 * Build the system prompt for a turn.
 *
 * The prefix is identical across every turn for a given Studio install, so
 * we mark it `cache_control: ephemeral`. The per-project suffix changes
 * cheaply and is left uncached.
 */
export function buildSystemPrompt(opts: {
  projectId: string;
  activeCompPath?: string | null;
}): Anthropic.Messages.TextBlockParam[] {
  const skillBody = loadHyperframesSkill();

  // Stable prefix — eligible for cache. Order: role → contract → tools.
  const prefix = [ROLE_HEADER, skillBody, TOOL_PROTOCOL].join("\n\n");

  const liveLines: string[] = [`### Current session`, `- Project: \`${opts.projectId}\``];
  if (opts.activeCompPath) liveLines.push(`- Active composition: \`${opts.activeCompPath}\``);
  liveLines.push(`- Today: ${new Date().toISOString().slice(0, 10)}`);
  const suffix = liveLines.join("\n");

  return [
    {
      type: "text",
      text: prefix,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: suffix,
    },
  ];
}

/**
 * Single-string variant for the Agent SDK, which takes `systemPrompt: string`
 * (not a content-block array). We give up the explicit `cache_control`
 * breakpoint here — the SDK manages its own caching of the prefix the way
 * Claude Code does.
 */
export function buildSystemPromptText(opts: {
  projectId: string;
  activeCompPath?: string | null;
}): string {
  const blocks = buildSystemPrompt(opts);
  return blocks.map((b) => b.text).join("\n\n");
}
