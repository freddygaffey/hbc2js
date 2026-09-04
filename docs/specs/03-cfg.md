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

**Versions.** Five are now fetched and fixtured: 84, 94, **96**, 98, 99. v96 is
layout class C with the v94 opcode *numbering* — only `DirectEval` gained a
third operand (`docs/TOOLCHAIN.md` "v96: opcode table and layout") — so every
v94 code path in this spec applies verbatim to v96, and `era: "opcode"` covers
84/94/96 while `era: "lowered"` covers 98/99. Production apps ship 96 and 98, so
neither is a curiosity.

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
  readonly index: number;                       // position in `regions` (§5 step 3 order: outermost first)
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
file order is the active one. Sort by `(startPc asc, endPc desc, file order
desc)` to get an outermost-first order; then a region's parent is the nearest
preceding region whose range contains it, an **identical** range included (§5
step 7). **Ranges that partially overlap without
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
  /** The function that actually contains the generator body. Resolved by the
   *  SAME two-hop procedure at BOTH eras — see §3.4.1. Null when no creation
   *  site was found. */
  readonly innerFunctionIndex: number | null;
  /** The intermediate trampoline function, when the two-hop resolution went
   *  through one (the normal case at both eras). */
  readonly trampolineFunctionIndex: number | null;
  /** True for the function that must be wrapped by the D9 shim — i.e. the
   *  target of a `CreateGenerator`. True at BOTH eras (§3.4.1). */
  readonly shimRequired: boolean;
}

export interface GeneratorShape {
  readonly info: FunctionKindInfo;
  /** v<=96 only. The synthetic block prepended by §4.5, and the CFG entry when
   *  present. Null for every other function. */
  readonly resumeDispatch: BlockId | null;
  /** v<=96 only. One entry per SaveGenerator: the suspend site and the block the
   *  VM resumes into. This is what the `yield` recovery pass consumes. */
  readonly suspendPoints: readonly SuspendPoint[];
  /** v<=96 only: offsets of StartGenerator / CompleteGenerator / ResumeGenerator. */
  readonly generatorOps: readonly { readonly offset: number; readonly name: string }[];
}

export interface SuspendPoint {
  /** 1-based resume state. State 0 is the function's real entry. This is the
   *  value the D9 shim passes back in to resume here (§4.5, spec 05 §7.2). */
  readonly state: number;
  readonly saveOffset: number;      // the SaveGenerator instruction
  readonly resumeBlock: BlockId;    // the block at SaveGenerator's target
  /** True when SaveGenerator is immediately followed by `Ret r` — the canonical
   *  `r = yield v` shape (docs/PRIOR-ART.md §6.2). Measured: true for all four
   *  suspend points of 23-generator-basic at v94. */
  readonly canonical: boolean;
  readonly retRegister: number | null;
}
```

#### 3.4.1 Resolving `innerFunctionIndex` — the two-hop rule, identical at both eras

**Do not read the creation-site operand as the body.** Measured on
`tests/fixtures/constructs/23-generator-basic` at v94 and v99:

```
v94  global:                CreateGeneratorClosure r4, r2, fn#1     <- fn#1 is a TRAMPOLINE
v94  fn#1 NCFunction<sequence>(1 params, 1 registers):
       [@ 0] CreateEnvironment 0<Reg8>
       [@ 2] CreateGenerator 0<Reg8>, 0<Reg8>, 2<UInt16>            <- fn#2 is the BODY
       [@ 7] Ret 0<Reg8>
v94  fn#2 Function<?anon_0_sequence>: StartGenerator; ResumeGenerator; ... SaveGenerator ...

v99  fn NCFunction<sequence>(1 params, 2 registers):
       [@ 13] CreateGenerator 1<Reg8>, 1<Reg8>, 3<UInt16>           <- fn#3 is the BODY
