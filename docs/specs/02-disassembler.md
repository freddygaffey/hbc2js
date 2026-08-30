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

### 4.2 `StringSwitchImm` (v≥99)

Operands: `(Reg8 value, UInt32 globalIndex, UInt32 tableOffset, Addr32 defaultTarget, UInt32 tableSize)`.
Table entries are `{ uint32 caseLabelStringID; int32 target; }` pairs, same
4-alignment rule, targets `ip`-relative, `byteLength = 8 * tableSize`. Validate
each `caseLabelStringID < stringCount`. `header.numStringSwitchImms` counts these
instructions file-wide — assert the count of decoded `StringSwitchImm`
instructions equals it when the whole module is decoded (a cheap, strong
cross-check; record as a diagnostic mismatch, not fatal, since partial decoding
is legal).

### 4.3 Coverage warning

**No fixture in the corpus contains any switch instruction.** Verified by
disassembling all 51 construct fixtures at v94 and v99 with the oracle:
`hermesc` lowers small `switch` statements to comparison chains, and
`09-switch-fallthrough` / `10-switch-no-fallthrough` produce `JStrictEqual`
chains, not `SwitchImm`. **Everything in §4 is therefore written blind** (risk
R5). Do not mark M2 complete without either (a) a new fixture with ~16 dense
integer cases plus a `-O` variant, or (b) an explicit overseer waiver recorded
in `docs/STATUS.md`. See O-1.

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
and makes the strongest possible oracle. Per function:

```
Function<?anon_0_gen>(1 params, 17 registers, 0 symbols):
[@ 0] StartGenerator
[@ 1] LoadConstUndefined 2<Reg8>
[@ 5] ResumeGenerator 0<Reg8>, 1<Reg8>
[@ 8] JmpTrueLong 168<Addr32>, 1<Reg8>
[@ 17] SaveGenerator 4<Addr8>
...
Exception Handlers:
0: start = 30, end = 50, target = 52
1: start = 30, end = 71, target = 73
```

Rules:
* offsets decimal, function-relative;
* operands are `<decimal value><TypeName>` joined with `", "`;
* `Addr8`/`Addr32` print the **raw displacement**, not a resolved target;
* `Double` prints via `String(value)` (shortest round-trip);
* no comments, no string text, no label lines;
* the `Exception Handlers:` block follows the instructions when the function has
  handlers, entries in file order, offsets decimal.

The `Function<name>(N params, M registers, K symbols)` line is emitted for
compatibility; `K symbols` is `environmentSize` for v≤96 and `0` for v≥97 (the
field no longer exists — §3.2 of HBC-FORMAT).

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
| `string` | `s<N> "<escaped, ≤32 chars, … if truncated>"` | `s19 "gen"` |
| `function` | `f<N> "<name>"` | `f6 "ze"` |
| `bigint` | `bi<N> <decimal>n` | `bi0 42n` |
| `regexp` | `re<N>` | `re0` |
| `builtin` | `b<N> "<name>"` from the builtin table | `b52 "spawnAsync"` |
| `cacheIndex` | `#c<N>`, omitted when `showCacheIndices: false` | `#c1` |
| `shape` | `sh<N>(numProps=<k>)` | `sh0(numProps=2)` |
| `literalOffset` | `lit@0x<hex>` | `lit@0x000c` |
| `double` | `String(value)` | `7.3` |
| `imm` | decimal | `42` |

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

Both live in `tests/oracle/disasm/`. Each produces two normalised line arrays
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
3. Compare `probe.hbc` with the fixture `.hbc`. If they differ, `t.skip()` with
   the byte-length delta in the message and record it in
   `tests/oracle/known-divergences.md`. Expect exactly one such skip:
   `hermes-dec-sample/v99.hbc` (built by a non-public Hermes commit; different
   builtin table and an extra `Unreachable` — see `docs/TOOLCHAIN.md`). Use
   `v99-public.hbc` for the v99 comparison instead.
4. Run `hermesc -dump-bytecode -pretty-disassemble=false source.js` in the same
   temp dir; capture stdout.
5. Disassemble the fixture `.hbc` with our `raw` mode.
6. Normalise both (N-hermesc below) and compare.

**Normaliser N-hermesc.** From hermesc's stdout keep only:

* lines matching `^Function<(?<name>[^>]*)>\((?<p>\d+) params, (?<r>\d+) registers, (?<s>\d+) symbols\):$`
  → `FUNC <p> <r> <s>` (drop the name: hermesc prints the *source* name while we
  print the string-table name; they agree on our fixtures but the name is not
  what this test is proving);
* lines matching `^\[@ (?<off>\d+)\] (?<op>\w+)(?: (?<ops>.*))?$`
  → `<off> <op> <ops normalised>`;
* the `Exception Handlers:` header and its `^(\d+): start = (\d+), end = (\d+), target = (\d+)$`
  lines → `EH <n> <start> <end> <target>`.

