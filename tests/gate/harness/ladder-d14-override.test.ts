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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOracleLadder, VERDICT } from "../../../src/harness/ladder.ts";
import { compileWithHermesc } from "../../../src/harness/roundtrip.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";
import { chooseReference } from "../../../src/harness/reference-policy.ts";
import { hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { findHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
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

test("D14 override soundness: a genuine candidate-vs-VM disagreement (adversarial/43) stays DIVERGENT, not downgraded", async (t) => {
  const o = oraclesReady(t, 99);
  if (o === null) return;
  const dir = join(repoRoot(), "tests", "fixtures", "adversarial", "43-fuzz-async-guard-shared-range");
  const hbcBytes = new Uint8Array(readFileSync(join(dir, "v99.hbc")));
  const sourceJs = readFileSync(join(dir, "source.js"), "utf8");
  const candidateJs = hbc2jsDecompiler({ hbcBytes, version: 99, fixtureName: "43-fuzz-async-guard-shared-range", sourceJs });

  const tmp = mkdtempSync(join(tmpdir(), "hbc2js-ladder-d14-adv43-"));
  try {
    const candidatePath = join(tmp, "candidate.js");
    writeFileSync(candidatePath, candidateJs);
    const fixture = { name: "43-fuzz-async-guard-shared-range" };
    const reference = chooseReference(fixture, 99);
    assert.equal(reference.engine, "hermes-vm");
    assert.deepEqual(reference.knownDivergences, [], "not curated — this is a real, unfixed bug (docs/BUGS.md), never a documented divergence");

    const r = await runOracleLadder({ fixture, candidateJsPath: candidatePath, sourceJsPath: join(dir, "source.js"), reference, hbcBytes, hbcVersion: 99, oracles: ["syntax", "trace"] });
    assert.equal(r.verdict, VERDICT.DIVERGENT, `this fixture is a documented, still-open real divergence (docs/BUGS.md 2026-09-02) — the D14 override must never fire without vm-agrees evidence: ${JSON.stringify(r.oracles)} caveats=${JSON.stringify(r.caveats)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
