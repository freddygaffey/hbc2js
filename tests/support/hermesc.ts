// docs/specs/00-project-skeleton.md §7.2 — locate tools/hermesc/vNN/hermesc; skip
// helpers. Tests never invoke tools/get-hermesc.sh (offline-safe, side-effect-free).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { repoRoot } from "./paths.ts";
import { requireOracles } from "./tiers.ts";

export type HbcVersion = 84 | 94 | 96 | 98 | 99;

export interface Hermesc {
  readonly version: HbcVersion;
  readonly path: string;
}

export function findHermesc(version: HbcVersion): Hermesc | null {
  const envVar = process.env[`HERMESC_V${version}`];
  if (envVar !== undefined && existsSync(envVar)) return { version, path: envVar };
  const guess = join(repoRoot(), "tools", "hermesc", `v${version}`, "hermesc");
  if (existsSync(guess)) return { version, path: guess };
  return null;
}

export function requireHermesc(t: TestContext, version: HbcVersion): Hermesc | null {
  const h = findHermesc(version);
  if (h === null) {
    const msg = `hermesc v${version} not found (run tools/get-hermesc.sh ${version})`;
    if (requireOracles()) {
      throw new Error(msg);
    }
    t.skip(msg);
    return null;
  }
  return h;
}

export function runHermesc(h: Hermesc, args: readonly string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(h.path, args, { cwd, shell: false, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
