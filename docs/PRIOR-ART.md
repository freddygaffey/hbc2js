# Prior art: Hermes bytecode → JavaScript

Survey of every tool we could find that reads Hermes bytecode, of the Hermes compiler
itself, and of the decompilation literature relevant to our CFG→JS step. Concludes with
recommendations and risks for hbc2js.

Date of survey: 2026-08-30. Companion documents: `docs/HBC-FORMAT.md` (our own format
write-up, derived from MIT Hermes sources), `docs/TOOLCHAIN.md` (getting `hermesc`),
`docs/TEST-CORPUS.md` (fixture plan), `docs/RESEARCH-SUMMARY.md` (digest).

---

## 1. hermes-dec (P1sec) — the incumbent

| | |
|---|---|
| Repo | `github.com/P1sec/hermes-dec` |
| Licence | **AGPL-3.0-or-later** |
| Language | Python 3, zero dependencies |
| Stars / activity | ~1150 ★, last push 2026-08-11 — actively maintained |
| Installed here | `hermes-dec 0.1.7`, entry points `hbc-disassembler` / `hbc-decompiler` |
| HBC versions | Generated opcode tables for 51–99 (`hbc51.py` … `hbc99.py`) |
| Produces | Faithful disassembly; "pseudo-code" that is *not* runnable JS |
| Also in | OWASP MASTG (`MASTG-TOOL-0104`) — it is the de-facto standard tool |

### 1.1 What its output actually looks like

Disassembly is excellent and is the right shape for a diff oracle (D3). On
`tests/fixtures/hermes-dec-sample/v94.hbc`:

```
=> [Function #0 "global" of 235 bytes]: 1 params, frame size=16, strict=0,
   exc handler=0, debug info=1  @ offset 0x00000320
==> 00000000: <DeclareGlobalVar>: <string_id: 17>   # String: 'testx' (Identifier)
==> 0000000f: <CreateEnvironment>: <Reg8: 1>
==> 00000011: <CreateAsyncClosure>: <Reg8: 2, Reg8: 1, function_id: 1>
==> 00000018: <PutById>: <Reg8: 0, Reg8: 2, UInt8: 1, string_id: 17>
```

The **decompiler** output is a register-machine transliteration wrapped in a
`for(;;) switch(ip)` dispatcher — exactly the fallback our SPEC reserves for
*irreducible* CFGs, applied unconditionally:

```js
r2 = function* () { // Original name: gen, environment: r1
    r0 = function* () { // Original name: ?anon_0_gen, environment: r0
        _fun5: for(var _fun5_ip = 0; ; ) switch(_fun5_ip) {
case 0:
            StartGenerator();
            ResumeGenerator(result_out_reg=0, return_bool_out_reg=1);
            if(r1) { _fun5_ip = 176; continue _fun5 }
case 14:
            r1 = 42;
            SaveGenerator(address=21);
case 19:
            return r1;
case 30: // try_start_0 // try_start_1
            r4 = global;
            r5 = r4.bind(r2)();
case 52: // catch_target0
            CatchBlockStart(arg_register=4);
            ...
```

### 1.2 Measured shortfalls on our fixtures

Both files decompile without crashing (v99 emits four `pass4: … references unknown
register` warnings). Both outputs *pass* `node --check` — and both die immediately when
executed:

```
$ node v94.dec.js
TypeError: Cannot set properties of undefined (setting 'onload')   [line 182]
$ node v99.dec.js
TypeError: Cannot set properties of undefined (setting 'onload')   [line 396]
```

Counting structure recovery in the emitted files:

| | v94.dec.js | v99.dec.js |
|---|---|---|
| lines | 215 | 428 |
| `for(;;) switch(ip)` dispatchers | 4 | 4 |
| `case` labels | 34 | 81 |
| `while` loops recovered | **0** | **0** |
| `try {` recovered | **0** | **0** |
| `yield` recovered | **0** | **0** |

Specific defects, all of which hbc2js must not reproduce:

1. **No control-flow structuring at all.** Its own README says the output "is not valid
   JavaScript yet as it does not retranscribe loop/conditional structures". Confirmed:
   zero loops, zero `try`.
2. **Pseudo-instructions leak into the output**: `StartGenerator()`,
   `ResumeGenerator(result_out_reg=0, …)`, `SaveGenerator(address=21)`,
   `CatchBlockStart(arg_register=4)`, `CompleteGenerator()` — none of these are JS.
3. **`global` is emitted as a bare identifier**, and assignments to undeclared names
   (`testx = undefined;`) make the output strict-mode-hostile.
4. **Calls are modelled as `callee.bind(thisArg)(args)`.** That is observably wrong: it
   allocates a new function object per call, breaks `Function.prototype.toString`, breaks
   identity comparisons on the callee, and re-evaluates the receiver. `Reflect.apply`
   or a `(0, obj.m)(…)`/`obj.m(…)` split is the correct lowering.
5. **Unresolved environment slots.** v99 output references `_closure1_slot1` and
   `_env_r8_slot0` that are never declared → `ReferenceError` even before semantics.
6. **v99 debug-offset misparse.** It prints a 2-field `DebugOffsets` for v99, but static
   Hermes shrank the struct to a single `uint32`; the "scope_desc_data" values it prints
   (`0x444`, `0x47b`, `0x6d8`) are the *next function's bytecode offsets*. See
   `docs/HBC-FORMAT.md` §4.
7. **No generator/async recovery.** Both the v94 `SaveGenerator`/`ResumeGenerator` form
   and the v99 explicit state-machine form come out as switch soup.

### 1.3 Licence position

