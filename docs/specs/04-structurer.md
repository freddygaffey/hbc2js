# Spec 04 — Structurer: CFG → structured tree IR (M4, stage 2)

**Milestone:** M4 (baseline), second stage
**Status:** ready to implement
**Owner model:** **Opus** — this is the algorithmic core (D5)
**Prerequisites:** spec 03 (CFG)
**Consumers:** spec 05 (emitter), spec 07 (pass ladder)

Reference: `docs/DECISIONS.md` **D7** (Ramsey ICFP'22 supersedes the
`for(;;) switch(ip)` fallback of D6), **D11** (baseline first, ugly allowed),
**D12** (matcher/writer/checker passes); `docs/PRIOR-ART.md` **§4.2**, **§4.5**
(three-tier structurer with a provable floor), **§6.3** (`finally` is not in the
format).

> **Ownership notice.** Do not edit `src/**`, `package.json` or `tests/**/*.test.ts`
> — an implementer owns those for M1.

---

## 1. Scope and the one non-negotiable property

**In.** A total translation from `FunctionCfg` to a structured **tree IR**, plus
the machinery that proves the translation did not change the control-flow graph.

**Out.** Anything about expressions, registers, or JavaScript syntax (spec 05);
readability rewrites such as `while(c)`, `for`, real `switch` recovery, early
returns (spec 07 — they are *passes over this IR*, not part of the core).

> **The property that defines this component: totality.** The translation
> succeeds on every CFG — reducible or not, obfuscated or not — with no
> irreducibility test, no bail-out, and no `goto`. Every prior tool in
> `docs/PRIOR-ART.md` §2 fails somewhere; the reason we can promise not to is
> that Ramsey's algorithm is total by construction and we verify each result
> against the input graph (§5) rather than trusting it.

The `for(;;) switch(pc)` form of D6 survives only as a **tier-(−1) debug escape
hatch** behind `--dispatch-fallback`, for isolating a miscompiled region. It is
not on any normal path.

---

## 2. Tree IR

```ts
// src/structure/ir.ts
export type LabelId = number;                    // dense per function

export type Stmt =
  /** A straight-line run of one CFG block's instructions. The leaf of the tree. */
  | { readonly k: "block";    readonly cfgBlock: BlockId }
  | { readonly k: "seq";      readonly body: readonly Stmt[] }
  /** `label: { body }` — target of a forward multi-level break. */
  | { readonly k: "labeled";  readonly label: LabelId; readonly body: Stmt }
  /** `label: while (true) { body }` — every loop is infinite here; `while(c)`
   *  and `for` are pass-ladder rewrites (spec 07). */
  | { readonly k: "loop";     readonly label: LabelId; readonly body: Stmt }
  /** Two-way branch on the terminator of `cfgBlock`, which must be a `branch`. */
  | { readonly k: "if";       readonly cfgBlock: BlockId;
      readonly then: Stmt; readonly else: Stmt }
  /** `break label` (exits a `labeled` or a `loop`). */
  | { readonly k: "break";    readonly label: LabelId }
  /** `continue label` (re-enters a `loop`). */
  | { readonly k: "continue"; readonly label: LabelId }
  /** Terminal: the block's own `Ret` / `Throw` / `Unreachable`. */
  | { readonly k: "return";   readonly cfgBlock: BlockId }
  | { readonly k: "throw";    readonly cfgBlock: BlockId }
  | { readonly k: "unreachable" }
  /** Multi-way dispatch produced *only* by the irreducible path (§4.4) or by a
   *  jump-table terminator. `scrutinee` names where the value comes from. */
  | { readonly k: "switch";   readonly cfgBlock: BlockId;
      readonly scrutinee: Scrutinee;
      readonly cases: readonly SwitchArm[];
      readonly default: Stmt }
  /** Exception region. Carved by spec 03, wrapped here, never inferred. */
  | { readonly k: "try";      readonly region: number;   // index into cfg.regions
      readonly body: Stmt; readonly handler: Stmt;
      readonly catchRegister: number };

export type Scrutinee =
  | { readonly t: "jumptable"; readonly table: SwitchTable }  // from a real SwitchImm
  | { readonly t: "dispatch";  readonly variable: DispatchVar }; // §4.4 irreducible fix-up

export interface SwitchArm {
  readonly value: number;              // integer case value, or string id
  readonly isString: boolean;
  readonly body: Stmt;
}

/** A synthetic variable introduced only to resolve an irreducible region.
 *  The emitter renders it as `let __state<N>`. Its existence is reported. */
export interface DispatchVar { readonly id: number }

export interface StructuredFunction {
  readonly functionIndex: number;
  readonly root: Stmt;
  readonly labels: readonly LabelInfo[];
  readonly dispatchVars: readonly DispatchVar[];   // empty on reducible input
  /** Blocks duplicated to resolve irreducibility (§4.4), for reporting. */
  readonly duplicatedBlocks: readonly BlockId[];
  readonly diagnostics: readonly Diagnostic[];
  readonly stats: StructureStats;
}

export interface LabelInfo {
  readonly id: LabelId;
  readonly kind: "block" | "loop";
  readonly header: BlockId;            // the CFG block this label fronts
  readonly usedBy: readonly ("break" | "continue")[];
}

export interface StructureStats {
  readonly blocks: number;
  readonly duplicated: number;
  readonly dispatchVars: number;
  readonly maxNesting: number;
  readonly labels: number;
  /** blocks emitted / blocks in the CFG. 1.0 means no duplication. */
  readonly expansion: number;
}
```

