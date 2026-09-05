// ACCEPTANCE: spec 22 — docs/specs/passes/22-try-shape-try-clean.md, rung
// `try-clean` (stage B). Written before the implementation: every test that
// needs the rung is `{ skip: SKIP }` and loads it through a *non-literal*
// dynamic import, so this file typechecks and runs green while
// src/passes/try-clean/ does not exist. The orchestrator lifts the skips in
// the commit that lands the rung; nothing else in the file changes.
//
// Unit tests on hand-built statement lists (the liveness rules of spec 22
// section 4.2 and the checker of section 6.2) plus rung-owned property
// assertions on fixtures 12-16 (counts and regexes on the diff, never a
// whole-output comparison — CLAUDE.md testing rules / CONSOLIDATION section B
// item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { repoRoot } from "../../support/paths.ts";

const SKIP = "spec 22 acceptance -- unimplemented";

/** Non-literal specifier: TypeScript cannot resolve it, so this file
 *  typechecks before src/passes/try-clean exists. */
const DIR = ["..", "..", "..", "src", "passes", "try-clean"].join("/");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function rung(): Promise<{ match: Any; rewrite: Any; check: Any; tryClean: Any }> {
  const [m, r, c, i] = await Promise.all([import(`${DIR}/match.ts`), import(`${DIR}/rewrite.ts`), import(`${DIR}/check.ts`), import(`${DIR}/index.ts`)]);
  return { match: (m as Any).match, rewrite: (r as Any).rewrite, check: (c as Any).check, tryClean: (i as Any).tryClean };
}

// --- hand-built AST helpers -------------------------------------------------

const id = (name: string): Expr => ({ k: "ident", name });
const num = (v: number): Expr => ({ k: "lit", text: String(v) });
const set = (target: Expr, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target, value } });
const pc = (n: number): Stmt => set(id("__pc"), num(n));
const excCopy = (p: string): Stmt => set(id("__exc"), id(p));
const pcFrame: Stmt = { k: "init", kind: "let", name: "__pc", value: { k: "unary", op: "-", arg: num(1) } };
const excFrame: Stmt = { k: "decl", kind: "let", names: ["__exc"] };
/** `if (!(__pc >= lo && __pc <= hi)) { throw p; }` — the emitter's range guard. */
const guardOf = (lo: number, hi: number, p: string): Stmt => ({
  k: "if",
  test: { k: "unary", op: "!", arg: { k: "logical", op: "&&", left: { k: "bin", op: ">=", left: id("__pc"), right: num(lo) }, right: { k: "bin", op: "<=", left: id("__pc"), right: num(hi) } } },
  then: [{ k: "throw", arg: id(p) }],
  else: [],
});
const tryStmt = (block: readonly Stmt[], param: string, handler: readonly Stmt[]): Stmt => ({ k: "try", block, param, handler });

/** Count every `__pc = n` store, at any depth. */
function countStores(list: readonly Stmt[], name: string): number {
  let n = 0;
  const walkE = (e: Expr): void => {
    if (e.k === "assign" && e.target.k === "ident" && e.target.name === name) n++;
    for (const v of Object.values(e as unknown as Record<string, unknown>)) {
      if (v !== null && typeof v === "object") {
        if (Array.isArray(v)) v.forEach((x) => typeof x === "object" && x !== null && "k" in x && walkE(x as Expr));
        else if ("k" in (v as object)) walkE(v as Expr);
      }
    }
  };
  const walkS = (s: Stmt): void => {
    if (s.k === "expr") walkE(s.expr);
    if (s.k === "init") walkE(s.value);
    if (s.k === "if") {
      walkE(s.test);
      s.then.forEach(walkS);
      s.else.forEach(walkS);
    }
    if (s.k === "try") {
      s.block.forEach(walkS);
      s.handler.forEach(walkS);
    }
    if (s.k === "for") {
      if (s.init !== null) walkE(s.init);
      if (s.update !== null) walkE(s.update);
      s.body.forEach(walkS);
    }
    if (s.k === "while" || s.k === "do-while" || s.k === "labeled" || s.k === "func") s.body.forEach(walkS);
  };
  list.forEach(walkS);
  return n;
}

function text(list: readonly Stmt[]): string {
  return JSON.stringify(list);
}

/** match + rewrite + check on a whole function body; null when refused. */
async function clean(list: readonly Stmt[]): Promise<readonly Stmt[] | null> {
  const { match, rewrite, check } = await rung();
  const ctx = { functionIndex: 0, fnBody: list } as Any;
  const m = match(list, ctx);
  if (m === null) return null;
  const after = rewrite(m, ctx) as readonly Stmt[];
  const v = check(list, after, ctx) as { ok: boolean; reason?: string };
  assert.equal(v.ok, true, v.reason);
  return after;
}

