import { useCallback, useMemo, useState } from "react";
import type { ProjectSummary, WorkspaceInfo } from "../hooks/useServerConnection";

interface ResolutionPreset {
  value:
    | "landscape"
    | "portrait"
    | "square"
    | "landscape-4k"
    | "portrait-4k"
    | "square-4k"
    | "portrait-4-5"
    | "portrait-2-3";
  label: string;
  hint: string;
  width: number;
  height: number;
}

const RESOLUTION_GROUPS: ReadonlyArray<{
  label: string;
  options: ReadonlyArray<ResolutionPreset>;
}> = [
  {
    label: "Vertical (9:16) · TikTok, Reels, Shorts, Stories",
    options: [
      {
        value: "portrait",
        label: "Vertical 1080p",
        hint: "TikTok · Reels · Shorts · Stories",
        width: 1080,
        height: 1920,
      },
      {
        value: "portrait-4k",
        label: "Vertical 4K",
        hint: "9:16 high-res",
        width: 2160,
        height: 3840,
      },
    ],
  },
  {
    label: "Vertical (4:5 / 2:3) · Instagram feed, LinkedIn, Pinterest",
    options: [
      {
        value: "portrait-4-5",
        label: "Instagram feed portrait",
        hint: "4:5 · LinkedIn / Facebook feed",
        width: 1080,
        height: 1350,
      },
      {
        value: "portrait-2-3",
        label: "Pinterest pin",
        hint: "2:3",
        width: 1080,
        height: 1620,
      },
    ],
  },
  {
    label: "Square (1:1) · Instagram feed",
    options: [
      {
        value: "square",
        label: "Square 1080",
        hint: "Instagram feed",
        width: 1080,
        height: 1080,
      },
      {
        value: "square-4k",
        label: "Square 4K",
        hint: "1:1 high-res",
        width: 2160,
        height: 2160,
      },
    ],
  },
  {
    label: "Horizontal (16:9) · YouTube, X, LinkedIn",
    options: [
      {
        value: "landscape",
        label: "Landscape 1080p",
        hint: "YouTube · X · LinkedIn",
        width: 1920,
        height: 1080,
      },
      {
        value: "landscape-4k",
        label: "Landscape 4K",
        hint: "16:9 UHD",
        width: 3840,
        height: 2160,
      },
    ],
  },
];

type Resolution = ResolutionPreset["value"];

export interface StudioSplashProps {
  waiting?: boolean;
  workspace?: WorkspaceInfo | null;
  projects?: ProjectSummary[];
  onOpenProject?: (projectId: string) => void;
  onRefresh?: () => Promise<void> | void;
}

export function StudioSplash({
  waiting,
  workspace,
  projects = [],
  onOpenProject,
  onRefresh,
}: StudioSplashProps) {
  if (waiting) {
    return (
      <div className="h-full w-full bg-neutral-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-center px-6">
          <div className="w-4 h-4 rounded-full border-2 border-neutral-700 border-t-neutral-500 animate-spin" />
          <p className="text-xs text-neutral-600">
            Waiting for preview server… run{" "}
            <code className="text-neutral-500 font-mono">npm run dev</code>
          </p>
        </div>
      </div>
    );
  }

  // Single-project mode resolves to a project automatically; if we still get
  // here it means the server is alive but no project loaded yet. Show a
  // minimal heartbeat so we don't flash an unrelated picker.
  if (workspace?.mode === "single") {
    return (
      <div className="h-full w-full bg-neutral-950 flex items-center justify-center">
        <div className="w-4 h-4 rounded-full bg-studio-accent animate-pulse" />
      </div>
    );
  }

  return (
    <ProjectPicker
      workspace={workspace ?? null}
      projects={projects}
      onOpenProject={onOpenProject}
      onRefresh={onRefresh}
    />
  );
}

interface ProjectPickerProps {
  workspace: WorkspaceInfo | null;
  projects: ProjectSummary[];
  onOpenProject?: (projectId: string) => void;
  onRefresh?: () => Promise<void> | void;
}

