# Spec 02 — Disassembler (M2)

**Milestone:** M2
**Status:** ready to implement
**Owner model:** Sonnet (D5); `switchtable.ts` wants an Opus review
**Prerequisites:** spec 00, spec 01
**Consumers:** M3 round-trip oracle (D3), M4 CFG builder

Reference sections of `docs/HBC-FORMAT.md`: **§11.1** (encoding rules, operand
widths, jump semantics, switch tables), **§11.2** (opcode numbering and the
spot-checks), **§11.3** (property-cache operands), **§11.4** (builtins),
**§12.7–§12.9** (jump traps). You should not need any other section.

> **Concurrency notice.** Do not create, edit or delete anything under
> `tests/fixtures/**` or `tools/equiv/**`. Stage files explicitly.

---

## 1. Scope

* Decode a function body into a typed instruction list (§3).
* Resolve jump targets and switch jump tables to function-relative offsets (§4).
* Assign deterministic labels (§5).
* Emit a canonical textual disassembly **that we own**, in two modes (§6).
* Diff-test that output against `hermesc -dump-bytecode` and hermes-dec's
  `hbc-disassembler`, through normalisers (§7).
* Hit a performance target on a 12 MB bundle (§8).

Out of scope: basic blocks, dominators, any CFG structure (M4), and any
semantic interpretation of opcodes beyond "which operand is a string id".

---

## 2. Public API

```ts
// src/disasm/decode.ts
export function decodeFunction(mod: HbcModule, functionIndex: number): DecodedFunction;
export function decodeModule(mod: HbcModule, opts?: { readonly indices?: readonly number[] }):
  Iterable<DecodedFunction>;          // lazy: yields one function at a time

// src/disasm/print.ts
export type DisasmMode = "raw" | "canonical";
export interface PrintOptions {
  readonly mode: DisasmMode;                 // default "canonical"
  readonly showCacheIndices?: boolean;       // default true
  readonly maxStringPreview?: number;        // default 32 chars
  readonly indices?: readonly number[];      // subset of functions
}
export function printModule(mod: HbcModule, out: Writable, opts?: PrintOptions): void;
export function printFunction(mod: HbcModule, fn: DecodedFunction, out: Writable, opts?: PrintOptions): void;
```

`printModule` writes to a stream and **never builds the whole disassembly as one
string** (§8).

---

## 3. Instruction decoding

### 3.1 Types

```ts
export type OperandType =
  | "Reg8" | "Reg32" | "UInt8" | "UInt16" | "UInt32"
  | "Addr8" | "Addr32" | "Imm32" | "Double";

/** Semantic annotation harvested from BytecodeList.def's OPERAND_*_ID macros
 *  (spec 01 §5.4 rule 7), plus two we infer from the opcode name. */
export type OperandRole =
  | "reg" | "imm" | "double" | "addr"
  | "string" | "function" | "bigint" | "regexp"
  | "cacheIndex" | "builtin" | "shape" | "literalOffset" | "envSlot";

export interface Operand {
  readonly type: OperandType;
  readonly role: OperandRole;
  readonly value: number;        // Double values land here too; Imm32/Addr* are signed
}

export type InstrKind =
  | "normal" | "jump" | "condJump" | "switch"
  | "return" | "throw" | "catch" | "unreachable";

export interface Instruction {
  readonly offset: number;             // FUNCTION-RELATIVE offset of the opcode byte
  readonly length: number;             // 1 + sum of operand widths
  readonly opcode: number;
  readonly name: string;
  readonly operands: readonly Operand[];
  readonly kind: InstrKind;
  /** Function-relative targets. Empty for "normal"; one for "jump"; one for
   *  "condJump" (the taken edge — the fallthrough is offset+length);
   *  default + cases for "switch". */
  readonly targets: readonly number[];
  readonly fallsThrough: boolean;
  /** Present only for switch instructions. */
  readonly switchTable?: SwitchTable;
}

export interface SwitchTable {
  readonly kind: "uint" | "string";
  readonly tableOffset: number;        // function-relative, post-alignment
  readonly byteLength: number;
  readonly defaultTarget: number;      // function-relative
  readonly min: number;                // "uint" only
  readonly max: number;                // "uint" only
  readonly cases: readonly SwitchCase[];
}
export interface SwitchCase {
  readonly value: number;              // the integer case value, or the string id
  readonly target: number;             // function-relative
}

export interface DecodedFunction {
  readonly index: number;
  readonly header: FunctionHeader;
  readonly name: string;
  readonly instructions: readonly Instruction[];
  readonly byOffset: ReadonlyMap<number, number>;   // instruction offset -> index
  readonly labels: ReadonlyMap<number, string>;     // offset -> "L3"
  readonly handlers: readonly ExceptionHandler[];
  readonly switchTables: readonly SwitchTable[];
  /** max(bytecodeSizeInBytes, end of the last jump table) — the function's true
   *  extent in the file. docs/HBC-FORMAT.md §12.8. */
  readonly extentEnd: number;
  readonly diagnostics: readonly Diagnostic[];
}
```

### 3.2 The decode loop

Body = `fn.body()`, exactly `bytecodeSizeInBytes` bytes, offsets are
function-relative from 0.

```
ip = 0
while ip < size:
  opcode = body[ip]
  def = table.opcodes[opcode]           // E_UNKNOWN_OPCODE if absent
  o = ip + 1
  for each operandType in def.operands:
    require(o + width <= size)          // else E_OPERAND_OVERRUN
    read little-endian, signed per §11.1
    o += width
  emit Instruction{ offset: ip, length: o - ip, ... }
  ip = o
```

Rules from `docs/HBC-FORMAT.md` §11.1, restated so you do not have to open it:

