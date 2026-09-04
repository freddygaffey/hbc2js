// tests/projdb/init.test.ts — docs/specs/16-project-db.md §7 A2: `hbc2js
// init` on rn-template-0.72's bundle builds `project.hbcproj` via the fresh
// path (§4.1). Assertions per the spec's A2 description: `ix_functions`
// count == bundle `functionCount`; `ix_modules` agrees with `MODULES.json`
// id-for-id; `meta.index_built_for` verifies; `log` holds exactly `init` +
// `rebuild-index` gen 1; init on an existing `.hbcproj` refuses.
//
// Rung rule (CLAUDE.md testing rules / docs/CONSOLIDATION.md §B): property/
// structural assertions on this rung's own DB, not a literal-string compare
// against a shared fixture's decompiled output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../../src/artifact/schema.ts";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { repoRoot } from "../support/paths.ts";

const CLI = join(repoRoot(), "src", "cli.ts");

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const modulesJson = JSON.parse(splitResult.files.get("MODULES.json")!) as { modules: readonly { id: number; file: string; factoryFunctionIndex: number | null; deps: readonly number[] }[] };

const outDir = mkdtempSync(join(tmpdir(), "hbc2js-projdb-init-"));
const dbPath = join(outDir, "project.hbcproj");

const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
const db = openProjectDb(dbPath);
initProjectDb(db, rows, { actorWho: "test" });
db.close();

test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("A2 ix_functions count == bundle functionCount", () => {
  const check = new DatabaseSync(dbPath, { readOnly: true });
  const n = (check.prepare("SELECT COUNT(*) AS n FROM ix_functions").get() as { n: number }).n;
  const bundleFunctionCount = (check.prepare("SELECT value FROM meta WHERE key='function_count'").get() as { value: string }).value;
  assert.equal(n, Number(bundleFunctionCount));
  assert.equal(n, splitResult.module.functions.length);
  check.close();
});

test("A2 ix_modules agrees with MODULES.json id-for-id", () => {
  const check = new DatabaseSync(dbPath, { readOnly: true });
  const dbModules = check.prepare("SELECT id, file, factory_fn AS factoryFn FROM ix_modules ORDER BY id").all() as { id: number; file: string; factoryFn: number | null }[];
  assert.equal(dbModules.length, modulesJson.modules.length);
  const byId = new Map(modulesJson.modules.map((m) => [m.id, m]));
  for (const row of dbModules) {
    const src = byId.get(row.id);
    assert.ok(src !== undefined, `ix_modules has id ${row.id} not in MODULES.json`);
    assert.equal(row.file, src!.file);
    assert.equal(row.factoryFn, src!.factoryFunctionIndex);
  }
  for (const m of modulesJson.modules) {
    const deps = check.prepare("SELECT dep FROM ix_module_deps WHERE id = ? ORDER BY ord").all(m.id) as { dep: number }[];
    assert.deepEqual(deps.map((d) => d.dep), [...m.deps]);
  }
  check.close();
});

test("A2 meta.index_built_for verifies (recomputes to the same hash)", () => {
  const check = new DatabaseSync(dbPath, { readOnly: true });
  const get = (key: string): string => (check.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string }).value;
  const bundleSha256 = get("bundle_sha256");
  const producerJson = get("producer_json");
  const indexBuiltFor = get("index_built_for");
  assert.equal(indexBuiltFor, sha256Hex(`${bundleSha256}:${producerJson}`));
  assert.equal(bundleSha256, sha256Hex(bytes));
  check.close();
});

test("A2 log holds exactly init + rebuild-index gen 1", () => {
  const check = new DatabaseSync(dbPath, { readOnly: true });
  const logRows = check.prepare("SELECT op, gen FROM log ORDER BY seq").all() as { op: string; gen: number | null }[];
  assert.deepEqual(
    logRows.map((r) => r.op),
    ["init", "rebuild-index"],
  );
  assert.equal(logRows[1]!.gen, 1);
  check.close();
});

test("A2 hbc2js init on an existing .hbcproj refuses (end-to-end CLI)", () => {
  assert.ok(existsSync(dbPath), "precondition: project.hbcproj from module-scope setup must already exist");
  assert.throws(() => execFileSync("node", [CLI, "init", RN_TEMPLATE, "--out", outDir], { encoding: "utf8", stdio: "pipe" }));
  // exit code 3, per runInit's refuse path — captured via the child's own
  // error object rather than a second try/catch, so a genuinely different
  // failure (e.g. a thrown TypeError before the existsSync guard) still
  // fails this assertion instead of being silently accepted as "refused".
  try {
    execFileSync("node", [CLI, "init", RN_TEMPLATE, "--out", outDir], { encoding: "utf8", stdio: "pipe" });
    assert.fail("expected hbc2js init to exit non-zero on an existing project.hbcproj");
  } catch (e) {
    const status = (e as { status: number | null }).status;
    assert.equal(status, 3);
  }
});

test("regression: an `init` project (modules rendered under src/) serves fn source through ArtifactService", async () => {
  // `init` writes the split tree to <out>/src but records bare `module_N.js`
  // names (spec 16 §4.1); `ArtifactService.source` used to join the bare
  // name onto the artifact root and throw ENOENT for every function.
  const { writeSplitResult } = await import("../../src/split/write.ts");
  const { ArtifactService } = await import("../../src/artifact/service.ts");
  writeSplitResult(splitResult, join(outDir, "src"));
  assert.equal(existsSync(join(outDir, "module_0.js")), false, "layout under test: nothing at the root");
  const svc = new ArtifactService(outDir, {});
  const owned = svc.ownedFns(0).filter((f) => f.lines !== null);
  assert.ok(owned.length > 0);
  const text = svc.source(owned[0]!.fn);
  assert.equal(text.split("\n").length, owned[0]!.lines![1] - owned[0]!.lines![0] + 1);
});