**Design notes worth stating, because they are choices.**

* **Leaves reference CFG blocks, they do not copy instructions.** The IR is a
  *shape*; spec 05 walks it and reads instructions from the CFG. This makes the
  round-trip check (§5) trivial and keeps the IR small enough to snapshot.
* **Every loop is `while(true)`.** Ramsey's output shape has no condition on the
  loop itself. `while (c)` is a spec 07 rewrite with its own `check`. Do not
  fold it in here — the whole point of D11/D12 is that the ugly form is the
  provably-correct floor.
* **`try` is not produced by the translation.** It is wrapped around regions
  before/around it (§4.5). Ramsey's algorithm never sees an exception edge.

---

## 3. Public API

```ts
// src/structure/index.ts
export function structure(cfg: FunctionCfg, opts?: StructureOptions): StructuredFunction;

export interface StructureOptions {
  /** Irreducibility resolution. "duplicate" splits nodes (better output, can
   *  blow up); "dispatch" introduces a state variable (never blows up).
   *  Default "auto": duplicate while expansion <= maxExpansion, else dispatch. */
  readonly irreducible?: "auto" | "duplicate" | "dispatch";
  readonly maxExpansion?: number;                // default 2.0
  /** Debug escape hatch (D6 tier -1): emit the whole function as one dispatch
   *  loop over pc. Never on by default. */
  readonly dispatchFallback?: boolean;
  /** Run the §5 round-trip check inline and throw on failure. Default true. */
  readonly verify?: boolean;
}
```

---

## 4. The algorithm

Ramsey, *Beyond Relooper: recursive translation of unstructured control flow to
structured control flow*, ICFP 2022 (PACMPL 6, art. 90) — a single recursive
pass over the dominator tree with immutable data, ~200 lines. It reimplements
Peterson–Kasami–Tokura. We follow it directly; the notes below fix the
Hermes-specific details it does not cover.

### 4.1 Preliminaries (all from spec 03)

* The **normal** CFG only — `succs`/`preds`, never `exceptionSuccs`.
* `dom` (immediate dominators, children, `dominates`), `rpo`, `backEdges`.
* A block is a **loop header** iff it is the target of a back edge.
* A block is a **merge point** iff it has ≥ 2 normal predecessors and is not a
  loop header.

### 4.2 The recursion

```
doTree(node, context):
    kids = dom.children[node] sorted by RPO index, descending
    mergeKids   = kids that are merge points
    ordinaryKids = the rest
    inner = nodeWithin(node, mergeKids, context)
    -- mergeKids become nested `labeled` blocks so that any block dominated by
    -- `node` can `break` forward to them from arbitrary depth.

nodeWithin(node, [k, ...ks], context):
    labeled(labelFor(k), nodeWithin(node, ks, context ++ [BlockFollowedBy k]))
      followed by doTree(k, context)

nodeWithin(node, [], context):
    if node is a loop header:
        loop(labelFor(node), doBranch-body with context ++ [LoopHeadedBy node])
    else:
        seq(blockLeaf(node), translateTerminator(node, context))

translateTerminator(node, context):
    return/throw/unreachable -> the corresponding leaf
    jump t                   -> doBranch(node, t, context)
    branch                   -> if(node, doBranch(node, taken, ctx),
                                        doBranch(node, notTaken, ctx))
    switch                   -> switch(node, arms = doBranch per case, default)

doBranch(from, to, context):
    if (from, to) is a back edge          -> continue(labelOf(to))
    else if `to` is a merge point         -> break(labelOf(to))     -- forward exit
    else                                  -> doTree(to, context)    -- inline it
```

