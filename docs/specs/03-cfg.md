# Spec 03 — CFG, exception regions, environment graph (M4, stage 1)

**Milestone:** M4 (baseline), first stage
**Status:** ready to implement
**Owner model:** Opus for `exceptions.ts` and `env-graph.ts`; Sonnet for the rest (D5)
**Prerequisites:** spec 01 (parser), spec 02 (disassembler)
**Consumers:** spec 04 (structurer), spec 05 (emitter), spec 07 (pass ladder)

Reference sections you will actually need: `docs/HBC-FORMAT.md` **§4** (handler
table semantics), **§11.1** (jump/switch encoding); `docs/PRIOR-ART.md` **§4.5**
(exceptions structured separately and first), **§6.1** (closures/environments),
**§6.2** (generators, two eras), **§6.3** (try/catch/finally), **§6.4** (switch);
`docs/DECISIONS.md` **D7**, **D9**, **D11**, **D13**, **D16**.

> **Ownership notice.** An implementer owns `src/**`, `package.json` and
> `tests/**/*.test.ts` for M1. Do not edit those. This spec describes what the
> M4 implementer will add; it touches nothing itself.

---

## 1. Scope

**In.** `DecodedFunction` (spec 02) → a control-flow graph with basic blocks and
typed edges; exception regions carved from the handler table *before* any
structuring; switch jump-table edges; a per-function generator/async
classification with the D9 shim boundary made explicit; and — as a **separate
analysis output** — the environment/closure graph the emitter needs to turn
`(env, slot)` pairs into real JS variables.

**Out.** Dominators-consuming structural decisions (spec 04 owns those, though
this spec provides the dominator tree), SSA and expression rebuilding (spec 05
and the pass ladder), any AST.

**Why the env graph lives here and not in the emitter.** It is a whole-*module*
dataflow analysis over the function table, not a per-function emission concern:
`CreateClosure r1, rEnv, f#6` in function 0 is what tells you that function 6's
parent environment is the one created in function 0. Risk **R3** in
`docs/PRIOR-ART.md` §7.5 — dangling `_closure1_slot1`, hermes-dec's exact bug —
is a failure of this analysis, not of emission, and it must fail loudly here.

---

## 2. Public API

```ts
// src/cfg/index.ts
export function buildCfg(mod: HbcModule, fn: DecodedFunction): FunctionCfg;

/** Whole-module analyses. Both are cheap relative to decoding and are computed
 *  once, eagerly, because they are inherently cross-function. */
export function buildEnvGraph(mod: HbcModule, decode: (i: number) => DecodedFunction): EnvGraph;
export function classifyFunctions(mod: HbcModule, decode: (i: number) => DecodedFunction): readonly FunctionKindInfo[];

export interface ModuleAnalysis {
  readonly module: HbcModule;
  readonly envGraph: EnvGraph;
  readonly kinds: readonly FunctionKindInfo[];
  cfg(functionIndex: number): FunctionCfg;      // memoised
  readonly diagnostics: readonly Diagnostic[];
}
export function analyseModule(mod: HbcModule, opts?: AnalysisOptions): ModuleAnalysis;

export interface AnalysisOptions {
  /** Fail instead of falling back to a materialised environment object when an
   *  (env, slot) pair cannot be resolved statically. Default true — see §6.4. */
  readonly strictEnv?: boolean;
  /** Cap on blocks per function before we refuse (obfuscated input; §8). */
  readonly maxBlocks?: number;                  // default 200_000
}
```

---

## 3. Types

### 3.1 Blocks and edges

