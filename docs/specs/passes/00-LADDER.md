# The M5 pass ladder — architecture (D9, D12, D12a, D14, D20)

**Who reads this.** An Opus agent speccing a batch of rungs reads this page plus
the catalogue rows it names. A Sonnet agent implementing one rung reads
*only* `src/passes/README.md` and that rung's spec (D12a); this page tells the
spec author what the spec must say so that stays true. Nothing here is code;
where the framework must change before a rung can exist, §7 says so.

**Vocabulary.** A *rung* is one pass directory `src/passes/<name>/`. *Stage A*
rewrites the structurer's tree IR (`src/structure/ir.ts` `Stmt`); *stage B*
rewrites the emitter's JS AST (`src/emit/ast.ts` `Stmt`/`Expr`) after lowering
and before printing. A rung lives in exactly one stage (spec 07 §5.1).

**Baseline shape a rung starts from** (sampled: 02, 12, 17, 19, 23, 27):
`let r0…rN` frames; one statement per instruction (`r3 = "sum="; r3 = r3 + r9`);
`Reflect.apply(f, this, [args])` for every non-fast-path call;
`if (!("print" in r0)) throw new ReferenceError(...)` before each global read;
`_fnN` function names with the real name in a `// fn#N "name"` comment;
environment slots already named `_e<depth>_<slot>`; `__pc`/`__exc` scaffolding
inside every `try`; `finally` bodies duplicated per exit path; v≥97 generators
as `__hbc_makeGeneratorLowered(_fnK)` around a `__pc`-numbered state machine.

---

## 1. Rung inventory

Status: **done** = shipped; **spec'd** = batch assigned below; **hard** = §5
(Fable spec + review). "Versions" is where the idiom exists; a rung matching
nothing at a version is fine, a rung matching *wrongly* at one is not — every
spec states the per-version shape it has read (catalogue confidence rule).

### 1.1 Stage A — tree IR (control flow)