`context` is the immutable stack of enclosing constructs; `labelOf` searches it
from the innermost outward. Ramsey's paper proves that a target is always found
for a reducible graph — which is why §4.4 exists for the other case.

**Ordering constraint that must not be relaxed.** `mergeKids` are wrapped
*outermost-last*: a merge point later in RPO must be reachable by `break` from
inside the handling of an earlier one. Sorting `kids` by descending RPO index
before nesting is what guarantees that; get it backwards and you produce
`break`s to labels that are not in scope, which the §5 check will catch but
which is much easier to prevent than to debug.

### 4.3 Determinism

Every set iteration in the algorithm must be over a sorted sequence — dominator
children by RPO index, merge kids by RPO index, switch arms by case value.
Golden snapshots (§6) are byte-compared across platforms, so a `Set` iteration
order leaking into the output is a real bug.

### 4.4 Irreducible regions

An irreducible region is one entered at two or more blocks from outside. Two
sanctioned resolutions, both in the paper:

* **`duplicate`** — split the offending node so each entry gets its own copy.
  Output quality is better; worst case is exponential, which is why
  `maxExpansion` (default 2.0, measured as blocks emitted / blocks in the CFG)
  caps it. Record every duplicated block in `duplicatedBlocks`.
* **`dispatch`** — introduce a `DispatchVar`, front the region with a
  `switch (__state0)` whose arms are the entry blocks, and rewrite entering
  edges as `__state0 = k; continue L`. Never blows up. This is the same shape as
  D6's fallback but scoped to one region instead of the whole function.

`auto` (the default) tries `duplicate` and falls back to `dispatch` when the
expansion cap would be exceeded. **Both must be implemented**; a
`duplicate`-only structurer is not total in practice.

Report irreducibility: `dispatchVars.length > 0 || duplicatedBlocks.length > 0`
goes into `StructureStats` and into the CLI's `--stats`. Nobody has measured how
much irreducible flow real RN bundles contain; this is how we find out.

### 4.5 Exception regions

Regions come from spec 03 already carved, properly nested, and block-aligned.
They are **not** discovered here.

```
structureWithRegions(cfg):
    order regions outermost-first (spec 03 already sorts them)
    for each outermost region R:
        bodyTree    = structure(subgraph(R.bodyBlocks))
        handlerTree = structure(subgraph reachable from R.handlerBlock, minus enclosing regions)
        emit try{ bodyTree } catch(r){ handlerTree }
    the remainder of the function structures normally, with each region's
    whole extent standing in as a single opaque node
```

Two rules:

1. **A `break`/`continue` may not cross a `try` boundary in the IR.** JS allows
   `break label` out of a `try` (the `finally` semantics we do not have make it
   safe here), but permitting it makes the §5 check much harder and buys nothing
   for correctness. If the translation wants to produce such an edge, wrap the
   `try` in a `labeled` block and break to *that*.
2. **Nothing about `finally`.** The compiler duplicated the finally body into
   the normal path and into a synthesised catch-and-rethrow handler
   (`docs/PRIOR-ART.md` §6.3). The baseline emits both copies. That is correct
   and verbose. `finally` recovery is spec 07's `finally-dedup` pass, gated on
   the equivalence suite staying green.

### 4.6 Jump tables

A `switch` terminator (spec 03 §4.2) becomes an IR `switch` with
`scrutinee: {t: "jumptable"}` directly — the arms are the case targets, the
default is the default target. This is *not* the readable `switch` recovery pass:
fall-through runs are represented by arms whose bodies `break` to a shared
`labeled` block, exactly as the CFG says. Turning that into JS `switch` with real
fall-through is spec 07's `switch-raise` pass.

---

## 5. Proof obligations: the tree must round-trip to an isomorphic CFG

This is D12's `check` lifted to whole-function level, and it is the reason to
trust a 200-line algorithm on a 4200-function bundle.