v99  fn#3 Function<sequence>: the lowered state machine
```

The procedure, one rule for both eras:

```
1. Start at the creation site: CreateGeneratorClosure / CreateAsyncClosure
   (v<=96) or CreateClosure on a header-kind Generator/Async function (v>=97).
   Call its function-id operand F.
2. If F's own body contains a `CreateGenerator`, then
       trampolineFunctionIndex = F
       innerFunctionIndex      = that CreateGenerator's function-id operand
   else
       trampolineFunctionIndex = null
       innerFunctionIndex      = F
3. shimRequired is set on innerFunctionIndex, at both eras.
```

Reading "the outer stub's inner function" as "the `CreateGeneratorClosure`
operand" finds a 3-instruction trampoline with **zero** `SaveGenerator`s, so
`suspendPoints` comes back empty and nothing crashes — a silently wrong
classification that surfaces much later as "the shim is never called". That is
why the procedure is written out rather than described.

`CreateGenerator` therefore appears at **both** eras. See the note under CFG-12.

**Two eras, two front-ends — do not let one code path serve both** (D9,
PRIOR-ART §6.2):

| | v≤96 (`era: "opcode"`) | v≥97 (`era: "lowered"`) |
|---|---|---|
| How we know | `CreateGeneratorClosure` / `CreateAsyncClosure` at the creation site; `StartGenerator` first in the body | `FunctionHeader.flags.kind` ∈ {Generator, Async} (spec 01 §3.4) |
| Body shape | VM primitives: `StartGenerator`, `ResumeGenerator`, `SaveGenerator`, `CompleteGenerator` | an explicit compiler-lowered state machine: state slot in an environment, `JStrictEqual` dispatch chain, `NewObjectWithBuffer` `{value, done}` results |
| CFG treatment | **§4.5's resume dispatcher is required**: `SaveGenerator` targets have no static predecessor, so a synthetic entry must supply one | nothing special — it is a plain function whose dispatch chain is reached by ordinary branches from the single entry (verified at v99) |
| M4 baseline | §4.5 dispatcher + **D9 shim** (spec 05 §7.2) | **D9 shim**: `CreateGenerator` → `__hbc_makeGenerator(body, env)` (spec 05 §7.2) |

**The shim boundary, stated precisely.** `CreateGenerator` is the shim site at
**both** eras, and `innerFunctionIndex` (§3.4.1) is the function it wraps. For
`era: "lowered"` the CFG of that body is *ordinary* — verified at v99: every
dispatch-chain case is reached by an ordinary `JStrictEqual`/`JmpTrue` branch
from the single entry. For `era: "opcode"` it is **not** ordinary and §4.5
applies. Resist the temptation to recognise the v≥97 state machine at CFG level —
that is Strategy B, deferred.

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
  /** Every `Create*Closure`/`Create*Class` site that made a closure over this
   *  function index, keyed by `siteKey(creatingFunction, offset)`, mapped to the
   *  environment captured there (`null` = the undefined operand). More than one
   *  distinct value is `W_AMBIGUOUS_CLOSURE_ENV`; the map is the evidence a fix
   *  needs, since `closureEnvOf` then reports only `null`. See §6.2. */
  readonly closureCreationSites: ReadonlyMap<number, ReadonlyMap<string, EnvNodeId | null>>;
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
   **A leader is not a predecessor** — see §4.5, which is what actually makes
   these blocks reachable.

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

A `SaveGenerator; Ret` block terminates in `return` and therefore has **no**
successor — correct, because yielding really does return to the caller. Its
resume block is entered on the *next* call, from the dispatcher of §4.5, not
from here.

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

### 4.5 Generator resume edges (v≤96) — required, not optional

### The problem, measured

`hermesc -dump-bytecode -pretty-disassemble=false` on
`tests/fixtures/constructs/23-generator-basic/source.js` at v94, function
`?anon_0_sequence` (reached by the §3.4.1 two-hop from `global`'s
`CreateGeneratorClosure r4, r2, fn#1`):

