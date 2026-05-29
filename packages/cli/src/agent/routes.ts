/**
 * CLI-only HTTP routes for the in-Studio AI chat. Mounted on the embedded
 * Hono server in `studioServer.ts` BEFORE the shared studio API — these
 * are local-execution paths that don't make sense in the dev vite adapter,
 * so they don't live in `@hyperframes/core`.
 *
 * Routes:
 *   GET    /api/credentials                     — provider auth status (api key + claude code)
 *   PUT    /api/credentials/anthropic           — save the user's API key
 *   DELETE /api/credentials/anthropic           — revoke the stored key
 *   POST   /api/projects/:id/agent/chat         — run a chat turn (SSE)
 *   DELETE /api/projects/:id/agent/conversation — reset the resumable session
 *   GET    /api/projects/:id/skills             — list installed skills (user + project)
 *   PUT    /api/projects/:id/skills/:name       — { enabled: boolean } toggle a skill
 *   POST   /api/projects/:id/skills             — { name, description, body? } create project skill
 *   GET    /api/skills/catalog                  — curated skills available via `npx skills add`
 *   POST   /api/projects/:id/skills/install     — { slug } install a catalog entry
 */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StudioApiAdapter } from "@hyperframes/core/studio-api";
import {
  clearAnthropicApiKey,
  clearStockApiKey,
  getAnthropicApiKey,
  getCredentialsStatus,
  setAnthropicApiKey,
  setStockApiKey,
  STOCK_PROVIDERS,
  type StockProvider,
} from "./credentials.js";
import { detectAuthStatus, type AuthSource } from "./authDetect.js";
import { runAgentTurn, type AgentEvent, type AuthMode } from "./agentLoop.js";
import {
  SKILL_CATALOG,
  createProjectSkill,
  installSkill,
  listInstalledSkills,
  setSkillEnabled,
} from "./skills.js";

interface ChatBody {
  message?: unknown;
  activeCompPath?: unknown;
  /** If "auto" (or omitted), the server picks the preferredSource. */
  authMode?: unknown;
}

/**
 * Tracks the last sessionId per (project, authMode) so follow-up turns
 * automatically resume the conversation Claude Code maintains on disk.
 * In-memory only — clearing the conversation or restarting the server
 * starts fresh.
 */
const projectSessions = new Map<string, string>();
const sessionKey = (projectId: string, mode: AuthMode) => `${projectId}::${mode}`;

function buildAuthStatusPayload() {
  const auth = detectAuthStatus();
  const credentials = getCredentialsStatus();
  return {
    preferredSource: auth.preferredSource,
    claudeCode: auth.claudeCode,
    apiKey: { ...credentials.anthropic },
    stockMedia: {
      pexels: credentials.pexels,
      unsplash: credentials.unsplash,
      pixabay: credentials.pixabay,
    },
  };
}

