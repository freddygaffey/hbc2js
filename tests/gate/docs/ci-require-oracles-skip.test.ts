// docs/AGENT-LOG.md 2026-09-05 "ci: make REQUIRE_ORACLES fail only on
// provisionable oracles" — regression coverage for that fix.
//
// tests/support/oracles.ts's whole design is: HBC2JS_REQUIRE_ORACLES=1 turns
// a missing *provisionable* oracle (hermesc, hermes-dec, now semgrep/
// androguard — tools CI itself installs) into a hard failure, so a workflow
// that silently stopped installing one doesn't quietly go INCONCLUSIVE
// forever. It must NOT turn an in-repo, not-yet-landed artefact (a tool file
// not written yet, a fixture not committed yet, a bundle fetched manually
// and never checked in) into a failure — CI can never provision those, so
// REQUIRE_ORACLES has no business demanding them. Before this fix,
// tests/secrets/held-out.test.ts and tests/security/t6/t7/t8 all conflated
// the two, which is exactly what made GitHub CI red on every push (see
// docs/BUGS.md's CI red-run row).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

// node --test sets NODE_TEST_CONTEXT for its own children (so it can talk to
// them over a serialized v8 channel instead of plain stdout); this file's
// own child `node --test` invocations must NOT inherit that or their
// reporter output goes to the wrong channel and spawnSync's captured stdout
// comes back empty.
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env["NODE_TEST_CONTEXT"];
  delete env["NODE_TEST_WORKER_ID"];
  return env;
}

function countRequireOraclesImports(path: string): number {
  const src = readFileSync(path, "utf8");
  return (src.match(/requireOracles/g) ?? []).length;
}

test("not-yet-landed-artefact tests never import requireOracles (nothing there for REQUIRE_ORACLES to gate)", () => {
  for (const rel of [
    ["tests", "secrets", "held-out.test.ts"],
    ["tests", "security", "t7-lane-s-artifact-bar.test.ts"],
    ["tests", "security", "t8-lane-m-agreement.test.ts"],
  ]) {
    const p = join(repoRoot(), ...rel);
    assert.equal(countRequireOraclesImports(p), 0, `${rel.join("/")} should not reference requireOracles at all — its only checks are in-repo not-yet-landed artefacts`);
  }
});

test("t6-lane-s-recall only gates the semgrep BINARY on requireOracles, not measure-semgrep.ts", () => {
  const p = join(repoRoot(), "tests", "security", "t6-lane-s-recall.test.ts");
  const src = readFileSync(p, "utf8");
  // Exactly one requireOracles() call site (the semgrep-binary-absent
  // branch); the measure-semgrep.ts-absent branch below it must not call it.
  const calls = src.match(/requireOracles\(\)/g) ?? [];
  assert.equal(calls.length, 1, `expected exactly one requireOracles() call, got ${calls.length}`);
  const measureBranch = src.slice(src.indexOf("MEASURE_SEMGREP_PATH)) {"));
  assert.ok(!measureBranch.includes("requireOracles"), "the measure-semgrep.ts-absent branch must not gate on requireOracles (it is an in-repo artefact, not an oracle)");
});

test("t7/t8 report skip (not fail) under HBC2JS_REQUIRE_ORACLES=1, since their artefacts are reliably absent pre-spec-13-step-3/4", () => {
  for (const rel of ["tests/security/t7-lane-s-artifact-bar.test.ts", "tests/security/t8-lane-m-agreement.test.ts"]) {
    const abs = join(repoRoot(), rel);
    // Sanity: the fixture these depend on genuinely doesn't exist yet (else
    // this test would be proving nothing).
    if (rel.includes("t7")) assert.ok(!existsSync(join(repoRoot(), "tools", "security", "semgrep")), "tools/security/semgrep unexpectedly exists — Lane S must have landed; update this test");
    if (rel.includes("t8")) assert.ok(!existsSync(join(repoRoot(), "tests", "fixtures", "security", "vuln-app", "apk")), "the fixture APK unexpectedly exists — Lane M must have landed; update this test");

    const res = spawnSync(process.execPath, ["--test", abs], {
      cwd: repoRoot(),
      encoding: "utf8",
      env: childEnv({ HBC2JS_REQUIRE_ORACLES: "1" }),
    });
    assert.equal(res.status, 0, `${rel} exited ${res.status} under REQUIRE_ORACLES=1 (expected 0, i.e. skip not fail):\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /ℹ skipped [1-9]/, `${rel}: expected the reporter summary to report a skip under REQUIRE_ORACLES=1:\n${res.stdout}`);
    assert.match(res.stdout, /ℹ fail 0/, `${rel}: a subtest failed under REQUIRE_ORACLES=1:\n${res.stdout}`);
  }
});

test("47-spread-non-iterable-message's dedicated regression test moved out of tests/gate/** (D22a: a gate file may not decompile fixtures/adversarial for pass/fail)", () => {
  assert.ok(!existsSync(join(repoRoot(), "tests", "gate", "runtime", "spread-non-iterable-message.test.ts")));
  const dest = join(repoRoot(), "tests", "sweep", "adversarial", "spread-non-iterable-message.test.ts");
  assert.ok(existsSync(dest));

  // Under the default (gate) tier it must skip, not run its body — same
  // convention as every other sweep-tier file (requireSweep).
  const gateRun = spawnSync(process.execPath, ["--test", dest], { cwd: repoRoot(), encoding: "utf8", env: childEnv({}) });
  assert.equal(gateRun.status, 0);
  assert.match(gateRun.stdout, /ℹ skipped 1/, gateRun.stdout);

  // A missing Hermes VM must skip, not fail, even under REQUIRE_ORACLES=1
  // (tests/support/hermesvm.ts's convention) — this repro only proves
  // something when no VM is present on this machine.
  const findHermesVmPath = join(repoRoot(), "src", "harness", "hermes-vm.ts");
  const hasAnyVm = [94, 96, 99].some((v) => {
    const check = spawnSync(process.execPath, ["-e", `import("${findHermesVmPath}").then(m => process.exit(m.findHermesVm(${v}) ? 0 : 1))`], { encoding: "utf8", env: childEnv({}) });
    return check.status === 0;
  });
  if (hasAnyVm) return; // this machine has a VM: the body runs for real, nothing to prove about the skip path here

  const sweepRun = spawnSync(process.execPath, ["--test", dest], {
    cwd: repoRoot(),
    encoding: "utf8",
    env: childEnv({ HBC2JS_TIER: "sweep", HBC2JS_REQUIRE_ORACLES: "1" }),
  });
  assert.equal(sweepRun.status, 0, `expected a missing-VM skip, not a failure:\n${sweepRun.stdout}`);
  assert.match(sweepRun.stdout, /ℹ skipped 1/, sweepRun.stdout);
});