```
[@ 0]  StartGenerator
[@ 1]  ResumeGenerator 0<Reg8>, 1<Reg8>
[@ 4]  JmpTrue 82<Addr8>, 1<Reg8>        -- to 86, the .return() path
[@ 7]  LoadConstString 1<Reg8>, 7<UInt16>
[@ 11] SaveGenerator 4<Addr8>            -- target 11+4 = 15
[@ 13] Ret 1<Reg8>
[@ 15] ResumeGenerator 1<Reg8>, 2<Reg8>  -- RESUME POINT: zero predecessors
[@ 18] JmpTrue 65<Addr8>, 2<Reg8>
[@ 21] LoadConstString 2<Reg8>, 8<UInt16>
[@ 25] SaveGenerator 4<Addr8>            -- target 29
[@ 27] Ret 2<Reg8>
[@ 29] ResumeGenerator 2<Reg8>, 3<Reg8>  -- RESUME POINT
 ...                                      (4 suspend points: 11, 25, 39, 57
                                           -> resume blocks 15, 29, 43, 61)
```

Every `SaveGenerator` is immediately followed by `Ret`, whose row in §4.2's edge
table is *"return | none"*. Nothing else in the function branches to 15, 29, 43
or 61 — the only way to reach them is the VM re-entering at the saved pc, which
is **opaque runtime state, not a static edge**. So without §4.5:

* RPO never visits them; dominators never assign them an `idom`; **CFG-10 fires
  `E_INTERNAL`** for every generator with more than one `yield` — which is
  fixtures 23, 24, 25 and 26, i.e. the normal case;
* even with CFG-10 relaxed, spec 04's translation can never visit an unreached
  node, so **the code that runs on the second and subsequent `.next()` calls is
  not emitted at all** — absent, not ugly.

The v≥97 era does **not** have this problem (verified at v99: the dispatch chain
is reached by ordinary branches from the single entry).

### The fix: a synthetic resume-dispatch entry (option (a))

For every function with `era: "opcode"` and `suspendPoints.length > 0`, prepend
one synthetic block:

```
B_dispatch  (id = blocks.length, but it becomes cfg.entry)
  terminator: { kind: "switch", table: <synthetic> }
  scrutinee:  the generator's resume state (see the emitter contract below)
  edges:      switch-case  0 -> the real entry block (offset 0)
              switch-case  k -> suspendPoints[k-1].resumeBlock,  k = 1..n
              switch-default -> the real entry block
```

Properties this buys, each of which is the reason to prefer it over option (b):

1. **Every resume block gets a predecessor**, so RPO, dominators and CFG-10 all
   work with no special cases anywhere downstream.
2. **Spec 04 needs no change at all.** The body becomes a single-entry graph
   whose entry is a multi-way switch; Ramsey structures it into
   `switch (state) { case 0: … case 1: … }`, which is *exactly what the VM does
   at runtime*. Not a coincidence — it is the same construct.
3. **The emitter contract falls out.** `SaveGenerator L_k` lowers to
   `__state = k;` and its following `Ret r` to `return r;`; the shim calls back
   with `__state`. Spec 05 §7.2 specifies this.

Rules:

* `B_dispatch` is synthetic: it has `instructions: []` and `start === end === -1`.
  Code that assumes every block owns bytes must handle it — CFG-02 is amended
  accordingly (CFG-17).
* It is added **only** for `era: "opcode"` bodies with suspend points. A v≤96
  generator *trampoline* (§3.4.1) has none and is an ordinary function.
* `GeneratorShape.resumeDispatch` records its id; `cfg.entry` is it.
* State numbering is `suspendPoints` in ascending `saveOffset` order, 1-based.
  This is stable, deterministic, and is the contract the shim depends on.

### Why not option (b)

Structuring each resume block as its own root and stitching the results together
at emit time also works, but it moves the join into the emitter, needs its own
soundness argument, and produces output that no longer corresponds to a single
CFG — so spec 04 §5's whole-function isomorphism check would have nothing to
check against. Option (a) keeps one graph, one tree, one proof. Recorded here so
the choice is not silently revisited.

