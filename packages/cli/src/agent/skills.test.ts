/**
 * Tests for the skill authoring API. Focus on the new `createUserSkill`
 * path (added for the video → skill workflow) plus the existing
 * `createProjectSkill` invariants that we routed through the shared helper.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectSkill, createUserSkill } from "./skills.js";

let projectDir: string;
let homeDir: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hf-skills-proj-"));
  homeDir = mkdtempSync(join(tmpdir(), "hf-skills-home-"));
  // skills.ts reads ~/.claude via os.homedir(); on POSIX that respects $HOME,
  // on Windows it respects %USERPROFILE%. Stub both so the test is portable.
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe("createUserSkill", () => {
  it("writes SKILL.md to ~/.claude/skills/<slug>/", () => {
    const result = createUserSkill({
      name: "Cinematic Intro",
      description: "Bold sans-serif kinetic typography with cubic easing.",
      body: "# Cinematic Intro\n\nPrinciples: foo.",
    });

    expect(result.scope).toBe("user");
    expect(result.dirName).toBe("cinematic-intro");
    expect(result.path).toContain(join(".claude", "skills", "cinematic-intro", "SKILL.md"));
    expect(existsSync(result.path)).toBe(true);

    const written = readFileSync(result.path, "utf-8");
    expect(written).toContain("name: Cinematic Intro");
    expect(written).toContain("description: Bold sans-serif kinetic typography");
    expect(written).toContain("# Cinematic Intro");
  });

  it("rejects an empty name", () => {
    expect(() => createUserSkill({ name: "  ", description: "x", body: "y" })).toThrow(
      /name is required/i,
    );
  });

  it("rejects an empty description", () => {
    expect(() => createUserSkill({ name: "Foo", description: "", body: "y" })).toThrow(
      /description is required/i,
    );
  });

  it("rejects a name with no alphanumerics", () => {
    expect(() => createUserSkill({ name: "!!!", description: "d", body: "b" })).toThrow(
      /alphanumeric/i,
    );
  });

  it("rejects creating the same skill twice", () => {
    createUserSkill({ name: "Glassy", description: "d", body: "b" });
    expect(() => createUserSkill({ name: "Glassy", description: "d2", body: "b2" })).toThrow(
      /already exists/i,
    );
  });
});

describe("createProjectSkill", () => {
  it("writes to <projectDir>/.claude/skills/<slug>/SKILL.md and reports scope", () => {
    const result = createProjectSkill(projectDir, {
      name: "Bold Headlines",
      description: "Loud display copy with heavy weight and high tracking.",
      body: "# Bold Headlines",
    });

    expect(result.scope).toBe("project");
    expect(result.dirName).toBe("bold-headlines");
    expect(result.path.startsWith(projectDir)).toBe(true);
    expect(existsSync(result.path)).toBe(true);
  });

  it("does not write into the user dir even if it would collide", () => {
    // Same slug exists at user scope — project scope should still succeed.
    createUserSkill({ name: "Shared Name", description: "user", body: "u" });
    const result = createProjectSkill(projectDir, {
      name: "Shared Name",
      description: "project",
      body: "p",
    });
    expect(result.scope).toBe("project");
    expect(readFileSync(result.path, "utf-8")).toContain("description: project");
  });
});

describe("createSkillInRoot via createProjectSkill — pre-existing dir without SKILL.md", () => {
  it("still rejects when only the directory exists (collision is on the dir name)", () => {
    mkdirSync(join(projectDir, ".claude", "skills", "stub-only"), { recursive: true });
    expect(() =>
      createProjectSkill(projectDir, {
        name: "stub-only",
        description: "d",
        body: "b",
      }),
    ).toThrow(/already exists/i);
  });
});
