// docs/specs/00-project-skeleton.md §9.2 — repo root resolution for tests, never
// process.cwd(). Deliberately independent of src/util/paths.ts (tests must not
// depend on library internals for their own plumbing).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let cachedRoot: string | undefined;

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

export function repoRoot(): string {
  if (cachedRoot === undefined) {
    cachedRoot = findRepoRootFrom(import.meta.dirname);
  }
  return cachedRoot;
}