| Type | Bytes | Read as |
|---|---|---|
| `Reg8`, `UInt8` | 1 | unsigned |
| `UInt16` | 2 | unsigned LE |
| `Reg32`, `UInt32` | 4 | unsigned LE |
| `Addr8` | 1 | **signed** int8 |
| `Addr32` | 4 | **signed** int32 LE |
| `Imm32` | 4 | signed int32 LE |
| `Double` | 8 | IEEE-754 LE (`DataView.getFloat64(o, true)`) |

No alignment, no padding, operands immediately follow the opcode byte.

**Jump displacements are relative to the opcode byte, not to the next
instruction** (§11.1, §12.7): `target = insn.offset + disp`.

Short and `…Long` jump variants are always adjacent opcode numbers, short first
(§11.1) — useful as a sanity assertion on the generated table, not something to
rely on for decoding.

### 3.3 Validation

| Check | Failure |
|---|---|
| opcode present in the table | `E_UNKNOWN_OPCODE` (+ offset, function index) |
| operands fit within `bytecodeSizeInBytes` | `E_OPERAND_OVERRUN` |
| the loop ends with `ip === size` exactly | `E_OPERAND_OVERRUN` ("trailing partial instruction") |
| every jump target ∈ `[0, size)` | `E_JUMP_OUT_OF_RANGE` |
| every jump target is an instruction start (second pass over `byOffset`) | `E_JUMP_MISALIGNED` |
| every handler `start`/`end`/`target` is an instruction start (`end` may equal `size`) | diag `W_HANDLER_MISALIGNED` — see below |
| operand with role `string` has `value < stringCount`; `function` < `functionCount`; `bigint` < `bigIntCount`; `regexp` < `regExpCount`; `shape` < `objShapeTableCount` | `E_BAD_STRING_ID` / `E_BAD_FUNCTION_ID` / `E_SECTION_OVERRUN` |

Handler misalignment is a **diagnostic, not fatal**, because `end` is exclusive
and may legitimately land on the byte after the last instruction of a protected
region; treat a misaligned `start`/`target` as a warning too and let the CFG
builder (M4) decide. Everything else is fatal — a misdecode must be loud (R1).

**Probe-aware error hints (spec 01 §6.4 step 4, review S1).** When
`module.layout.probe.exhaustive === false`, the opcode table was chosen from a
*sample* of functions. `decodeModule` must therefore attach, to every
`E_UNKNOWN_OPCODE` and `E_OPERAND_OVERRUN` raised on a function outside
`probe.sampledFunctions`, the hint:

> `the opcode table may be wrong: only <N> of <M> functions were probed; re-run
> with --verify for an exhaustive probe, or force one with --opcode-table=<id>`

Without it, a subtly-wrong table surfaces as a random decoder bug rather than the
loud layout error D8 intends. This matters most for the v98/v99 pair, whose
tables agree on every opcode below 165 (spec 01 §5.2.1) — a small function can
decode cleanly under both.

The decoder is also the engine of spec 01 §6.4's opcode-table probe: expose

```ts
export function tryDecodeFunction(mod: HbcModule, index: number, table: OpcodeTable):
  { ok: true; fn: DecodedFunction } | { ok: false; code: ErrorCode; offset: number };
```

which performs the same loop but returns instead of throwing. `decodeFunction`
is `tryDecodeFunction` + throw.

### 3.4 Operand roles

Roles come from the generated table's `idOperands` map (spec 01 §5.4 rule 7),
which is derived from `OPERAND_STRING_ID` / `OPERAND_FUNCTION_ID` /
`OPERAND_BIGINT_ID` in `BytecodeList.def`. For the handful the macros do not
cover, assign by rule:

* `Addr8`/`Addr32` → `addr`; `Double` → `double`; `Imm32` → `imm`.
* `Reg8`/`Reg32` → `reg`.
* `CreateRegExp`'s 4th operand → `regexp`; `NewObjectWithBuffer`'s shape operand
  (v≥97) → `shape`; buffer-index operands of `New{Array,Object}WithBuffer*` →
  `literalOffset`; `CallBuiltin`/`GetBuiltinClosure`'s builtin number →
  `builtin`.
* The `UInt8` sitting between the object register and the string id on
  `GetById` / `GetByIdShort` / `PutById*` / `TryGetById` / `TryPutById*` →
  `cacheIndex`. **It is a runtime inline-cache slot with no semantic meaning**
  (§11.3) — you must consume the byte, and the emitter must ignore it. Note
  `PROPERTY_CACHING_DISABLED` changed from `0` to `0xFF` at v97, so infer
  nothing from the value.
* Everything else → `imm`.

Encode this role assignment as data in `src/tables/roles.ts` (a small
hand-written override table keyed by `opcodeName → operandIndex → role`, merged
over the generated `idOperands`), not as `if` chains in the decoder. A role
override naming an opcode that does not exist in a table is an `E_TABLE_ASSERT`
at load — that way the overrides cannot silently rot as tables are added.

---

## 4. Jump tables

`docs/HBC-FORMAT.md` §11.1. Three instructions, two shapes.

### 4.1 `SwitchImm` (v≤96) and `UIntSwitchImm` (v≥99)

Operands: `(Reg8 value, UInt32 tableOffset, Addr32 defaultTarget, UInt32 min, UInt32 max)`.

```
ipAbs      = fn.header.offset + insn.offset          // absolute file offset of the opcode
tableAbs   = alignUp(ipAbs + tableOffset, 4)         // ALIGNMENT IS ON THE ABSOLUTE ADDRESS
tableRel   = tableAbs - fn.header.offset
count      = max - min + 1
cases[i]   = { value: min + i,
               target: insn.offset + int32LE(file, tableAbs + 4*i) }   // ip-relative
defaultTgt = insn.offset + defaultTarget
byteLength = 4 * count
```

