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

// docs/BUGS.md 2026-09-02 "hermes-lit date-fp-contract" — this one case's
// expected.txt was captured empirically at harvest time on whatever
// Node/V8 happened to be current then, and the upstream source it checks
// (`Date.UTC` with a deliberately FMA-probing, wildly out-of-range input)
// genuinely computes a different literal answer on a newer Node/V8. That is
// a Node-version drift in the harness's own harvested corpus, not a
// decompiler regression (this test never invokes hbc2js). expected.txt is a
// golden/snapshot fixture, so regenerating it needs Fred's approval as a
// batch, not a silent fix here — quarantine by name instead, visibly, so
// the other 117 harvested cases keep gating the sweep.
const QUARANTINED: ReadonlyMap<string, string> = new Map([["date-fp-contract", "docs/BUGS.md 2026-09-02 hermes-lit date-fp-contract — Node/V8-version drift in Date.UTC's FMA handling, not a decompiler bug; expected.txt regeneration needs golden-snapshot approval"]]);

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
    if (QUARANTINED.has(name)) continue; // reported via its own visible skip subtest below
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
  const gated = names.length - QUARANTINED.size;
  console.log(`hermes-lit sweep: ${passed}/${gated} cases pass (${QUARANTINED.size} quarantined, see below)`);
  assert.deepEqual(failures, [], `${failures.length}/${gated} hermes-lit case(s) regressed:\n${failures.join("\n")}`);

  for (const [name, reason] of QUARANTINED) {
    assert.ok(existsSync(join(CASES_DIR, name)), `quarantined case ${name} no longer exists in the harvest — remove its QUARANTINED entry`);
    await t.test(`quarantined: ${name}`, (st) => st.skip(reason));
  }
});