| Rung | Catalogue row(s) | Fixtures | Versions | Recognises → emits | Status |
|---|---|---|---|---|---|
| `loop-cond` | 2, 3 | 02, 03, 11 | all | `loop{block c; if c break}` → `LoopForm` while/do-while annotation | done |
| `for-header` | 4 | 04, 11 | all | init block before + step at body tail → `LoopForm.init/step` | done |
| `finally-dedup` | 12 (+54) | 12, 13, 16, 54 | all | k structurally-equal copies of a finally body + synthesized catch-rethrow → one `finalizer` | **hard** §5.1 |
| `yield-recovery` | 17 | 23–26 | ≤96 | `switch(generator-state)` resume dispatcher + `__state = k; return v` → `function*` with `yield` | batch 4 |
| `gen-lowered` | 18 (ABI ✅ measured, T13) | 23–26 | ≥97 | `CreateGenerator` wrapper + `__pc` state machine → `function*` | **hard** §5.2 |
| `async-recovery` | 19 | 27, 28 | all | `spawnAsync(body)` around a recovered generator → `async function` + `await` | batch 4, `after: [yield-recovery, gen-lowered]` |
| `if-chain` | 1 | 01 | all | `else { if … }` → `else if`; `if (c) return; else {…}` → early return | done |
| `switch-raise` | 6, 7 (8 is ⛔: not until a fixture exists) | 09, 10, 52, 53 | all (opcode rename at 99) | jump-table `switch` node + `JStrictEqual` compare chain on one register → `switch` with fall-through | **done (S1, jump-table)**; S2 blocked on F13 |
| `for-in` | 9 (✅ verified, v94+v99 — re-read done 2026-09-05, spec 21) | 05 | all | `GetPNameList` before a formed loop whose test is `GetNextPName`/`JmpUndefined` → `for (k in o)` | **done** (2026-09-05, agent/forin): registered in `src/passes/registry.ts`; `tests/gate/passes/for-in.test.ts` skip lifted unchanged, 10/10. Verified against the real Hermes VM (byte-for-byte at v84). The landing also fixed the stage-B AST traversal gap (`src/passes/ast.ts` and two rungs' own private duplicates in `reg-split`/`expr-rebuild`) that a first attempt found DIVERGENT — `docs/BUGS.md`'s 2026-09-05 row, now resolved. |
| `for-of` | 10 (✅ verified, v94+v99 — re-read done 2026-09-05, spec 21; v99 `Mov`-refreshes the `IteratorNext` source and the normal-close state register) | 06, 07 | all | `IteratorBegin` + `IteratorNext` loop + two `IteratorClose` sites → `for (v of it)` | **done** (2026-09-05, agent/forin): registered in `src/passes/registry.ts`; `tests/gate/passes/for-of.test.ts` skip lifted, assertions unchanged (the acceptance fixture's exit block stopped reading the binding register — PUSHBACK P-18a), 10/10. `06-for-of-array` and `07-for-of-iterable` both report 3 `for (… of …)` heads at all five versions with no residual iterator helper in 06, gate tier 555 PASS / 0 DIVERGENT. Three lowering shapes the spec had not transcribed were closed in the landing: the v84/v94/v96 **merge-point cleanup** (a `break`-carrying loop's two `try`s share one handler through a `labeled` wrapper — `IterForm.mergeLabel`), the v96/v98/v99 setup block that schedules constant loads *after* its `IteratorBegin`, and v99's `Mov`-aliased normal close. `docs/BUGS.md`'s `for-of-break-handler-shape` row is fixed. |
| `label-clean` | 5 (single-version; the rung is IR hygiene, row is evidence only) | 08, 11 | all | unused labels; `labeled{…; break L}` whose only use is the final break; `seq` of one | done (rung 7, re-enabled 2026-08-31 after infinite-loop fix) |
| `try-shape` | 11 | 14, 15 | all | `try` whose handler never reads `catchRegister` → `catch {}`; `__pc` range guard that covers the whole region → plain `catch` | batch 4, `after: [finally-dedup]` |

Row 27 (obfuscated control-flow flattening) needs **no rung**: Hermes's own
front end collapses the dispatcher. The obfuscation rung that remains is
`string-array-decode` (stage B, §5.5).

### 1.2 Stage B — JS AST (expressions, names, sugar)

| Rung | Catalogue row(s) | Fixtures | Versions | Recognises → emits | Status |
|---|---|---|---|---|---|
| `expr-rebuild` | R1 (§7.2) | all | all | single-def/single-use register in one statement list → inlined expression; `let` only for values live across a boundary; `rX = rX` dropped | done |
| `global-access` | R2 | 19, all | all | `r = globalThis; if (!("x" in r)) throw ReferenceError; r.x` → `x`; `hasOwnProperty(globalThis,"d") ‖ globalThis.d = undefined` → `var d` | done |
| `call-shape` | R3 (+ builtins table) | all | all | `Reflect.apply(f, undefined, [a])` → `f(a)`; `Reflect.apply(o.m, o, [a])` → `o.m(a)`; `Reflect.construct(C, [a])` → `new C(a)`; `functionPrototypeCall/Apply` helpers → `.call/.apply` | done |
| `fn-naming` | R4 | all | all | `_fnN` whose bytecode name is a valid, unshadowed identifier → that name; `_fnN` assigned once to `o.key`/`var k` → `key` | done |
| `var-naming` | R5 | all | all | surviving `rN` → `v1…` by live range; params keep `aN` unless evidence names them; env slots `_eD_S` → names when §5.4 evidence exists | done (2026-08-31; 3.1% named — see PUSHBACK P-6 / reg-split) |
| `reg-split` | R9 | 04, 02, 11, 14, 22 | all | a register with ≥2 disjoint live ranges (webs — reaching-defs over the structured AST; loop-carried values and try→catch flows stay one web) → one variable per range (`r0`, `r0_2`, …), so var-naming can name each independently | **default-on 2026-09-03** (`docs/specs/passes/19-reg-split.md`; unparks P-6), `after: [sugar rungs, jsx-recover]`, `before: [var-naming]` — D23's stage boundary resolved the P-11b jsx-recover interaction, PUSHBACK P-11 closed |
| `template-literal` | 21 | 43, 44 | all | `Reflect.apply(__hbc_HermesInternal.concat, c0, [s0, c1, …])` → template literal (never a `+` chain — row 21 corrected); `getTemplateObject` + tag call → tagged template | batch 3, **merged 2026-09-01** |
| `default-params` | 24 | 39, 51 | 94, 99 (measured); orphan functions at v99, i.e. a top-level `function` with no `CreateClosure` site, are out of reach of the framework's stage-B driver — follow-up, not a shape gap | prologue labeled block `L: { r = arguments[k]; if (r !== U) break L; …default…; break L; }` (not the if/else spec §2 described — corrected per docs/PUSHBACK.md P-8) → `(r = e)` | **merged 2026-09-02** |
| `destructure` | 22 (✅ verified, v94+v99) | 37, 38, 39 | all | one labeled block per array element (own `__hbc_iterBegin`/`__hbc_iterNext` + done flag; the commit may sit at the head of the *next* block) and per defaulted object property (`GetById` + `!== undefined` guard); plain properties are bare `GetById`s; object rest = **3-arg** `copyDataProperties`; array rest = inline append loop → `[rA, rB = d, , ...rR] = x` / `({ a: rA, ...rO } = x)` assignments (spec 16 §2; P-3/P-9 corrected — not straight-line, not an `Expr`) | **merged** (2026-09-02), `after: [default-params]`, `before: [var-naming]`; v1 scope: direct/staged-commit array elements + close block, object plain/defaulted/3-arg-rest properties — array per-element defaults, holes-by-shape and array rest not yet matched (refused, `docs/BUGS.md`) |
| `spread-rest` | 23 (✅ verified, v94+v99) | 40, 41, 42 | all | `arraySpread` runs on a seed array; `new Array(0)` + `arraySpread` + `__hbc_b_apply` calls; `copyRestArgs(arguments, k)`; **2-arg** `copyDataProperties` runs → `[...x]`, `f(...x)`, `(...rest)`, `{...o}` (the 3-arg object form is `destructure`'s — spec 17 §0's ownership table) | **merged** (2026-09-02), `after: [expr-rebuild, global-access, call-shape, destructure]`, `before: [var-naming]`; recovers all S1/S2/S4 sites at all 5 versions; S3 (rest param) misses orphaned functions at v98/v99 (`docs/BUGS.md`, shared root cause with `default-params`) |
| `optional-chain` | 25 (✅ verified, v94+v99) | 48 | v94 fully; v99 partial (docs/BUGS.md) | labeled-block run, one loose-`Eq`-null guard per link: `rRes = undefined; if (rX == N) break L; rT = rX.prop; …` with `Reflect.apply(rM, rBase, …)` for `?.()`; separate `!=` block for `??` → `x?.y?.()`, `x ?? d` (spec 18 §2; P-3 corrected — no `cond` survives to stage B) | **landed** (2026-09-02): v94 fully recovers all `?.`/`??` sites in `48` (0 residual null guards); v99 misses chains whose own base guard is elided by the compiler once a sibling chain already proved it non-null (docs/BUGS.md row) |
| `logical-assign` | 26 (⛔ — fixture first) | none yet | all | branch-around-store → `a ??= b` etc. | unscheduled |
| `class-recover` | 20 (v99 only; ≤98 shape unmeasured) | 32–36 | 99 (≤98 later) | `CreateBaseClass/DerivedClass` + `Constructor<>`/`NCFunction<>` + `<instance_members_initializer>` → `class` | batch 4, `after: [call-shape, fn-naming]` |
| `arguments-form` | 16 (single-version) | 42, 49 | all | `__hbc_arguments` reads where no param slot aliases → `arguments` | batch 4 |
| `literal-forms` | 45, 46, 47, 55 (needs rows) | 45, 46, 47, 55 | all | `new RegExp("…","g")` from a regex-table literal → `/…/g`; BigInt table → `123n`; `typeofIs` mask helper → `typeof x === "…"` chains | batch 4 |
| `try-clean` | 11, 12 | 12–16 | all | `__pc =` stores and `__exc` copies no handler reads → removed; `__pc = -1` frame → removed | batch 4, `after: [expr-rebuild]`; stage-A `try-shape` first |
| `jsx-recover` | D20, R6 | 59, bundles | all | `React.createElement(T, p, …c)` / `jsx(T, {…children})` trees → JSX (opt-in `--jsx`; spilled callee/type/config registers resolved and absorbed per spec 08 implementation notes) | **merged 2026-09-01**, opt-in; §5.3; **reordered 2026-09-03 (D23)** to last-of-structure-recovery (was last overall), before the renaming block |
| `string-array-decode` | R7 (needs row) | `.obf` variants | all | obfuscator string-array accessor `_0x…(i)` → the literal | **hard** §5.5 |
| `closure-naming` | R5 cross-function part | 17, 18, 21, 22 | all | consistent env-slot names across every function touching the slot | **hard** §5.4 |

Not rungs: `29-promise-chaining`, `31-microtask-ordering`, `50-this-binding`
(no idiom); `30-async-generator` (uncompilable); `21-iife-closures` (module
wrapper `_fn0.call(globalThis)` is the emitter's, not a lowering).

**Count: 31 rungs** (12 stage A, 19 stage B); 13 merged (jsx-recover, reg-split opt-in), 4 hard, 1 unscheduled.

---

## 2. Ordering and dependencies

```
stage A                                        stage B
yield-recovery ─┐                              expr-rebuild ── string-array-decode
gen-lowered ────┼─► finally-dedup ─► loop-cond ─► for-header      │
                │        │             ├─► for-in                 ├─► global-access ─► call-shape ─┬─► spread-rest
                │        │             ├─► for-of                 │                                ├─► optional-chain
                │        │             ├─► switch-raise           ├─► fn-naming ─► class-recover   │
                │        │             └─► if-chain               ├─► template-literal             │
                │        └─► try-shape                            ├─► default-params ─► destructure│
                └────────────────► async-recovery                 ├─► try-clean                    │
                            (all) ─► label-clean                  ├─► arguments-form, literal-forms│
                                                                  └─► (all above) ─► jsx-recover ──┘
                                             D23 stage boundary: structure-recovery (above) ─► renaming: fn-naming ─► reg-split ─► var-naming/closure-naming
```

Rationale, one line each (a spec must repeat the ones that bind its rung):

* **Generator rungs first in stage A** (spec 07 §5.2): every later matcher
  assumes ordinary control flow; the resume dispatcher is not a loop.
* **`finally-dedup` before `loop-cond`**: fixture 16's duplicated finally
  bodies contain `break`/`continue` that the tail-guard matcher would otherwise
  read as loop exits; dedup changes block counts loop rungs key on.
  (`loop-cond` already ships, so `finally-dedup` declares `before: ["loop-cond"]`.)
* **`loop-cond` before `for-in`/`for-of`/`switch-raise`/`if-chain`**: they
  annotate or nest inside a *formed* loop; a compare-chain switch inside an
  unformed loop looks like a dispatcher.
* **`label-clean` last in stage A**: every other rung removes label uses.
* **`expr-rebuild` first in stage B** (enforced by `registry.ts` injection,
  PL-11): no syntactic matcher can see through one-instruction-per-statement.
* **`string-array-decode` immediately after `expr-rebuild`**: decoded keys turn
  `o["m"]` into `o.m` so `call-shape` and `fn-naming` see real names.
* **`global-access` before `call-shape`**: `Reflect.apply(r0.print, r2, …)`
  with `r2 = undefined` must become `print(…)`, not `globalThis.print(…)`.
* **`call-shape` before `spread-rest`/`optional-chain`**: spread call args and
  optional calls are shapes *of* a call, not of `Reflect.apply`.
* **`default-params` before `destructure`**: destructuring defaults reuse the
  `=== undefined` idiom (rows 22/24 share one matcher).
* **Naming after everything that deletes registers**: naming a temporary that
  a later rung would have folded wastes a name and blocks the fold
  (`var-naming` is fixed-point-safe but not free).
* **`reg-split` immediately before `var-naming`** (spec 19): splitting a
  reused register's disjoint live ranges into separate variables is what
  lifts var-naming past its §4.1 reuse gate (P-6); it must see the final
  register population, so it runs after every rung that folds or absorbs
  registers.
* **D23 stage boundary — structure-recovery before renaming**
  (`docs/DECISIONS.md` D23): every structure-recovery rung (`expr-rebuild` …
  `optional-chain`, `jsx-recover`) is registered before every pure-renaming
  rung (`fn-naming`, `reg-split`, `var-naming`). `jsx-recover` is therefore
  **last of the structure-recovery block, not last overall**: it wants
  `React.createElement`/`jsx` as calls with named callees and folded props,
  which every earlier structure rung supplies, but it must run *before*
  `reg-split` renames the registers its call-shape matcher keys off
  (`docs/BUGS.md`'s 2026-09-02 P-11b row — reg-split's per-store renaming
  broke jsx-recover's matcher when reg-split ran first). This is also why
  `reg-split` is safe **default-on** (not opt-in): it no longer runs before
  any structure-recovery rung.

### Batches (five rungs each; each batch is one Opus spec task)

| Batch | Rungs | Why this batch |
|---|---|---|
| 1 | `expr-rebuild`, `global-access`, `call-shape`, `fn-naming`, `label-clean` | M4 review's order 1–3: largest readability and round-trip win; erases 30/40 fuzz divergences; needs the stage-B driver (§7.1) — batch 1 *includes* that framework work |
| 2 | `if-chain`, `switch-raise`, `for-in`, `for-of`, `var-naming` | finishes control flow on already-✅ rows (for-in/for-of re-read at v99 and spec'd in `docs/specs/passes/21-for-in-for-of.md`); naming makes batch-1 output reviewable |
| 3 | `template-literal`, `default-params`, `destructure`, `spread-rest`, `optional-chain` | expression sugar, all single-version rows → each spec starts with the second-version read |
| 4 | `yield-recovery`, `async-recovery`, `class-recover`, `try-shape` + `try-clean`, `arguments-form` + `literal-forms` | D9 v1→v2 for ≤96; classes at 99 |
| Fable | `finally-dedup`, `gen-lowered`, `jsx-recover`, `closure-naming`, `string-array-decode` | §5 |

---

## 3. IR ownership

### 3.1 Stage A (`src/structure/ir.ts`)

| Rung | May match/rewrite | Must not touch |
|---|---|---|
| `loop-cond`, `for-header` | `loop` (annotation only), the guard `if`, `break`/`continue` to its label | `try`, `switch`, `block` contents |
| `finally-dedup` | `try`, `seq`, `block` (removing declared duplicates), `return`/`throw` leaves inside the region | `loop` internals, `setState` |
| `yield-recovery`, `gen-lowered` | `switch` with `generator-state`/`dispatch` scrutinee, `setState`, `return` | `try` regions other than the generator's own |
| `if-chain` | `if`, `seq`, `return` | `loop`, `try` |
| `switch-raise` | `switch` (jump-table), `if` chains on one register, `break` to the raised label | `loop` annotations |
| `for-in`, `for-of` | `loop.form` (extends `LoopForm` with an `iter` variant, §7.3), the preceding `block`, the `try`+handler that holds abrupt `IteratorClose` | anything outside `[pred-block, loop, close-handler]` |
| `try-shape` | `try.catchRegister`, handler prologue `block` | body |
| `label-clean` | `labeled`, `seq`, `break` | leaf blocks |

Every stage-A node not listed for a rung is opaque to it: pattern through it
with `children()`/`postOrder`, never rebuild it. `setState` and `unreachable`
are never rewritten by any rung except the generator rungs.

### 3.2 Stage B (`src/emit/ast.ts`)

| Rung | May match/rewrite | Must not touch |
|---|---|---|
| `expr-rebuild` | `let`/`init` of `rN`, `expr`/`assign` statements, any `Expr` containing `ident rN` | statement order; `try`/loops as structure; `__pc`/`__exc` (they are ordered effects) |
| `global-access` | `if (!("x" in r)) throw`, `ident globalThis`, `member` on it, the `hasOwnProperty`/`= undefined` pair | any other `throw` |
| `call-shape` | `call` whose callee is `Reflect.apply`/`Reflect.construct`/`__hbc_b_functionPrototype*` | callee expressions with side effects (refuse) |
| `fn-naming`, `var-naming`, `closure-naming` | `ident` names, `func.name`, `init.name`, `func.params` | everything else (pure alpha-renaming) |
| sugar rungs (`template-literal`, `default-params`, `destructure`, `spread-rest`, `optional-chain`, `literal-forms`) | the `Expr` sub-tree of one statement, **or a run of sibling statements/labeled blocks in one statement list** (P-3/P-8: the measured batch-3 idioms arrive as labeled-block runs with tail `break`s, not as expressions) | statements outside the captured run |
| `class-recover` | `func`, `assign` to `.prototype`, helper calls named in row 20 | bodies of the methods |
| `try-clean` | `try`, `assign`/`init` of `__pc`/`__exc` | anything the handler still reads |
| `jsx-recover` | `call` trees rooted at a proven React callee | non-React calls |

### 3.3 Invariants every rung preserves (in addition to PL-01…PL-11)

* **D14**: the rewrite prints what the bytecode does — one shared `let` per
  loop, no TDZ at 94/99, unmapped `arguments`. A rung that would need Node's
  semantics to be right (e.g. per-iteration `let`) refuses.
* **Isomorphism**: stage A rewrites pass spec 04 §5's whole-function
  round-trip after splicing; annotation-only rewrites satisfy `sameShape`.
* **No cross-pass state**: a rung communicates only through the tree
  (annotations such as `LoopForm`) and `ctx.applied` (ordering assertions
  only, never data). No module-level mutable state; no memo across sites.
* **No cross-function reach** from `match`/`rewrite` except through a
  read-only `ctx.module` view (§7.4) — and only the naming rungs use it.
* **Refuse generously**: an unexpected shape returns `null`; `check` restates
  every assumption `rewrite` made. Abandonment is a metric, not a failure.
* **Idempotent and deterministic** (PL-08, PL-10): a second run rewrites
  nothing; site iteration order is post-order, never a `Map` of object keys.

---

## 4. Shared helpers and the `check` taxonomy

### 4.1 Add to `src/passes/tree.ts` (stage A)

| Helper | Signature | Purpose |
|---|---|---|
| `items` | `(s: Stmt) => readonly Stmt[]` | `seq` flattening; both shipped rungs private-define it |
| `isBreakTo` / `isContinueTo` | `(s: Stmt, L: LabelId) => boolean` | replaces the private `isJump` |
| `precedingSibling` | `(ctx, node) => Stmt \| null` | the `parentOf` dance in `for-header/check.ts` |
| `lastInstruction` | `(fn, block) => Instruction \| null` | terminator access without `instructionsOf(...).at(-1)!` |
| `isSideEffectFree` | `(insns: readonly Instruction[]) => boolean` | loads, moves, compares, const only — the `while-cond` header rule |
| `registerLiveAfter` | `(fn, block, index, reg) => boolean` | for-header/for-of liveness; one conservative implementation |
| `constantAt` | `(fn, block, index, reg) => number \| string \| boolean \| null \| undefined` | generalises `valueAtLoopEntry`'s walk |
| `duplicatedBlocks` | `(fn) => Map<BlockId, Stmt[]>` | structurer-duplicated blocks by original id (finally-dedup, `check` declared-duplicate accounting) |
| `regionBlocks` | `(fn, region) => { body: BlockId[]; handler: BlockId[] }` | try-region membership from `AugmentedCfg` |
| `sameCode` | `(fn, a: BlockId, b: BlockId, opts?: { modRegisters: boolean }) => boolean` | instruction-sequence equality modulo register numbering (finally-dedup, switch-raise arm merging) |
| `blocksMultiset` | `(node: Stmt) => Map<BlockId, number>` | the CF-preserving check with declared duplicates |

### 4.2 New `src/passes/ast.ts` (stage B framework; may import `src/emit/ast.ts`)

| Helper | Signature | Purpose |
|---|---|---|
| `walk` / `mapExpr` / `mapStmts` | visitor + rebuilding maps over `Stmt`/`Expr` | every stage-B rung |
| `identUses` | `(stmts, name) => { reads: number; writes: number; nested: number }` | `nested` = uses inside inner `func` (closure capture) |
| `defUse` | `(stmts) => Map<name, { def: index; uses: index[] }>` for `rN` | expr-rebuild, var-naming |
| `isPure` | `(e: Expr) => boolean` | literals, local idents, arithmetic on pure; **not** `member` (getters), not `call` |
| `isHelperCall` | `(e, name: string) => e is CallExpr` | `__hbc_b_*` recognition by name, never by position |
| `effectSequence` | `(stmts) => Effect[]` | §4.3's expression-only check |
| `freeNames` | `(stmts) => Set<string>` | alpha-renaming safety |
| `parses` | `(stmts) => boolean` | `new vm.Script(printProgram(...))` in try/catch — the cheap "still JS" guard |

### 4.3 `check` taxonomy — say which one your rung uses

| Class | Rungs | Obligation |
|---|---|---|
| **CF-preserving (stage A)** | finally-dedup, switch-raise, if-chain, yield/gen, try-shape, label-clean | `blocksMultiset(before)` = `blocksMultiset(after)` minus the duplicates the rung *declares* it removed; every `break`/`continue` label in `after` resolves; then the driver's whole-function round-trip |
| **Annotation-only (stage A)** | loop-cond, for-header, for-in, for-of | `sameShape(before, after)` + the semantic predicate the annotation asserts (`firstTestHolds`, liveness of the step register, the iterator register is not read after `IteratorClose`) |
| **Expression-only (stage B)** | expr-rebuild, call-shape, global-access, sugar rungs, try-clean, class-recover, jsx | `effectSequence(before)` deep-equals `effectSequence(after)`; `parses(after)`; no `rN` read before its def was introduced. An *effect* is, in order: `call`/`new` (callee + arg count), `member` write, `delete`, `throw`, `return`, `assign` to a name with `nested > 0` or non-`rN`, and any `member` **read** (getters are effects). Pure operations may move; nothing else may. This is O(n) over the statement list — no round-trip, no CFG. |
| **Alpha-renaming (stage B)** | fn-naming, var-naming, closure-naming | `freeNames` unchanged after renaming back; the new name is not in `freeNames` of any enclosing or nested `func`; printing `before` and `after` with the rename undone is byte-identical |

`global-access` additionally asserts the dropped guard's name equals the
member read that follows it (the `in` check and the read are one effect).

---

## 5. Hard rungs (Fable spec + review)

Each: why hard / correctness fallback / evidence required before speccing.

### 5.1 `finally-dedup`
*Hard:* the structurer emits k copies (normal exit, each `return`, the
synthesized catch-rethrow guarded by a `__pc` range) that differ in scratch
registers and in what follows them; the tree IR has **no finalizer node**, so
merging cannot pass `checkIsomorphic` as it stands — it needs `try.finalizer`
in `ir.ts` plus verifier support (spec 04 change, not a pass). Fixture 16's
`break`/`continue` inside finally drop the pending exception — JS `finally`
does the same, so the rewrite is legal, but the copies are not `sameCode`
(one ends in `Throw r`, one falls through).
*Fallback:* copies stay; `try-clean` still removes dead `__pc` stores.
*Evidence:* copy count per site over the corpus (`duplicatedBlocks`), rows 12
and 54 re-read at 84/96/98, a table of which copy contains which terminator.

### 5.2 `gen-lowered` (D9 v2, v≥97)
*Hard:* the resume ABI is now **✅ measured (T13, rows 18/19, read at 98 and
99)**: `LoadParam 1` = action (`0` next, `1` throw, `2` return — `0` is the
fall-through, never compared for), `LoadParam 2` = value; status slot
`0/1/2/3` = not-started / suspended / executing (re-entry trap) / completed;
the env slot numbers are **per function**, so the matcher must find the slot
from the `throwTypeError("...executing generators")` trap, not by index. The
body is a `__pc` state machine inside nested `try`s; each suspension is
`store status 1, store yield-index k; return {value, done:false}` and the
resume is a `JStrictEqual` chain on the index — recovering `yield` means
re-threading straight-line code across arms while keeping every `try`
region's membership. Row 18 still lists what is unpinned (action codes > 2,
`yield*` delegation at ≥97).
*Fallback:* `__hbc_makeGeneratorLowered` stays (provably correct floor).
*Evidence:* execute `.next/.throw/.return` interleavings on the v99 VM for
23–26 and diff against the recovered `function*` under Node; arm-count and
try-nesting histogram of generators in the RN template bundle; confirm the
driver-function shape for async (row 19) so `async-recovery` shares the
matcher.

### 5.3 `jsx-recover` (D20)
*Hard:* the callee is never a name — Metro gives `(0, r.jsx)(T, {…})` with `r`
a `__hbc_b_requireFast(n)` result the decompiler refuses to resolve; proving
"this is React's `jsx`/`createElement`" needs the deps fingerprint (D17) to
identify module *n*. Props spread (`copyDataProperties`), `key`, children
arrays vs varargs, and `jsxs` all change the shape; a wrong match prints JSX
for an unrelated call with the same arity.
*Fallback:* none applied; output stays `jsx(T, {…})`.
*Evidence:* counts of the three call shapes in the RN template and
react-navigation bundles at 94/99; a fixture pair (`createElement` classic
runtime, `jsx` automatic runtime) compiled through Metro; a ✅ row.

### 5.4 `closure-naming`
*Hard:* `_e1_0` is one slot shared by every function in the env chain; a name
must be chosen once per slot and applied in all of them, which no per-site
`match` can see. Evidence for the name exists only in property keys and
`displayName`s at `-O`; the choice must not capture a free name in any
function touching the slot (shadowing across depths). This is a module-level
analysis, i.e. a framework addition (§7.4), not a bigger matcher.
*Fallback:* `_eD_S` stays (already readable and unique).
*Evidence:* per-bundle histogram of slot uses per slot and name-evidence
availability; confirm rows 13/14 at 96/98.

### 5.5 `string-array-decode`
*Hard:* the accessor is a real function (rc4/base64 + rotation, per
`tests/fixtures/OBFUSCATION.md`) that must be *evaluated*, not matched;
evaluation in-process is a sandbox and a supply-chain question, and the
rotation prelude has side effects the decoder depends on. No catalogue row
exists, so PL-06 refuses the rung today.
*Fallback:* calls stay; every other rung still fires around them.
*Evidence:* a row from the `.obf` variants at 94 and 99 describing the
accessor's bytecode shape; a whitelist of the decoder shapes we will evaluate;
a measured count of decodable sites in the hardened tier.

---

## 6. Measurement

Reported in `docs/STATUS.md` per rung and in aggregate, produced by one script
(`tools/passes-metrics.ts`, batch 1) over `tests/fixtures/constructs/**` at all
five versions × base/`.min`/`.obf`, plus the RN template bundle.

**Per rung:** `sites rewritten / abandoned` (from the driver records, already
printed by `--emit-tree`), abandonment reasons histogram, versions where it
fired, wall time.

**Residue metrics** (share of functions containing none of the token, counted
on the printed output):

| Metric | Owner rung(s) | Baseline (M4) |
|---|---|---|
| `while (true)` | loop-cond, for-header | ~0 % free |
| `Reflect.apply` / `Reflect.construct` | call-shape | 0 % |
| raw `rN` identifiers | expr-rebuild, var-naming | 0 % |
| `in r` global guards | global-access | 0 % |
| labels `L\d+:` | label-clean | — |
| `__pc` / `__exc` | try-clean, finally-dedup | — |
| `_fnN` names | fn-naming | 0 % |
| `_eD_S` slots | closure-naming | — |
| `__hbc_makeGenerator*` | yield-recovery, gen-lowered | — |
| round-trip exact functions (M6) | all | 20.8 % |

**"N/53 recovered".** A construct fixture counts as recovered when, at every
version it compiles at and for base/`.min`/`.obf`: (1) verdict PASS with
passes on and off (PL-09); (2) the fixture's owner rung fired on every site
its `docs/lowering` file lists, 0 abandoned; (3) the owner metric's residue is
0 in that fixture's functions; (4) the printed construct matches `source.js`'s
construct kind (a `for` fixture prints `for`). Fixtures with no rung (§1's
"not rungs" list) count as recovered once (1) holds and `rN`/`Reflect.apply`
residue is 0 — the readability rungs are their owner. Denominator stays the 53
STATUS counts today; `55-typeof-is-masks` joins when `literal-forms` lands.

Acceptance bar per batch: every rung green on its targets, no metric
regresses, `--passes=none` byte-identical, gate ≤ 90 s.

---

## 7. Framework changes required before batch 1

1. **Stage-B driver.** `src/passes/driver.ts` is stage A only and
   `emitModule`'s `passes` hook runs between structurer and lowering. Add a
   hook between `lowerInstruction` and `printProgram` (`src/emit/index.ts`),
   a stage-B `applyPasses` over `ast.ts` statement lists (post-order over
   `func` bodies innermost first), a `PassContext` without `structured`, and
   `--emit-ast` mirroring `--emit-tree`. Spec 07 §5.5's injection already
   assumes this exists; nothing runs it.
2. **PL-06 for readability rungs.** `catalogue: []` fails the gate, but
   `expr-rebuild`, naming, `global-access`, `call-shape`, JSX and the
   obfuscation rung recognise no Hermes idiom. Add a "Readability rows" section
   to the catalogue (`R1…R7`, confidence = the baseline sample they were read
   from) so `catalogue: ["R1"]` satisfies the same check; do not weaken the
   rule for idiom rungs.
3. **`LoopForm.iter`.** `for-in`/`for-of` need `{ kind: "for-in" | "for-of"; iter: BlockId; close: BlockId[] }`
   on the annotation; the emitter prints from it and falls back to `while`
   when the blocks are not where declared, exactly as `init/step` does today.
4. **`ctx.module`** (read-only): bytecode function names, the env/closure
   graph from `src/cfg`, and the deps fingerprint verdict per module — for the
   naming rungs and JSX only. Added to `tree.ts`, not imported by rungs.
5. **Spec location.** D12a names `docs/specs/passes/NN-<name>.md`; the README
   says the catalogue detail file is the spec and no such directory exists.
   Resolution: idiom rungs are spec'd in `docs/lowering/<idiom>.md` §§1–7 as
   the README says; readability rungs (R-rows) get `docs/specs/passes/NN-<rung>.md`
   in the same seven-section format; this page is `00-`. Update D12a's text.
6. **`Pass.versions?`** — an optional predicate the registry applies so a rung
   that cannot fire at a version is skipped (and reported as such) instead of
   matching every node to return `null`.
7. **Hoist `items`/`isBreakTo`** from the two shipped rungs into `tree.ts`
   (§4.1) so batch 1 does not copy them a third time.
