// docs/specs/passes/01-framework-fixes.md F1 (the stage-B driver) and F8
// (src/passes/ast.ts, stage B's `tree.ts`). Unit tests on hand-built ASTs —
// no HBC fixture needed, since this is pure framework over `src/emit/ast.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, lit } from "../../../src/emit/ast.ts";
import {
  applyAstPasses,
  defUse,
  effectSequence,
  expressionOnlyCheck,
  freeNames,
  identUses,
  isHelperCall,
  isPure,
  isPureStmt,
  isSafeIdentifier,
  mapExpr,
  mapStmts,
  parses,
  spliceList,
  stmtLists,
  walk,
} from "../../../src/passes/ast.ts";
import { pruneRegisterDecls } from "../../../src/passes/index.ts";
import type { CheckResult, Match, Pass, PassContext } from "../../../src/passes/types.ts";
import { ErrorCode, Hbc2jsError } from "../../../src/errors.ts";

const assignExpr = (target: Expr, value: Expr): Expr => ({ k: "assign", target, value });
const exprStmt = (e: Expr): Stmt => ({ k: "expr", expr: e });
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });

const baseCtx: Omit<PassContext, "applied" | "structured" | "parentOf" | "fnBody"> = {
  analysis: null as unknown as PassContext["analysis"],
  functionIndex: 0,
  cfg: null as unknown as PassContext["cfg"],
  hbcVersion: 94,
  layoutClass: "hbc94" as PassContext["layoutClass"],
  diagnostic: () => {},
};

// ---------------------------------------------------------------------------
// stmtLists / spliceList (F1)
// ---------------------------------------------------------------------------

test("stmtLists: innermost first, and it does not descend into a nested func's body", () => {
  const innerFunc: Stmt = { k: "func", name: "inner", params: [], body: [exprStmt(call(id("shouldNotAppear"), []))] };
  const thenList: Stmt[] = [exprStmt(call(id("a"), []))];
  const elseList: Stmt[] = [innerFunc];
  const ifStmt: Stmt = { k: "if", test: id("c"), then: thenList, else: elseList };
  const body: readonly Stmt[] = [ifStmt];

  const lists = stmtLists(body);
  // The func's own body must never be yielded as a site.
  for (const l of lists) assert.ok(l !== (innerFunc as Stmt & { k: "func" }).body, "must not yield a nested func's body as a site");
  // Both branches, then the whole body, in that (innermost-first) order.
  assert.deepEqual(lists, [thenList, elseList, body]);
});

test("spliceList: replaces the target list by identity, rebuilding only the spine, and leaves untouched siblings' identity alone", () => {
  const target: readonly Stmt[] = [exprStmt(call(id("old"), []))];
  const untouchedSibling: readonly Stmt[] = [exprStmt(call(id("sibling"), []))];
  const ifStmt: Stmt = { k: "if", test: id("c"), then: target, else: untouchedSibling };
  const body: readonly Stmt[] = [ifStmt];
  const repl: readonly Stmt[] = [exprStmt(call(id("new"), []))];

  const out = spliceList(body, target, repl);
  assert.notEqual(out, body);
  const outIf = out[0] as Stmt & { k: "if" };
  assert.equal(outIf.then, repl);
  assert.equal(outIf.else, untouchedSibling, "an untouched sibling list keeps its identity");

  // Splicing the root itself is the identity case.
  assert.equal(spliceList(body, body, repl), repl);
  // A list that is not reachable at all leaves the tree unchanged (same object).
  const unrelated: readonly Stmt[] = [exprStmt(id("z"))];
  assert.equal(spliceList(body, unrelated, repl), body);
});

// ---------------------------------------------------------------------------
// walk / mapExpr / mapStmts
// ---------------------------------------------------------------------------

test("walk: visits every expression, including inside a nested func", () => {
  const nested: Stmt = { k: "func", name: "f", params: [], body: [exprStmt(id("deep"))] };
  const body: readonly Stmt[] = [exprStmt(call(id("outer"), [id("a")])), nested];
  const names: string[] = [];
  walk(body, { expr: (e) => { if (e.k === "ident") names.push(e.name); } });
  assert.deepEqual(names.sort(), ["a", "deep", "outer"]);
});