**The alignment trap.** Hermes aligns the *runtime address* of the table, i.e.
the absolute address, not the function-relative offset. Function bodies are not
guaranteed to start 4-aligned, so `alignUp(ip + tableOffset, 4)` computed in
function-relative space can differ from the truth by up to 3 bytes. Always
compute in absolute file offsets and convert back. Get this wrong and the switch
silently reads neighbouring bytes as targets.

**The extent trap** (§12.8). `bytecodeSizeInBytes` covers the opcodes only; the
jump table lives *beyond* it, 4-aligned. So:

* the table's bytes are read from `mod.bytes`, **not** from `fn.body()`;
* `extentEnd = max(bytecodeSizeInBytes, max over tables of (tableRel + byteLength))`;
* targets are still function-relative offsets *into the opcode region* and must
  satisfy `0 ≤ target < bytecodeSizeInBytes`, else `E_SWITCH_TABLE`.

Bounds: `max ≥ min`, `count ≤ 2^20` (a sanity ceiling — a bigger table is
corruption), `tableAbs + 4*count ≤ fileLength - 20`. Violations →
`E_SWITCH_TABLE`.

**Worked example, measured from `constructs/52-switch-jumptable/v94.hbc`** (use
it as the unit test):

```
function 1 "classify": header.offset = 0x204 (516), bytecodeSizeInBytes = 260
instruction at function-relative 7:
  SwitchImm r0, tableOffset=253, defaultTarget=+223, min=0, max=12
ipAbs    = 516 + 7                = 523
tableAbs = alignUp(523 + 253, 4)  = alignUp(776, 4) = 776   (0x308)
tableRel = 776 - 516              = 260               == bytecodeSizeInBytes
count    = 12 - 0 + 1             = 13
extentEnd= max(260, 260 + 52)     = 312
default  = 7 + 223                = 230               (an instruction start)
case 0   = 7 + 207                = 214               (an instruction start)
```

Full expected case list (raw `int32` entries as `hermesc` prints them, before
adding `ip`): `207, 191, 191, 161, 175, 145, 129, 113, 94, 75, 56, 37, 18`.
Note case 1 and case 2 share a target — fall-through, which the M4 structurer
must preserve.

**This fixture does not discriminate absolute-vs-relative alignment** (0x204 is
already 4-aligned, so both computations give 776). The absolute rule is still the
correct one; a discriminating fixture would need a function body starting at a
non-4-aligned offset, which is rare because jump tables pad to 4. Keep the
absolute form and note in a code comment that the fixture does not prove it.

### 4.2 `StringSwitchImm` (v≥99)

Operands: `(Reg8 value, UInt32 globalIndex, UInt32 tableOffset, Addr32 defaultTarget, UInt32 tableSize)`.
Table entries are `{ uint32 caseLabelStringID; int32 target; }` pairs, same
4-alignment rule, targets `ip`-relative, `byteLength = 8 * tableSize`. Validate
each `caseLabelStringID < stringCount`. `header.numStringSwitchImms` counts these
instructions file-wide — assert the count of decoded `StringSwitchImm`
instructions equals it when the whole module is decoded (a cheap, strong
cross-check; record as a diagnostic mismatch, not fatal, since partial decoding
is legal).

### 4.3 Coverage — now real, with one gap left

Two fixtures added since the first draft of this spec close the integer-switch
gap at **all four versions**:

| Fixture | v84 | v94 | v98 | v99 |
|---|---|---|---|---|
| `constructs/52-switch-jumptable` (13 cases, 0..12) | `SwitchImm` | `SwitchImm` | `UIntSwitchImm` | `UIntSwitchImm` |
| `constructs/53-switch-jumptable-large` (40 cases, 0..39) | `SwitchImm` | `SwitchImm` | `UIntSwitchImm` | `UIntSwitchImm` |

The operand shape is unchanged across the rename
(`Reg8, UInt32 tableOffset, Addr32 default, UInt32 min, UInt32 max`), so §4.1
covers both. The measured opcode numbers are `0x85`=133 (v94 `SwitchImm`),
`0xa6`=166 (v98 `UIntSwitchImm`) and `0xa7`=167 (v99 `UIntSwitchImm`) — the v98
value is one *below* v99's, which is the evidence behind spec 01 §5.2.1's finding
that v98 needs its own opcode table.

**Still a gap: `StringSwitchImm`.** Neither new fixture is a `switch` over string
literals, so the v≥99 string-switch form, its `{uint32 stringId, int32 target}`
pair layout, and the `header.numStringSwitchImms` cross-check remain untested.
§4.2 is written blind. See O-1.

---

## 5. Labels

Deterministic, mode-independent:

1. Collect the target set = all `insn.targets` ∪ all switch case targets ∪
   switch defaults ∪ every handler `target`.
2. Sort ascending by offset.
3. Assign `L1, L2, …` in that order. (`L0` unused, so a bare `L` never collides
   with a register name in a normaliser regex.)
4. Handler `start`/`end` offsets get labels too, but from a separate namespace:
   `T1, T2, …` in ascending order, so that the exception-region annotations do
   not perturb `L` numbering when a handler range happens not to be a jump
   target.

Labels are a *presentation* concern; `Instruction.targets` stays numeric so the
CFG builder never parses text.

---

## 6. Canonical textual format

We own this format. Two modes, one decoder.

### 6.1 `raw` mode — the diff target

Chosen to be **line-for-line identical to `hermesc -dump-bytecode
-pretty-disassemble=false`**, because that is the MIT compiler's own rendering
and makes the strongest possible oracle. Everything below is copied verbatim from
real runs against `tests/fixtures/hermes-dec-sample/source.js` and
`constructs/52-switch-jumptable/source.js`, at v84/v94/v98/v99.