```ts
export type BlockId = number;                   // dense, 0-based, entry === 0

export type EdgeKind =
  | "fallthrough"      // straight-line continuation
  | "jump"             // unconditional Jmp/JmpLong
  | "branch-taken"     // conditional jump, condition holds
  | "branch-not-taken" // conditional jump, fallthrough
  | "switch-case"      // one jump-table entry
  | "switch-default";  // the switch's default target

export interface Edge {
  readonly from: BlockId;
  readonly to: BlockId;
  readonly kind: EdgeKind;
  /** switch-case only: the integer case value, or the case-label string id. */
  readonly caseValue?: number;
  /** switch-case only: true when caseValue indexes the string table. */
  readonly caseIsString?: boolean;
}

export type BlockTerminator =
  | { readonly kind: "fallthrough" }
  | { readonly kind: "jump" }
  | { readonly kind: "branch" }
  | { readonly kind: "switch"; readonly table: SwitchTable }
  | { readonly kind: "return" }
  | { readonly kind: "throw" }
  | { readonly kind: "unreachable" };           // the Unreachable opcode, or a dead tail

export interface BasicBlock {
  readonly id: BlockId;
  readonly start: number;                       // function-relative offset, inclusive
  readonly end: number;                         // function-relative offset, exclusive
  readonly instructions: readonly Instruction[];// slice of DecodedFunction.instructions
  readonly terminator: BlockTerminator;
  readonly succs: readonly Edge[];              // NORMAL edges only — never exception edges
  readonly preds: readonly BlockId[];
  /** True iff this block is the `target` of some handler; it begins with `Catch`. */
  readonly isHandlerEntry: boolean;
  /** Register bound by the leading `Catch`, when isHandlerEntry. */
  readonly catchRegister?: number;
}
```

**The single most important structural rule (D7, `docs/PRIOR-ART.md` §4.5):**

> Exception edges are **never** members of `succs`/`preds`. They live in a side
> map (`FunctionCfg.exceptionSuccs`). The dominator tree, reverse postorder, and
> everything spec 04 computes see the *normal* graph only. Dalvik decompilers do
> exactly this and it is what makes exception handling tractable.

### 3.2 Function CFG

```ts
export interface FunctionCfg {
  readonly functionIndex: number;
  readonly blocks: readonly BasicBlock[];       // index === BlockId
  readonly entry: BlockId;                      // always 0
  readonly exits: readonly BlockId[];           // return / throw / unreachable terminators
  readonly byOffset: ReadonlyMap<number, BlockId>;  // block START offset -> id
  /** pc -> the innermost handler-entry block protecting it, if any. Derived from
   *  the handler table; used for exception edges and for region carving. */
  readonly exceptionSuccs: ReadonlyMap<BlockId, readonly BlockId[]>;
  readonly regions: readonly ExceptionRegion[]; // outermost-first, properly nested
  readonly switchTables: readonly SwitchTable[];
  readonly dom: DominatorTree;
  readonly rpo: readonly BlockId[];             // reverse postorder over normal edges
  readonly reducible: boolean;                  // informational only; see §5
  readonly generator: GeneratorShape;
  readonly diagnostics: readonly Diagnostic[];
}

export interface DominatorTree {
  readonly idom: readonly (BlockId | null)[];   // idom[entry] === null
  readonly children: readonly (readonly BlockId[])[];
  dominates(a: BlockId, b: BlockId): boolean;   // O(1) via pre/post numbering
  readonly preorder: readonly BlockId[];
  /** Back edges of the normal graph: (from, to) with `to` dominating `from`. */
  readonly backEdges: readonly (readonly [BlockId, BlockId])[];
}
```

### 3.3 Exception regions

```ts
export interface ExceptionRegion {
  readonly index: number;                       // position in the handler table (file order)
  readonly startPc: number;                     // handler.start, function-relative
  readonly endPc: number;                       // handler.end, EXCLUSIVE
  readonly handlerBlock: BlockId;               // handler.target's block; begins with Catch
  readonly catchRegister: number;
  /** Every block whose [start,end) lies inside [startPc,endPc). Block-aligned by
   *  construction (§5 splits at handler boundaries). */
  readonly bodyBlocks: ReadonlySet<BlockId>;
  /** Index into `regions` of the immediately enclosing region, or null. */
  readonly parent: number | null;
  readonly children: readonly number[];
  /** True when several table entries share this `target` — Hermes emits that for
   *  a single `catch` protecting several disjoint ranges, and for the
   *  synthesised catch-and-rethrow half of a `finally`. */
  readonly sharesHandlerWith: readonly number[];
}
```

**Nesting.** `docs/HBC-FORMAT.md` §4.3: handlers are innermost-first in file
order, may overlap and nest, and for a given pc the *first* matching entry in
file order is the active one. Sort by `(startPc asc, endPc desc)` to get an
outermost-first order; then a region's parent is the nearest preceding region
whose range strictly contains it. **Ranges that partially overlap without
nesting are not expected** — Hermes emits properly nested ranges — so treat a
crossing pair as `E_BAD_HANDLER` rather than inventing a semantics for it.

