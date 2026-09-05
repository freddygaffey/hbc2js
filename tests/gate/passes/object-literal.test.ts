// docs/specs/passes/20-object-literal.md — M5 rung 20. Unit tests on
// hand-built ASTs (positives: a plain three-property run, a run whose values
// are closures, integer keys, a v99 `NewObjectWithBuffer` placeholder run;
// negatives: a `PutById` run, an intervening read of the half-built object,
// a `__proto__` key, a non-contiguous run, an unstamped statement; one
// mutation the checker must reject) plus fixture-level, rung-owned
// assertions on 63 (docs/CONSOLIDATION.md §B item 7: no exact-output
// comparison against a shared fixture's whole decompiled text).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decompile } from "../../../src/decompile.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { check } from "../../../src/passes/object-literal/check.ts";
import { objectLiteral } from "../../../src/passes/object-literal/index.ts";
import { match } from "../../../src/passes/object-literal/match.ts";
import { rewrite } from "../../../src/passes/object-literal/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";
import type { FunctionCfg } from "../../../src/cfg/types.ts";
import { repoRoot } from "../../support/paths.ts";

const id = (name: string): Expr => ({ k: "ident", name });
const lit = (text: string): Expr => ({ k: "lit", text });
const obj = (props: readonly { key: string; computed: boolean; value: Expr }[]): Expr => ({ k: "object", props });

/** A statement stamped as if the emitter had lowered `opcode` at `offset`. */
let nextOffset = 0;
const stamped = (s: Stmt, opcode: string): Stmt => {
  const offset = nextOffset;
  nextOffset += 4;
  OPCODES.set(offset, opcode);
  return { ...s, origin: { fn: 0, start: offset, end: offset + 4 } } as Stmt;
};
const OPCODES = new Map<number, string>();

const def = (reg: string, props: readonly { key: string; computed: boolean; value: Expr }[], opcode = "NewObject"): Stmt => stamped({ k: "expr", expr: { k: "assign", target: id(reg), value: obj(props) } }, opcode);
const store = (reg: string, key: string, computed: boolean, value: Expr, opcode = "PutNewOwnByIdShort"): Stmt =>
  stamped({ k: "expr", expr: { k: "assign", target: { k: "member", obj: id(reg), prop: lit(key), computed }, value } }, opcode);

/** A `PassContext` whose `cfg` answers `opcodeAt` from `OPCODES`. */
function ctxFor(): PassContext {
  const blocks = [{ instructions: [...OPCODES].map(([offset, name]) => ({ offset, name, length: 4, operands: [] })) }];
  return { functionIndex: 0, cfg: { blocks } as unknown as FunctionCfg } as PassContext;
}

function fold(list: readonly Stmt[]): readonly Stmt[] | null {
  const ctx = ctxFor();
  const m = match(list, ctx);
  if (m === null) return null;
  const after = rewrite(m);
  const v = check(list, after, ctx);
  assert.equal(v.ok, true, v.reason);
  return after;
}

// ---------------------------------------------------------------------------
// Positives.
// ---------------------------------------------------------------------------

test("object-literal folds a plain three-property NewObject run", () => {
  const list = [def("r0", []), store("r0", "x", false, id("r3")), store("r0", "y", false, id("r2")), store("r0", "tag", false, id("r1")), { k: "return", arg: id("r0") } as Stmt];
  const after = fold(list);
  assert.ok(after !== null);
  assert.equal(after.length, 2);
  const value = (after[0] as { expr: { value: Expr } }).expr.value;
  assert.equal(value.k, "object");
  assert.deepEqual(
    (value as Extract<Expr, { k: "object" }>).props.map((p) => ("k" in p ? "…" : p.key)),
    ["x", "y", "tag"],
  );
});

test("object-literal folds closure values (the literal-with-closure-values case)", () => {
  const fn = (name: string): Expr => ({ k: "func", name, params: [], body: [] });
  const list = [def("r0", []), store("r0", "name", false, lit('"counter"')), store("r0", "inc", false, fn("inc")), store("r0", "read", false, fn("read"))];
  const after = fold(list);
  assert.ok(after !== null);
  assert.equal(after.length, 1);
  const props = ((after[0] as { expr: { value: Expr } }).expr.value as Extract<Expr, { k: "object" }>).props;
  assert.equal(props.length, 3);
  assert.equal(props.filter((p) => !("k" in p) && p.value.k === "func").length, 2);
});