AGPL-3.0. Under `docs/DECISIONS.md` D4 we **must not copy any of its code**, must not
port its algorithms line-for-line, and must not vendor its generated opcode tables (they
are AGPL-licensed derived files even though the underlying `.def` is MIT). What *is*
fine: running it and reading its *output*. We use it as a disassembly oracle only, and we
generate our own opcode tables from `BytecodeList.def` at pinned Hermes commits.

**Practical rule for implementation agents:** you may run `hbc-disassembler` and diff its
text against ours. You may not open `site-packages/hermes_dec/**`.

---

## 2. The rest of the field

### 2.1 hbctool — `github.com/bongtrop/hbctool`

MIT, Python, ~640 ★, last push **2023-12-10** (effectively dormant). Disassembler **and
assembler** — its purpose is patch-and-repack for pentesting, not decompilation.
Supports only **HBC 59, 62, 74, 76**; its own TODO lists "add the other Hermes bytecode
versions". Useless for v84/v94/v99. Its permissive licence and its round-trip
(disassemble → edit → assemble) test discipline are the interesting parts.

### 2.2 hasmer — `github.com/lucasbaizer/hasmer`

MIT, C#/.NET, 42 ★, **archived 2024-10-17**. Defines "Hasm", a textual assembly language
for Hermes, and assembles it back to bytecode. Claims a decompiler to JavaScript, but it
is incomplete and the project is dead. Value to us: the *idea* of a stable textual
assembly form as a testing intermediate, and a permissive licence if we ever want to
read its structuring approach.

### 2.3 hermes_rs — `github.com/Pilfer/hermes_rs`

MIT (per `Cargo.toml`; no `LICENSE` file at repo root), Rust, ~180 ★, last push
2026-02-09, crate `hermes_rs` v0.1.14. **Disassembler + binary assembler only** — the
README's own matrix marks the Decompiler column ❌ for every version, and the roadmap
says "eventually a halfway decent decompiler, but that may be another project". Supports
v76, 84, 89, 90, 93, 94, 95, 96 as cargo features. Notably it does **not** implement
regexp or debug-info deserialisation. Author also sells a closed-source product
("Bytecode Studio"). Reusable: the licence is permissive, and its per-version feature
split is a good architectural model, but there is no structuring work to borrow.

### 2.4 hermes-dec-rs — `github.com/kroo/hermes-dec-rs`

Dual **MIT / Apache-2.0** (`LICENSE-MIT` + `LICENSE-APACHE`; GitHub reports
`NOASSERTION` because there are two), Rust, small (5 ★), last commit 2026-03-31.
This is the closest project in *intent* to hbc2js: "Parse all HBC versions ≥ 80
(RN 0.72+)", CFG construction, SSA, "raise to high-level constructs (`if/else`, loops,
`try/catch`, `switch`)", emitting an **OXC** AST and pretty-printing JS. The repo
contains a large amount of in-progress analysis (`switch_issues_analysis.md`,
`duplicated_ssa_design.md`, `issue_root_causes.md`) which is candid about where its
structurer breaks. Permissively licensed and therefore **the one project we could
legally port from**.

### 2.5 hermes-decomp — `github.com/SymbioticSec/hermes-decomp`

**MIT**, Rust, ~160 ★, created 2026-01-27, last push 2026-08-19 — the most active new
entrant. Supports **HBC 40–99**. Pipeline: parse → disassemble → CFG/structuring →
"readable JavaScript" with constant propagation, closure resolution, and pattern
detection for generators, async and classes. Ships a large RE toolbox around the
decompiler (`xref`, `callgraph`, `tui`, `bin-diff`, `graphviz`, `modules`/`deps`,
`secrets`, `frida-hooks`, Metro module splitting) plus an MCP server. Was exercised on
CTF challenges at Insomnihack 2026.
**Crucially it does not claim runnable output**: its own README says the write-side tools
"patch bytecode / HASM. They do **not** recompile decompiled JavaScript." So it targets
*human-readable*, not *semantically equivalent*. That is precisely the gap SPEC.md
claims — the gap is narrower than it was in 2024, but it is still there.

### 2.6 droidsaw-hermes — `github.com/droidsaw/droidsaw-hermes`

**BSD-3-Clause**, Rust, part of the `droidsaw` Android-analysis workspace, last push
2026-06-11. Architecturally the single most relevant project to read (and, licence-wise,
the easiest to borrow ideas from with attribution). Its documented pipeline is almost
exactly the one SPEC.md sketches, one stage deeper:

```
parse → decode → cfg → ssa (Braun et al. 2013, iterative)
      → optimize (copy prop, const fold, DCE, name recovery from LoadParam/GetById/CreateClosure)
      → structure (region-based; post-dominators)
      → sugar (flatten_early_returns, recover_switch, recover_for_in, recover_try_catch,
               recover_destructuring, recover_class, linearize_async, strip_tdz_traps)
      → emit (Region IR → JS via oxc_codegen)
      → verify (syntactic via OXC; semantic via verify_body)
```

Its correctness story is the strongest of any project surveyed and independently
validates our `docs/DECISIONS.md` D3:

* a `hermesc(src.js) → parse → decompile_bundle → hermesc` **fixture ratchet** over 36
  language-surface fixtures, with `SEMANTIC_FAIL` pinned at 0 and `COMPILE_FAIL`
  monotonically decreasing; a fixture flip blocks merge;
* byte-identical parse/emit round-trip proptests (`HbcFileEquiv<V84|V96|V98|V99>`);
* nine libFuzzer targets including differential parser/CFG oracles;
* an adversarial corpus for hostile headers (count amplification, bigint bombs,
  out-of-range overflow strings).