**Function header line — three real shapes, not one.** The first draft of this
spec assumed `^Function<name>(P params, R registers, S symbols):`; the real
output has a prefix that varies and, for class D/E, a completely different tail.

v94 (class C) — note three of the eight functions carry an `NC` prefix:

```
Function<global>(1 params, 16 registers, 0 symbols):
NCFunction<testx>(2 params, 15 registers, 0 symbols):
NCFunction<?anon_0_testx>(2 params, 1 registers, 0 symbols):
Function<?anon_0_?anon_0_testx>(2 params, 16 registers, 0 symbols):
NCFunction<gen>(1 params, 1 registers, 0 symbols):
Function<?anon_0_gen>(1 params, 17 registers, 0 symbols):
Function<ze>(1 params, 12 registers, 1 symbols):
Function<zb>(1 params, 9 registers, 0 symbols):
```

v99 (class E) — no `symbols` field at all; `numberRegCount` / `nonPtrRegCount`
instead. v98 output is identical in shape:

```
Function<global>(1 params, 18 registers, 1 numbers, 1 non-pointers):
NCFunction<testx>(2 params, 16 registers, 0 numbers, 1 non-pointers):
NCFunction<gen>(1 params, 2 registers, 1 numbers, 0 non-pointers):
Function<ze>(1 params, 13 registers, 0 numbers, 1 non-pointers):
NCFunction<?anon_0_testx>(2 params, 3 registers, 1 numbers, 0 non-pointers):
Function<gen>(1 params, 32 registers, 0 numbers, 0 non-pointers):
Function<zb>(1 params, 11 registers, 0 numbers, 1 non-pointers):
NCFunction<distanceFromOrigin>(1 params, 14 registers, 0 numbers, 0 non-pointers):
```

The `NC` prefix means **not constructable** and corresponds exactly to
`FunctionFlags.prohibitInvoke === "construct"` — verified against the v94 fixture
(functions 1, 2 and 4 have small-header `flags` low bits `01`, and are exactly
the three printed `NCFunction`). Only `Function` and `NCFunction` were observed
across every fixture tried; a `C`-prefixed form (prohibit *call*, i.e.
constructor-only) is plausible but never appeared, so match it optionally and
fail loudly on any other prefix rather than silently dropping the line.

So `raw` mode emits, per function:

```
Function<?anon_0_gen>(1 params, 17 registers, 0 symbols):
[@ 0] StartGenerator
[@ 1] LoadConstUndefined 2<Reg8>
[@ 5] ResumeGenerator 0<Reg8>, 1<Reg8>
[@ 8] JmpTrueLong 168<Addr32>, 1<Reg8>
[@ 14] LoadConstUInt8 1<Reg8>, 42<UInt8>
[@ 17] SaveGenerator 4<Addr8>
[@ 52] Catch 4<Reg8>
[@ 75] LoadConstInt 5<Reg8>, 432<Imm32>
```

with `NC` when `prohibitInvoke === "construct"`, `(P params, R registers, S
symbols)` for classes A–C where `S = environmentSize`, and
`(P params, R registers, N numbers, M non-pointers)` for classes D/E where the
two counts are `numberRegCount` / `nonPtrRegCount` (class D has neither field in
its header, so emit `0 numbers, 0 non-pointers` there and expect the oracle
comparison for class D to be untestable anyway — no class-D fixture exists).

Instruction lines: offsets decimal and function-relative; operands
`<decimal value><TypeName>` joined with `", "`; `Addr8`/`Addr32` print the **raw
displacement**, not a resolved target; `Double` via `String(value)`; no comments,
no string text, no label lines.

**Exception handlers** — printed after the instructions, offsets decimal and
function-relative (verbatim, v94 `?anon_0_gen`):

```
Exception Handlers:
0: start = 30, end = 50, target = 52
1: start = 30, end = 71, target = 73
2: start = 75, end = 149, target = 151
```

**Jump tables** — printed after the handlers, entries as raw `ip`-relative
displacements (verbatim, `52-switch-jumptable` at both v94 and v99 — the block is
byte-identical across versions):

```
 Jump Tables: 
  offset 253
   0 : 207
   1 : 191
   2 : 191
   3 : 161
```

(Note the trailing space after `Jump Tables:` and the one/two/three-space
indents. Reproduce them exactly in `raw` mode; the normaliser strips them anyway,
but a `raw` mode that is diff-clean against the oracle *before* normalisation is
a much better bug detector.)

The v98/v99 module preamble additionally contains a `StringSwitchImm count: N`
line, which is `header.numStringSwitchImms`; `raw` mode does not emit the
preamble and the normaliser drops it.

### 6.2 `canonical` mode — what we actually use

For humans, for CFG debugging, and for our own golden snapshots:

```
; hbc2js disassembly — version 94, layout C, table hbc94
function #5 "?anon_0_gen"  params=1 frame=17 env=0 flags=strict,exc,dbg  @0x000004b7 size=179
  .try T1..T2 -> L4        ; handler 0
  .try T1..T3 -> L6        ; handler 1
  .try T4..T5 -> L9        ; handler 2
  0000  StartGenerator
  0001  LoadConstUndefined   r2
  0005  ResumeGenerator      r0, r1
  0008  JmpTrueLong          L1, r1
  000e  LoadConstUInt8       r1, 42
  0011  SaveGenerator        L2
  0013  Ret                  r1
L2:
  0015  ResumeGenerator      r1, r4
  0020  GetByIdShort         r4, r4, #c1, s19 "gen"
  0032  CreateRegExp         r1, s12 "dkooDD JPOD D09D\n\\  @ .…", s13 "gmi", re0
  .switch UIntSwitchImm @0x0068  min=0 max=3 default=L9
        0 -> L3   1 -> L4   2 -> L4   3 -> L7
```

