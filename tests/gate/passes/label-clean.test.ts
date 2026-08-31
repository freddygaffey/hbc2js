// docs/specs/passes/06-label-clean.md — unit tests on hand-built trees (§7's
// checklist: >=1 positive per rule L1-L4, negatives for a non-tail break, a
// continue crossing an inner loop, a label used by both a break and a
// continue from different depths, and >=1 site the `check` refuses), plus
// red->green on the 08/11/02 fixture corpus at all five HBC versions.
//
// Also covers the 2026-08-31 hang regression (BUGS.md): decompiling
// 37-destructuring-array (all versions) and 48-optional-chaining-nullish
// (v84/v94) with the full pass pipeline enabled used to never return. The
// pass itself was innocent (see "37/48 hang regression" below) — the actual
// bug was an unmemoized exponential recursion in expr-rebuild's dead-store
// search (`src/passes/expr-rebuild/match.ts`'s `scanFrom`), only ever
// reached with a statement list this large because label-clean's unwrapping
// of *other*, unrelated labels merges previously-separate statement lists
// into the one the pathological cascade sits in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { decompile } from "../../../src/decompile.ts";
import { hbc2jsDecompiler, runTier } from "../../../src/harness/tiers.ts";
import { VERDICT } from "../../../src/harness/ladder.ts";
import type { Stmt } from "../../../src/structure/ir.ts";
import { check } from "../../../src/passes/label-clean/check.ts";
import { labelClean } from "../../../src/passes/label-clean/index.ts";
import { match } from "../../../src/passes/label-clean/match.ts";
import { rewrite } from "../../../src/passes/label-clean/rewrite.ts";
import type { PassContext } from "../../../src/passes/types.ts";

// ---------------------------------------------------------------------------
// Hand-built-tree helpers. label-clean is pure IR hygiene: it never reads a
// CFG block's instructions, so `ctx.structured` is left `undefined` (as it
// always is when the driver isn't in play) except where a test needs it.
// ---------------------------------------------------------------------------

const block = (cfgBlock: number): Stmt => ({ k: "block", cfgBlock });
const brk = (label: number): Stmt => ({ k: "break", label });
const cont = (label: number): Stmt => ({ k: "continue", label });
const seq = (body: readonly Stmt[]): Stmt => ({ k: "seq", body });
const iff = (cfgBlock: number, then: Stmt, els: Stmt): Stmt => ({ k: "if", cfgBlock, then, else: els });
const labeled = (label: number, body: Stmt): Stmt => ({ k: "labeled", label, body });
const loop = (label: number, body: Stmt): Stmt => ({ k: "loop", label, body });

const ctx: PassContext = { analysis: null as unknown as PassContext["analysis"], functionIndex: 0, cfg: null as unknown as PassContext["cfg"], hbcVersion: 94, layoutClass: "hbc94" as PassContext["layoutClass"], applied: [], diagnostic: () => {} };

// ---------------------------------------------------------------------------
// L1 — unused `labeled`.
// ---------------------------------------------------------------------------

test("L1 positive: a labeled block nothing breaks or continues to unwraps to its body", () => {
  const body = seq([block(0), block(1)]);
  const node = labeled(0, body);
  const m = match(node, ctx);
  assert.ok(m !== null && m.data.rule === "L1");
  const after = rewrite(m!);
  assert.equal(after, body, "L1 returns the body by reference");
  assert.deepEqual(check(node, after, ctx), { ok: true });
});

// ---------------------------------------------------------------------------
// L2 — tail-break `labeled`.
// ---------------------------------------------------------------------------

test("L2 positive: a labeled block whose only break is in tail position unwraps, deleting the break", () => {
  // L0: { block b0; if b0 { break L0 } else { block b1 } }
  const node = labeled(0, seq([block(0), iff(0, brk(0), block(1))]));
  const m = match(node, ctx);
  assert.ok(m !== null && m.data.rule === "L2");
  const after = rewrite(m!);
  assert.deepEqual(after, seq([block(0), iff(0, seq([]), block(1))]));
  assert.deepEqual(check(node, after, ctx), { ok: true });
});

test("L2 positive: two tail breaks, nested through if/else, both deleted", () => {
  // L0: { block b0; if b0 { break L0 } else { block b1; if b1 { block b2 } else { break L0 } } }
  const inner = iff(1, block(2), brk(0));
  const node = labeled(0, seq([block(0), iff(0, brk(0), seq([block(1), inner]))]));
  const m = match(node, ctx);
  assert.ok(m !== null && m.data.rule === "L2");
  const after = rewrite(m!);
  const expected = seq([block(0), iff(0, seq([]), seq([block(1), iff(1, block(2), seq([]))]))]);
  assert.deepEqual(after, expected);
  assert.deepEqual(check(node, after, ctx), { ok: true });
});