It also independently confirms the two format hazards we found by hand: five
layout-equivalence classes for the header, and "v98 ships in two incompatible header
layouts … both are detected at load".

### 2.7 Also-rans

| Project | Licence | Lang | State |
|---|---|---|---|
| `moleium/talaria` | MIT | C++23 | Disassembler + pseudocode generator, 2 ★, last push 2025-12 |
| `niosega/hermes-decompiler` | GPL-3.0 | C | Abandoned 2021; GPL makes it uninteresting anyway |
| `vickz84259/hbcdecomp` | MIT | Rust | "Attempt at writing a decompiler", abandoned 2021 |
| `volesen/hermes-disassembler` | none stated | — | 2022, toy |
| `xyxdaily/hermes-dec-reverse` | AGPL (fork) | Python | Fork of hermes-dec; inherits AGPL |
| JEB Decompiler | commercial, closed | — | Has Hermes support; expensive; not a source of reusable anything |
| "Bytecode Studio" | commercial, closed | — | From the hermes_rs author |

**Nobody in this field ships an execution-equivalence test suite for decompiled output.**
droidsaw-hermes comes closest (recompile-and-compare); everyone else stops at "it looks
like JavaScript". That is where hbc2js can be genuinely novel, and it is what
`docs/DECISIONS.md` D2 already commits us to.

---

## 3. Facebook Hermes itself (MIT) — the ground truth

Repo `github.com/facebook/hermes`, MIT. Under D4 this is the only source we may derive
tables from. The files that matter and how the format evolved are documented in
`docs/HBC-FORMAT.md`; the summary of the *version history* is:

### 3.1 Two lineages

* **`main` — classic Hermes**, frozen at `BYTECODE_VERSION = 96` (bumped 2023-08-29 for
  the RegExp `hasIndices` flag). Everything React Native shipped through the 0.7x line.
* **`static_h` — Static Hermes**, 97 (2024-05-24) → 98 (2024-08-30) → 99 (2026-02-12,
  re-affirmed 2026-03-05). This became the new stable line
  (`hermes-compiler@260318099.0.0`, announced 2026-06-05, whose release notes say
  "Bytecode version changed (98 → 99)"). **Static Hermes absolutely changes the format**
  — see §3.3.

### 3.2 Opcode-table evolution (derived by parsing `BytecodeList.def` at each version-bump commit)

| Version | Opcodes | Change |
|---|---|---|
| 83 → 84 | 185 → 185 | no opcode change; the v84 bump added the **function source table** to the file header (and `padding[27]`) |
| 85 | 187 | `+Inc`, `+Dec` |
| 86 | 187 | builtins-list change only (`ArrayBuffer.isView` dropped) |
| 87 | 190 | `+LoadConstBigInt`, `+LoadConstBigIntLongIndex`, `+ToNumeric`; **header gains `bigIntCount` + `bigIntStorageSize`**, padding 27 → 19 |
| 88 | 190 | `BigInt::inc` semantics only |
| 89 | 190 | **no opcode change** — non-deterministic functions removed from the static-builtins list (so *builtin numbering* shifts) |
| 90 | 190 | RegExp named groups (regexp bytecode only) |
| 91 | 190 | TextifiedCallee debug-info table (`DebugInfoHeader` gains a field) |
| 92 | 192 | `+CreateInnerEnvironment`, `+ThrowIfHasRestrictedGlobalProperty` (block scoping) |
| 93 | 190 | block scoping **reverted** |
| 94 | 192 | block scoping **re-landed** — v94 ≡ v92 opcode-wise |
| 95 | 192 | `DirectEval` gains an `isStrict` `UInt8` operand |
| 96 | 192 | RegExp `hasIndices` flag; no opcode change |

Between v84 and v96 the **function header layout never changed** (16-byte
`SmallFuncHeader`, same bit widths). The only header-level change is the BigInt pair at
v87. That makes a v84↔v94↔v96 parser cheap to share.

### 3.3 Static Hermes: 96 → 97 → 98 → 99

This is a much bigger break than the version delta suggests.

**v97** (197 opcodes) — the pivotal one for a decompiler:
* **Generators and async stop being VM primitives.** `StartGenerator`,
  `ResumeGenerator`, `CompleteGenerator`, `SaveGenerator[Long]`,
  `CreateGeneratorClosure[LongIndex]`, `CreateAsyncClosure[LongIndex]` are all
  **removed**. Generator/async-ness moves into a 2-bit `kind` field in the function
  header flags (`FuncKind::{Normal, Generator, Async}`), and the body is lowered by the
  compiler into an explicit state machine (§6.2).
* **Environments become explicit and first-class.** `CreateEnvironment` gains
  `(parentEnvReg, size)`; new `CreateFunctionEnvironment`, `CreateTopLevelEnvironment`,
  `GetParentEnvironment`, `GetClosureEnvironment`; `GetEnvironment` gains a start-env
  operand. `environmentSize` leaves the function header.
* **Strict/loose splits everywhere**: `PutById` → `PutByIdLoose`/`PutByIdStrict`,
  likewise `TryPutById`, `PutByVal`, `DelById`, `DelByVal`, `ReifyArguments`,
  `GetArgumentsPropByVal`.
* `PutOwnBySlotIdx[Long]`, `AddS`, `GetByIndex`, `CallWithNewTarget[Long]`;
  `CallDirect*`, `CallLong`, `ConstructLong` removed.
* Object literals move to the **shape table**: `NewObjectWithBuffer` goes from
  `(dest, sizeHint, numProps, keyBufIdx, valBufIdx)` to `(dest, shapeIdx, valBufOffset)`.