```ts
// src/structure/verify.ts
export interface ReconstructedCfg {
  readonly blocks: readonly BlockId[];          // in emission order, with duplicates
  readonly edges: readonly (readonly [BlockId, BlockId])[];
}
export function reconstruct(fn: StructuredFunction, cfg: FunctionCfg): ReconstructedCfg;
export function checkIsomorphic(cfg: FunctionCfg, rec: ReconstructedCfg): CheckResult;

export type CheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string;
      readonly missingEdges: readonly (readonly [BlockId, BlockId])[];
      readonly extraEdges: readonly (readonly [BlockId, BlockId])[] };
```

`reconstruct` interprets the tree abstractly — walk it, resolve every `break`
/`continue` to the block that control actually reaches, and collect the induced
edge set. Then:

| Obligation | Statement |
|---|---|
| **P1 — edge preservation** | The reconstructed edge set, after collapsing duplicated blocks back to their originals, equals `cfg`'s normal edge set exactly. Missing *or* extra edges both fail. |
| **P2 — block coverage** | Every reachable CFG block appears at least once as a `block`/`return`/`throw` leaf. |
| **P3 — no duplicate side effects without duplication** | A block appears more than once **only** if it is in `duplicatedBlocks`. |
| **P4 — label scoping** | Every `break`/`continue` names a label that is in scope at that point, and `continue` names a `loop`. |
| **P5 — terminator fidelity** | For every block whose terminator is `branch`, the tree has an `if` on it; `switch` → a `switch` with the same arm set; `return`/`throw` → the matching leaf. |
| **P6 — region containment** | Every block of `region.bodyBlocks` occurs inside that region's `try.body` and nowhere else; handler blocks occur only in `try.handler`. |
| **P7 — termination** | The translation itself terminates: assert a step budget of `O(blocks × log blocks)` and fail with `E_TOO_COMPLEX` rather than hanging. |

P1 is the one that matters and it is cheap. **Run it inline for every function
by default** (`verify: true`); the cost is one extra tree walk. Turn it off only
for bulk sweeps where wall time matters, and never in the gate tier.

A failure is `E_STRUCTURE_UNSOUND` with the offending function index and the
missing/extra edge lists. It is a bug in the structurer, never a property of the
input — there is no input for which failing is acceptable.

---

## 6. Where the D12 pass pipeline plugs in

Two pass stages, and the catalogue (spec 07) records which stage each pass is in:

```
CFG ──structure()──► Tree IR ──[stage A: structural passes]──► Tree IR
                                                                 │
                                                        emit() (spec 05)
                                                                 ▼
                                                            JS AST ──[stage B: syntactic passes]──► JS AST ──► text
```

* **Stage A (this IR).** Passes that change control-flow *shape*:
  `while(true)+if-break` → `while(c)`; `for` header recovery; `switch-raise`;
  early-return flattening; `finally-dedup`; v≤96 `yield` recovery. Their `check`
  (D12) is `checkIsomorphic` restricted to the rewritten subtree — the rewrite
  must preserve entry/exit edges exactly. That is the same machinery as §5, which
  is why it lives here.
* **Stage B (JS AST, spec 05).** Passes that change *syntax* only: expression
  rebuilding from register chains, `obj.m(a)` call-shape recovery, literal
  inlining, template-literal recovery, name heuristics. Their `check` is
  structural equality of the surrounding statement list plus `node --check`.

**Ordering constraints (normative).**

1. Stage A always runs before stage B. No pass may be registered in both.
2. Within stage A: `finally-dedup` runs **before** `while`/`for` recovery
   (de-duplicating changes block counts, which loop recovery keys on), and
   `switch-raise` runs **after** loop recovery (a flattened dispatcher looks like
   a loop containing a switch, and raising the switch first hides the loop).
3. `yield` recovery (v≤96) runs **first** in stage A: it removes
   `SaveGenerator`/`ResumeGenerator` pseudo-control-flow, and every later pass
   assumes ordinary control flow.
4. Every pass is individually toggleable and the registry order is fixed data,
   not implicit. Two passes whose relative order matters must say so in the
   catalogue.
5. **A pass that fails its `check` is abandoned for that site**, leaving the
   correct-but-ugly form; it never aborts the function (D12).

---

## 7. Invariants

