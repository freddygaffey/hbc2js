// docs/CONSOLIDATION.md item 25 — the D14 Hermes-VM cross-check must project
// both sides the same way for a program that legitimately dies of an
// uncaught throw.
//
// Before: `ladder.ts` compared `printLines(candidateTrace)` (print records
// only, never an `err`) against the VM's raw stdout+stderr (which carries
// Hermes's `Uncaught TypeError: ...` crash report). Any program whose
// top-level throws — adversarial/36-optional-chaining-sideeffect,
// `null.method?.()` is a TypeError by spec — was reported DIVERGENT at every
// version even when candidate and VM agreed on every print and on the error
// type (docs/BUGS.md 2026-08-31 ladder row).
//
// After: both sides are `print lines + "uncaught <Name>"` (`printProjection`
// in trace.ts, `hermesPrintProjection` in hermes-vm.ts). Name only — the two
// engines word the same TypeError differently, which is what
// `--relax error-messages` already acknowledges.
//
// The DIVERGENT cases below deliberately make candidate === source.js, so the
// Node-vs-Node trace compare is trivially EQUIVALENT and only the VM
// cross-check can (and must) produce the DIVERGENT verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOracleLadder, VERDICT } from "../../../src/harness/ladder.ts";
import { compileWithHermesc } from "../../../src/harness/roundtrip.ts";
import { findHermesVm, hermesPrintProjection, uncaughtErrorName } from "../../../src/harness/hermes-vm.ts";
import { printProjection } from "../../../src/harness/trace.ts";
import { chooseReference } from "../../../src/harness/reference-policy.ts";
import { hbc2jsDecompiler } from "../../../src/harness/tiers.ts";
import { findHermesc } from "../../support/hermesc.ts";
import { requireOracles } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import type { TestContext } from "node:test";

const THROWING = `const o = null;\nprint("before");\no.method?.();\nprint("never");\n`;
const NOT_THROWING = `print("before");\n`;
const OTHER_TYPE = `print("before");\nthrow new RangeError("different type");\n`;
const SAME_TYPE_OTHER_MESSAGE = `print("before");\nthrow new TypeError("same type, different wording");\n`;

function oraclesReady(t: TestContext): { hermescPath: string; vmOk: true } | null {
  const hermesc = findHermesc(94);
  const vm = findHermesVm(94);
  if (hermesc === null || vm === null) {
    const msg = `hermesc v94 + Hermes VM v94 required (tools/get-hermesc.sh 94, tools/build-hermes-vm.sh 94)`;
    if (requireOracles()) throw new Error(`${msg} (HBC2JS_REQUIRE_ORACLES=1)`);
    t.skip(msg);
    return null;
  }
  return { hermescPath: hermesc.path, vmOk: true };
}

