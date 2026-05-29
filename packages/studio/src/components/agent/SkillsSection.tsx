/**
 * Settings → Skills tab. Lets the user:
 *   - Installed: see every skill the agent could load + toggle enable/disable.
 *   - Browse:    install one of the curated catalog entries via `npx skills add`.
 *   - New:       author a project-local skill by writing a SKILL.md from a form.
 *
 * State that needs to survive sub-tab switches (the last install outcome per
 * slug, the loaded catalog, the cached installed-skills list) lives here at
 * the SkillsSection level rather than inside the individual rows.
 */

import { useEffect, useState } from "react";
import type { CatalogEntry, InstalledSkill } from "../../hooks/useAgentChat";

export interface SkillsSectionProps {
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
}

/** UI-only shape for what we display about a finished install attempt. */
interface InstallOutcome {
  ok: boolean;
  error?: string;
  output: string;
  /** Names of skills that appeared after install (diff against pre-install list). */
  added: string[];
}

type SkillsTab = "installed" | "browse" | "new";

export function SkillsSection({
  listSkills,
  setSkillEnabled,
  createSkill,
  fetchCatalog,
  installSkill,
}: SkillsSectionProps) {
  const [tab, setTab] = useState<SkillsTab>("installed");
  const [skills, setSkills] = useState<InstalledSkill[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [loadingSkills, setLoadingSkills] = useState(false);
  // Keyed by slug — kept here so the outcome survives Installed/Browse/New
  // sub-tab switches. (It still resets when the parent SettingsModal switches
  // top-level tabs, which is acceptable.)
  const [installOutcomes, setInstallOutcomes] = useState<Record<string, InstallOutcome>>({});

  const refreshSkills = async () => {
    setLoadingSkills(true);
    try {
      setSkills(await listSkills());
    } finally {
      setLoadingSkills(false);
    }
  };

  useEffect(() => {
    void refreshSkills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (tab === "browse" && catalog === null) {
      void fetchCatalog().then(setCatalog);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div>
      <div className="mb-3 flex gap-1 text-[11px]">
        <TabButton active={tab === "installed"} onClick={() => setTab("installed")}>
          Installed
        </TabButton>
        <TabButton active={tab === "browse"} onClick={() => setTab("browse")}>
          Browse
        </TabButton>
        <TabButton active={tab === "new"} onClick={() => setTab("new")}>
          New
        </TabButton>
      </div>

      {tab === "installed" && (
        <InstalledSkillsList
          skills={skills}
          loading={loadingSkills}
          onToggle={async (name, enabled) => {
            const next = await setSkillEnabled(name, enabled);
            setSkills(next);
          }}
        />
      )}
      {tab === "browse" && (
        <CatalogList
          catalog={catalog}
          installed={skills ?? []}
          outcomes={installOutcomes}
          onInstall={async (slug) => {
            const before = new Set((skills ?? []).map((s) => s.name));
            const result = await installSkill(slug);
            let outcome: InstallOutcome;
            if (result.ok) {
              setSkills(result.skills);
              const added = result.skills.filter((s) => !before.has(s.name)).map((s) => s.name);
              outcome = { ok: true, output: result.output, added };
            } else {
              outcome = { ok: false, error: result.error, output: result.output, added: [] };
            }
            setInstallOutcomes((prev) => ({ ...prev, [slug]: outcome }));
            return outcome;
          }}
        />
      )}
      {tab === "new" && (
        <NewSkillForm
          onCreate={async (input) => {
            const result = await createSkill(input);
            if (result.ok) {
              setSkills(result.skills);
              setTab("installed");
            }
            return result;
          }}
        />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "px-2 py-1 rounded border " +
        (active
          ? "border-neutral-700 bg-neutral-800 text-neutral-100"
          : "border-transparent text-neutral-500 hover:text-neutral-300")
      }
    >
      {children}
    </button>
  );
}

function InstalledSkillsList({
  skills,
  loading,
  onToggle,
}: {
  skills: InstalledSkill[] | null;
  loading: boolean;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
}) {
  if (skills === null || loading) {
    return <div className="text-[11px] text-neutral-500 px-1 py-2">Loading…</div>;
  }
  if (skills.length === 0) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3 text-[11px] text-neutral-400">
        No skills installed yet. Use <em className="not-italic text-neutral-300">Browse</em> to
        install one, or <em className="not-italic text-neutral-300">New</em> to author your own.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {skills.map((skill) => (
        <SkillRow key={`${skill.scope}:${skill.name}`} skill={skill} onToggle={onToggle} />
      ))}
    </div>
  );
}

function SkillRow({
  skill,
  onToggle,
}: {
  skill: InstalledSkill;
  onToggle: (name: string, enabled: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-start justify-between gap-3 rounded border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-neutral-100 truncate">{skill.name}</span>
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">
            {skill.scope}
          </span>
        </div>
        {skill.description && (
          <p className="text-[11px] text-neutral-400 mt-0.5 line-clamp-3">{skill.description}</p>
        )}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onToggle(skill.name, !skill.enabled);
          } finally {
            setBusy(false);
          }
        }}
        className={
          "shrink-0 text-[11px] px-2 py-1 rounded border " +
          (skill.enabled
            ? "border-emerald-700/60 bg-emerald-900/30 text-emerald-200 hover:bg-emerald-900/50"
            : "border-neutral-700 bg-neutral-800 text-neutral-400 hover:text-neutral-200")
        }
      >
        {busy ? "…" : skill.enabled ? "On" : "Off"}
      </button>
    </div>
  );
}

function CatalogList({
  catalog,
  installed,
  outcomes,
  onInstall,
}: {
  catalog: CatalogEntry[] | null;
  installed: InstalledSkill[];
  outcomes: Record<string, InstallOutcome>;
  onInstall: (slug: string) => Promise<InstallOutcome>;
}) {
  if (catalog === null) {
    return <div className="text-[11px] text-neutral-500 px-1 py-2">Loading catalog…</div>;
  }
  if (catalog.length === 0) {
    return (
      <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3 text-[11px] text-neutral-400">
        No curated skills available right now.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-neutral-500">
        Runs <code className="text-neutral-300">npx skills add &lt;slug&gt;</code> in the
        background. The agent picks up the skill on the next message.
      </p>
      {catalog.map((entry) => (
        <CatalogRow
          key={entry.slug}
          entry={entry}
          alreadyInstalled={installed.some(
            (s) => s.name === entry.slug.split("/").pop() || s.name === entry.title,
          )}
          lastOutcome={outcomes[entry.slug] ?? null}
          onInstall={onInstall}
        />
      ))}
    </div>
  );
}

function CatalogRow({
  entry,
  alreadyInstalled,
  lastOutcome,
  onInstall,
}: {
  entry: CatalogEntry;
  alreadyInstalled: boolean;
  lastOutcome: InstallOutcome | null;
  onInstall: (slug: string) => Promise<InstallOutcome>;
}) {
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  const buttonLabel = alreadyInstalled
    ? "Installed"
    : busy
      ? `Installing… ${elapsed}s`
      : lastOutcome?.ok && lastOutcome.added.length > 0
        ? "Re-install"
        : lastOutcome
          ? "Try again"
          : "Install";

  // Open the subprocess output panel by default when something went wrong
  // (error or amber "exited 0 but installed nothing"). On clean success we
  // collapse it to keep the row compact.
  const showOutputOpen = !!lastOutcome && (!lastOutcome.ok || lastOutcome.added.length === 0);

  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-neutral-100">{entry.title}</div>
          <div className="text-[10px] text-neutral-500 font-mono mt-0.5">{entry.slug}</div>
          <p className="text-[11px] text-neutral-400 mt-1">{entry.description}</p>
        </div>
        <button
          type="button"
          disabled={busy || alreadyInstalled}
          onClick={async () => {
            setBusy(true);
            await onInstall(entry.slug);
            setBusy(false);
          }}
          className={
            "shrink-0 text-[11px] px-3 py-1.5 rounded border " +
            (alreadyInstalled
              ? "border-neutral-800 bg-neutral-900 text-neutral-500 cursor-default"
              : "border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700 disabled:opacity-50")
          }
        >
          {buttonLabel}
        </button>
      </div>
      {busy && (
        <p className="text-[11px] text-neutral-500 mt-2">
          Running <code className="text-neutral-400">npx skills add {entry.slug}</code> — cold cache
          can take ~30s. Live output is in the terminal that started Studio.
        </p>
      )}
      {!busy && lastOutcome && (
        <div className="mt-2 space-y-2">
          {lastOutcome.ok ? (
            lastOutcome.added.length > 0 ? (
              <div className="rounded border border-emerald-800/60 bg-emerald-900/20 px-2.5 py-2 text-[11px] text-emerald-200">
                Installed {lastOutcome.added.length} skill
                {lastOutcome.added.length === 1 ? "" : "s"}:{" "}
                <span className="font-mono">{lastOutcome.added.join(", ")}</span>
              </div>
            ) : (
              <div className="rounded border border-amber-800/60 bg-amber-900/20 px-2.5 py-2 text-[11px] text-amber-200">
                <code className="text-amber-100">npx skills add</code> exited successfully but no
                new skills appeared in <code className="text-amber-100">~/.claude/skills/</code> or{" "}
                <code className="text-amber-100">&lt;project&gt;/.claude/skills/</code>. The output
                below shows what the subprocess actually did — paste it back here if it's unclear.
              </div>
            )
          ) : (
            <pre className="text-[11px] text-red-400 whitespace-pre-wrap break-words">
              {lastOutcome.error}
            </pre>
          )}
          {lastOutcome.output.trim() ? (
            <details open={showOutputOpen}>
              <summary className="text-[11px] text-neutral-400 cursor-pointer hover:text-neutral-200">
                Subprocess output ({lastOutcome.output.length} chars)
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto text-[11px] text-neutral-300 bg-black/40 border border-neutral-800 rounded p-2 whitespace-pre-wrap break-words font-mono">
                {lastOutcome.output}
              </pre>
            </details>
          ) : (
            <p className="text-[11px] text-neutral-500 italic">
              Subprocess produced no output — the command exited silently.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function NewSkillForm({
  onCreate,
}: {
  onCreate: (input: {
    name: string;
    description: string;
    body?: string;
  }) => Promise<{ ok: true; skills: InstalledSkill[] } | { ok: false; error: string }>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-3 rounded border border-neutral-800 bg-neutral-900/60 p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (!name.trim() || !description.trim()) {
          setError("Name and description are required.");
          return;
        }
        setSubmitting(true);
        const result = await onCreate({
          name: name.trim(),
          description: description.trim(),
          body: body.trim() || undefined,
        });
        setSubmitting(false);
        if (!result.ok) setError(result.error);
        else {
          setName("");
          setDescription("");
          setBody("");
        }
      }}
    >
      <div>
        <label className="block text-[11px] text-neutral-400 mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="cinematic-overlay"
          className="w-full bg-black/40 border border-neutral-800 rounded px-2 py-1.5 text-[12px] text-neutral-100 focus:outline-none focus:border-neutral-600"
        />
      </div>
      <div>
        <label className="block text-[11px] text-neutral-400 mb-1">
          Description{" "}
          <span className="text-neutral-600">(the model reads this to decide when to invoke)</span>
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="Add letterboxed bars, film grain, and slow camera-move framing to compositions when the user asks for a cinematic look."
          className="w-full bg-black/40 border border-neutral-800 rounded px-2 py-1.5 text-[12px] text-neutral-100 focus:outline-none focus:border-neutral-600 resize-y"
        />
      </div>
      <div>
        <label className="block text-[11px] text-neutral-400 mb-1">
          Body <span className="text-neutral-600">(optional — markdown guidance)</span>
        </label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={5}
          placeholder="# Cinematic overlay&#10;&#10;Apply a 2.35:1 letterbox by inserting black `<div>` bars over the top and bottom 12% of the canvas..."
          className="w-full bg-black/40 border border-neutral-800 rounded px-2 py-1.5 text-[12px] text-neutral-100 font-mono focus:outline-none focus:border-neutral-600 resize-y"
        />
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] text-neutral-500">
          Writes to <code className="text-neutral-400">.claude/skills/&lt;slug&gt;/SKILL.md</code>{" "}
          inside your project.
        </p>
        <button
          type="submit"
          disabled={submitting}
          className="text-[11px] px-3 py-1.5 rounded border border-neutral-700 bg-neutral-800 text-neutral-100 hover:bg-neutral-700 disabled:opacity-50"
        >
          {submitting ? "Creating…" : "Create skill"}
        </button>
      </div>
    </form>
  );
}
