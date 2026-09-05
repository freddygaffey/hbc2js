// ACCEPTANCE: spec 21 (docs/specs/passes/21-for-in-for-of.md) — the `for-in`
// stage-A rung, catalogue row 9.
//
// These tests are written BEFORE `src/passes/for-in/` exists and are marked
// `{ skip: SKIP }` so the gate stays green until the rung lands. The
// implementer removes the `skip` option from every `test(...)` in this file in
// the landing commit and changes nothing else: this file is the acceptance
// criterion, so a test that looks wrong is a docs/PUSHBACK.md row, not an edit
// (spec 21 §8).
//
// Testing rules (CLAUDE.md): every assertion below is a rung-owned property —
// a count, a regex over the decompiled text, a structural check on the tree,
// or an equivalence verdict. Nothing compares whole output against a literal.
//
// The rung is loaded through a runtime-computed specifier so that
// `tsc --noEmit` does not fail on a module that does not exist yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import { hbc2jsDecompiler, runTier } from "../../../src/harness/tiers.ts";
import { structure } from "../../../src/structure/index.ts";
import { seq } from "../../../src/structure/ir.ts";
import type { LabelId, Stmt } from "../../../src/structure/ir.ts";
import type { CheckResult, Match, PassContext } from "../../../src/passes/types.ts";
import { addr, imm, insn, reg, synthCfg } from "./synth.ts";

/** Runtime specifier: unresolvable at type-check time on purpose (spec 21 §8). */
const passModule = async (file: string): Promise<Record<string, unknown>> =>
  (await import(new URL(`../../../src/passes/for-in/${file}.ts`, import.meta.url).href)) as Record<string, unknown>;

type MatchFn = (node: Stmt, ctx: PassContext) => Match<Stmt, unknown> | null;
type CheckFn = (before: Stmt, after: Stmt, ctx: PassContext) => CheckResult;

const fixtureBytes = (name: string, version: string): Uint8Array =>
  new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, `${version}.hbc`)));
const decompiled = (name: string, version: string): string => decompile(fixtureBytes(name, version), { moduleName: "x" }).code;

