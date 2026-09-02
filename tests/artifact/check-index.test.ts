// tests/artifact/check-index.test.ts — A3 (docs/specs/10-artifact-format.md
// §7): run the §4.1 checker `--all` on a construct fixture's artifact -> PASS;
// then corrupt one `calls.jsonl` row (flip a callee) in a temp copy -> checker
// FAILS naming that row (the regression test for "checker actually checks").
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";

const ROOT = repoRoot();
const FIXTURE_HBC = join(ROOT, "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const CHECKER = join(ROOT, "tools", "artifact", "check-index.ts");

const bytes = readFileSync(FIXTURE_HBC);
const splitResult = splitProject(bytes, { moduleName: "04-for-loop-basic" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-check-index-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });

test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("A3a check-index --all PASSes on a clean construct-fixture artifact", () => {
  const out = execFileSync("node", [CHECKER, outDir, "--hbc", FIXTURE_HBC, "--all"], { encoding: "utf8" });
  assert.match(out, /^check-index PASS:/);
});

test("A3b check-index --all FAILs and names the row when calls.jsonl is corrupted", () => {
  const corruptDir = mkdtempSync(join(tmpdir(), "hbc2js-check-index-corrupt-"));
  cpSync(outDir, corruptDir, { recursive: true });
  const callsPath = join(corruptDir, "index", "calls.jsonl");
  const lines = readFileSync(callsPath, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => JSON.parse(l));
  assert.ok(rows.length > 0, "fixture must have at least one call row to corrupt");
  const flipIdx = 0;
  const corruptedFn = rows[flipIdx].caller;
  // A callee no real recount could ever independently produce: a fabricated
  // closure edge to a fnIndex nothing in this tiny bundle has — guaranteed
  // to disagree with the recount regardless of what the original row was.
  rows[flipIdx] = { caller: rows[flipIdx].caller, site: rows[flipIdx].site, callee: 999999, kind: "closure" };
  writeFileSync(callsPath, [lines[0], ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n");

  let out = "";
  let failed = false;
  try {
    out = execFileSync("node", [CHECKER, corruptDir, "--hbc", FIXTURE_HBC, "--all"], { encoding: "utf8" });
  } catch (e) {
    failed = true;
    out = (e as { stdout?: string }).stdout ?? "";
  }
  assert.equal(failed, true, "checker must exit non-zero on a corrupted index");
  assert.match(out, /^check-index FAIL:/);
  assert.match(out, new RegExp(`fn:${corruptedFn} `));
  rmSync(corruptDir, { recursive: true, force: true });
});
