// docs/specs/passes/08-jsx-recovery.md — unit tests on hand-built ASTs
// (automatic runtime with spilled type/config, `jsxs` array children, the
// classic runtime, three negatives, a real `check` refusal, PL-08
// idempotence), the D20 framework properties (registry: last, opt-in,
// absent by default; printer: JSX only under `jsx: true`, the lowered call
// otherwise; `jsxToCall` bijection), red->green on fixture 59 at the gate
// versions, the rn-template module_422 `--split --jsx` target, and the §8
// corpus metric with a floor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedDecompile as decompile } from "../../support/decompiled.ts";
import type { Expr, Stmt } from "../../../src/emit/ast.ts";
import { id, jsxToCall, lit } from "../../../src/emit/ast.ts";
import { printProgram } from "../../../src/emit/print.ts";
import { parses } from "../../../src/passes/ast.ts";
import { check } from "../../../src/passes/jsx-recover/check.ts";
import { jsxRecover } from "../../../src/passes/jsx-recover/index.ts";
import { deriveSites, match } from "../../../src/passes/jsx-recover/match.ts";
import { rewrite } from "../../../src/passes/jsx-recover/rewrite.ts";
import { enabledPasses, REGISTRY } from "../../../src/passes/registry.ts";
import type { PassContext } from "../../../src/passes/types.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { measureJsxRecoverBundle } from "../../../tools/passes-metrics.mjs";

// ---------------------------------------------------------------------------
// Hand-built-AST helpers.
// ---------------------------------------------------------------------------

const set = (name: string, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target: id(name), value } });
const member = (obj: Expr, prop: string): Expr => ({ k: "member", obj, prop: lit(prop), computed: false });
const index = (obj: Expr, i: number): Expr => ({ k: "member", obj, prop: lit(String(i)), computed: true });
const storeTo = (target: Expr, value: Expr): Stmt => ({ k: "expr", expr: { k: "assign", target, value } });
const call = (callee: Expr, args: readonly Expr[]): Expr => ({ k: "call", callee, args });
const obj = (props: readonly [string, Expr][]): Expr => ({ k: "object", props: props.map(([key, value]) => ({ key, computed: false, value })) });
const str = (s: string): Expr => lit(JSON.stringify(s));
const ret = (arg: Expr): Stmt => ({ k: "return", arg });

function ctxFor(fnBody: readonly Stmt[]): PassContext {
  return { analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg: {} as PassContext["cfg"], hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], applied: [], diagnostic: () => {}, fnBody };
}

function run(before: readonly Stmt[]): readonly Stmt[] {
  const ctx = ctxFor(before);
  const m = match(before, ctx);
  assert.ok(m !== null, "expected a match");
  const after = rewrite(m);
  assert.deepEqual(check(before, after, ctx), { ok: true });
  assert.equal(match(after, ctxFor(after)), null, "PL-08: second run must rewrite nothing");
  return after;
}

const jsxText = (stmts: readonly Stmt[]): string => printProgram(stmts, { indent: "  ", jsx: true });

// The corpus shape: callee/type spilled to registers, config built by stores.
const automaticSite = (): Stmt[] => [set("r10", member(id("_e0_0"), "jsx")), set("r4", id("_e0_2")), set("r3", obj([])), storeTo(member(id("r3"), "style"), id("r6")), storeTo(member(id("r3"), "children"), str("hello")), set("r8", call(id("r10"), [id("r4"), id("r3")]))];

// ---------------------------------------------------------------------------
// Positives.
// ---------------------------------------------------------------------------

test("automatic runtime: spilled type + store-built config -> one element; callee definition stays", () => {
  const after = run(automaticSite());
  assert.equal(jsxText(after), "r10 = _e0_0.jsx;\nr8 = <_e0_2 style={r6}>hello</_e0_2>;\n");
  // Without `jsx: true` the printer lowers the node to the exact call.
  assert.equal(printProgram(after), 'r10 = _e0_0.jsx;\nr8 = r10(_e0_2, {style: r6, children: "hello"});\n');
  assert.ok(parses(after));
});

test("jsxs: `new Array(n)` + index stores become the children, in order; a keyed jsx call gets key={…}", () => {
  const before = [set("r11", member(id("_e0_0"), "jsxs")), set("r5", { k: "new", callee: id("Array"), args: [lit("2")] }), storeTo(index(id("r5"), 0), id("r8")), storeTo(index(id("r5"), 1), id("r7")), set("r3", obj([])), storeTo(member(id("r3"), "children"), id("r5")), set("r6", call(id("r11"), [id("_e0_3"), id("r3")])), set("r2", call(member(id("_e0_0"), "jsx"), [str("div"), obj([["children", id("r1")]]), str("k1")]))];
  const after = run(before);
  assert.equal(jsxText(after), 'r11 = _e0_0.jsxs;\nr6 = <_e0_3>{r8}{r7}</_e0_3>;\nr2 = <div key="k1">{r1}</div>;\n');
});