Operand rendering table:

| Role | Rendering | Example |
|---|---|---|
| `reg` | `r<N>` | `r4` |
| `addr` | the label | `L2` |
| `string` | `s<N> "<truncated escape, see below>"` | `s19 "gen"` |
| `function` | `f<N> "<name>"` | `f6 "ze"` |
| `bigint` | `bi<N> <decimal>n` | `bi0 42n` |
| `regexp` | `re<N>` | `re0` |
| `builtin` | `b<N> "<name>"` from the builtin table | `b52 "spawnAsync"` |
| `cacheIndex` | `#c<N>`, omitted when `showCacheIndices: false` | `#c1` |
| `shape` | `sh<N>(numProps=<k>)` | `sh0(numProps=2)` |
| `literalOffset` | `lit@0x<hex>` | `lit@0x000c` |
| `double` | `String(value)` | `7.3` |
| `imm` | decimal | `42` |

**String truncation rule (review N3), stated exactly because golden files are
byte-exact.** Escape the whole string first, then take the first
`maxStringPreview` characters **of the escaped output** (default 32), then append
`…` (U+2026) iff anything was dropped. Never split an escape sequence: if the cut
would land inside a `\xNN` / `\uNNNN` / `\n`, back up to the start of that
sequence. So `s12` of `v94.hbc` (43 source characters, containing a literal NUL
and `\r\n\t`) renders as the first 32 characters of its *escaped* form plus `…`.
Do not hand-transcribe this into a test: generate the expected value once from
`printFunction` and commit it as golden data, then review the diff.

Escaping (deterministic, used in golden files and in test expectations):
`\\`, `\"`, `\n`, `\r`, `\t`, `\xNN` for other code units < 0x20 or == 0x7f,
`\uNNNN` for code units ≥ 0x80 **including lone surrogates**, and no
astral-plane special casing (a surrogate pair renders as two `\uNNNN`). That
makes the output pure ASCII and byte-stable across platforms.

Module preamble (`printModule` only):

```
; hbc2js disassembly of <basename>
; version=94 layout=C opcodeTable=hbc94 functions=8 strings=34 globalCodeIndex=0
```

No absolute paths, no timestamps — the output is committed as golden data.

### 6.3 CLI

`hbc2js disasm <file.hbc> [--mode=raw|canonical] [--function=N] [--no-cache-indices] [-o out.txt]`.
Defaults: `canonical`, all functions, stdout.

---

## 7. Diff tests against the two oracles

Both live in `tests/gate/oracle/disasm/` (spec 00 §2.1). Each produces two normalised line arrays
and compares them element-wise, reporting the first 20 mismatches as
`fixture vNN fn#K @offset: ours=<line> theirs=<line>`.

### 7.A `hermesc -dump-bytecode` (MIT, primary)

**Applicability gate.** `hermesc -dump-bytecode` takes **source**, not a `.hbc`
(`docs/TOOLCHAIN.md`) — it recompiles and dumps. So the comparison is only valid
when the fixture's `.hbc` is byte-identical to what the installed `hermesc`
produces from `source.js`. Procedure per `(fixture, version)`:

1. `requireHermesc(t, version)`; skip if absent.
2. Copy `source.js` into a temp dir; run
   `hermesc -emit-binary -out=probe.hbc source.js` **with `cwd` = that temp dir
   and a relative filename** (the filename is embedded — `docs/TOOLCHAIN.md`).
3. Compare `probe.hbc` with the fixture `.hbc`. If they differ, record
   INCONCLUSIVE (D15) with the byte-length delta in the message and an entry in
   `tests/gate/oracle/known-divergences.md`. Expect exactly one such case:
   `hermes-dec-sample/v99.hbc` (built by a non-public Hermes commit; different
   builtin table and an extra `Unreachable` — see `docs/TOOLCHAIN.md`). Use
   `v99-public.hbc` for the v99 comparison instead. All four versions
   (84, 94, 98, 99) are in scope; `tools/hermesc/v98` exists.
4. Run `hermesc -dump-bytecode -pretty-disassemble=false source.js` in the same
   temp dir; capture stdout.
5. Disassemble the fixture `.hbc` with our `raw` mode.
6. Normalise both (N-hermesc below) and compare.

**Normaliser N-hermesc.** From hermesc's stdout keep only:

* **function header lines**, matching

  ```
  ^(?<nc>N?C?)Function<(?<name>[^>]*)>\((?<p>\d+) params, (?<r>\d+) registers, (?:(?<s>\d+) symbols|(?<nr>\d+) numbers, (?<npr>\d+) non-pointers)\):$
  ```

  → `FUNC <p> <r> <s|nr,npr>`. The name is **not** compared (it comes from the
  compiler's IR, we take ours from the string table; they agreed on every fixture
  tried, but that is not what this test is for). The `nc` prefix **is** compared,
  as a free extra assertion: `nc === "NC"` must equal
  `flags.prohibitInvoke === "construct"`. Any prefix other than `""` or `"NC"` is
  a hard failure — do not widen the regex to swallow it.
* **instruction lines**, `^\[@ (?<off>\d+)\] (?<op>\w+)(?: (?<ops>.*))?$`
  → `<off> <op> <ops>` with runs of whitespace collapsed and the `<Type>`
  suffixes left intact.
* **exception handlers**: the `Exception Handlers:` header plus
  `^(\d+): start = (\d+), end = (\d+), target = (\d+)$` → `EH <n> <start> <end> <target>`.
