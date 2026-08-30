# 06 — `label-clean` (stage A, catalogue row **R8**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Depends
on `01-framework-fixes.md` (F4's `items`/`isBreakTo`, F9's `loop.hideLabel`).
**Last in stage A**: every other stage-A rung removes label uses, so this one
must see the final tree.

## 1. Purpose

The structurer labels every loop and every multi-level-break block, and
`src/emit/function.ts` prints the label unconditionally. Most of them are
unnecessary: a `continue L` to the innermost enclosing loop is a plain
`continue`, and a `labeled` block whose only use is a break in tail position is
nothing at all. This rung is IR hygiene, not idiom recovery — it recognises no
Hermes lowering, hence an R-row rather than catalogue row 5 (which is
`✅ single-version` and would fail PL-06).

Before — `08-labeled-break-continue/v94.hbc`, `--emit-tree`:

```
L1: loop {
  L2: {
    block b2
    if b2 { break L2 } else { block b3; if b3 { continue L1 } else { … } }
  }
  block b5
  …
}
```

After:

```
loop {
  block b2
  if b2 { } else { block b3; if b3 { continue } else { … } }
  block b5
  …
}
```

## 2. Baseline shape

`src/structure/ir.ts`: `{k:"labeled", label, body}`, `{k:"loop", label, body,
form?}`, `{k:"break", label}`, `{k:"continue", label}`. `LabelId` is required on
`break`/`continue`, so a loop label can never be *deleted*, only **hidden**
(`01` F9's `loop.hideLabel`, transparent to `verify.ts` as `form` is; the
emitter then prints `label: null` on that loop and on every jump targeting it).
`labeled` nodes contribute no CFG block and no edge, so they are deleted.

## 3. IR shape the rung owns

May match/rewrite: `labeled`, `seq`, `break`, `continue`, and the `hideLabel`
field of `loop`. **Must not touch** leaf `block` nodes, `if`, `try`, `switch`,
`setState`, `unreachable`, or any `loop.form` — in particular never reorder or
delete a `block`, which is what keeps `blocksMultiset` invariant.

## 4. Matcher

