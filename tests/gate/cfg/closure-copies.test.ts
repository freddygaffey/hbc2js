// docs/reports/2026-09-05-ambiguous-closure-env.md §3 and §4 — per-creation-context
// bodies for `W_AMBIGUOUS_CLOSURE_ENV` (docs/BUGS.md 2026-09-04, cause (a)).
//
// A function created at two sites with two different environments has two
// lexical identities, not an unknowable one. It used to be forced to
// `closureEnvOf = null` and emitted ONCE, with `_e<env>_<slot>` names taken
// from whichever site the fixed point recorded first — correct at that site and
// silently wrong at every other one — while the `_fn<n>` reference at the other
// sites sat in a function that did not contain the body, so it was unbound.
// `EnvGraph.closureCopies` now carries one copy per distinct environment, each
// with the positional remap from copy 0's chain to its own.
//
// No `source.js` reproduces the shape (§4's test plan: identical inner bodies, a
// twice-called helper and a generator over a loop variable were all probed and
// none makes hermesc v96/v99 deduplicate a function index), so the buckets are
// synthesised directly on `buildEnvGraph`, the way
// tests/gate/cfg/env-no-capture.test.ts synthesises its two-site module.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EnvGraph } from "../../../src/cfg/types.ts";
import type { Op } from "../../support/synth-module.ts";
import { bucketA, bucketB, bucketC, graphOf, joinedChildFunctions, loadSlot, mkClosure, mkEnv, ret, selfEnv } from "../../support/synth-module.ts";

const ambiguous = (g: EnvGraph): number[] => g.diagnostics.filter((d) => d.code === "W_AMBIGUOUS_CLOSURE_ENV").map((d) => (d.context as { functionIndex?: number }).functionIndex!);

test("bucket A: two creating functions, aligned chains — one copy per environment, remapped at the leaf", () => {
  const g = bucketA();
  const copies = g.closureCopies.get(3);
  assert.ok(copies !== undefined, "fn#3 is created over env 1 and env 2; it must get one body per creation context");
  assert.equal(copies.length, 2);
  assert.deepEqual(
    copies.map((c) => c.env),
    [1, 2],
    "copy 0 must capture closureEnvOf(fn#3) — the chain every recorded EnvAccess was resolved against — and copy 1 the other site's environment",
  );
  assert.equal(g.closureEnvOf.get(3), copies[0]!.env, "copy 0's environment is the one the accesses already name");
  assert.deepEqual([...copies[0]!.envRemap], [], "copy 0 renames nothing");
  assert.deepEqual([...copies[1]!.envRemap], [[1, 2]], "aligned chains differ only at the leaf: `_e1_0` becomes `_e2_0` in copy 1");
  assert.equal(copies[0]!.sites.length, 1);
  assert.equal(copies[1]!.sites.length, 1);
  assert.notEqual(copies[0]!.sites[0], copies[1]!.sites[0], "each copy owns the Create*Closure site that captured its environment");
  assert.deepEqual(ambiguous(g), [], "a function with per-creation-context copies is no longer ambiguous");
});

test("bucket B: both sites inside one creating function still get one body each", () => {
  const g = bucketB();
  const copies = g.closureCopies.get(2);
  assert.ok(copies !== undefined, "fn#2 is created twice inside fn#1 over two different environments");
  assert.equal(copies.length, 2);
  assert.deepEqual([...copies[1]!.envRemap], [[copies[0]!.env, copies[1]!.env]]);
  assert.equal(new Set(copies.flatMap((c) => c.sites)).size, 2, "both sites are accounted for, so neither is left naming a body it cannot see");
  assert.deepEqual(ambiguous(g), []);
});

