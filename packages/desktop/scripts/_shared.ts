/**
 * Shared helpers for the desktop prepare scripts. These run from the
 * `packages/desktop` working directory.
 */

import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const DESKTOP_ROOT = resolve(HERE, "..");
export const REPO_ROOT = resolve(DESKTOP_ROOT, "..", "..");
// Tauri resolves `externalBin` and `resources` paths relative to `src-tauri/`,
// so the artifact directories live there too.
export const SRC_TAURI = resolve(DESKTOP_ROOT, "src-tauri");
export const RESOURCES_DIR = resolve(SRC_TAURI, "resources");
export const BINARIES_DIR = resolve(SRC_TAURI, "binaries");

export type TauriTriple =
  | "x86_64-pc-windows-msvc"
  | "aarch64-pc-windows-msvc"
  | "x86_64-apple-darwin"
  | "aarch64-apple-darwin"
  | "x86_64-unknown-linux-gnu"
  | "aarch64-unknown-linux-gnu";

export interface TargetInfo {
  triple: TauriTriple;
  bunTarget: string;
  os: "windows" | "darwin" | "linux";
  arch: "x64" | "arm64";
  ext: "" | ".exe";
}

export function currentTarget(): TargetInfo {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "win32" && arch === "x64") {
    return {
      triple: "x86_64-pc-windows-msvc",
      bunTarget: "bun-windows-x64",
      os: "windows",
      arch: "x64",
      ext: ".exe",
    };
  }
  if (platform === "darwin" && arch === "arm64") {
    return {
      triple: "aarch64-apple-darwin",
      bunTarget: "bun-darwin-arm64",
      os: "darwin",
      arch: "arm64",
      ext: "",
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      triple: "x86_64-apple-darwin",
      bunTarget: "bun-darwin-x64",
      os: "darwin",
      arch: "x64",
      ext: "",
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      triple: "x86_64-unknown-linux-gnu",
      bunTarget: "bun-linux-x64",
      os: "linux",
      arch: "x64",
      ext: "",
    };
  }
  if (platform === "linux" && arch === "arm64") {
    return {
      triple: "aarch64-unknown-linux-gnu",
      bunTarget: "bun-linux-arm64",
      os: "linux",
      arch: "arm64",
      ext: "",
    };
  }
  throw new Error(`Unsupported platform: ${platform}/${arch}`);
}

export function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

export function log(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.log("[hf-desktop]", ...args);
}
