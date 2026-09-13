// tests/projdb/init-real-bundle.test.ts — regression for docs/BUGS.md
// 2026-09-13 "UNIQUE constraint failed: ix_ranges.fn" row (readability lane,
// queue item 2): `hbc2js init` on a real Metro-shaped bundle
// (react-navigation-example-0.85.3) crashed inside `initProjectDb` because
// `src/split/index.ts`'s factory-mark loop assumed every non-"factory"
// `onFunctionRange` name matched `_fn<idx>` exactly and called
// `Number(name.replace(/^_fn/, ""))` on it. A duplicated closure copy
// (`src/emit/index.ts`'s `copyNameOf`, `_fn<idx>__c<copy>` for `copy > 0`)
// leaves a `__c<n>` suffix behind, so that call produced `NaN`. A `NaN`
// bound as a `node:sqlite` `INTEGER PRIMARY KEY` (`ix_ranges.fn`) silently
// auto-assigns the next free rowid instead of erroring immediately — the
// crash only surfaces later, when a legitimate row with that same fn id is
// inserted and collides with the auto-assigned one.
//
// Rung rule (CLAUDE.md testing rules): structural/property assertions only,
// no literal-string compare against this shared fixture's decompiled output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";

const FIXTURE_DIR = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3");
const RELEASE_HBC = join(FIXTURE_DIR, "react-navigation-example.hbc");
const DEBUG_HBC = join(FIXTURE_DIR, "react-navigation-example.debug.hbc");

// docs/lanes/readability.md's own note: uncommitted (gitignored real-world
// `.hbc`), fetched by `tests/fixtures/bundles/react-navigation-example-0.85.3/
// fetch.sh` — skip rather than fail when it is not present.
const haveFixture = existsSync(RELEASE_HBC) && existsSync(DEBUG_HBC);

void test("unit: a duplicated closure copy's onFunctionRange name (`_fn<idx>__c<copy>`) parses to its ORIGINAL numeric fn id, not NaN", (t) => {
  if (!haveFixture) {
    t.skip("react-navigation-example-0.85.3 not fetched (run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh)");
    return;
  }
  const bytes = readFileSync(RELEASE_HBC);
  const splitResult = splitProject(bytes, { moduleName: "react-navigation-example.hbc" });

  // The exact duplicate shape this bug was found on: fn#13435 gets emitted
  // as multiple closure copies (`_fn13435`, `_fn13435__c1`, `_fn13435__c2`,
  // `_fn13435__c3`) inside module_1682.js — confirmed by grepping the
  // fixture's own split output for "__c" once, kept here as a documented
  // fact rather than re-derived every run.
  const module1682 = splitResult.files.get("module_1682.js");
  assert.ok(module1682 !== undefined, "module_1682.js should exist in this fixture's split output");
  assert.match(module1682!, /_fn13435__c1\b/, "fixture no longer contains the duplicated-closure shape this regression test targets");

  // No onFunctionRange name should ever have failed to parse into a real
  // fn id: every key in the map is a non-negative integer, never NaN.
  for (const fn of splitResult.functionRanges.keys()) {
    assert.ok(Number.isInteger(fn) && fn >= 0, `functionRanges has a non-integer key: ${fn}`);
  }

  // fn#13435 (the base copy, copy 0) still gets a recorded range — the fix
  // must not drop the range entirely, only stop mis-parsing the suffixed
  // copy names.
  assert.ok(splitResult.functionRanges.has(13435), "fn#13435 should still have a recorded range");

  // No diagnostic reports a dropped/unparseable range for this bundle.
  const dropped = splitResult.diagnostics.filter((d) => d.includes("does not match _fn<idx>"));
  assert.deepEqual(dropped, [], `expected no dropped function ranges, got: ${dropped.join(" | ")}`);
});

void test("regression: hbc2js init succeeds end-to-end on react-navigation-example-0.85.3 (release + debug .hbc)", (t) => {
  if (!haveFixture) {
    t.skip("react-navigation-example-0.85.3 not fetched (run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh)");
    return;
  }
  for (const [label, hbcPath] of [
    ["release", RELEASE_HBC],
    ["debug", DEBUG_HBC],
  ] as const) {
    const bytes = readFileSync(hbcPath);
    const splitResult = splitProject(bytes, { moduleName: `react-navigation-example${label === "debug" ? ".debug" : ""}.hbc` });
    const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });

    // The exact shape of the original crash: no two rangeRows share an fn,
    // and none is NaN (the auto-rowid-assignment failure mode this bug hit).
    const seen = new Set<number>();
    for (const r of rows.rangeRows) {
      assert.ok(!Number.isNaN(r.fn), `${label}: rangeRows contains a NaN fn (file ${r.file})`);
      assert.ok(!seen.has(r.fn), `${label}: rangeRows has a duplicate fn ${r.fn}`);
      seen.add(r.fn);
    }

    const outDir = mkdtempSync(join(tmpdir(), `hbc2js-init-real-bundle-${label}-`));
    const dbPath = join(outDir, "project.hbcproj");
    try {
      const db = openProjectDb(dbPath);
      try {
        // Must not throw "UNIQUE constraint failed: ix_ranges.fn" (the
        // exact failure this regression test is named after).
        initProjectDb(db, rows, { actorWho: "test" });
      } finally {
        db.close();
      }
      const check = new DatabaseSync(dbPath, { readOnly: true });
      const n = (check.prepare("SELECT COUNT(*) AS n FROM ix_ranges").get() as { n: number }).n;
      assert.equal(n, rows.rangeRows.length, `${label}: ix_ranges row count should match rangeRows`);
      check.close();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }
});
