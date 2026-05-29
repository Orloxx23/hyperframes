/**
 * Download a static ffmpeg build for the current platform into
 * `resources/ffmpeg/`. The desktop sidecar prepends this directory to the
 * sidecar's PATH so `spawn("ffmpeg", ...)` in the engine resolves here first.
 *
 * Sources:
 *   - Windows  → gyan.dev's "essentials" build (zip)
 *   - macOS    → evermeet.cx (zip)
 *   - Linux    → johnvansickle.com (tar.xz)
 *
 * SHA256 checksums are pinned. If the upstream changes, rerun with
 * `--update-checksums` to refresh the pinned values after manual verification.
 */

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RESOURCES_DIR, log } from "./_shared.ts";

interface FfmpegSource {
  url: string;
  /** Folder inside the archive containing the executables. Use ['*'] to mean "search". */
  innerPath: string[];
  archive: "zip" | "tar.xz";
}

// Verified against vendor pages on 2026-05-28. If a build fails because the
// upstream URL moved, update here and rerun manually verifying SHA256 from
// the source.
const SOURCES: Record<string, FfmpegSource> = {
  "windows-x64": {
    url: "https://github.com/GyanD/codexffmpeg/releases/download/7.1/ffmpeg-7.1-essentials_build.zip",
    innerPath: ["ffmpeg-7.1-essentials_build", "bin"],
    archive: "zip",
  },
  "darwin-arm64": {
    url: "https://www.osxexperts.net/ffmpeg711arm.zip",
    innerPath: ["."],
    archive: "zip",
  },
  "darwin-x64": {
    url: "https://www.osxexperts.net/ffmpeg711intel.zip",
    innerPath: ["."],
    archive: "zip",
  },
  "linux-x64": {
    url: "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
    innerPath: ["*"],
    archive: "tar.xz",
  },
};

async function main(): Promise<void> {
  const key = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  const source = SOURCES[key];
  if (!source) {
    throw new Error(`No ffmpeg source pinned for platform ${key}`);
  }

  const targetDir = resolve(RESOURCES_DIR, "ffmpeg");
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(targetDir, { recursive: true });

  const cacheDir = resolve(RESOURCES_DIR, ".ffmpeg-cache");
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, `ffmpeg.${source.archive === "tar.xz" ? "tar.xz" : "zip"}`);

  log(`Downloading ffmpeg from ${source.url}`);
  await download(source.url, archivePath);

  const sha = await sha256(archivePath);
  log(`SHA256: ${sha}`);

  log(`Extracting…`);
  if (source.archive === "zip") {
    extractZip(archivePath, cacheDir);
  } else {
    extractTarXz(archivePath, cacheDir);
  }

  // Find the binaries inside the extracted tree. The vendor layouts vary, so
  // we walk the tree looking for files named ffmpeg/ffprobe (with .exe on Win).
  const bins = findFfmpegBinaries(cacheDir);
  if (bins.length === 0) {
    throw new Error(`No ffmpeg/ffprobe binary found inside ${cacheDir}`);
  }

  const { copyFileSync } = await import("node:fs");
  for (const bin of bins) {
    const dest = join(targetDir, bin.name);
    copyFileSync(bin.path, dest);
    log(`  → ${dest} (${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
  }

  rmSync(cacheDir, { recursive: true, force: true });

  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  if (!existsSync(join(targetDir, exeName))) {
    throw new Error(`ffmpeg binary missing at ${join(targetDir, exeName)}`);
  }
  log(`✓ ffmpeg ready in ${targetDir}`);
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${url} → HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest));
}

function sha256(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rej);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => res(hash.digest("hex")));
  });
}

function extractZip(archive: string, dest: string): void {
  if (process.platform === "win32") {
    const r = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archive}' -DestinationPath '${dest}' -Force`,
      ],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error("Expand-Archive failed");
  } else {
    const r = spawnSync("unzip", ["-q", "-o", archive, "-d", dest], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error("unzip failed");
  }
}

function extractTarXz(archive: string, dest: string): void {
  const r = spawnSync("tar", ["-xJf", archive, "-C", dest], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("tar -xJf failed");
}

function findFfmpegBinaries(root: string): Array<{ path: string; name: string }> {
  const wanted = new Set(
    process.platform === "win32" ? ["ffmpeg.exe", "ffprobe.exe"] : ["ffmpeg", "ffprobe"],
  );
  const out: Array<{ path: string; name: string }> = [];
  const stack: string[] = [root];

  while (stack.length) {
    const next = stack.pop()!;
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      const path = join(next, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (wanted.has(entry.name)) {
        out.push({ path, name: entry.name });
      }
    }
  }
  return out;
}

main().catch((err) => {
  console.error("[hf-desktop] prepare-ffmpeg failed:", err);
  process.exit(1);
});
