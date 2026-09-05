// tests/secrets/cli-db-backed.test.ts — regression for docs/BUGS.md
// "SecretsService" row: `hbc2js secrets <verb> --artifact <dir>` threw
// ENOENT on a DB-backed (.hbcproj-only, spec 16 §2.4) artifact because
// `runSecrets` (src/cli.ts) constructed `SecretsService` without an
// `ArtifactService`, forcing the legacy direct-disk `index/strings.json`/
// `index/string-uses.jsonl` read path that a DB-backed project never
// writes. Same DB-backed-artifact construction as
// tests/mcp/leads-search.test.ts (writeSplitResult + buildIndexRows +
// initProjectDb, no index/*.jsonl on disk at all) — no manifest.json,
// no index/ directory, only `project.hbcproj`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "v94.hbc");

function buildDbBackedArtifact(): string {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-secrets-cli-dbbacked-"));
  const bytes = readFileSync(FIXTURE_HBC);
  const splitResult = splitProject(bytes, { moduleName: "index.hbc" });
  writeSplitResult(splitResult, dir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(dir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  return dir;
}

test("secrets scan succeeds against a DB-backed (.hbcproj-only) artifact, not just JSONL (docs/BUGS.md SecretsService)", () => {
  const dir = buildDbBackedArtifact();
  try {
    assert.ok(!existsSync(join(dir, "manifest.json")), "fixture must be DB-backed only, no manifest.json");
    assert.ok(!existsSync(join(dir, "index", "strings.json")), "fixture must have no legacy jsonl string index");
    const out = execFileSync("node", [CLI, "secrets", "scan", "--force", "--artifact", dir], { encoding: "utf8" });
    assert.match(out, /\bnew\b.*\bcached\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