| # | Invariant | Violation |
|---|---|---|
| ST-01 | `structure()` returns for every input CFG (totality) | `E_INTERNAL` — no input may fail |
| ST-02 | P1–P7 of §5 hold | `E_STRUCTURE_UNSOUND` |
| ST-03 | output contains no `goto`-equivalent construct | by construction — the IR has none |
| ST-04 | `dispatchVars` is empty when the CFG is reducible and `irreducible !== "dispatch"` | diag `W_UNEXPECTED_DISPATCH` |
| ST-05 | `expansion <= maxExpansion` | falls back to `dispatch`, records `W_EXPANSION_CAP` |
| ST-06 | every `LabelInfo.usedBy` is non-empty | diag `W_UNUSED_LABEL` (an unused label is dead weight the emitter should drop, and usually means a mis-nesting) |
| ST-07 | no `break`/`continue` crosses a `try` boundary | `E_INTERNAL` (§4.5 rule 1) |
| ST-08 | iteration order is deterministic; two runs produce identical output | golden test |
| ST-09 | `maxNesting` ≤ 1000 | `E_TOO_COMPLEX` — beyond that the emitter's recursion is at risk |

---

## 8. Test plan

`tests/gate/structure/**`, `tests/sweep/structure/**`.

### T1 — Round-trip isomorphism, corpus-wide (the headline test)

For **every function of every gate binary** (201 files, ~1500 functions):
`structure()` then `checkIsomorphic()` must return `ok: true`. This single test
is worth more than every shape assertion combined, because it validates the
algorithm against inputs nobody hand-checked.

### T2 — Shape goldens

Snapshot a canonical rendering of the tree (an S-expression-ish text, one node
per line, labels normalised to `L0..Ln` in first-appearance order) to
`tests/golden/structure/<group>/<name>/vNN.txt`. Reviewable diffs when the
algorithm changes; also the artefact spec 07's passes will visibly improve.

### T3 — Targeted shapes

Assert the *un-raised* baseline shapes explicitly, so a later pass that changes
them is visible:

| Fixture | Expected baseline shape |
|---|---|
| `02-while-loop` | one `loop` whose body starts with an `if` that `break`s — **not** a `while(c)` |
| `03-do-while-loop` | one `loop` with the test at the end (`if` → `continue`) |
| `04-for-loop-basic` | `seq(init, loop(if-break, body, update))` |
| `08-labeled-break-continue` | ≥ 2 labels, at least one `break` to a non-innermost label |
| `11-nested-loops-mixed` | nesting depth ≥ 2, no duplicated blocks |
| `09/10-switch-*` | **no** IR `switch` — these lower to compare chains, so an `if`-tree is correct |
| `52-switch-jumptable` | one IR `switch`, 13 arms + default, arms 1 and 2 sharing a target via a `labeled` block |
| `53-switch-jumptable-large` | 40 arms, default reachable from the middle of the arm list |
| `12`–`16` (try family) | `try` nodes matching spec 03's region count; `13-try-finally-no-catch` shows the **duplicated** finally body in both the normal path and the handler — assert the duplication is present, since that is the correct baseline |
| `23`–`26` (generators, v94) | ordinary structure containing the `SaveGenerator` blocks; no `yield` |
| `23`–`26` (v99) | ordinary structure; the dispatch chain appears as an `if`-tree, and `shimRequired` is spec 03's business, not visible here |

### T4 — Irreducibility, synthetically

No fixture is known to be irreducible, so build the graphs directly against the
`FunctionCfg` interface: the classic two-entry loop, a three-entry irreducible
region, and a nested pair. Assert: `duplicate` mode succeeds with
`duplicatedBlocks.length > 0`; `dispatch` mode succeeds with one `DispatchVar`;
both pass P1–P7; `auto` picks `dispatch` when `maxExpansion` is set to 1.0.

### T5 — Obfuscated variants must still be total

All 194 `vNN.obf.hbc`: `structure()` + `checkIsomorphic()` succeed for every
function, inside a 5 s per-function budget. Assert **nothing about shape** —
control-flow flattening produces a dispatcher loop with 40–70 blocks per
function and the output will be ugly, which is fine. Record
`StructureStats` per function into a metrics snapshot: expansion factor,
dispatch vars, max nesting. If flattened input ever produces
`duplicatedBlocks.length` above a few percent of blocks, that is the signal to
default `irreducible` to `dispatch`.

### T6 — Determinism

Every gate function structured twice in one process, and once in a fresh
process, produces byte-identical golden text. Run the whole T2 corpus under
both macOS and Linux in CI.