test("object-literal writes an integer key non-computed", () => {
  const list = [def("r0", []), store("r0", "1", true, id("r4"), "PutOwnByIndex"), store("r0", "0", true, id("r3"), "PutOwnByIndex"), store("r0", "len", false, id("r1"))];
  const after = fold(list);
  assert.ok(after !== null);
  const props = ((after[0] as { expr: { value: Expr } }).expr.value as Extract<Expr, { k: "object" }>).props;
  assert.deepEqual(
    props.map((p) => ("k" in p ? "…" : `${p.key}/${String(p.computed)}`)),
    ["1/false", "0/false", "len/false"],
  );
});

test("object-literal replaces a NewObjectWithBuffer placeholder in place, keeping its position", () => {
  const list = [
    def("r0", [
      { key: "name", computed: false, value: lit('"counter"') },
      { key: "inc", computed: false, value: lit("null") },
      { key: "read", computed: false, value: lit("null") },
    ], "NewObjectWithBuffer"),
    store("r0", "read", false, id("r9"), "PutOwnBySlotIdx"),
    store("r0", "inc", false, id("r8"), "PutOwnBySlotIdx"),
  ];
  const after = fold(list);
  assert.ok(after !== null);
  const props = ((after[0] as { expr: { value: Expr } }).expr.value as Extract<Expr, { k: "object" }>).props;
  assert.deepEqual(
    props.map((p) => ("k" in p ? "…" : p.key)),
    ["name", "inc", "read"],
  );
  assert.deepEqual(
    props.map((p) => ("k" in p ? "…" : ((p.value as { name?: string; text?: string }).name ?? (p.value as { text?: string }).text))),
    ['"counter"', "r8", "r9"],
  );
});

test("object-literal folds only the prefix before an accessor define", () => {
  const list = [
    def("r0", []),
    store("r0", "plain", false, id("r2")),
    { k: "expr", expr: { k: "call", callee: { k: "member", obj: id("Object"), prop: lit("defineProperty"), computed: false }, args: [id("r0"), lit('"doubled"'), obj([])] } } as Stmt,
    store("r0", "after", false, id("r3")),
  ];
  const after = fold(list);
  assert.ok(after !== null);
  assert.equal(after.length, 3);
  const props = ((after[0] as { expr: { value: Expr } }).expr.value as Extract<Expr, { k: "object" }>).props;
  assert.equal(props.length, 1);
});

// ---------------------------------------------------------------------------
// Negatives.
// ---------------------------------------------------------------------------

test("object-literal refuses a PutById run (full [[Set]], not an own define)", () => {
  const list = [def("r0", []), store("r0", "a", false, id("r1"), "PutByIdLoose"), store("r0", "b", false, id("r2"), "PutByIdLoose")];
  assert.equal(match(list, ctxFor()), null);
});

test("object-literal refuses a value that reads the half-built object", () => {
  const list = [def("r0", []), store("r0", "a", false, { k: "member", obj: id("r0"), prop: lit("z"), computed: false })];
  assert.equal(match(list, ctxFor()), null);
});

test("object-literal refuses a __proto__ key in either spelling", () => {
  assert.equal(match([def("r0", []), store("r0", "__proto__", false, id("r1"))], ctxFor()), null);
  assert.equal(match([def("r0", []), store("r0", '"__proto__"', true, id("r1"))], ctxFor()), null);
});

test("object-literal refuses a non-contiguous run and an unstamped store", () => {
  const gap = [def("r0", []), { k: "expr", expr: { k: "assign", target: id("r5"), value: lit("1") } } as Stmt, store("r0", "a", false, id("r5"))];
  assert.equal(match(gap, ctxFor()), null);
  const unstamped: Stmt = { k: "expr", expr: { k: "assign", target: { k: "member", obj: id("r0"), prop: lit("a"), computed: false }, value: id("r1") } };
  assert.equal(match([def("r0", []), unstamped], ctxFor()), null);
});

test("object-literal refuses NewObjectWithParent (the prototype is a runtime value)", () => {
  assert.equal(match([def("r0", [], "NewObjectWithParent"), store("r0", "a", false, id("r1"))], ctxFor()), null);
});

test("object-literal is a fixed point (PL-08)", () => {
  const list = [def("r0", []), store("r0", "x", false, id("r3")), store("r0", "y", false, id("r2"))];
  const once = fold(list);
  assert.ok(once !== null);
  assert.equal(match(once, ctxFor()), null);
});

