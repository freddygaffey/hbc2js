# 19 — `reg-split` (stage B, catalogue row **R8**)

Reading list: `docs/AGENT-BRIEF.md`, `src/passes/README.md`, this file. Read
`docs/specs/passes/07-var-naming.md` §2 (baseline shape) and §6 (the reuse
hazard) for the problem this rung solves; you do not need any other spec.

Status: **specced 2026-09-02** (Fable design task; unparks `docs/PUSHBACK.md`
P-6). Fred approved the direction 2026-09-02 ("src contents readability is the
goal"). Not yet implemented.

## 1. Purpose

Hermes reuses one register for many semantically unrelated values inside a
function. In `04-for-loop-basic/v94` (all rungs before naming applied), `r0`
holds a loop bound, a `join` result, a call result, the constant `0`, a
do-while accumulator, and the string `"total="` — six unrelated jobs, one
name. `var-naming`'s §4.1 reuse gate therefore (correctly) refuses it, and
almost every other multi-def register too: measured coverage is **3.1 %** of
surviving register variables named (spec 07 §8, 2026-08-31). The gate is not
the bug; the shared name is.

`reg-split` runs immediately before `var-naming` and splits each register's
**disjoint live ranges** into separate variables:

```js
// before                                   // after reg-split
r11 = print;                                r11_2 = print;
r0 = r15.join(" | ");                       r0_2 = r15.join(" | ");
r0 = r11(r0);                               r0_3 = r11_2(r0_2);
r0 = 0;                                     r0_4 = 0;
do { …; r0 = r11; } while (…);              do { …; r0_4 = r11_3; } while (…);
```

Each split variable now has exactly one def (or one coherent def-web, e.g. a
loop counter's init+update), so `var-naming`'s single-def/single-role gate
passes and each range can be named independently. This is standard decompiler
live-range splitting ("webs", Muchnick ch. 16; unluac's SSA-lite —
`docs/PRIOR-ART.md` §"live-range → variable"). It is a **pure renaming**: no
statement moves, no expression changes shape, no value is computed
differently. A register that is genuinely one range is untouched (no-op).

## 2. Baseline shape (what the rung reads)

Identical to spec 07 §2: the emitter declares a function's registers in one
leading `{k:"decl", kind:"let", names:["r0",…]}` (`src/emit/function.ts`),
defs are `{k:"assign"}`/`{k:"init"}` statements with an `ident rN` target —
plus, after the sugar rungs, `(rN = e)` assignment *expressions* nested inside
larger expressions (default-params' `(r = e)`, optional-chain's guards) — and
reads are `{k:"ident", name:"rN"}`. Nested `{k:"func"}` bodies are separate
frames that restart at `r0` (AGENT-BRIEF); a register name never crosses a
frame boundary (`identUses.nested` is always 0 for a register).

Stage B has no CFG. Control flow is the structured statement tree:
`if`/`while`/`do-while`/`for`/`labeled`/`break`/`continue`/`return`/`throw`/
`try` (catch only — finally was dissolved at stage A by `finally-dedup`)/
`switch` (`src/emit/ast.ts` `Stmt`). The analysis in §4 is defined over that
tree, not over basic blocks.

## 3. AST shape the rung owns (ladder §3.2)

May match/rewrite: the `name` of an `{k:"ident"}` that is a register
(`isRegisterName`) — read, `assign` target, `init` name, or an entry of the
leading `decl.names`. Must not touch: statement order, expression shape,
non-register names, env slots (`_eN_M`), params (`aN`), `__pc`/`__exc`,
function names, and — same rule as var-naming §5 — **no occurrence inside a
nested `func` body** (a different frame). Pure alpha-renaming, nothing else.

### 3.1 The split-name scheme, and one framework line (F15)

A register `rN` with `k ≥ 2` live ranges becomes `rN` (first range, in
first-occurrence order), `rN_2`, `rN_3`, … `rN_k`. Keeping the original
number preserves provenance (a reader — and a debugging agent diffing against
`--no-pass reg-split` — can see `r0_3` was `r0`), and the first range keeping
plain `rN` makes the pass a strict no-op on unsplit registers.

Downstream machinery must keep treating split names as registers:
`var-naming` matches candidates by `isRegisterName`; `defUse`/`registerUses`/
`identUsesMany`/`effectSequence` treat register names as frame-local scratch
slots; the F10 finaliser drops dead `decl` entries by the same test. So this
rung ships one framework change (**F15**, next free F-number at
implementation time): `src/passes/ast.ts`'s `REG_RE` becomes
`/^r\d+(?:_\d+)?$/`. That is the entire framework diff. Two knock-ons, both
in existing pass-local constants, updated in the same commit:

* var-naming §4.3's emitter-name-class regex gains the same suffix
  (`r\d+(_\d+)?`) so a heuristic base can never manufacture a split-shaped
  name;
* fn-naming/global-access copies of that name-class regex, if any, likewise
  (grep for `r\\d`).

The emitter itself never generates a suffixed name, so there is no ambiguity
about origin: a suffixed register in the tree was made by this rung.

## 4. Matcher — live-range (web) analysis over one frame

**The site is the function-body root list only**: `match` returns `null`
unless `list === ctx.fnBody`. A register is function-scoped, so a per-sublist
site cannot see every def/use; the whole frame is analysed at once. As with
var-naming/fn-naming (P-1 batched convention, spec 05 §4), one `match`
returns **every** split for the frame:
`{ splits: [{ reg:"r0", webs: [[occ…],[occ…],…] }, …] }`, where an *occ* is an
occurrence handle (statement pre-order index + a path to the exact `ident`/
target/`decl` entry, the same indexing `defUse` uses). Registers with exactly
one web are omitted; if no register has ≥ 2 webs, `match` returns `null`
(the common single-range case is a true no-op).

### 4.1 Definitions

* **Occurrence** — one appearance of `rN` in this frame: a *def* (assign/init
  target, including a nested `(rN = e)` assignment expression) or a *use*
  (any other `ident rN`). The leading `decl` entry is not an occurrence; it
  is modelled as the **virtual def `d0`** (the implicit `undefined` a `let`
  slot holds at function entry).
* **Web (live range)** — an equivalence class of occurrences under the
  reflexive-transitive-symmetric closure of "def *d* reaches use *u*": every
  use is grouped with every def that may reach it, and two defs that both
  reach one use are thereby grouped together (a φ-like merge is one web).
  This is exactly the classical du-chain web; splitting webs apart can never
  change which def a use reads from, because no use is separated from any
  def that could reach it.
* **Range boundary** — a def *d* of `rN` at a program point where no read of
  the *previous* value of `rN` is still possible: no use reachable from *d*'s
  point can see a def from the earlier web (equivalently: *d* starts a new
  web). A def that *is* reached-around by a live value — a loop-carried
  counter whose init and update both reach the test read, a value merged at
  an `if` join — is **not** a boundary; it stays inside the existing web.

### 4.2 The analysis: forward reaching-defs over the structured tree

Compute webs with a forward abstract interpretation. State = per register, the
set of def-occurrences that may currently be "the last write". One union-find
over occurrences accumulates the webs.

Walk each statement list top to bottom. For every statement/expression,
process **reads before the write** of the same node (an `assign`'s value and
member-target subexpressions are evaluated before the store):

* **use `u`**: union `u` with every def in the current reaching set of its
  register. (Empty set cannot happen except via `d0`; a use reached by `d0`
  unions with `d0`.)
* **def `d` at statement level** (an `assign`/`init` statement, or the
  register terms of a `for`'s `init`/`update` expression): *strong kill* —
  the reaching set becomes `{d}`.
* **def `d` nested in a conditional expression context** (`cond` arm,
  `logical` right side, `optcall`/`optmember` continuation — anything not
  executed unconditionally when its statement runs): *weak update* — add `d`
  to the reaching set, do not kill. (default-params' `(r = e)` sits inside
  an already-rewritten expression; correctness over precision here.)

Control flow:

* **`if`**: process `then` and `else` from copies of the entry state; the
  exit state is the pointwise union of the two arm exits (a value live across
  the merge keeps one reaching set containing defs from both arms, so a use
  after the join unions both — **one web across a join**, per §4.1).
* **`while` / `do-while` / `for`**: fixpoint. Model the evaluation order
  (`for`: init → test → body → update → test → …; `while`: test first;
  `do-while`: body first). Entry-of-body state = union(state before loop,
  state at end of body/update); iterate until the union-find and the state
  stop changing (sets grow monotonically over a finite lattice; two or three
  iterations in practice). This makes a **loop-carried value one web**
  automatically: the update def flows around the back edge into the test/body
  reads, unioning with the init def. *The loop var is never split across
  iterations.*
* **`break L` / `continue L`**: union the current state into a pending join
  for the target (the labeled statement's exit, or the loop's header join),
  then the fall-through state becomes ⊥ (unreachable). `labeled` blocks: exit
  state = union(fall-through, all `break L` contributions).
* **`return` / `throw`**: state becomes ⊥.
* **`switch`**: discriminant reads first; arms processed in source order with
  fall-through (arm entry = union(dispatch state, previous arm's exit));
  `break` joins at the switch exit as above.
* **`try { B } catch (p) { H }`**: the exception edge can fire *between any
  two operations* of `B`, and mid-statement (a def's RHS may throw before the
  store). So: while walking `B`, accumulate a running union `anyB` of every
  state seen (the state at entry to `B` and after every step). `H` is
  processed with entry state `anyB` — every def before or inside the try
  reaches every use in the handler, and a def inside the try does **not**
  kill across the exception edge. The try statement's exit state =
  union(exit of `B`, exit of `H`). The catch binding `_excN` is not a
  register; ignore it.
* **`func` (statement or expression)**: do not descend — different frame.
  (`comment`/`directive`/`raw`: no occurrences. Any future `Stmt` kind not
  listed: conservative fallback — treat every contained def as a weak update
  and union all contained occurrences of one register into one web.)

After the walk, each register's webs are its union-find classes. Order a
register's webs by their earliest occurrence (pre-order index; `d0`'s web,
if any use is reached only by the decl, is ordered by its first *use*).
A def-only web (a dead store) is still its own web — split it too; giving a
dead store its own name is honest, and expr-rebuild/F10 debt, not ours.

### 4.3 What is deliberately *not* split

* Single-web registers — no-op, invisible in the diff.
* Loop-carried counters/accumulators — one web by construction (§4.2), so
  `for (r1 = 0; r1 < r7; r1 = …)` keeps exactly one variable across
  init/test/update/body, which is what var-naming's #1 heuristic needs.
* Registers occurring anywhere inside a `try` whose handler also uses them —
  the `anyB` rule unions the try-side and handler-side occurrences, which is
  the sound reading of the exception edge. (`__pc`/`__exc` are not registers
  and are never touched; `try-clean` owns them.)
* Anything under a conservative-fallback node (§4.2 last bullet).

## 5. Writer — frame-local rename, decl update

For each `{ reg, webs }` (webs in first-occurrence order): web 1 keeps `reg`;
web *j* ≥ 2 gets `reg + "_" + j` — unless that name is already taken
(`freeNames(ctx.fnBody) ∪ declaredNames(ctx.fnBody)`; practically impossible
since the emitter never makes suffixed names, but check and bump the suffix
past the collision). Rewrite every occurrence in each web to its web's name,
via the occurrence handles from `match` — **never** a whole-tree
name-replace, and never recursing into a nested `func` (var-naming §5's
`renameRegisterInFrame` discipline; the occurrence handles make this exact).

The leading `decl.names` entry for `reg` is replaced, in place, by the full
ordered list `[reg, reg_2, …, reg_k]`. Every web's variable is thereby
declared and starts as `undefined` — observationally identical to the single
slot it replaces: a use whose web contains `d0` read `undefined` before and
reads `undefined` (from its own fresh slot) after; a use in any other web is
reached only by its own defs, same as before. No other statement is added,
removed, or reordered; no expression changes.

Idempotence (PL-08) is structural: the writer's output has exactly one web
per variable by construction, so a second `match` finds no register with ≥ 2
webs and returns `null`. (F15 keeps suffixed names inside `isRegisterName`,
so they *are* re-analysed — and found single-web.)

## 6. Checker — sound, correctness-critical

A wrong split is a silent miscompile: `r0_3 = r11(r0_2)` where the read
should have seen web 3's value computes a different program. `check` is the
guard that earns the rewrite the right to land, and it must not share fate
with the matcher (a bug in §4.2's interpreter must not be blessed by
re-running §4.2). Obligations, all mandatory:

1. **Undo is byte-identical.** Map every register name in `after` through
   `strip(rX_j) = rX` (this frame only, stopping at nested `func`s; the
   `decl.names` list collapses back to its original entries, order
   preserved, duplicates removed). `printProgram` of the result must equal
   `printProgram(before)` exactly. This proves the rewrite was a pure
   renaming — nothing else changed.
2. **Occurrence bijection.** Walk both trees in lockstep (same shape by
   obligation 1): every occurrence position holds a register in `before` iff
   it holds one in `after`, and `strip(after-name) === before-name` at every
   position. Per original register, total reads+writes are preserved and
   `identUses(after, rN_j).nested === 0` for every split name — a nonzero
   `nested` means the rename leaked into another frame, the §3 bug.
3. **Reaching-def preservation — the soundness core.** `check` recomputes a
   *deliberately coarser* reaching relation **R** with its own small
   implementation in `check.ts` (no imports from `match.ts`; different
   algorithm by design), and asserts: for **every** pair (def *d*, use *u*)
   of the same original register with `R(d, u)`, the `after` tree gives *d*
   and *u* the **same** name. Because R over-approximates true
   reachability (R ⊇ may-reach), this implies no use was separated from any
   def that could reach it, and (transitively, since equality of names is
   transitive) no two defs reaching one use were separated either — the two
   failure modes the brief names. Under-splitting (two true webs sharing a
   name) is not checked: it is the status quo, safe by definition.

   **R, defined over `before`** (pre-order statement indices from `defUse`'s
   scheme; "spine" = the chain of statement lists from the frame root to the
   list holding an occurrence's statement):

   * **R-loop**: if any single loop statement contains both *d* and *u*
     (header expressions included) → `R(d, u)`. (No kill reasoning inside a
     loop at all — the back edge makes everything in the loop mutually
     reachable, coarsely.)
   * **R-catch**: if *d* is in a `try`'s block (or before the `try` at any
     depth) and *u* is in that `try`'s handler, with `d.idx < u.idx` →
     `R(d, u)`. (Kills inside the try body never count toward handler uses.)
   * **R-seq**: if `d.idx < u.idx` → `R(d, u)`, **unless** some def *k* of
     the same register "surely intercepts": `d.idx < k.idx ≤ u.idx`, *k* is
     a statement-level strong def (§4.2 — never a nested `(r = e)`), *k*'s
     spine is a **prefix of** *u*'s spine (so every structured path that
     reaches *u* runs through *k*'s list position first — true in this
     goto-free AST), every `try` containing *k* also contains *u* (else the
     exception edge bypasses the kill), and no loop contains *u* without
     containing *k* (else the back edge carries the old value around *k*
     — redundant with R-loop but stated for independence).
   * `d0` (the decl) participates as a def with index −1 and root spine.

   R is a dozen lines of index/spine arithmetic over the occurrence table —
   nothing like §4.2's fixpoint interpreter — which is the point: the two
   analyses only agree on a split when a simple, auditable argument and the
   precise one both hold. Every disagreement is a refusal (`W_PASS_ABANDONED`
   `coarse-reach-crosses-split`), never a landed split. R's cost is
   O(defs × uses) per register; registers have few occurrences each, and the
   pairs can be pruned to same-register pairs with `d.idx < u.idx` plus
   R-loop pairs.
4. **Name hygiene.** Every introduced name matches `/^r\d+_\d+$/` with the
   original number; is not in `freeNames(before) ∪ declaredNames(before)`;
   appears in the rewritten `decl.names`; and `strip` over `decl.names`
   reproduces the original list. `isSafeIdentifier` holds trivially but is
   asserted.
5. **Backstops** (not this rung's code, but part of the contract): the
   stage-B driver's whole-function `parses` + `checkBindings` (EM-01) run
   after the pass; the gate must stay **0-DIVERGENT with the pass on and
   off** (PL-09) and all 492 fixture verdicts stay PASS under the trace
   oracle; `--passes=none` byte-identical (PL-05). A checker this heavy is
   still cheap insurance next to what a miscompile costs.

**Known limit (shared-fate residue).** If §4.2 and R are *both* wrong about
the same edge (e.g. both mis-model a future `Stmt` kind), a bad split can
pass 3. The conservative-fallback rule (§4.2, unknown kinds → one web) and
the trace oracle bound this; it is the main open risk (§9).

## 7. Ordering

```
after:  ["expr-rebuild", "call-shape", "global-access", "fn-naming",
         "template-literal", "default-params", "destructure",
         "spread-rest", "optional-chain"]        // everything that deletes,
                                                 // folds or absorbs registers
before: ["var-naming"]                           // the consumer
```

* **After `expr-rebuild`**: it inlines single-def/single-use temporaries;
  reg-split works on what survives. Splitting first would waste analysis on
  registers about to vanish (and expr-rebuild's own liveness would then see
  suffixed names — harmless under F15, but pointless).
* **After the sugar rungs**: they match on register idioms (nearest-preceding
  definition resolution etc.) measured against unsuffixed output; run them on
  the shape they were specced on.
* **Before `var-naming`**: the whole purpose. Also before `closure-naming`
  and `jsx-recover` by transitivity when they land.
* **Loop rungs** (stage A `loop-cond`/`for-header`) ran long before; their
  product is the `for`/`while`/`do-while` Stmt kinds §4.2 keys on. The loop
  var is one web (§4.3), so `for (r1 = 0; r1 < r7; r1 = …)` headers are
  never torn apart and var-naming's induction heuristic still fires.
* **Follow-up, not v1** (§9 Q1): after splitting, some ranges become
  single-def/single-use (`r11_2 = print; r0_3 = r11_2(r0_2)`) — exactly what
  `expr-rebuild` inlines, but it already ran. A second `expr-rebuild`
  instance after reg-split needs registry support for registering one pass
  twice; that is a separate framework task, not this rung.

`optIn` is **not** set: output is runnable JS and the default pipeline runs
it, so the equivalence gate exercises every split.

## 8. Metrics and floors

Two layers; measure with `tools/passes-metrics.mjs` (add
`measureRegSplit`, mirror `measureVarNaming`'s harness):

1. **Pass-own (structural, the direct measure of splitting):** share of
   surviving register variables that are **single-def** (`defUse` defs ≤ 1,
   counting webs post-split), over `tests/fixtures/constructs/**` × 5
   versions × base/`.min`/`.obf`. Baseline: measure first (expected well
   under half). Target: **≥ 80 %** single-def after reg-split (the residue
   is loop-carried webs and try-merged webs, which are multi-def by design).
   Also report: total register variables before → after (the denominator
   grows — that is the pass working), and mean distinct variables per
   function (should rise).
2. **Downstream (the point of the exercise):** var-naming's registers-named
   % re-measured with reg-split on. Baselines (spec 07 §8, 2026-08-31):
   3.1 % full matrix, 3.4 % gate v94+v99 base subset, 4.1 % RN template
   bundle (rN tokens 204,381 → 199,307). Target: **≥ 15 %** on the gate
   subset; regression floor in
   `tests/gate/passes/reg-split-metrics.test.ts` at **8 %** (a hard
   doubling; if measurement lands below 8 %, that is a pushback on this
   spec, not a lowered floor). Report the bundle rN-token count and the
   named-% per version in `docs/STATUS.md`.

   Honesty note on the ceiling: splitting converts `reuse-conflict` refusals
   into per-range verdicts, but a range whose def is a bare literal
   (`r9_2 = 10`) or alias (`r9_3 = a1`) still hits var-naming's
   `no-heuristic` refusal **by design** (spec 07 §4.2 #7). The measured jump
   comes from ranges that are call results, arrays, loop vars and guards.
   Getting beyond that needs new var-naming heuristics (§9 Q4), not more
   splitting. Part of the implementation task is the histogram: of the
   post-split refusals, how many are `no-heuristic` (name-signal debt) vs
   `reuse-conflict` (splittable value still merged — should be ≈ 0).

## 9. Open questions / risks (for Fred and the implementer)

* **Q1 — second `expr-rebuild` run.** Recommended: registry support for a
  repeated pass instance (`expr-rebuild#2` after reg-split), separate
  framework task. Without it, split single-use aliases stay as one-line
  assignments. Decide before or after v1 lands; v1 does not depend on it.
  **Resolved 2026-09-02 (Q4 compound upgrade): skipped, and closed rather
  than deferred.** D23 (`docs/DECISIONS.md`) formalised the ordering this
  spec's own §7 already implied: every stage-B pass is either a
  structure-recovery rung (`expr-rebuild` among them — it rewrites tree
  *shape*) or a pure-renaming rung (`reg-split`, `var-naming`), and *all*
  structure-recovery rungs are registered before *all* renaming rungs, on
  the invariant that a renaming rung may assume the tree's shape is final. A
  second `expr-rebuild` instance placed after `reg-split` — itself a
  renaming rung ordered before `var-naming` in that same renaming block —
  would put a structure-recovery rewrite *after* a renaming rung has already
  run, which is exactly the ordering D23 forbids (it is the general form of
  the `jsx-recover`/P-11b bug D23 fixes: a structure matcher keyed on shape
  running downstream of a renaming rung sees a tree whose *identity*
  information, not just its names, D23 says renaming may have already
  touched). So Q1 is not merely undecided, it is precluded by the
  now-formalised stage invariant: no framework task should schedule
  `expr-rebuild#2` after `reg-split`. (A second `expr-rebuild` run *before*
  `reg-split` — i.e. two passes through the whole structure-recovery block —
  is a different, unasked question; nothing here rules it out, but it is out
  of scope for this task.) The naming heuristics (§9 Q4, this same upgrade)
  are therefore the whole deliverable for closing the registers-named gap;
  see `tests/gate/passes/var-naming-metrics.test.ts`'s header for the
  measured result.
* **Q2 — how much of the ~96 % unnamed is splittable reuse vs no-signal?**
  Unknown until measured. The §8 histogram answers it; if `no-heuristic`
  dominates post-split, the next task is var-naming heuristics (Q4), and
  this spec's 15 % target may be the realistic ceiling for reg-split alone.
* **Q3 — name scheme.** This spec picks `rN_j` + F15 (`REG_RE` extension)
  over renumbering into fresh `rN` (zero framework change but loses
  provenance). If Fred prefers zero framework surface, renumbering is a
  drop-in writer change; §4–§6 are unaffected.
* **Q4 — alias/literal naming.** A follow-up var-naming heuristic
  (`rX_2 = print` → callee-alias naming; `rX_3 = a1` → param-alias) would
  compound with this pass. Out of scope here.
* **Risk — checker shared fate** (§6 known limit). Mitigations specced:
  independent coarse R, conservative fallback for unknown node kinds,
  0-DIVERGENT gate on every fixture. Residual risk is real but bounded;
  any DIVERGENT with the pass on is an immediate `docs/BUGS.md` row and the
  pass ships `optIn` until fixed.
* **Risk — `.obf` variants.** Obfuscator state machines reuse registers
  pathologically; splitting is still sound (same analysis) but web counts
  explode (`r0_17`). Acceptable — honest names — but watch the metric and
  printProgram time on `.obf`; a per-register web cap is *not* specced (a
  cap that merges webs is always safe if ever needed).
* **v94 vs v99 shape**: none. The rung reads only the emitter's AST, which
  is version-uniform; allocators differ per version so *which* registers
  split differs, but matcher/writer/checker do not (same position as spec 07
  §9). No opcode is inspected.

## 10. Fixtures and tests

`targets: ["04-for-loop-basic", "02-while-loop", "11-nested-loops-mixed",
"14-nested-try-catch", "22-nested-closures-counters"]`, all five versions +
`.min`/`.obf`:

* `04-for-loop-basic` — the canonical case: `r0` (≥ 5 webs), `r11` (outer
  induction web + `print`-alias web + do-while web + inner induction web),
  `r1`, `r14`; **and** the negative: each `for` header's counter stays one
  variable across init/test/update/body.
* `02-while-loop` — loop-carried web through a `while` (test-first order).
* `11-nested-loops-mixed` — nested loop fixpoints, `break`/`continue` joins.
* `14-nested-try-catch` — the exception edge: a register defined in a try
  and read in its handler is one web (no split across the edge).
* `22-nested-closures-counters` — frame locality: outer-frame splits never
  rename inside a nested closure reusing the same register numbers.

Rung tests assert rung-owned properties only (CONSOLIDATION §B7 — no
exact-output assertions on shared fixtures): counts of distinct register
variables before/after, single-def share, regex checks on the diff (e.g.
`/\br0_2\b/` appears; `for \(r\d+ = 0` headers keep one name), and the
metrics floors of §8. Unit tests on hand-built lists
(`tests/gate/passes/synth.ts`):

* positive: straight-line reuse (2 webs); reuse around an `if` join (one web
  across the merge — *not* split); loop-carried counter (one web);
  conditional weak-def `(r = e)` (no strong kill);
* negative: single-web register (match returns null); register live into a
  catch handler (one web); nested-frame register untouched;
* checker refusals: a hand-forged split that violates R-loop (two names
  inside one loop) and one that violates R-catch — both refused with
  `coarse-reach-crosses-split`; an undo that is not byte-identical.

Red→green: the downstream proof is `var-naming` naming a register it
previously refused as `reuse-conflict` on `04-for-loop-basic` (e.g. the
`join`-result range or the inner induction var) — asserted structurally
(named-count rises), not by golden output.

## Acceptance checklist

- [ ] Catalogue row **R8** added to `docs/LOWERING-CATALOGUE.md` (readability
      rung — this spec is its evidence file, per `src/passes/README.md`).
- [ ] F15: `REG_RE = /^r\d+(?:_\d+)?$/` in `src/passes/ast.ts` + the two
      name-class regex knock-ons (§3.1), with tests.
- [ ] `src/passes/reg-split/{index,match,rewrite,check}.ts`; registry line
      between the sugar rungs and `var-naming`; `catalogue: ["R8"]`;
      `after`/`before` per §7.
- [ ] `match` batches all splits per frame; null unless `list === ctx.fnBody`;
      null on its own output (PL-08, structural).
- [ ] §4.2 analysis: joins, loop fixpoint (loop-carried = one web),
      break/continue/labeled joins, `anyB` try rule, weak defs, `func`
      non-descent, conservative fallback for unknown kinds.
- [ ] Writer: web 1 keeps `rN`; `rN_j` for the rest; occurrence-handle
      rewrite (frame-local, never whole-tree); `decl.names` expanded in
      place; nothing else changes.
- [ ] Checker: obligations 1–4 incl. the independent coarse relation R
      (no code shared with `match.ts`); refusal reason
      `coarse-reach-crosses-split` observable in diagnostics.
- [ ] Gate 0-DIVERGENT passes-on and passes-off; 492/492 fixture PASS;
      `--passes=none` byte-identical.
- [ ] Metrics per §8 (`measureRegSplit`; floor test at 8 % named on gate
      subset; single-def share ≥ 80 %); numbers + histogram in
      `docs/STATUS.md`; `docs/AGENT-LOG.md`; ladder row status flipped —
      same commit.

## Estimated complexity

**Medium-high** — the biggest analysis any stage-B rung carries.
~300–380 lines: the §4.2 interpreter is ~150 (state maps, union-find, the
per-kind walk), writer ~50 (occurrence-handle rename + decl), checker
~100–130 (undo/bijection are small; R and the pair sweep are the substance).
~250–300 lines of tests. The two design-pinned risks: the **try/exception
edge** (the `anyB` rule and R-catch — get these wrong and a handler reads
the wrong variable) and the **loop back edge** (fixpoint + R-loop — get
these wrong and a loop-carried value is torn). Both have dedicated negative
fixtures and checker refusal tests above. No CFG is needed; do not reach for
`src/cfg` (D12a forbids it) — the structured tree is sufficient and is the
IR this rung owns.