test("mapExpr: rebuilds only where a child actually changed, renaming an ident", () => {
  const untouched: Expr = id("keepme");
  const target: Expr = call(id("rN"), [untouched]);
  const rewritten = mapExpr(target, (e) => (e.k === "ident" && e.name === "rN" ? id("renamed") : e));
  assert.deepEqual(rewritten, call(id("renamed"), [untouched]));
  assert.equal((rewritten as Expr & { k: "call" }).args[0], untouched, "an unchanged child keeps its identity");
});

test("mapStmts: identity when nothing changes; rebuilds the spine when something does", () => {
  const body: readonly Stmt[] = [exprStmt(id("a")), exprStmt(id("b"))];
  assert.equal(mapStmts(body, (s) => s), body);
  const out = mapStmts(body, (s) => s, (e) => (e.k === "ident" && e.name === "a" ? id("A") : e));
  assert.notEqual(out, body);
  assert.deepEqual(out[0], exprStmt(id("A")));
  assert.equal(out[1], body[1], "the untouched statement keeps its identity");
});

// ---------------------------------------------------------------------------
// freeNames / parses
// ---------------------------------------------------------------------------

test("freeNames: names used but not declared anywhere in the list, including inside a nested func", () => {
  const body: readonly Stmt[] = [{ k: "init", kind: "let", name: "x", value: id("y") }, exprStmt(call(id("f"), [id("x")])), { k: "func", name: "g", params: ["p"], body: [exprStmt(call(id("p"), [id("z")]))] }];
  assert.deepEqual(freeNames(body), new Set(["y", "f", "z"]));
});

test("parses: valid statement lists parse, and a bare unparseable body does not", () => {
  assert.ok(parses([exprStmt(call(id("f"), [])), { k: "return", arg: null }]));
  assert.ok(!parses([{ k: "expr", expr: { k: "assign", target: lit("1"), value: lit("2") } }]));
});

// ---------------------------------------------------------------------------
// identUses
// ---------------------------------------------------------------------------

test("identUses: reads, writes, and uses inside a nested func kept separate (non-register name — a genuine, collision-free cross-scope reference)", () => {
  const body: readonly Stmt[] = [
    { k: "init", kind: "let", name: "_e0_0", value: lit("0") }, // write
    exprStmt(call(id("f"), [id("_e0_0")])), // read
    exprStmt(assignExpr(id("_e0_0"), id("_e0_0"))), // read (value) + write (target)
    { k: "func", name: "g", params: [], body: [exprStmt(id("_e0_0"))] }, // nested: a real capture
  ];
  assert.deepEqual(identUses(body, "_e0_0"), { reads: 2, writes: 2, nested: 1 });
});

// Function-scope-aware fix (docs/AGENT-LOG.md): Hermes restarts register
// numbering per function, and this codebase's emitter only ever copies a
// genuinely captured value into a collision-free env-slot name
// (`_e<env>_<slot>`, see `src/emit/names.ts`) before it crosses a function
// boundary — a raw register name is always function-local, never itself the
// captured value. So unlike the non-register case above, a nested `func`
// mentioning the same register number is *never* counted as a use of this
// frame's register, no matter how the nested body uses it.
test("identUses: a register name reused by a nested func's own frame is never counted as nested — `nested` is always 0", () => {
  const body: readonly Stmt[] = [
    { k: "init", kind: "let", name: "r1", value: lit("0") }, // write
    exprStmt(call(id("f"), [id("r1")])), // read
    { k: "func", name: "g", params: [], body: [exprStmt(assignExpr(id("r1"), call(id("use"), [id("r1")])))] }, // separate frame's own r1: read + write, neither ours
  ];
  assert.deepEqual(identUses(body, "r1"), { reads: 1, writes: 1, nested: 0 });
});

test("identUses: querying the nested function's own body directly attributes its register uses to that scope", () => {
  const nestedBody: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), call(id("use"), [id("r1")])))];
  assert.deepEqual(identUses(nestedBody, "r1"), { reads: 1, writes: 1, nested: 0 });
});