test("negative (break-not-in-tail): a labeled block with a non-tail break refuses", () => {
  // L0: { block b0; if b0 { break L0 } else {}; block b1 } -- the break is
  // *not* in tail position: `block b1` follows it.
  const node = labeled(0, seq([block(0), iff(0, brk(0), seq([])), block(1)]));
  assert.equal(match(node, ctx), null);
});

test("negative: a continue to the labeled block's own label refuses (structurer should never emit this, but label-clean must not assume L1/L2)", () => {
  const node = labeled(0, seq([block(0), cont(0)]));
  assert.equal(match(node, ctx), null);
});

// ---------------------------------------------------------------------------
// L3 — hideable loop label.
// ---------------------------------------------------------------------------

test("L3 positive: a continue to the loop's own label, with nothing nested between, hides the label", () => {
  // loop L0 { block b0; if b0 { continue L0 } else { break L0 } }
  const node = loop(0, seq([block(0), iff(0, cont(0), brk(0))]));
  const m = match(node, ctx);
  assert.ok(m !== null && m.data.rule === "L3");
  const after = rewrite(m!);
  assert.deepEqual(after, { ...node, hideLabel: true });
  assert.deepEqual(check(node, after, ctx), { ok: true });
});

test("L3 positive: zero uses of the loop's label also hides it", () => {
  const node = loop(0, block(0));
  const m = match(node, ctx);
  assert.ok(m !== null && m.data.rule === "L3");
});

test("negative (label-still-needed): a continue that crosses an inner loop to reach the outer one refuses", () => {
  // loop L0 { loop L1 { if b0 { continue L0 } else { block b1 } } }
  const inner = loop(1, iff(0, cont(0), block(1)));
  const node = loop(0, inner);
  assert.equal(match(node, ctx), null);
  // In isolation (nothing above it), L1's own label is targeted by nothing
  // (the `continue L0` inside it is not a use of *L1*), so L1 itself still
  // hides — the refusal above is specific to L0, whose continue is not
  // innermost once L1 sits between it and L0.
  const innerMatch = match(inner, ctx);
  assert.ok(innerMatch !== null && innerMatch.data.rule === "L3");
});

test("negative (label-still-needed): one label used by both a break and a continue from different depths refuses", () => {
  // loop L0 { block b0; if b0 { break L0 } else { loop L1 { if b1 { continue L0 } else { block b2 } } } }
  const nested = loop(1, iff(1, cont(0), block(2)));
  const node = loop(0, seq([block(0), iff(0, brk(0), nested)]));
  assert.equal(match(node, ctx), null, "the break at depth 1 is fine, but the continue from inside L1 is not innermost for L0");
});

test("negative (continue-to-labeled-block): a continue whose label resolves to a labeled block, not a loop, refuses", () => {
  // loop L0 { L1: { if b0 { continue L1 } else { block b1 } } }
  const inner = labeled(1, iff(0, cont(1), block(1)));
  const node = loop(0, inner);
  assert.equal(match(node, ctx), null);
});

test("PL-08: a loop already marked hideLabel is invisible to a second run", () => {
  const base = loop(0, block(0)) as Stmt & { k: "loop" };
  const node: Stmt = { ...base, hideLabel: true };
  assert.equal(match(node, ctx), null);
});

// ---------------------------------------------------------------------------
// L4 — `seq` of one.
// ---------------------------------------------------------------------------

test("L4 positive: a one-element seq unwraps to its sole statement", () => {
  const node = seq([block(0)]) as Stmt & { k: "seq" };
  const m = match(node, ctx);
  assert.ok(m !== null && m.data.rule === "L4");
  const after = rewrite(m!);
  assert.equal(after, node.body[0]);
  assert.deepEqual(check(node, after, ctx), { ok: true });
});

test("negative: a two-element seq does not match L4", () => {
  assert.equal(match(seq([block(0), block(1)]), ctx), null);
});

// ---------------------------------------------------------------------------
// check() refusals — a hand-built `after` that does not match what the
// rewrite would have produced, independent of match/rewrite.
// ---------------------------------------------------------------------------

test("check refuses: L2's rewrite is expected to delete the tail break, a bad `after` that keeps it fails", () => {
  const before = labeled(0, seq([block(0), iff(0, brk(0), block(1))]));
  const badAfter = seq([block(0), iff(0, brk(0), block(1))]); // break left in place
  const r = check(before, badAfter, ctx);
  assert.equal(r.ok, false);
});

test("check refuses: an L3 rewrite that does not set hideLabel", () => {
  const before = loop(0, seq([block(0), iff(0, cont(0), brk(0))]));
  const badAfter = before; // hideLabel never set
  const r = check(before, badAfter, ctx);
  assert.equal(r.ok, false);
});

