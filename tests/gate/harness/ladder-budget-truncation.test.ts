// tests/gate/harness/ladder-budget-truncation.test.ts — docs/PUSHBACK.md P-16
// / docs/BUGS.md 2026-09-04 family H1.
//
// `ladder.ts`'s D14 Hermes-VM cross-check compared the VM's *uncapped* stdout
// against the candidate's `maxRecords`-capped trace projection, so a
// non-terminating program was DIVERGENT at whichever side stopped first —
// a verdict that measured machine load, not the decompiler (110 of the 159
// surviving campaign finds, and re-running one find gave DIVERGENT or
// INCONCLUSIVE depending on load). Both sides are now capped to the same
// number of lines, and an equal capped prefix under a budget is INCONCLUSIVE.
//
// Uses the same fake-VM technique as `ladder-d14-override.test.ts`: a tiny
// executable standing in for "the Hermes VM", so the test needs no hermesc
// and no Hermes build, never skips, and is fully deterministic in what the
// VM side produces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOracleLadder, VERDICT } from "../../../src/harness/ladder.ts";

/** A fake Hermes VM that ignores the bytecode it is handed and prints
 *  `count` copies of each line in `lines`, in order — standing in for a VM
 *  that ran far longer than the candidate's record budget allowed. */
function writeFakeVm(dir: string, prologue: readonly string[], repeated: string, count: number): string {
  const vmPath = join(dir, "fake-hermes-vm.js");
  writeFileSync(
    vmPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(prologue)}.concat(new Array(${count}).fill(${JSON.stringify(repeated)})).join("\\n") + "\\n");\n`,
    { mode: 0o755 },
  );
  return vmPath;
}

const NON_TERMINATING = `while (true) { print("tick"); }\n`;

function referenceFor(vmPath: string) {
  return { engine: "hermes-vm" as const, reason: "synthetic P-16 test", vm: { hbcVersion: 99, path: vmPath }, knownDivergences: [] };
}

test("P-16: a non-terminating program whose VM side ran past the candidate's record budget is INCONCLUSIVE, not DIVERGENT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-ladder-budget-"));
  try {
    const candidatePath = join(dir, "candidate.js");
    const sourcePath = join(dir, "source.js");
    writeFileSync(candidatePath, NON_TERMINATING);
    writeFileSync(sourcePath, NON_TERMINATING);
    // 4000 VM lines vs a 50-record candidate budget: exactly the shape
    // measured on `v84-seed778059` (3,389,470 VM lines vs 4,999 records),
    // scaled down so the test costs a second, not five.
    const vmPath = writeFakeVm(dir, [], "tick", 4000);
    const fixture = { name: "synthetic-non-terminating-p16" };

    // Stable across repeated runs: the old behaviour's verdict depended on
    // where the two budgets happened to cut, which moved with machine load.
    const verdicts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runOracleLadder({
        fixture,
        candidateJsPath: candidatePath,
        sourceJsPath: sourcePath,
        reference: referenceFor(vmPath),
        hbcBytes: new Uint8Array([0]),
        hbcVersion: 99,
        oracles: ["syntax", "trace"],
        timeoutMs: 1500,
        maxRecords: 50,
      });
      verdicts.push(r.verdict);
      assert.notEqual(r.verdict, VERDICT.DIVERGENT, `run ${i}: a budget cut-off is not evidence against the decompiler: ${JSON.stringify(r.oracles)}`);
      assert.match(r.caveats.join("\n"), /budget cut-off, not a divergence \(P-16\)/, `run ${i}: the budget cut-off must be recorded as a caveat, never silently dropped`);
    }
    assert.deepEqual(verdicts, [VERDICT.INCONCLUSIVE, VERDICT.INCONCLUSIVE, VERDICT.INCONCLUSIVE], `verdict must be stable across runs, was ${verdicts.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P-16 guard: a non-terminating program that diverges from the VM *before* the cut-off is still DIVERGENT", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-ladder-budget-guard-"));
  try {
    const candidatePath = join(dir, "candidate.js");
    const sourcePath = join(dir, "source.js");
    // Prints a wrong first value, then loops forever — docs/BUGS.md's own
    // "prove fixed" criterion for the H1 row.
    writeFileSync(candidatePath, `print("WRONG");\n${NON_TERMINATING}`);
    writeFileSync(sourcePath, `print("WRONG");\n${NON_TERMINATING}`);
    const vmPath = writeFakeVm(dir, ["right"], "tick", 4000);

    const r = await runOracleLadder({
      fixture: { name: "synthetic-non-terminating-divergent-p16" },
      candidateJsPath: candidatePath,
      sourceJsPath: sourcePath,
      reference: referenceFor(vmPath),
      hbcBytes: new Uint8Array([0]),
      hbcVersion: 99,
      oracles: ["syntax", "trace"],
      timeoutMs: 1500,
      maxRecords: 50,
    });
    assert.equal(r.verdict, VERDICT.DIVERGENT, `a real disagreement inside the capped prefix must survive the P-16 fix: ${JSON.stringify(r.oracles)} caveats=${JSON.stringify(r.caveats)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