**`finally` is not represented.** Per §6.3 of PRIOR-ART, the compiler duplicates
the finally body into the normal path and into a synthesised catch-and-rethrow
handler. This spec does **not** try to recognise that; it records
`sharesHandlerWith` so a later pass (spec 07, `finally-dedup`) can. The baseline
emits the correct-but-verbose duplicated form.

### 3.4 Generators and async

```ts
export type FunctionKind = "normal" | "generator" | "async" | "async-generator";
export type GeneratorEra = "none" | "opcode" | "lowered";

export interface FunctionKindInfo {
  readonly functionIndex: number;
  readonly kind: FunctionKind;
  readonly era: GeneratorEra;
  /** How we know. "header" = flags.kind (classes D/E); "creation-site" = a
   *  CreateGeneratorClosure/CreateAsyncClosure named this function; "body" = the
   *  body starts with StartGenerator. */
  readonly evidence: readonly ("header" | "creation-site" | "body")[];
  /** v<=96: the outer stub's inner function; v>=97: CreateGenerator's operand. */
  readonly innerFunctionIndex: number | null;
  /** v>=97 only. The D9 shim is required for this function. */
  readonly shimRequired: boolean;
}

export interface GeneratorShape {
  readonly info: FunctionKindInfo;
  /** v<=96 only. One entry per SaveGenerator: the suspend site and the block the
   *  VM resumes into. This is what the `yield` recovery pass consumes. */
  readonly suspendPoints: readonly SuspendPoint[];
  /** v<=96 only: offsets of StartGenerator / CompleteGenerator / ResumeGenerator. */
  readonly generatorOps: readonly { readonly offset: number; readonly name: string }[];
}

export interface SuspendPoint {
  readonly saveOffset: number;      // the SaveGenerator instruction
  readonly resumeBlock: BlockId;    // the block at SaveGenerator's target
  /** True when SaveGenerator is immediately followed by `Ret r` — the canonical
   *  `r = yield v` shape (docs/PRIOR-ART.md §6.2). */
  readonly canonical: boolean;
  readonly retRegister: number | null;
}
```

**Two eras, two front-ends — do not let one code path serve both** (D9,
PRIOR-ART §6.2):

| | v≤96 (`era: "opcode"`) | v≥97 (`era: "lowered"`) |
|---|---|---|
| How we know | `CreateGeneratorClosure` / `CreateAsyncClosure` at the creation site; `StartGenerator` first in the body | `FunctionHeader.flags.kind` ∈ {Generator, Async} (spec 01 §3.4) |
| Body shape | VM primitives: `StartGenerator`, `ResumeGenerator`, `SaveGenerator`, `CompleteGenerator` | an explicit compiler-lowered state machine: state slot in an environment, `JStrictEqual` dispatch chain, `NewObjectWithBuffer` `{value, done}` results |
| CFG treatment | `SaveGenerator` is a **normal** terminator-like instruction: it does *not* end a block by itself, but its target is a leader (a resume point). `ResumeGenerator` is an ordinary instruction | nothing special — it is a plain function with a dispatch `switch`/compare-chain at the top |
| M4 baseline | structure normally; `yield` recovery is a spec 07 pass | **D9 shim**: emit the body as a plain function and `CreateGenerator` as `__hbc_makeGenerator(body, env)` (spec 05 §7) |

**The shim boundary, stated precisely.** For `era: "lowered"`, the CFG is
*ordinary*. Nothing in this spec special-cases it. The only obligation here is to
set `shimRequired: true` and `innerFunctionIndex` from the `CreateGenerator`
operand, so the emitter knows which function to wrap. Resist the temptation to
recognise the state machine at CFG level — that is Strategy B, deferred.

### 3.5 Environment / closure graph

