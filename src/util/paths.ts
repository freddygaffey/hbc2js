// docs/specs/00-project-skeleton.md §9.2 — repo root resolution, never process.cwd().
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let cachedRoot: string | undefined;

/** Walk up from `startDir` to the first ancestor containing package.json. */
function findRepoRootFrom(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`repoRoot: no package.json found walking up from ${startDir}`);
    }
    dir = parent;
  }
}

/** Repo root, resolved from this module's own location (not process.cwd()), cached. */
export function repoRoot(): string {
  if (cachedRoot === undefined) {
    cachedRoot = findRepoRootFrom(import.meta.dirname);
  }
  return cachedRoot;
}