// ---------------------------------------------------------------------------
// Liveness rules (spec 22 section 4.2).
// ---------------------------------------------------------------------------

test("try-clean: with no guard anywhere, every __pc store and the __pc = -1 frame go", { skip: SKIP }, async () => {
  const body: Stmt[] = [excFrame, pcFrame, pc(0), set(id("r0"), num(1)), tryStmt([pc(1), set(id("r0"), num(2))], "_exc0", [excCopy("_exc0"), pc(2), set(id("r1"), id("__exc"))]), pc(3), { k: "return", arg: id("r0") }];
  const after = await clean(body);
  assert.ok(after !== null);
  assert.equal(countStores(after, "__pc"), 0);
  assert.ok(!text(after).includes('"__pc"'), "no __pc reference of any kind survives");
  // The `__exc` copy is live (`r1 = __exc` is attributed to that handler).
  assert.equal(countStores(after, "__exc"), 1);
});

test("try-clean: a handler that reads __pc keeps every store in its try block", { skip: SKIP }, async () => {
  const inner: Stmt[] = [pc(1), set(id("r0"), num(2)), pc(2), set(id("r0"), num(3))];
  const body: Stmt[] = [excFrame, pcFrame, pc(0), tryStmt(inner, "_exc0", [guardOf(1, 1, "_exc0"), excCopy("_exc0"), pc(3), set(id("r0"), id("__exc"))]), pc(4)];
  const after = await clean(body);
  assert.ok(after !== null);
  // Kept: the two stores inside the guarded block. Deleted: 0, 3 and 4.
  assert.equal(countStores(after, "__pc"), 2);
  assert.ok(text(after).includes('"__pc"'), "the frame stays while a guard still reads __pc");
  const t = after.find((s) => s.k === "try") as Extract<Stmt, { k: "try" }>;
  assert.equal(countStores(t.block, "__pc"), 2);
  assert.equal(countStores(t.handler, "__pc"), 0);
});

test("try-clean: a store in an inner handler nested inside an outer guarded block stays (fixture 12 shape)", { skip: SKIP }, async () => {
  const innerTry = tryStmt([pc(0), set(id("r0"), num(1))], "_exc1", [excCopy("_exc1"), pc(2), set(id("r0"), id("__exc"))]);
  const body: Stmt[] = [excFrame, pcFrame, tryStmt([innerTry], "_exc0", [guardOf(0, 1, "_exc0"), excCopy("_exc0"), pc(3), { k: "return", arg: id("r0") }])];
  const after = await clean(body);
  assert.ok(after !== null);
  const outer = after.find((s) => s.k === "try") as Extract<Stmt, { k: "try" }>;
  // pc(0) and pc(2) are both inside the outer guarded block -> live.
  assert.equal(countStores(outer.block, "__pc"), 2);
  // pc(3) is in the outer handler, after the guard -> dead.
  assert.equal(countStores(outer.handler, "__pc"), 0);
});

test("try-clean: an __exc copy with no read anywhere goes, with the frame and the catch binding", { skip: SKIP }, async () => {
  const body: Stmt[] = [excFrame, tryStmt([set(id("r0"), num(1))], "_exc0", [excCopy("_exc0"), set(id("r0"), num(2))])];
  const after = await clean(body);
  assert.ok(after !== null);
  assert.ok(!text(after).includes('"__exc"'), "no __exc reference survives");
  const t = after.find((s) => s.k === "try") as Extract<Stmt, { k: "try" }>;
  assert.equal(t.param, null, "an unread catch binding becomes `catch { }`");
});

test("try-clean: an open __exc read outside the handler keeps every copy (fixture 16 v99 shape)", { skip: SKIP }, async () => {
  const body: Stmt[] = [excFrame, tryStmt([set(id("r0"), num(1))], "_exc0", [excCopy("_exc0")]), set(id("r12"), id("__exc"))];
  const after = await clean(body);
  if (after === null) return; // refusing the whole function is also correct here
  assert.equal(countStores(after, "__exc"), 1);
  assert.ok(text(after).includes('"__exc"'));
});

test("try-clean: a guarded handler keeps its catch binding (the guard rethrows it)", { skip: SKIP }, async () => {
  const body: Stmt[] = [excFrame, pcFrame, tryStmt([pc(0), set(id("r0"), num(1))], "_exc0", [guardOf(0, 0, "_exc0"), excCopy("_exc0"), set(id("r0"), num(2))])];
  const after = await clean(body);
  assert.ok(after !== null);
  const t = after.find((s) => s.k === "try") as Extract<Stmt, { k: "try" }>;
  assert.equal(t.param, "_exc0");
});

