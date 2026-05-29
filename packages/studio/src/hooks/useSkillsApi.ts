/**
 * REST wrapper around the agent's skills endpoints (list, toggle, create,
 * catalog browse, install).
 *
 * Pulled out of useAgentChat so the chat hook stays focused on the SSE/
 * streaming dispatch — skills are an orthogonal concern that just happens
 * to live on the same server. Each method is memoized by projectId so the
 * components don't re-render for free.
 */

import { useCallback } from "react";

export type SkillScope = "user" | "project";

export interface InstalledSkill {
  name: string;
  description: string;
  scope: SkillScope;
  path: string;
  enabled: boolean;
}

export interface CatalogEntry {
  slug: string;
  title: string;
  description: string;
  category?: string;
}

export interface SkillsApi {
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

export function useSkillsApi(projectId: string): SkillsApi {
  const listSkills = useCallback(async (): Promise<InstalledSkill[]> => {
    const res = await fetch(`/api/projects/${projectId}/skills`);
    if (!res.ok) return [];
    const data = (await res.json()) as { skills?: InstalledSkill[] };
    return data.skills ?? [];
  }, [projectId]);

  const setSkillEnabled = useCallback(
    async (name: string, enabled: boolean): Promise<InstalledSkill[]> => {
      const res = await fetch(`/api/projects/${projectId}/skills/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = (await res.json().catch(() => ({}))) as { skills?: InstalledSkill[] };
      return data.skills ?? [];
    },
    [projectId],
  );

  const createSkill = useCallback(
    async (input: {
      name: string;
      description: string;
      body?: string;
    }): Promise<{ ok: true; skills: InstalledSkill[] } | { ok: false; error: string }> => {
      const res = await fetch(`/api/projects/${projectId}/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = (await res.json().catch(() => ({}))) as {
        skills?: InstalledSkill[];
        error?: string;
      };
      if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
      return { ok: true, skills: data.skills ?? [] };
    },
    [projectId],
  );

  const fetchCatalog = useCallback(async (): Promise<CatalogEntry[]> => {
    const res = await fetch(`/api/skills/catalog`);
    if (!res.ok) return [];
    const data = (await res.json()) as { catalog?: CatalogEntry[] };
    return data.catalog ?? [];
  }, []);

  const installSkill = useCallback(
    async (
      slug: string,
    ): Promise<
      | { ok: true; skills: InstalledSkill[]; output: string }
      | { ok: false; error: string; output: string }
    > => {
      const res = await fetch(`/api/projects/${projectId}/skills/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        skills?: InstalledSkill[];
        error?: string;
        output?: string;
      };
      const output = data.output ?? "";
      if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}`, output };
      return { ok: true, skills: data.skills ?? [], output };
    },
    [projectId],
  );

  return { listSkills, setSkillEnabled, createSkill, fetchCatalog, installSkill };
}