* File header: `arrayBufferSize` → `literalValueBufferSize`,
  `objValueBufferSize` → `objShapeTableCount`.
* `SmallFuncHeader` shrinks 16 → 12 bytes; `infoOffset` is deleted (the overflow flag now
  carries the info offset) and the info block becomes *optional*.

**v98** (201) — `+GetOwnBySlotIdx[Long]`, `+TypedLoadParent`, `+TypedStoreParent`.

**v99** (219, then **220**) — the class/private-field/fast-array release:
`NewFastArray`, `FastArrayLength/Load/Store/Push/Append`, `CreateBaseClass*`,
`CreateDerivedClass*`, `CreateThisForNew`, `CreateThisForSuper`, `ThrowIfThisInitialized`,
`CreatePrivateName`, `AddOwnPrivateBySym`, `GetOwnPrivateBySym`, `PutOwnPrivateBySym`,
`PrivateIsIn`, `DefineOwn*` (replacing `PutNewOwn*`/`PutOwn*`), `GetByValWithReceiver`,
`PutByValWithReceiver`, `TypeOfIs`, `JmpTypeOfIs`, `JmpBuiltinIs[Not][Long]`,
`ToPropertyKey`, `ToUint32`, `CallRequire` (a Metro-`require` fast path),
`UIntSwitchImm` + `StringSwitchImm` (replacing `SwitchImm`), and the removal of the
`J*GreaterN`/`J*GreaterEqualN` numeric-jump family. Header gains `numStringSwitchImms`;
`FUNC_HEADER_FIELDS` is reshaped (`ParamCount` 7→5 bits, `+LoopDepth`,
`+NumberRegCount`, `+NonPtrRegCount`, `+PrivateNameCacheSize`, `FunctionName` 17→8 bits).

**Two traps, both verified against bytes** (details and byte dumps in
`docs/HBC-FORMAT.md` §0 and §11.2):

1. The v99-shaped header landed *before* the version bump — so **v98 exists in two
   incompatible header layouts**.
2. `NewTypedObjectWithBuffer` was inserted at **opcode index 4** after the v99 bump
   without a further bump — so **v99 exists in two incompatible opcode tables**, and
   both our v99 fixtures — the original and one compiled here from public
   `hermes-compiler@260318099.0.1` — need the *later* (220-opcode) one.

### 3.4 Getting a compiler

Already solved in parallel — see `docs/TOOLCHAIN.md` and `tools/get-hermesc.sh`.
Summary: prebuilt `hermesc` ships on npm, HBC 84 ← `hermes-engine-cli@0.8.1`,
HBC 94 ← `react-native@0.72.17` (`sdks/hermesc/`), HBC 99 ← `hermes-compiler@260318099.x`.
v94 recompiles **byte-identically**, so D3's recompile-diff oracle is viable today.

---

## 4. Structuring literature

Our problem is: an arbitrary reducible-or-not CFG over a **register** machine (no operand
stack) must become structured ES2022. The relevant bodies of work:

### 4.1 Classical decompiler structuring

* **Cifuentes, *Reverse Compilation Techniques* (PhD, 1994)** and *Structuring Decompiled
  Graphs* (CC'96). Interval analysis + a fixed catalogue of patterns (pre-tested loop,
  post-tested loop, 2-way, n-way). Anything unmatched becomes a `goto`. This is the
  ancestor of every "structural analysis" decompiler.
* **Phoenix — Brumley et al., "Native x86 Decompilation Using Semantics-Preserving
  Structural Analysis and Iterative Control-Flow Structuring", USENIX Security 2013.**
  Adds *iterative refinement*: when no pattern matches, insert a minimal `goto`/virtualised
  edge and retry, instead of giving up on the whole region. Introduces the
  semantics-preservation discipline we want.
* **DREAM — Yakdan et al., "No More Gotos: Decompilation Using Pattern-Independent
  Control-Flow Structuring and Semantics-Preserving Transformations", NDSS 2015**
  (and DREAM++, IEEE S&P 2016). Instead of matching a fixed catalogue, it derives
  *reaching conditions* for every node from the dominator tree and builds a condition-aware
  AST, then simplifies the boolean formulas. Produces **goto-free** output for arbitrary
  reducible CFGs. This is the single most applicable paper to us because our target
  language (JS) has no `goto` at all.
* **SAILR — Basque et al., "Ahoy SAILR! There is No Need to DREAM of C: A Compiler-Aware
  Structuring Algorithm for Binary Decompilation", USENIX Security 2024.** The important
  correction to DREAM: goto-free is not the goal; *resembling the original source* is.
  SAILR inverts specific goto-inducing compiler transformations. Their measurement shows
  17% of spurious gotos come from compiler optimisations even at `-O0`. Implemented in
  the angr decompiler; open source.

### 4.2 The CFG→structured-language line (directly on point, because JS *is* the target)

* **Relooper — Zakai, "Emscripten: an LLVM-to-JavaScript compiler", OOPSLA 2011.**
  The canonical algorithm for turning an arbitrary CFG into JS loops/ifs/labelled
  `break`/`continue`, using multiple-entry "multiple" blocks and a `__label__` variable
  where necessary. Its degenerate case is *exactly* our SPEC's `for(;;) switch(ip)`
  fallback.
