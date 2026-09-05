// ACCEPTANCE: spec 21 (docs/specs/passes/21-for-in-for-of.md) — the `for-of`
// stage-A rung, catalogue row 10.
//
// Written BEFORE `src/passes/for-of/` existed and marked `{ skip: SKIP }` so
// the gate stayed green until the rung landed. The `skip` option was removed
// from every `test(...)` here in the landing commit, nothing else changed
// (spec 21 §8).
//
// Testing rules (CLAUDE.md): counts, regexes over the decompiled text,
// structural checks and equivalence verdicts only — no literal comparison
// against the output of a shared fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import { hbc2jsDecompiler, runTier } from "../../../src/harness/tiers.ts";
import { structure } from "../../../src/structure/index.ts";
import { seq } from "../../../src/structure/ir.ts";
import type { Stmt } from "../../../src/structure/ir.ts";
import type { CheckResult, Match, PassContext } from "../../../src/passes/types.ts";
import { addr, imm, insn, reg, synthCfg } from "./synth.ts";

/** Runtime specifier: unresolvable at type-check time on purpose (spec 21 §8). */
const passModule = async (file: string): Promise<Record<string, unknown>> =>
  (await import(new URL(`../../../src/passes/for-of/${file}.ts`, import.meta.url).href)) as Record<string, unknown>;

type MatchFn = (node: Stmt, ctx: PassContext) => Match<Stmt, unknown> | null;
type CheckFn = (before: Stmt, after: Stmt, ctx: PassContext) => CheckResult;

const fixtureBytes = (name: string, version: string): Uint8Array =>
  new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, `${version}.hbc`)));
const decompiled = (name: string, version: string): string => decompile(fixtureBytes(name, version), { moduleName: "x" }).code;