/** `for (const|let|var <name> in …)` statement heads. */
const forInHeads = (code: string): number => (code.match(/\bfor\s*\((?:const|let|var)\s+[A-Za-z_$][\w$]*\s+in\s/g) ?? []).length;
const forOfHeads = (code: string): number => (code.match(/\bfor\s*\((?:const|let|var)\s+[A-Za-z_$][\w$]*\s+of\s/g) ?? []).length;

/** Uses of a `__hbc_*` runtime helper that are NOT its own definition. */
const callSites = (code: string, helper: string): number =>
  (code.match(new RegExp(`${helper}\\(`, "g")) ?? []).length - (code.match(new RegExp(`function\\s+${helper}\\(`, "g")) ?? []).length;

// ---------------------------------------------------------------------------
// Hand-forged trees. `match` is called directly (no driver, no round-trip), so
// a refusal here is provably the matcher's own. Every negative is paired with
// the positive control it was derived from: if the control stops matching the
// negative proves nothing, and the test says so.

/**
 * The measured for-in shape (spec 21 §2.1), byte-identical at v94 and v99:
 *
 *   labeled L0 { block b0; if b0 { break L0 } else {};
 *                loop L1 { block b1; if b1 { break L0 } else {}; block b2; continue L1 } }
 *
 * `opts` perturbs exactly one thing at a time.
 */
function forInSynth(opts: { exhaustedBreaksTo?: LabelId; scratchTouched?: boolean; testsOtherRegister?: boolean } = {}) {
  const bodyInsns = opts.scratchTouched === true
    ? [insn("Mov", reg(8), reg(1)), insn("LoadConstUInt8", reg(4), imm(7))] // writes the enumerator's index scratch
    : [insn("Mov", reg(8), reg(1))];
  const cfg = synthCfg([
    { succs: [3, 1], insns: [insn("Mov", reg(5), reg(9)), insn("GetPNameList", reg(6), reg(5), reg(4), reg(3)), insn("JmpUndefined", addr(12), reg(6))] },
    { succs: [3, 2], insns: [insn("GetNextPName", reg(1), reg(6), reg(5), reg(4), reg(3)), insn("JmpUndefined", addr(8), reg(opts.testsOtherRegister === true ? 8 : 1))] },
    { succs: [1], insns: bodyInsns },
    { succs: [], insns: [insn("Ret", reg(2))] },
  ]);
  const loop: Stmt = {
    k: "loop",
    label: 1,
    body: seq([
      { k: "block", cfgBlock: 1 },
      { k: "if", cfgBlock: 1, then: { k: "break", label: opts.exhaustedBreaksTo ?? 0 }, else: seq([]) },
      { k: "block", cfgBlock: 2 },
      { k: "continue", label: 1 },
    ]),
  };
  const outerBody = seq([
    { k: "block", cfgBlock: 0 },
    { k: "if", cfgBlock: 0, then: { k: "break", label: 0 }, else: seq([]) },
    loop,
  ]);
  const root: Stmt = { k: "labeled", label: 0, body: outerBody };
  const fn = structure(cfg);
  const ctx: PassContext = {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg,
    hbcVersion: 94,
    layoutClass: "hbc94" as PassContext["layoutClass"],
    applied: ["loop-cond", "for-header"],
    diagnostic: () => {},
    structured: { ...fn, root },
    parentOf: (node: unknown) => (node === loop ? { parent: outerBody, index: 2 } : null),
  };
  return { cfg, root, loop, ctx };
}

// ---------------------------------------------------------------------------

test("ACCEPTANCE spec 21: for-in is a registered stage-A rung on catalogue row 9", async () => {
  const { forIn } = (await passModule("index")) as { forIn: { name: string; stage: string; catalogue: readonly (number | string)[]; after?: readonly string[]; before?: readonly string[] } };
  const { REGISTRY } = await import("../../../src/passes/registry.ts");
  assert.equal(forIn.name, "for-in");
  assert.equal(forIn.stage, "A");
  assert.deepEqual([...forIn.catalogue], [9]);
  assert.ok(forIn.after?.includes("loop-cond"), "spec 21 §7: after loop-cond");
  assert.ok(forIn.after?.includes("for-header"), "spec 21 §7: after for-header");
  assert.ok(forIn.before?.includes("label-clean"), "spec 21 §7: before label-clean");
  const names = REGISTRY.map((p) => p.name);
  assert.ok(names.includes("for-in"), "the rung is switched on in src/passes/registry.ts");
  assert.ok(names.indexOf("for-in") > names.indexOf("for-header"), "registered after for-header");
  assert.ok(names.indexOf("for-in") < names.indexOf("label-clean"), "registered before label-clean");
});

test("ACCEPTANCE spec 21: fixture 05 prints one `for (… in …)` per source loop, at every version", async () => {
  const counts = new Map<string, number>();
  for (const v of ["v84", "v94", "v96", "v98", "v99"]) counts.set(v, forInHeads(decompiled("05-for-in-object", v)));
  // 05-for-in-object's source has exactly two `for...in` loops.
  for (const [v, n] of counts) assert.equal(n, 2, `${v}: expected 2 for-in heads, got ${n}`);
  assert.equal(new Set(counts.values()).size, 1, "version parity: the same number of loops is recovered at every version");
});

test("ACCEPTANCE spec 21: no enumerator machinery survives in fixture 05's output", async () => {
  for (const v of ["v94", "v99"]) {
    const code = decompiled("05-for-in-object", v);
    assert.equal(callSites(code, "__hbc_pnames"), 0, `${v}: a GetPNameList helper call survived`);
    assert.equal(callSites(code, "__hbc_nextPName"), 0, `${v}: a GetNextPName helper call survived`);
  }
});

test("ACCEPTANCE spec 21: fixture 05 still passes the equivalence oracle at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: ["05-for-in-object"] });
  assert.deepEqual(report.results.filter((r) => r.verdict !== "PASS").map((r) => `${r.fixture.name}: ${r.verdict}`), []);
  assert.ok(report.summary.pass >= 5, `expected the fixture to run at all 5 versions, got ${report.summary.pass}`);
});

test("ACCEPTANCE spec 21: the matcher accepts the measured shape and refuses a second exit label", async () => {
  const { match } = (await passModule("match")) as { match: MatchFn };
  const control = forInSynth();
  assert.notEqual(match(control.loop, control.ctx), null, "control: the measured for-in shape must match");

  // §4.1 P5: both JmpUndefined guards must leave to the SAME label. Here the
  // exhausted guard breaks out of the loop itself instead of to L0.
  const bad = forInSynth({ exhaustedBreaksTo: 1 });
  assert.equal(match(bad.loop, bad.ctx), null, "two different exits is not the for-in idiom");
});

test("ACCEPTANCE spec 21: the matcher refuses when the enumerator scratch registers are touched", async () => {
  const { match } = (await passModule("match")) as { match: MatchFn };
  const control = forInSynth();
  assert.notEqual(match(control.loop, control.ctx), null, "control: the measured for-in shape must match");

  // §4.1 P6: idx/size are enumerator state, never JS values. A write from the
  // body means this is not a compiler-generated for-in.
  const bad = forInSynth({ scratchTouched: true });
  assert.equal(match(bad.loop, bad.ctx), null, "a body write to the index scratch must refuse the site");
});

test("ACCEPTANCE spec 21: the matcher refuses when the exhaustion test reads a different register", async () => {
  const { match } = (await passModule("match")) as { match: MatchFn };
  const control = forInSynth();
  assert.notEqual(match(control.loop, control.ctx), null, "control: the measured for-in shape must match");

  // §4.1 P3: the JmpUndefined must test GetNextPName's own destination.
  const bad = forInSynth({ testsOtherRegister: true });
  assert.equal(match(bad.loop, bad.ctx), null, "the guard must test the key register the opcode just wrote");
});

test("ACCEPTANCE spec 21: the rung is idempotent — an already-annotated loop does not match again", async () => {
  const { match } = (await passModule("match")) as { match: MatchFn };
  const { rewrite } = (await passModule("rewrite")) as { rewrite: (m: Match<Stmt, unknown>) => Stmt };
  const control = forInSynth();
  const first = match(control.loop, control.ctx);
  assert.notEqual(first, null, "control: the measured for-in shape must match");
  const after = rewrite(first!);
  assert.equal(after.k, "loop");
  const ctx2: PassContext = { ...control.ctx, parentOf: (node: unknown) => (node === after ? { parent: control.ctx.structured!.root, index: 2 } : null) };
  assert.equal(match(after, ctx2), null, "PL-08: a second run must rewrite nothing");
});

test("ACCEPTANCE spec 21: the checker refuses a rewrite that changed the tree shape", async () => {
  const { check } = (await passModule("check")) as { check: CheckFn };
  const control = forInSynth();
  // Annotation-only (LADDER §4.3): sameShape(before, after) is the whole
  // obligation on the tree. This "rewrite" also drops the body block.
  const mangled: Stmt = {
    k: "loop",
    label: 1,
    body: seq([{ k: "block", cfgBlock: 1 }, { k: "if", cfgBlock: 1, then: { k: "break", label: 0 }, else: seq([]) }, { k: "continue", label: 1 }]),
    form: { kind: "for-in", cond: 1, at: "head", negate: true, iter: 1, setup: 0, close: [], binding: 1, source: 5 } as never,
  };
  const verdict = check(control.loop, mangled, control.ctx);
  assert.equal(verdict.ok, false, "a shape change must be refused");
  assert.match(verdict.reason ?? "", /shape/i);
});

test("ACCEPTANCE spec 21: for-in never claims a for-of site", async () => {
  // §4.3: the two rungs must not see each other's shapes. 06-for-of-array
  // contains three `for...of` loops and no `for...in` at all.
  for (const v of ["v94", "v99"]) {
    const code = decompiled("06-for-of-array", v);
    assert.equal(forInHeads(code), 0, `${v}: for-in must not fire on an iterator loop`);
    assert.ok(forOfHeads(code) >= 0);
  }
});