async function ladder(hermescPath: string, programForHbc: string, candidateAndSource: string) {
  const compiled = compileWithHermesc({ version: 94, path: hermescPath }, programForHbc, "source.js");
  assert.ok(compiled.ok, `hermesc v94 must compile the program: ${compiled.ok ? "" : compiled.error}`);
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-ladder-uncaught-"));
  try {
    const candidatePath = join(dir, "candidate.js");
    const sourcePath = join(dir, "source.js");
    writeFileSync(candidatePath, candidateAndSource);
    writeFileSync(sourcePath, candidateAndSource);
    const fixture = { name: "ladder-uncaught-probe" };
    const reference = chooseReference(fixture, 94);
    assert.equal(reference.engine, "hermes-vm");
    return await runOracleLadder({ fixture, candidateJsPath: candidatePath, sourceJsPath: sourcePath, reference, hbcBytes: compiled.bytes, hbcVersion: 94, oracles: ["syntax", "trace"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("uncaughtErrorName / hermesPrintProjection parse Hermes's stderr crash report by error name only", () => {
  assert.equal(uncaughtErrorName("Uncaught TypeError: Cannot read property 'method' of null\n    at global (source.js:30:25)\n"), "TypeError");
  assert.equal(uncaughtErrorName("Uncaught RangeError\n"), "RangeError", "empty message: no colon after the name");
  assert.equal(uncaughtErrorName("Uncaught TypeError: m\nmultiline\n    at f (x.js:1:46)\n"), "TypeError");
  assert.equal(uncaughtErrorName("Uncaught 42\n"), "Thrown", "non-Error throw maps to errShape's 'Thrown'");
  assert.equal(uncaughtErrorName("Uncaught [object Object]\n"), "Thrown");
  assert.equal(uncaughtErrorName(""), null);
  assert.equal(uncaughtErrorName("Error deserializing bytecode: Wrong bytecode version\n"), null, "a VM refusal is not an uncaught program error");
  const base = { ok: false, timedOut: false, lines: [], raw: "" };
  assert.deepEqual(hermesPrintProjection({ ...base, stdout: "a\nb\n", stderr: "Uncaught TypeError: x\n    at global\n" }), ["a", "b", "uncaught TypeError"]);
  assert.deepEqual(hermesPrintProjection({ ...base, ok: true, stdout: "a\n", stderr: "" }), ["a"]);
});

test("printProjection appends `uncaught <Name>` for a main-phase err record only", () => {
  const out = { k: "out" as const, ch: "print", s: "a" };
  assert.deepEqual(printProjection([out, { k: "err", phase: "main", name: "TypeError", message: "whatever V8 says" }, { k: "globals", v: "{}" }]), ["a", "uncaught TypeError"]);
  assert.deepEqual(printProjection([out, { k: "err", phase: "drain", name: "Error", message: "in a microtask" }]), ["a"], "drain-phase errors have no Hermes counterpart");
  assert.deepEqual(printProjection([out, { k: "unhandled", name: "Error", message: "rejected" }]), ["a"], "unhandled rejections print nothing under the bare VM either");
});

test("CONSOLIDATION 25: a legitimately-throwing program is PASS when the candidate throws the same error type", async (t) => {
  const o = oraclesReady(t);
  if (o === null) return;
  // Identical program on both sides. V8 and Hermes word this TypeError
  // differently ("Cannot read properties of null (reading 'method')" vs
  // "Cannot read property 'method' of null") — the fix must not care.
  const r = await ladder(o.hermescPath, THROWING, THROWING);
  assert.equal(r.verdict, VERDICT.PASS, JSON.stringify(r.oracles));
  assert.equal(r.caveats.length, 0);
  // Same error type, an entirely different message: still PASS (name-only).
  const r2 = await ladder(o.hermescPath, SAME_TYPE_OTHER_MESSAGE, SAME_TYPE_OTHER_MESSAGE);
  assert.equal(r2.verdict, VERDICT.PASS, JSON.stringify(r2.oracles));
});

test("CONSOLIDATION 25: DIVERGENT when the candidate does not throw where the bytecode does, or throws a different type", async (t) => {
  const o = oraclesReady(t);
  if (o === null) return;
  const notThrowing = await ladder(o.hermescPath, THROWING, NOT_THROWING);
  assert.equal(notThrowing.verdict, VERDICT.DIVERGENT, JSON.stringify(notThrowing.oracles));
  const trace = notThrowing.oracles.find((x) => x.oracle === "trace");
  assert.ok(trace?.divergence !== undefined);
  assert.match(trace.divergence.a, /^before\nuncaught TypeError$/, "VM side: print then the normalised terminal error");
  assert.equal(trace.divergence.b, "before", "candidate side: never threw");

  const otherType = await ladder(o.hermescPath, THROWING, OTHER_TYPE);
  assert.equal(otherType.verdict, VERDICT.DIVERGENT, JSON.stringify(otherType.oracles));
  assert.equal(otherType.oracles.find((x) => x.oracle === "trace")?.divergence?.b, "before\nuncaught RangeError");

  // And the mirror image: bytecode does not throw, candidate does.
  const candidateThrows = await ladder(o.hermescPath, NOT_THROWING, THROWING);
  assert.equal(candidateThrows.verdict, VERDICT.DIVERGENT, JSON.stringify(candidateThrows.oracles));
});

test("CONSOLIDATION 25: adversarial/36-optional-chaining-sideeffect through the real decompiler is PASS at v94", async (t) => {
  const o = oraclesReady(t);
  if (o === null) return;
  const dir = join(repoRoot(), "tests", "fixtures", "adversarial", "36-optional-chaining-sideeffect");
  const hbcBytes = new Uint8Array(readFileSync(join(dir, "v94.hbc")));
  const candidateJs = hbc2jsDecompiler({ hbcBytes, version: 94, fixtureName: "36-optional-chaining-sideeffect", sourceJs: readFileSync(join(dir, "source.js"), "utf8") });
  const tmp = mkdtempSync(join(tmpdir(), "hbc2js-ladder-adv36-"));
  try {
    const candidatePath = join(tmp, "candidate.js");
    writeFileSync(candidatePath, candidateJs);
    const fixture = { name: "36-optional-chaining-sideeffect" };
    const r = await runOracleLadder({ fixture, candidateJsPath: candidatePath, sourceJsPath: join(dir, "source.js"), reference: chooseReference(fixture, 94), hbcBytes, hbcVersion: 94, oracles: ["syntax", "trace"] });
    assert.equal(r.verdict, VERDICT.PASS, JSON.stringify(r.oracles));
    assert.equal(r.caveats.length, 0, "a genuine PASS, not a known-divergence caveat");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
