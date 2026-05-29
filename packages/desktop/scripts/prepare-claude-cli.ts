/**
 * Copy the `claude` CLI binary (from @anthropic-ai/claude-agent-sdk's
 * platform-specific optional dep) into `resources/claude/`.
 *
 * The Agent SDK ships the binary as a per-platform package (e.g.
 * `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`). When the CLI is
 * single-file-compiled via `bun --compile`, those optional deps are
 * `--external`'d (their native code can't survive the virtual fs), so the
 * SDK's default resolver fails with:
 *
 *   Error: Native CLI binary for win32-x64 not found.
 *   ... or set options.pathToClaudeCodeExecutable.
 *
 * The desktop sidecar sets `HYPERFRAMES_CLAUDE_CLI_PATH` to point at this
 * bundled binary; `agentLoop.ts` reads it and passes it to the SDK via
 * `options.pathToClaudeCodeExecutable`.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";
import { RESOURCES_DIR, REPO_ROOT, log } from "./_shared.ts";

const PLATFORM_KEY = (() => {
  if (process.platform === "win32" && process.arch === "x64") return "win32-x64";
  if (process.platform === "win32" && process.arch === "arm64") return "win32-arm64";
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "darwin-x64";
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "linux-arm64";
  throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
})();

const BINARY_NAME = process.platform === "win32" ? "claude.exe" : "claude";

async function main(): Promise<void> {
  const pkgName = `@anthropic-ai/claude-agent-sdk-${PLATFORM_KEY}`;
  log(`Looking for ${pkgName}…`);

  // Bun's nested node_modules layout puts the actual package under
  // `node_modules/.bun/<scope>+<name>@<version>/node_modules/<scope>/<name>/`.
  // We resolve via Node's require.resolve so it works regardless of which
  // package manager populated node_modules (bun, pnpm, npm).
  const { createRequire } = await import("node:module");
  const require_ = createRequire(join(REPO_ROOT, "package.json"));

  let sourceBinary: string | null = null;
  try {
    // We can't `require.resolve(pkgName)` directly because the optional dep
    // has no exports field; resolve its package.json then point at the binary
    // next to it.
    const pkgJsonPath = require_.resolve(`${pkgName}/package.json`);
    sourceBinary = join(resolve(pkgJsonPath, ".."), BINARY_NAME);
  } catch {
    // require.resolve failed — fall back to scanning .bun directly. Bun's
    // workspace layout doesn't always expose optional deps via the parent
    // node_modules symlink.
    sourceBinary = findInBunCache(pkgName, BINARY_NAME);
  }

  if (!sourceBinary || !existsSync(sourceBinary)) {
    throw new Error(
      `Could not locate ${BINARY_NAME} from ${pkgName}. ` +
        `Run 'bun install' from the repo root and verify the optional dep was fetched.`,
    );
  }

  const targetDir = resolve(RESOURCES_DIR, "claude");
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(targetDir, { recursive: true });

  const targetBinary = join(targetDir, BINARY_NAME);
  cpSync(sourceBinary, targetBinary, { force: true });

  if (process.platform !== "win32") {
    chmodSync(targetBinary, 0o755);
  }

  const size = statSync(targetBinary).size;
  log(`✓ Bundled ${BINARY_NAME} → ${targetBinary} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

function findInBunCache(pkgName: string, binary: string): string | null {
  const bunCache = resolve(REPO_ROOT, "node_modules", ".bun");
  if (!existsSync(bunCache)) return null;
  // Scoped packages have `+` separators in bun's cache directory names.
  const cacheDirPrefix = pkgName.replace(/\//g, "+").replace(/^@/, "@");
  try {
    for (const entry of readdirSync(bunCache)) {
      if (!entry.startsWith(cacheDirPrefix)) continue;
      const candidate = resolve(bunCache, entry, "node_modules", pkgName, binary);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    /* fall through */
  }
  return null;
}

main().catch((err) => {
  console.error("[hf-desktop] prepare-claude-cli failed:", err);
  process.exit(1);
});
