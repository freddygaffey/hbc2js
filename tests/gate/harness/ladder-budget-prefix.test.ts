// tests/gate/harness/ladder-budget-prefix.test.ts — docs/BUGS.md 2026-09-05
// (fuzz fix-wave 4, the residual family-F2 finds). Three programs that print
// and then run out of some engine resource used to be reported DIVERGENT by
// `ladder.ts`'s Hermes VM cross-check even though the VM's own trace of the
// bytecode agreed with the candidate line for line:
//
//  1. the P-16 budget rule dropped one line off the *shared* cap whenever
//     both sides were cut off, so a program whose whole observable output is
//     one line before it loops forever verified `cap === 0` lines — the one
//     line the VM did print, which is the D14 ground truth refuting the
//     Node-vs-candidate difference, was thrown away (finds `v94-seed780867`,
//     `v96-seed781844`, `v96-seed782973`: Hermes shares ONE `let` binding
//     across loop iterations, so the bytecode prints `16,16,…` where
//     source.js under Node prints `0,1,2,…` — the candidate is right);
//  2. a DIVERGENT candidate-vs-source.js comparison was never weakened even
//     when the VM had just refuted the very record it diverged on;
//  3. only the *candidate's* engine-resource ceiling was recognised. Hermes
//     words the same array-size ceiling differently (`Requested an array
//     size that fails to allocate`) and reports heap exhaustion as an
//     `LLVM ERROR: OOM` abort with no `Uncaught` line, so the candidate's
//     ceiling marker was stripped while the VM's identical one was not —
//     a divergence manufactured out of two engines hitting the same wall
//     after identical output (find `v99-seed777142`, whose verdict flipped
//     between DIVERGENT and INCONCLUSIVE with machine load).
//
// Every case here is INCONCLUSIVE, never PASS (HA-01): neither side ran to
// completion, so nothing beyond the observed prefix is evidence either way.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOracleLadder, VERDICT } from "../../../src/harness/ladder.ts";
import { compileWithHermesc } from "../../../src/harness/roundtrip.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";
import { chooseReference } from "../../../src/harness/reference-policy.ts";
import { decompile } from "../../../src/decompile.ts";
import { findHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import type { TestContext } from "node:test";
import type { CheckResult } from "../../../src/harness/ladder.ts";

function oraclesReady(t: TestContext, version: 94 | 99): { hermescPath: string } | null {
  const hermesc = findHermesc(version);
  const vm = findHermesVm(version);
  if (hermesc === null || vm === null) {
    const msg = `hermesc v${version} + Hermes VM v${version} required (tools/get-hermesc.sh ${version}, tools/build-hermes-vm.sh ${version})`;
    if (hermesc === null && requireOracles()) throw new Error(`${msg} (HBC2JS_REQUIRE_ORACLES=1)`);
    t.skip(msg);
    return null;
  }
  return { hermescPath: hermesc.path };
}

/** Compile `source` at `version`, decompile the bytecode with the real
 *  decompiler (or take `candidateOverride` for the soundness case), and run
 *  the full trace ladder — exactly what `tools/fuzz/reclassify-finds.mjs`
 *  does to a campaign find. */
async function ladder(name: string, version: 94 | 99, hermescPath: string, source: string, candidateOverride?: string): Promise<CheckResult> {
  const compiled = compileWithHermesc({ version, path: hermescPath }, source, "fuzz.js");
  assert.ok(compiled.ok, `hermesc v${version} must compile ${name}: ${compiled.ok ? "" : compiled.error}`);
  const candidate = candidateOverride ?? decompile(compiled.bytes, { resolveV98Ambiguity: true, moduleName: name }).code;
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-ladder-budget-"));
  try {
    const candidatePath = join(dir, "candidate.js");
    const sourcePath = join(dir, "source.js");
    writeFileSync(candidatePath, candidate);
    writeFileSync(sourcePath, source);
    const fixture = { name };
    const reference = chooseReference(fixture, version);
    assert.equal(reference.engine, "hermes-vm");
    assert.deepEqual(reference.knownDivergences, [], "must not be curated — these are nameless fuzz programs");
    return await runOracleLadder({
      fixture, candidateJsPath: candidatePath, sourceJsPath: sourcePath, reference,
      hbcBytes: compiled.bytes, hbcVersion: version, embeddedFilename: "fuzz.js",
      matchedCompilerReference: true, oracles: ["syntax", "trace"], timeoutMs: 5000, maxRecords: 5000,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `tools/fuzz/minimise-live.mjs` reduction of find `v94-seed780867.js`,
// signature-preserving. The first `print` is the whole observable output; the
// trailing nest never terminates (`-Infinity + 1` is `-Infinity`), which is
// what cuts both sides off and used to erase the VM's evidence.
const SHARED_LET_SOURCE = `const closures = [];
for (let i = 0; i < 0x10; i++) {
  closures.push(function () { return i; });
}
print('let closures each see own i:', closures.map(function (f) { return f(); }).join(','));
for (let i = 0; i < 0x10; i++) {
  for (let j = -Infinity; j < 0; j++) {
  }
}
`;

// Find `v99-seed777142`'s shape, reduced to the part that matters: output,
// then an engine resource ceiling both engines hit after byte-identical
// output. The find itself grows an array in a loop whose counter never
// advances (`-Infinity + 1`), which takes the VM seconds to allocate its way
// through and made this test a load flake (it raced the ladder's 5 s
// timeout, and a VM cut off by the timeout instead of by its own ceiling
// exercises a different branch). Unbounded recursion reaches the same class
// of ceiling — `RangeError: Maximum call stack size exceeded` in *both*
// engines, `trace.ts`'s `RESOURCE_CEILING_MESSAGES` and `ladder.ts`'s
// `VM_RESOURCE_CEILING` — in ~16 ms under the VM, so no amount of machine
// load can turn it into a timeout.
const RESOURCE_CEILING_SOURCE = `var x = 999;
print('body runs even though condition is false: x=' + x);
function rec(n) { return rec(n + 1); }
rec(0);
print('unreachable');
`;

test("fix-wave 4: a one-line-then-forever program keeps the VM's evidence — the D14 ground truth refutes the Node-vs-source divergence instead of confirming it", async (t) => {
  const o = oraclesReady(t, 94);
  if (o === null) return;
  const r = await ladder("fuzzgen-v94-seed780867-reduced", 94, o.hermescPath, SHARED_LET_SOURCE);
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE, JSON.stringify(r.oracles));
  assert.ok(
    r.caveats.some((c) => /refutes this divergence/.test(c)),
    `the VM reproduced the candidate's only line, so the caveat must say the divergence was refuted: ${JSON.stringify(r.caveats)}`,
  );
  // The verified prefix must be non-empty: `cap === 0` is exactly the bug.
  assert.ok(
    r.caveats.some((c) => /the [1-9]\d*-line common prefix is identical/.test(c)),
    `at least one line must actually have been verified: ${JSON.stringify(r.caveats)}`,
  );
});

test("fix-wave 4: an engine resource ceiling is recognised on the VM side too, so both sides' ceiling markers come off together", async (t) => {
  const o = oraclesReady(t, 99);
  if (o === null) return;
  const r = await ladder("fuzzgen-v99-seed777142-reduced", 99, o.hermescPath, RESOURCE_CEILING_SOURCE);
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE, JSON.stringify(r.oracles));
  assert.ok(
    r.caveats.some((c) => /VM \d+ line\(s\), engine resource ceiling \(resource\)/.test(c)),
    `the VM's own RangeError ceiling must be reported as a ceiling, not as a divergence: ${JSON.stringify(r.caveats)}`,
  );
});

test("fix-wave 4 soundness: a candidate that really disagrees with the VM inside the observed prefix stays DIVERGENT", async (t) => {
  const o = oraclesReady(t, 94);
  if (o === null) return;
  // Same budget shape as the first case (one line, then forever), but the
  // candidate prints something the VM never printed. The relaxed cap must
  // catch this, not excuse it.
  const wrong = `print('let closures each see own i: 0,1,2');\nfor (;;) {}\n`;
  const r = await ladder("fuzzgen-budget-soundness", 94, o.hermescPath, SHARED_LET_SOURCE, wrong);
  assert.equal(r.verdict, VERDICT.DIVERGENT, JSON.stringify(r.oracles));
  assert.ok(
    r.oracles.some((x) => /diverges from Hermes VM/.test(x.detail ?? "")),
    `the divergence must be reported against the VM itself: ${JSON.stringify(r.oracles)}`,
  );
});