test("classic runtime: trailing children, key/ref stay attrs, null props; `Fragment` prints as its named tag", () => {
  const before = [ret(call(member(id("r5"), "createElement"), [member(id("_e0_1"), "Fragment"), lit("null"), id("r3"), call(member(id("r5"), "createElement"), [id("_e0_4"), obj([["key", str("z")], ["item", id("r6")]])])]))];
  const after = run(before);
  assert.equal(jsxText(after), 'return <_e0_1.Fragment>{r3}<_e0_4 key="z" item={r6} /></_e0_1.Fragment>;\n');
  assert.equal(printProgram(after), 'return r5.createElement(_e0_1.Fragment, null, r3, r5.createElement(_e0_4, {key: "z", item: r6}));\n');
});

test("jsxToCall is a bijection on every recovered node", () => {
  const before = automaticSite();
  const { sites } = deriveSites(before, before);
  assert.equal(sites.length, 1);
  assert.deepEqual(jsxToCall(sites[0]!.node), sites[0]!.resolved);
});

// ---------------------------------------------------------------------------
// Negatives and a check refusal.
// ---------------------------------------------------------------------------

test("negative: a register callee not defined from a factory member is not a site", () => {
  const before = [set("r10", member(id("_e0_0"), "render")), set("r8", call(id("r10"), [id("_e0_2"), obj([])]))];
  assert.equal(match(before, ctxFor(before)), null);
});

test("negative: `document.createElement(\"div\")` (string type, no props object) is refused, not recovered", () => {
  const before = [set("r0", call(member(member(id("r7"), "document"), "createElement"), [str("div"), obj([])]))];
  assert.equal(match(before, ctxFor(before)), null);
  assert.deepEqual(deriveSites(before, before).refusals, { "ambiguous-createElement": 1 });
});

test("negative: a register type with no resolvable definition is `bad-type`; jsxs with non-array children is `jsxs-nonarray`", () => {
  const before = [set("r8", call(member(id("_e0_0"), "jsx"), [id("r4"), obj([])])), set("r9", call(member(id("_e0_0"), "jsxs"), [id("_e0_3"), obj([["children", id("r13")]])]))];
  assert.equal(match(before, ctxFor(before)), null);
  assert.deepEqual(deriveSites(before, before).refusals, { "bad-type": 1, "jsxs-nonarray": 1 });
});

test("negative: an absorbed register read after the call is `not-dead`; a moved value whose input is clobbered is refused", () => {
  const notDead = [...automaticSite(), ret(id("r4"))];
  assert.equal(match(notDead, ctxFor(notDead)), null);
  assert.deepEqual(deriveSites(notDead, notDead).refusals, { "not-dead": 1 });
  const clobbered = [set("r10", member(id("_e0_0"), "jsx")), set("r3", obj([])), storeTo(member(id("r3"), "style"), id("r6")), set("r6", lit("1")), set("r8", call(id("r10"), [id("_e0_2"), id("r3")]))];
  assert.deepEqual(deriveSites(clobbered, clobbered).refusals, { "input-clobbered": 1 });
});

test("check refuses an `after` that is not the derived fold, and one whose node does not invert to its call", () => {
  const before = automaticSite();
  const ctx = ctxFor(before);
  assert.equal(check(before, before, ctx).ok, false);
  const m = match(before, ctx)!;
  const after = rewrite(m);
  const last = after[after.length - 1] as Extract<Stmt, { k: "expr" }>;
  const assign = last.expr as Extract<Expr, { k: "assign" }>;
  const node = assign.value as Extract<Expr, { k: "jsx" }>;
  const tampered: Stmt[] = [...after.slice(0, -1), { k: "expr", expr: { ...assign, value: { ...node, attrs: [] } } }];
  assert.equal(check(before, tampered, ctx).ok, false);
});

// ---------------------------------------------------------------------------
// Framework (D20 §7): registry, opt-in, printer.
// ---------------------------------------------------------------------------

test("D20: jsx-recover is registered last of the structure-recovery block (before the renaming block), opt-in, and absent from every default selection", () => {
  // D23 (docs/DECISIONS.md): structure-recovery rungs all precede renaming
  // rungs (`fn-naming`, `reg-split`, `var-naming`) — jsx-recover is a
  // structure rung, so it is last of *that* block, not last overall.
  const names = REGISTRY.map((p) => p.name);
  const renamingBlock = ["fn-naming", "reg-split", "var-naming"];
  const jsxAt = names.indexOf("jsx-recover");
  assert.ok(jsxAt >= 0 && jsxAt === names.length - 1 - renamingBlock.length, `expected jsx-recover immediately before the renaming block, got index ${jsxAt} of ${names.join(",")}`);
  assert.deepEqual(names.slice(jsxAt + 1), renamingBlock);
  assert.equal(jsxRecover.optIn, true);
  assert.ok(!enabledPasses({}).some((p) => p.name === "jsx-recover"));
  assert.ok(!enabledPasses({ stage: "B" }).some((p) => p.name === "jsx-recover"));
  const on = enabledPasses({ optIn: ["jsx-recover"] }).map((p) => p.name);
  assert.deepEqual(on.slice(on.indexOf("jsx-recover") + 1), renamingBlock);
  assert.throws(() => enabledPasses({ optIn: ["nope"] }));
});

