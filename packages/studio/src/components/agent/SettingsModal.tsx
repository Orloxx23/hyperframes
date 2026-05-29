/**
 * Settings modal for the AI chat panel.
 *
 * Top-level tabs (AI provider / Stock media / Skills) keep the modal from
 * growing vertically when we add more sections. The AI tab nests a
 * provider-grid → provider-detail flow ("← Back" returns to the grid).
 *
 * Extracted out of AgentChatPanel.tsx along with StockMediaSection and the
 * Anthropic auth helpers to keep the chat panel under the 600 LOC budget.
 */

import { useState } from "react";
import type { AuthMode, AuthStatus, CatalogEntry, InstalledSkill } from "../../hooks/useAgentChat";
import { SkillsSection } from "./SkillsSection";
import { StockMediaSection } from "./StockMediaSection";
import { CloseIcon, DiamondIcon, DotsIcon, RefreshIcon, SparkleIcon } from "./icons";

type StockProviderId = "pexels" | "unsplash" | "pixabay";

export interface SettingsModalProps {
  status: AuthStatus | null;
  authMode: AuthMode;
  setAuthMode: (mode: AuthMode) => void;
  onRefresh: () => Promise<AuthStatus | null>;
  onSaveKey: (apiKey: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onClearKey: () => Promise<void>;
  onSaveStockKey: (
    provider: StockProviderId,
    apiKey: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onClearStockKey: (provider: StockProviderId) => Promise<void>;
  listSkills: () => Promise<InstalledSkill[]>;
  setSkillEnabled: (name: string, enabled: boolean) => Promise<InstalledSkill[]>;
  createSkill: (input: {
    name: string;
    description: string;
    body?: string;
  }) => Promise<{ ok: true; skills: InstalledSkill[] } | { ok: false; error: string }>;
  fetchCatalog: () => Promise<CatalogEntry[]>;
  installSkill: (
    slug: string,
  ) => Promise<
    | { ok: true; skills: InstalledSkill[]; output: string }
    | { ok: false; error: string; output: string }
  >;
  onClose: () => void;
}

type SettingsTab = "ai" | "stock" | "skills";

const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: "ai", label: "AI provider" },
  { id: "stock", label: "Stock media" },
  { id: "skills", label: "Skills" },
];

