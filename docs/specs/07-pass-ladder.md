# Spec 07 — The pass ladder (M5)

**Milestone:** M5 — begins only once M4's baseline is green (spec 05 §1)
**Status:** framework ready to implement; individual passes gated on `docs/TASKS.md` **T3**
**Owner model:** framework — Opus; individual passes — Sonnet, one per session (D5)
**Prerequisites:** specs 03, 04, 05, 06
**Consumers:** `docs/LOWERING-CATALOGUE.md`, `docs/STATUS.md`'s `N/53 recovered` counter

Reference: `docs/DECISIONS.md` **D11** (incremental, fixture-driven), **D12**
(matcher + writer + checker, catalogued), **D13**/**D16** (tiers), **D15**
(three-valued equivalence); `docs/PRIOR-ART.md` **§4.5** tier 1, **§5**, **§6**.

> **Ownership notice.** Do not edit `src/**`, `package.json`, `tests/**/*.test.ts`,
> `tools/**`, or `tests/fixtures/**`.

---

## 1. The shape of M5

M4 produces correct, ugly JavaScript for every gate fixture. M5 makes it
readable, **one construct at a time, with the equivalence suite as a ratchet that
never regresses** (D11):

```
pick the next tests/fixtures/constructs/<NN-topic>
  → read its disassembly, write the catalogue row (what idiom Hermes emits)
  → write src/passes/<name>/{match,rewrite,check}.ts
  → the fixture is the red→green test
  → the full gate corpus is the regression gate
  → a pass that improves readability but breaks any fixture is REJECTED
```

Order follows fixture numbering unless a dependency forces otherwise (§5). The
counter in `docs/STATUS.md` is `N/53 recovered`.

**The rejection rule is absolute.** There is no "improves 40 fixtures, breaks 1"
trade. A pass that fails its own `check` at a site is abandoned *for that site*
and the correct-but-ugly form survives; a pass that makes any fixture DIVERGENT
is not merged at all.

---

## 2. Framework contract (D12)

```ts
// src/passes/types.ts

/** Stage A operates on the structurer's tree IR (spec 04); stage B on the JS AST
 *  (spec 05). A pass belongs to exactly one stage. */
export type Stage = "A" | "B";

export interface PassContext {
  readonly analysis: ModuleAnalysis;      // spec 03: module, envGraph, kinds, cfg()
  readonly functionIndex: number;
  readonly cfg: FunctionCfg;
  readonly hbcVersion: number;
  readonly layoutClass: LayoutClass;
  /** Passes already applied to this function, in order. A pass may require or
   *  refuse to run after another; see §5. */
  readonly applied: readonly string[];
  readonly diagnostic: (d: Diagnostic) => void;
}

/** What a matcher captures. `nodes` are the IR/AST nodes the rewrite will
 *  replace; `data` is pass-private. Matches must be non-overlapping within a
 *  pass — the driver asserts it. */
export interface Match<TNode, TData = unknown> {
  readonly root: TNode;
  readonly nodes: readonly TNode[];
  readonly data: TData;
  /** Source provenance for the catalogue and for reports. */
  readonly at: { readonly functionIndex: number; readonly offset: number };
}