* **jump tables**: `^ Jump Tables: ?$`, then `^  offset (\d+)$` → `JT <offset>`,
  then `^   (\d+) : (-?\d+)$` → `JTE <case> <disp>`.

Drop everything else: the `Bytecode File Information` block (including
`StringSwitchImm count:`), `Global String Table`, `Function Source Table`,
`Offset in debug table:` lines, the `Array Buffer`/`Object Key Buffer` dumps, the
compiled-regexp dump, every `Debug *` table, and blank lines.

Function ordering: hermesc dumps functions in **function-table index order** —
verified by matching `Function<gen>(1 params, 32 registers, …)` at dump position 5
against `docs/HBC-FORMAT.md` §4.2's function 5 (`frameSize = 32`). The *names*
are arranged differently between v94 and v99 because the compiler orders
functions differently, which is a real difference in the files, not a dump
artefact. Assert the function counts match before comparing lines, so an ordering
bug reports as a count mismatch rather than 400 line diffs.

`hermesc -dump-bytecode` also prints the decoded debug source table
(`bc 24: line 7 col 1 scope offset 0x0000 env r2`). Ignore it in M2 — but note it
is a ready-made oracle if spec 01's O-5 (debug delta stream) is taken up.

### 7.B `hbc-disassembler` (hermes-dec, AGPL — output only)

Works directly on `.hbc`, so it covers **every** fixture including
`hermes-dec-sample/v99.hbc`. Run `hbc-disassembler <file> <out>` and read `out`.

Its shape:

```
=> [Function #5 "?anon_0_gen" of 179 bytes]: 1 params, frame size=17, strict=0, exc handler=1, debug info=1  @ offset 0x000004b7
  [Exception handlers: [start=0x1e, end=0x32, target=0x34] [start=0x1e, end=0x47, target=0x49] ]
  [Debug offsets: source_locs=0x0, scope_desc_data=0x0]

Bytecode listing:

==> 00000000: <DeclareGlobalVar>: <string_id: 17>  # String: 'testx' (Identifier)
==> 00000004: <JmpTrue>: <Addr8: 117, Reg8: 1>  # Address: 00000079
```

**Normaliser N-hermesdec:**

| Input line | Output |
|---|---|
| `^=> \[Function #(\d+) "(.*)" of (\d+) bytes\]: (\d+) params, frame size=(\d+), strict=(\d), exc handler=(\d), debug info=(\d)\s+@ offset 0x([0-9a-f]+)$` | `FUNC <idx> <size> <params> <frame> <strict> <exc> <dbg> <offset-as-decimal>` |
| `^\s*\[Exception handlers: (.*)\]$` | split the inner `[start=0x…, end=0x…, target=0x…]` groups → one `EH <n> <start> <end> <target>` line each, hex→decimal |
| `^\s*\[Debug offsets: .*\]$` | **dropped** (hermes-dec misparses this for v99 — `docs/HBC-FORMAT.md` §4) |
| `^==> ([0-9a-f]{8}): <(\w+)>(?:: (.*?))?(?:  #.*)?$` | `<offset hex→decimal> <opcode> <operands>` |
| everything else (banners, blank lines, `Bytecode listing:`) | dropped |

Operand normalisation: the operand list is `<Type: value>` items separated by
`, ` **inside a single pair of angle brackets** (`<Reg8: 0, Reg8: 1>`) — split on
`, ` after stripping the outer `<`/`>`, then map each `Type: value` to
`value<Type>` so the result is identical in shape to N-hermesc's output. Drop
everything after `  #` (the resolved-address and string-text comments).

**Known divergences to allowlist** (each with a byte-level justification in
`tests/gate/oracle/known-divergences.md`):

1. **v99 `[Debug offsets:]`** — hermes-dec reads 12 bytes where static Hermes
   has 4. Dropped by the normaliser; our own value is asserted in spec 01 T3
   instead.
2. **Builtin numbering** — hermes-dec's builtin table may come from a different
   Hermes commit than our pinned one, so `CallBuiltin`/`GetBuiltinClosure`
   comments can name a different builtin. We compare numbers only (comments are
   dropped anyway), so this should not bite; if a *number* ever differs, that is
   a real bug in one of us and the test must fail.
3. **v99 support warning** — `hbc-disassembler` prints a "not formally
   supported" warning to stderr for v99. Ignore stderr.
4. **Opcode names** — both sides derive names from `BytecodeList.def`, so names
   must match exactly. **Do not add name-mapping to the normaliser.** A name
   mismatch means our table pin is wrong; fix the pin, not the test.

### 7.C What the two oracles prove, jointly

| | hermesc | hermes-dec |
|---|---|---|
| Reads `.hbc` directly | no (recompiles source) | yes |
| Covers `hermes-dec-sample/v99.hbc` | no | yes |
| Licence | MIT (safe to depend on) | AGPL (output only) |
| Independent of our opcode table | yes (it *is* the compiler) | yes (its own tables) |

Two independent oracles agreeing with us on every fixture is the M2 correctness
argument. Where they disagree with each other (only the v99 debug offsets, so
far), `docs/HBC-FORMAT.md` adjudicates from the bytes.

### 7.D Golden disassembly snapshots

Independently of the oracles, write `canonical`-mode output for every
`(fixture, version)` to `tests/golden/disasm/<group>/<name>/v<NN>.txt` and
commit it. This is what makes an unintended change in *our* format visible in
review, and it works with no external binaries installed.

### 7.E Round-trip self-check

Cheap and strong: for every decoded function, re-serialise each instruction from
its operand values using the table's widths and assert the bytes equal
`body().subarray(insn.offset, insn.offset + insn.length)`. This catches
sign/width/endianness errors without any oracle at all. Run it over every
fixture in `tests/gate/disasm/reencode.test.ts`.

---

## 8. Performance