test("bucket C: chains of different length have no positional remap and stay W_AMBIGUOUS_CLOSURE_ENV", () => {
  const g = bucketC();
  assert.equal(g.closureCopies.get(2), undefined, "there is no node-for-node alignment between a 1-deep and a 2-deep chain");
  assert.deepEqual(ambiguous(g), [2], "the unaligned residual keeps today's behaviour rather than guessing a remap");
  assert.equal(g.closureEnvOf.get(2), null, "…including being an orphan for src/emit/placement.ts");
});

test("report §3's join: aligned sites nothing in the subtree can tell apart are joined, not duplicated", () => {
  // The hypothesis that failed as a *standalone* fix (4 of 178) is correct once
  // duplication exists: a joined function's lexical home is then always right.
  const g = bucketA(false);
  assert.equal(g.closureCopies.get(3), undefined, "fn#3 never names the environment the two sites disagree about; one body is enough");
  assert.deepEqual(ambiguous(g), [], "and it is not ambiguous either — nothing observable differs between the sites");
  assert.equal(g.closureEnvOf.get(3), 1, "it keeps a real lexical home instead of being forced to null");
});

test("a site with the *undefined* environment operand is still ambiguous: there is no chain to align", () => {
  const g = graphOf(
    new Map<number, readonly Op[]>([
      [0, [mkEnv(0), mkClosure(1, 0, 1), { name: "LoadConstUndefined", ops: [["reg", 2]] }, mkClosure(3, 2, 1), ret(1)]],
      [1, [selfEnv(0), loadSlot(1, 0, 0), ret(1)]],
    ]),
  );
  assert.equal(g.closureCopies.get(1), undefined);
  assert.deepEqual(ambiguous(g), [1]);
});

// docs/reports/2026-09-05-ambiguous-closure-env.md §6 — the join's subtree is
// creation-based, not `closureEnvOf`-based.
//
// `namesAgreeAcrossSites` (the test above) decides "nothing in `f`'s lexical
// subtree names an environment the sites disagree about" and then emits ONE
// body. It used to walk only the `closureEnvOf` relation, which is exactly the
// relation that leaves a child created inside `f` over an environment `f`
// merely CAPTURED outside `f`'s subtree — so that child's reads were never
// counted and the join fired over them. On react-navigation that produced one
// body whose child read `_e3141_0` at six sites that disagree about which
// environment position 0 is: an unbound `_fn<n>` at best, a silent
// wrong-binding at worst (report §5 "Landing item 5" measured the three).
test("the join does not fire when a creation-only child names an environment the sites disagree about", () => {
  const joined = graphOf(joinedChildFunctions("movable"));
  assert.equal(joined.closureCopies.get(3), undefined, "the child reads nothing, so one body still is enough");
  assert.deepEqual(ambiguous(joined), [], "…and fn#3 keeps a real lexical home");

  const g = graphOf(joinedChildFunctions("pinned"));
  const copies = g.closureCopies.get(3);
  assert.ok(copies !== undefined, "fn#4 is created only inside fn#3 and reads slot 0 of the environment fn#3 captured, which is env 1 at one site and env 2 at the other: the sites are NOT indistinguishable");
  assert.equal(copies.length, 2, "one body per creation context, so each context's child reads its own environment");
  assert.deepEqual([...copies[1]!.envRemap], [[1, 2]], "copy 1 rewrites the leaf of copy 0's chain, which is what the child's read resolves against");
  assert.deepEqual(ambiguous(g), [], "duplication, not ambiguity: the chains align");
});

test("the creation-based subtree runs to a fixed point: a grandchild's read defeats the join too", () => {
  // fn#4 is in fn#3's subtree only because its one creation site is fn#3;
  // fn#5 only because its one creation site is fn#4. A single pass that tested
  // membership against the `closureEnvOf` descendants would reach neither.
  const g = graphOf(joinedChildFunctions("grandchild"));
  const copies = g.closureCopies.get(3);
  assert.ok(copies !== undefined, "the grandchild reads the environment the two sites disagree about");
  assert.equal(copies.length, 2);
  assert.deepEqual(ambiguous(g), []);
});