* **Stackifier** (LLVM's `WebAssemblyCFGStackify.cpp`) and Binaryen's Relooper — the
  production descendants. They handle irreducibility by node splitting or by a dispatch
  loop.
* **Ramsey, "Beyond Relooper: recursive translation of unstructured control flow to
  structured control flow (functional pearl)", ICFP 2022** (PACMPL 6, art. 90).
  Reimplements Peterson–Kasami–Tokura in a single recursive pass over the dominator tree
  with immutable data. **This is the cleanest thing to implement.** It is provably total
  (it always produces structured output, using labelled multi-level breaks and, only for
  irreducible regions, node duplication or a dispatch variable), it is ~200 lines, and its
  output shape — nested blocks + labelled breaks + `if`/`loop` — maps 1:1 onto JS
  `label: { … break label; }`, `while(true)`, `if`.

### 4.3 Production decompilers

* **Ghidra** — `blockaction.cc`: iteratively collapses a "block graph" by matching
  structured shapes; unmatchable edges are turned into `goto`s and the graph is retried
  until a fixed point. Pragmatic, well-tested, and the source is public-domain-ish (Apache
  2.0) if we want to read it.
* **Hex-Rays** — interval/structural analysis with a goto fallback; closed source. Its
  observable behaviour (prefer `while`, hoist loop-invariant conditions, sink common
  tails) is a good spec for what "good output" means.

### 4.4 Dynamic-language decompilers (nearest neighbours)

* **Lua** (`unluac`, `luadec`) — register-based like Hermes, and the same problems: no
  types, closures via upvalue indices, no source names. `unluac`'s approach is a
  per-block "declaration" pass that decides where a register's live range begins, which is
  how it turns registers into named locals. We need the same pass.
* **Dalvik/Android** (`jadx`, `dex2jar`+CFR/Procyon, `dare`) — register-based, and the
  closest thing to a solved problem for `try`/`catch`/`finally` from a *handler table*.
  Two techniques worth stealing: (a) build exception edges as a separate predecessor map
  so they never pollute the dominator tree used for the main structuring, then re-attach
  handlers as `try` regions; (b) recover `finally` by detecting the *duplicated* handler
  body that the compiler inlined into every exit path, and de-duplicating it.
* **JVM decompilers (CFR, Procyon)** — the reference for `try/finally` de-duplication and
  for generator/`async` state-machine recovery in the Kotlin/Scala world (`CFR` reverses
  Kotlin coroutine state machines by recognising the `label` switch). Directly analogous
  to our v99 problem (§6.2).

### 4.5 Recommendation for hbc2js's structurer

**A three-tier structurer, with a provable floor.**

1. **Tier 0 — the floor (implement first).** Ramsey's ICFP-2022 recursive translation over
   the dominator tree, producing nested `label: { }` blocks, `while(true)`, `if`, and
   multi-level `break`/`continue`. It is total: it always succeeds, on reducible *and*
   irreducible graphs, and it never needs `goto`. This replaces SPEC's
   `for(;;) switch(ip)` as the fallback — it is just as correct but produces vastly better
   output, and it removes the need to *detect* irreducibility before deciding a strategy.
   Keep `for(;;) switch(ip)` only as a tier-(-1) escape hatch behind a flag, for debugging
   a miscompiled region.
2. **Tier 1 — pattern raising.** On top of tier 0's tree, run peephole passes that turn
   `while(true){ if(!c) break; B }` into `while(c) B`, recover `for` headers from
   loop-invariant init/update, collapse `if(c) break;`-chains, flatten early returns, and
   turn a `UIntSwitchImm`/`StringSwitchImm` dispatch into a real `switch` with
   fall-through. These are all *syntactic rewrites on an AST we already trust*, so each one
   is individually testable and individually revertible.
3. **Tier 2 — condition-aware structuring (later, optional).** DREAM-style reaching
   conditions to eliminate the residual duplicated tests that tier 1 cannot merge. Only
   worth doing once tiers 0–1 are green on the fixture suite; SAILR's finding (readability
   ≠ goto-freedom) suggests the marginal value is low for our "runnable, not pretty" goal.

Rationale: our acceptance criterion is *behavioural equivalence*, not resemblance to the
lost source. That inverts the usual decompiler trade-off — we should pick the algorithm
with the strongest totality guarantee and layer beautification on top, rather than pick a
heuristic structurer and bolt on a correctness fallback. Ramsey's algorithm is the only
one in the literature that is both total and simple enough to audit.

Exceptions are structured **separately and first**: build the CFG with exception edges in
a side map (Dalvik-style), compute `try` regions directly from the handler table (they are
contiguous pc ranges, which is a gift), emit `try { … } catch (e) { … }` around the region,
and only then run tier 0 on the interior. Never let an exception edge into the dominator
computation.

---

## 5. SSA, registers and names

Hermes is register-based with a fixed `frameSize` per function and no operand stack, so:

* Registers are **not** SSA. Build SSA (Braun et al., *Simple and Efficient Construction of
  SSA Form*, CC 2013 — the on-the-fly algorithm, iterative to avoid stack overflow on long
  bundles) so copy propagation and constant folding can collapse the
  `r5 = 'x'; r5 = r6 + r5` chains into expressions.
* Then run a **live-range → variable** pass (unluac-style): each SSA value that survives a
  block boundary becomes a `let`; values with a single use in the same block get inlined
  into the expression. This is what turns 40 lines of `rN = …` into one line of JS.
* **Do not attempt name recovery** (SPEC out-of-scope). But do use the *free* names:
  `functionName` in the function header, identifier strings behind `GetById`/`PutById`,
  and — when `hasDebugInfo` — line numbers as comments. `functionSourceTable` even gives
  the *original source text* for a few functions; emit it verbatim when present.

---

## 6. Hermes-specific hard cases

### 6.1 Closures and environments