const forOfHeads = (code: string): number => (code.match(/\bfor\s*\((?:const|let|var)\s+[A-Za-z_$][\w$]*\s+of\s/g) ?? []).length;
const callSites = (code: string, helper: string): number =>
  (code.match(new RegExp(`${helper}\\(`, "g")) ?? []).length - (code.match(new RegExp(`function\\s+${helper}\\(`, "g")) ?? []).length;

// ---------------------------------------------------------------------------
// Hand-forged trees, `match` called directly (no driver, no round-trip), so a
// refusal is provably the matcher's own. Each negative is paired with the
// positive control it perturbs.
//
// NOTE for the implementer, and an acceptance constraint in its own right:
// `synthCfg` builds no exception regions, so the matcher must read the
// synthesized cleanup handler through the TREE — `try.handler` -> `throw bC`
// -> `instructionsOf(bC)` — as spec 21 §4.2 P5 describes it, not through
// `regionBlocks(fn, region)`. A matcher that needs the region table cannot see
// a hand-built tree and cannot be unit-tested for its refusals.

interface ForOfOpts {
  /** Handler is a user `catch`, not `Catch; IteratorClose s, 1; Throw` (§4.2 P5). */
  readonly userHandler?: boolean;
  /** The abrupt `IteratorClose` names a register that is not the state (§4.2 P6). */
  readonly closeWrongRegister?: boolean;
  /** The exit block reads the iteration state, so it is live after the loop (§4.2 P7). */
  readonly stateLiveAfter?: boolean;
}

/**
 * The measured for-of shape (spec 21 §2.2), in its v99 spelling — the source
 * operand of `IteratorNext` is a per-iteration `Mov` copy that aliases the
 * destination register, which is exactly what a v94-only matcher gets wrong.
 *
 *   block b0                      ; IteratorBegin r4, r6
 *   loop L1 {
 *     block b1                    ; Mov r7,r6; IteratorNext r7,r4,r7; Mov r8,r4; JStrictEqual EXIT, r8, r3
 *     if b1 { return b3 } else {}
 *     try { block b2; continue L1 } catch r0 { throw b4 }
 *   }
 */
function forOfSynth(opts: ForOfOpts = {}) {
  const handlerInsns = opts.userHandler === true
    ? [insn("Catch", reg(0)), insn("Mov", reg(1), reg(0)), insn("Throw", reg(0))]
    : [insn("Catch", reg(0)), insn("IteratorClose", reg(opts.closeWrongRegister === true ? 9 : 4), imm(1)), insn("Throw", reg(0))];
  // PUSHBACK P-18a: the plain exit must not read the binding register `r7`
  // either — spec 21 §4.2 P8 / §6.4 make `registerLiveAfter(binding) === false`
  // a precondition of the site, so `Ret r7` (this fixture's original spelling)
  // was itself a shape the rung is required to refuse. `Ret r2` keeps the exit
  // exactly as trivial and stays parallel with the `stateLiveAfter` variant,
  // which perturbs it by reading `r4` instead. Every assertion is unchanged.
  const exitInsns = opts.stateLiveAfter === true
    ? [insn("Mov", reg(2), reg(4)), insn("Ret", reg(2))]
    : [insn("Mov", reg(2), reg(3)), insn("Ret", reg(2))];
  const cfg = synthCfg([
    { succs: [1], insns: [insn("LoadConstUndefined", reg(3)), insn("Mov", reg(6), reg(9)), insn("IteratorBegin", reg(4), reg(6))] },
    { succs: [3, 2], insns: [insn("Mov", reg(7), reg(6)), insn("IteratorNext", reg(7), reg(4), reg(7)), insn("Mov", reg(8), reg(4)), insn("JStrictEqual", addr(12), reg(8), reg(3))] },
    { succs: [1], insns: [insn("Mov", reg(0), reg(7))] },
    { succs: [], insns: exitInsns },
    { succs: [], insns: handlerInsns },
  ]);
  const loop: Stmt = {
    k: "loop",
    label: 1,
    body: seq([
      { k: "block", cfgBlock: 1 },
      { k: "if", cfgBlock: 1, then: { k: "return", cfgBlock: 3 }, else: seq([]) },
      { k: "try", region: 0, cfgBlock: 2, body: seq([{ k: "block", cfgBlock: 2 }, { k: "continue", label: 1 }]), handler: { k: "throw", cfgBlock: 4 }, catchRegister: 0 },
    ]),
  };
  const root = seq([{ k: "block", cfgBlock: 0 }, loop]);
  const fn = structure(cfg);
  const ctx: PassContext = {
    analysis: null as unknown as PassContext["analysis"],
    functionIndex: 0,
    cfg,
    hbcVersion: 99,
    layoutClass: "hbc99" as PassContext["layoutClass"],
    applied: ["loop-cond", "for-header"],
    diagnostic: () => {},
    structured: { ...fn, root },
    parentOf: (node: unknown) => (node === loop ? { parent: root, index: 1 } : null),
  };
  return { cfg, root, loop, ctx };
}

// ---------------------------------------------------------------------------

test("ACCEPTANCE spec 21: for-of is a registered stage-A rung on catalogue row 10", async () => {
  const { forOf } = (await passModule("index")) as { forOf: { name: string; stage: string; catalogue: readonly (number | string)[]; after?: readonly string[]; before?: readonly string[] } };
  const { REGISTRY } = await import("../../../src/passes/registry.ts");
  assert.equal(forOf.name, "for-of");
  assert.equal(forOf.stage, "A");
  assert.deepEqual([...forOf.catalogue], [10]);
  assert.ok(forOf.after?.includes("loop-cond"), "spec 21 §7: after loop-cond");
  assert.ok(forOf.after?.includes("for-header"), "spec 21 §7: after for-header");
  assert.ok(forOf.before?.includes("label-clean"), "spec 21 §7: before label-clean");
  const names = REGISTRY.map((p) => p.name);
  assert.ok(names.includes("for-of"), "the rung is switched on in src/passes/registry.ts");
  assert.ok(names.indexOf("for-of") > names.indexOf("for-header"), "registered after for-header");
  assert.ok(names.indexOf("for-of") < names.indexOf("label-clean"), "registered before label-clean");
});

test("ACCEPTANCE spec 21: fixtures 06 and 07 print one `for (… of …)` per source loop, at every version", async () => {
  // 06-for-of-array: three loops (break, plain, sparse). 07-for-of-iterable:
  // three loops (Map with entry destructuring, Set, hand-rolled iterator).
  for (const name of ["06-for-of-array", "07-for-of-iterable"]) {
    const counts = new Map<string, number>();
    for (const v of ["v84", "v94", "v96", "v98", "v99"]) counts.set(v, forOfHeads(decompiled(name, v)));
    for (const [v, n] of counts) assert.equal(n, 3, `${name} ${v}: expected 3 for-of heads, got ${n}`);
    assert.equal(new Set(counts.values()).size, 1, `${name}: version parity`);
  }
});

test("ACCEPTANCE spec 21: the nested destructuring iterator in fixture 07 is not claimed as a fourth loop", async () => {
  // §4.4: `for (const [k, v] of m)` lowers to an OUTER for-of whose body holds
  // a second IteratorBegin/IteratorNext pair for the `[k, v]` entry. That pair
  // is `destructure`'s row 22 site, has no `loop` node, and must not become a
  // for-of. Four IteratorBegin sites in the bytecode, three for-of statements.
  for (const v of ["v94", "v99"]) assert.equal(forOfHeads(decompiled("07-for-of-iterable", v)), 3, `${v}: exactly the three source loops`);
});

test("ACCEPTANCE spec 21: no iterator machinery survives in fixture 06's output", async () => {
  // 06 has no destructuring and no spread, so every iterator helper call in it
  // belongs to a for-of loop and must be gone.
  for (const v of ["v94", "v99"]) {
    const code = decompiled("06-for-of-array", v);
    assert.equal(callSites(code, "__hbc_iterBegin"), 0, `${v}: an IteratorBegin helper call survived`);
    assert.equal(callSites(code, "__hbc_iterNext"), 0, `${v}: an IteratorNext helper call survived`);
    assert.equal(callSites(code, "__hbc_iterClose"), 0, `${v}: an IteratorClose helper call survived`);
  }
});

test("ACCEPTANCE spec 21: fixtures 06 and 07 still pass the equivalence oracle at every version", async () => {
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only: ["06-for-of-array", "07-for-of-iterable"] });
  assert.deepEqual(report.results.filter((r) => r.verdict !== "PASS").map((r) => `${r.fixture.name}: ${r.verdict}`), []);
  assert.ok(report.summary.pass >= 10, `expected both fixtures at all 5 versions, got ${report.summary.pass}`);
});