export interface CheckResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface Pass<TNode = unknown, TData = unknown> {
  readonly name: string;                  // kebab-case, matches the directory
  readonly stage: Stage;
  readonly targets: readonly string[];    // fixture names this pass exists for
  /** Pure. Recognises one Hermes lowering idiom. MUST NOT mutate. */
  match(node: TNode, ctx: PassContext): Match<TNode, TData> | null;
  /** Pure. Emits the idiomatic form for exactly the captured shape. */
  rewrite(m: Match<TNode, TData>, ctx: PassContext): TNode;
  /** Local guard. Asserts the rewritten subtree preserves control-flow entry and
   *  exit edges (stage A) or statement-list structure (stage B). */
  check(before: TNode, after: TNode, ctx: PassContext): CheckResult;
  /** Optional: passes that must have run first. Enforced by the registry. */
  readonly after?: readonly string[];
  /** Optional: passes that must NOT have run yet. */
  readonly before?: readonly string[];
}
```

### 2.1 The driver

```ts
export function applyPasses<TNode>(root: TNode, passes: readonly Pass<TNode>[], ctx: PassContext): {
  readonly result: TNode;
  readonly applied: readonly AppliedRecord[];
  readonly abandoned: readonly AbandonedRecord[];
};
```

Per pass, per function:

1. Walk the tree once, collecting matches (matchers are pure, so collection order
   does not affect them). **Assert matches are non-overlapping**; overlapping
   matches are a bug in the matcher, not a case to resolve by precedence.
2. For each match, innermost-first: compute `after = rewrite(m)`, then
   `check(before, after)`.
3. `ok` → splice `after` in. `!ok` → **abandon this site**, record
   `AbandonedRecord{pass, at, reason}`, leave the original subtree untouched,
   continue with the next match.
4. A pass never throws. An exception escaping `match`/`rewrite`/`check` is
   `E_PASS_CRASH` and fails the build — it means the pass is unsound, not that
   the input was odd.

Abandonment counts are reported (`--pass-stats`) and are the signal that a
matcher is too eager: a pass abandoning 30% of its sites is matching things it
should not.

### 2.2 What `check` actually checks

* **Stage A** — reuse spec 04's `checkIsomorphic`, restricted to the rewritten
  subtree: the set of (entry, exit) edges crossing the subtree boundary must be
  identical before and after, and no CFG block may be dropped or duplicated
  unless the pass declares it. This is the whole-function proof obligation
  (spec 04 §5) applied locally, which is why spec 04 owns the machinery.
* **Stage B** — the rewritten statement list has the same *effect sequence*:
  same number and order of side-effecting operations (calls, property
  writes, `throw`s), same terminators. Plus, cheaply, the emitted subtree still
  parses. A stage-B pass that reorders two calls is unsound even if the fixture
  passes.

`check` is a *local, cheap* guard. It is not a proof, and the equivalence suite
(spec 06) remains the real gate. Its job is to catch the pass firing on a shape
it did not expect, which is the common failure.

### 2.3 Registry

```ts
// src/passes/registry.ts
export const REGISTRY: readonly Pass[] = [ /* ordered; empty at M4 */ ];
export function enabledPasses(opts: { readonly only?: readonly string[];
                                      readonly skip?: readonly string[];
                                      readonly stage?: Stage }): readonly Pass[];
