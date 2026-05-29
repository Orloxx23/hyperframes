import type { Hono } from "hono";
import type { StudioApiAdapter } from "../types.js";
import { walkDir } from "../helpers/safePath.js";
import { normalizeResolutionFlag } from "../../core.types.js";

export function registerProjectRoutes(api: Hono, adapter: StudioApiAdapter): void {
  // List all projects + workspace metadata (used by the splash picker).
  api.get("/projects", async (c) => {
    const [projects, workspace] = await Promise.all([
      Promise.resolve(adapter.listProjects()),
      Promise.resolve(adapter.getWorkspaceInfo?.() ?? { mode: "single", root: null }),
    ]);
    return c.json({ projects, workspace });
  });

  // Workspace info — split out so the UI can refresh after a change.
  api.get("/workspace", async (c) => {
    const info = await Promise.resolve(
      adapter.getWorkspaceInfo?.() ?? { mode: "single", root: null },
    );
    return c.json(info);
  });

  // Change the active workspace root.
  api.put("/workspace", async (c) => {
    if (!adapter.setWorkspaceRoot) {
      return c.json({ error: "workspace switching not supported" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as { root?: unknown } | null;
    const root = typeof body?.root === "string" ? body.root.trim() : "";
    if (!root) return c.json({ error: "root is required" }, 400);
    try {
      const info = await adapter.setWorkspaceRoot(root);
      return c.json(info);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Create a blank project in the active workspace.
  api.post("/projects", async (c) => {
    if (!adapter.createBlankProject) {
      return c.json({ error: "project creation not supported" }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      resolution?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);

    let resolution: ReturnType<typeof normalizeResolutionFlag> | undefined;
    if (typeof body?.resolution === "string" && body.resolution.length > 0) {
      const parsed = normalizeResolutionFlag(body.resolution);
      if (!parsed) return c.json({ error: `unknown resolution: ${body.resolution}` }, 400);
      resolution = parsed;
    }

    try {
      const project = await adapter.createBlankProject({
        name,
        ...(resolution ? { resolution } : {}),
      });
      return c.json({ project });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Resolve session to project (multi-project mode)
  api.get("/resolve-session/:sessionId", async (c) => {
    if (!adapter.resolveSession) {
      return c.json({ error: "not available" }, 404);
    }
    const { sessionId } = c.req.param();
    const result = await adapter.resolveSession(sessionId);
    if (!result) return c.json({ error: "Session not found" }, 404);
    return c.json(result);
  });

  // Project file tree
  api.get("/projects/:id", async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const files = walkDir(project.dir);
    return c.json({ id: project.id, dir: project.dir, title: project.title, files });
  });
}