export function SettingsModal(props: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>("ai");
  const [providerOpen, setProviderOpen] = useState<"anthropic" | null>(null);

  const headerCopy: Record<SettingsTab, { title: string; subtitle: string }> = {
    ai: {
      title: "Connect your AI subscription or key",
      subtitle:
        "Hyperframes designs with your Claude agent. Use your existing subscription or an API key — credentials are never shared with us.",
    },
    stock: {
      title: "Stock media providers",
      subtitle:
        "Let the agent search and download stock photos and videos. Paste your own API key per provider.",
    },
    skills: {
      title: "Skills",
      subtitle:
        "Editing styles, runtime helpers, and domain guides for the AI. Install community skills or author your own.",
    },
  };
  const header = headerCopy[tab];
  const isAiDetail = tab === "ai" && providerOpen !== null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="w-full max-w-2xl max-h-[calc(100vh-2rem)] flex flex-col rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl">
        <div className="px-6 py-5 border-b border-neutral-800 flex items-start justify-between flex-shrink-0">
          {isAiDetail ? (
            <button
              type="button"
              onClick={() => setProviderOpen(null)}
              className="text-[12px] text-neutral-400 hover:text-neutral-200 flex items-center gap-1"
            >
              ← Back
            </button>
          ) : (
            <div>
              <h2 className="text-base font-semibold text-neutral-100">{header.title}</h2>
              <p className="text-[11px] text-neutral-500 mt-1 max-w-md">{header.subtitle}</p>
            </div>
          )}
          <button
            type="button"
            onClick={props.onClose}
            className="h-7 w-7 flex items-center justify-center rounded text-neutral-500 hover:text-neutral-300 hover:bg-neutral-900"
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </div>

        {!isAiDetail && (
          <div className="px-6 pt-3 flex gap-1 border-b border-neutral-800 flex-shrink-0">
            {SETTINGS_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={
                  "px-3 py-2 text-[12px] -mb-px border-b-2 transition-colors " +
                  (tab === t.id
                    ? "border-neutral-200 text-neutral-100"
                    : "border-transparent text-neutral-500 hover:text-neutral-300")
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        <div className="px-6 py-5 overflow-y-auto">
          {tab === "ai" &&
            (providerOpen === null ? (
              <ProviderGrid status={props.status} onOpen={(p) => setProviderOpen(p)} />
            ) : (
              <AnthropicSetup
                status={props.status}
                authMode={props.authMode}
                setAuthMode={props.setAuthMode}
                onRefresh={props.onRefresh}
                onSaveKey={props.onSaveKey}
                onClearKey={props.onClearKey}
              />
            ))}
          {tab === "stock" && (
            <StockMediaSection
              status={props.status}
              onSaveStockKey={props.onSaveStockKey}
              onClearStockKey={props.onClearStockKey}
            />
          )}
          {tab === "skills" && (
            <SkillsSection
              listSkills={props.listSkills}
              setSkillEnabled={props.setSkillEnabled}
              createSkill={props.createSkill}
              fetchCatalog={props.fetchCatalog}
              installSkill={props.installSkill}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── AI provider grid + Anthropic setup ─────────────────────────────────────

function ProviderGrid({
  status,
  onOpen,
}: {
  status: AuthStatus | null;
  onOpen: (provider: "anthropic") => void;
}) {
  const anthropicConnected =
    (status?.claudeCode.ready ?? false) || (status?.apiKey.configured ?? false);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <ProviderCard
        title="Anthropic"
        subtitle="Claude Code"
        icon={<SparkleIcon />}
        connected={anthropicConnected}
        onSetup={() => onOpen("anthropic")}
      />
      <ProviderCard title="OpenAI" subtitle="GPT Codex" icon={<DotsIcon />} disabled comingSoon />
      <ProviderCard title="Google" subtitle="Gemini" icon={<DiamondIcon />} disabled comingSoon />
    </div>
  );
}

interface ProviderCardProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  connected?: boolean;
  disabled?: boolean;
  comingSoon?: boolean;
  onSetup?: () => void;
}

function ProviderCard({
  title,
  subtitle,
  icon,
  connected,
  disabled,
  comingSoon,
  onSetup,
}: ProviderCardProps) {
  return (
    <div
      className={`rounded-lg border p-4 flex flex-col gap-3 ${
        disabled
          ? "border-neutral-900 bg-neutral-950/50 opacity-60"
          : "border-neutral-800 bg-neutral-900/30"
      }`}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm font-medium text-neutral-100 leading-tight">{title}</div>
          <div className="text-[11px] text-neutral-500 leading-tight">{subtitle}</div>
        </div>
        <div className="text-neutral-500">{icon}</div>
      </div>
      <div>
        {comingSoon ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-neutral-900 text-neutral-500 border border-neutral-800">
            Coming soon
          </span>
        ) : connected ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-950/40 text-emerald-300 border border-emerald-900/50">
            ● Connected
          </span>
        ) : (
          <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-amber-950/30 text-amber-300 border border-amber-900/40">
            ● Not connected
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onSetup}
        disabled={disabled}
        className="mt-auto h-8 rounded-md text-[11px] font-medium border border-neutral-800 text-neutral-300 hover:bg-neutral-900 hover:border-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Setup
      </button>
    </div>
  );
}

function AnthropicSetup({
  status,
  authMode,
  setAuthMode,
  onRefresh,
  onSaveKey,
  onClearKey,
}: Omit<
  SettingsModalProps,
  | "onClose"
  | "onSaveStockKey"
  | "onClearStockKey"
  | "listSkills"
  | "setSkillEnabled"
  | "createSkill"
  | "fetchCatalog"
  | "installSkill"
>) {
  const claudeReady = status?.claudeCode.ready ?? false;
  const cliInstalled = status?.claudeCode.cliInstalled ?? false;
  const apiKeyConfigured = status?.apiKey.configured ?? false;
  const apiKeySource = status?.apiKey.source;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <SparkleIcon />
          <h3 className="text-base font-semibold text-neutral-100">Setup Claude</h3>
          {claudeReady && (
            <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-950/40 text-emerald-300 border border-emerald-900/50">
              ● Connected
            </span>
          )}
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="ml-1 text-neutral-500 hover:text-neutral-300"
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshIcon />
          </button>
        </div>
        <p className="text-[11px] text-neutral-500">
          Pick how Hyperframes authenticates with Claude.
        </p>
      </div>

      <section>
        <h4 className="text-[12px] font-semibold text-neutral-200 mb-2">Step 1 · Install</h4>
        <p className="text-[12px] text-neutral-400 leading-relaxed">
          To use your subscription you need{" "}
          <a
            href="https://docs.claude.com/en/docs/claude-code/setup"
            target="_blank"
            rel="noreferrer"
            className="text-studio-accent hover:underline"
          >
            Claude Code installed and logged in
          </a>
          . Install natively (not in WSL on Windows), then run{" "}
          <code className="font-mono text-neutral-300">claude</code> once and sign in.
        </p>
        <div className="mt-2 text-[11px] text-neutral-600 font-mono">
          {cliInstalled ? (
            <div className="text-emerald-400">
              ✓ found at{" "}
              <span className="text-neutral-400">{status?.claudeCode.cliPath ?? "(via PATH)"}</span>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-amber-400">⚠ `claude` binary not detected</div>
              <div className="text-neutral-500">
                Already installed? Try restarting <code>hyperframes preview</code>, or set{" "}
                <code className="text-neutral-300">
                  HYPERFRAMES_CLAUDE_PATH=/abs/path/to/claude
                </code>{" "}
                in the shell before launching.
              </div>
            </div>
          )}
        </div>
      </section>

      <section>
        <h4 className="text-[12px] font-semibold text-neutral-200 mb-2">
          Step 2 · Authenticate with
        </h4>
        <div className="space-y-1.5">
          <AuthRadio
            checked={authMode === "auto"}
            onSelect={() => setAuthMode("auto")}
            label="Auto (recommended)"
            description="Use Claude Code subscription when available; fall back to the API key."
          />
          <AuthRadio
            checked={authMode === "claude-code"}
            onSelect={() => setAuthMode("claude-code")}
            label="Your Claude Code settings (e.g. subscription)"
            description={
              claudeReady
                ? "Detected. Billing goes to your Claude.ai Pro/Max subscription."
                : "Install Claude Code and run `claude` to log in, then refresh."
            }
            disabledWhy={!claudeReady ? "Claude Code not detected" : undefined}
          />
          <AuthRadio
            checked={authMode === "api-key"}
            onSelect={() => setAuthMode("api-key")}
            label="API key"
            description={
              apiKeyConfigured
                ? `Configured (${apiKeySource === "env" ? "env var" : "saved locally"}).`
                : "Paste an Anthropic API key below."
            }
          />
          <AuthRadio checked={false} disabledWhy="Coming soon" label="AWS Bedrock" />
          <AuthRadio checked={false} disabledWhy="Coming soon" label="Google Vertex" />
          <AuthRadio checked={false} disabledWhy="Coming soon" label="Microsoft Foundry" />
          <AuthRadio checked={false} disabledWhy="Coming soon" label="Custom model" />
        </div>
      </section>

      {(authMode === "api-key" || (authMode === "auto" && !claudeReady)) && (
        <ApiKeySection
          configured={apiKeyConfigured}
          source={apiKeySource}
          onSave={onSaveKey}
          onClear={onClearKey}
        />
      )}
    </div>
  );
}

function AuthRadio({
  checked,
  onSelect,
  label,
  description,
  disabledWhy,
}: {
  checked: boolean;
  onSelect?: () => void;
  label: string;
  description?: string;
  disabledWhy?: string;
}) {
  const disabled = disabledWhy != null && !onSelect;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`w-full text-left flex items-start gap-2.5 px-2 py-1.5 rounded-md transition-colors ${
        disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-neutral-900 cursor-pointer"
      }`}
    >
      <span
        className={`mt-0.5 w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
          checked ? "border-studio-accent" : "border-neutral-700"
        }`}
      >
        {checked && <span className="w-1.5 h-1.5 rounded-full bg-studio-accent" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-neutral-200 leading-tight">{label}</div>
        {description && (
          <div className="text-[10px] text-neutral-500 mt-0.5 leading-tight">{description}</div>
        )}
        {disabledWhy && !description && (
          <div className="text-[10px] text-neutral-600 mt-0.5 leading-tight">{disabledWhy}</div>
        )}
      </div>
    </button>
  );
}

function ApiKeySection({
  configured,
  source,
  onSave,
  onClear,
}: {
  configured: boolean;
  source?: "env" | "file" | "none";
  onSave: (key: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onClear: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (source === "env") {
    return (
      <section className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2.5 text-[11px] text-neutral-400">
        <code className="font-mono">ANTHROPIC_API_KEY</code> environment variable detected. To
        override here, unset it and restart.
      </section>
    );
  }

  const handleSave = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError("Paste your Anthropic API key.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const result = await onSave(trimmed);
    setSubmitting(false);
    if (result.ok) {
      setApiKey("");
    } else {
      setError(result.error);
    }
  };

  return (
    <section className="rounded-md border border-neutral-800 bg-neutral-900/30 px-3 py-3 space-y-3">
      <label className="block">
        <span className="block text-[11px] uppercase tracking-wide text-neutral-500 mb-1">
          Anthropic API key
        </span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSave();
          }}
          placeholder="sk-ant-…"
          autoComplete="off"
          spellCheck={false}
          className="w-full h-9 px-3 rounded-md bg-neutral-950 border border-neutral-800 text-sm font-mono text-neutral-100 placeholder-neutral-600 focus:border-studio-accent focus:outline-none"
          disabled={submitting}
        />
        <p className="mt-1.5 text-[11px] text-neutral-600">
          Get a key at{" "}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noreferrer"
            className="text-studio-accent hover:underline"
          >
            console.anthropic.com
          </a>
          . Stored at <code className="font-mono">~/.hyperframes/credentials.json</code> (chmod
          600).
        </p>
      </label>
      {error && (
        <div className="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      <div className="flex items-center justify-between">
        {configured ? (
          <button
            type="button"
            onClick={() => void onClear()}
            className="text-[11px] text-emerald-300 hover:text-emerald-100 underline"
          >
            Disconnect
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={submitting || !apiKey.trim()}
          className="h-9 px-4 rounded-md text-xs font-medium bg-studio-accent text-neutral-950 hover:bg-studio-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? "Saving…" : "Save & connect"}
        </button>
      </div>
    </section>
  );
}