// ---------------------------------------------------------------------------
// Refusals (spec 22 section 4.2).
// ---------------------------------------------------------------------------

test("try-clean: a __pc read that is not a handler guard refuses the whole function", { skip: SKIP }, async () => {
  const body: Stmt[] = [pcFrame, pc(0), set(id("r0"), id("__pc")), pc(1)];
  assert.equal(await clean(body), null);
});

test("try-clean: a guarded try whose block has no entry store deletes no __pc store (C4)", { skip: SKIP }, async () => {
  const body: Stmt[] = [excFrame, pcFrame, pc(0), tryStmt([set(id("r0"), num(1)), pc(1)], "_exc0", [guardOf(1, 1, "_exc0"), excCopy("_exc0")])];
  const after = await clean(body);
  const stores = after === null ? countStores(body, "__pc") : countStores(after, "__pc");
  assert.equal(stores, 2, "without an entry-dominating store, no __pc store may be deleted");
});

test("try-clean: a handler whose prologue is not `__exc = param` refuses the function (C3)", { skip: SKIP }, async () => {
  const body: Stmt[] = [excFrame, pcFrame, pc(0), tryStmt([pc(1)], "_exc0", [set(id("r0"), id("_exc0")), excCopy("_exc0")])];
  assert.equal(await clean(body), null);
});

test("try-clean: a __pc store captured by a nested function refuses the whole function (C1)", { skip: SKIP }, async () => {
  const nested: Stmt = { k: "func", name: "_fn1", params: [], body: [set(id("r0"), id("__pc"))] };
  const body: Stmt[] = [pcFrame, pc(0), nested, pc(1)];
  assert.equal(await clean(body), null);
});

test("try-clean: a lone __pc store in a for-header slot stays; one of two goes", { skip: SKIP }, async () => {
  const sole: Stmt = { k: "for", label: null, init: null, test: id("r1"), update: { k: "assign", target: id("__pc"), value: num(11) }, body: [] };
  const pair: Stmt = { k: "for", label: null, init: null, test: id("r1"), update: { k: "seq", exprs: [{ k: "assign", target: id("__pc"), value: num(11) }, { k: "assign", target: id("r1"), value: num(2) }] }, body: [] };
  const a = await clean([pcFrame, sole]);
  assert.equal(a === null ? 1 : countStores(a, "__pc"), 1, "a sole for-slot store is kept");
  const b = await clean([pcFrame, pair]);
  assert.ok(b !== null);
  assert.equal(countStores(b, "__pc"), 0);
});

test("try-clean: idempotence — a cleaned body matches nothing on the second run (PL-08)", { skip: SKIP }, async () => {
  const { match } = await rung();
  const body: Stmt[] = [excFrame, pcFrame, pc(0), tryStmt([pc(1)], "_exc0", [excCopy("_exc0")]), pc(2)];
  const after = await clean(body);
  assert.ok(after !== null);
  assert.equal(match(after, { functionIndex: 0, fnBody: after } as Any), null);
});

// ---------------------------------------------------------------------------
// Checker (spec 22 section 6.2) — it must reject a forged rewrite.
// ---------------------------------------------------------------------------

test("try-clean check: rejects deleting a store the guard can read", { skip: SKIP }, async () => {
  const { match, check } = await rung();
  const before: Stmt[] = [excFrame, pcFrame, tryStmt([pc(1), set(id("r0"), num(1))], "_exc0", [guardOf(1, 1, "_exc0"), excCopy("_exc0")])];
  const ctx = { functionIndex: 0, fnBody: before } as Any;
  const m = match(before, ctx);
  assert.ok(m !== null);
  // Forge: drop the live in-block store as well.
  const forged: Stmt[] = [excFrame, pcFrame, tryStmt([set(id("r0"), num(1))], "_exc0", [guardOf(1, 1, "_exc0"), excCopy("_exc0")])];
  assert.equal((check(before, forged, ctx) as { ok: boolean }).ok, false);
});

test("try-clean check: rejects an edit that is not a pure deletion (undo by re-insertion)", { skip: SKIP }, async () => {
  const { match, check } = await rung();
  const before: Stmt[] = [pcFrame, pc(0), set(id("r0"), num(1))];
  const ctx = { functionIndex: 0, fnBody: before } as Any;
  const m = match(before, ctx);
  assert.ok(m !== null);
  const forged: Stmt[] = [set(id("r0"), num(2))]; // deletions plus one smuggled change
  assert.equal((check(before, forged, ctx) as { ok: boolean }).ok, false);
});

