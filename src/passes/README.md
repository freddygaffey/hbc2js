# Writing a pass (D12 / D12a) — read this and your pass's catalogue row, nothing else

A pass makes the decompiler's *correct* output *readable*. It never makes it
more correct. If a pass is deleted the build still passes; the JS just looks
like the bytecode again. `--passes=none` is exactly that (PL-05).

## The contract

`src/passes/<name>/` holds `index.ts`, `match.ts`, `rewrite.ts`, `check.ts`,
and exports one object of type `Pass` (`src/passes/types.ts`):

```ts
export const myPass: Pass<Stmt, MySite> = {
  name: "my-pass",          // kebab-case, identical to the directory name
  stage: "A",               // A = the structurer's tree IR; B = the JS AST
  targets: ["04-for-loop-basic"],   // fixtures that exercise it
  catalogue: [4],           // docs/LOWERING-CATALOGUE.md row numbers (PL-06)
  after: ["loop-cond"],     // optional ordering constraints, checked at
  before: [],               // registry-selection time, not at run time
  match, rewrite, check,
};
```

* **`match(node, ctx) → Match | null`** — pure, and it *must not mutate*.
  Recognises exactly one Hermes lowering idiom. Return `null` for everything
  else, generously: a refused site costs nothing, a wrong match costs
  correctness. The driver calls it on every node, innermost (post-order) first.
  A `Match`'s `root` is documentation only — **the driver splices the exact
  node it called `match` on, never `m.root`** (`driver.ts:47,66`); if your
  `root` disagrees with the matched node, that disagreement fails silently.
  `m.at.offset` is the one field the driver actually reads back out of a
  match besides the node itself: it is what `--emit-tree`/`--emit-ast` and
  every `W_PASS_ABANDONED` line print, so make it point at the site.
* **`rewrite(m, ctx) → node`** — pure. Builds the replacement for the captured
  shape only. Never reads the tree outside `m`.
* **`check(before, after, ctx) → { ok, reason? }`** — the site-local guard.
  This is where a pass earns the right to fire. Say what your rewrite assumed
  and assert it here; a stage-A rewrite that is pure annotation (the tree is
  unchanged) gets *no* help from the driver's round-trip, so `check` is the
  only guard it has.

**Idempotence (PL-08).** A pass must be a fixed point: run it twice and the
second run rewrites nothing. Both shipped stage-A rungs get this for free the
same way — `rewrite` sets an annotation (`form !== undefined`, `hideLabel`,
…) that `match` itself checks for and refuses to match again, so a site that
already carries the annotation is invisible to a second pass. A stage-B rung
has no annotation field to piggyback on (it rewrites the AST itself, not a
sidecar field on it), so it must reach the same fixed point structurally:
`match` must return `null` on its own `rewrite`'s output, not merely on the
original shape.

Registration is one line in `src/passes/registry.ts`. Order there is explicit
data, not import order.

## What the driver does for you (`src/passes/driver.ts`)

One pass at a time, innermost site first, until the pass stops matching:

1. `rewrite`, then `check`. A `false` verdict → **that site only** is
   abandoned; the node stays in the tree untouched, a `W_PASS_ABANDONED`
   diagnostic is recorded, and the site is never retried (D12). The real
   backstop behind "never retried" is `MAX_SITES_PER_PASS` (`driver.ts:23`,
   10,000): `refused` is keyed by node identity, so a matcher that keeps
   producing genuinely fresh matches forever (PL-08 says it must not) is
   stopped rather than looping the process to death.
2. The rewrite is spliced into the whole function and spec 04 §5's
   `reconstruct` + `checkIsomorphic` round-trip is re-run over the **whole
   function**. A rewrite that changed the CFG is abandoned the same way.
3. An exception escaping `match`/`rewrite`/`check` is `E_PASS_CRASH` (PL-04),
   never a silent skip: an escaping throw means the pass is unsound.

So a bad pass degrades output, it never breaks it — but only if `check` is
honest.

**D14 invariant.** `LoopForm.init` (and `.step`) is an `Expr`, never a
declaration: the emitter prints `for (r1 = 0; …)`, and must never print
`for (let i = 0; …)` — the latter is Node's per-iteration `let` binding,
which the bytecode does not have (Hermes shares one binding across every
iteration; see D14 in `docs/DECISIONS.md`). A pass that hands the emitter a
declaration here would be quietly wrong at the one point this project treats
"the bytecode's own semantics, not the source's" as non-negotiable.

## Stage B: the JS AST

