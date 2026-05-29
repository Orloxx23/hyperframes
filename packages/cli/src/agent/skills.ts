/**
 * Skills discovery, configuration, and authoring for the in-Studio AI chat.
 *
 * Claude Code skills live as `<dir>/SKILL.md` files with a YAML frontmatter
 * `name` and `description`. The Agent SDK reads them from two locations when
 * `settingSources` includes the matching source:
 *
 *   - `~/.claude/skills/<name>/SKILL.md`              (scope: user)
 *   - `<projectDir>/.claude/skills/<name>/SKILL.md`   (scope: project)
 *
 * This module surfaces those skills to Studio's UI and lets users curate
 * which ones the agent actually sees on a per-project basis.
 *
 * The per-project enable list lives at `<projectDir>/.hyperframes/skills.json`.
 * Shape: `{ enabled: string[] | null }` — `null` means "all enabled" (the
 * default before the user ever curates), an array means "only these names".
 */

import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type SkillScope = "user" | "project";

export interface InstalledSkill {
  /** Skill name from frontmatter (or directory name fallback). */
  name: string;
  /** One-paragraph description from frontmatter. */
  description: string;
  scope: SkillScope;
  /** Absolute path to the SKILL.md file. */
  path: string;
  /** Whether this skill is currently enabled for the project. */
  enabled: boolean;
}

export interface SkillsConfig {
  /** null = all enabled (default). string[] = only the listed names are enabled. */
  enabled: string[] | null;
}

export interface CatalogEntry {
  /** Identifier used as `npx skills add <slug>` (e.g. "heygen-com/hyperframes"). */
  slug: string;
  /** Display title. */
  title: string;
  /** One-paragraph description. */
  description: string;
  /** Optional tag for filtering ("style", "runtime", "utility"). */
  category?: string;
}

// ── Frontmatter parser ─────────────────────────────────────────────────────

/**
 * Minimal YAML-frontmatter reader tuned for SKILL.md files. Returns the
 * `name` and `description` fields and ignores everything else. We don't
 * pull in a full YAML parser because:
 *   1. The Claude Code skill format only requires these two keys.
 *   2. Both are single-line in every observed skill (the description can
 *      be very long, but it's still one logical line).
 *   3. Adding a YAML dep would balloon the CLI bundle.
 *
 * If a value is wrapped in matching quotes we strip them; otherwise we
 * keep the raw string. Multi-line YAML block scalars (`>` / `|`) fall back
 * to the first line only — acceptable for the curate-and-toggle UX.
 */
function parseFrontmatter(source: string): { name: string; description: string } | null {
  if (!source.startsWith("---")) return null;
  const end = source.indexOf("\n---", 3);
  if (end < 0) return null;
  const block = source.slice(3, end).replace(/^\r?\n/, "");
  const lines = block.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  const name = fields.name?.trim();
  if (!name) return null;
  return { name, description: fields.description?.trim() ?? "" };
}

// ── Discovery ──────────────────────────────────────────────────────────────

function userSkillsRoot(): string {
  return join(homedir(), ".claude", "skills");
}

function projectSkillsRoot(projectDir: string): string {
  return join(projectDir, ".claude", "skills");
}

/**
 * Bridge `<projectDir>/.agents/skills/` (where the `skills` npm CLI installs
 * by default) over to `<projectDir>/.claude/skills/` (where the Agent SDK
 * actually reads from).
 *
 * Background: the `skills` CLI claims it sets up symlinks for "Claude Code"
 * but on Windows that step silently fails without Developer Mode or admin
 * privileges, leaving the user with skills the agent can't see. We bridge
 * it ourselves using junctions (directory-only, no elevation required on
 * Windows) with a recursive-copy fallback.
 *
 * Idempotent: skips entries that already exist on the destination side.
 * Best-effort: any per-entry failure is swallowed so a single bad skill
 * doesn't break the whole listing.
 */
function mirrorAgentsSkills(projectDir: string): void {
  const src = join(projectDir, ".agents", "skills");
  if (!existsSync(src)) return;

  let srcStat;
  try {
    srcStat = statSync(src);
  } catch {
    return;
  }
  if (!srcStat.isDirectory()) return;

  const dst = projectSkillsRoot(projectDir);
  if (!existsSync(dst)) mkdirSync(dst, { recursive: true });

  let entries: string[];
  try {
    entries = readdirSync(src);
  } catch {
    return;
  }

  for (const entry of entries) {
    const srcPath = join(src, entry);
    const dstPath = join(dst, entry);
    if (existsSync(dstPath)) continue;
    try {
      // `junction` is Windows-only metadata that allows directory symlinks
      // without the SeCreateSymbolicLink privilege. On POSIX, node ignores
      // the third arg and creates a normal symlink.
      symlinkSync(srcPath, dstPath, "junction");
    } catch {
      try {
        cpSync(srcPath, dstPath, { recursive: true });
      } catch {
        /* skip — don't let one bad skill break the listing */
      }
    }
  }
}

