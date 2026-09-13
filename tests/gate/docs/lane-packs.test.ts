// docs/lanes/*.md are lane packs: a worker's whole orientation for one lane
// (Fred, 2026-09-13: pay orientation once per lane, respawn per task from the
// pack). A pack that cites a file which no longer exists misleads the next
// worker, so every backticked repo path in a pack must exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const lanesDir = join(repoRoot, "docs", "lanes");

/** A backticked token that looks like a repo path: contains a `/`, starts
 *  with a known top-level directory, and has no glob, angle-bracket
 *  placeholder or CLI-flag characters. */
const PATH_RE = /`((?:src|docs|tests|tools|skills|ui)\/[A-Za-z0-9_./-]+)`/g;

test("docs/lanes: every lane pack exists, has the required sections, and cites only files that exist", () => {
  assert.ok(existsSync(lanesDir), "docs/lanes/ is missing");
  const packs = readdirSync(lanesDir).filter((f) => f.endsWith(".md"));
  assert.ok(packs.length >= 1, "docs/lanes/ has no packs");
  const missing: string[] = [];
  for (const pack of packs) {
    const text = readFileSync(join(lanesDir, pack), "utf8");
    for (const section of ["## Files and what owns what", "## Test commands", "## Gotchas", "## Queue", "## Last update"]) {
      assert.ok(text.includes(section), `${pack}: missing section starting "${section}"`);
    }
    // The queue section names files a future task will CREATE; only the
    // orientation sections (everything before it) must cite existing paths.
    const queueAt = text.indexOf("## Queue");
    const orientation = queueAt >= 0 ? text.slice(0, queueAt) : text;
    for (const m of orientation.matchAll(PATH_RE)) {
      const p = m[1]!;
      if (p.includes("*") || p.includes("<")) continue;
      // A path with a file extension or a trailing slash must exist as written;
      // a bare directory name too.
      if (!existsSync(join(repoRoot, p))) missing.push(`${pack}: ${p}`);
    }
  }
  assert.deepEqual(missing, [], `lane packs cite paths that do not exist:\n${missing.join("\n")}`);
});