Targets, measured on a CI runner, for the 12 MB bundle of SPEC's "definition of
done" #4 (see spec 01 O-4 — the bundle does not exist yet; until it does,
measure on the largest available input and record the extrapolation):

| Operation | Target |
|---|---|
| `parseHbc` (spec 01) | ≤ 400 ms |
| `decodeModule` over every function, no text | ≤ 4 s, peak RSS ≤ 8× file size |
| `printModule` in `raw` mode to a file | ≤ 15 s total |
| `printModule` in `canonical` mode to a file | ≤ 25 s total (string resolution dominates) |

Implementation rules that make those reachable:

1. **Stream the output.** `printFunction` writes into a `string[]` chunk buffer
   flushed to the `Writable` every ~64 KB. Never `+=` into one giant string and
   never `array.join("")` over the whole module.
2. **`decodeModule` is a generator.** One `DecodedFunction` alive at a time; the
   caller decides what to retain. A 12 MB bundle has ~10^5 functions and
   materialising all their instruction arrays at once is the obvious OOM.
3. **One `DataView` for the whole file**, created once in `parseHbc`. Do not
   allocate a `DataView` per function or per operand.
4. **Do not allocate an `Operand` object per operand in the hot path if it
   shows up in profiling** — but do not pre-optimise: measure first, and if you
   do switch to a flat `Int32Array` encoding, keep the `Instruction` interface
   as the public shape and make the compact form internal.
5. **String previews are lazy.** `canonical` mode calls `strings.get()`; that is
   the mode's cost and is why it has a looser budget.
6. Record the actual numbers in `docs/STATUS.md` when M2 lands; a perf
   regression is only visible if a baseline is written down.

---

## 9. Acceptance criteria

- [ ] Every function of every gate binary (196 `constructs/*/v*.hbc` + 5
      `hermes-dec-sample/*.hbc`; **re-derive these counts from the tree**)
      decodes with zero errors and zero warn-diagnostics, and `ip` lands exactly
      on `bytecodeSizeInBytes` for every function.
- [ ] Every function of all four `bundles/rn-template-0.72/*.hbc` decodes
      (sweep tier) — ~4200 functions each, including the 2 overflowed headers and
      the 165 deduplicated bodies.
- [ ] §7.E re-encoding round-trip is byte-exact for every instruction of every
      gate binary.
- [ ] Every jump target in every gate binary resolves to an instruction boundary
      inside its function.
- [ ] **Switch tables are a hard requirement, not a waiver** (the fixtures now
      exist): `52-switch-jumptable` and `53-switch-jumptable-large` decode at all
      four versions, and the v94 case list asserts exactly the §4.1 worked
      example — `tableAbs = 776`, `tableRel = 260`, `count = 13`,
      `extentEnd = 312`, `default → 230`, cases
      `207, 191, 191, 161, 175, 145, 129, 113, 94, 75, 56, 37, 18`, with cases 1
      and 2 sharing a target.
- [ ] `hermesc -dump-bytecode -pretty-disassemble=false` diff (7.A) is **empty**
      for every fixture whose `.hbc` reproduces byte-identically, at v84, v94,
      v98 **and** v99; the only INCONCLUSIVE is `hermes-dec-sample/v99.hbc`, with
      a recorded reason.
- [ ] The N-hermesc normaliser handles all three real header-line shapes
      (`Function<…>… symbols`, `NCFunction<…>… symbols`,
      `…(P params, R registers, N numbers, M non-pointers)`) and the `NC` prefix
      is asserted equal to `prohibitInvoke === "construct"` on every function of
      every fixture. A regression test feeds the normaliser the eight verbatim
      v94 header lines and the eight verbatim v99 header lines from §6.1 and
      asserts 8 matches each.
- [ ] `hbc-disassembler` diff (7.B) is **empty** for every gate binary including
      `hermes-dec-sample/v99.hbc`, with an allowlist of at most the four entries
      in §7.B.
- [ ] The v94 spot-check from `docs/HBC-FORMAT.md` §11.2 is asserted directly:
      the first seven instructions of `hermes-dec-sample/v94.hbc` function 0
      decode as `DeclareGlobalVar 'testx'; DeclareGlobalVar 'gen';
      DeclareGlobalVar 'ze'; CreateEnvironment r1; CreateAsyncClosure r2, r1,
      fn#1; GetGlobalObject r0; PutById r0, r2, #c1, 'testx'`.
- [ ] The v99 spot-check is asserted directly: function 0 of
      `hermes-dec-sample/v99.hbc` decodes as `CreateFunctionEnvironment r3,
      size 0; DeclareGlobalVar 'testx'; DeclareGlobalVar 'gen';
      DeclareGlobalVar 'ze'; GetGlobalObject r2; CreateClosure r4, r3, fn#1;
      PutByIdLoose r2, r4, #c0, 'testx'`.
- [ ] The v98/v99 divergence is asserted from both sides: `hermes-dec-sample`'s
      function 0 differs between v98 and v99 **in exactly one byte** (body offset
      81: `0xa5` vs `0xa6`), and both decode to `CreateRegExp` under their own
      table; `52-switch-jumptable`'s switch opcode is `0xa6` at v98 and `0xa7` at
      v99. Decoding a v98 fixture with `hbc99-mar2026` (or vice versa) must fail.
- [ ] Decoding any v99 fixture with `hbc99-feb2026` fails within the first 16
      bytes of function 0 (the R1 alarm rings from this layer too).
- [ ] Canonical golden snapshots exist for every gate `(fixture, version)` and are
      byte-stable across two runs and across macOS/Linux.
- [ ] `hbc2js disasm --mode=raw tests/fixtures/hermes-dec-sample/v94.hbc` output
      is byte-identical to normalised `hermesc` output, asserted at CLI level so
      the CLI path is covered.