// ---------------------------------------------------------------------------
// defUse
// ---------------------------------------------------------------------------

test("defUse: rN defs/reads only, by pre-order statement index; a nested func's own rN is a different frame", () => {
  const body: readonly Stmt[] = [
    { k: "init", kind: "let", name: "r1", value: lit("0") }, // stmt 0: def r1
    exprStmt(assignExpr(id("r2"), id("r1"))), // stmt 1: read r1, def r2
    { k: "func", name: "g", params: [], body: [exprStmt(assignExpr(id("r1"), lit("9")))] }, // stmt 2: nested, not counted
  ];
  const du = defUse(body);
  assert.deepEqual(du.get("r1"), { defs: [0], reads: [1] });
  assert.deepEqual(du.get("r2"), { defs: [1], reads: [] });
  assert.equal(du.get("notAReg"), undefined);
});

// ---------------------------------------------------------------------------
// isPure / isPureStmt / isHelperCall / isSafeIdentifier
// ---------------------------------------------------------------------------

test("isPure: literals/idents/this/unary/binary/logical/cond over pure; never member, call, new, assign", () => {
  assert.ok(isPure(lit("1")));
  assert.ok(isPure(id("x")));
  assert.ok(isPure({ k: "this" }));
  assert.ok(isPure({ k: "bin", op: "+", left: id("a"), right: lit("1") }));
  assert.ok(isPure({ k: "cond", test: id("a"), then: lit("1"), else: lit("2") }));
  assert.ok(!isPure(member(id("o"), "p")));
  assert.ok(!isPure(call(id("f"), [])));
  assert.ok(!isPure({ k: "new", callee: id("C"), args: [] }));
  assert.ok(!isPure(assignExpr(id("x"), lit("1"))));
});

test("isPureStmt: comment/decl, or expr assigning a pure value to an ident", () => {
  assert.ok(isPureStmt({ k: "comment", text: "x" }));
  assert.ok(isPureStmt({ k: "decl", kind: "let", names: ["r1"] }));
  assert.ok(isPureStmt(exprStmt(assignExpr(id("r1"), lit("1")))));
  assert.ok(!isPureStmt(exprStmt(assignExpr(id("r1"), call(id("f"), [])))), "impure value");
  assert.ok(!isPureStmt(exprStmt(assignExpr(member(id("o"), "p"), lit("1")))), "member target");
});

test("isHelperCall: matches by callee name, never by position", () => {
  assert.ok(isHelperCall(call(id("__hbc_b_apply"), [id("a"), id("b")]), "__hbc_b_apply"));
  assert.ok(!isHelperCall(call(id("__hbc_b_apply"), []), "__hbc_b_other"));
  assert.ok(!isHelperCall(call(member(id("o"), "__hbc_b_apply"), []), "__hbc_b_apply"), "not an ident callee");
});

test("isSafeIdentifier: the emitter's IDENT_RE + reserved words", () => {
  assert.ok(isSafeIdentifier("foo"));
  assert.ok(isSafeIdentifier("_x$1"));
  assert.ok(!isSafeIdentifier("1foo"));
  assert.ok(!isSafeIdentifier("for"));
  assert.ok(!isSafeIdentifier("foo bar"));
});

// ---------------------------------------------------------------------------
// effectSequence / expressionOnlyCheck (§4.3)
// ---------------------------------------------------------------------------

test("effectSequence: a member read is recorded, in order, alongside a call and a return", () => {
  const body: readonly Stmt[] = [exprStmt(call(member(id("o"), "push"), [member(id("arr"), "length")])), { k: "return", arg: id("r1") }];
  assert.deepEqual(effectSequence(body), [
    { k: "member-read" }, // the callee, `o.push`, itself
    { k: "member-read" }, // arr.length, evaluated as an argument before the call
    { k: "call", callee: "member.push", arity: 1 },
    { k: "return" },
  ]);
});

