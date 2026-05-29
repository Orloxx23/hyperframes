/**
 * Blank-project scaffolding shared by every Studio adapter that exposes
 * `createBlankProject` (CLI embedded server + vite dev adapter).
 *
 * The output must be a valid hyperframes composition — i.e. the runtime
 * needs to find a root composition element via `[data-composition-id]` and
 * a matching `window.__timelines[id]` entry. Without those, the preview
 * iframe never emits `stage-size`, so the Studio falls back to its default
 * landscape canvas and the user sees the wrong orientation.
 */

import { CANVAS_DIMENSIONS, type CanvasResolution } from "../../core.types.js";

const DEFAULT_DURATION_SECONDS = 10;

/**
 * Filesystem-safe slug for a project directory. Keeps Unicode letters
 * intact (so non-ASCII names like "diseño" survive) but replaces path
 * separators and other shell-hostile characters with dashes.
 */
export function sanitizeProjectName(input: string): string {
  return input
    .normalize("NFC")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface BlankProjectOptions {
  name: string;
  resolution: CanvasResolution;
  /** Composition duration in seconds. Defaults to 10. */
  durationSeconds?: number;
}

/**
 * Build the index.html for a brand-new project.
 *
 * The template mirrors the bundled `blank` CLI starter:
 * - `<html data-resolution>` so the linter recognises the preset
 * - `<div id="root" data-composition-id="main" data-width data-height>` —
 *   the runtime's `resolveRootCompositionElement()` looks for this
 * - GSAP CDN + `window.__timelines["main"]` so the runtime has a paused
 *   timeline to register against. Without that, no `stage-size` message
 *   reaches the parent and the Studio renders a default landscape canvas.
 */
export function buildBlankProjectIndexHtml(opts: BlankProjectOptions): string {
  const { width, height } = CANVAS_DIMENSIONS[opts.resolution];
  const duration = opts.durationSeconds ?? DEFAULT_DURATION_SECONDS;
  const safeName = escapeHtml(opts.name);
  return `<!doctype html>
<html lang="en" data-resolution="${opts.resolution}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <title>${safeName}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body {
        margin: 0;
        width: ${width}px;
        height: ${height}px;
        overflow: hidden;
        background: #0d0f14;
        color: #f5f5f5;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #root { position: relative; }
      .placeholder {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: ${Math.round(Math.min(width, height) * 0.06)}px;
        opacity: 0.5;
        letter-spacing: -0.02em;
      }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-duration="${duration}"
      data-width="${width}"
      data-height="${height}"
      style="width: ${width}px; height: ${height}px;"
    >
      <div class="placeholder">${safeName}</div>
      <!--
        Add your clips here. Example:
        <div id="title" class="clip" data-start="0" data-duration="3" data-track-index="1"
             style="font-size: 64px; color: #fff; padding: 40px">
          Hello World
        </div>
      -->
    </div>

    <script>
      window.__timelines = window.__timelines || {};
      const tl = gsap.timeline({ paused: true });
      // Example: tl.from("#title", { opacity: 0, y: -50, duration: 1 }, 0);
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
}

/** Convenience wrapper that bundles index.html + meta.json contents. */
export function buildBlankProjectFiles(opts: BlankProjectOptions): {
  "index.html": string;
  "meta.json": string;
} {
  return {
    "index.html": buildBlankProjectIndexHtml(opts),
    "meta.json": `${JSON.stringify(
      { id: opts.name, name: opts.name, createdAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
  };
}