Everything above is stage A (the structurer's tree IR). A stage-B rung's
`Pass<readonly Stmt[], TData>` operates one level down, on `src/emit/ast.ts`'s
JS AST, at the granularity of **a statement list**: `match` takes one list,
`rewrite` returns its replacement, `check` compares two lists. This is the
granularity at which a rung can move a value between statements — the tree
IR's nodes are too coarse for that.

The stage-B driver (`src/passes/ast.ts`'s `applyAstPasses`) mirrors the
description above with two differences: sites are enumerated by `stmtLists`
(every statement list reachable from the function body, innermost first,
skipping any nested function's body — that is a separate site, already
processed under its own context), and the whole-function guard is cheaper —
stage A's per-site tree round-trip has no stage-B equivalent (there is no CFG
to reconstruct), so instead `parses` runs **once per (pass, function)**,
after that pass's sites are exhausted; on failure the whole pass's work on
that function is reverted, not just the last site, and one `W_PASS_ABANDONED`
records `"whole-function parse failed"`. `ctx.fnBody` is the *current* whole
function body, re-derived after every accepted site, for a rung that needs a
whole-function answer (liveness, free names) from one list. `--emit-ast`
mirrors `--emit-tree`.

`src/passes/ast.ts` is stage B's `tree.ts`: `walk`/`mapExpr`/`mapStmts` (a
read-only visitor and two rebuilding maps), `stmtLists`/`spliceList` (site
enumeration and splice), `freeNames`/`parses`, `identUses`, `defUse` (`rN`
def/use by pre-order statement index), `isPure`/`isPureStmt`,
`isHelperCall`, `isSafeIdentifier`, and `effectSequence`/
`expressionOnlyCheck` — §4.3's ordered-effects comparison, the whole guard an
expression-only rewrite (one that only changes *how* a value is computed,
never *what is observable while computing it*) needs.

## The import boundary (D12a, enforced by `tests/gate/passes/imports.test.ts`)

Files under `src/passes/<name>/` may import **only**:

* `../types.ts`, `../tree.ts`, `../ast.ts`, `../driver.ts` — the framework;
* `../../structure/ir.ts` and `../../structure/verify.ts` — the public tree IR
  and verifier;
* their own siblings inside the pass directory.

Never `src/emit`, `src/cfg`, `src/disasm`, `src/parse`, or another pass. If you
need something from those, it belongs in `src/passes/tree.ts` (stage A) or
`src/passes/ast.ts` (stage B) — both *are* framework and may reach further:
`tree.ts` re-exports `BlockId`, `Instruction`, `writtenRegisters`, and
borrows the emitter's own `conditionFor` so a pass can never disagree with the
printer about a condition's polarity; `ast.ts` may import `src/emit/ast.ts`
and `src/emit/print.ts` for the same reason.

Useful things already in `tree.ts`: `usesOf`, `blocksOf`, `completesNormally`,
`instructionsOf`, `sameShape`, `condInputs`, `valueAtLoopEntry`,
`firstTestHolds`, `items`, `isBreakTo`, `isContinueTo`. `ctx.module` (a
read-only whole-module view — function names, env slot accesses, the deps
verdict when one exists) is available to every rung, stage A or B, by
convention read only by the naming rungs and `jsx-recover`.

## The catalogue rule (PL-06)

`catalogue: []` fails the gate. So does a row that does not exist, or whose
Confidence column is not `✅ verified` — `⛔ inferred` and `✅ single-version`
are both refusals (`docs/LOWERING-CATALOGUE.md`'s own confidence key says to
treat single-version as ⚠️). **Measure first: read the
`hermesc -dump-bytecode` at two versions, write the row and its
`docs/lowering/*.md` evidence file, then write the pass.**

Your pass's *spec* depends on which kind it is (D12a): an **idiom** rung's
(one that recognises a Hermes lowering idiom, numbered catalogue rows) is the
catalogue row's `docs/lowering/<idiom>.md` evidence file; a **readability**
rung's (an `R`-numbered row — it recognises no idiom, so it has no
`docs/lowering/*.md` evidence file to point at) is
`docs/specs/passes/NN-<rung>.md`. Both use the same seven sections (Source,
Bytecode, CFG/IR shape, Matcher, Writer, Checker, Version differences) that
spec 07 §3.2 asks for. `docs/specs/passes/00-LADDER.md` is the ladder's
architecture document, not a per-rung spec. That file plus this page is the
whole reading list.

## Running one pass on one fixture

```sh
npm run cli -- tests/fixtures/constructs/04-for-loop-basic/v94.hbc      # all passes
npm run cli -- …/v94.hbc --no-pass for-header                           # all but one
npm run cli -- …/v94.hbc --passes=none                                  # M4 baseline
npm run cli -- …/v94.hbc --emit-tree      # tree IR + `passes=`/`abandoned=` per function
npm run cli -- --list-passes
node --test "tests/gate/passes/*.test.ts"
```

## Checklist for a new pass

1. Catalogue row `✅ verified` at ≥2 versions + its `docs/lowering/*.md`.
2. `src/passes/<name>/{index,match,rewrite,check}.ts`; registry line.
3. Unit tests on hand-built trees (`tests/gate/passes/synth.ts`): ≥1 positive,
   ≥2 negative, ≥1 site the `check` refuses.
4. Red→green on the `targets` fixtures at all five HBC versions, plus their
   `.obf` variants through the hardened tier.
5. `npm test` green, and `--passes=none` still byte-identical to the baseline.
6. `docs/STATUS.md`, `docs/AGENT-LOG.md`, and the catalogue row's Pass column,
   in the same commit.
