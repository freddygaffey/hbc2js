// tests/gate/cli/hbcproj-status-adopt.test.ts — docs/specs/18-project-
// storage-integrity.md §10 (three-way conflict porcelain) / §R4 step 3,
// exercised end to end via child process (matches tests/gate/cli/
// hbcproj-export.test.ts's own convention): `hbc2js init` a real
// `.hbcproj`, seed a name in-process (same db file, same convention
// `tests/projdb/status-adopt.test.ts` uses), then drive `status`/`diff`/
// `adopt`/`restore` as separate CLI invocations against it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { openProjectDb } from "../../../src/projdb/db.ts";
import { dbSetName } from "../../../src/projdb/annotations.ts";
import { exportWriteEffect } from "../../../src/projdb/export.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function initProjectWithOneName(): { outDir: string; dbPath: string; namesPath: string } {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-hbcproj-status-adopt-cli-"));
  const init = runCli(["init", FIXTURE_HBC, "--out", outDir]);
  assert.equal(init.status, 0, init.stderr);
  const dbPath = join(outDir, "project.hbcproj");
  // `init` mints its own `init`/`rebuild-index` log rows but never exports
  // them (only `hbcproj export`/the write-path hook materialise `log/`,
  // `src/projdb/ix-write.ts`'s `initProjectDb` never touches disk) — export
  // once up front, exactly like a real workflow would, so `log/` starts in
  // sync with the db before this test's own incremental write.
  const bulkExport = runCli(["hbcproj", "export", dbPath]);
  assert.equal(bulkExport.status, 0, bulkExport.stderr);
  const db = openProjectDb(dbPath);
  const { record } = dbSetName(db, "fn:1", "decodePayload", { source: "human", who: "fred" });
  exportWriteEffect(db, outDir, Number(record.rid));
  db.close();
  const namesPath = join(outDir, "analysis", "names", "_unassigned.json");
  assert.ok(existsSync(namesPath));
  return { outDir, dbPath, namesPath };
}

test("hbcproj status --help / diff --help / adopt --help / restore --help all exit 0", () => {
  for (const verb of ["status", "diff", "adopt", "restore"]) {
    const r = runCli(["hbcproj", verb, "--help"]);
    assert.equal(r.status, 0, `${verb}: ${r.stderr}`);
    assert.match(r.stdout, new RegExp(`hbcproj ${verb}`));
  }
});

test("hbcproj status reports clean for a freshly-exported project, then hand-edit after a manual edit", () => {
  const { outDir, dbPath, namesPath } = initProjectWithOneName();
  try {
    const clean = runCli(["hbcproj", "status", dbPath]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /clean: .*names/);

    const parsed = JSON.parse(readFileSync(namesPath, "utf8")) as { entries: Record<string, { name: string }> };
    parsed.entries["fn:1"]!.name = "handEditedName";
    writeFileSync(namesPath, JSON.stringify(parsed), "utf8");

    const edited = runCli(["hbcproj", "status", dbPath]);
    assert.equal(edited.status, 0, edited.stderr);
    assert.match(edited.stdout, /hand-edit: .*names/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("hbcproj diff shows the hand edit vs. the db's current value", () => {
  const { outDir, dbPath, namesPath } = initProjectWithOneName();
  try {
    const parsed = JSON.parse(readFileSync(namesPath, "utf8")) as { entries: Record<string, { name: string }> };
    parsed.entries["fn:1"]!.name = "handEditedName";
    writeFileSync(namesPath, JSON.stringify(parsed), "utf8");

    const r = runCli(["hbcproj", "diff", dbPath]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /handEditedName/);
    assert.match(r.stdout, /decodePayload/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("hbcproj adopt folds a hand edit in, then status/verify --full report clean/OK", () => {
  const { outDir, dbPath, namesPath } = initProjectWithOneName();
  try {
    const parsed = JSON.parse(readFileSync(namesPath, "utf8")) as { entries: Record<string, { name: string }> };
    parsed.entries["fn:1"]!.name = "handEditedName";
    writeFileSync(namesPath, JSON.stringify(parsed), "utf8");

    const adopt = runCli(["hbcproj", "adopt", dbPath, namesPath, "--who", "alice"]);
    assert.equal(adopt.status, 0, adopt.stderr);
    assert.match(adopt.stdout, /adopted: /);

    const status = runCli(["hbcproj", "status", dbPath]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /clean: .*names/);

    const verify = runCli(["hbcproj", "verify", dbPath, "--full"]);
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /OK/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("hbcproj restore discards a hand edit and re-materialises the shard from the db", () => {
  const { outDir, dbPath, namesPath } = initProjectWithOneName();
  try {
    const parsed = JSON.parse(readFileSync(namesPath, "utf8")) as { entries: Record<string, { name: string }> };
    parsed.entries["fn:1"]!.name = "badHandEdit";
    writeFileSync(namesPath, JSON.stringify(parsed), "utf8");

    const restore = runCli(["hbcproj", "restore", dbPath, namesPath]);
    assert.equal(restore.status, 0, restore.stderr);
    assert.match(restore.stdout, /restored: /);

    const restored = JSON.parse(readFileSync(namesPath, "utf8")) as { entries: Record<string, { name: string }> };
    assert.equal(restored.entries["fn:1"]!.name, "decodePayload");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("hbcproj adopt refuses a missing db path", () => {
  const r = runCli(["hbcproj", "adopt", join(tmpdir(), "does-not-exist.hbcproj"), "--all"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist/);
});
