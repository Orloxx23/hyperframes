/**
 * Detects which auth path the in-Studio agent can use.
 *
 * Two routes:
 *  - **Claude Code subscription** (preferred). Requires the `claude` CLI on
 *    PATH and the credentials store populated (the user ran `claude /login`
 *    once). Billing then comes from the user's Pro/Max subscription. This
 *    is the Pencil / Cursor pattern.
 *  - **API key**. Fallback for users without a Claude subscription, or for
 *    CI/headless environments. Pegged at `~/.hyperframes/credentials.json`
 *    or the `ANTHROPIC_API_KEY` env var (see `credentials.ts`).
 *
 * IMPORTANT: This module does NOT decode or read the Claude Code
 * credentials file. The on-disk format is undocumented and we treat it as
 * opaque. We check for *existence* only — actual auth happens through the
 * Agent SDK reading the env on its own.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import { homedir } from "node:os";
import { isAnthropicConfigured } from "./credentials.js";

export type AuthSource = "claude-code" | "api-key" | "none";

export interface AuthStatus {
  /** The route the agent will use on the next call. */
  preferredSource: AuthSource;
  claudeCode: {
    /** `claude` binary is on PATH. */
    cliInstalled: boolean;
    /** Credentials file present. On macOS this is unreliable (Keychain). */
    credentialsLikelyPresent: boolean;
    /** True when both signals look good — best-effort. */
    ready: boolean;
    /** Override env var location, useful for the UI to show diagnostics. */
    configDir: string;
    /** Resolved absolute path to the binary if we found one. */
    cliPath?: string;
  };
  apiKey: { configured: boolean };
}

function isMacOS(): boolean {
  return process.platform === "darwin";
}

function isWindows(): boolean {
  return process.platform === "win32";
}

function getClaudeConfigDir(): string {
  // Claude Code honors CLAUDE_CONFIG_DIR on Linux + Windows; macOS uses
  // Keychain primarily. We surface the path regardless so the UI can hint.
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override) return override;
  return join(homedir(), ".claude");
}

/**
 * Walks PATH looking for an executable named `claude` (or `claude.cmd` /
 * `claude.exe` / `claude.ps1` on Windows). Returns the first match.
 */
function findOnPath(name: string): string | null {
  const PATH = process.env.PATH ?? "";
  const segments = PATH.split(delimiter).filter(Boolean);
  const exts = isWindows()
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";").map((e) => e.toLowerCase())
    : [""];
  for (const seg of segments) {
    for (const ext of exts) {
      const candidate = join(seg, `${name}${ext}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        /* permission errors etc — try next */
      }
    }
  }
  return null;
}

/**
 * Best-effort search beyond `$PATH`. Covers the common install layouts
 * we've seen in the wild (winget, npm-global, bun, Homebrew, native
 * installer). Cheap on cold start — just `existsSync` probes.
 */
function findClaudeBinary(): string | null {
  // 1. User override — escape hatch when our detection can't find the
  // binary because of a PATH that isn't inherited by this process
  // (e.g. winget updated PATH after the server was launched).
  const override = process.env.HYPERFRAMES_CLAUDE_PATH;
  if (override && existsSync(override)) return override;

  // 2. PATH walk — fastest path when the env is already correct.
  const fromPath = findOnPath("claude");
  if (fromPath) return fromPath;

  // 3. Well-known install locations. These keep working even when the
  // launching shell missed a PATH refresh.
  const candidates: string[] = [];
  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    if (localAppData) {
      // winget — exact subdirectory varies by version, so we glob via
      // synchronous readdir below. Keep the parent here for the glob step.
      candidates.push(join(localAppData, "Programs", "claude", "claude.exe"));
      candidates.push(join(localAppData, "Programs", "@anthropic-ai", "claude-code", "claude.exe"));
    }
    if (appData) {
      candidates.push(join(appData, "npm", "claude.cmd"));
      candidates.push(join(appData, "npm", "claude.ps1"));
    }
    candidates.push(join(homedir(), ".bun", "bin", "claude.exe"));
    candidates.push(join(homedir(), ".claude", "local", "claude.exe"));
  } else {
    candidates.push("/usr/local/bin/claude");
    candidates.push("/opt/homebrew/bin/claude");
    candidates.push(join(homedir(), ".bun", "bin", "claude"));
    candidates.push(join(homedir(), ".npm-global", "bin", "claude"));
    candidates.push(join(homedir(), ".claude", "local", "claude"));
  }

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // 4. winget on Windows installs under a per-package directory with
  // a publisher-specific suffix. Scan the parent and look for any
  // `Anthropic.ClaudeCode_*/claude.exe`.
  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const wingetRoot = join(localAppData, "Microsoft", "WinGet", "Packages");
      try {
        if (existsSync(wingetRoot)) {
          for (const entry of readdirSync(wingetRoot)) {
            if (entry.startsWith("Anthropic.ClaudeCode_")) {
              const probe = join(wingetRoot, entry, "claude.exe");
              if (existsSync(probe)) return probe;
            }
          }
        }
      } catch {
        /* ignore — winget dir missing */
      }
    }
  }

  // 5. Ask the user's shell. `where` / `which` see the shell's live PATH
  // even when this process inherited a stale one. Fail silently.
  try {
    const cmd = isWindows() ? "where.exe" : "which";
    const out = execFileSync(cmd, ["claude"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    if (first && existsSync(first)) return first;
  } catch {
    /* not found via shell either */
  }

  return null;
}

function findClaudeCli(): { installed: boolean; path?: string } {
  const path = findClaudeBinary();
  return path ? { installed: true, path } : { installed: false };
}

function claudeCredentialsLikelyPresent(): boolean {
  const configDir = getClaudeConfigDir();
  const credsFile = join(configDir, ".credentials.json");
  if (existsSync(credsFile)) return true;
  // Some installs store under a slightly different layout — also probe a
  // couple of well-known siblings the SDK / CLI consult on Linux/Win.
  if (existsSync(join(configDir, "settings.json"))) {
    // Settings doesn't prove auth, but its presence + bin install often
    // implies a healthy install. Keychain users on Mac will hit this path.
    if (isMacOS()) return true;
  }
  return false;
}

export function detectAuthStatus(): AuthStatus {
  const cli = findClaudeCli();
  const credsLikely = cli.installed && claudeCredentialsLikelyPresent();
  const apiKeyConfigured = isAnthropicConfigured();
  // On macOS we can't introspect the Keychain entry from here. If the CLI
  // is installed we *optimistically* assume the user is logged in; the
  // Agent SDK will surface an auth error on first query if not.
  const ready = cli.installed && (credsLikely || isMacOS());

  let preferredSource: AuthSource = "none";
  if (ready) preferredSource = "claude-code";
  else if (apiKeyConfigured) preferredSource = "api-key";

  return {
    preferredSource,
    claudeCode: {
      cliInstalled: cli.installed,
      credentialsLikelyPresent: credsLikely,
      ready,
      configDir: getClaudeConfigDir() + sep,
      ...(cli.path ? { cliPath: cli.path } : {}),
    },
    apiKey: { configured: apiKeyConfigured },
  };
}
