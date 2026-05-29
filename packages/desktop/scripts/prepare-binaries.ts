/**
 * Compile the `hyperframes` CLI as a single-file native binary via `bun --compile`.
 *
 * The output is named with a Tauri-compatible triple suffix
 * (`hyperframes-x86_64-pc-windows-msvc.exe`) so Tauri's sidecar plumbing can
 * pick the right binary per platform during bundling.
 *
 * Native modules (`sharp`, `onnxruntime-node`) are kept `--external` because
 * their platform-specific `.node` files can't survive the bun virtual fs.
 * The desktop app never invokes the codepaths that need them (snapshot,
 * background-removal), so this is safe — see contactSheet.ts for the
 * matching lazy-import refactor.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BINARIES_DIR, REPO_ROOT, currentTarget, ensureDir, log } from "./_shared.ts";

async function main(): Promise<void> {
  const target = currentTarget();
  log(`Compiling CLI for ${target.triple} (${target.bunTarget})`);

  ensureDir(BINARIES_DIR);

  const cliEntry = resolve(REPO_ROOT, "packages", "cli", "dist", "cli.js");
  if (!existsSync(cliEntry)) {
    throw new Error(
      `CLI bundle not found at ${cliEntry}. Run 'bun run --filter @hyperframes/cli build' from the repo root first.`,
    );
  }

  const outName = `hyperframes-${target.triple}${target.ext}`;
  const outPath = resolve(BINARIES_DIR, outName);

  const args = [
    "build",
    cliEntry,
    "--compile",
    "--external",
    "sharp",
    "--external",
    "onnxruntime-node",
    "--external",
    "@img/*",
    `--target=${target.bunTarget}`,
    "--outfile",
    outPath,
  ];

  log(`bun ${args.join(" ")}`);
  const result = spawnSync("bun", args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    throw new Error(`bun --compile failed with exit code ${result.status}`);
  }

  if (!existsSync(outPath)) {
    throw new Error(`Expected output not produced: ${outPath}`);
  }

  const size = statSync(outPath).size;
  log(`✓ Built ${outName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch((err) => {
  console.error("[hf-desktop] prepare-binaries failed:", err);
  process.exit(1);
});