Drop everything else: the `Bytecode File Information` block, `Global String
Table`, `Function Source Table`, `Offset in debug table:` lines, the regexp
bytecode dump, all `Debug *` tables, and blank lines. Operand normalisation:
collapse runs of whitespace to one space; leave `<Type>` suffixes intact.

Function ordering: hermesc dumps functions in index order, same as us. Assert
the counts match before comparing, so an ordering bug reports as a count
mismatch rather than 400 line diffs.

`hermesc -dump-bytecode` also prints the decoded debug source table
(`bc 24: line 7 col 1 …`). Ignore it in M2 — but note it is a ready-made oracle
if spec 01's O-3 (debug delta stream) is ever taken up.

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
`tests/oracle/known-divergences.md`):

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
fixture in `tests/unit/disasm/reencode.test.ts`.

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

- [ ] Every function of every fixture binary (~141 files) decodes with zero
      errors and zero warn-diagnostics, and `ip` lands exactly on
      `bytecodeSizeInBytes` for every function.
- [ ] §7.E re-encoding round-trip is byte-exact for every instruction of every
      fixture.
- [ ] Every jump target in every fixture resolves to an instruction boundary
      inside the function.
- [ ] `hermesc -dump-bytecode -pretty-disassemble=false` diff (7.A) is
      **empty** for every fixture where the `.hbc` reproduces byte-identically,
      at v84, v94 and v99; the only skip is `hermes-dec-sample/v99.hbc`, with a
      recorded reason.
- [ ] `hbc-disassembler` diff (7.B) is **empty** for every fixture binary
      including `hermes-dec-sample/v99.hbc`, with an allowlist of at most the
      four entries in §7.B.
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
- [ ] Decoding any v99 fixture with the `hbc99-feb2026` table fails within the
      first 16 bytes (the R1 alarm still rings from this layer too).
- [ ] Canonical golden snapshots exist for every `(fixture, version)` and are
      byte-stable across two runs and across macOS/Linux.
- [ ] Switch decoding: either a fixture exercises `UIntSwitchImm`/`SwitchImm`
      and the test asserts its case targets, **or** the skip message names
      `docs/specs/02-disassembler.md` §4.3 and the overseer waiver is recorded
      in `docs/STATUS.md`.
- [ ] `hbc2js disasm --mode=raw` output for `v94.hbc` is byte-identical to
      normalised `hermesc` output (this is 7.A, but assert it as a CLI-level
      test too, so the CLI path is covered).
- [ ] Perf numbers for the largest available input are recorded in
      `docs/STATUS.md`.
- [ ] No file under `tests/fixtures/**` or `tools/equiv/**` was modified.

---

## 10. Estimated complexity

**Sonnet for the bulk.** The decoder is a loop over a generated table; the
printer is formatting; the normalisers are regex work with a clear target
format, all of which is verifiable against real output the same session.

Two spots deserve care and an Opus review:

* **`switchtable.ts`** — the absolute-vs-relative alignment rule (§4.1) and the
  extent-beyond-`bytecodeSizeInBytes` rule (§4.2) are both silent-corruption
  bugs if wrong, and **no fixture will catch them** (§4.3).
* **The normaliser allowlist** — the temptation, when a diff fails, is to widen
  the normaliser until it passes. That converts a real bug into a green test.
  Any new allowlist entry must cite bytes, and reviewers should treat a growing
  `known-divergences.md` as a defect signal.

Estimated size: `decode.ts` ~250 lines, `labels.ts` ~60, `switchtable.ts` ~150,
`print.ts` ~350, roles table ~80, tests ~900.

---

## 11. Open questions for the overseer

* **O-1 — the switch fixture.** No fixture in the corpus contains a switch jump
  table (§4.3), so §4 ships untested. I would like the fixtures agent to add
  `52-switch-dense-int` (≥ 16 consecutive integer cases + default) and, for
  v99, `53-switch-string` (a `switch` over string literals, which should reach
  `StringSwitchImm`), each with a `-O` variant. Approve, and who writes them?
* **O-2 — `raw` mode's fidelity target.** I have pinned `raw` mode to hermesc's
  exact rendering, which makes the primary oracle a trivial diff but means our
  "own" format is really hermesc's. The alternative is a format of our choosing
  plus a richer normaliser. I prefer the current choice (the normaliser is where
  bugs hide), but it does mean `raw` output changes if hermesc's does. Agree?
* **O-3 — jump-table bytes and the M4 CFG.** `extentEnd` tells the CFG builder
  where a function really ends. Should `FunctionRecord` in spec 01 gain an
  `extentEnd` field (computed lazily by asking the disassembler), or does the
  CFG builder call `decodeFunction` and read it from there? Currently the
  latter, which keeps spec 01 free of any opcode knowledge.
* **O-4 — do we keep `hbcdump` in the oracle set?** `tools/hermesc/v84/hbcdump`
  is MIT, reads `.hbc` **directly** (unlike `hermesc -dump-bytecode`), and is
  version-locked to 84. That makes it a third, licence-clean, direct-on-binary
  oracle — but only for v84. Worth wiring up as `tests/oracle/disasm/hbcdump`,
  or is two oracles enough?
