import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { downloadFile } from "../utils/download.js";

const MODELS_DIR = join(homedir(), ".cache", "hyperframes", "whisper", "models");
const PREBUILT_DIR = join(homedir(), ".cache", "hyperframes", "whisper", "prebuilt");
const DEFAULT_MODEL = "small.en";

export type WhisperSource = "env" | "system" | "brew" | "build" | "prebuilt";

export interface WhisperResult {
  executablePath: string;
  source: WhisperSource;
}

function getModelUrl(model: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
}

// --- Find helpers -----------------------------------------------------------

function whichBinary(name: string): string | undefined {
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const output = execFileSync(cmd, [name], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    const first = output
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return first || undefined;
  } catch {
    return undefined;
  }
}

function findFromEnv(): WhisperResult | undefined {
  const envPath = process.env["HYPERFRAMES_WHISPER_PATH"];
  if (envPath && existsSync(envPath)) {
    return { executablePath: envPath, source: "env" };
  }
  return undefined;
}

function findFromSystem(): WhisperResult | undefined {
  for (const name of ["whisper-cli", "whisper"]) {
    const path = whichBinary(name);
    if (path) return { executablePath: path, source: "system" };
  }

  // Check brew paths directly on macOS
  if (platform() === "darwin") {
    for (const p of ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"]) {
      if (existsSync(p)) return { executablePath: p, source: "system" };
    }
  }

  return undefined;
}

// --- Pre-built binary (Windows) ---------------------------------------------

const WHISPER_EXE = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

function findBinaryRecursive(dir: string, filename: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur) continue;
    let entries: import("node:fs").Dirent[] = [];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === filename) return p;
    }
  }
  return undefined;
}

function findFromPrebuilt(): WhisperResult | undefined {
  const p = findBinaryRecursive(PREBUILT_DIR, WHISPER_EXE);
  return p ? { executablePath: p, source: "prebuilt" } : undefined;
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

interface GhRelease {
  tag_name: string;
  assets: GhAsset[];
}

/**
 * Follow redirects and fetch JSON. Used for the GitHub releases API which
 * sometimes redirects authenticated requests. Sets a UA header because
 * GitHub rejects requests without one.
 */
function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const follow = (u: string, depth: number) => {
      if (depth > 5) {
        reject(new Error(`too many redirects fetching ${url}`));
        return;
      }
      const parsed = new URL(u);
      httpsGet(
        {
          hostname: parsed.hostname,
          path: `${parsed.pathname}${parsed.search}`,
          headers: {
            "User-Agent": "hyperframes-cli",
            Accept: "application/vnd.github+json",
          },
        },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            const location = res.headers.location;
            if (location) {
              follow(location, depth + 1);
              return;
            }
          }
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned HTTP ${res.statusCode} for ${u}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T);
            } catch (e) {
              reject(
                new Error(
                  `failed to parse GitHub API response: ${e instanceof Error ? e.message : e}`,
                ),
              );
            }
          });
        },
      ).on("error", (err) => reject(err));
    };
    follow(url, 0);
  });
}

/**
 * Pick the best Windows pre-built asset from a whisper.cpp release. We
 * prefer the plain CPU build (`whisper-bin-x64.zip`) over BLAS / CUDA
 * variants — those depend on additional runtimes the user may not have.
 */
function pickWindowsAsset(release: GhRelease): GhAsset | undefined {
  const patterns = [
    /^whisper-bin-x64\.zip$/i,
    /^whisper-blas-bin-x64\.zip$/i,
    /^whisper-bin-Win32\.zip$/i,
  ];
  for (const re of patterns) {
    const match = release.assets.find((a) => re.test(a.name));
    if (match) return match;
  }
  return undefined;
}

/**
 * Download and extract the official whisper.cpp pre-built Windows binary.
 * Avoids the need for git + cmake + a C++ compiler. The release is fetched
 * from GitHub's API so we always grab the latest published binary.
 */