### The `.return()` / `.throw()` paths

Each `ResumeGenerator dst, isReturnReg` is followed by
`JmpTrue isReturnReg, <completion>`, and each completion path is
`CompleteGenerator; Ret`. Those are ordinary instructions and ordinary edges —
no special handling. `ResumeGenerator` lowers to "read the sent value and the
is-return flag from the shim" (spec 05 §7.2).

---

## 5. Exception region carving (do this before anything else structural)

```
1. Read fn.exceptionHandlers (spec 01 §3.4): (start, end, target), function-relative.
2. Validate: start < end <= bytecodeSize; target < bytecodeSize; each of
   start/target is an instruction boundary.
3. Sort a copy by (start asc, end desc, FILE ORDER DESC) -> outermost-first.
4. Reject crossing (partially overlapping, non-nested) pairs -> E_BAD_HANDLER.
5. Split blocks at every start/end/target (§4.1 rules 5-6).
6. For each handler, bodyBlocks = { B : R.start <= B.start && B.end <= R.end }.
7. parent = nearest preceding region containing this one, where "containing"
   INCLUDES an identical range (step 3 has already put the later table entry
   first, so the preceding equal-range region is the outer one).
8. Group by target to fill sharesHandlerWith.
9. Assert every handlerBlock's first instruction is `Catch`; record its register.
```

Step 9 is a real check, not a formality: a handler target that does not begin
with `Catch` means the handler table or the decode is wrong, and it is fatal.

**Why step 3 breaks ties by file order *descending*, and why step 7 admits an
equal range.** A `try` with both a `catch` and a `finally` compiles to two table
entries with the *identical* `[start, end)`: the catch first, the finally's
synthesised catch-and-rethrow second. The VM's
`BCProviderBase::findCatchTargetOffset` (`lib/BCGen/HBC/BytecodeDataProvider.cpp`)
scans the table in file order and returns the **first** entry that covers the pc,
so for equal ranges the *earlier* entry is the *inner* handler. Ordering the tie
ascending and refusing an equal-range region a parent makes them siblings, and
spec 04 then emits the earlier entry as the **outer** JS `try` — the catch is
skipped and the exception is taken by the finally's rethrow. React Native's own
`ErrorUtils.applyWithGuard` is exactly this shape; see review M4-C1 and
`tests/fixtures/constructs/54-try-catch-finally-shared-range`.

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
  | { readonly t: "none" }
  | { readonly t: "unknown" };