```

* **Order is explicit data**, not implied by import order or directory listing.
* The registry validates `after`/`before` constraints at load and throws
  `E_PASS_ORDER` on a cycle or a violated constraint. Do this at load, not at
  run: a mis-ordered ladder should fail the first test, not the 40th fixture.
* **Before validating, the registry auto-injects `after: ["expr-rebuild"]` into
  every stage-B pass except `expr-rebuild`** (§5 constraint 5). A prose-only
  rule would leave PL-07 with nothing to enforce for the ladder's single most
  load-bearing dependency.
* `--passes=none` reproduces the M4 baseline exactly. That is a required
  capability: every bug report starts with "does it reproduce with no passes?"

---

## 3. The catalogue (`docs/LOWERING-CATALOGUE.md`)

One row per idiom. The file is created empty (headers only) by spec 00; every
pass adds exactly one row **and** one detail section, in the same commit as the
pass (`CLAUDE.md`: change + tests + docs together).

### 3.1 Table format

```markdown
| # | Idiom | Construct | Versions | Pass | Stage | Fixture | Confirmed |
|---|---|---|---|---|---|---|---|
| 1 | `while(true){if(!c)break;B}` | `while (c) B` | 84,94,98,99 | `while-cond` | A | 02-while-loop | ✅ v94 |
```

* **Versions** — the HBC versions the idiom was *observed* at, not assumed.
* **Confirmed** — ✅ plus the versions whose disassembly was actually read, or
  ⛔ if the row is a hypothesis. **A pass may not be implemented against a ⛔
  row.**

### 3.2 Detail section format

Each row gets a section keyed by pass name containing, in this order:

1. **Source** — the JS in the fixture that produces it.
2. **Bytecode** — the actual `hermesc -dump-bytecode -pretty-disassemble=false`
   excerpt, verbatim, with the version and fixture named. Not paraphrased.
3. **CFG/IR shape** — what spec 03/04 produce for it.
4. **Matcher** — the shape `match()` looks for, and what it deliberately does
   *not* match.
5. **Writer** — the emitted form.
6. **Checker** — what `check()` asserts beyond the stage default.
7. **Version differences** — where v84/v94 and v98/v99 differ, which is common.

The verbatim bytecode is the point. A catalogue of prose descriptions is how a
project ends up with matchers that fire on shapes the compiler never emits.

---

## 4. Which idioms are known, and which must be measured first

**This is the most important section of this spec.** `docs/TASKS.md` **T3** is
exactly the job of reading `hermesc -dump-bytecode` for every construct fixture
at v94 and v99 and writing the catalogue. **Until a row's Confirmed column is
✅, its pass must not be written.**

What is genuinely established today, with a citation:

| Idiom | Evidence | Confidence |
|---|---|---|
| `switch` with a dense integer table → `SwitchImm` (v84/94) / `UIntSwitchImm` (v98/99), operands `Reg8, tableOffset, defaultTarget, min, max`, entries `int32` relative to the switch pc | `tests/fixtures/README.md` and this project's own measurement of `52-switch-jumptable`: `SwitchImm r0, 253, +223, 0, 12`, table at `align4(ip+253)`, 13 entries `207,191,191,161,…` | **high** |
| Sparse / small / string `switch` (v84, v94) → a `JStrictEqual`/`JStrictEqualLong` compare chain, **no** jump table | `tests/fixtures/README.md` §"Switch jump tables"; fixtures `09`/`10` produce zero `SwitchImm` | **high** |
| String `switch` at v99 → a real `StringSwitchImm` with `{stringId, target}` pairs | `tests/fixtures/README.md`, measured but **not shipped as a fixture** | high, **no fixture** |
| v≤96 generators → `StartGenerator` … `SaveGenerator L; Ret r` … `ResumeGenerator r, isReturn` … `CompleteGenerator` | `docs/PRIOR-ART.md` §6.2, and directly visible in `hermesc -dump-bytecode` of `hermes-dec-sample` at v94 | **high** |
| v≤96 async → generator + `GetBuiltinClosure` `spawnAsync` (#52 at v94, #57 at v99) then `Call4` | `docs/PRIOR-ART.md` §6.2, `docs/TOOLCHAIN.md` | medium |
| v≥97 generators → header `kind` + a compiler-lowered state machine (state slot, `JStrictEqual` dispatch chain, `NewObjectWithBuffer` `{value,done}`) | `docs/PRIOR-ART.md` §6.2, `docs/HBC-FORMAT.md` §3.2 | shape yes, **calling convention no** |
| `try`/`catch` → a handler-table range whose target begins with `Catch <reg>` | `docs/HBC-FORMAT.md` §4 | **high** |
| `finally` → **not represented**; the body is duplicated into the normal path and into a synthesised catch-and-rethrow handler | `docs/HBC-FORMAT.md` §4.3, `docs/PRIOR-ART.md` §6.3 | high, **shape unmeasured** |
| environments → `Create*Environment` / `Load|StoreToEnvironment` / `GetEnvironment` (v≤96) and the explicit-env family (v≥97) | `docs/PRIOR-ART.md` §6.1 | **high** |
| `CreateRegExp dst, patternStrId, flagsStrId, tableIdx` | `docs/HBC-FORMAT.md` §8, seen in the v94 dump | **high** |
| `for…in` → `GetPNameList dst, obj, idx, size` then `GetNextPName name, list, obj, idx, size` | **measured** at v94 and v99 on `05-for-in-object`: `GetPNameList 6,5,4,3` / `GetNextPName 1,6,5,4,3` — same family at both eras | **high** |
| `for…of` → `IteratorBegin it, obj` / `IteratorNext val, it, obj` / `IteratorClose it, ignoreInnerException<UInt8>` | **measured** at v94 and v99 on `06-for-of-array`; note `IteratorClose` appears **twice** (flag `0` on the normal path, `1` on the abrupt/`try` path) | **high** |
| `new X(…)` → `CreateThis`(v84/94/96) or `CreateThisForNew`(v98/99) + `Construct` + `SelectObject` | **measured** at v94/v96/v99 on `13-try-finally-no-catch`; 12/53 fixtures contain it — see spec 05 §7.5 | **high** |
| the generator two-hop: creation site → trampoline → `CreateGenerator` → body, at **both** eras | **measured** at v94 and v99 on `23-generator-basic` — see spec 03 §3.4.1 | **high** |
| v≤96 suspend shape: `SaveGenerator L; Ret r` with `L` = the instruction after the `Ret`, and resume blocks with **zero** static predecessors | **measured** on `23-generator-basic` v94: suspends at 11/25/39/57 → resumes at 15/29/43/61 — see spec 03 §4.5 | **high** |

**Must be measured before any pass is written (all ⛔ today):**

`while`/`do-while`/`for` block shapes · labelled break/continue · template
literals · tagged templates · destructuring (array and object) · spread and rest
· default parameters · optional chaining and `??` ·
`typeof`/`instanceof`/`in` · classes, `super`, static members, private fields,
getters/setters (v98/v99 only) · `arguments` reification · the duplicated-
`finally` block shape.

Two items that were on this list have since been resolved and moved up:
`for…in`/`for…of` (one `hermesc` command each, run for this revision) and the
**v≥97 generator calling convention** — spec 05 §7.2.1 now settles it as a
consequence of the two-hop finding: the shim goes on `CreateGenerator` at both
eras, and the v≤96 body's contract with the shim is fully specified by spec 03
§4.5's resume dispatcher. What is still genuinely unknown at v≥97 is the
*internal* state-machine encoding, which only Strategy B (`yield` recovery)
needs — not the M4 shim.

That is still a lot of the corpus, and it is not a gap in the research — it is
precisely what T3 exists to produce (and T3 is now claimed, per
`docs/TASKS.md`). The honest statement of status is: **we know the format cold
and the lowering only in patches.** Note also `docs/lowering/` exists but is
empty and `docs/LOWERING-CATALOGUE.md` has not landed yet, so every row above
lives in this spec until T3 moves it.

---

## 5. Ordering constraints

From spec 04 §6, restated as registry constraints:

1. Stage A entirely before stage B. No pass in both.
2. `yield-recovery` (v≤96) is **first in stage A**: it removes
   `SaveGenerator`/`ResumeGenerator` pseudo-control-flow, and every later stage-A
   pass assumes ordinary control flow. (`before: ["*"]` within stage A.)
3. `finally-dedup` runs **before** loop recovery — de-duplication changes block
   counts, which loop recovery keys on.
4. `switch-raise` runs **after** loop recovery — a flattened or compare-chain
   dispatcher looks like a loop containing a switch, and raising the switch first
   hides the loop.
5. `expr-rebuild` is **first in stage B** and everything else in stage B depends
   on it: with `let r0…rN` and one statement per instruction, no syntactic
   matcher can see anything. **This is enforced mechanically, not by prose:**
   `registry.ts` auto-injects `after: ["expr-rebuild"]` into every stage-B pass
   except `expr-rebuild` itself, at load, before running the `after`/`before`
   validation. Otherwise PL-07 has nothing to check for the one dependency that
   matters most, and a future stage-B pass registered without the declaration
   would silently run against unrebuilt `r0…rN` code. §7's per-pass checklist
   also lists the declaration, so it is visible as well as enforced.
6. Any other pair whose order matters declares `after`/`before` **and** says so
   in its catalogue row. An undeclared ordering dependency is a bug.

---

## 6. The first ten passes

In fixture order, **except** where a dependency forces otherwise (D11 permits
this explicitly). Each row: what it recognises, what it emits, and whether it is
blocked on T3.

> **This table is implementation/session order, not registry or runtime order.**
> Runtime order is fixed by stage (all of stage A before all of stage B, §5
> constraint 1) and by each pass's declared `after`/`before`. Rows 1 and 2 are
> both stage B and therefore run **last** at runtime despite being built first.

| # | Pass | Stage | Fixtures | Recognises | Emits | Blocked on T3? |
|---|---|---|---|---|---|---|
| 1 | `expr-rebuild` | B | all | register def-use chains with a single use in the same block | inlined expressions; `let` only for values live across a block boundary | **no** — this is SSA + copy propagation over our own IR (`docs/PRIOR-ART.md` §5, Braun et al.), not a Hermes idiom |
| 2 | `call-shape` | B | all | `Reflect.apply(c, o, [...])` where `c` came from a `GetById` on `o` | `o.m(a, b)`; `new C(a)` for constructs | **no** — spec 05 §7.4 already defines the rule; this generalises the residue |
| 3 | `if-else-chain` | A | 01 | nested `if`/`else` where the `else` is a single `if`; `if (c) { return x } else { … }` | `else if` chains; early-return flattening | **partly** — the *shape* is generic, but confirm 01's disassembly for the comparison-direction flip terser/Hermes performs |
| 4 | `while-cond` | A | 02 | `loop(L, seq(block B, if(cond, break L, body)))` where `B` has no side effects | `while (!cond) { body }` | **yes** — must confirm the header block is genuinely side-effect-free at v94 and v99 |
| 5 | `do-while` | A | 03 | `loop(L, seq(body, if(cond, continue L, break L)))` | `do { body } while (cond)` | **yes** |
| 6 | `for-header` | A | 04, 11 | a `while(c)` (post-pass 4) whose init immediately precedes it and whose update is the last statement of the body, with the update variable not otherwise live out | `for (init; c; update)` | **yes** — the liveness condition is the whole pass and it needs real bytecode |
| 7 | `for-in` | A | 05 | `GetPNameList dst,obj,idx,size` + the loop whose body starts `GetNextPName name,list,obj,idx,size` | `for (const k in o)` | **no — confirmed** at v94 and v99 (§4); only the surrounding loop shape depends on pass 4 |
| 8 | `for-of` | A | 06, 07 | `IteratorBegin` + `IteratorNext` loop + the **two** `IteratorClose` sites (flag `0` normal, `1` abrupt/`try`) | `for (const v of it)` | **no — confirmed** at v94 and v99 (§4); the abrupt-exit `IteratorClose` inside a handler is the part to get right |
| 9 | `label-clean` | A | 08, 11 | labels with no `break`/`continue` referring to them (spec 04 ST-06); labels whose only use is an immediate `break` | drops or inlines them | **no** — pure IR hygiene |
| 10 | `switch-raise` | A | 09, 10, 52, 53 | (a) an IR `switch` with a jump-table scrutinee; (b) a `JStrictEqual` compare chain on one register against constants | a JS `switch` with real fall-through, `default` placed correctly | **partly** — (a) is confirmed and measured; (b) needs the compare-chain shape from `09`/`10` at each version |

**Next after these**, in rough order: `finally-dedup` (12–16, **T3-blocked** —
the duplicated-block shape is unmeasured), `yield-recovery` for v≤96 (23–26,
**unblocked**: spec 03 §4.5 and spec 05 §7.2.1 fully specify the baseline shape,
so the pass collapses `__state = k; return v;` plus resume-case *k* of the
dispatcher back into `r = yield v` and emits a real `function*`), `async-await`
(27–29, partly measured — the `spawnAsync` builtin wrapper), `template-literal`
(43, 44), `destructure` (37–39), `spread-rest` (40–42), `class-recover` (32–36,
v98/v99 only), `optional-chain` (48), `regexp-literal` (45) — the last six all
T3-blocked.

**Note on pass 1's ordering.** `expr-rebuild` is number 1 despite `01-if-else-chain`
being the first fixture, because every stage-B matcher and every human reading
the output needs it. This is exactly the "unless a dependency forces otherwise"
clause of D11, and it should be recorded as such in the catalogue.

---

## 7. Per-pass workflow (what an implementer does)

1. **Read the bytecode.** `hermesc -dump-bytecode -pretty-disassemble=false
   source.js` at every version the fixture compiles at. Paste the excerpt into
   the catalogue section. If it disagrees with what this spec assumed, the spec
   is wrong — say so.
2. **Write the catalogue row and section** (§3), flipping Confirmed to ✅.
3. **Write `match.ts`.** Pure, narrow, and deliberately conservative: it is
   better to miss a site than to fire on the wrong one. State in the section what
   it refuses to match.
4. **Write `rewrite.ts`.** Emits only the captured shape.
5. **Write `check.ts`.** Beyond the stage default, assert whatever the rewrite
   assumed (e.g. `while-cond` asserts the header block had no side effects).
6. **Register it** in `registry.ts` with `after`/`before` constraints. For a
   stage-B pass, `after: ["expr-rebuild"]` is auto-injected (§5 constraint 5) —
   declare it anyway, so the dependency is visible in the pass's own source.
7. **Red→green on the fixture**, then **the full gate corpus must stay green** —
   including the `.min` control and, nightly, the `.obf` variants.
8. **Update `docs/STATUS.md`'s `N/53 recovered` counter.**

---

## 8. Invariants

| # | Invariant | Violation |
|---|---|---|
| PL-01 | `match` and `check` never mutate their inputs | frozen-input unit test |
| PL-02 | matches within one pass never overlap | driver assertion |
| PL-03 | a failed `check` abandons the site only; the function still emits | unit test |
| PL-04 | no pass throws; an escaping exception is `E_PASS_CRASH` | driver test |
| PL-05 | `--passes=none` reproduces the M4 golden output byte-for-byte | golden test |
| PL-06 | every registered pass has a catalogue row with Confirmed ✅ | CI check parsing `docs/LOWERING-CATALOGUE.md` |
| PL-07 | registry order satisfies all `after`/`before`; no cycles | load-time check |
| PL-08 | applying passes twice is idempotent (a second run rewrites nothing) | corpus test |
| PL-09 | for every gate fixture, verdict is PASS with passes on **and** off | the ratchet |
| PL-10 | pass application is deterministic; two runs give identical output | golden test |
| PL-11 | every stage-B pass other than `expr-rebuild` has an effective `after` containing it, whether declared or injected | load-time check + unit test |

PL-06 deserves emphasis: a CI job parses the catalogue, extracts pass names and
Confirmed marks, and fails if a registered pass has no ✅ row. That is the
mechanism that makes §4's "don't implement against a hypothesis" rule real
rather than advisory.

---

## 9. Test plan

1. **Per-pass unit tests.** Hand-built IR/AST fragments: one positive case, at
   least two negative cases (shapes the matcher must refuse), and one case where
   `check` fails and the site is abandoned.
2. **Per-pass fixture test.** The target fixture emits the expected idiom —
   asserted against the emission golden, which the pass's commit updates. The
   golden diff *is* the readability review.
3. **Corpus regression (the ratchet).** After every pass: the whole gate tier
   through spec 06 stays PASS. This is non-negotiable and is what D11 means by
   "the equivalence checker never regresses".
4. **Idempotence** (PL-08) over the whole corpus.
5. **`--passes=none` parity** (PL-05) over the whole corpus — the M4 baseline
   must remain reachable forever, because it is the fallback when a pass is
   suspected.
6. **Hardened tier, nightly.** All `.obf.hbc` (241 today, across five versions
   84/94/96/98/99) with passes on: still PASS.
   Obfuscated input is where an over-eager matcher will fire on something it
   should not — control-flow flattening produces loop+switch shapes that look
   exactly like the ones passes 4, 5 and 10 hunt for. Expect abandonment rates
   here to be high and *that is correct*; a pass with a 0% abandonment rate on
   flattened input is probably unsound.
7. **Ablation report.** `--pass-stats` over the corpus: per pass, sites matched,
   sites abandoned, fixtures improved. Committed as a table in
   `docs/LOWERING-CATALOGUE.md`'s appendix so the ladder's value is visible.

---

## 10. Acceptance criteria

**Framework (must all hold before pass 1 is merged):**

- [ ] `src/passes/{types,registry}.ts` implement §2 exactly, with an empty registry.
- [ ] `applyPasses` handles abandonment per §2.1 step 3 and never throws.
- [ ] Stage-A `check` reuses spec 04's `checkIsomorphic` on the rewritten subtree.
- [ ] `--passes=none` reproduces M4 goldens byte-for-byte (PL-05).
- [ ] Registry order validation fails loudly on a cycle (negative test).
- [ ] The stage-B `after: ["expr-rebuild"]` injection happens at load and is
      asserted by a test that registers a stage-B pass *without* the declaration
      and checks it still runs after `expr-rebuild` (PL-11).
- [ ] `docs/LOWERING-CATALOGUE.md` has the §3 headers and the §4 evidence table.
- [ ] The PL-06 CI check exists and fails on a registered pass with a ⛔ row.

**Per pass:**

- [ ] Catalogue row + detail section with **verbatim** disassembly, Confirmed ✅.
- [ ] `match`/`rewrite`/`check` in `src/passes/<name>/`, each pure.
- [ ] Unit tests: 1 positive, ≥ 2 negative, 1 abandonment.
- [ ] Target fixture's emission golden updated and reviewed.
- [ ] Whole gate tier still PASS under spec 06, passes on and off.
- [ ] `docs/STATUS.md` counter incremented.

---

## 11. Estimated complexity

| Component | Size | Model |
|---|---|---|
| `types.ts` + `registry.ts` + driver | ~350 lines | **Opus** (the abandonment and ordering semantics are the load-bearing bits) |
| `expr-rebuild` (pass 1) | ~500 lines — SSA construction + copy propagation + live-range → variable | **Opus**; this is the single biggest readability win and the hardest pass |
| `switch-raise` (pass 10) | ~250 lines | Sonnet |
| passes 2–9 | ~120–250 lines each | Sonnet, one per session |
| catalogue rows (T3 work) | reading, not coding | Sonnet |

D11's rhythm is one pass per session with the corpus as the gate, which suits a
Sonnet-sized unit of work well — *provided* the catalogue row exists first. The
two Opus items are the framework and `expr-rebuild`.

---

## 12. Open questions for the overseer

* **O-1 — T3 is still the critical path, but a smaller one than stated.** Six of
  the first ten passes are now unblocked or only partly blocked (§4 gained
  `for…in`, `for…of`, the `new` triple and both generator findings, all measured
  for this revision), and T3 is claimed per `docs/TASKS.md`. `docs/lowering/`
  exists but is empty and `docs/LOWERING-CATALOGUE.md` has not landed, so PL-06's
  CI check has nothing to parse yet. Should the catalogue be split per fixture
  family (loops / iteration / classes / generators) so several agents can work it
  in parallel, and should the remaining T3 scope run *during* M4?
* **O-2 — `expr-rebuild` before or inside M4?** It is listed as pass 1 here, but
  M4's output without it is genuinely hard to read, which will slow down every
  M4 debugging session. The counter-argument is D11: M4 is about correctness and
  a 500-line SSA pass inside it is scope creep. Keep it in M5 (my choice), or
  pull it forward?
* **O-3 — `StringSwitchImm` still has no fixture.** `switch-raise` covers it in
  principle, and `tests/fixtures/README.md` records the idiom was measured but
  deliberately not shipped as a fixture. Without one, that arm of the pass is
  untestable. One string-switch fixture at v99 closes it. Approve?
* **O-4 — abandonment-rate thresholds.** §9 item 6 argues a 0% abandonment rate
  on obfuscated input is suspicious. Should that be an actual CI assertion (e.g.
  "a pass must abandon at least one site across the hardened tier, or justify
  itself"), or just a reported metric?
* **O-5 — does the catalogue belong in the repo or in the spec tree?**
  `docs/LOWERING-CATALOGUE.md` is per D12, but it will grow to hundreds of lines
  of verbatim disassembly. Split per family (`docs/lowering/loops.md`, …) once it
  exceeds ~500 lines, or keep one file?

---

## 13. Review responses (`docs/specs/REVIEW-03-07.md`)

| Item | Verdict | Where |
|---|---|---|
| **S5** `for…in`/`for…of` listed as unverified "hard blocks" when one `hermesc` command each confirms them | **Fixed** | Re-measured independently for this revision at v94 **and** v99 and moved into §4's confirmed table with the operand shapes (`GetPNameList dst,obj,idx,size` / `GetNextPName name,list,obj,idx,size`; `IteratorBegin` / `IteratorNext` / `IteratorClose it,flag` — noting `IteratorClose` appears twice, flag `0` normal and `1` abrupt). Passes 7 and 8 flip to "no — confirmed". §4's remaining-scope paragraph is narrowed accordingly |
| **N1** the "first ten passes" table reads as runtime order but is not | **Fixed** | A blockquote caption above the table saying it is implementation/session order, that runtime order is fixed by stage and by `after`/`before`, and that rows 1–2 (both stage B) therefore run **last** — covering pass 2 as well as pass 1 |
| **N2** §5 constraint 5's stage-B dependency on `expr-rebuild` is prose the registry cannot validate | **Fixed** | Made mechanical: §2.3 and §5 now require `registry.ts` to **auto-inject** `after: ["expr-rebuild"]` into every stage-B pass except `expr-rebuild` itself, at load, before validation; new invariant **PL-11**; §7's checklist still asks for the explicit declaration so it is visible in the pass's own source; a negative test registers a stage-B pass without it and asserts the injection |
| **N2's positive finding** (no cycle in the declared ordering constraints) | Acknowledged, unchanged | §5's chain stands |
| B1, B2, S1–S4, S6, N3 | Not this spec's | Consumed as inputs — see below |

**Consumed from the other specs' fixes.** §4's evidence table gained four more
confirmed rows this round, all measured for this revision: the `new` triple
(spec 05 §7.5, 12/53 fixtures), the generator two-hop at both eras (spec 03
§3.4.1), the v≤96 suspend/resume shape with its zero-predecessor resume blocks
(spec 03 §4.5), and — as a consequence of those two — the v≥97 **shim** calling
convention, which spec 05 §7.2.1 now settles. That last one was previously listed
as a hard T3 blocker for M4; only Strategy B (`yield` recovery at v≥97) still
needs the state machine's internal encoding. `yield-recovery` for v≤96 moves from
T3-blocked to unblocked for the same reason.

**Still true and worth repeating:** `docs/lowering/` is empty and
`docs/LOWERING-CATALOGUE.md` does not exist yet, so **PL-06's CI check has
nothing to parse and no pass may be implemented until T3 lands its first rows.**