async function downloadPrebuiltWindows(onProgress?: (msg: string) => void): Promise<WhisperResult> {
  onProgress?.("Fetching latest whisper.cpp release...");
  const release = await fetchJson<GhRelease>(
    "https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest",
  );
  const asset = pickWindowsAsset(release);
  if (!asset) {
    throw new Error(
      `no compatible Windows pre-built found in release ${release.tag_name}. ` +
        `Set HYPERFRAMES_WHISPER_PATH to a manually-installed whisper-cli.exe.`,
    );
  }

  mkdirSync(PREBUILT_DIR, { recursive: true });
  const zipPath = join(PREBUILT_DIR, asset.name);
  onProgress?.(`Downloading ${asset.name} (${release.tag_name})...`);
  await downloadFile(asset.browser_download_url, zipPath);

  onProgress?.("Extracting...");
  try {
    // PowerShell's Expand-Archive ships with every supported Windows version
    // — no need for the user to have 7-Zip or another tool installed.
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${PREBUILT_DIR.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
  } catch (err) {
    let detail = "";
    if (err && typeof err === "object" && "stderr" in err) {
      const stderr = String(err.stderr).trim();
      if (stderr) detail = `\n${stderr.slice(-500)}`;
    }
    throw new Error(`failed to extract ${asset.name}${detail}`);
  } finally {
    try {
      unlinkSync(zipPath);
    } catch {
      /* best-effort cleanup */
    }
  }

  const result = findFromPrebuilt();
  if (!result) {
    throw new Error(
      `extracted ${asset.name} but ${WHISPER_EXE} was not found inside. The release format may have changed.`,
    );
  }
  return result;
}

// --- Build from source ------------------------------------------------------

const BUILD_DIR = join(homedir(), ".cache", "hyperframes", "whisper", "whisper.cpp");
const WHISPER_REPO = "https://github.com/ggml-org/whisper.cpp.git";

function findBuiltBinary(): WhisperResult | undefined {
  for (const p of [
    join(BUILD_DIR, "build", "bin", "whisper-cli"),
    join(BUILD_DIR, "build", "whisper-cli"),
  ]) {
    if (existsSync(p)) return { executablePath: p, source: "build" };
  }
  return undefined;
}

function buildFromSource(onProgress?: (msg: string) => void): WhisperResult {
  // Clean stale builds — if BUILD_DIR exists but has no binary, nuke and re-clone
  if (existsSync(BUILD_DIR) && !findBuiltBinary()) {
    rmSync(BUILD_DIR, { recursive: true, force: true });
  }

  if (!existsSync(BUILD_DIR)) {
    onProgress?.("Downloading whisper.cpp...");
    mkdirSync(join(homedir(), ".cache", "hyperframes", "whisper"), {
      recursive: true,
    });
    execFileSync("git", ["clone", "--depth", "1", WHISPER_REPO, BUILD_DIR], {
      stdio: "ignore",
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  }

  onProgress?.("Building whisper.cpp (this may take a minute)...");
  try {
    execFileSync("cmake", ["-B", "build"], {
      cwd: BUILD_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    execFileSync("cmake", ["--build", "build", "--config", "Release", "-j"], {
      cwd: BUILD_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
    });
  } catch (err: unknown) {
    // Build failed — capture diagnostics, then clean up so next attempt starts fresh
    let detail = "";
    if (err && typeof err === "object" && "stderr" in err) {
      const stderr = String(err.stderr).trim();
      if (stderr) detail = `\n${stderr.slice(-500)}`;
    }
    rmSync(BUILD_DIR, { recursive: true, force: true });
    throw new Error(
      `whisper-cpp build failed. Ensure cmake and a C compiler are installed.${detail}`,
    );
  }

  const result = findBuiltBinary();
  if (!result) throw new Error("Build completed but whisper-cli not found");
  return result;
}

// --- Public API -------------------------------------------------------------

export function findWhisper(): WhisperResult | undefined {
  return findFromEnv() ?? findFromSystem() ?? findFromPrebuilt() ?? findBuiltBinary();
}

function getInstallInstructions(): string {
  if (platform() === "darwin") {
    return "brew install whisper-cpp";
  }
  if (platform() === "win32") {
    return (
      "Hyperframes auto-downloads whisper.cpp's pre-built Windows binary on first " +
      "use — if that failed, manually download the latest `whisper-bin-x64.zip` " +
      "from https://github.com/ggml-org/whisper.cpp/releases, extract it, and " +
      "set HYPERFRAMES_WHISPER_PATH to the whisper-cli.exe inside."
    );
  }
  return "See https://github.com/ggml-org/whisper.cpp#building";
}

function hasBrew(): boolean {
  return whichBinary("brew") !== undefined;
}

function hasGit(): boolean {
  return whichBinary("git") !== undefined;
}

function hasCmake(): boolean {
  return whichBinary("cmake") !== undefined;
}

export async function ensureWhisper(options?: {
  onProgress?: (msg: string) => void;
}): Promise<WhisperResult> {
  // 1. Already installed?
  const existing = findWhisper();
  if (existing) return existing;

  // Track the diagnostic reasons each install path failed so the final error
  // can tell the user what actually went wrong (the old code swallowed every
  // failure and surfaced a generic "not found" message).
  const failures: string[] = [];

  // 2a. Windows: download official pre-built binary. Avoids the
  // git + cmake + MSVC chain entirely. This is almost always what a
  // Windows user wants — much faster and more reliable than building.
  if (platform() === "win32") {
    try {
      return await downloadPrebuiltWindows(options?.onProgress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`pre-built download: ${msg}`);
      options?.onProgress?.(`Pre-built download failed (${msg}). Trying source build...`);
    }
  }

  // 2b. macOS: try brew (fastest — pre-built bottle)
  if (platform() === "darwin" && hasBrew()) {
    options?.onProgress?.("Installing whisper-cpp via Homebrew...");
    try {
      execFileSync("brew", ["install", "whisper-cpp"], {
        stdio: "ignore",
        timeout: 300_000,
      });
      const installed = findFromSystem();
      if (installed) return { ...installed, source: "brew" };
      failures.push("brew install succeeded but whisper-cli not on PATH after");
    } catch (err) {
      failures.push(`brew install: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Build from source (needs git + cmake + C compiler)
  if (!hasGit()) failures.push("git is not installed");
  else if (!hasCmake()) failures.push("cmake is not installed");
  else {
    try {
      return buildFromSource(options?.onProgress);
    } catch (err) {
      failures.push(`source build: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Give up — tell the user how
  throw new Error(
    `whisper-cpp not found and all install paths failed:\n  - ${failures.join("\n  - ")}\n\n${getInstallInstructions()}`,
  );
}

export async function ensureModel(
  model: string = DEFAULT_MODEL,
  options?: { onProgress?: (message: string) => void },
): Promise<string> {
  const modelPath = join(MODELS_DIR, `ggml-${model}.bin`);
  if (existsSync(modelPath)) return modelPath;

  mkdirSync(MODELS_DIR, { recursive: true });

  options?.onProgress?.(`Downloading model ${model}...`);
  await downloadFile(getModelUrl(model), modelPath);

  if (!existsSync(modelPath)) {
    throw new Error(`Model download failed: ${model}`);
  }

  return modelPath;
}

export function hasFFmpeg(): boolean {
  return hasBinary("ffmpeg");
}

export function hasFFprobe(): boolean {
  return hasBinary("ffprobe");
}

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ["-version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export { MODELS_DIR, DEFAULT_MODEL };