```ts
export type EnvNodeId = number;

export interface EnvNode {
  readonly id: EnvNodeId;
  /** The function containing the Create*Environment instruction. */
  readonly ownerFunction: number;
  readonly createOffset: number;                // function-relative
  readonly createOpcode: string;                // CreateEnvironment | CreateFunctionEnvironment | CreateTopLevelEnvironment | CreateInnerEnvironment
  /** Static parent, or null for a top-level environment. */
  readonly parent: EnvNodeId | null;
  /** v<=96: from FunctionHeader.environmentSize. v>=97: the size operand. */
  readonly size: number;
  /** Function-table indices bound to this env by CreateClosure/CreateGenerator/
   *  CreateAsyncClosure/CreateGeneratorClosure. */
  readonly closures: readonly number[];
}

export type EnvAccessKind = "load" | "store";

export interface EnvAccess {
  readonly functionIndex: number;
  readonly offset: number;
  readonly kind: EnvAccessKind;
  readonly slot: number;
  /** Resolved environment, or null when resolution failed (see §6.4). */
  readonly env: EnvNodeId | null;
  /** Why resolution failed, when env is null. */
  readonly unresolvedReason?: "dynamic-closure-env" | "unknown-depth" | "reg-not-tracked";
}

export interface EnvSlot {
  readonly env: EnvNodeId;
  readonly slot: number;
  readonly accesses: readonly EnvAccess[];
  /** The set of functions that touch this slot. */
  readonly readers: ReadonlySet<number>;
  readonly writers: ReadonlySet<number>;
  /** "lexical": every accessor is the owner function or a lexical descendant, so
   *  the slot can be a plain closure variable declared in the owner (the normal
   *  case). "materialised": it must become a real object property. */
  readonly strategy: "lexical" | "materialised";
}

export interface EnvGraph {
  readonly nodes: readonly EnvNode[];
  readonly slots: readonly EnvSlot[];
  slot(env: EnvNodeId, slot: number): EnvSlot;
  /** Function index -> the env node that function's closure was created with,
   *  i.e. its lexical parent environment. Null for the global function and for
   *  any function whose creation site we never saw. */
  readonly closureEnvOf: ReadonlyMap<number, EnvNodeId | null>;
  /** Function index -> env nodes created *inside* that function. */
  readonly envsCreatedIn: ReadonlyMap<number, readonly EnvNodeId[]>;
  readonly unresolved: readonly EnvAccess[];
  readonly diagnostics: readonly Diagnostic[];
}
```

---

## 4. Block construction

### 4.1 Leaders

A block starts at every offset in the **leader set**:

1. `0` (function entry).
2. The target of every jump / conditional jump (`Instruction.targets`).
3. Every switch case target and switch default target.
4. The instruction *after* every jump, conditional jump, switch, `Ret`, `Throw`
   and `Unreachable` (when that offset is < `bytecodeSizeInBytes`).
5. Every handler `target` (a handler entry, always beginning with `Catch`).
6. Every handler `start` and every handler `end` — **this is the block-splitting
   step that makes exception regions block-aligned**, and it is the one people
   forget. Without it a region's `bodyBlocks` cannot be a set of whole blocks.
7. v≤96 generators: the target of every `SaveGenerator` (a resume point).

Spec 02 already guarantees every jump target is an instruction boundary; assert
the same for handler `start`/`target` and record `W_HANDLER_MISALIGNED` (not
fatal) for a misaligned `end`, per spec 02 §3.3 — an `end` equal to
`bytecodeSizeInBytes` is legal and common.

### 4.2 Edges

Per block, from its last instruction:

| Last instruction | Terminator | Edges |
|---|---|---|
| unconditional jump | `jump` | one `jump` edge to the target |
| conditional jump | `branch` | `branch-taken` → target, `branch-not-taken` → next offset |
| `SwitchImm`/`UIntSwitchImm`/`StringSwitchImm` | `switch` | one `switch-case` per table entry (carrying `caseValue`), one `switch-default` |
| `Ret` | `return` | none |
| `Throw`, `ThrowIfEmpty`-family that always throws | `throw` | none |
| `Unreachable` | `unreachable` | none |
| anything else (block ended because the next offset is a leader) | `fallthrough` | one `fallthrough` edge |

Duplicate `switch-case` edges to the same target are **kept as distinct edges**
(fall-through runs and shared targets are semantic — fixture
`53-switch-jumptable-large` has several) but the `preds` list is deduplicated.

### 4.3 Exception edges

For each block *B* and each region *R* with `B ∈ R.bodyBlocks`, add
`R.handlerBlock` to `exceptionSuccs.get(B)`, innermost region first. Any
instruction in a protected range can throw — modelling per-instruction
throw points is unnecessary at block granularity, because spec 04 wraps whole
regions in `try`.

`exceptionSuccs` is used by spec 04 to attach handlers and by spec 05 for
liveness sanity, never by the dominator computation.

### 4.4 Dominators, RPO, reducibility

Compute over the **normal** graph only.

* RPO by iterative DFS (no recursion — obfuscated inputs reach thousands of
  blocks; see §8).
