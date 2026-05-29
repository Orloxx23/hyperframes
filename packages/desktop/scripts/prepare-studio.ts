/**
 * Copy the built Studio bundle (and the hyperframe-runtime.js) into
 * `resources/studio/` so Tauri ships them with the installer.
 *
 * The sidecar reads them via the `HYPERFRAMES_STUDIO_DIR` and
 * `HYPERFRAMES_RUNTIME_JS` env vars — see [studioServer.ts:resolveStudioBundle](../../cli/src/server/studioServer.ts).
 */

import { cpSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { REPO_ROOT, RESOURCES_DIR, ensureDir, log } from "./_shared.ts";

const STUDIO_DIST = resolve(REPO_ROOT, "packages", "studio", "dist");
const CLI_DIST = resolve(REPO_ROOT, "packages", "cli", "dist");

async function main(): Promise<void> {
  if (!existsSync(STUDIO_DIST)) {
    throw new Error(
      `Studio bundle not found at ${STUDIO_DIST}. Run 'bun run --filter @hyperframes/studio build' from the repo root first.`,
    );
  }

  const target = resolve(RESOURCES_DIR, "studio");
  ensureDir(target);

  // Copy the entire studio dist tree (index.html + assets/ + icons/ + ...).
  // We DO NOT delete first — leftover files from a previous prepare are
  // harmless and the OS-level rename inside cpSync is atomic per file.
  for (const entry of readdirSync(STUDIO_DIST)) {
    cpSync(join(STUDIO_DIST, entry), join(target, entry), {
      recursive: true,
      force: true,
    });
  }
  log(`✓ Copied Studio bundle → ${target}`);

  // Copy the hyperframe runtime JS. tsup emits it next to cli.js as
  // either `hyperframe-runtime.js` or `hyperframe.runtime.iife.js`.
  const runtimeCandidates = [
    join(CLI_DIST, "hyperframe-runtime.js"),
    join(CLI_DIST, "hyperframe.runtime.iife.js"),
  ];
  const runtimeSrc = runtimeCandidates.find((p) => existsSync(p));
  if (!runtimeSrc) {
    throw new Error(
      `Runtime JS not found in any of: ${runtimeCandidates.join(", ")}. Did the CLI build emit it?`,
    );
  }

  cpSync(runtimeSrc, join(target, "hyperframe-runtime.js"), { force: true });
  log(`✓ Copied runtime → ${join(target, "hyperframe-runtime.js")}`);
}

main().catch((err) => {
  console.error("[hf-desktop] prepare-studio failed:", err);
  process.exit(1);
});
