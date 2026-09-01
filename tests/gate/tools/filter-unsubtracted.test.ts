// CONSOLIDATION 28 — a partial/interrupted bulk sigdb build must never be
// layered into a real signature DB until baseline subtraction is done for
// every file. docs/DEPS.md's "Data hygiene" note (§ "The D17c bulk DB")
// records `subtractedBaselines` (non-empty) as the on-disk marker that
// subtraction happened; `tools/pkgsig/filter-unsubtracted.mjs` is the hard
// check that quarantines any non-baseline file missing that marker, and
// `tools/pkgsig/fetch-db.sh` always runs it (unconditionally, no flag to
// skip) after extracting an archive, before the DB is considered ready. No
// prior gate test covered this mechanism directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// tools/pkgsig/filter-unsubtracted.d.mts supplies the type (allowJs is off
// per tsconfig.json, so a bare .mjs import would otherwise be TS7016).
import { filterUnsubtracted } from "../../../tools/pkgsig/filter-unsubtracted.mjs";

function makeDir() {
  return mkdtempSync(join(tmpdir(), "hbc2js-sigdb-test-"));
}

test("a non-baseline file with subtractedBaselines: [] (unsubtracted) is hard-quarantined, not layered", () => {
  const dir = makeDir();
  try {
    writeFileSync(
      join(dir, "amplitude-react-native@2.17.0__hbc94.json"),
      JSON.stringify({ package: "@amplitude/react-native", version: "2.17.0", hbcVersion: 94, toolchainBaseline: false, subtractedBaselines: [], functions: [1, 2, 3] }),
    );
    const rejected = filterUnsubtracted(dir);
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]?.package, "@amplitude/react-native");
    assert.ok(!existsSync(join(dir, "amplitude-react-native@2.17.0__hbc94.json")), "unsubtracted file must be moved out of the loadable directory");
    assert.ok(existsSync(join(dir, "_rejected-unsubtracted", "amplitude-react-native@2.17.0__hbc94.json")), "quarantined copy must exist for audit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a correctly-subtracted file (non-empty subtractedBaselines) is left in place", () => {
  const dir = makeDir();
  try {
    const name = "react-redux@8.0.0__hbc99.json";
    writeFileSync(join(dir, name), JSON.stringify({ package: "react-redux", version: "8.0.0", hbcVersion: 99, toolchainBaseline: false, subtractedBaselines: ["rn-template-0.72"], functions: [1] }));
    const rejected = filterUnsubtracted(dir);
    assert.equal(rejected.length, 0);
    assert.ok(existsSync(join(dir, name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a baseline file itself (toolchainBaseline: true) is exempt even with an empty subtractedBaselines array", () => {
  const dir = makeDir();
  try {
    const name = "rn-template-0.72__hbc94.json";
    writeFileSync(join(dir, name), JSON.stringify({ package: "rn-template-0.72", version: "0.72.0", hbcVersion: 94, toolchainBaseline: true, subtractedBaselines: [], functions: [1] }));
    const rejected = filterUnsubtracted(dir);
    assert.equal(rejected.length, 0);
    assert.ok(existsSync(join(dir, name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("index.json drops quarantined entries so a stale manifest never points at a rejected file", () => {
  const dir = makeDir();
  try {
    const name = "bad-pkg@1.0.0__hbc94.json";
    writeFileSync(join(dir, name), JSON.stringify({ package: "bad-pkg", version: "1.0.0", hbcVersion: 94, toolchainBaseline: false, subtractedBaselines: [], functions: [] }));
    writeFileSync(join(dir, "index.json"), JSON.stringify({ entries: [{ package: "bad-pkg", version: "1.0.0", hbcVersion: 94 }] }));
    filterUnsubtracted(dir);
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    assert.equal(index.entries.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