* Dominators by Cooper–Harvey–Kennedy iterative intersection over RPO. It is
  ~40 lines, fast enough, and easier to audit than Lengauer–Tarjan. Assert
  convergence within `blocks.length` iterations.
* `backEdges` = edges `(u → v)` where `v` dominates `u`.
* `reducible` = every retreating edge (target already visited and not finished in
  the DFS) is a back edge. **This flag is informational.** Spec 04's algorithm is
  total and must not branch on it; it exists for reporting and for the
  obfuscated-fixture stress metric.

---

## 5. Exception region carving (do this before anything else structural)

```
1. Read fn.exceptionHandlers (spec 01 §3.4): (start, end, target), function-relative.
2. Validate: start < end <= bytecodeSize; target < bytecodeSize; each of
   start/target is an instruction boundary.
3. Sort a copy by (start asc, end desc) -> outermost-first.
4. Reject crossing (partially overlapping, non-nested) pairs -> E_BAD_HANDLER.
5. Split blocks at every start/end/target (§4.1 rules 5-6).
6. For each handler, bodyBlocks = { B : R.start <= B.start && B.end <= R.end }.
7. parent = nearest preceding region strictly containing this one.
8. Group by target to fill sharesHandlerWith.
9. Assert every handlerBlock's first instruction is `Catch`; record its register.
```

Step 9 is a real check, not a formality: a handler target that does not begin
with `Catch` means the handler table or the decode is wrong, and it is fatal.

**Known corpus stress cases.** `hermes-dec-sample` function 5 has 3 handlers at
v94 and **5 at v99, four of which share one target** (`docs/HBC-FORMAT.md`
§4.1/§4.2) — nested `try` inside `catch` inside a generator. That is the
regression test for steps 3, 7 and 8.

---

## 6. The environment / closure graph

### 6.1 Opcodes to model

From `docs/PRIOR-ART.md` §6.1:

**v≤96.** `CreateEnvironment <envReg>` (size from the *function header*, not the
instruction — a real trap), `CreateInnerEnvironment` (v92/94+),
`GetEnvironment <dst>, <levels>` (walk N levels up the static chain),
`LoadFromEnvironment <dst>, <env>, <slot>`,
`StoreToEnvironment <env>, <slot>, <val>`, `StoreNPToEnvironment` (identical
semantics — a GC write-barrier hint only; **treat it exactly like
`StoreToEnvironment`**), `CreateClosure`, `CreateGeneratorClosure`,
`CreateAsyncClosure` (+ `LongIndex` variants of each).