### T7 — Sweep: real bundles

`bundles/rn-template-0.72/*.hbc`: every function structures and verifies.
Report the distribution of `expansion`, the count of functions needing a
`DispatchVar`, and total wall time. **This is the first real measurement of how
irreducible shipped React Native bytecode is** — record it in `docs/STATUS.md`.

---

## 9. Acceptance criteria

- [ ] `structure()` succeeds on every function of every gate binary — zero
      failures, zero `E_TOO_COMPLEX`.
- [ ] `checkIsomorphic()` returns `ok: true` for every one of them, with
      `verify: true` (the default).
- [ ] A deliberately broken translation (e.g. drop one `break`) makes T1 fail —
      verify the check has teeth, then revert.
- [ ] Output contains no construct that has no JS equivalent: every IR node maps
      to exactly one of `label:{}`, `while(true)`, `if`, `break L`, `continue L`,
      `switch`, `try/catch`, `return`, `throw`.
- [ ] `dispatchVars.length === 0` and `duplicatedBlocks.length === 0` for every
      gate fixture at every version (i.e. the whole construct corpus is
      reducible) — or, if not, the exceptions are listed in `docs/STATUS.md`
      with their fixture names.
- [ ] Both `duplicate` and `dispatch` irreducibility modes are implemented and
      exercised by T4.
- [ ] All 194 `.obf.hbc` binaries structure and verify inside budget.
- [ ] Golden tree snapshots are byte-stable across two runs and across
      macOS/Linux.
- [ ] `structure()` uses no recursion proportional to block count (an explicit
      stack or a depth guard); a synthetic 50 000-block function does not
      overflow.
- [ ] The pass-plug-in points of §6 exist as real extension points
      (`applyStagePasses(ir, registry)`), with an empty registry at M4.

---

## 10. Estimated complexity

**Opus.** This is the one component where the algorithm is genuinely subtle and
where a plausible-looking wrong answer is the default failure mode.

| Component | Size | Notes |
|---|---|---|
| `ir.ts` | ~120 lines | pure types |
| `structure.ts` (Ramsey core) | ~350 lines | the paper is ~200 lines of Haskell; add CFG plumbing and determinism |
| `irreducible.ts` (duplicate + dispatch) | ~250 lines | both modes, expansion accounting |
| `regions.ts` (try wrapping) | ~180 lines | interaction with labels is the tricky part |
| `verify.ts` (P1–P7) | ~300 lines | write this **before** the core, and develop against it |
| tests T1–T7 | ~800 lines | mostly corpus-driven |

**Sequence: write `verify.ts` first.** Then the core, then irreducibility, then
regions. Developing the translation against a working isomorphism checker turns
a subtle algorithm into a tight red/green loop, and it means T1 is passing from
the first day rather than being retrofitted.

Read the paper. It is a functional pearl, it is short, and the recursion in §4.2
is a paraphrase, not a substitute.

---

## 11. Open questions for the overseer

* **O-1 — default irreducibility mode.** I set `auto` (duplicate up to 2×, then
  dispatch). If real bundles turn out to be materially irreducible, `dispatch`
  everywhere is safer and uglier. T7 will tell us; do you want the default
  switched on evidence, or pinned now?
* **O-2 — should `verify` ever be off?** I default it on everywhere, which costs
  one extra tree walk per function (~10–15% of structuring time). For a 4200-
  function bundle in a sweep that is seconds, not minutes. My inclination is
  "always on, no flag". Objection?
* **O-3 — `finally` detection.** Spec 03 O-3 asks whether detection belongs in
  the CFG. Wherever it lives, the *rewrite* is a stage-A pass and it changes the
  block count, which is why §6 orders it first. Confirm that ordering is
  acceptable, or say if `finally` should be deferred past M5 entirely.
* **O-4 — `break` out of `try`.** §4.5 rule 1 forbids it and wraps instead. That
  costs one extra label per region. Legal JS allows it; the restriction exists to
  keep §5 simple. Worth relaxing later?
* **O-5 — irreducible fixtures.** T4 builds graphs by hand because we have none.
  `javascript-obfuscator` does not produce irreducible flow (its flattening is a
  reducible loop+switch). If irreducible input matters, someone would have to
  hand-write bytecode or find a bundle containing it. Worth a task, or is
  synthetic coverage enough?