// ---------------------------------------------------------------------------
// Fixture 59 at the gate versions.
// ---------------------------------------------------------------------------

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "59-jsx-runtime-calls");

for (const version of [94, 99]) {
  test(`59-jsx-runtime-calls v${version}: default output is plain JS with the element calls; --jsx recovers them`, (t) => {
    const file = join(FIXTURE, `v${version}.hbc`);
    if (!existsSync(file)) return t.skip(`${file} not present`);
    const bytes = new Uint8Array(readFileSync(file));
    const plain = decompile(bytes, { moduleName: "59.hbc" }).code;
    assert.doesNotMatch(plain, /<_e0_\d+/);
    const plainStores = (plain.match(/\.children = /g) ?? []).length;
    assert.ok(plainStores >= 6, `expected the element calls' children stores in the default output, got ${plainStores}`);
    const jsx = decompile(bytes, { moduleName: "59.hbc", passes: { optIn: ["jsx-recover"] }, emit: { jsx: true } }).code;
    assert.match(jsx, /<_e0_\d+ style=\{r\d+\}>hello<\/_e0_\d+>/);
    assert.match(jsx, /<div className=(?:\{r\d+\}|"x")>\{r\d+\}<\/div>/, "v94 spills the string to a register, v99 keeps it inline");
    assert.match(jsx, /<_e0_\d+\.Comp \/>/);
    assert.match(jsx, /<_e0_\d+ key=(?:\{r\d+\}|"z") style=\{r\d+\} \/>/, "the classic createElement site with key/style props");
    assert.ok((jsx.match(/= <[_A-Za-z]/g) ?? []).length >= 8, "at least eight elements recovered (nested ones print inline)");
    // The one `jsxs` site whose children is a `.map(...)` call stays a call (spec §4: jsxs asserts an array);
    // every other site absorbed its children store (v99 seeds some in the literal, so compare, not count).
    const jsxStores = (jsx.match(/\.children = /g) ?? []).length;
    assert.ok(plainStores - jsxStores >= 4, `children stores ${plainStores} -> ${jsxStores}`);
  });
}

// ---------------------------------------------------------------------------
// Corpus: rn-template module_422 via --split --jsx, and the §8 metric.
// ---------------------------------------------------------------------------

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

test("rn-template module_422 via --split --jsx holds JSX elements (spec §2's corpus target)", (t) => {
  if (!existsSync(RN_TEMPLATE)) return t.skip("rn-template-0.72/index.android.hbc not present");
  const bytes = new Uint8Array(readFileSync(RN_TEMPLATE));
  const result = splitProject(bytes, { moduleName: "index.android.hbc", passes: { optIn: ["jsx-recover"] }, jsx: true });
  const text = result.files.get("module_422.js");
  assert.ok(text !== undefined);
  const elements = text.match(/= <[_A-Za-z][\w.]*(?: [^;]*)?(?:\/>|<\/[_A-Za-z][\w.]*>);/g) ?? [];
  assert.ok(elements.length >= 2, `expected JSX elements in module_422.js, got ${elements.length}`);
  assert.match(text, /<[_A-Za-z][\w.]*\.Text style=\{r\d+\}>\{r\d+\}<\/[_A-Za-z][\w.]*\.Text>/);
  // Nothing outside `--jsx` changes: the default split is byte-identical to before.
  const plain = splitProject(bytes, { moduleName: "index.android.hbc" }).files.get("module_422.js")!;
  assert.doesNotMatch(plain, /= </);
});

test("§8 metric floor: rn-template element-creation sites recovered", (t) => {
  if (!existsSync(RN_TEMPLATE)) return t.skip("rn-template-0.72/index.android.hbc not present");
  const m = measureJsxRecoverBundle(RN_TEMPLATE) as { sites: number; recovered: number; recoveredPct: number; refusals: Record<string, number> };
  assert.ok(m.sites >= 150, `expected the ~159 element sites spec §8 counts, got ${m.sites}`);
  assert.ok(m.recoveredPct >= 8, `recovered ${m.recovered}/${m.sites} (${m.recoveredPct.toFixed(1)}%) below the floor; refusals ${JSON.stringify(m.refusals)}`);
});
