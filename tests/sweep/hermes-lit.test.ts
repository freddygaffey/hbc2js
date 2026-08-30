// docs/TASKS.md T1 / docs/TEST-CORPUS.md §1b — verifies every harvested
// facebook/hermes lit test under tests/sweep/hermes-lit/cases/ still runs
// under Node with the project's standard `print` shim and still produces
// exactly the stdout its expected.txt (derived from the upstream // CHECK
// lines by tools/harvest-hermes-lit.ts) records. This is a regression check
// on the harvest, not on the decompiler — see tests/gate/decompile for that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { requireSweep } from "../support/tiers.ts";

const CASES_DIR = join(repoRoot(), "tests", "sweep", "hermes-lit", "cases");
const PRINT_SHIM = "globalThis.print ??= (...a)=>console.log(...a);\n";

test("hermes-lit: every harvested case runs under Node+print-shim and matches its expected.txt exactly", async (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(CASES_DIR)) {
    t.skip(`no cases found at ${CASES_DIR} — run tools/harvest-hermes-lit.ts first`);
    return;
  }
  const names = readdirSync(CASES_DIR).sort();
  assert.ok(names.length > 0, "hermes-lit harvest is empty — see tests/sweep/hermes-lit/PROVENANCE.md");

  let passed = 0;
  const failures: string[] = [];
  for (const name of names) {
    const dir = join(CASES_DIR, name);
    const source = readFileSync(join(dir, "source.js"), "utf8");
    const expected = readFileSync(join(dir, "expected.txt"), "utf8");
    let stdout: string;
    try {
      stdout = execFileSync(process.execPath, ["--input-type=commonjs", "-"], {
        input: PRINT_SHIM + source,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (e) {
      failures.push(`${name}: threw under Node — ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    if (stdout !== expected) {
      failures.push(`${name}: stdout mismatch`);
      continue;
    }
    passed++;
  }
  console.log(`hermes-lit sweep: ${passed}/${names.length} cases pass`);
  assert.deepEqual(failures, [], `${failures.length}/${names.length} hermes-lit case(s) regressed:\n${failures.join("\n")}`);
});