function isStockProvider(value: string): value is StockProvider {
  return (STOCK_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Mount agent + credentials routes.
 *
 * `prefix` is `/api` when registering on the top-level Hono app (CLI
 * embedded mode), or `""` when registering on the sub-API that the Vite
 * dev plugin already exposes under `/api/*`.
 */
export function registerAgentRoutes(
  app: Hono,
  adapter: StudioApiAdapter,
  prefix: string = "/api",
): void {
  app.get(`${prefix}/credentials`, (c) => c.json(buildAuthStatusPayload()));

  app.put(`${prefix}/credentials/anthropic`, async (c) => {
    const body = (await c.req.json().catch(() => null)) as { apiKey?: unknown } | null;
    const key = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!key) return c.json({ error: "apiKey is required" }, 400);
    try {
      setAnthropicApiKey(key);
      return c.json(buildAuthStatusPayload());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid key" }, 400);
    }
  });

  app.delete(`${prefix}/credentials/anthropic`, (c) => {
    clearAnthropicApiKey();
    return c.json(buildAuthStatusPayload());
  });

  app.put(`${prefix}/credentials/stock/:provider`, async (c) => {
    const provider = c.req.param("provider");
    if (!isStockProvider(provider)) {
      return c.json({ error: `unknown provider: ${provider}` }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as { apiKey?: unknown } | null;
    const key = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!key) return c.json({ error: "apiKey is required" }, 400);
    try {
      setStockApiKey(provider, key);
      return c.json(buildAuthStatusPayload());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "invalid key" }, 400);
    }
  });

  app.delete(`${prefix}/credentials/stock/:provider`, (c) => {
    const provider = c.req.param("provider");
    if (!isStockProvider(provider)) {
      return c.json({ error: `unknown provider: ${provider}` }, 400);
    }
    clearStockApiKey(provider);
    return c.json(buildAuthStatusPayload());
  });

  app.delete(`${prefix}/projects/:id/agent/conversation`, (c) => {
    const id = c.req.param("id");
    for (const key of [...projectSessions.keys()]) {
      if (key.startsWith(`${id}::`)) projectSessions.delete(key);
    }
    return c.json({ ok: true });
  });

  // ── Skills ────────────────────────────────────────────────────────────────

  app.get(`${prefix}/projects/:id/skills`, async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const skills = listInstalledSkills(project.dir);
    return c.json({ skills });
  });

  app.put(`${prefix}/projects/:id/skills/:name`, async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const name = c.req.param("name");
    const body = (await c.req.json().catch(() => null)) as { enabled?: unknown } | null;
    if (typeof body?.enabled !== "boolean") {
      return c.json({ error: "enabled (boolean) is required" }, 400);
    }
    setSkillEnabled(project.dir, name, body.enabled);
    return c.json({ skills: listInstalledSkills(project.dir) });
  });

  app.post(`${prefix}/projects/:id/skills`, async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown;
      description?: unknown;
      body?: unknown;
    } | null;
    const name = typeof body?.name === "string" ? body.name : "";
    const description = typeof body?.description === "string" ? body.description : "";
    const skillBody = typeof body?.body === "string" ? body.body : undefined;
    try {
      const result = createProjectSkill(project.dir, {
        name,
        description,
        ...(skillBody !== undefined ? { body: skillBody } : {}),
      });
      return c.json({
        skill: result,
        skills: listInstalledSkills(project.dir),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "failed to create skill" }, 400);
    }
  });

  app.get(`${prefix}/skills/catalog`, (c) => c.json({ catalog: SKILL_CATALOG }));

  app.post(`${prefix}/projects/:id/skills/install`, async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);
    const body = (await c.req.json().catch(() => null)) as { slug?: unknown } | null;
    const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
    if (!slug) return c.json({ error: "slug is required" }, 400);
    // Guardrail: only accept slugs from the curated catalog. This avoids
    // turning the install endpoint into an arbitrary `npx` execution
    // surface for any user with network access to the Studio server.
    const entry = SKILL_CATALOG.find((e) => e.slug === slug);
    if (!entry) return c.json({ error: `unknown catalog slug: ${slug}` }, 400);
    const result = await installSkill(entry.slug, project.dir);
    if (!result.ok) {
      return c.json({ error: result.error ?? "install failed", output: result.output }, 500);
    }
    return c.json({
      ok: true,
      output: result.output,
      skills: listInstalledSkills(project.dir),
    });
  });

  app.post(`${prefix}/projects/:id/agent/chat`, async (c) => {
    const project = await adapter.resolveProject(c.req.param("id"));
    if (!project) return c.json({ error: "project not found" }, 404);

    const body = (await c.req.json().catch(() => null)) as ChatBody | null;
    const userMessage = typeof body?.message === "string" ? body.message : "";
    if (!userMessage.trim()) {
      return c.json({ error: "message is required" }, 400);
    }
    const activeCompPath = typeof body?.activeCompPath === "string" ? body.activeCompPath : null;

    // Resolve auth mode. `auto` (default) honors the server's detection.
    const requested = typeof body?.authMode === "string" ? body.authMode : "auto";
    const authStatus = detectAuthStatus();
    const apiKey = getAnthropicApiKey();
    const authMode = resolveAuthMode(requested, authStatus.preferredSource, apiKey != null);
    if (authMode === null) {
      return c.json(
        {
          error:
            "No Claude auth configured. Open the AI panel → Settings to connect Claude Code or paste an API key.",
        },
        428,
      );
    }
    if (authMode === "api-key" && !apiKey) {
      return c.json({ error: "API key auth selected but no key is configured." }, 428);
    }

    const sessionMapKey = sessionKey(project.id, authMode);
    const resumeSessionId = projectSessions.get(sessionMapKey) ?? null;

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      c.req.raw.signal.addEventListener("abort", () => controller.abort());

      const write = (event: AgentEvent) =>
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {});

      try {
        const result = await runAgentTurn({
          authMode,
          ...(authMode === "api-key" && apiKey ? { apiKey } : {}),
          projectDir: project.dir,
          projectId: project.id,
          activeCompPath,
          userMessage,
          resumeSessionId,
          signal: controller.signal,
          adapter,
          project,
          emit: (event) => {
            void write(event);
          },
        });
        if (result.sessionId) projectSessions.set(sessionMapKey, result.sessionId);
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({
            stopReason: result.stopReason,
            sessionId: result.sessionId,
          }),
        });
      } catch (err) {
        await stream
          .writeSSE({
            event: "error",
            data: JSON.stringify({
              message: err instanceof Error ? err.message : String(err),
              recoverable: false,
            }),
          })
          .catch(() => {});
      }
    });
  });
}

function resolveAuthMode(
  requested: string,
  preferred: AuthSource,
  apiKeyAvailable: boolean,
): AuthMode | null {
  if (requested === "claude-code") return "claude-code";
  if (requested === "api-key") return apiKeyAvailable ? "api-key" : null;
  // "auto"
  if (preferred === "claude-code") return "claude-code";
  if (preferred === "api-key" || apiKeyAvailable) return "api-key";
  return null;
}
