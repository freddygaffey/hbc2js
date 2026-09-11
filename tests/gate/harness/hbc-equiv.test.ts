// docs/specs/06-harness.md section 8 + docs/specs/28-llm-readability.md
// section 9.4 (REWRITE row): the `equiv --hbc` oracle as a callable API, and
// the function-restricted rewrite oracle built on it. Driven in-process; the
// CLI is never spawned from library code, so it is never spawned here either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { repoRoot } from "../../support/paths.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";
import { hbcVsJsUnderHermes, runFunctionEquiv } from "../../../src/harness/hbc-equiv.ts";
import { findFunctionSpan } from "../../../src/readability/rewrite.ts";

const FIXTURE = "04-for-loop-basic";
const VERSION = 84;

function hbcPath(): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${String(VERSION)}.hbc`);
}

function faithfulRender(): string {
  return decompile(new Uint8Array(readFileSync(hbcPath()))).code;
}

/** The oracle needs a Hermes VM for this exact bytecode version (HA-05: it
 *  never falls back to Node). v84's VM is committed, so a missing one is an
 *  environment problem, not a landing gap -- REQUIRE_ORACLES turns it into a
 *  failure. */
function vmOrSkip(t: TestContext): boolean {
  if (findHermesVm(VERSION) !== null) return true;
  const msg = `no Hermes VM for HBC v${String(VERSION)} (tools/get-hermes-vm); the equiv --hbc oracle cannot run`;
  if (requireOracles()) throw new Error(msg);
  t.skip(msg);
  return false;
}

function inTempFile<T>(name: string, content: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-hbc-equiv-test-"));
  try {
    const p = join(dir, name);
    writeFileSync(p, content);
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fnText(code: string, name: string): string {
  const span = findFunctionSpan(code, name);
  assert.notEqual(span, undefined, `the render should contain function ${name}`);
  return code.slice(span!.start, span!.end);
}

test("hbcVsJsUnderHermes: the faithful render of a fixture is EQUIVALENT to its own bytecode", (t) => {
  if (!vmOrSkip(t)) return;
  const r = inTempFile("faithful.js", faithfulRender(), (p) => hbcVsJsUnderHermes(hbcPath(), p));
  assert.equal(r.verdict, "EQUIVALENT", r.why);
  assert.ok(r.lines > 0, `a verdict must rest on observed output, got ${String(r.lines)} lines`);
  assert.match(r.oracle, /^hbc2js equiv --hbc /, "the proof records the invocation verbatim");
});

test("hbcVsJsUnderHermes: no VM for the version is INCONCLUSIVE with zero evidence, never EQUIVALENT", (t) => {
  if (!vmOrSkip(t)) return;
  const r = inTempFile("faithful.js", faithfulRender(), (p) => hbcVsJsUnderHermes(hbcPath(), p, { findVm: () => null }));
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.equal(r.lines, 0);
  assert.match(r.why, /no Hermes VM for HBC version/);
});

test("hbcVsJsUnderHermes: a changed program is DIVERGENT", (t) => {
  if (!vmOrSkip(t)) return;
  const changed = `${faithfulRender()}\nprint("extra");\n`;
  const r = inTempFile("changed.js", changed, (p) => hbcVsJsUnderHermes(hbcPath(), p));
  assert.equal(r.verdict, "DIVERGENT", r.why);
});

test("runFunctionEquiv: without the bytecode leg there is no PASS (INCONCLUSIVE is never PASS)", async (t) => {
  if (!vmOrSkip(t)) return;
  const code = faithfulRender();
  const r = await inTempFile("faithful.js", code, (p) =>
    runFunctionEquiv({ hbcPath: hbcPath(), candidateJsPath: p, fn: 0, faithfulFnCode: fnText(code, "_fn0"), candidateFnCode: fnText(code, "_fn0"), findVm: () => null }),
  );
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.equal(r.coverage.inputs, 0);
  assert.deepEqual(
    r.legs.map((l) => l.name),
    ["module-hbc"],
    "the fuzz leg must not even run when the guarantee leg failed",
  );
});

test("runFunctionEquiv: PASS reports the coverage it rests on", async (t) => {
  if (!vmOrSkip(t)) return;
  const code = faithfulRender();
  const r = await inTempFile("faithful.js", code, (p) => runFunctionEquiv({ hbcPath: hbcPath(), candidateJsPath: p, fn: 0 }));
  assert.equal(r.verdict, "PASS", r.why);
  assert.ok(r.coverage.records > 0, "a PASS must record the records it was proven over");
});

test("runFunctionEquiv: the fuzz leg refutes a function-level difference the module run never exercises", async (t) => {
  if (!vmOrSkip(t)) return;
  const code = faithfulRender();
  // The module leg sees the untouched faithful render (it PASSes), so the only
  // thing that can produce a DIVERGENT verdict here is the function-restricted
  // fuzz leg: exactly the "trace coverage is thin" mitigation spec 28 section
  // 0a asks for.
  const r = await inTempFile("faithful.js", code, (p) =>
    runFunctionEquiv({
      hbcPath: hbcPath(),
      candidateJsPath: p,
      fn: 0,
      faithfulFnCode: "function target(a) { return a + 1; }",
      candidateFnCode: "function target(a) { return a + 2; }",
      alwaysFuzz: true,
      fuzz: 8,
    }),
  );
  assert.equal(r.verdict, "DIVERGENT", r.why);
  assert.deepEqual(
    r.legs.map((l) => `${l.name}:${l.verdict}`),
    ["module-hbc:PASS", "function-fuzz:DIVERGENT"],
  );
});

test("runFunctionEquiv: agreeing functions pass the fuzz leg over a non-zero number of inputs", async (t) => {
  if (!vmOrSkip(t)) return;
  const code = faithfulRender();
  const r = await inTempFile("faithful.js", code, (p) =>
    runFunctionEquiv({
      hbcPath: hbcPath(),
      candidateJsPath: p,
      fn: 0,
      faithfulFnCode: "function target(a) { return a + 1; }",
      candidateFnCode: "function target(a) { let b = a; return b + 1; }",
      alwaysFuzz: true,
      fuzz: 8,
    }),
  );
  assert.equal(r.verdict, "PASS", r.why);
  assert.ok(r.coverage.inputs > 0, "the fuzz leg must report how many inputs it proved over");
});
