// tests/gate/cli/hbcproj-export.test.ts — docs/specs/18-project-storage-
// integrity.md §9 `export` verb (§R4 step 0), exercised via child process
// (matches tests/gate/cli/deps.test.ts's own convention): `hbc2js init` a
// real `.hbcproj`, then `hbc2js hbcproj export` it and check the shard
// layout lands on disk next to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("hbcproj export --help prints usage and exits 0", () => {
  const r = runCli(["hbcproj", "export", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hbcproj export/);
});

test("hbcproj export with no db path exits 2", () => {
  const r = runCli(["hbcproj", "export"]);
  assert.equal(r.status, 2);
});

test("hbcproj export materialises analysis/ + log/ next to a real project.hbcproj", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-hbcproj-export-cli-"));
  try {
    const init = runCli(["init", FIXTURE_HBC, "--out", outDir]);
    assert.equal(init.status, 0, init.stderr);
    const dbPath = join(outDir, "project.hbcproj");
    assert.ok(existsSync(dbPath));

    const first = runCli(["hbcproj", "export", dbPath]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /wrote \d+ shard\(s\)/);
    assert.ok(existsSync(join(outDir, "analysis")));
    assert.ok(existsSync(join(outDir, "log")));

    // re-export of unchanged state is a no-op (§14) — surfaced via the CLI too.
    const before = readdirSync(join(outDir, "log"));
    const second = runCli(["hbcproj", "export", dbPath]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /wrote 0 shard\(s\)/);
    assert.deepEqual(readdirSync(join(outDir, "log")), before);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("hbcproj export refuses a missing db path", () => {
  const r = runCli(["hbcproj", "export", join(tmpdir(), "does-not-exist.hbcproj")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist/);
});

test("hbcproj with an unknown verb exits 2 with a clear message", () => {
  const r = runCli(["hbcproj", "bogus-verb"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown or unimplemented verb/);
});