```

`none` is the **undefined environment operand**, and it is a fact, not an
absence: Hermes compiles a function that captures nothing to
`LoadConstUndefined rE; CreateClosure rD, rE, fn`. Folding that into `unknown`
makes every non-capturing function an orphan with an unknown `selfEnv`, and the
closures *it* creates cascade into orphans too — 4,009 of the 4,187 orphans on
react-navigation-example-0.85.3 (docs/BUGS.md 2026-09-04). `none` also answers
the parent operand of `CreateEnvironment`/`CreateInnerEnvironment`: an
environment created with an undefined parent has no parent.

* Transfer: `Create*Environment` → `env`; `LoadConstUndefined` → `none`;
  `GetParentEnvironment`/`GetEnvironment`
  with a static `levels` → walk `parent` that many times (`unknown` if it runs
  off the top); `GetClosureEnvironment r, c` → the closure's env if `c` is a
  tracked `closure`, else `unknown`; `Mov` copies; every other write → `unknown`.
* `Create*Closure d, rE, fn` with `rE` = `none` records `closureEnvOf(fn) =
  null` — *known* to capture nothing, which is what makes it not an orphan. If
  another site creates the same `fn` with a real environment, that is a genuine
  conflict (`W_AMBIGUOUS_CLOSURE_ENV`): `none` never loses to, and never
  overrides, a real environment, because binding the body to that environment
  would be wrong on the undefined-operand path.
* Every site is kept, not just the winner: `closureCreationSites` maps the
  function index to `siteKey(creatingFunction, offset) -> environment`. A
  conflict is a statement that the function has more than one lexical identity —
  Hermes inlines closure-making helpers and deduplicates identical bodies across
  Metro module factories, so the same function index is created from two places
  with two different environments. Reporting it and giving up leaves the body
  named for whichever site the fixed point saw first, which is silently wrong at
  the others; the fix is one emitted body per creation context, designed with
  measured numbers in `docs/reports/2026-09-05-ambiguous-closure-env.md`
  (178 such functions on react-navigation-example-0.85.3, 160 of them differing
  only in the directly captured environment).
* **The conflict is data, not a dead end.** `closureCopies` maps such a function
  to one `ClosureCopy` per distinct captured environment, each carrying the
  siteKeys that captured it and the positional `envRemap` from copy 0's
  environment chain to its own. It is populated only when every site resolved to
  a *real* environment (a site with the undefined operand has no chain to align)
  and every site's chain is rooted and of the same length; copy 0 always
  captures `closureEnvOf(f)`, which is the chain every recorded `EnvAccess` was
  resolved against, so copy 0's names are unchanged and only the other copies
  are rewritten. Two consequences: a function with copies is **not** reported
  `W_AMBIGUOUS_CLOSURE_ENV` and keeps a real `closureEnvOf`, and a function
  whose chains do not align keeps exactly the old behaviour (`closureEnvOf =
  null`, an orphan for the emitter). Where nothing in the function's lexical
  subtree ever names an environment the sites disagree about, the copies would
  be identical text: it is joined instead - one body, one lexical home, no
  warning. See docs/specs/05-emitter.md §6 for what the emitter does with it.
* **A copy is an instance, not a renamed function.** `closureCopies` names the
  environments; it does not name the functions that travel. The emitter derives
  those from `closureCreationSites` inverted by *creating* function: a closure
  created inside a copied function over an environment that function captured
  has its own `closureEnvOf` home outside the copy, and it needs one instance
  per copy rather than a new home. That is why `closureCreationSites` keeps the
  creating function and offset in the key and why it must stay exported even
  though `closureEnvOf` is enough for ordinary placement
  (docs/specs/05-emitter.md §6, report §5 item 1).
* **Copies can create each other.** Restricted to the functions that have
  copies, the "creates" relation (`closureCreationSites` inverted by creating
  function) has strongly connected components: two duplicated functions that
  create each other, or one that creates itself. A copy captured over an
  environment such a group *owns* is hosted inside the group, so it has as many
  homes as that host has instances. The graph only records this; placing a copy
  per instance is the emitter's job (docs/specs/05-emitter.md §6, report §5
  "Landing item 2").
* **`closureCreationSites` is a superset of what the lattice conflicts on, and
  the difference is a known bug.** Copies are built from `closureEnvConflict`
  only. On react-navigation-example fn#13056 has six recorded sites capturing
  six distinct environments with *aligned* chains (`[3141, 1939]`,
  `[3142, 1939]`, `[4511, …]`, …) and `closureEnvOf` is nonetheless the single
  value 3141, so the function is not flagged ambiguous, gets no copies, and the
  five non-chosen sites emit a `_fn13056` that copy 0's home does not have in
  scope. fn#15251 and fn#15275 are the same shape. Anything reading
  `closureEnvOf` to mean "this function has one creation environment" must treat
  that as unproven until the two agree (report §5, "What the 26 remaining
  unbound names actually are").
* **Unequal chains stay ambiguous, by construction.** The remap is positional,
  so `chainOf(e).length !== chain0.length` abandons duplication for that
  function entirely; it keeps `closureEnvOf === null` and becomes an orphan for
  `src/emit/placement.ts` to host by cost. That is the whole of this bundle's
  18-function residual, and the 19 unbound names it produces are not a placement
  defect: no single home can satisfy sites whose environments have no
  correspondence.
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
| CFG-02 | the **non-synthetic** blocks partition `[0, bytecodeSizeInBytes)` with no gaps or overlaps; the §4.5 dispatcher is the only block with `start === -1` | `E_INTERNAL` |
| CFG-03 | `succs` contains no exception edge | `E_INTERNAL` |
| CFG-04 | `preds` is exactly the reverse of all `succs`, deduplicated | `E_INTERNAL` |
| CFG-05 | every block is reachable from `entry` over normal ∪ exception edges | diag `W_UNREACHABLE_BLOCK` **except** in an `era: "opcode"` generator/async body, where it is fatal `E_INTERNAL` — see the note below |
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
| CFG-17 | `era: "opcode"` **and** `suspendPoints.length > 0` ⟹ `resumeDispatch !== null` and `cfg.entry === resumeDispatch` | `E_INTERNAL` |
| CFG-18 | every `suspendPoints[k].resumeBlock` has ≥ 1 predecessor, and one of them is `resumeDispatch` | `E_INTERNAL` |
| CFG-19 | `resumeDispatch`'s case count is `suspendPoints.length + 1` and states are `0..n` with no gaps | `E_INTERNAL` |

**CFG-05's carve-out, and why it is fatal there.** "Dead code after `Ret` is
normal" is the right intuition for an ordinary function and exactly the wrong one
for a v≤96 generator body, where the code after `Ret` is the *most* important
code in the function — it is what the next `.next()` executes. So in an
`era: "opcode"` body an unreachable block is not a curiosity, it means §4.5's
dispatcher was not built and the emitted generator will silently lose its
resume paths. Fail there.

**CFG-12 names only the `*Closure` opcodes, deliberately.** `CreateGenerator`
itself appears at **both** eras — inside the v≤96 trampoline and as the
outer-stub-to-body link at v≥97 (§3.4.1). Do not "tighten" CFG-12 to include it;
that produces a false `E_INTERNAL` on every v≤96 generator.

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

For every gate binary (**249** today: 243 `constructs/*/v{84,94,96,98,99}.hbc`
+ 6 `hermes-dec-sample/*.hbc` — re-derive from the tree) and every function,
snapshot a canonical JSON:
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

### T4 — Generator classification and resume dispatch

* **Two-hop resolution (§3.4.1)** on `23-generator-basic` at v94: the global
  function's `CreateGeneratorClosure r4, r2, fn#1` resolves to
  `trampolineFunctionIndex = 1` (`NCFunction<sequence>`, 3 instructions) and
  `innerFunctionIndex = 2` (`?anon_0_sequence`). At v99 the same source resolves
  through `NCFunction<sequence>`'s `CreateGenerator r1, r1, fn#3` to
  `innerFunctionIndex = 3`. Assert the trampoline itself has
  `suspendPoints.length === 0` — that is the trap S2 describes.
* **Resume dispatch (§4.5)** on `?anon_0_sequence` at v94: exactly **4** suspend
  points at `saveOffset` 11, 25, 39, 57 with `resumeBlock` starting at offsets
  15, 29, 43, 61, all `canonical: true` (each `SaveGenerator` is immediately
  followed by `Ret`); `resumeDispatch !== null`; `cfg.entry === resumeDispatch`;
  the dispatcher has 5 case edges (states 0–4); every resume block has the
  dispatcher as a predecessor; and — the point of the whole exercise —
  **every block has a non-null `idom` (CFG-10) and no block is unreachable**.
* Negative test: build the same CFG with §4.5 disabled and assert CFG-05 fires
  as `E_INTERNAL`, proving the carve-out has teeth.
* v84/v94/v96 `23-…`–`26-…` (generators) and `27-…`–`29-…` (async):
  `era === "opcode"`, `suspendPoints.length > 0`, `resumeDispatch !== null`.
* v98/v99 same fixtures: `era === "lowered"`, `kind` from the header flags,
  `shimRequired === true` on `innerFunctionIndex`, `suspendPoints.length === 0`,
  `resumeDispatch === null`, and **no unreachable blocks** (verified: the v99
  dispatch chain is reached by ordinary branches).
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

For all **241** `vNN.obf.hbc` binaries (`tests/fixtures/OBFUSCATION.md`; count
re-derived after v96 was added), run
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
- [ ] CFG-01…CFG-19 are each exercised by at least one test; the fatal ones have
      a negative test (hand-corrupted input) proving they fire.
- [ ] Exception edges appear in `exceptionSuccs` and **nowhere** in `succs` —
      asserted by a corpus-wide property test, plus a unit test that a dominator
      tree computed with exception edges included would differ (proving the
      separation matters and is real).
- [ ] All T2 byte-anchored numbers match exactly.
- [ ] Generator classification agrees across v94 and v99 for every fixture that
      compiles at both, with different `era` and different evidence.
- [ ] **Every v≤96 generator/async body has a resume dispatcher, every resume
      block is reachable, and every block has an `idom`** — the T4 assertions
      above, for all of 23–29 at v84/v94/v96.
- [ ] Two-hop resolution (§3.4.1) is asserted at both eras; a trampoline is
      never mistaken for a body.
- [ ] `unresolved.length === 0` for every gate binary at every version, with
      `strictEnv: true`.
- [ ] All `.obf.hbc` binaries (241 today) analyse to completion inside budget
      with all invariants holding.
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

---

## 13. Review responses (`docs/specs/REVIEW-03-07.md`)

| Item | Verdict | Where |
|---|---|---|
| **B1** v≤96 generator resume blocks are unreachable; CFG-10 fires, dominators and Ramsey never see the resume code | **Fixed** | New **§4.5**: a synthetic resume-dispatch entry block (the review's option (a)) with `switch`-case edges to the real entry and to every `SaveGenerator` target, verified line-by-line against the v94 dump of `23-generator-basic` quoted in full. New types (`SuspendPoint.state`, `GeneratorShape.resumeDispatch`), new invariants CFG-17/18/19, CFG-02 amended for the synthetic block, **CFG-05 carve-out made fatal** for `era: "opcode"` bodies, T4 rewritten with the measured offsets (suspends 11/25/39/57 → resumes 15/29/43/61) plus a negative test that disables §4.5 and asserts the failure. Option (b) is recorded as considered and rejected, with the reason (it would leave spec 04 §5's isomorphism check nothing to check against) |
| **S2** `innerFunctionIndex` doc-comment gives v≤96 a result, not a procedure | **Fixed** | New **§3.4.1**: the two-hop procedure written as pseudocode, identical at both eras, with the verbatim v94 trampoline (`CreateEnvironment; CreateGenerator r0,r0,fn#2; Ret`) and the v99 equivalent. `trampolineFunctionIndex` added to `FunctionKindInfo`. T4 asserts the trampoline has zero suspend points — the exact silent-failure mode described |
| **S6** CFG-12 could be "tightened" wrongly because `CreateGenerator` exists at both eras | **Fixed** | An explicit note under the invariant table saying so, cross-referencing §3.4.1 |
| **What holds up** (switch model, region carving incl. shared targets, `finally` duplication, obfuscated reducibility) | Acknowledged, unchanged | Recorded so it is not re-litigated |
| B2, S1, S3, S4, S5, N1, N2, N3 | Not this spec's | B2/S3 in spec 05; S1 in spec 04; S4 in specs 05 and 06; S5/N1/N2 in spec 07; N3 in spec 06 |

**Beyond the review.** The corpus gained HBC **96** (`docs/TOOLCHAIN.md`) while
these specs were being written: §1 now states that v96 shares v94's layout class
and opcode numbering (the only difference is `DirectEval`'s third operand), so
`era: "opcode"` spans 84/94/96 and every count in §9 was re-derived (249 gate
binaries, 241 obfuscated).