function readSkillsFromRoot(root: string, scope: SkillScope): InstalledSkill[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: InstalledSkill[] = [];
  for (const dirName of entries) {
    const dir = join(root, dirName);
    let dirStat;
    try {
      dirStat = statSync(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    const skillPath = join(dir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    let body: string;
    try {
      body = readFileSync(skillPath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatter(body);
    const name = parsed?.name ?? dirName;
    const description = parsed?.description ?? "";
    out.push({
      name,
      description,
      scope,
      path: skillPath,
      // The caller fills in `enabled` once it has the project config.
      enabled: true,
    });
  }
  return out;
}

/**
 * List every installed skill the agent could see, annotated with whether
 * it's currently enabled for this project.
 *
 * If the same skill name appears in both user and project scopes, both
 * entries are returned — they're distinct sources even though the SDK
 * resolves precedence in its own way.
 */
export function listInstalledSkills(projectDir: string): InstalledSkill[] {
  // Auto-bridge `.agents/skills/` → `.claude/skills/` so skills installed
  // by `npx skills add` actually show up (and become visible to the SDK).
  mirrorAgentsSkills(projectDir);

  const config = readSkillsConfig(projectDir);
  const isEnabled = (name: string): boolean =>
    config.enabled === null ? true : config.enabled.includes(name);

  const user = readSkillsFromRoot(userSkillsRoot(), "user").map((s) => ({
    ...s,
    enabled: isEnabled(s.name),
  }));
  const project = readSkillsFromRoot(projectSkillsRoot(projectDir), "project").map((s) => ({
    ...s,
    enabled: isEnabled(s.name),
  }));
  return [...project, ...user].sort((a, b) => a.name.localeCompare(b.name));
}

/** Names of skills currently enabled for the project. Used by agentLoop. */
export function enabledSkillNames(projectDir: string): string[] | "all" {
  const config = readSkillsConfig(projectDir);
  if (config.enabled === null) return "all";
  return config.enabled.slice();
}

// ── Per-project config ─────────────────────────────────────────────────────

function configPath(projectDir: string): string {
  return join(projectDir, ".hyperframes", "skills.json");
}

export function readSkillsConfig(projectDir: string): SkillsConfig {
  const file = configPath(projectDir);
  if (!existsSync(file)) return { enabled: null };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { enabled?: unknown };
    if (Array.isArray(parsed.enabled) && parsed.enabled.every((v) => typeof v === "string")) {
      return { enabled: parsed.enabled as string[] };
    }
    return { enabled: null };
  } catch {
    return { enabled: null };
  }
}

function writeSkillsConfig(projectDir: string, config: SkillsConfig): void {
  const file = configPath(projectDir);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Flip one skill on/off and persist. If `enabled === null` was the prior
 * state (meaning "all on"), we materialize the implicit list first so the
 * disable actually takes effect.
 */
export function setSkillEnabled(projectDir: string, name: string, enabled: boolean): SkillsConfig {
  const config = readSkillsConfig(projectDir);
  if (config.enabled === null) {
    // Materialize "all" into the actual installed-skills list, then mutate.
    const allNames = listInstalledSkills(projectDir).map((s) => s.name);
    const dedup = Array.from(new Set(allNames));
    config.enabled = enabled
      ? dedup // no-op enable — but record the snapshot so future skills are explicit
      : dedup.filter((n) => n !== name);
  } else {
    const set = new Set(config.enabled);
    if (enabled) set.add(name);
    else set.delete(name);
    config.enabled = Array.from(set);
  }
  writeSkillsConfig(projectDir, config);
  return config;
}

// ── Authoring (create a new project skill) ─────────────────────────────────

/** Lowercase kebab slug — what the directory under .claude/skills/ is named. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export interface CreateProjectSkillInput {
  name: string;
  description: string;
  /** Optional body — if omitted, a minimal placeholder is written. */
  body?: string;
}

export interface CreateProjectSkillResult {
  path: string;
  dirName: string;
  scope: SkillScope;
}

function createSkillInRoot(
  root: string,
  scope: SkillScope,
  input: CreateProjectSkillInput,
): CreateProjectSkillResult {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) throw new Error("Skill name is required.");
  if (!description) throw new Error("Skill description is required.");
  const slug = slugify(name);
  if (!slug) throw new Error("Skill name must contain at least one alphanumeric character.");

  const dir = join(root, slug);
  if (existsSync(dir)) {
    throw new Error(
      `A ${scope} skill named "${slug}" already exists. Pick a different name or add a discriminator (e.g. "${slug}-v2").`,
    );
  }
  mkdirSync(dir, { recursive: true });

  const body =
    input.body?.trim() ||
    [
      `# ${name}`,
      "",
      "Document the editing style, runtime, or workflow this skill covers.",
      "Be specific about *when* the agent should invoke it — the description",
      "above is what the model uses to decide.",
    ].join("\n");

  const md = [`---`, `name: ${name}`, `description: ${description}`, `---`, "", body, ""].join(
    "\n",
  );
  const skillPath = join(dir, "SKILL.md");
  writeFileSync(skillPath, md, "utf-8");
  return { path: skillPath, dirName: slug, scope };
}

/**
 * Write a new skill into `<projectDir>/.claude/skills/<slug>/SKILL.md`. The
 * caller is expected to validate inputs (we still enforce the bare minimum:
 * non-empty name + description, slug uniqueness within the project).
 */
export function createProjectSkill(
  projectDir: string,
  input: CreateProjectSkillInput,
): CreateProjectSkillResult {
  return createSkillInRoot(projectSkillsRoot(projectDir), "project", input);
}

/**
 * Write a new skill into `~/.claude/skills/<slug>/SKILL.md`. Used by the
 * `create_skill` MCP tool when the agent generates a reusable skill (e.g.
 * from a reference video). User skills are visible across every project.
 */
export function createUserSkill(input: CreateProjectSkillInput): CreateProjectSkillResult {
  return createSkillInRoot(userSkillsRoot(), "user", input);
}

// ── Curated catalog + install ──────────────────────────────────────────────

/**
 * Hand-curated list of skills we recommend to Hyperframes users. Editing
 * this array is the only step needed to ship a new entry — the Studio UI
 * picks it up automatically. Slugs must resolve via `npx skills add`.
 */
export const SKILL_CATALOG: CatalogEntry[] = [
  {
    slug: "heygen-com/hyperframes",
    title: "Hyperframes (official)",
    description:
      "Full Hyperframes authoring contract: composition structure, timing, GSAP timelines, media, and the production workflow. Recommended baseline.",
    category: "style",
  },
];

export interface InstallResult {
  ok: boolean;
  /** Combined stdout+stderr from the install subprocess (best-effort). */
  output: string;
  error?: string;
}

/** Hard ceiling on how long we let `npx skills add` run before killing it. */
const INSTALL_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Run `npx skills add <slug>` in the user's shell. Skills install into
 * `~/.claude/skills/` so the cwd doesn't matter, but we still pass the
 * project dir for predictability (some skill installers may scope to it).
 *
 * Hardening:
 *   - `stdio[0]` is "ignore" so any interactive prompt the child tries to
 *     issue returns EOF immediately instead of hanging the request forever.
 *   - Subprocess stdout+stderr is mirrored to the Studio server's stderr,
 *     so users can watch progress in the terminal that started Studio.
 *   - A hard timeout kills the child if it stalls (cold-cache `npx` can
 *     legitimately take ~30s; we wait up to 3 minutes before giving up).
 *
 * Returns the captured output so the UI can surface it in case of failure.
 */
export function installSkill(slug: string, projectDir: string): Promise<InstallResult> {
  return new Promise((resolveResult) => {
    // `--yes` skips the `npx` "ok to proceed?" prompt; without it `npx`
    // hangs forever the first time a package is fetched on a clean cache.
    const args = ["--yes", "skills", "add", slug];
    process.stderr.write(`[studio] installing skill: npx ${args.join(" ")}\n`);

    const child = spawn("npx", args, {
      cwd: projectDir,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", npm_config_yes: "true" },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let settled = false;
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      output += text;
      // Mirror to Studio's terminal so the user has live visibility.
      process.stderr.write(text);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      resolveResult({
        ok: false,
        output,
        error: `npx skills add timed out after ${INSTALL_TIMEOUT_MS / 1000}s. Try running the command manually: npx skills add ${slug}`,
      });
    }, INSTALL_TIMEOUT_MS);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({ ok: false, output, error: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) resolveResult({ ok: true, output });
      else resolveResult({ ok: false, output, error: `npx skills add exited with code ${code}` });
    });
  });
}
