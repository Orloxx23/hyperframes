/**
 * Credentials storage for the in-Studio AI chat and stock media providers.
 *
 * Persists API keys to `~/.hyperframes/credentials.json` with chmod 0o600
 * (best-effort — no-op on Windows). This is the same security posture as
 * `~/.aws/credentials` or `~/.npmrc`: local filesystem with restrictive
 * permissions, not OS-keychain. For a hardened desktop build, swap for
 * `keytar` (native module).
 *
 * The server is the only reader/writer — credentials never reach the
 * browser. Routes return masked info (`{configured: true}`), not the key.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(homedir(), ".hyperframes");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json");

export type AiProvider = "anthropic";
export type StockProvider = "pexels" | "unsplash" | "pixabay";
export type Provider = AiProvider | StockProvider;

export const STOCK_PROVIDERS: StockProvider[] = ["pexels", "unsplash", "pixabay"];

interface StoredEntry {
  apiKey: string;
  addedAt: string;
}

export interface CredentialsFile {
  anthropic?: StoredEntry;
  pexels?: StoredEntry;
  unsplash?: StoredEntry;
  pixabay?: StoredEntry;
}

const STOCK_ENV_VARS: Record<StockProvider, string[]> = {
  pexels: ["PEXELS_API_KEY"],
  unsplash: ["UNSPLASH_ACCESS_KEY", "UNSPLASH_API_KEY"],
  pixabay: ["PIXABAY_API_KEY"],
};

function readCredentialsFile(): CredentialsFile {
  if (!existsSync(CREDENTIALS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf-8")) as CredentialsFile;
  } catch {
    return {};
  }
}

function writeCredentialsFile(creds: CredentialsFile): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), "utf-8");
  try {
    chmodSync(CREDENTIALS_FILE, 0o600);
  } catch {
    /* ignore — non-POSIX FS */
  }
}

function readEnvKey(names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

// ── Anthropic ─────────────────────────────────────────────────────────────

export function getAnthropicApiKey(): string | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return readCredentialsFile().anthropic?.apiKey ?? null;
}

export function isAnthropicConfigured(): boolean {
  return getAnthropicApiKey() !== null;
}

export function setAnthropicApiKey(apiKey: string): void {
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith("sk-ant-")) {
    throw new Error('Anthropic API keys start with "sk-ant-". Check the value.');
  }
  const creds = readCredentialsFile();
  creds.anthropic = { apiKey: trimmed, addedAt: new Date().toISOString() };
  writeCredentialsFile(creds);
}

export function clearAnthropicApiKey(): void {
  clearProviderKey("anthropic");
}

// ── Stock providers ───────────────────────────────────────────────────────

export function getStockApiKey(provider: StockProvider): string | null {
  const fromEnv = readEnvKey(STOCK_ENV_VARS[provider]);
  if (fromEnv) return fromEnv;
  return readCredentialsFile()[provider]?.apiKey ?? null;
}

export function setStockApiKey(provider: StockProvider, apiKey: string): void {
  const trimmed = apiKey.trim();
  if (trimmed.length < 8) {
    throw new Error(`${provider} API key looks too short — paste the full value.`);
  }
  const creds = readCredentialsFile();
  creds[provider] = { apiKey: trimmed, addedAt: new Date().toISOString() };
  writeCredentialsFile(creds);
}

export function clearStockApiKey(provider: StockProvider): void {
  clearProviderKey(provider);
}

function clearProviderKey(provider: Provider): void {
  const creds = readCredentialsFile();
  if (!(provider in creds)) return;
  delete creds[provider];
  if (Object.keys(creds).length === 0) {
    try {
      unlinkSync(CREDENTIALS_FILE);
    } catch {
      /* ignore */
    }
    return;
  }
  writeCredentialsFile(creds);
}

// ── Status payload ────────────────────────────────────────────────────────

export type CredentialSource = "env" | "file" | "none";

export interface ProviderStatus {
  configured: boolean;
  source: CredentialSource;
  addedAt?: string;
}

export interface CredentialsStatus {
  anthropic: ProviderStatus;
  pexels: ProviderStatus;
  unsplash: ProviderStatus;
  pixabay: ProviderStatus;
}

function statusForAnthropic(creds: CredentialsFile): ProviderStatus {
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return { configured: true, source: "env" };
  }
  if (creds.anthropic) {
    return { configured: true, source: "file", addedAt: creds.anthropic.addedAt };
  }
  return { configured: false, source: "none" };
}

function statusForStock(provider: StockProvider, creds: CredentialsFile): ProviderStatus {
  if (readEnvKey(STOCK_ENV_VARS[provider])) {
    return { configured: true, source: "env" };
  }
  const entry = creds[provider];
  if (entry) {
    return { configured: true, source: "file", addedAt: entry.addedAt };
  }
  return { configured: false, source: "none" };
}

export function getCredentialsStatus(): CredentialsStatus {
  const creds = readCredentialsFile();
  return {
    anthropic: statusForAnthropic(creds),
    pexels: statusForStock("pexels", creds),
    unsplash: statusForStock("unsplash", creds),
    pixabay: statusForStock("pixabay", creds),
  };
}
