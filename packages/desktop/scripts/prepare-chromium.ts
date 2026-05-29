/**
 * Download chrome-headless-shell into `resources/chrome/` for the current
 * platform. The desktop sidecar sets `PRODUCER_HEADLESS_SHELL_PATH` to point
 * at the resulting binary so the producer's render pipeline never has to
 * lazy-download Chromium on first launch.
 *
 * Pinned to the same Chrome version as the CLI's `browser/manager.ts` so the
 * desktop and CLI render identically.
 */

import { Browser, detectBrowserPlatform, install, resolveBuildId } from "@puppeteer/browsers";
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { RESOURCES_DIR, log } from "./_shared.ts";

// Keep in sync with packages/cli/src/browser/manager.ts CHROME_VERSION
const CHROME_VERSION = "131.0.6778.85";

async function main(): Promise<void> {
  const platform = detectBrowserPlatform();
  if (!platform) {
    throw new Error("Could not detect a supported puppeteer platform.");
  }

  const targetDir = resolve(RESOURCES_DIR, "chrome");
  if (existsSync(targetDir)) {
    // Wipe any prior install — keep this idempotent. The destination tree is
    // committed to the installer at build time, so partial leftovers would
    // bloat the artifact.
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(targetDir, { recursive: true });

  // We use a scratch cache adjacent to the resources dir so @puppeteer/browsers
  // can manage its own layout, then copy only the files we want into resources/.
  const cacheDir = resolve(RESOURCES_DIR, ".chrome-cache");
  mkdirSync(cacheDir, { recursive: true });

  const buildId = await resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, CHROME_VERSION);

  log(`Installing chrome-headless-shell ${buildId} for ${platform}…`);
  const installed = await install({
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId,
    cacheDir,
    platform,
  });

  // `executablePath` is the absolute path to the headless-shell binary in the
  // cache. The directory containing it has the platform-specific layout
  // (e.g. `chrome-headless-shell-win64/`) which puppeteer expects at runtime.
  const containingDir = resolve(installed.executablePath, "..");
  log(`Copying ${containingDir} → ${targetDir}`);

  // Copy the containing dir's contents — flatten the puppeteer cache shape.
  // The desktop's paths.rs expects `chrome-headless-shell[.exe]` to sit
  // directly in `resources/chrome/`.
  for (const entry of readdirSync(containingDir)) {
    cpSync(join(containingDir, entry), join(targetDir, entry), {
      recursive: true,
      force: true,
    });
  }

  // Clean up the cache so the resources dir contains only what ships.
  rmSync(cacheDir, { recursive: true, force: true });

  const exeName =
    process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  const finalPath = join(targetDir, exeName);
  if (!existsSync(finalPath)) {
    throw new Error(
      `Expected chrome-headless-shell binary at ${finalPath} after install.\n` +
        `Got: ${readdirSync(targetDir).join(", ")}`,
    );
  }

  const size = statSync(finalPath).size;
  log(`✓ chrome-headless-shell ready at ${finalPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  log(`✓ Total resources/chrome/ size: ${totalSize(targetDir)} MB`);
}

function totalSize(dir: string): string {
  let sum = 0;
  const stack = [dir];
  while (stack.length) {
    const next = stack.pop()!;
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      const path = join(next, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else sum += statSync(path).size;
    }
  }
  return (sum / 1024 / 1024).toFixed(1);
}

// `basename` is imported eagerly so future debug logging can pick it up.
void basename;

main().catch((err) => {
  console.error("[hf-desktop] prepare-chromium failed:", err);
  process.exit(1);
});