**v≥97.** `CreateFunctionEnvironment <dst>, <size>` (parent = the enclosing
function's env), `CreateTopLevelEnvironment <dst>, <size>` (no parent),
`CreateEnvironment <dst>, <parentEnvReg>, <size>`,
`GetParentEnvironment <dst>, <levels>`, `GetClosureEnvironment <dst>, <closure>`,
`GetEnvironment <dst>, <startEnv>, <levels>`, `CreateClosure`,
`CreateGenerator`.

### 6.2 A minimal register tracker

Resolving `(envReg, slot)` needs to know which env node a register holds. Full
SSA is spec 05's business; here a **per-function forward abstract interpretation
over the RPO with a flat lattice** is enough and is deliberately small:

```ts
type EnvValue =
  | { readonly t: "env"; readonly node: EnvNodeId }
  | { readonly t: "closure"; readonly fn: number; readonly env: EnvNodeId }
  | { readonly t: "unknown" };
```

* Transfer: `Create*Environment` → `env`; `GetParentEnvironment`/`GetEnvironment`
  with a static `levels` → walk `parent` that many times (`unknown` if it runs
  off the top); `GetClosureEnvironment r, c` → the closure's env if `c` is a
  tracked `closure`, else `unknown`; `Mov` copies; every other write → `unknown`.
* Merge at joins: equal values meet to themselves, everything else to `unknown`.
* Iterate to a fixed point over RPO. Loops converge in ≤ 2 passes with this
  lattice; cap at `blocks.length` and bail to `unknown` if not.

This is intentionally weaker than SSA and intentionally *sound*: it never claims
an env it has not proven.

### 6.3 Slot classification

For every `EnvSlot`, decide `strategy`:

* **`lexical`** — every accessing function is the env's `ownerFunction` or a
  lexical descendant of it (following `closureEnvOf`). Then the slot is an
  ordinary captured variable: the emitter declares it in the owner function and
  relies on JS closure semantics. This is the normal case and should be the
  overwhelming majority on the construct corpus.
* **`materialised`** — anything else: an accessor outside the lexical subtree, or
  any access whose `env` could not be resolved but whose *slot* is known. The
  emitter must then create a real object (`const _env3 = { s0: undefined, … }`)
  and rewrite accesses as property reads/writes.

### 6.4 Unresolved accesses — the R3 rule

> An `EnvAccess` with `env === null` is a **hard error by default**
> (`E_ENV_UNRESOLVED`, with function index, offset and reason). It must never
> silently become an identifier.

That is the whole point: hermes-dec emits `_closure1_slot1` and `_env_r8_slot0`
that are never declared, and the output throws `ReferenceError` before semantics
are even in question (`docs/PRIOR-ART.md` §1.2 defect 5, §7.5 R3).

`AnalysisOptions.strictEnv = false` downgrades it to `W_ENV_UNRESOLVED` plus a
whole-function `materialised` fallback: every env in that function becomes a
runtime object and every access becomes dynamic. That is correct but ugly, and
it is the escape hatch for obfuscated or hand-crafted bytecode — not the default.

---

## 7. Invariants

| # | Invariant | Violation |
|---|---|---|
| CFG-01 | every instruction belongs to exactly one block | `E_INTERNAL` |
| CFG-02 | blocks partition `[0, bytecodeSizeInBytes)` with no gaps or overlaps | `E_INTERNAL` |
| CFG-03 | `succs` contains no exception edge | `E_INTERNAL` |
| CFG-04 | `preds` is exactly the reverse of all `succs`, deduplicated | `E_INTERNAL` |
| CFG-05 | every block is reachable from `entry` over normal ∪ exception edges | diag `W_UNREACHABLE_BLOCK` (dead code after `Ret` is normal; a handler unreachable both ways is suspicious) |
| CFG-06 | every non-exit block has ≥ 1 successor | `E_INTERNAL` |
| CFG-07 | handler `target` blocks begin with `Catch` | `E_BAD_HANDLER` |
| CFG-08 | regions are properly nested (no crossing) | `E_BAD_HANDLER` |
| CFG-09 | every region's `bodyBlocks` is block-aligned | `E_INTERNAL` (means §4.1 rule 6 was skipped) |
| CFG-10 | `idom[entry] === null` and every other block has a non-null idom | `E_INTERNAL` |
| CFG-11 | switch edge count === `table.cases.length + 1` | `E_SWITCH_TABLE` |
| CFG-12 | `era === "opcode"` ⟹ zero `Create{Generator,Async}Closure` in a v≥97 module, and vice versa | `E_INTERNAL` |
| CFG-13 | every `SaveGenerator` target is a block start | `E_JUMP_MISALIGNED` |
| CFG-14 | `EnvNode.size` ≥ `max(slot)+1` over its slots | diag `W_ENV_SLOT_OOB` — a slot beyond the declared size means the tracker resolved the wrong env |
| CFG-15 | no `EnvAccess` with `env === null` when `strictEnv` | `E_ENV_UNRESOLVED` |
| CFG-16 | every function reachable from `globalCodeIndex` via closures has an entry in `closureEnvOf` | diag `W_ORPHAN_FUNCTION` (real bundles contain unreferenced functions) |

---

## 8. Robustness on obfuscated input

The hardened tier (D13, `tests/fixtures/OBFUSCATION.md`) is the stress case, and
its numbers are known: control-flow flattening produces **5.4×–8.8× more
instructions and 3.6×–7.7× more basic blocks** than the same construct
unobfuscated, and it converts structured control flow into a dispatcher `switch`
over shuffled state ids. Consequences to design for, not discover:

1. **No recursion over the graph.** DFS for RPO, dominator iteration, region
   nesting and the env fixed point are all explicit-stack or worklist loops.
   A recursive DFS on `01-if-else-chain.obf` (70 blocks) is fine; on a flattened
   real bundle function it is not.
2. **`maxBlocks` guard.** Above `AnalysisOptions.maxBlocks` (default 200 000),
   throw `E_TOO_COMPLEX` with the function index rather than melting. This is a
   budget, so per D15 it produces INCONCLUSIVE downstream, never a pass.
3. **The flattened dispatcher is a `switch` with many cases, all sharing one
   join.** Expect wide blocks lists, high in-degree on the dispatch head, and
   `reducible === true` (flattening produces a reducible graph — it is a loop
   with a switch, not a goto soup). Irreducibility, if it shows up at all, will
   come from real bundles, not from the obfuscator.
4. **A flattened function loses its jump table.** OBFUSCATION.md's measurement:
   `52-switch-jumptable.obf` contains **zero** `SwitchImm` — the shuffled state
   ids are too sparse for Hermes's density heuristic, so the dispatcher lowers to
   a `JStrictEqual` chain. So the hardened tier does **not** test jump-table
   code; only the base and minified tiers do. Do not assume otherwise when
   choosing coverage fixtures.

---

## 9. Test plan

All gate-tier tests live under `tests/gate/cfg/**`, sweep under
`tests/sweep/cfg/**` (spec 00 §2.1).

### T1 — Block structure goldens

For every gate binary and every function, snapshot a canonical JSON:
`{blocks: [{id, start, end, terminator, succs:[{to,kind,caseValue}]}], exits,
rpo, idom, backEdges, reducible}` to `tests/golden/cfg/<group>/<name>/vNN.json`.
Deterministic key order; `UPDATE_GOLDEN=1` rewrites. This is the ratchet: any
change to leader computation shows up as a reviewable diff.

### T2 — Byte-anchored assertions (hardcoded, not snapshots)

* `hermes-dec-sample` v94 function 5: 3 regions with body ranges
  `[0x1e,0x32)`, `[0x1e,0x47)`, `[0x4b,0x95)` and handler blocks at `0x34`,
  `0x49`, `0x97`; regions 0 and 1 share `startPc`, so region 1 is the parent of
  region 0; every handler block starts with `Catch`.
* Same function at v99: 5 regions, handler blocks at `0x17b` for **four** of
  them → `sharesHandlerWith` has one group of size 4.
* `52-switch-jumptable` v94 function 1: the switch block has 14 successors
  (13 cases + default), cases 1 and 2 target the same block, and the case
  targets are the §4.1-worked list from spec 02 §4.1.
* `53-switch-jumptable-large`: 41 successors; `default` is **not** the last case
  textually — assert the default edge exists independently of case ordering.

### T3 — Exception invariants across the corpus

Every gate binary: CFG-01…CFG-13 hold for every function. Fixtures
`12-try-catch-finally-return`, `13-try-finally-no-catch`, `14-nested-try-catch`,
`15-catch-without-binding`, `16-finally-with-break-continue` are the targeted
cases; assert region counts and nesting depth per fixture and record them in the
golden.

### T4 — Generator classification

* v84/v94 `23-…`–`26-…` (generators) and `27-…`–`29-…` (async):
  `era === "opcode"`, `suspendPoints.length` > 0, and every canonical suspend
  point is `SaveGenerator` immediately followed by `Ret`.
* v98/v99 same fixtures: `era === "lowered"`, `kind` from the header flags,
  `shimRequired === true`, `innerFunctionIndex` equal to the `CreateGenerator`
  operand, and `suspendPoints.length === 0`.
* `hermes-dec-sample` v99: functions 2 and 4 are the `kind = Generator` stubs
  (spec 01 T2) and each names an inner function.
* Cross-check: for every fixture that compiles at both v94 and v99, the *set of
  function kinds* agrees between versions even though the evidence differs.

### T5 — Environment graph

* `17-closure-loop-var`, `18-closure-loop-let`, `21-iife-closures`,
  `22-nested-closures-counters`: every `EnvAccess` resolves
  (`unresolved.length === 0`), every slot is `strategy: "lexical"`, and the
  `closureEnvOf` chain matches the source's lexical nesting depth.
* **Corpus-wide hard gate:** `unresolved.length === 0` for every gate binary at
  every version. If that cannot be achieved, the failure list is the M4 blocker
  list — do not relax `strictEnv` to make the suite green (R3).
* `StoreNPToEnvironment` is treated identically to `StoreToEnvironment`: assert
  a fixture containing both produces one slot, not two.

### T6 — Obfuscated variants (hardened tier)

For all 194 `vNN.obf.hbc` binaries (`tests/fixtures/OBFUSCATION.md`), run
`analyseModule` and assert only **totality and safety**, not shape:

* it terminates within a per-function budget (2 s) and under `maxBlocks`;
* every invariant CFG-01…CFG-13 holds;
* `unresolved.length === 0` (the obfuscator adds closures and string-array
  decoders — a real environment-resolution stress test);
* record `blocks`, `edges`, `regions`, `reducible` per function into a
  **metrics** snapshot (not an assertion) so the CFG's response to flattening is
  tracked over time.

Expected from OBFUSCATION.md's measurements: roughly 4–8× the block count of the
base fixture, `reducible === true` throughout, and zero `SwitchImm` in the
flattened functions.

### T7 — Sweep: real bundles

`bundles/rn-template-0.72/*.hbc` (4199–4314 functions each): every function
builds a CFG, invariants hold, and `unresolved.length` is reported. Record wall
time and peak RSS. A non-zero `unresolved` count here is *expected* early and is
the concrete R3 work list; it must reach zero before M6.

---

## 10. Acceptance criteria

- [ ] `analyseModule` succeeds on all gate binaries with zero errors.
- [ ] CFG-01…CFG-16 are each exercised by at least one test; the fatal ones have
      a negative test (hand-corrupted input) proving they fire.
- [ ] Exception edges appear in `exceptionSuccs` and **nowhere** in `succs` —
      asserted by a corpus-wide property test, plus a unit test that a dominator
      tree computed with exception edges included would differ (proving the
      separation matters and is real).
- [ ] All T2 byte-anchored numbers match exactly.
- [ ] Generator classification agrees across v94 and v99 for every fixture that
      compiles at both, with different `era` and different evidence.
- [ ] `unresolved.length === 0` for every gate binary at every version, with
      `strictEnv: true`.
- [ ] All 194 `.obf.hbc` binaries analyse to completion inside budget with all
      invariants holding.
- [ ] Golden CFG snapshots exist for every gate `(fixture, version)` and are
      byte-stable across two runs and across macOS/Linux.
- [ ] No recursion over graph data: `grep` for a self-recursive DFS in
      `src/cfg/**` returns nothing, and a synthetic 100 000-block function
      analyses without a stack overflow.
- [ ] `docs/LOWERING-CATALOGUE.md` is untouched by this spec (spec 07 owns it).

---

## 11. Estimated complexity

| Component | Size | Model |
|---|---|---|
| `blocks.ts` (leaders, edges, terminators) | ~250 lines | Sonnet |
| `dom.ts` (RPO, Cooper–Harvey–Kennedy, back edges) | ~150 lines | Sonnet |
| **`exceptions.ts`** (region carving, nesting, sharing) | ~250 lines; nesting and the shared-target case are subtle | **Opus** |
| `generators.ts` (classification, suspend points) | ~200 lines | Sonnet |
| **`env-graph.ts`** (tracker, fixed point, slot classification) | ~400 lines; this is R3 and it is the one that will produce wrong-but-plausible output if rushed | **Opus** |
| tests T1–T7 | ~900 lines | Sonnet |

Sequence: blocks → dom → exceptions → generators → env graph. The env graph is
last because it needs the CFG's RPO, and it is where the review effort should go.

---

## 12. Open questions for the overseer

* **O-1 — is `reducible` worth computing at all?** Spec 04's algorithm is total,
  so nothing branches on it. I kept it for reporting (it tells us whether real
  bundles contain irreducible flow, which nobody has measured). Cheap, but it is
  a field that invites misuse. Keep or drop?
* **O-2 — per-instruction vs per-block exception edges.** I model "any block in a
  protected range can throw". A finer model (only instructions that can actually
  throw) would give tighter regions but needs a can-throw table per opcode, which
  is another generated artefact. Is block granularity acceptable for M4?
* **O-3 — `finally` detection placement.** I deliberately do *not* detect the
  duplicated finally body here; `sharesHandlerWith` is the hook and spec 07 owns
  the pass. But the duplication is most visible at CFG level (two structurally
  identical block chains, one reachable from a rethrowing handler). Should the
  *detection* live here as an analysis output and only the *rewrite* in the pass?
* **O-4 — env-graph strictness on real bundles.** T7 will almost certainly find
  unresolved accesses in a 4200-function bundle at first. Do we gate M4 on
  gate-tier zero only (my proposal), or on bundles too?
* **O-5 — `StringSwitchImm` has no compiled fixture.** `tests/fixtures/README.md`
  records that a v99 string switch *does* emit `StringSwitchImm` but that no
  fixture was shipped ("would duplicate 09/10's shape"). For the CFG that is not
  a duplicate: it is the only source of string-keyed case edges. One fixture
  would close CFG-11 for the string case. Approve?
