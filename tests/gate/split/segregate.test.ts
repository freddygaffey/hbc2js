// tests/gate/split/segregate.test.ts — docs/specs/08-segregation.md §6
// milestone 1 acceptance: `hbc2js segregate` moves a `--split` tree's
// modules into `node_modules/<pkg>/` (library) vs `src/` (custom) vs
// `_unclassified/` (no classify.ts verdict) without changing any factory
// body, and the segregated tree still boots exactly as far as the
// un-segregated one (§4, resolver-equivalence proof).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { splitProject } from "../../../src/split/index.ts";
import { readSplitDir, segregateSplitTree, writeSegregateResult } from "../../../src/split/segregate.ts";
import { runDeps } from "../../../src/deps/index.ts";
import { writeSplitResult } from "../../../src/split/write.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

// The un-segregated boot test (tests/gate/split/loadable.test.ts) pins 76 as
// its floor on this exact fixture; segregation must not make the resolver
// re-run reach any fewer modules (§4.2 — no require() edge segregation
// rewrote should stop resolving).
const MIN_MODULES_RUN = 76;

/** Strips only what segregation is allowed to change (§4): a
 *  `require('./module_<id>.js')` call's string-literal argument. Everything
 *  else in a module file — including its header comment — must come out
 *  byte-identical. */
function normaliseRequireTargets(text: string): string {
  return text.replace(/require\((['"])[^'"]*module_(\d+)\.js\1\)/g, "require(<module_$2>)");
}

void test("segregate: moves rn-template-0.72's split tree into node_modules/ vs src/, no factory body changes, boot still reaches registerComponent", async () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const split = splitProject(bytes, { moduleName: "index.android.hbc" });
  assert.ok(split.modules.length > 0, "split produced no modules");

  const depsRun = await runDeps(RN_TEMPLATE, { offline: true });
  assert.ok(depsRun.report.classification !== null, "deps run produced no classification");

  const seg = segregateSplitTree(split.files, depsRun.report);

  // (c) no module is lost: count in == count out, and every module landed
  // in exactly one of the three buckets.
  assert.equal(seg.modules.length, split.modules.length, "segregation dropped or duplicated a module");
  const seenIds = new Set(seg.modules.map((m) => m.id));
  assert.equal(seenIds.size, split.modules.length, "segregation produced duplicate module ids");
  for (const m of seg.modules) assert.ok(m.bucket === "src" || m.bucket === "node_modules" || m.bucket === "unclassified", `module ${m.id} landed in an unknown bucket ${m.bucket}`);

  // Milestone 1: some modules of each headline kind, on this fixture
  // (DEPS.md's seed-run numbers: ~41% library by weight).
  const srcCount = seg.modules.filter((m) => m.bucket === "src").length;
  const nodeModulesCount = seg.modules.filter((m) => m.bucket === "node_modules").length;
  assert.ok(srcCount > 0, "expected at least one custom module in src/");
  assert.ok(nodeModulesCount > 0, "expected at least one library module in node_modules/");

  // (b) structural proof: every module's file, modulo require() target
  // strings, is byte-identical before and after segregation.
  for (const m of split.modules) {
    const before = split.files.get(m.file);
    const after = seg.files.get(seg.modules.find((s) => s.id === m.id)!.newPath);
    assert.ok(before !== undefined && after !== undefined, `module ${m.id} missing before/after text`);
    assert.equal(normaliseRequireTargets(after!), normaliseRequireTargets(before!), `module ${m.id}'s factory body changed during segregation`);
  }

  // (a) behavioural proof: reuse tools/e2e/boot-split.mjs, pointed at the
  // segregated tree on disk (its only input is a directory + index.js).
  const splitDir = mkdtempSync(join(tmpdir(), "hbc2js-segregate-split-"));
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-segregate-out-"));
  try {
    writeSplitResult(split, splitDir);
    const reread = segregateSplitTree(readSplitDir(splitDir), depsRun.report);
    writeSegregateResult(reread, outDir);

    const r = spawnSync(process.execPath, [join(repoRoot(), "tools", "e2e", "boot-split.mjs"), outDir, "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, `boot-split.mjs exited ${r.status}: ${r.stderr}`);
    const result = JSON.parse(r.stdout) as { modulesExecuted: number; reachedRegisterComponent: boolean; componentName: string | null; firstThrow: unknown };
    assert.ok(result.modulesExecuted >= MIN_MODULES_RUN, `only ${result.modulesExecuted} module(s) ran on the segregated tree (floor ${MIN_MODULES_RUN})`);
    assert.equal(result.reachedRegisterComponent, true, `segregated tree did not reach AppRegistry.registerComponent (first throw: ${JSON.stringify(result.firstThrow)})`);
    assert.equal(result.componentName, "HelloHermes072");
  } finally {
    rmSync(splitDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