function ProjectPicker({ workspace, projects, onOpenProject, onRefresh }: ProjectPickerProps) {
  const [showNewModal, setShowNewModal] = useState(false);
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => (a.title ?? a.id).localeCompare(b.title ?? b.id)),
    [projects],
  );

  return (
    <div className="h-full w-full bg-neutral-950 overflow-auto">
      <div className="max-w-4xl mx-auto px-8 py-12">
        <header className="flex items-end justify-between mb-10">
          <div>
            <h1 className="text-3xl font-semibold text-neutral-100 tracking-tight">Hyperframes</h1>
            <p className="mt-2 text-sm text-neutral-500">
              {workspace?.root ? (
                <>
                  Workspace ·{" "}
                  <code className="font-mono text-xs text-neutral-400">{workspace.root}</code>
                </>
              ) : (
                "Workspace not configured"
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowWorkspaceModal(true)}
              className="h-9 px-3 rounded-md text-xs font-medium border border-neutral-800 text-neutral-300 hover:bg-neutral-900 hover:border-neutral-700 transition-colors"
            >
              Change workspace…
            </button>
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
              className="h-9 px-3 rounded-md text-xs font-medium bg-studio-accent text-neutral-950 hover:bg-studio-accent/90 transition-colors"
            >
              + New project
            </button>
          </div>
        </header>

        {sortedProjects.length === 0 ? (
          <EmptyState onCreate={() => setShowNewModal(true)} />
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {sortedProjects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onOpenProject?.(p.id)}
                  className="group w-full text-left rounded-lg border border-neutral-800 bg-neutral-900/40 hover:border-neutral-700 hover:bg-neutral-900 transition-colors overflow-hidden"
                >
                  <div className="aspect-video bg-neutral-900 border-b border-neutral-800 flex items-center justify-center text-neutral-700 text-xs font-mono">
                    {p.id}
                  </div>
                  <div className="p-3">
                    <div className="text-sm font-medium text-neutral-200 truncate">
                      {p.title ?? p.id}
                    </div>
                    <div className="text-[11px] text-neutral-500 truncate font-mono mt-0.5">
                      {p.id}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showNewModal && (
        <NewProjectModal
          onClose={() => setShowNewModal(false)}
          onCreated={async (id) => {
            setShowNewModal(false);
            await onRefresh?.();
            onOpenProject?.(id);
          }}
        />
      )}

      {showWorkspaceModal && (
        <WorkspaceModal
          currentRoot={workspace?.root ?? ""}
          onClose={() => setShowWorkspaceModal(false)}
          onChanged={async () => {
            setShowWorkspaceModal(false);
            await onRefresh?.();
          }}
        />
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900/20 px-8 py-16 text-center">
      <p className="text-sm text-neutral-400 mb-1">No projects in this workspace yet.</p>
      <p className="text-xs text-neutral-600 mb-6">
        Create one to start editing — or change the workspace folder above.
      </p>
      <button
        type="button"
        onClick={onCreate}
        className="h-9 px-4 rounded-md text-xs font-medium bg-studio-accent text-neutral-950 hover:bg-studio-accent/90 transition-colors"
      >
        + Create your first project
      </button>
    </div>
  );
}

interface NewProjectModalProps {
  onClose: () => void;
  onCreated: (id: string) => void | Promise<void>;
}

function NewProjectModal({ onClose, onCreated }: NewProjectModalProps) {
  const [name, setName] = useState("");
  const [resolution, setResolution] = useState<Resolution>("landscape");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    if (!name.trim()) {
      setError("Choose a name for your project.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), resolution }),
      });
      const data = (await res.json()) as { project?: { id?: string }; error?: string };
      if (!res.ok || !data.project?.id) {
        throw new Error(data.error ?? `Server responded with ${res.status}`);
      }
      await onCreated(data.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [name, resolution, submitting, onCreated]);

  return (
    <ModalShell title="New project" onClose={onClose} size="lg">
      <div className="space-y-5">
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wide text-neutral-500 mb-1">
            Project name
          </span>
          <input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            placeholder="my-video"
            className="w-full h-9 px-3 rounded-md bg-neutral-950 border border-neutral-800 text-sm text-neutral-100 placeholder-neutral-600 focus:border-studio-accent focus:outline-none"
            disabled={submitting}
          />
        </label>

        <div>
          <span className="block text-[11px] uppercase tracking-wide text-neutral-500 mb-2">
            Canvas
          </span>
          <div className="space-y-3">
            {RESOLUTION_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="text-[10px] uppercase tracking-wide text-neutral-600 mb-1.5">
                  {group.label}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {group.options.map((opt) => (
                    <ResolutionTile
                      key={opt.value}
                      preset={opt}
                      selected={resolution === opt.value}
                      onSelect={() => setResolution(opt.value)}
                      disabled={submitting}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>

      <ModalFooter
        primaryLabel={submitting ? "Creating…" : "Create project"}
        onPrimary={handleSubmit}
        primaryDisabled={submitting || !name.trim()}
        onCancel={onClose}
      />
    </ModalShell>
  );
}

interface ResolutionTileProps {
  preset: ResolutionPreset;
  selected: boolean;
  onSelect: () => void;
  disabled: boolean;
}

function ResolutionTile({ preset, selected, onSelect, disabled }: ResolutionTileProps) {
  // Render the aspect ratio thumb at a constant height so vertical formats
  // stay narrow and landscape formats stay wide — a quick visual hint of
  // the orientation without needing the user to read the dimensions.
  const thumbHeight = 36;
  const thumbWidth = Math.round((preset.width / preset.height) * thumbHeight);
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`text-left rounded-md border px-2.5 py-2 transition-colors ${
        selected
          ? "border-studio-accent bg-studio-accent/10"
          : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-700 hover:bg-neutral-900"
      } disabled:opacity-50 disabled:cursor-not-allowed`}
      aria-pressed={selected}
    >
      <div className="flex items-center gap-2.5">
        <div
          className={`flex-shrink-0 rounded-sm border ${
            selected
              ? "border-studio-accent/80 bg-studio-accent/20"
              : "border-neutral-700 bg-neutral-800"
          }`}
          style={{ width: thumbWidth, height: thumbHeight }}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div
            className={`text-[12px] font-medium truncate ${
              selected ? "text-neutral-50" : "text-neutral-200"
            }`}
          >
            {preset.label}
          </div>
          <div className="text-[10px] text-neutral-500 truncate font-mono">
            {preset.width}×{preset.height}
          </div>
          <div className="text-[10px] text-neutral-600 truncate">{preset.hint}</div>
        </div>
      </div>
    </button>
  );
}

interface WorkspaceModalProps {
  currentRoot: string;
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}

function WorkspaceModal({ currentRoot, onClose, onChanged }: WorkspaceModalProps) {
  const [root, setRoot] = useState(currentRoot);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    if (!root.trim()) {
      setError("Provide an absolute path to the workspace folder.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: root.trim() }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Server responded with ${res.status}`);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [root, submitting, onChanged]);

  return (
    <ModalShell title="Change workspace" onClose={onClose}>
      <div className="space-y-4">
        <label className="block">
          <span className="block text-[11px] uppercase tracking-wide text-neutral-500 mb-1">
            Workspace folder
          </span>
          <input
            type="text"
            autoFocus
            value={root}
            onChange={(e) => setRoot(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleSubmit();
            }}
            placeholder="C:\Users\me\hyperframes"
            className="w-full h-9 px-3 rounded-md bg-neutral-950 border border-neutral-800 text-sm text-neutral-100 font-mono placeholder-neutral-600 focus:border-studio-accent focus:outline-none"
            disabled={submitting}
          />
          <p className="mt-1.5 text-[11px] text-neutral-600">
            Every direct subfolder containing an <code className="font-mono">index.html</code> shows
            up as a project. The folder is created if it doesn't exist.
          </p>
        </label>

        {error && (
          <div className="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}
      </div>

      <ModalFooter
        primaryLabel={submitting ? "Saving…" : "Use this folder"}
        onPrimary={handleSubmit}
        primaryDisabled={submitting || !root.trim()}
        onCancel={onClose}
      />
    </ModalShell>
  );
}

function ModalShell({
  title,
  onClose,
  children,
  size = "md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: "md" | "lg";
}) {
  const maxWidth = size === "lg" ? "max-w-2xl" : "max-w-md";
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full ${maxWidth} max-h-[calc(100vh-2rem)] flex flex-col rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl`}
      >
        <div className="px-5 py-4 border-b border-neutral-800 flex-shrink-0">
          <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function ModalFooter({
  primaryLabel,
  onPrimary,
  primaryDisabled,
  onCancel,
}: {
  primaryLabel: string;
  onPrimary: () => void;
  primaryDisabled: boolean;
  onCancel: () => void;
}) {
  return (
    <div className="mt-5 flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        className="h-9 px-3 rounded-md text-xs font-medium border border-neutral-800 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 transition-colors"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onPrimary}
        disabled={primaryDisabled}
        className="h-9 px-4 rounded-md text-xs font-medium bg-studio-accent text-neutral-950 hover:bg-studio-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {primaryLabel}
      </button>
    </div>
  );
}
