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
* **`rewrite(m, ctx) → node`** — pure. Builds the replacement for the captured
  shape only. Never reads the tree outside `m`.
* **`check(before, after, ctx) → { ok, reason? }`** — the site-local guard.
  This is where a pass earns the right to fire. Say what your rewrite assumed
  and assert it here; a stage-A rewrite that is pure annotation (the tree is
  unchanged) gets *no* help from the driver's round-trip, so `check` is the
  only guard it has.

Registration is one line in `src/passes/registry.ts`. Order there is explicit
data, not import order.

## What the driver does for you (`src/passes/driver.ts`)

One pass at a time, innermost site first, until the pass stops matching:

1. `rewrite`, then `check`. A `false` verdict → **that site only** is
   abandoned; the node stays in the tree untouched, a `W_PASS_ABANDONED`
   diagnostic is recorded, and the site is never retried (D12).
2. The rewrite is spliced into the whole function and spec 04 §5's
   `reconstruct` + `checkIsomorphic` round-trip is re-run over the **whole
   function**. A rewrite that changed the CFG is abandoned the same way.
3. An exception escaping `match`/`rewrite`/`check` is `E_PASS_CRASH` (PL-04),
   never a silent skip: an escaping throw means the pass is unsound.

So a bad pass degrades output, it never breaks it — but only if `check` is
honest.

## The import boundary (D12a, enforced by `tests/gate/passes/imports.test.ts`)

Files under `src/passes/<name>/` may import **only**:

* `../types.ts`, `../tree.ts`, `../driver.ts` — the framework;
* `../../structure/ir.ts` and `../../structure/verify.ts` — the public tree IR
  and verifier;
* their own siblings inside the pass directory.

Never `src/emit`, `src/cfg`, `src/disasm`, `src/parse`, or another pass. If you
need something from those, it belongs in `src/passes/tree.ts` (which *is*
framework and may reach further — it re-exports `BlockId`, `Instruction`,
`writtenRegisters`, and borrows the emitter's own `conditionFor` so a pass can
never disagree with the printer about a condition's polarity).

Useful things already in `tree.ts`: `usesOf`, `blocksOf`, `completesNormally`,
`instructionsOf`, `sameShape`, `condInputs`, `valueAtLoopEntry`,
`firstTestHolds`.

## The catalogue rule (PL-06)

`catalogue: []` fails the gate. So does a row that does not exist, or whose
Confidence column is not `✅ verified` — `⛔ inferred` and `✅ single-version`
are both refusals (`docs/LOWERING-CATALOGUE.md`'s own confidence key says to
treat single-version as ⚠️). **Measure first: read the
`hermesc -dump-bytecode` at two versions, write the row and its
`docs/lowering/*.md` evidence file, then write the pass.**

Your pass's *spec* is that catalogue row's detail section — the
`docs/lowering/<idiom>.md` file the row links to, whose §§1–7 (Source, Bytecode,
CFG/IR shape, Matcher, Writer, Checker, Version differences) are exactly what
spec 07 §3.2 asks for. That file plus this page is the whole reading list
(D12a); there is no separate `docs/specs/passes/` directory.

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