// ---------------------------------------------------------------------------
// The checker rejects a mutated writer.
// ---------------------------------------------------------------------------

test("object-literal check rejects a reordered property list", () => {
  const list = [def("r0", []), store("r0", "x", false, id("r3")), store("r0", "y", false, id("r2"))];
  const ctx = ctxFor();
  const m = match(list, ctx);
  assert.ok(m !== null);
  const bad = rewrite({ ...m, data: { ...m.data, props: [...m.data.props].reverse() } });
  const v = check(list, bad, ctx);
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /key\/order/);
});

test("object-literal check rejects dropping one store too many", () => {
  const list = [def("r0", []), store("r0", "x", false, id("r3")), store("r0", "y", false, id("r2")), { k: "return", arg: id("r0") } as Stmt];
  const ctx = ctxFor();
  const m = match(list, ctx);
  assert.ok(m !== null);
  const bad = rewrite({ ...m, data: { ...m.data, storeCount: m.data.storeCount + 1 } });
  assert.equal(check(list, bad, ctx).ok, false);
});

// ---------------------------------------------------------------------------
// Fixture-level, rung-owned assertions (CONSOLIDATION §B item 7).
// ---------------------------------------------------------------------------

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "63-object-literal");

function js(version: string, skip: readonly string[] = []): string {
  return decompile(readFileSync(join(FIXTURE, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: skip.length > 0 ? { skip } : {} }).code;
}

test("object-literal registers in the ladder between optional-chain and jsx-recover", () => {
  assert.equal(objectLiteral.stage, "B");
  assert.deepEqual([...objectLiteral.before!], ["jsx-recover", "var-naming"]);
  assert.ok(objectLiteral.after!.includes("expr-rebuild"));
});

for (const version of ["v84", "v94", "v96", "v98", "v99"]) {
  test(`object-literal rebuilds the fixture's literals at ${version}`, () => {
    const on = js(version);
    const off = js(version, ["object-literal"]);
    // Rung-owned property 1: the baseline builds `point` as a definition plus
    // one store per property (v84/94/96: `= {}`; v98/99: a
    // `NewObjectWithBuffer` literal of placeholders). With the rung on, no
    // `.tag =` store survives anywhere and the literal carries all three.
    assert.match(off, /\.tag = /);
    assert.doesNotMatch(on, /\.tag = /);
    assert.match(on, /\{x: [^\n]+, y: [^\n]+, tag: [^\n]+\}/);
    // Rung-owned property 2: the closure-valued literal is one statement.
    assert.match(on, /\{name: "counter", inc: \w+, read: \w+\}/);
    assert.doesNotMatch(on, /\.inc = \w+;/);
    // Rung-owned property 3: strictly fewer own-property store statements and
    // strictly fewer lines than with the rung skipped. (A count, not a
    // literal-text comparison — CONSOLIDATION §B item 7.)
    const stores = (s: string): number => (s.match(/^\s*\w+(?:\.\w+|\[\d+\]) = [^\n]*;$/gm) ?? []).length;
    assert.ok(stores(on) < stores(off), `expected fewer property stores with the rung on (${stores(on)} vs ${stores(off)})`);
    assert.ok(on.split("\n").length < off.split("\n").length);
  });

  test(`object-literal refuses the fixture's negative controls at ${version}`, () => {
    const on = js(version);
    // D: the intervening read of the half-built object stays two statements.
    assert.match(on, /\.a = [^\n]*\n\s*\w+\.b = \w+\.a /);
    // E: the accessor still goes through Object.defineProperty, and the
    // property after it is still a separate store.
    assert.match(on, /Object\.defineProperty\([^\n]*"doubled"/);
    // docs/BUGS.md 2026-09-01 "register prologue" (F26): the intervening
    // store may now be a register's own first-definition `let rN = …;`
    // instead of a bare `rN = …;` (the prologue no longer hoists a register
    // whose first def is this plain a top-level statement) — either form is
    // fine, the property under test is only that `.after` is still a
    // separate statement.
    assert.match(on, /Object\.defineProperty\([^\n]*\n\s*((?:let |const |var )?\w+ = [^\n]*;\n\s*)?\w+\.after = /);
    // F: the object escapes mid-run, so `second` is never folded in.
    assert.match(on, /\.second = /);
  });
}