Post-order, innermost first (the driver's order). Return the first applicable of
L1…L4. `usesOf(node, label)` (`tree.ts`) gives `{breaks, continues}`.

**L1 — unused `labeled`.** `node.k === "labeled"` and
`usesOf(node.body, node.label)` is `{breaks: 0, continues: 0}`.

**L2 — tail-break `labeled`.** `node.k === "labeled"`; every `break L` for
`L = node.label` inside `node.body` is in **tail position** of the labeled body;
and there is no `continue L`. Tail position is computed structurally: the tail
set of `seq` is the tail set of its last element; of `if` it is the union of the
tail sets of `then` and `else`; of `labeled`/`loop` bodies it is empty (a break
out of an inner construct is not a tail of this one); a `break L` statement is
in the set iff it is reached that way. Any `break L` outside the tail set →
refuse (`break-not-in-tail`).

**L3 — hideable loop label.** `node.k === "loop"`, `node.hideLabel !== true`,
and for every `break`/`continue` targeting `node.label` inside `node.body`,
`node` is the innermost enclosing construct that could receive an unlabelled
jump at that use site: for a `continue`, the innermost enclosing `loop`; for a
`break`, the innermost enclosing `loop` **or** `labeled`. Compute with one
lexical walk of `node.body` carrying a stack of enclosing loop/labeled labels;
a use whose target is not the top of the appropriate stack → refuse
(`label-still-needed`). Zero uses also matches (the label is simply unused).

**L4 — `seq` of one.** `node.k === "seq" && node.body.length === 1`. Cheap
hygiene; `withChildren` already flattens nested `seq`s, but a one-element `seq`
survives a rewrite by an earlier rung.

## 5. Writer

* **L1**: return `node.body`.
* **L2**: return `node.body` with every tail `break L` deleted — a deleted
  break leaves its arm as `{k:"seq", body:[]}` when it was the arm's only
  statement, which is legal and prints as an empty block.
* **L3**: return `{...node, hideLabel: true}`. Annotation only; the tree is
  otherwise untouched, so `sameShape(before, after)` holds.
* **L4**: return `node.body[0]`.

## 6. Checker

Class: **CF-preserving** (ladder §4.3), except L3 which is
**annotation-only**. `check` must:

1. `blocksMultiset(before)` equals `blocksMultiset(after)` — no `block` leaf is
   added, removed or duplicated (L1/L2/L4 delete only label wrappers and
   `break` statements, which carry no blocks);
2. every `break`/`continue` label appearing in `after` still resolves to an
   enclosing `labeled`/`loop` *in the spliced whole tree* — the rung sees only
   its subtree, so assert it on `after` and let the driver's whole-function
   round-trip catch the rest;
3. L2 only: re-derive the tail set on `before` and assert every deleted `break`
   was in it, and that `usesOf(before.body, label).continues === 0`;
4. L3 only: `sameShape(before, after)`, `before.form` is unchanged, and the
   innermost-target property of §4 L3 re-derived from `before` (do not trust the
   match data);
5. L1 only: `usesOf(before.body, before.label)` is `{0, 0}`.

The driver then re-runs `reconstruct` + `checkIsomorphic` over the whole
function for L1/L2/L4, which is the real proof that the control flow is
unchanged; L3 gets no help from it (the tree is identical), so obligation 4 is
its only guard — write it carefully.

## 7. Ordering, refusals, metrics

**Ordering.** `stage: "A"`, `after: ["loop-cond", "for-header"]`, last in the
stage-A block. As batches 2 and 4 land (`if-chain`, `switch-raise`, `for-in`,
`for-of`, `try-shape`, `yield-recovery`) each is registered *before* this rung
and this `after:` list grows to include it — that rule belongs to whoever adds
those rungs, and is restated in `00-LADDER.md` §2. **IR ownership**: `labeled`,
`seq`, `break`, `continue`, `loop.hideLabel` (ladder §3.1); never leaf blocks.

**Refuse (per-site):** `break-not-in-tail`, `label-still-needed`,
`continue-to-labeled-block` (a `continue` whose target is a `labeled`, which
the structurer should never emit — refuse rather than assume), `loop-form-cond`
(L3 on a loop whose `form.at === "tail"` where the guard's `continue L` is the
loop test: hiding the label is still correct, but assert the innermost property
holds for it too rather than special-casing it), `generator-dispatcher` (the
function's root contains a `switch` with a `generator-state` or `dispatch`
scrutinee — leave every label alone until batch 4's generator rungs have run;
declare `versions` nothing, this is a per-function refusal).

**D14.** Label hygiene changes no evaluation order, no binding, no exception
path; the only risk is a jump that changes target, which obligations 2–4 and
the driver's round-trip both cover.

**Fixtures (red→green).** `targets: ["08-labeled-break-continue",
"11-nested-loops-mixed", "02-while-loop"]`, all five versions plus
`.min`/`.obf`. Unit tests on hand-built trees (`tests/gate/passes/synth.ts`):
≥1 positive per rule; negatives for a `labeled` with a non-tail `break`, a
`continue` to an outer loop across an inner one, and a label used by both a
`break` and a `continue` from different depths; ≥1 site the `check` refuses.

**Corpus metric.** Residue metric `labels L\d+:` (ladder §6, baseline "—"):
share of emitted functions with zero `L\d+:` declarations, target **≥ 70 %**
over `tests/fixtures/constructs/**` at all five versions, plus surviving labels
per function on the RN template bundle. Fixture 08 must still print at least one
genuine labelled `break outer` — 100 % there would mean the rung is wrong.

**Estimated size:** ~140 lines across `match/rewrite/check`, ~200 lines of
tests.
