import { useEffect, useState, useCallback } from "react";
import { buildProjectHash, parseProjectIdFromHash } from "../utils/projectRouting";
import { useMountEffect } from "./useMountEffect";

export interface ProjectSummary {
  id: string;
  title?: string;
  sessionId?: string;
}

export interface WorkspaceInfo {
  mode: "single" | "workspace";
  root: string | null;
}

interface ServerConnectionState {
  projectId: string | null;
  resolving: boolean;
  waitingForServer: boolean;
  workspace: WorkspaceInfo | null;
  projects: ProjectSummary[];
  /** Re-fetch the project list (after create/workspace change). */
  refresh: () => Promise<void>;
  /** Programmatically open a project (updates the URL hash). */
  openProject: (projectId: string) => void;
  /** Return to the splash project picker. */
  returnToSplash: () => void;
}

interface ProjectsResponse {
  projects?: Array<{ id?: string; title?: string; sessionId?: string }>;
  workspace?: { mode?: string; root?: string | null };
}

function normalizeProjects(raw: ProjectsResponse | null): ProjectSummary[] {
  if (!raw?.projects) return [];
  return raw.projects
    .filter(
      (p): p is { id: string; title?: string; sessionId?: string } => typeof p?.id === "string",
    )
    .map((p) => ({
      id: p.id,
      title: p.title ?? p.id,
      sessionId: p.sessionId,
    }));
}

function normalizeWorkspace(raw: ProjectsResponse | null): WorkspaceInfo {
  const mode = raw?.workspace?.mode === "workspace" ? "workspace" : "single";
  return { mode, root: raw?.workspace?.root ?? null };
}

/**
 * Resolves the active project ID against the server.
 *
 * Modes:
 *   - **single**: legacy behavior. If `/api/projects` returns one project we
 *     auto-select it and write the hash, so old bookmarks keep working.
 *   - **workspace**: the user picks a project from the splash. We never
 *     auto-select even if exactly one project happens to exist — otherwise
 *     creating a single new project would skip past the picker on next load.
 *
 * Polls every 2 s until the server responds.
 */
export function useServerConnection(): ServerConnectionState {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [waitingForServer, setWaitingForServer] = useState(false);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);

  const fetchProjects = useCallback(async (): Promise<ProjectsResponse | null> => {
    try {
      const res = await fetch("/api/projects");
      return (await res.json()) as ProjectsResponse;
    } catch {
      return null;
    }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const data = await fetchProjects();
    if (!data) return;
    setProjects(normalizeProjects(data));
    setWorkspace(normalizeWorkspace(data));
  }, [fetchProjects]);

  useMountEffect(() => {
    const hashProjectId = parseProjectIdFromHash(window.location.hash);
    let cancelled = false;
    let retryTimer: ReturnType<typeof window.setTimeout> | null = null;

    function scheduleRetry() {
      setWaitingForServer(true);
      retryTimer = window.setTimeout(tryConnect, 2000);
    }

    function tryConnect() {
      fetch("/api/projects")
        .then((r) => r.json() as Promise<ProjectsResponse>)
        .then((data) => {
          if (cancelled) return;
          const nextWorkspace = normalizeWorkspace(data);
          const nextProjects = normalizeProjects(data);
          setWorkspace(nextWorkspace);
          setProjects(nextProjects);
          setWaitingForServer(false);

          if (hashProjectId) {
            setProjectId(hashProjectId);
            return;
          }
          if (nextWorkspace.mode === "single") {
            const first = nextProjects[0];
            if (first) {
              setProjectId(first.id);
              window.location.hash = buildProjectHash(first.id);
              return;
            }
          }
          // Workspace mode (or no projects yet) — render the picker.
          setProjectId(null);
        })
        .catch(() => {
          if (!cancelled) scheduleRetry();
        })
        .finally(() => {
          if (!cancelled) setResolving(false);
        });
    }

    tryConnect();
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  });

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    const onHashChange = () => {
      const next = parseProjectIdFromHash(window.location.hash);
      setProjectId(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openProject = useCallback((id: string) => {
    window.location.hash = buildProjectHash(id);
  }, []);

  const returnToSplash = useCallback(() => {
    // Clear the hash without reloading. setProjectId fires via the hashchange
    // listener above; do it eagerly too so the splash mounts in the same tick.
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    setProjectId(null);
  }, []);

  return {
    projectId,
    resolving,
    waitingForServer,
    workspace,
    projects,
    refresh,
    openProject,
    returnToSplash,
  };
}
