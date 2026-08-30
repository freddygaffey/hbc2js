# 01 — framework fixes (batch 1, land these first)

**Who implements this.** One Sonnet agent, before any of `02`…`06`. Reading
list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Nothing else.
Ten framework items (F1…F10) plus §9's seven fixes carried over from
`docs/reviews/M5-pass-1.md`; each is small, each ships its own tests.
**Acceptance for the whole file: the corpus output is byte-identical to
today's** (no rung is registered here), gate green, gate ≤ 90 s.

## 1. F1 — the stage-B driver

`src/passes/driver.ts` drives stage A only; `emitModule`'s `passes` hook runs
between the structurer and lowering. Stage B needs its own driver.

* **Node granularity: a statement list, `readonly Stmt[]`** (`src/emit/ast.ts`).
  A stage-B rung is `Pass<readonly Stmt[], TData>`: `match` takes one list,
  `rewrite` returns the replacement, `check` compares two lists. That is the
  granularity §4.3's expression-only check is defined over, and the only one in
  which `expr-rebuild` can move a value between statements.
* **Site order.** `stmtLists(body)` yields every statement list reachable from
  the function body **innermost first (post-order)**, skipping any `k:"func"`
  statement's or `func` expression's body — already processed under its own
  context. Lists compare by object identity, so the driver's `refused` set
  works as in stage A. `spliceList(root, target, repl)` rebuilds only the
  spine, mirroring `driver.ts`'s `splice`.
* **Where it hooks.** `src/emit/index.ts`'s `emitOne`, right after
  `emitFunction(...)` returns and before the parent splices it in — `emitOne`
  recurses into children first, so this is innermost-function-first with
  `cfg`/`functionIndex` in hand, and it precedes `checkBindings`, which then
  double-guards every rename (EM-01). New `EmitOptions.astPasses?: (fn, cfg) =>
  { fn; diagnostics }`, built by `astPassHook(analysis, opts)` in
  `src/passes/index.ts`.
* **Context.** `PassContext` without `structured`/`parentOf`, plus
  `readonly fnBody?: readonly Stmt[]` — the *current* whole function body,
  re-derived after every accepted site, which is how a rung asks a
  whole-function question (liveness, free names) from one list — and
  `readonly module?: ModuleView` (F6).
* **Whole-function guard.** Per site, only the rung's own `check` (stage A's
  per-site round-trip is too expensive here); then **once per (pass,
  function)**, after that pass's sites are exhausted, `parses(fnBodyAfter)` —
  on failure revert that pass's work on that function and record one
  `W_PASS_ABANDONED` reason `whole-function parse failed`. An escaping throw is
  still `E_PASS_CRASH`. `--emit-ast` mirrors `--emit-tree` (each function's
  list with a `passes=…`/`abandoned=…` header). `enabledPasses({stage:"B"})`
  and the `expr-rebuild` `after:` injection already exist in `registry.ts`;
  stage-B rungs append to `REGISTRY` after the stage-A ones.

Tests: `stmtLists` order and func-skipping; `spliceList` identity; synthetic
rungs that rewrite / fail `check` / emit unparseable output / throw.
## 2. F2 — PL-06 readability rows

`catalogue: []` fails the gate, and the readability rungs recognise no Hermes
idiom, so they cannot cite one.

* Add a `## Readability rows (PL-06)` section to `docs/LOWERING-CATALOGUE.md`,
  same columns as the index, keyed `R1`…`R8`: R1 `expr-rebuild`, R2
  `global-access`, R3 `call-shape`, R4 `fn-naming`, R5 `var-naming`
  (+ `closure-naming`), R6 `jsx-recover`, R7 `string-array-decode`, **R8
  `label-clean`**. Confidence `✅ verified`; "Versions read" names the baseline
  sample it was read from (e.g. `19-var-hoisting v94`).
* `Pass.catalogue` widens to `readonly (number | string)[]`;
  `parseCatalogueIndex` also parses the readability table (`R\d+` keys) into
  the same `Map<number | string, CatalogueRow>`; `checkCatalogue` is unchanged
  otherwise. **Do not weaken the rule for idiom rungs** — a numeric row that is
  `⛔` or `✅ single-version` still fails.
* R8 exists because the ladder assigns `label-clean` catalogue row 5, which is
  `✅ single-version` and so rejected by `checkCatalogue`; the rung is IR
  hygiene, not an idiom. Row 5 stays its evidence link in the Notes cell.

## 3. F3 — spec location, and four README gaps

D12a and the README disagree; **the README wins**. Edit D12a in
`docs/DECISIONS.md`: idiom rungs are spec'd in `docs/lowering/<idiom>.md`
§§1–7; *readability* rungs (R-rows) in `docs/specs/passes/NN-<rung>.md` in the
same seven sections; `00-LADDER.md` is the architecture. Correct D12a's
`src/passes/<name>/<name>.test.ts` to `tests/gate/passes/<name>.test.ts`, where
`loop-cond.test.ts` already lives, and make `imports.test.ts` require that file
to exist per pass. Then close the four gaps review F9 found in the README:

1. the "there is no separate `docs/specs/passes/` directory" sentence — replace
   it with the split above;
2. **the `Match` contract**: the driver splices *the node it called `match` on*
   and ignores `m.root` (`driver.ts:47,66`); `m.at.offset` is what
   `--emit-tree`/`--emit-ast` and `W_PASS_ABANDONED` print. A `root` that
   disagrees with the matched node fails silently;
3. `MAX_SITES_PER_PASS` (`driver.ts:23`) is the real backstop behind "the site
   is never retried"; `refused` is keyed by node identity;
4. the PL-08 idempotence trick both shipped rungs use and nobody wrote down:
   annotate so the next `match` returns `null` (`form !== undefined`). Add the
   stage-B form: a stage-B rung must be a fixed point on its own output.

Also record the D14 invariant review M5-pass-1 asks for: `LoopForm.init` is an
`Expr`, never a declaration — the emitter can print `for (r1 = 0; …)` and must
never print `for (let i = 0; …)`, which would give Node's per-iteration binding
where Hermes shares one.

## 4. F4 — hoist into `src/passes/tree.ts`

Both shipped rungs private-define these; batch 1 would be the third copy.
`items(s) = s.k === "seq" ? s.body : [s]`; `isBreakTo(s, label)` /
`isContinueTo(s, label)` replacing the private `isJump`. Update
`loop-cond/match.ts` and the inline `.k === "seq" ? … : […]` in
`loop-cond/rewrite.ts`. Output must not change.

## 5. F5–F7 — three type additions

**F5 `LoopForm.iter`** (`src/structure/ir.ts`):

```ts
readonly iter?: { readonly kind: "for-in" | "for-of"; readonly iterBlock: BlockId; readonly close: readonly BlockId[] };
```

`src/emit/function.ts` prints `for (k in o)` / `for (v of it)` from it, falling
back to `while` when the named blocks are not where declared, exactly as
`init`/`step` do. Nothing sets it in batch 1, so output is unchanged; batch 2's
`for-in`/`for-of` then need no framework work.

**F6 `ctx.module`** — read-only, in `tree.ts` (framework, so it may reach into
`src/cfg`), built once per module by `src/passes/index.ts`. Only the naming
rungs and `jsx-recover` may read it (convention, not enforced); rungs still
never import `src/cfg`, so the import-boundary test is unchanged.

```ts
export interface ModuleView {
  readonly functionCount: number;
  functionName(index: number): string;              // "" when anonymous
  isGlobalFunction(index: number): boolean;
  envSlotAccesses(env: number, slot: number): readonly { functionIndex: number; offset: number }[];
  depsVerdict(): readonly { module: number; package: string; confidence: number }[] | null;
}
```

**F7 `Pass.versions?`** — `(hbcVersion: number, layoutClass: LayoutClass) =>
boolean`, applied by `runPasses` (stage A) and `astPassHook` (stage B) when the
list is built for a module, not in `enabledPasses`, which has no version in
hand. A filtered-out rung is reported once per module as an `info` diagnostic
`W_PASS_VERSION_SKIP`, shown as `skipped(version)` by `--emit-tree`/`--emit-ast`.

## 6. F8 — new `src/passes/ast.ts`

Framework for stage B; may import `src/emit/ast.ts` and `src/emit/print.ts`.
Add `../ast.ts` to `tests/gate/passes/imports.test.ts`'s allowlist.

| Helper | Signature |
|---|---|
| `walk` / `mapExpr` / `mapStmts` | visitor + rebuilding maps over `Stmt`/`Expr` |
| `stmtLists` / `spliceList` | F1's site enumeration and splice |
| `freeNames` / `parses` | `Set<string>` of free names; `new vm.Script(printProgram(stmts))` in try/catch |
| `identUses` | `(stmts, name) => { reads; writes; nested }`; `nested` = uses inside a nested `func` |
| `defUse` | `(stmts) => Map<string, { defs: number[]; reads: number[] }>` over `rN`, pre-order statement index |
| `isPure` | literals, idents, `this`, unary/binary/logical/cond over pure. **Not** `member` (getters), `call`, `new`, `assign` |
| `isPureStmt` | `comment`/`decl`, or `expr` assigning a pure value to an `ident` |
| `isHelperCall` | `(e, name) => e is CallExpr` — `__hbc_b_*` by callee name, never by position |
| `isSafeIdentifier` | the emitter's `IDENT_RE` + reserved words, copied (rungs may not import `src/emit/names.ts`) |
| `effectSequence` | §4.3's ordered effects: `call`/`new` (callee shape + arity), member write, `delete`, `throw`, `return`, assignment to a non-`rN` name or a name with `nested > 0`, and every member **read** |
| `expressionOnlyCheck` | `effectSequence` deep-equal + no `rN` read before its first def in `after` |

## 7. F9 — suppressible loop labels

`06-label-clean` cannot drop a loop label through the IR: `break`/`continue`
carry a required `LabelId` and `src/emit/function.ts` prints `labelName(...)`
unconditionally. Add `readonly hideLabel?: boolean` to the `loop` node,
transparent to `verify.ts` as `form` is. The emitter collects the function's
hidden `LabelId`s and prints `label: null` on those loops and on every
`break`/`continue` targeting them. Nothing sets it in batch 1.