test("check refuses: an L4 unwrap to the wrong node", () => {
  const before = seq([block(0)]);
  const r = check(before, block(1), ctx);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Registration sanity: the exported Pass object wires the same functions.
// ---------------------------------------------------------------------------

test("the registered Pass object is match/rewrite/check as tested above", () => {
  assert.equal(labelClean.name, "label-clean");
  assert.equal(labelClean.stage, "A");
  assert.deepEqual(labelClean.catalogue, ["R8"]);
  assert.deepEqual(labelClean.after, ["loop-cond", "for-header"]);
  const body = seq([block(0), block(1)]);
  const node = labeled(0, body);
  const m = labelClean.match(node, ctx);
  assert.ok(m !== null);
  assert.equal(labelClean.rewrite(m, ctx), body);
});

// ---------------------------------------------------------------------------
// Fixture red->green: no orphan `L\d+:` left where nothing targets it, at
// every HBC version.
// ---------------------------------------------------------------------------

const fixture = (name: string, file: string): Uint8Array => new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, file)));
const VERSIONS = [84, 94, 96, 98, 99];

test("08-labeled-break-continue: every version keeps at least one genuine label (100% removal would be wrong) but drops the redundant ones", () => {
  for (const v of VERSIONS) {
    const code = decompile(fixture("08-labeled-break-continue", `v${v}.hbc`), { resolveV98Ambiguity: true, moduleName: "08" }).code;
    const labels = code.match(/\bL\d+:/g) ?? [];
    assert.ok(labels.length >= 1, `v${v}: expected at least one surviving label, found none`);
    assert.ok(labels.length < 6, `v${v}: expected fewer than the 6 labels the structurer originally emitted, found ${labels.length}`);
  }
});

test("11-nested-loops-mixed and 02-while-loop: label-clean fires without changing behaviour (checked via the harness below) and does not increase label count", () => {
  for (const name of ["11-nested-loops-mixed", "02-while-loop"]) {
    for (const v of VERSIONS) {
      const on = decompile(fixture(name, `v${v}.hbc`), { resolveV98Ambiguity: true, moduleName: name }).code;
      const off = decompile(fixture(name, `v${v}.hbc`), { resolveV98Ambiguity: true, moduleName: name, passes: { skip: ["label-clean"] } }).code;
      const onLabels = (on.match(/\bL\d+:/g) ?? []).length;
      const offLabels = (off.match(/\bL\d+:/g) ?? []).length;
      assert.ok(onLabels <= offLabels, `${name} v${v}: label-clean increased label count (${offLabels} -> ${onLabels})`);
    }
  }
});

test("the .obf variants of 08/11/02 stay PASS with passes on", async () => {
  const only = ["08-labeled-break-continue.obf", "11-nested-loops-mixed.obf", "02-while-loop.obf"];
  const report = await runTier({ tier: "hardened", decompiler: hbc2jsDecompiler, only });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => `${r.fixture.name}: ${r.verdict}`);
  assert.deepEqual(bad, []);
  assert.ok(report.summary.pass >= 12, `only ${report.summary.pass} .obf checks ran`);
});

// ---------------------------------------------------------------------------
// 37/48 hang regression (see file header, BUGS.md, docs/AGENT-LOG.md): with
// the full pipeline (label-clean included) enabled, `decompile()` used to
// never return for these two fixtures. Root cause was `expr-rebuild`'s
// unmemoized dead-store search, not label-clean itself, but label-clean's
// unwrapping is what merged the statement lists that exposed it — so the
// regression belongs on this gate as much as expr-rebuild's own.
// ---------------------------------------------------------------------------

test("37-destructuring-array and 48-optional-chaining-nullish (v84/v94) decompile without hanging", () => {
  const HANG_TIMEOUT_MS = 5_000;
  const cases: { readonly name: string; readonly versions: readonly number[] }[] = [
    { name: "37-destructuring-array", versions: VERSIONS },
    { name: "48-optional-chaining-nullish", versions: [84, 94] },
  ];
  for (const { name, versions } of cases) {
    for (const v of versions) {
      for (const variant of ["", ".min", ".obf"] as const) {
        const t0 = Date.now();
        decompile(fixture(name, `v${v}${variant}.hbc`), { resolveV98Ambiguity: true, moduleName: name });
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < HANG_TIMEOUT_MS, `${name}${variant} v${v}: decompile() took ${elapsed}ms (expected well under ${HANG_TIMEOUT_MS}ms) — possible regression of the exponential-recursion hang in expr-rebuild's scanFrom`);
      }
    }
  }
});

test("37-destructuring-array and 48-optional-chaining-nullish (v84/v94): PASS against the trace oracle with the full pipeline on", async () => {
  const only = ["37-destructuring-array", "37-destructuring-array.min", "48-optional-chaining-nullish", "48-optional-chaining-nullish.min"];
  const report = await runTier({ tier: "gate", decompiler: hbc2jsDecompiler, only });
  const bad = report.results.filter((r) => r.verdict !== VERDICT.PASS).map((r) => r.fixture.name);
  assert.deepEqual(bad, []);
  assert.ok(report.summary.pass >= 18, `only ${report.summary.pass} checks ran`);
});
