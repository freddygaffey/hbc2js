// docs/BUGS.md 2026-09-01 (Service NSW whole-file abort) + 2026-09-04
// (react-navigation `_e2326_0`) — EM-01's module-level scope check used to be
// all-or-nothing: the FIRST unbound identifier anywhere in a 15,000-function
// module threw `E_UNBOUND_IDENT` out of `emitModule`, so one bad nested
// function cost the whole file's output. `collectUnbound` reports every
// unbound identifier with the chain of emitted function *statements* it sits
// under, which is what lets `emitModule` isolate exactly those functions
// (`W_UNBOUND_ISOLATED`, a throwing stub body) and still emit the module.
// The throwing `checkBindings` is unchanged and still runs afterwards, so a
// non-per-function scope bug is still a hard failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hbc2jsError, ErrorCode } from "../../../src/errors.ts";
import { checkBindings, collectUnbound, unboundMessage } from "../../../src/emit/scope-check.ts";
import { id, lit, p } from "../../../src/emit/ast.ts";
import type { Stmt } from "../../../src/emit/ast.ts";
import { resolveOrphanHosts } from "../../../src/emit/placement.ts";
import type { OrphanPlacementInput } from "../../../src/emit/placement.ts";

/** `_fn0` (the global function) with one nested function that reads an env
 *  slot nobody declares, and one that is fine. */
function program(): Stmt[] {
  const bad: Stmt = { k: "func", name: "_fn7", params: [p("a1")], body: [{ k: "return", arg: id("_e99_0") }] };
  const good: Stmt = { k: "func", name: "_fn8", params: [], body: [{ k: "decl", kind: "let", names: ["r0"] }, { k: "return", arg: id("r0") }] };
  const outer: Stmt = { k: "func", name: "_fn3", params: [], body: [bad, good, { k: "return", arg: id("_fn7") }] };
  return [{ k: "iife", body: [{ k: "func", name: "_fn0", params: [], body: [outer, { k: "return", arg: id("_fn3") }] }, { k: "return", arg: id("_fn0") }] }];
}

test("collectUnbound reports the unbound name with its function-statement path", () => {
  const found = collectUnbound(program(), [], 0);
  assert.deepEqual(
    found.map((u) => ({ name: u.name, path: u.path.join(" > ") })),
    [{ name: "_e99_0", path: "module > _fn0 > _fn3 > _fn7" }],
  );
  assert.match(unboundMessage(found[0]!), /"_e99_0" is not declared in any enclosing scope \(module > _fn0 > _fn3 > _fn7\)/);
});

test("collectUnbound reports every offender, not just the first, and each once", () => {
  const two: Stmt[] = [
    { k: "func", name: "_fn1", params: [], body: [{ k: "expr", expr: id("_e1_0") }, { k: "expr", expr: id("_e1_0") }] },
    { k: "func", name: "_fn2", params: [], body: [{ k: "expr", expr: id("_e2_0") }] },
  ];
  const found = collectUnbound(two, [], 0);
  assert.deepEqual(found.map((u) => `${u.path.join(">")}|${u.name}`), ["module>_fn1|_e1_0", "module>_fn2|_e2_0"]);
});

test("a well-scoped program has no unbound identifiers and checkBindings accepts it", () => {
  const ok: Stmt[] = [{ k: "func", name: "_fn0", params: [], body: [{ k: "decl", kind: "let", names: ["_e1_0"] }, { k: "expr", expr: id("_e1_0") }] }];
  assert.deepEqual(collectUnbound(ok, [], 0), []);
  checkBindings(ok, [], 0);
});

test("checkBindings still throws E_UNBOUND_IDENT on the first offender", () => {
  assert.throws(
    () => {
      checkBindings(program(), [], 0);
    },
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_UNBOUND_IDENT && /_e99_0/.test(e.message),
  );
});

test("a stub body (comment + throw new Error) never trips the scope check", () => {
  const stubbed: Stmt[] = [
    {
      k: "func",
      name: "_fn7",
      params: [p("a1")],
      body: [
        { k: "comment", text: "_fn7 -- ISOLATED FAILURE (E_UNBOUND_IDENT)" },
        { k: "throw", arg: { k: "new", callee: id("Error"), args: [lit('"hbc2js: could not decompile _fn7 -- E_UNBOUND_IDENT"')] } },
      ],
    },
  ];
  assert.deepEqual(collectUnbound(stubbed, [], 0), []);
});

// ---------------------------------------------------------------------------
// Orphan PLACEMENT (docs/BUGS.md 2026-09-04, the `_fn13838`/`_e652_0` family).
// Isolation above keeps the module emitting; placement is what stops the names
// being unbound in the first place. `resolveOrphanHosts` is the pure rule:
// module level is always a candidate, so a host is only ever chosen when it
// leaves strictly fewer names unbound.
// ---------------------------------------------------------------------------

/** Lexical tree `0 -> 1 -> 2`, plus orphans (parent `null`) the cases add. */
function placementInput(over: Partial<OrphanPlacementInput> & { readonly parentOf: ReadonlyMap<number, number | null> }): OrphanPlacementInput {
  return {
    functionCount: over.functionCount ?? 8,
    globalIndex: 0,
    envsUsedIn: new Map(),
    declaringFunction: new Map(),
    creationSitesOf: new Map(),
    ...over,
  };
}