test("try-clean registers in stage B between object-literal and the naming rungs (D23)", { skip: SKIP }, async () => {
  const { tryClean } = await rung();
  assert.equal(tryClean.stage, "B");
  assert.ok((tryClean.after as string[]).includes("expr-rebuild"));
  for (const later of ["fn-naming", "reg-split", "var-naming"]) assert.ok((tryClean.before as string[]).includes(later), `try-clean must run before ${later}`);
  const { REGISTRY } = (await import(["..", "..", "..", "src", "passes", "registry.ts"].join("/"))) as Any;
  const names = (REGISTRY as { name: string }[]).map((p) => p.name);
  assert.ok(names.includes("try-clean"));
  assert.ok(names.indexOf("try-clean") > names.indexOf("object-literal"));
});

// ---------------------------------------------------------------------------
// Fixture-level, rung-owned properties (CONSOLIDATION section B item 7).
// ---------------------------------------------------------------------------

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const js = (fixture: string, version: string, skip: readonly string[] = []): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: skip.length > 0 ? { skip } : {} }).code;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;
const PC_STORE = /__pc = -?\d+/g;
const EXC_COPY = /__exc = _exc\d+;/g;
// Non-global twin: assert.match/doesNotMatch use RegExp.test, which advances
// lastIndex on a /g regex.
const PC_STORE1 = new RegExp(PC_STORE.source);

for (const version of ["v94", "v99"]) {
  test(`try-clean removes __pc stores and __exc copies across fixtures 12-16 at ${version}`, { skip: SKIP }, () => {
    for (const fixture of ["12-try-catch-finally-return", "13-try-finally-no-catch", "14-nested-try-catch", "15-catch-without-binding", "16-finally-with-break-continue"]) {
      const on = js(fixture, version);
      const off = js(fixture, version, ["try-clean"]);
      assert.ok(count(on, PC_STORE) < count(off, PC_STORE), `${fixture} ${version}: expected fewer __pc stores (${count(on, PC_STORE)} vs ${count(off, PC_STORE)})`);
      assert.ok(count(on, EXC_COPY) <= count(off, EXC_COPY));
      // Never deletes a `try`, a `catch` body or a `throw`.
      assert.equal(count(on, /\} catch/g), count(off, /\} catch/g), `${fixture} ${version}: catch clauses must survive`);
      assert.equal(count(on, /\bthrow /g), count(off, /\bthrow /g), `${fixture} ${version}: throws must survive`);
    }
  });

  test(`try-clean leaves no __pc or __exc in 15-catch-without-binding's tryParse at ${version}`, { skip: SKIP }, () => {
    const on = js("15-catch-without-binding", version);
    const fn = on.slice(on.indexOf("tryParse"), on.indexOf("unreliable"));
    assert.doesNotMatch(fn, PC_STORE1);
    assert.doesNotMatch(fn, /__exc/);
  });

  test(`try-clean keeps every store a surviving guard can read at ${version}`, { skip: SKIP }, () => {
    for (const fixture of ["12-try-catch-finally-return", "13-try-finally-no-catch", "14-nested-try-catch", "16-finally-with-break-continue"]) {
      const on = js(fixture, version);
      // Wherever a guard survives, the frame and at least one store survive
      // with it: a guard reading a `__pc` nothing writes would be a bug.
      if (/if \(!\(__pc >=/.test(on)) {
        assert.match(on, /let __pc = -1;/, `${fixture} ${version}: a surviving guard needs its frame`);
        assert.ok(count(on, PC_STORE) > 1, `${fixture} ${version}: a surviving guard needs its stores`);
      }
    }
  });
}

// Baseline facts (spec 22 section 2) — these run *now* and must keep passing
// after the rungs land, because `--passes=none` is byte-identical (PL-05).
for (const version of ["v94", "v99"]) {
  test(`baseline (passes=none) prints the __pc/__exc scaffolding at ${version}`, () => {
    const base = decompile(readFileSync(join(CONSTRUCTS, "15-catch-without-binding", `${version}.hbc`)), { resolveV98Ambiguity: true, passes: { none: true } }).code;
    assert.match(base, /let __pc = -1;/);
    assert.match(base, /if \(!\(__pc >= \d+ && __pc <= \d+\)\)/);
    assert.match(base, /__exc = _exc\d+;/);
    assert.ok(count(base, PC_STORE) >= 3, "the baseline stores __pc at every block head");
  });
}