test("effectSequence: member write, delete, and throw are recorded; a plain rN reassignment with no nested capture is not", () => {
  const body: readonly Stmt[] = [
    exprStmt(assignExpr(member(id("o"), "p"), lit("1"))),
    exprStmt({ k: "unary", op: "delete ", arg: member(id("o"), "p") }),
    exprStmt(assignExpr(id("r1"), lit("2"))), // plain scratch register: invisible
    { k: "throw", arg: id("e") },
  ];
  assert.deepEqual(effectSequence(body), [{ k: "member-write" }, { k: "delete" }, { k: "throw" }]);
});

// Scoped analysis (docs/AGENT-LOG.md): a raw register name is always
// function-local (Hermes restarts numbering per function), so a nested
// `func` mentioning the same number is that closure's own, unrelated local —
// never a genuine capture of this frame's register, whose reassignment stays
// invisible. A real capture is always a distinct, non-register name (an env
// slot, or any other declared name), which is always visible.
test("effectSequence: a same-numbered rN in a nested func's own frame is still an invisible reassignment, and a non-rN name always is visible", () => {
  const notActuallyCaptured: readonly Stmt[] = [exprStmt(assignExpr(id("r1"), lit("1"))), { k: "func", name: "g", params: [], body: [exprStmt(id("r1"))] }];
  assert.deepEqual(effectSequence(notActuallyCaptured), []);
  const genuineCapture: readonly Stmt[] = [exprStmt(assignExpr(id("_e0_0"), lit("1"))), { k: "func", name: "g", params: [], body: [exprStmt(id("_e0_0"))] }];
  assert.deepEqual(effectSequence(genuineCapture), [{ k: "assign", name: "_e0_0" }]);
  const namedVar: readonly Stmt[] = [{ k: "init", kind: "let", name: "count", value: lit("0") }];
  assert.deepEqual(effectSequence(namedVar), [{ k: "assign", name: "count" }]);
});

test("expressionOnlyCheck: ok when the effect sequence is unchanged and no rN is read before its own def; refuses otherwise", () => {
  const before: readonly Stmt[] = [{ k: "init", kind: "let", name: "r1", value: lit("1") }, exprStmt(call(id("f"), [id("r1")]))];
  const after: readonly Stmt[] = [exprStmt(call(id("f"), [lit("1")]))]; // folded: same one effect (the call), same arity
  const ok: CheckResult = expressionOnlyCheck(before, after);
  assert.deepEqual(ok, { ok: true });

  const changedEffects: readonly Stmt[] = [exprStmt(call(id("f"), [id("r1")])), exprStmt(call(id("g"), []))]; // an extra call
  assert.equal(expressionOnlyCheck(before, changedEffects).ok, false);

  const readBeforeDef: readonly Stmt[] = [exprStmt(call(id("f"), [id("r1")])), { k: "init", kind: "let", name: "r1", value: lit("1") }];
  const verdict = expressionOnlyCheck(before, readBeforeDef);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason ?? "", /read before its first def/);
});

// ---------------------------------------------------------------------------
// F10 — register-decl pruning finaliser
// ---------------------------------------------------------------------------

test("pruneRegisterDecls: shrinks to the registers still used, drops the decl entirely when none remain, and ignores a nested func's own frame", () => {
  const stillUsed: readonly Stmt[] = [{ k: "decl", kind: "let", names: ["r0", "r1", "r2"] }, exprStmt(assignExpr(id("r0"), lit("1"))), exprStmt(call(id("f"), [id("r0")]))];
  const pruned = pruneRegisterDecls(stillUsed);
  assert.deepEqual((pruned[0] as Stmt & { k: "decl" }).names, ["r0"]);

  const noneUsed: readonly Stmt[] = [{ k: "decl", kind: "let", names: ["r0", "r1"] }, exprStmt(call(id("f"), []))];
  assert.deepEqual(pruneRegisterDecls(noneUsed), [exprStmt(call(id("f"), []))]);

  const nestedOnly: readonly Stmt[] = [{ k: "decl", kind: "let", names: ["r0"] }, { k: "func", name: "g", params: [], body: [exprStmt(id("r0"))] }];
  assert.deepEqual(pruneRegisterDecls(nestedOnly), [(nestedOnly[1] as Stmt)], "r0 used only in a nested func's own frame does not keep the outer decl alive");

  const allUsed: readonly Stmt[] = [{ k: "decl", kind: "let", names: ["r0"] }, exprStmt(id("r0"))];
  assert.equal(pruneRegisterDecls(allUsed), allUsed, "nothing to prune: same object back");

  const noDecl: readonly Stmt[] = [exprStmt(call(id("f"), []))];
  assert.equal(pruneRegisterDecls(noDecl), noDecl);
});