test("an orphan that reads an env slot declared inside a function is hosted there, not left at module level", () => {
  // fn#5 reads env 9, whose `_e9_*` names are declared in fn#2's body. Module
  // level is OUTSIDE the global function, so the read is unbound there.
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 0], [2, 1], [5, null]]),
      envsUsedIn: new Map([[5, new Set([9])]]),
      declaringFunction: new Map([[9, 2]]),
    }),
  );
  assert.deepEqual(placements.map((p) => ({ orphan: p.orphan, host: p.host })), [{ orphan: 5, host: 2 }]);
  assert.equal(placements[0]!.unboundAtModule, 1);
  assert.equal(placements[0]!.unboundAtHost, 0);
});

test("the orphan's whole subtree travels with it: a child's env reads pick the host", () => {
  // fn#5 itself reads nothing; its child fn#6 reads env 9 (declared in fn#2).
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 0], [2, 1], [5, null], [6, 5]]),
      envsUsedIn: new Map([[6, new Set([9])]]),
      declaringFunction: new Map([[9, 2]]),
    }),
  );
  assert.deepEqual(placements.map((p) => p.host), [2]);
});

test("an env declared inside the orphan's own subtree never drags it anywhere", () => {
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 0], [5, null], [6, 5]]),
      envsUsedIn: new Map([[5, new Set([9])], [6, new Set([9])]]),
      declaringFunction: new Map([[9, 5]]),
    }),
  );
  assert.deepEqual(placements, []);
});

test("the deepest function that declares every env read wins; a shallower one that misses some does not", () => {
  // env 9 is declared in fn#1, env 10 in fn#2 (nested inside fn#1). Only fn#2
  // (or deeper) sees both.
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 0], [2, 1], [3, 2], [5, null]]),
      envsUsedIn: new Map([[5, new Set([9, 10])]]),
      declaringFunction: new Map([[9, 1], [10, 2]]),
    }),
  );
  assert.deepEqual(placements.map((p) => ({ host: p.host, unboundAtHost: p.unboundAtHost })), [{ host: 2, unboundAtHost: 0 }]);
});

test("env declarations on two unrelated branches: the placement that binds the most wins, and it is never worse than module level", () => {
  // fn#5 reads env 9 (declared in fn#1) and env 10 (declared in fn#2), and
  // fn#1/fn#2 are siblings — no function sees both. Module level binds neither
  // (2 unbound); either sibling binds one, so a host is still an improvement.
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 0], [2, 0], [5, null]]),
      envsUsedIn: new Map([[5, new Set([9, 10])]]),
      declaringFunction: new Map([[9, 1], [10, 2]]),
    }),
  );
  assert.equal(placements.length, 1);
  assert.equal(placements[0]!.unboundAtModule, 2);
  assert.equal(placements[0]!.unboundAtHost, 1);
  assert.ok(placements[0]!.host === 1 || placements[0]!.host === 2);
});

test("a function created at two unrelated sites (W_AMBIGUOUS_CLOSURE_ENV) stays at module level when hosting would break more `_fn` references than it binds", () => {
  // fn#5 is created in fn#2 and in fn#3 (siblings) and reads one env declared
  // in fn#2. Hosting it in fn#2 binds that read but leaves the `_fn5`
  // reference in fn#3 unbound — a wash, so the placement must not move it.
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 0], [2, 1], [3, 1], [5, null]]),
      envsUsedIn: new Map([[5, new Set([9])]]),
      declaringFunction: new Map([[9, 2]]),
      creationSitesOf: new Map([[5, new Set([2, 3])]]),
    }),
  );
  assert.deepEqual(placements, []);
});

test("a `_fn` reference from a site nested inside the host still resolves, so that orphan does move", () => {
  // Both creation sites are inside fn#2 (fn#3 is nested in it), so hosting in
  // fn#2 keeps both references in scope and binds the env read.
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 0], [2, 1], [3, 2], [5, null]]),
      envsUsedIn: new Map([[5, new Set([9])]]),
      declaringFunction: new Map([[9, 2]]),
      creationSitesOf: new Map([[5, new Set([2, 3])]]),
    }),
  );
  assert.deepEqual(placements.map((p) => p.host), [2]);
});

test("an orphan that reads nothing is left alone (module level costs it nothing)", () => {
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 0], [5, null]]),
      creationSitesOf: new Map([[5, new Set([1])]]),
    }),
  );
  assert.deepEqual(placements, []);
});

test("the global function is a legitimate host: an env declared in it is not in scope at module level", () => {
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [5, null]]),
      envsUsedIn: new Map([[5, new Set([9])]]),
      declaringFunction: new Map([[9, 0]]),
    }),
  );
  assert.deepEqual(placements.map((p) => p.host), [0]);
});

test("a host is never chosen inside the orphan's own subtree (that would be a cycle)", () => {
  // The only declarer of env 9 is fn#6, which is the orphan's own child.
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 0], [5, null], [6, 5], [7, 6]]),
      envsUsedIn: new Map([[7, new Set([9])]]),
      declaringFunction: new Map([[9, 6]]),
    }),
  );
  assert.deepEqual(placements, []);
});

test("a cyclic parent chain in the input cannot hang the placement walk", () => {
  const placements = resolveOrphanHosts(
    placementInput({
      parentOf: new Map([[0, null], [1, 2], [2, 1], [5, null]]),
      envsUsedIn: new Map([[5, new Set([9])]]),
      declaringFunction: new Map([[9, 1]]),
    }),
  );
  assert.equal(placements.length, 1);
  assert.equal(placements[0]!.host, 1);
});