**v≤96.** `CreateEnvironment <envReg>` allocates a scope of `environmentSize` slots (size
comes from the *function header*, not the instruction). `GetEnvironment <dst>, <levels>`
walks *N* levels up the static chain. `LoadFromEnvironment <dst>, <env>, <slot>` /
`StoreToEnvironment <env>, <slot>, <val>` (plus `StoreNPToEnvironment` for non-pointer
values — same semantics, a GC write-barrier hint only, treat identically).
`CreateClosure <dst>, <envReg>, <functionId>` binds a function-table entry to an
environment.

**v≥97.** Environments are explicit values: `CreateFunctionEnvironment <dst>, <size>`
(parent = the current function's enclosing env), `CreateTopLevelEnvironment <dst>, <size>`
(no parent), `CreateEnvironment <dst>, <parentEnvReg>, <size>`,
`GetParentEnvironment <dst>, <levels>`, `GetClosureEnvironment <dst>, <closure>`,
`GetEnvironment <dst>, <startEnv>, <levels>`.

**Reconstruction plan.** Model an environment as a JS object with numbered slots and
recover real lexical scoping:

1. Build an *environment graph*: nodes = `Create*Environment` sites, edges = parent links,
   annotated with which function-table index each `CreateClosure`/`CreateGenerator` binds.
2. For each `(env, slot)` pair, collect every load/store across every function. If all
   accesses come from one function and its lexical descendants — which is the normal case —
   the slot is an ordinary captured `let` and can be emitted as a JS closure variable
   declared in the enclosing function. Nesting the emitted functions correctly is then
   sufficient; no explicit environment object is needed.
3. Only when a slot is accessed through an env obtained dynamically
   (`GetClosureEnvironment` on a value, or a `GetEnvironment` whose depth we cannot
   resolve statically) fall back to a materialised `const _env3 = {s0: …}` object.

Failing at step 2 is what produces hermes-dec's dangling `_closure1_slot1` /
`_env_r8_slot0`. Make step 2 a hard error rather than emitting an undefined name.

### 6.2 Generators and async — two completely different problems

**v≤96 (the VM does the work).** `CreateGeneratorClosure`/`CreateAsyncClosure` make the
outer function; a nested "inner" function contains the body and uses
`StartGenerator` (entry trampoline), `ResumeGenerator <resultReg>, <isReturnReg>`
(delivers `next(v)` / `return(v)` / rethrows for `throw(v)`),
`SaveGenerator <addr>` (suspend, resume at `addr`), and `CompleteGenerator`.
Async is generator + the `spawnAsync` builtin (`GetBuiltinClosure` #52 in v94, then
`Call4 spawnAsync, undefined, innerGen, this, arguments`).

Recovery: a `SaveGenerator L` immediately followed by `Ret r` **is** `r = yield <value>`,
where the resumed value arrives at `L` via the next `ResumeGenerator`. The pairing is
syntactically local, so a peephole pass over the block graph can rewrite
`SaveGenerator/Ret/…/ResumeGenerator` triples into a single `yield` expression, then
delete `StartGenerator`/`CompleteGenerator` and mark the function `function*`. Async
functions are then `async function` bodies with `await` where the generator yielded, once
the `spawnAsync` wrapper is recognised and elided.

**v≥97 (the compiler does the work — much harder).** There are no generator opcodes at
all. Our `v99.hbc` fixture shows what static Hermes emits for `function* gen()`:

* an *outer* stub, function header `kind = Generator`, which allocates an environment,
  zeroes three state slots, and returns `CreateGenerator <dst>, <env>, <innerFnId>`;
* an *inner* body (489 bytes for a 20-line generator) that is a **explicit state machine**:
  a state variable in an environment slot, a chain of `JStrictEqual`/`JStrictEqualLong`
  dispatch tests at the top, `NewObjectWithBuffer` producing `{value, done}` result
  objects, `Throw` for the `throw()` path, and `Unreachable` stubs.

Two strategies, and we should implement **A first**:

* **Strategy A — runtime shim (correct, ugly, cheap).** Emit the inner function verbatim
  as a plain function `function _gen_body(action, value, state)` structured by tier 0, and
  emit `CreateGenerator` as a call to a small hand-written runtime helper
  `__hbc_makeGenerator(_gen_body, env)` that implements the `next`/`return`/`throw`
  protocol by driving the state machine. This is *provably* behaviour-preserving because
  it is what the VM does, it needs no pattern recognition, and it makes the v99 fixture
  pass D2's trace test. The cost is that the output contains a helper and no `yield`.
* **Strategy B — state-machine inversion (pretty, expensive).** Recognise the dispatch
  chain, map each state constant to a resume point, and re-derive `yield`. This is exactly
  what CFR does for Kotlin coroutines. Defer it; it is a v2 feature and it is where every
  other tool in §2 currently fails.

**Consequence for the plan:** v94 and v99 need *different* generator front-ends. Do not
let an implementation agent assume one path. Budget for this explicitly in M4.

### 6.3 try/catch/finally

Handler table entries are `(start, end, target)` pc ranges (see `docs/HBC-FORMAT.md` §4).
They nest and overlap; innermost-first in file order. The handler block begins with
`Catch <reg>`.

* `try`/`catch` maps directly: the range is contiguous, so it is a *region* in the CFG and
  can be structured independently.
* **`finally` is not represented.** Hermes duplicates the finally body into the normal
  path and into a synthesised catch-and-rethrow handler. Recovering it requires detecting
  the duplicate block pair (identical instruction sequences reachable from a normal exit
  and from a handler that ends in a rethrow). Until that pass exists, emitting
  `try { … } catch (e) { <dup body>; throw e; } <dup body>` is **correct** — just verbose.
  Make correctness the default and the de-duplication an optimisation.
* Our v94 sample has 3 handlers on one function and the v99 sample has 5 (with four of
  them sharing one target) — nested `try` inside `catch` inside a generator. This is a good
  stress case and it is already in the corpus.

### 6.4 `switch`

`SwitchImm` (v≤96) / `UIntSwitchImm` (v99): dense integer jump table appended after the
function's opcodes, 4-aligned, entries `int32` relative to the switch's own pc, with
`min`/`max` bounds and a default target. `StringSwitchImm` (v99) uses
`(stringId, target)` pairs. No compiled fixture exercises these yet, so **we have no ground truth for switch**;
`tests/fixtures/constructs/09-switch-fallthrough` and `10-switch-no-fallthrough` supply
it once compiled (§7.4). Recovery is easy relative to everything else: the
table gives you the case values and targets directly; the only subtlety is fall-through,
which shows up as a case block with no terminator branching to the next case's block.

### 6.5 Regex, BigInt, strings

* **Regex**: `CreateRegExp <dst>, <patternStrId>, <flagsStrId>, <regexpTableIdx>` carries
  the source pattern and flags as *strings*. Ignore `regExpStorage` entirely and emit
  `new RegExp(pattern, flags)`. Emitting a `/…/flags` literal is only safe if the pattern
  contains no unescaped `/` and no newline; prefer the constructor and let a beautifier
  pass decide.
* **BigInt**: `bigIntTable` + `bigIntStorage`, little-endian two's-complement magnitude,
  loaded by `LoadConstBigInt[LongIndex]`. **Untested by any compiled fixture** — the
  BigInt lines in `tests/fixtures/hermes-dec-sample/source.js` are commented out.
  `tests/fixtures/constructs/46-bigint-arithmetic` covers it once compiled.
* **Strings**: two axes. (a) *Kind* — Identifier vs String, an RLE table; identifiers are
  property/global names and may be emitted unquoted, plain strings must be quoted.
  (b) *Encoding* — ASCII/Latin-1 vs UTF-16LE, per entry, with `length` in **characters**.
  Unpaired surrogates are legal in the table and must survive the round trip: decode to a
  JS string leniently and re-emit with `\uXXXX` escapes for anything non-printable or
  lone-surrogate. Our v94 fixture already contains a narrow no-break space (U+202F) and a
  literal NUL inside the regexp pattern — good.

### 6.6 Calls

`Call<N>`/`Call` place arguments in consecutive registers ending at the top of the frame,
with `thisArg` first. The correct JS lowering is `Reflect.apply(callee, thisArg, [args])`
in the general case, or the direct `obj.m(a, b)` form when the callee register was
produced by a `GetById`/`GetByIdShort` on the very register used as `thisArg` (the
overwhelmingly common case). **Do not use `callee.bind(thisArg)(…)`** — see §1.2, defect 4.
`CallBuiltin` reads its arguments in reverse from the frame top and always passes
`undefined` as `this`.

---

## 7. Recommendations

### 7.1 Reuse

| Thing | Verdict |
|---|---|
| MIT Hermes `BytecodeList.def`, `BytecodeFileFormat.h`, `BytecodeStream.cpp` | **Use as the sole source of truth.** Generate opcode/operand tables from pinned commits; record the commit SHA in the generated file. |
| `tools/get-hermesc.sh` / npm `hermesc` builds (`docs/TOOLCHAIN.md`) | **Already adopted.** Unblocks D3 round-trip and lets us mint fixtures for the missing features. |
| hermes-dec | **Behaviour oracle only** (disassembly text diff). Never read or copy its source (AGPL). |
| `droidsaw-hermes` (BSD-3) | **Read for architecture and, above all, for its test strategy** — the hermesc fixture ratchet, `HbcFileEquiv` round-trip proptests, and differential fuzzing are directly portable ideas. Attribute if we port code. |
| `hermes-dec-rs` (MIT/Apache-2.0) | Readable and portable; its published post-mortems on switch/SSA bugs are cheap lessons. |
| `hermes-decomp` (MIT), `hermes_rs` (MIT), `hbctool` (MIT), `hasmer` (MIT, archived) | Permissive; useful for cross-checking opcode semantics and for their disassembly text. |
| Ramsey ICFP'22 relooper | **Implement this as the structurer core.** |
| Braun et al. CC'13 SSA | Implement for the expression-rebuilding pass. |
| `niosega/hermes-decompiler` (GPL-3), `xyxdaily/hermes-dec-reverse` (AGPL fork) | **Avoid entirely.** |
| JEB, Bytecode Studio | Closed source; not usable, not comparable. |

### 7.2 Proposed structuring strategy (restating D6)

Supersede SPEC's "irreducible → `for(;;) switch(ip)`" with:

> **D7 (proposed): the structurer is Ramsey's recursive CFG→structured translation over
> the dominator tree, producing labelled blocks + `while(true)` + `if` + multi-level
> `break`/`continue`. It is total, so there is no separate irreducible path. Readability
> passes (`while(c)`, `for`, `switch`, early-return flattening) are AST rewrites layered
> on top and are individually testable. `for(;;) switch(ip)` is retained only as a debug
> escape hatch.**

Exception regions are carved out *before* structuring from the handler table; exception
edges never enter the dominator computation.

### 7.3 Sequencing

1. **M1 first, versioned from day one.** Parser with the five layout classes of
   `docs/HBC-FORMAT.md` §0.1 and a *layout probe*, not a version switch.
2. **M2 disassembler + hermes-dec text diff** on both fixtures — cheap, high-confidence.
3. **M3 get `hermesc`** from npm and stand up both oracles (D2 trace, D3 recompile) before
   writing a line of the structurer.
4. **M4 structurer**: tier 0 → fixtures pass with ugly-but-correct output → tier 1 passes,
   each gated on the trace suite staying green.
5. Generators: v94 pattern-recovery path and v99 **runtime-shim** path, in that order.

### 7.4 Corpus gaps

`tests/fixtures/constructs/` (51 single-construct programs, authored in parallel — see
`docs/TEST-CORPUS.md`) already covers the language surface that the two sample fixtures
miss: `switch` with and without fall-through, `for…in`/`for…of`, labelled
break/continue, `try/finally` in all four shapes, classes including private fields and
`super`, destructuring, spread/rest, tagged templates, BigInt arithmetic, optional
chaining, async generators, generator `return`/`throw`/delegation, TDZ. That closes the
*language* gap. What remains:

1. **Compile them.** They exist only as `source.js` + `expected.txt`; nothing is compiled
   to `.hbc` yet. Compiling each at v84/v94/v99 is what actually exercises the
   format paths that are `0` in both sample fixtures: `literalValueBuffer` /
   `objKeyBuffer` / `objShapeTable` / `arrayBuffer` (object and array literals),
   `bigIntTable`, and the `SwitchImm` / `UIntSwitchImm` / `StringSwitchImm` jump tables.
   **Until that happens the entire serialized-literal and jump-table code path in our
   parser will be written blind.** Do it before M4.
2. **A `-O` variant of each fixture**, to exercise bytecode dedup (shared function
   offsets), `AddN`/`MulN` numeric fast paths, and the register-allocation shapes the
   optimiser produces. Shipped bundles are always optimised.
3. **A real Metro bundle** (`segmentID`, `cjsModuleTable`, `CallRequire`, overflowed
   string entries, >255 function-name string ids forcing v99 large headers). None of our
   fixtures has a single overflowed string or overflowed v≤96 function header.
4. **A `-g` (debug info) variant**, so the debug-info skip logic is tested rather than
   assumed.

### 7.5 Top risks

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **The version field does not determine the layout** (v98 ×2 headers, v99 ×2 opcode tables). Silent misdecode looks like a working parser producing wrong JS. | Catastrophic and *quiet* | Layout probe + startup assertions on known opcode numbers (`docs/HBC-FORMAT.md` §11.2); refuse to parse rather than guess; record the chosen variant in output. |
| R2 | **v99 generators/async are compiler-lowered state machines**, not VM primitives. A `yield`-recovery approach that works on v94 produces nothing on v99. | Blocks the v99 half of "definition of done" | Ship the runtime-shim strategy (§6.2 A) as the correctness floor; treat `yield` recovery as v2. |
| R3 | **Environment-slot resolution failure** → dangling identifiers, exactly hermes-dec's bug. | Output looks fine, throws `ReferenceError` at runtime | Make unresolved `(env, slot)` a hard parse error; add a materialised-env fallback; assert every emitted identifier is bound (a post-emit scope check with a JS parser). |
| R4 | **`finally` is not in the format** — duplicated blocks only. | Wrong output if we guess; verbose but correct if we don't | Default to the correct-verbose form; de-duplication is an opt-in optimisation with its own tests. |
| R5 | **Untested format paths**: literal buffers / shape table / BigInt / switch tables are all `0` in every current `.hbc` fixture, and no fixture has an overflowed string or an optimised (`-O`) build. First real bundle hits all of them. | Crash or silent corruption on the 12 MB acceptance bundle | Compile `tests/fixtures/constructs/` at v84/v94/v99, plus `-O` and `-g` variants and one real Metro bundle, **before** M4 (§7.4). |
| R6 | **AGPL contamination.** hermes-dec is pip-installed on this machine and its source is one `cat` away. | Relicensing the project | Keep D4 in `CLAUDE.md` (done); state the ban in every agent prompt; consider a repo pre-commit grep for hermes-dec identifiers (`_fun%d_ip`, `CatchBlockStart`, `pass2_transform_code`). |
| R7 | **Behavioural equivalence is undecidable in general**; a green trace suite on 2 fixtures proves little. | False confidence | Lean on D3 recompile-diff for breadth (droidsaw-hermes proves this scales), and grow the fixture ratchet monotonically, with `SEMANTIC_FAIL` pinned at 0. |
| R8 | **Static Hermes is a moving target** — it bumped/reshaped the format twice in 2026 and is now the stable line. | Rework | Pin the Hermes commit per generated table; make table generation a scripted, repeatable step; test against ≥2 v99 compilers if they diverge again. |
| R9 | **The field moved in 2026.** `hermes-decomp` (MIT, HBC 40–99) and `droidsaw-hermes` (BSD-3) both ship structured JS output; SPEC's "nobody produces runnable JS" is now only true in the narrow sense that nobody *verifies* it. | Motivation/positioning | Keep the differentiator sharp: **execution-trace equivalence** (D2) plus **recompile round-trip** (D3) as first-class acceptance gates, not a nice-to-have. |

---

## 8. Bottom line

The gap SPEC.md targets is real but narrower than in 2024: two permissively licensed Rust
projects now emit structured JavaScript, and one of them (`droidsaw-hermes`) already
recompiles its output with `hermesc` as a test. What no project does is **prove
behavioural equivalence by execution**. That, plus first-class handling of the v97+
compiler-lowered generator/async form, is where hbc2js should plant its flag — and the
work should start from a version-probing parser and a `hermesc`-backed oracle, not from
the structurer.
