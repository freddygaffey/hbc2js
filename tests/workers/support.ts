// tests/workers/support.ts — the rung-private fixture for the worker tests
// (docs/specs/23-ui-workers.md §8). Builds a real `.hbcproj` from the
// committed RN-template bundle exactly the way `tests/mcp/tools.test.ts`
// does — same recipe, reused deliberately so the worker path is exercised
// against the same project shape the MCP write tools are.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

export const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

/** The same function `tests/mcp/{resources,tools}.test.ts` use: it owns a real
 *  source range, so `fn:188` is a resolvable target for a write. */
export const FN = 188;

export function buildProject(): string {
  const bytes = readFileSync(RN_TEMPLATE);
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-workers-"));
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  return outDir;
}

export function projectDbPath(dir: string): string {
  return join(dir, "project.hbcproj");
}