## 8. F10 — register-declaration pruning (finaliser, not a rung)

After the stage-B pipeline has fired **at least one** site in a function, prune
that function's leading `decl let r0…rN` to the `rN` still occurring as an
`ident` in its body (nested `func` bodies declare their own frame); drop the
`decl` when none remain. A finaliser rather than an `expr-rebuild` rule,
because `global-access` and `call-shape` kill registers *after* `expr-rebuild`
reaches its fixed point. Gated on a pass having fired, so `--passes=none` stays
byte-identical; `checkBindings` (EM-01) fails loudly on an over-prune.

## 9. Review fixes carried over (`docs/reviews/M5-pass-1.md`)

Two of these are that review's batch-1 **blockers**; all seven land here.

* **F1 (HIGH) — the D12a import boundary does not hold.**
  `tests/gate/passes/imports.test.ts:22,46`: `import "../../emit/conds.ts";`
  (no `from` clause) and `import … from "./../../emit/conds.ts";` (one extra
  `./`) both pass today. Fix `importsOf` to also match a clause-less
  `import "x"`, and replace `spec.startsWith("./")` with a real
  `resolve(dirAbs, spec).startsWith(dirAbs + sep)` sibling test. Add all five
  probe forms from the review as assertions over in-memory source strings, so
  the test tests itself and not only the two well-behaved passes that exist.
  This matters more, not less, once `../ast.ts` joins the allowlist (F8).
* **F2 (HIGH) — no test has ever made a real `check` return `ok: false`.** Both
  abandonment tests substitute a stub, and across the corpus the real checks
  fired 1,573 times and refused 0. Add `tests/gate/passes/for-header.test.ts`:
  (a) a synth CFG for `r1 = 20; r2 = 10; do { r1++ } while (r1 < r2)` —
  `loop-cond` applies, `for-header` does not, output stays `do…while`; (b) the
  same CFG through a `for-header` variant whose `match` omits the
  `firstTestHolds` proof — `abandoned` names `for-header` with
  `/statically-true first test/` and `r.fn.root === fn.root`. Add the mirror
  for `loop-cond/check.ts` (a head-form site whose test block carries
  straight-line instructions). README checklist item 3 already required this.
* **F3 (MEDIUM) — the emitter can silently drop a `for` head's init.**
  `src/emit/function.ts:405-407` consumes `pendingInit` unconditionally, and
  none of `lowerFormedLoop`'s `return false` paths push it back while the
  preceding block has already been emitted trimmed to `{ to: init.from }`. Not
  reachable today; **reachable the moment F1's stage-B driver or a second
  stage-A loop rung touches a formed loop**, and it produces wrong code rather
  than a refusal. Fix by not trimming the pred block until the loop is known to
  lower as a `for` (preferred), or by emitting `init` on the false path.
* **F4 (MEDIUM)** — `for-header`'s `check` re-derives `firstTestHolds` with the
  same arguments its `match` used, and the driver's round-trip is vacuous for an
  annotation-only rewrite, so the predicate guards itself. Add a differential
  test that *runs* both synthesised loops (true and false first test) and
  compares results, rather than re-asserting the predicate.
* **F5 (MEDIUM)** — mistyped pass names are silent: `--no-pass nonexistent`
  exits 0 and disables nothing, and `after: ["loop-condd"]` never constrains or
  complains (`registry.ts:35,42,50`). Validate `only`/`skip`/`after`/`before`
  against the registry and throw `E_PASS_ORDER` (CLI usage error for
  `--no-pass`). Batch 1 quadruples the number of names in play.
* **F8** — `for-header` has no test file of its own; F2 creates it.
* **F6/F7 are not batch 1.** F6 (`singleDefConstant` should be a
  reaching-definition test, not "one def in the whole function") and F7 (a
  `while-promote` rung for a rotated `while` with no step slice) are precision
  work on shipped rungs; log them against `00-LADDER.md` §1.1 rather than doing
  them here. The same review's metrics finding — that `N/53` conflates rows
  recovered, rungs done and fixtures de-scaffolded, and that "recovered" must
  mean *at every version* — belongs to whoever next edits ladder §6.

## 10. Acceptance checklist

1. `npm test` green; gate ≤ 90 s; `npm run test:all` once at the end.
2. `--passes=none` byte-identical to the M4 baseline, **and with passes on the
   construct corpus is byte-identical to today** at all five versions and for
   `.min`/`.obf` — F1…F10 add capability, not output.
3. New unit tests for F1, F4, F8 (each helper, incl. `effectSequence` on a
   member read), F10, and §9's F1/F2/F4 — including at least one test in which
   a **real** `check` refuses a real site. Catalogue R-rows, D12a and
   `src/passes/README.md` edited in the same commit; one `docs/AGENT-LOG.md`
   line.

**Estimated size:** ~450 lines of new framework code + ~350 lines of tests.
