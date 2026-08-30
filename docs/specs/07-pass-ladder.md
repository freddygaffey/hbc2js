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

**Must be measured before any pass is written (all ⛔ today):**

`while`/`do-while`/`for` block shapes · `for…in` (which opcodes: a
`GetPNameList`/`GetNextPName`-style family is expected but has **not** been
verified in this repo) · `for…of` (an `Iterator*` family, likewise unverified) ·
labelled break/continue · template literals · tagged templates · destructuring
(array and object) · spread and rest · default parameters · optional chaining and
`??` · `typeof`/`instanceof`/`in` · classes, `super`, static members, private
fields, getters/setters (v98/v99 only) · `arguments` reification · the v≥97
generator body's **calling convention** (spec 05 O-1) · the duplicated-`finally`
block shape.

That is most of the corpus, and it is not a gap in the research — it is precisely
what T3 exists to produce. The honest statement of status is: **we know the
format cold and the lowering hardly at all.**

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
   matcher can see anything.
6. Any other pair whose order matters declares `after`/`before` **and** says so
   in its catalogue row. An undeclared ordering dependency is a bug.

---

## 6. The first ten passes

In fixture order, **except** where a dependency forces otherwise (D11 permits
this explicitly). Each row: what it recognises, what it emits, and whether it is
blocked on T3.

| # | Pass | Stage | Fixtures | Recognises | Emits | Blocked on T3? |
|---|---|---|---|---|---|---|
| 1 | `expr-rebuild` | B | all | register def-use chains with a single use in the same block | inlined expressions; `let` only for values live across a block boundary | **no** — this is SSA + copy propagation over our own IR (`docs/PRIOR-ART.md` §5, Braun et al.), not a Hermes idiom |
| 2 | `call-shape` | B | all | `Reflect.apply(c, o, [...])` where `c` came from a `GetById` on `o` | `o.m(a, b)`; `new C(a)` for constructs | **no** — spec 05 §7.4 already defines the rule; this generalises the residue |
| 3 | `if-else-chain` | A | 01 | nested `if`/`else` where the `else` is a single `if`; `if (c) { return x } else { … }` | `else if` chains; early-return flattening | **partly** — the *shape* is generic, but confirm 01's disassembly for the comparison-direction flip terser/Hermes performs |
| 4 | `while-cond` | A | 02 | `loop(L, seq(block B, if(cond, break L, body)))` where `B` has no side effects | `while (!cond) { body }` | **yes** — must confirm the header block is genuinely side-effect-free at v94 and v99 |
| 5 | `do-while` | A | 03 | `loop(L, seq(body, if(cond, continue L, break L)))` | `do { body } while (cond)` | **yes** |
| 6 | `for-header` | A | 04, 11 | a `while(c)` (post-pass 4) whose init immediately precedes it and whose update is the last statement of the body, with the update variable not otherwise live out | `for (init; c; update)` | **yes** — the liveness condition is the whole pass and it needs real bytecode |
| 7 | `for-in` | A | 05 | the `for…in` opcode family | `for (const k in o)` | **yes, hard block** — the opcode family has not been verified in this repo at all |
| 8 | `for-of` | A | 06, 07 | the iterator opcode family (`Iterator*`), including the `try`-wrapped `IteratorClose` on abrupt exit | `for (const v of it)` | **yes, hard block** — same |
| 9 | `label-clean` | A | 08, 11 | labels with no `break`/`continue` referring to them (spec 04 ST-06); labels whose only use is an immediate `break` | drops or inlines them | **no** — pure IR hygiene |
| 10 | `switch-raise` | A | 09, 10, 52, 53 | (a) an IR `switch` with a jump-table scrutinee; (b) a `JStrictEqual` compare chain on one register against constants | a JS `switch` with real fall-through, `default` placed correctly | **partly** — (a) is confirmed and measured; (b) needs the compare-chain shape from `09`/`10` at each version |

**Next after these**, in rough order and all T3-blocked: `finally-dedup` (12–16),
`yield-recovery` for v≤96 (23–26), `async-await` (27–29), `template-literal`
(43, 44), `destructure` (37–39), `spread-rest` (40–42), `class-recover` (32–36,
v98/v99 only), `optional-chain` (48), `regexp-literal` (45).

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
6. **Register it** in `registry.ts` with `after`/`before` constraints.
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
6. **Hardened tier, nightly.** All 194 `.obf.hbc` with passes on: still PASS.
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

* **O-1 — T3 is the critical path for all of M5.** Ten of the first ten passes
  are wholly or partly blocked on it, and it is currently unclaimed on the task
  board. Should T3 be split per fixture family (loops / iteration / classes /
  generators) so several agents can work it in parallel, and should it run
  *during* M4 rather than after?
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
