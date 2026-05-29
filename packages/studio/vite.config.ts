import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { readNodeRequestBody } from "./vite.request-body.js";
import { createViteAdapter, isPathWithin } from "./vite.adapter";

async function loadRuntimeSourceForDev(
  server: import("vite").ViteDevServer,
): Promise<string | null> {
  try {
    const mod = await server.ssrLoadModule(
      resolve(__dirname, "../core/src/inline-scripts/hyperframe.ts"),
    );
    if (typeof mod.loadHyperframeRuntimeSource === "function") {
      return mod.loadHyperframeRuntimeSource();
    }
  } catch (err) {
    console.warn("[Studio] Failed to load runtime source from core:", err);
  }
  return null;
}

// ── Bridge Hono fetch → Node http response ───────────────────────────────────

async function bridgeHonoResponse(
  honoResponse: Response,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const headers: Record<string, string> = {};
  honoResponse.headers.forEach((v, k) => {
    headers[k] = v;
  });
  res.writeHead(honoResponse.status, headers);

  if (!honoResponse.body) {
    res.end();
    return;
  }

  const reader = honoResponse.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    /* client disconnected */
  }
  res.end();
}

// ── Vite plugin ──────────────────────────────────────────────────────────────

function devProjectApi(): Plugin {
  const dataDir = resolve(__dirname, "data/projects");
  const runtimePath = resolve(__dirname, "../core/dist/hyperframe.runtime.iife.js");

  return {
    name: "studio-dev-api",
    configureServer(server): void {
      let _api: { fetch: (req: Request) => Promise<Response> } | null = null;
      let _agentRoutesLoaded = false;
      let _agentRoutesError: string | null = null;
      const getApi = async () => {
        // Only cache the api once agent routes load successfully — otherwise
        // every credentials request would 404 until the user manually
        // restarts Vite. By retrying on each request after a failure, the
        // user can fix the import issue and just refresh the page.
        if (_api && _agentRoutesLoaded) return { api: _api, error: null as string | null };

        const mod = await server.ssrLoadModule("@hyperframes/core/studio-api");
        const adapter = createViteAdapter(dataDir, server);
        const api = _api ?? mod.createStudioApi(adapter);

        if (!_agentRoutesLoaded) {
          try {
            const agentMod = await server.ssrLoadModule("../cli/src/agent/routes");
            (agentMod.registerAgentRoutes as (a: unknown, b: unknown, c: string) => void)(
              api,
              adapter,
              "",
            );
            _agentRoutesLoaded = true;
            _agentRoutesError = null;
          } catch (err) {
            _agentRoutesError = err instanceof Error ? err.stack || err.message : String(err);
            console.error("[Studio] Failed to load agent routes:\n", _agentRoutesError);
          }
        }

        _api = api;
        return { api, error: _agentRoutesError };
      };

      // Runtime endpoint — prefer source build over dist artifact
      server.middlewares.use((req, res, next) => {
        if (req.url !== "/api/runtime.js") return next();
        const serve = async () => {
          let runtimeSource = await loadRuntimeSourceForDev(server);
          if (!runtimeSource && existsSync(runtimePath)) {
            runtimeSource = readFileSync(runtimePath, "utf-8");
          }
          if (!runtimeSource) {
            res.writeHead(404);
            res.end("runtime not available — build packages/core or load runtime source");
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/javascript",
            "Cache-Control": "no-store",
          });
          res.end(runtimeSource);
        };
        void serve().catch((err) => {
          console.error("[Studio runtime] Failed to serve runtime", err);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("failed to serve runtime");
          }
        });
      });

      // API middleware
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        try {
          const { api, error: agentLoadError } = await getApi();
          // If a credentials request hits the API but the agent routes
          // module failed to load (the part that registers them), respond
          // with the actual loader error so the user sees it instead of a
          // confusing 404. Without this, requests fall through to Hono's
          // default `404 Not Found` plain-text response and the chat panel
          // says "Endpoint not found" with no clue about the real cause.
          if (agentLoadError && req.url.startsWith("/api/credentials")) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: `Agent routes failed to load in dev. Check the Vite terminal for "[Studio] Failed to load agent routes". Excerpt: ${agentLoadError.split("\n").slice(0, 3).join(" | ").slice(0, 400)}`,
              }),
            );
            return;
          }
          const url = new URL(req.url, `http://${req.headers.host}`);
          url.pathname = url.pathname.slice(4);
          let body: Buffer | undefined;
          if (req.method !== "GET" && req.method !== "HEAD") {
            const bytes = await readNodeRequestBody(req);
            body = bytes.byteLength > 0 ? bytes : undefined;
          }
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (value != null) headers[key] = Array.isArray(value) ? value.join(", ") : value;
          }
          const fetchReq = new Request(url.toString(), {
            method: req.method,
            headers,
            body,
          });
          const response = await api.fetch(fetchReq);
          await bridgeHonoResponse(response, res);
        } catch (err) {
          console.error("[Studio API] Error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        }
      });

      // Watch project directories for file changes → HMR
      const realProjectPaths: string[] = [];
      try {
        for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
          const full = join(dataDir, entry.name);
          try {
            const real = lstatSync(full).isSymbolicLink() ? realpathSync(full) : full;
            realProjectPaths.push(real);
            server.watcher.add(real);
          } catch {
            /* skip broken symlinks */
          }
        }
      } catch {
        /* dataDir doesn't exist yet */
      }

      server.watcher.on("change", (filePath: string) => {
        const isProjectFile = realProjectPaths.some((p) => isPathWithin(p, filePath));
        if (
          isProjectFile &&
          (filePath.endsWith(".html") ||
            filePath.endsWith(".css") ||
            filePath.endsWith(".js") ||
            filePath.endsWith(".json"))
        ) {
          console.log(`[Studio] File changed: ${filePath}`);
          server.ws.send({ type: "custom", event: "hf:file-change", data: { path: filePath } });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devProjectApi()],
  define: {
    __STUDIO_VERSION__: JSON.stringify(process.env.npm_package_version ?? "dev"),
  },
  resolve: {
    alias: {
      "@hyperframes/player": resolve(__dirname, "../player/src/hyperframes-player.ts"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5190,
  },
});
