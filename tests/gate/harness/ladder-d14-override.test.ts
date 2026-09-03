// tests/gate/harness/ladder-d14-override.test.ts — docs/BUGS.md 2026-09-02
// ("D14 VM cross-check" row): the D14 VM-agrees-with-candidate override in
// `ladder.ts` used to fire only when `opts.reference.knownDivergences` was
// non-empty — populated solely from `reference-policy.ts`'s curated,
// fixture-*name*-keyed `KNOWN_DIVERGENT_FIXTURES` table. A fuzz-generated
// program has no name in that table and could never get the override, even
// when a direct Hermes VM run of its own bytecode confirmed the candidate
// byte-for-byte. This file proves the override is now evidence-based (fires
// for *any* program the VM confirms, curated or not) and that it never
// downgrades a genuine candidate-vs-VM disagreement.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOracleLadder, VERDICT } from "../../../src/harness/ladder.ts";
import { compileWithHermesc } from "../../../src/harness/roundtrip.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";
import { chooseReference } from "../../../src/harness/reference-policy.ts";
import { findHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import type { TestContext } from "node:test";

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

// Same shape as docs/BUGS.md's triage seed 777011: a sloppy-mode function
// that writes through `arguments[0]` and reads the parameter back. Under
// plain Node this is native sloppy-mode aliasing (`a` becomes 99); Hermes's
// `ReifyArguments` does not write back to the parameter's own storage, so
// the real bytecode leaves `a` at 1 (docs/AGENT-BRIEF.md's D14 rule).
const ARGS_ALIASING_SOURCE = `function f(a) {\n  arguments[0] = 99;\n  print(a);\n}\nf(1);\n`;
// A "decompiled-shape" candidate that reproduces the bytecode's own
// (non-aliasing) behaviour rather than naively re-emitting `arguments[0] =
// 99; print(a);`, which under Node would alias too and defeat the test.
const ARGS_ALIASING_CANDIDATE = `function f(a) {\n  var reified0 = a;\n  reified0 = 99;\n  print(a);\n}\nf(1);\n`;

test("D14 override is evidence-based: a nameless program the VM confirms gets PASS-with-caveat citing vm-agrees evidence, not a curated name", async (t) => {
  const o = oraclesReady(t, 94);
  if (o === null) return;
  const compiled = compileWithHermesc({ version: 94, path: o.hermescPath }, ARGS_ALIASING_SOURCE, "source.js");
  assert.ok(compiled.ok, `hermesc v94 must compile the aliasing program: ${compiled.ok ? "" : compiled.error}`);

  const dir = mkdtempSync(join(tmpdir(), "hbc2js-ladder-d14-"));
  try {
    const candidatePath = join(dir, "candidate.js");
    const sourcePath = join(dir, "source.js");
    writeFileSync(candidatePath, ARGS_ALIASING_CANDIDATE);
    writeFileSync(sourcePath, ARGS_ALIASING_SOURCE);

    // Deliberately a name that cannot be in KNOWN_DIVERGENT_FIXTURES: the
    // whole point is this is a fuzz-generated, nameless program.
    const fixture = { name: "fuzzgen-nameless-777011-shape" };
    const reference = chooseReference(fixture, 94);
    assert.equal(reference.engine, "hermes-vm");
    assert.deepEqual(reference.knownDivergences, [], "must not be curated — this is the whole point of the evidence-based override");

    const r = await runOracleLadder({ fixture, candidateJsPath: candidatePath, sourceJsPath: sourcePath, reference, hbcBytes: compiled.bytes, hbcVersion: 94, oracles: ["syntax", "trace"] });
    assert.equal(r.verdict, VERDICT.PASS, JSON.stringify(r.oracles));
    assert.equal(r.caveats.length, 1, JSON.stringify(r.caveats));
    assert.match(r.caveats[0]!, /vm-agrees evidence/, "caveat must record what the VM comparison actually was, not a curated-name lookup");
    assert.doesNotMatch(r.caveats[0]!, /known-divergence construct/, "must not cite the curated list — no name lookup happened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// docs/PUSHBACK.md P-14: this used to be one test against
// `tests/fixtures/adversarial/43-fuzz-async-guard-shared-range`, treated as
// a genuine candidate-vs-VM disagreement. It was not — `docs/reports/
// 2026-09-04-toolchain-artifact-investigation.md` root-caused fixture 43's
// DIVERGENT verdict to a toolchain artifact (the D14 VM oracle's `hermesc`/
// `hermes` commit mismatch at v99), now fixed at the source in
// `ladder.ts`'s matched-compiler reference recompilation. Testing the
// override's soundness against 43 was therefore testing a false premise —
// the fixture was never evidence that the override could wrongly downgrade
// a real disagreement, because there never was a real disagreement to guard
// against there.
//
// Reframed per the fix's own recommendation (that report's "Recommended
// fix" section): drive `runOracleLadder`'s D14 branch directly with a
// synthetic `(candidate, vm, node)` trace triple, constructing
// `LadderOptions.reference` by hand (bypassing `chooseReference`/
// `findHermesVm` — no real hermesc/Hermes-VM binary needed at all) and
// standing in for "the Hermes VM" with a tiny fake executable that prints a
// fixed, controlled line regardless of the bytecode file it's handed. This
// tests the override's decision logic itself with fully owned inputs — not
// a specific fixture whose classification turned out to be wrong — so it
// can never again be invalidated by a future root-cause finding about one
// fixture, and it never skips (no `tools/build-hermes-vm.sh`/`get-hermesc.sh`
// prerequisite).
function writeFakeVm(dir: string, printedLine: string): string {
  // `#!/usr/bin/env node` + chmod 755: a real executable `runHermesAsync`
  // can `execFile` directly (macOS + Linux both ship `env`), that ignores
  // whatever `-b <file>` bytecode path it's given and always reports one
  // fixed line — standing in for "the Hermes VM's own trace of the original
  // bytecode" without needing a real Hermes build.
  const vmPath = join(dir, "fake-hermes-vm.js");
  writeFileSync(vmPath, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(printedLine)});\n`, { mode: 0o755 });
  return vmPath;
}

test("D14 override soundness: a synthetic vm != candidate triple stays DIVERGENT, never downgraded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-ladder-d14-synth-a-"));
  try {
    // candidate and node(source.js) agree with each other ("A") — proving
    // the override's DIVERGENT verdict here comes from the VM disagreement
    // itself, not from an unrelated candidate-vs-Node mismatch the override
    // might be papering over.
    const candidatePath = join(dir, "candidate.js");
    const sourcePath = join(dir, "source.js");
    writeFileSync(candidatePath, `print("A");\n`);
    writeFileSync(sourcePath, `print("A");\n`);
    const vmPath = writeFakeVm(dir, "B"); // vm != candidate

    const fixture = { name: "synthetic-vm-disagrees" };
    const reference = { engine: "hermes-vm" as const, reason: "synthetic test", vm: { hbcVersion: 99, path: vmPath }, knownDivergences: [] };
    const r = await runOracleLadder({ fixture, candidateJsPath: candidatePath, sourceJsPath: sourcePath, reference, hbcBytes: new Uint8Array([0]), hbcVersion: 99, oracles: ["syntax", "trace"] });
    assert.equal(r.verdict, VERDICT.DIVERGENT, `vm ("B") != candidate ("A") must never be downgraded, even though candidate agrees with Node: ${JSON.stringify(r.oracles)} caveats=${JSON.stringify(r.caveats)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("D14 override soundness: a synthetic vm == candidate != node triple is PASS (D14-legit)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-ladder-d14-synth-b-"));
  try {
    // candidate and node(source.js) disagree ("A" vs "N"), which on its own
    // is a DIVERGENT trace comparison; the VM's own run agrees with the
    // candidate ("A"), which is exactly the D14 override's condition for
    // "this is a legitimate source.js-vs-bytecode divergence, not a
    // decompiler bug".
    const candidatePath = join(dir, "candidate.js");
    const sourcePath = join(dir, "source.js");
    writeFileSync(candidatePath, `print("A");\n`);
    writeFileSync(sourcePath, `print("N");\n`);
    const vmPath = writeFakeVm(dir, "A"); // vm == candidate

    const fixture = { name: "synthetic-vm-agrees-d14-legit" };
    const reference = { engine: "hermes-vm" as const, reason: "synthetic test", vm: { hbcVersion: 99, path: vmPath }, knownDivergences: [] };
    const r = await runOracleLadder({ fixture, candidateJsPath: candidatePath, sourceJsPath: sourcePath, reference, hbcBytes: new Uint8Array([0]), hbcVersion: 99, oracles: ["syntax", "trace"] });
    assert.equal(r.verdict, VERDICT.PASS, `vm ("A") == candidate ("A") != node ("N") is the override's own legit case: ${JSON.stringify(r.oracles)} caveats=${JSON.stringify(r.caveats)}`);
    assert.match(r.caveats.join("\n"), /vm-agrees evidence/, "PASS must be recorded as a vm-agrees override, not a silent pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
