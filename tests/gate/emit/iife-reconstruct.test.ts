// docs/specs/passes/27-iife-reconstruct.md -- structural properties of the
// emit-side step that puts an inlined IIFE back (docs/PUSHBACK.md P-41).
//
// Rung-owned properties only (CLAUDE.md testing rules): counts and guard
// outcomes, never a literal comparison against the whole decompiled output of
// a shared fixture. The round-trip property (recompiling reproduces the
// original environment sizes and slot immediates) is
// tests/gate/emit/sibling-env-slots.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import type { Stmt } from "../../../src/emit/ast.ts";
import { reconstructIifes } from "../../../src/emit/iife-reconstruct.ts";

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "75-sibling-envs");

function decompiled(version: number): string {
  const bytes = new Uint8Array(readFileSync(join(FIXTURE, `v${version}.hbc`)));
  try {
    return decompile(bytes).code;
  } catch {
    return decompile(bytes, { opcodeTable: "hbc98-late" }).code;
  }
}

/** IIFEs beyond the module's own single top-level wrapper. */
function innerIifes(code: string): number {
  return code.split("\n").filter((l) => /^\s+\(function \(\) \{$/.test(l)).length;
}

for (const version of [98, 99]) {
  test(`75-sibling-envs v${version}: each inlined IIFE is emitted back as one wrapper`, () => {
    if (!existsSync(join(FIXTURE, `v${version}.hbc`))) return;
    const code = decompiled(version);
    // The fixture inlines exactly three IIFEs (the sibling-env-slots test
    // pins that against the bytecode), so exactly three come back.
    assert.equal(innerIifes(code), 3, `v${version}: expected three reconstructed IIFEs`);
    // Every environment moved, so no flat multi-environment `let` prologue is
    // left behind: no single `let` lists slots of two different environments.
    for (const line of code.split("\n")) {
      const slots = [...line.matchAll(/_e(\d+)_\d+/g)].map((m) => m[1]);
      if (!/^\s*let /.test(line) || slots.length === 0) continue;
      assert.equal(new Set(slots).size, 1, `v${version}: a single declaration still spans two environments: ${line.trim()}`);
    }
  });
}

for (const version of [84, 94, 96]) {
  test(`75-sibling-envs v${version}: nothing is wrapped where hermesc does not inline`, () => {
    if (!existsSync(join(FIXTURE, `v${version}.hbc`))) return;
    // These compilers keep the callee as its own function, so there are no
    // sibling environments and the step must not fire at all.
    assert.equal(innerIifes(decompiled(version)), 0, `v${version}: unexpected reconstructed IIFE`);
  });
}

// --- guards (spec section 4), on synthetic statement lists ------------------

const label: Stmt = { k: "comment", text: "fn#0" };
const ident = (name: string) => ({ k: "ident", name }) as const;
const store = (slot: string, from: string): Stmt => ({ k: "expr", expr: { k: "assign", target: ident(slot), value: ident(from) } });
const reader = (name: string, slot: string): Stmt => ({ k: "func", name, params: [], body: [{ k: "return", arg: ident(slot) }] });

/** Two environments, one slot each, with one reader closure apiece. */
function twoEnvs(body: Stmt[], opts: { movable?: boolean } = {}) {
  return reconstructIifes({
    header: [label, { k: "decl", kind: "let", names: ["_e1_0", "_e2_0"] }, reader("_fn1", "_e1_0"), reader("_fn2", "_e2_0")],
    body,
    ownedEnvSlots: ["_e1_0", "_e2_0"],
    envParent: new Map([
      [1, 0],
      [2, 0],
    ]),
    movableChild: () => opts.movable !== false,
  });
}

const disjoint: Stmt[] = [store("_e1_0", "a"), { k: "expr", expr: ident("_fn1") }, store("_e2_0", "b"), { k: "expr", expr: ident("_fn2") }];

test("iife-reconstruct: two disjoint sibling environments both wrap", () => {
  const r = twoEnvs([...disjoint]);
  assert.deepEqual(r.wrapped, [1, 2]);
  assert.deepEqual(r.refusals, []);
  assert.equal(r.stmts.filter((s) => s.k === "iife").length, 2);
  // The moved reader declarations left the prologue, and the prologue's `let`
  // list went with them.
  assert.equal(r.stmts.filter((s) => s.k === "func").length, 0);
  assert.equal(r.stmts.filter((s) => s.k === "decl").length, 0);
});

test("iife-reconstruct: a hosted closure refuses (E_UNBOUND_IDENT guard)", () => {
  const r = twoEnvs([...disjoint], { movable: false });
  assert.deepEqual(r.wrapped, []);
  assert.deepEqual(
    r.refusals.map((x) => x.reason),
    ["hosted closure cannot move into the range", "hosted closure cannot move into the range"],
  );
});

test("iife-reconstruct: interleaved environments refuse as overlapping ranges", () => {
  // The interleaving must be one the section 7 regrouping cannot prove apart
  // (docs/PUSHBACK.md P-43): a property store may run a setter, so it never
  // moves past another environment's store. The provable case is covered by
  // "iife-group: an interleaved group of provably independent stores ...".
  const call: Stmt = { k: "expr", expr: { k: "call", callee: ident("f"), args: [] } };
  const r = twoEnvs([store("_e1_0", "a"), store("_e2_0", "b"), call, store("_e1_0", "c")]);
  assert.deepEqual(r.wrapped, []);
  assert.deepEqual(new Set(r.refusals.map((x) => x.reason)), new Set(["overlapping statement ranges"]));
});

test("iife-reconstruct: return, this and arguments inside a range refuse it", () => {
  for (const [bad, reason] of [
    [{ k: "return", arg: null } as Stmt, "return"],
    [{ k: "expr", expr: { k: "assign", target: ident("x"), value: { k: "this" } } } as Stmt, "this"],
    [{ k: "expr", expr: { k: "assign", target: ident("x"), value: { k: "argumentsObject" } } } as Stmt, "arguments"],
  ] as const) {
    const r = twoEnvs([store("_e1_0", "a"), bad, { k: "expr", expr: ident("_fn1") }, store("_e2_0", "b"), { k: "expr", expr: ident("_fn2") }]);
    assert.deepEqual(r.wrapped, [2], `${reason}: env 2 should still wrap`);
    assert.deepEqual(
      r.refusals.map((x) => x.reason),
      [reason],
    );
  }
});

test("iife-reconstruct: a range that touches a sibling environment refuses", () => {
  // env 0 is the function's own scope (the parent of 1 and 2), so it is
  // refused first; env 1's range then still reads one of its slots, which the
  // wrapper would put one scope level further away.
  const r = reconstructIifes({
    header: [label, { k: "decl", kind: "let", names: ["_e0_0", "_e1_0", "_e2_0"] }, reader("_fn1", "_e1_0"), reader("_fn2", "_e2_0")],
    body: [store("_e1_0", "_e0_0"), { k: "expr", expr: ident("_fn1") }, store("_e2_0", "b"), { k: "expr", expr: ident("_fn2") }],
    ownedEnvSlots: ["_e0_0", "_e1_0", "_e2_0"],
    envParent: new Map<number, number | null>([
      [0, null],
      [1, 0],
      [2, 0],
    ]),
    movableChild: () => true,
  });
  assert.deepEqual(r.wrapped, [2]);
  assert.ok(r.refusals.some((x) => x.env === 0 && x.reason === "parent of a sibling environment"));
  assert.ok(r.refusals.some((x) => x.env === 1 && x.reason === "environment read outside the range"));
});

test("iife-reconstruct: a let read after the range is hoisted in front of the IIFE", () => {
  const r = twoEnvs([store("_e1_0", "a"), { k: "init", kind: "let", name: "t", value: ident("a") }, { k: "expr", expr: ident("_fn1") }, store("_e2_0", "t"), { k: "expr", expr: ident("_fn2") }]);
  assert.deepEqual(r.wrapped, [1, 2]);
  const declAt = r.stmts.findIndex((s) => s.k === "decl" && s.names.includes("t"));
  const iifeAt = r.stmts.findIndex((s) => s.k === "iife");
  assert.ok(declAt >= 0 && declAt < iifeAt, "`let t` must be declared in front of the IIFE that assigns it");
  // and the initialiser stayed inside as a plain assignment
  const iife = r.stmts.find((s) => s.k === "iife");
  assert.ok(iife !== undefined && iife.k === "iife" && iife.body.some((s) => s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === "t"));
});

test("iife-reconstruct: a single owned environment is never wrapped", () => {
  const r = reconstructIifes({
    header: [label, { k: "decl", kind: "let", names: ["_e1_0"] }, reader("_fn1", "_e1_0")],
    body: [store("_e1_0", "a"), { k: "expr", expr: ident("_fn1") }],
    ownedEnvSlots: ["_e1_0"],
    envParent: new Map([[1, 0]]),
    movableChild: () => true,
  });
  assert.deepEqual(r.wrapped, []);
  assert.deepEqual(r.refusals, []);
  assert.equal(r.stmts.filter((s) => s.k === "iife").length, 0);
});

// --- section 7: grouping interleaved sibling environments -------------------
// `src/emit/iife-group.ts`. A group whose reordering is proved is wrapped; a
// group with one unprovable swap keeps its order and refuses exactly as before
// (`overlapping statement ranges`), with the blocking reason in `detail`.

/** `x = <ident>` -- the shape the regrouping is allowed to move. */
const set = (target: string, from: string): Stmt => store(target, from);

test("iife-group: an interleaved group of provably independent stores is regrouped and wrapped", () => {
  const r = twoEnvs([set("_e1_0", "a"), set("_e2_0", "b"), set("x", "_fn1"), set("y", "_fn2")]);
  assert.deepEqual(r.wrapped, [1, 2], `expected both environments wrapped, refusals: ${JSON.stringify(r.refusals)}`);
  assert.deepEqual(r.refusals, []);
  assert.equal(r.stmts.filter((s) => s.k === "iife").length, 2);
  // Each wrapper holds its own environment's statements and no other's.
  for (const s of r.stmts) {
    if (s.k !== "iife") continue;
    const envs = new Set([...JSON.stringify(s.body).matchAll(/_e(\d+)_\d+/g)].map((m) => m[1]));
    assert.equal(envs.size, 1, `a wrapper spans two environments: ${[...envs].join(",")}`);
  }
});

test("iife-group: one unprovable swap leaves the whole group flat", () => {
  // `arr[0] = _fn1` is a property store: it may run a setter, so it may not be
  // moved past environment 2's store. This is fixture 79's shape.
  const propStore: Stmt = { k: "expr", expr: { k: "assign", target: { k: "member", obj: ident("arr"), prop: { k: "lit", text: "0" }, computed: true }, value: ident("_fn1") } };
  const r = twoEnvs([set("_e1_0", "a"), set("_e2_0", "b"), propStore, set("y", "_fn2")]);
  assert.deepEqual(r.wrapped, []);
  assert.deepEqual(
    r.refusals.map((x) => x.reason),
    ["overlapping statement ranges", "overlapping statement ranges"],
  );
  assert.ok(
    r.refusals.every((x) => (x.detail ?? "").startsWith("swap ")),
    `expected a blocking-swap detail, got ${JSON.stringify(r.refusals)}`,
  );
  assert.equal(r.stmts.filter((s) => s.k === "iife").length, 0);
});

test("iife-group: a statement naming two environments is never regrouped", () => {
  // The largest class on react-navigation-example-0.85.3 (622 of the 757
  // `overlapping statement ranges` environments): one statement names slots of
  // two of them, so no reordering can put each in a wrapper of its own.
  const r = twoEnvs([set("_e1_0", "a"), set("_e2_0", "_e1_0"), set("x", "_fn1"), set("y", "_fn2")]);
  assert.deepEqual(r.wrapped, []);
  assert.ok(
    r.refusals.every((x) => x.reason === "overlapping statement ranges" && x.detail === "statement in two environments"),
    `unexpected refusals: ${JSON.stringify(r.refusals)}`,
  );
});

// --- fixture 79: the interleaved shape, refused ----------------------------

const FIXTURE79 = join(repoRoot(), "tests", "fixtures", "constructs", "79-interleaved-envs");

function decompiled79(version: number): string {
  const bytes = new Uint8Array(readFileSync(join(FIXTURE79, `v${version}.hbc`)));
  try {
    return decompile(bytes).code;
  } catch {
    return decompile(bytes, { opcodeTable: "hbc98-late" }).code;
  }
}

for (const version of [98, 99]) {
  test(`79-interleaved-envs v${version}: the interleaved group stays flat`, () => {
    if (!existsSync(join(FIXTURE79, `v${version}.hbc`))) return;
    const code = decompiled79(version);
    // Sibling environments are there (the fixture's point) ...
    const flat = code.split("\n").filter((line) => {
      if (!/^\s*let /.test(line)) return false;
      return new Set([...line.matchAll(/_e(\d+)_\d+/g)].map((m) => m[1])).size > 1;
    });
    assert.ok(flat.length > 0, `v${version}: expected a flat prologue spanning two environments`);
    // ... and none of them is wrapped: every swap the regrouping would need
    // moves a property store past an environment store.
    assert.equal(innerIifes(code), 0, `v${version}: an interleaved group was wrapped`);
  });
}
