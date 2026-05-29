/**
 * Settings → Stock media tab.
 *
 * Lets the user paste API keys for Pexels, Unsplash, and Pixabay so the
 * agent can search and download stock photos/videos. Keys live on disk
 * (`~/.hyperframes/credentials.json`) — the UI only ever sees whether a
 * key is configured, never the value.
 *
 * Extracted from SettingsModal.tsx so each file stays under the 600 LOC
 * budget enforced by the lefthook filesize check.
 */

import { useState } from "react";
import type { AuthStatus } from "../../hooks/useAgentChat";

type StockProviderId = "pexels" | "unsplash" | "pixabay";

interface StockProviderInfo {
  id: StockProviderId;
  title: string;
  subtitle: string;
  signupUrl: string;
  signupLabel: string;
  supports: string;
}

const STOCK_PROVIDER_INFO: StockProviderInfo[] = [
  {
    id: "pexels",
    title: "Pexels",
    subtitle: "Photos and videos",
    signupUrl: "https://www.pexels.com/api/",
    signupLabel: "pexels.com/api",
    supports: "Photo + Video",
  },
  {
    id: "unsplash",
    title: "Unsplash",
    subtitle: "Photos",
    signupUrl: "https://unsplash.com/developers",
    signupLabel: "unsplash.com/developers",
    supports: "Photo",
  },
  {
    id: "pixabay",
    title: "Pixabay",
    subtitle: "Photos and videos",
    signupUrl: "https://pixabay.com/api/docs/",
    signupLabel: "pixabay.com/api/docs",
    supports: "Photo + Video",
  },
];

export interface StockMediaSectionProps {
  status: AuthStatus | null;
  onSaveStockKey: (
    provider: StockProviderId,
    apiKey: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onClearStockKey: (provider: StockProviderId) => Promise<void>;
}

export function StockMediaSection({
  status,
  onSaveStockKey,
  onClearStockKey,
}: StockMediaSectionProps) {
  return (
    <div className="grid grid-cols-1 gap-2">
      {STOCK_PROVIDER_INFO.map((info) => (
        <StockKeyRow
          key={info.id}
          info={info}
          status={status?.stockMedia?.[info.id]}
          onSave={(apiKey) => onSaveStockKey(info.id, apiKey)}
          onClear={() => onClearStockKey(info.id)}
        />
      ))}
    </div>
  );
}

function StockKeyRow({
  info,
  status,
  onSave,
  onClear,
}: {
  info: StockProviderInfo;
  status?: { configured: boolean; source: "env" | "file" | "none"; addedAt?: string };
  onSave: (apiKey: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onClear: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configured = status?.configured ?? false;
  const fromEnv = status?.source === "env";

  const handleSave = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError("Paste your API key first.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await onSave(trimmed);
    setSubmitting(false);
    if (result.ok) {
      setApiKey("");
      setExpanded(false);
    } else {
      setError(result.error);
    }
  };

  const handleClear = async () => {
    await onClear();
    setApiKey("");
    setExpanded(false);
  };

  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/30">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-neutral-100">{info.title}</span>
            <span className="text-[10px] text-neutral-500">{info.supports}</span>
            {configured ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-950/40 text-emerald-300 border border-emerald-900/50">
                ● {fromEnv ? "Env var" : "Connected"}
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-neutral-900 text-neutral-500 border border-neutral-800">
                Not connected
              </span>
            )}
          </div>
          <div className="text-[10px] text-neutral-500 mt-0.5 truncate">
            Get a key at{" "}
            <a
              href={info.signupUrl}
              target="_blank"
              rel="noreferrer"
              className="text-studio-accent hover:underline"
            >
              {info.signupLabel}
            </a>
          </div>
        </div>
        {fromEnv ? (
          <span className="text-[10px] text-neutral-500">via env var</span>
        ) : configured ? (
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-[11px] text-neutral-400 hover:text-neutral-200"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              className="text-[11px] text-emerald-300 hover:text-emerald-100 underline"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="h-7 px-2.5 rounded-md text-[11px] font-medium border border-neutral-800 text-neutral-300 hover:bg-neutral-900 hover:border-neutral-700 flex-shrink-0"
          >
            {expanded ? "Cancel" : "Add key"}
          </button>
        )}
      </div>

      {expanded && !fromEnv && (
        <div className="px-3 pb-3 space-y-2 border-t border-neutral-800/60">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSave();
            }}
            placeholder={`Paste your ${info.title} API key`}
            autoComplete="off"
            spellCheck={false}
            className="w-full h-8 px-2.5 rounded-md bg-neutral-950 border border-neutral-800 text-[12px] font-mono text-neutral-100 placeholder-neutral-600 focus:border-studio-accent focus:outline-none"
            disabled={submitting}
          />
          {error && (
            <div className="rounded-md border border-red-900/50 bg-red-950/40 px-2.5 py-1.5 text-[11px] text-red-300">
              {error}
            </div>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={submitting || !apiKey.trim()}
              className="h-7 px-3 rounded-md text-[11px] font-medium bg-studio-accent text-neutral-950 hover:bg-studio-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