// ---------------------------------------------------------------------------
// F1 — the stage-B driver, on synthetic rungs.
// ---------------------------------------------------------------------------

interface RenameData {
  readonly list: readonly Stmt[];
}

/** `f(1)` -> `f(2)`: a trivial, always-matching-once rewrite with the PL-08
 *  fixed point built the stage-B way (`match` refuses its own output). */
function makeRenameRung(): Pass<readonly Stmt[], RenameData> {
  return {
    name: "synthetic-rename",
    stage: "B",
    targets: [],
    catalogue: ["R1"],
    match(list): Match<readonly Stmt[], RenameData> | null {
      const hit = list.some((s) => s.k === "expr" && s.expr.k === "call" && s.expr.args.length === 1 && s.expr.args[0]!.k === "lit" && s.expr.args[0]!.text === "1");
      return hit ? { root: list, nodes: [list], data: { list }, at: { functionIndex: 0, offset: 0 } } : null;
    },
    rewrite(m): readonly Stmt[] {
      return m.data.list.map((s) => (s.k === "expr" && s.expr.k === "call" ? { ...s, expr: { ...s.expr, args: [lit("2")] } } : s));
    },
    check(): CheckResult {
      return { ok: true };
    },
  };
}

test("applyAstPasses: a synthetic rung that matches and rewrites fires once and reaches a fixed point", () => {
  const fnBody: readonly Stmt[] = [exprStmt(call(id("f"), [lit("1")]))];
  const r = applyAstPasses(fnBody, [makeRenameRung()], baseCtx);
  assert.deepEqual(r.body, [exprStmt(call(id("f"), [lit("2")]))]);
  assert.equal(r.applied.length, 1);
  assert.equal(r.abandoned.length, 0);
});

test("applyAstPasses: a real check refusing a site leaves it untouched and abandons only that site", () => {
  const refusing: Pass<readonly Stmt[], RenameData> = { ...makeRenameRung(), check: () => ({ ok: false, reason: "unit test" }) };
  const fnBody: readonly Stmt[] = [exprStmt(call(id("f"), [lit("1")]))];
  const r = applyAstPasses(fnBody, [refusing], baseCtx);
  assert.equal(r.body, fnBody, "the untouched body is the very same object");
  assert.equal(r.applied.length, 0);
  assert.deepEqual(r.abandoned.map((a) => a.reason), ["unit test"]);
});

test("applyAstPasses: a rewrite that leaves the whole function unparseable is reverted, not just abandoned at its own site", () => {
  const unparseable: Pass<readonly Stmt[], RenameData> = {
    ...makeRenameRung(),
    rewrite: (): readonly Stmt[] => [{ k: "expr", expr: { k: "assign", target: lit("1"), value: lit("2") } }],
  };
  const fnBody: readonly Stmt[] = [exprStmt(call(id("f"), [lit("1")]))];
  const r = applyAstPasses(fnBody, [unparseable], baseCtx);
  assert.equal(r.body, fnBody, "reverted to the pre-pass body");
  assert.equal(r.applied.length, 0, "the site's own applied record was rolled back too");
  assert.equal(r.abandoned.length, 1);
  assert.match(r.abandoned[0]!.reason, /whole-function parse failed/);
});

test("applyAstPasses: an exception escaping match/rewrite/check is E_PASS_CRASH, not a silent skip", () => {
  const crashing: Pass<readonly Stmt[], RenameData> = { ...makeRenameRung(), rewrite: () => { throw new Error("boom"); } };
  const fnBody: readonly Stmt[] = [exprStmt(call(id("f"), [lit("1")]))];
  assert.throws(() => applyAstPasses(fnBody, [crashing], baseCtx), (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_PASS_CRASH);
});