test("ACCEPTANCE spec 21: the matcher accepts the v99 Mov-aliased header and refuses a user catch", async () => {
  const { match } = (await passModule("match")) as { match: MatchFn };
  const control = forOfSynth();
  assert.notEqual(match(control.loop, control.ctx), null, "control: the measured v99 for-of shape must match (Mov-refreshed source aliasing the destination register)");

  // §4.2 P5: a handler that is not exactly `Catch; IteratorClose s, 1; Throw`
  // is a user try/catch. try-shape owns it; this rung refuses outright.
  const bad = forOfSynth({ userHandler: true });
  assert.equal(match(bad.loop, bad.ctx), null, "a user catch must not be dropped as iterator cleanup");
});

test("ACCEPTANCE spec 21: the matcher refuses an IteratorClose on a register that is not the state", async () => {
  const { match } = (await passModule("match")) as { match: MatchFn };
  const control = forOfSynth();
  assert.notEqual(match(control.loop, control.ctx), null, "control: the measured v99 for-of shape must match");
  const bad = forOfSynth({ closeWrongRegister: true });
  assert.equal(match(bad.loop, bad.ctx), null, "§4.2 P6: every close must name the state register");
});

test("ACCEPTANCE spec 21: the matcher refuses when the iteration state is live after the loop", async () => {
  const { match } = (await passModule("match")) as { match: MatchFn };
  const control = forOfSynth();
  assert.notEqual(match(control.loop, control.ctx), null, "control: the measured v99 for-of shape must match");
  // §4.2 P7 / §6.4: the state register must be dead at the loop's exit — the
  // semantic predicate the annotation asserts. Here the exit block reads it.
  const bad = forOfSynth({ stateLiveAfter: true });
  assert.equal(match(bad.loop, bad.ctx), null, "iteration state read after the loop must refuse the site");
});

test("ACCEPTANCE spec 21: the rung is idempotent — an already-annotated loop does not match again", async () => {
  const { match } = (await passModule("match")) as { match: MatchFn };
  const { rewrite } = (await passModule("rewrite")) as { rewrite: (m: Match<Stmt, unknown>) => Stmt };
  const control = forOfSynth();
  const first = match(control.loop, control.ctx);
  assert.notEqual(first, null, "control: the measured v99 for-of shape must match");
  const after = rewrite(first!);
  assert.equal(after.k, "loop");
  const ctx2: PassContext = { ...control.ctx, parentOf: (node: unknown) => (node === after ? { parent: control.root, index: 1 } : null) };
  assert.equal(match(after, ctx2), null, "PL-08: a second run must rewrite nothing");
});

test("ACCEPTANCE spec 21: the checker refuses a rewrite that changed the tree shape", async () => {
  const { check } = (await passModule("check")) as { check: CheckFn };
  const control = forOfSynth();
  // Annotation-only (LADDER §4.3): the try node may NOT be deleted by the
  // rung — the emitter drops it at print time. A rewrite that removes it is a
  // shape change and must be refused.
  const mangled: Stmt = {
    k: "loop",
    label: 1,
    body: seq([
      { k: "block", cfgBlock: 1 },
      { k: "if", cfgBlock: 1, then: { k: "return", cfgBlock: 3 }, else: seq([]) },
      { k: "block", cfgBlock: 2 },
      { k: "continue", label: 1 },
    ]),
    form: { kind: "for-of", cond: 1, at: "head", negate: true, iter: 1, setup: 0, close: [4], binding: 7, source: 6 } as never,
  };
  const verdict = check(control.loop, mangled, control.ctx);
  assert.equal(verdict.ok, false, "a shape change must be refused");
  assert.match(verdict.reason ?? "", /shape/i);
});
