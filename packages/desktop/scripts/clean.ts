/**
 * Wipe build artifacts (binaries, resources, Cargo target).
 */

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { BINARIES_DIR, DESKTOP_ROOT, RESOURCES_DIR, log } from "./_shared.ts";

const TARGETS = [
  BINARIES_DIR,
  RESOURCES_DIR,
  resolve(DESKTOP_ROOT, "src-tauri", "target"),
  resolve(DESKTOP_ROOT, "tmp"),
];

for (const t of TARGETS) {
  if (existsSync(t)) {
    rmSync(t, { recursive: true, force: true });
    log(`removed ${t}`);
  }
}
log("✓ clean");