- [ ] Perf numbers for `bundles/rn-template-0.72/index.android.noopt.debug.hbc`
      (2.7 MB, the largest input in the tree) are recorded in `docs/STATUS.md`,
      with the extrapolation to the 12 MB target stated explicitly.
- [ ] Nothing under `tests/fixtures/**` or `tools/**` was modified.

---

## 10. Estimated complexity

**Sonnet for the bulk.** The decoder is a loop over a generated table; the
printer is formatting; the normalisers are regex work with a clear target format
that this spec now quotes verbatim, so they can be written against real output
in the same session.

Two spots deserve care and an Opus review:

* **`switchtable.ts`** — the absolute-vs-relative alignment rule (§4.1) and the
  extent-beyond-`bytecodeSizeInBytes` rule (§4.2). Fixtures 52/53 now cover the
  integer form end-to-end, but §4.1's worked example also shows they do **not**
  discriminate the alignment rule, and `StringSwitchImm` (§4.2) is still
  uncovered.
* **The normaliser allowlist** — the temptation, when a diff fails, is to widen
  the normaliser until it passes. That converts a real bug into a green test, and
  the review caught exactly that failure mode in this spec's first draft (the
  header regex silently dropped 3 of 8 functions). Any new allowlist entry or
  regex widening must cite bytes, and a growing `known-divergences.md` is a
  defect signal.

Estimated size: `decode.ts` ~280 lines, `labels.ts` ~60, `switchtable.ts` ~170,
`print.ts` ~380, roles table ~80, tests ~1000.

---

## 11. Open questions for the overseer

* **O-1 — `StringSwitchImm` still has no fixture.** 52/53 closed the integer
  case at all four versions; a `switch` over ~8 string literals is what would
  reach `StringSwitchImm` and exercise `header.numStringSwitchImms`. One fixture
  (`54-switch-string`) closes it. Approve, and who writes it?
* **O-2 — `raw` mode's fidelity target.** `raw` mode is pinned to hermesc's exact
  rendering, which makes the primary oracle a near-trivial diff but means our
  "own" format is really hermesc's — and the review showed that rendering is
  version-dependent (`symbols` vs `numbers/non-pointers`). The alternative is a
  format of our choosing plus a richer normaliser. I still prefer the current
  choice (complexity in the normaliser is where bugs hide), but it does mean
  `raw` output must track hermesc across versions. Agree?
* **O-3 — jump-table bytes and the M4 CFG.** `extentEnd` tells the CFG builder
  where a function really ends. Should `FunctionRecord` (spec 01) gain an
  `extentEnd` field computed lazily via the disassembler, or does the CFG builder
  call `decodeFunction` and read it from there? Currently the latter, which keeps
  spec 01 free of opcode knowledge.
* **O-4 — is `hbcdump` worth wiring up as a third oracle?**
  `tools/hermesc/v84/hbcdump` is MIT, reads `.hbc` **directly** (unlike
  `hermesc -dump-bytecode`, which recompiles source) and is version-locked to 84.
  That makes it the only licence-clean, direct-on-binary oracle we have — but
  only for v84. Wire it up as `tests/gate/oracle/hbcdump`, or are two enough?

---

## 12. Review responses (`docs/specs/REVIEW-01-02.md`)

| Item | Verdict | Where |
|---|---|---|
| **B1** N-hermesc header regex matches neither `NCFunction<…>` nor class-E's `numbers/non-pointers` tail | **Fixed** | §6.1 rewritten from real `-dump-bytecode` runs at **all four** versions, with the v94 and v99 header blocks quoted verbatim, plus the real `Exception Handlers:` and ` Jump Tables: ` blocks. §7.A's regex now takes the optional `N?C?` prefix and alternates `symbols` vs `numbers, non-pointers`; the `NC` prefix is turned into a free assertion on `prohibitInvoke === "construct"` (the review's suggestion — it is ground truth we were otherwise ignoring). §9 adds a regression test that feeds the normaliser the sixteen verbatim header lines. The old "`K symbols` is 0 for v≥97" prose is deleted: the word does not appear in class-E output at all |
| **B3** spec stale against the fixture corpus | **Fixed** | §4.3 rewritten with the real 52/53 coverage matrix at four versions and the measured opcode numbers; §4.1 gains a fully worked, measured example; §9's switch bullet is now a hard requirement with no waiver branch; the old O-1 request for a fixture that already exists is deleted, and the genuinely-open `StringSwitchImm` half is kept as the new O-1 |
| **S1** probe samples rather than verifies on large files | **Fixed (this half)** | §3.3 requires `decodeModule` to attach the probe-provenance hint to decode errors outside the probe sample; the `ProbeReport` fields it reads are added in spec 01 §6.4 step 4 |
| **N3** canonical-mode string truncation point unspecified | **Fixed** | §6.2 now states the rule exactly (escape first, cut at `maxStringPreview` *escaped* characters, never split an escape sequence, append U+2026 only if something was dropped) and forbids hand-transcribing the expected value into a test — generate it once, commit it as golden |
| B2, S2, S3, S4, S5, S6, N1, N2, N4, N5 | Not this spec's | B2/S4/S6/N1/N4/N5 in spec 01; S2/S3/S5/N2 in spec 00 |

**Not adopted:** nothing was rejected. Beyond the review, §6.1 also documents the
` Jump Tables: ` and `StringSwitchImm count:` blocks (neither was in the first
draft, and both appear in real output, so a normaliser that ignored them would
have failed on fixtures 52/53), and §4.1 records that the new switch fixtures do
**not** discriminate the absolute-vs-relative alignment rule — so that rule stays
a reasoned choice rather than a tested one.
