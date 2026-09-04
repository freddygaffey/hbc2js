# The Hermes bytecode (HBC) file format

Our own write-up of the on-disk format, derived from the **MIT-licensed** Facebook/Meta
Hermes sources and verified byte-for-byte against the fixtures in `tests/fixtures/hermes-dec-sample/`
(`v84.hbc`, `v94.hbc`, `v99.hbc`, `v99-public.hbc`). It is intended to be complete enough that an implementation
agent can write a parser from this document alone.

**Provenance / licence note.** Every structural claim below is traced to a file in
`github.com/facebook/hermes` (MIT). No part of this document is derived from
hermes-dec (AGPL); hermes-dec was used only as an *output oracle* — we compared its
printed field values with ours after the fact, and where we disagree with it, we say so
and show the bytes. See `docs/DECISIONS.md` D4.

Primary sources (cite these in code comments):

| What | Path in `facebook/hermes` |
|---|---|
| Magic, header, string/function header structs, section order | `include/hermes/BCGen/HBC/BytecodeFileFormat.h` |
| Bytecode version constant | `include/hermes/BCGen/HBC/BytecodeVersion.h` |
| Section write order, alignment, function-info layout | `lib/BCGen/HBC/BytecodeStream.cpp` |
| Opcode list, operand types, jump-table semantics | `include/hermes/BCGen/HBC/BytecodeList.def` |
| String-kind RLE encoding | `include/hermes/BCGen/HBC/StringKind.h` |
| Serialized literal (array/object buffer) tag encoding | `include/hermes/BCGen/{HBC/,}SerializedLiteralGenerator.h` |
| RegExp table entry | `include/hermes/Regex/RegexSerialization.h` |
| BigInt table entry | `include/hermes/Support/BigIntSupport.h` |
| Debug-info structures | `include/hermes/BCGen/HBC/DebugInfo.h` |
| `FuncKind` / `ProhibitInvoke` enums (v97+) | `include/hermes/BCGen/FunctionInfo.h` |
| Object shape table (v97+) | `include/hermes/BCGen/ShapeTableEntry.h` |
| Builtin numbering | `include/hermes/FrontEndDefs/Builtins.def` |

---

## 0. The single most important fact: version numbers are not layouts

There are **two live Hermes lineages**, and the `version` field alone does **not**
uniquely determine the file layout.

* **`main` (classic Hermes)** — frozen at `BYTECODE_VERSION = 96` (last bumped
  2023-08-29, "Add support for `hasIndices` RegExp flag"). This is what every shipping
  React Native app up to and including the RN 0.7x line emits. v84 and v94 live here.
* **`static_h` (Static Hermes)** — `97` (2024-05-24), `98` (2024-08-30), `99`
  (2026-02-12). This is the lineage that became the new stable release line
  (`260318099.0.0`, June 2026). v99 lives here.

Two concrete traps, both verified:

1. **v98 has two incompatible header layouts.** The commit that introduced
   `numStringSwitchImms` in the file header and rewrote `FUNC_HEADER_FIELDS`
   (`ParamCount` 7→5 bits, new `LoopDepth`, `NumberRegCount`, `NonPtrRegCount`,
   `PrivateNameCacheSize`) landed *before* the version was bumped to 99
   (`639e5d6afb16` is the parent of the v99 bump `42235b8d913f` and already has the new
   layout while still reporting 98). So a file reporting 98 may be "v98-early"
   (v97-shaped) or "v98-late" (v99-shaped).
2. **v99 has two incompatible opcode tables.** `NewTypedObjectWithBuffer` was inserted
   at **opcode index 4** by `913d31acd10a` (2026-03-05, "Revert bytecode version to 99")
   without a version bump, shifting every subsequent opcode number by one. Our
   both of our v99 fixtures (`v99.hbc`, and `v99-public.hbc` compiled here with
   `hermes-compiler@260318099.0.1`) decode correctly **only** against the *later*
   (220-opcode) table — see §11.2. The 219-opcode form existed in `static_h` between
   2026-02-12 and 2026-03-05 and can appear in bytecode built from that window.

**Implication for hbc2js:** the parser must treat `(version, layout-probe)` as the key,
not `version`. A cheap probe: decode the global function's first ~10 instructions with
each candidate table and reject the table that produces an operand referencing a
string/function id out of range, or that overruns `bytecodeSizeInBytes`. Record the
selected variant in the parse result so the disassembler and emitter agree.

### 0.1 Layout-equivalence classes

| Class | Versions | Header `uint32` count | Header padding | `SmallFuncHeader` | Distinguishing fields |
|---|---|---|---|---|---|
| A | 51–83 | 17 | 27 | 16 B | no `functionSourceCount` (pre-`cd92db3f`) |
| B | 84–86 | 17 | 27 | 16 B | `functionSourceCount` added; no BigInt |
| C | 87–96 | 19 | 19 | 16 B | `bigIntCount`, `bigIntStorageSize` added |
| D | 97, 98-early | 19 | 19 | 12 B | `objValueBufferSize` → `objShapeTableCount`; `arrayBufferSize` → `literalValueBufferSize`; `infoOffset` and `environmentSize` dropped from the function header |
| E | 98-late, 99 | 20 | 15 | 12 B | `numStringSwitchImms` added; `FUNC_HEADER_FIELDS` reshaped |

The file header is always **128 bytes** in every class — the padding array absorbs the
difference. That is a useful sanity check.

**Which classes are evidenced.** Gate fixtures only cover versions 84, 94, 96, 98,
99 — classes B, C, D/E (98's ambiguity window) and E. Class A (51–83) and the
84–86 slice of class B other than 84 itself have no fixture and no opcode table
generated for them (`candidatesForVersion` in `src/parse/layout.ts` returns
`opcodeTables: []`); `requireOpcodeTable` in `src/disasm/decode.ts` refuses with
`E_UNSUPPORTED_VERSION` before decoding a single instruction if a real file ever
resolves to one of them. This is not a soft default — there is no
`--allow-unverified` bypass, because there is no verified opcode table to hand it
even if there were one; the only working override is the existing
`--opcode-table=<id>` force flag, which supplies a real table instead of disabling
the check (CONSOLIDATION 27; `tests/gate/parse/unverified-paths.test.ts`).

---

## 1. Top-level file layout

The serializer (`BytecodeSerializer::serialize`) writes, in this exact order:

```
BytecodeFileHeader                    (128 bytes, always)
--- visitBytecodeSegmentsInOrder ---
functionHeaders    (SmallFuncHeader[functionCount])
stringKinds        (uint32[stringKindCount])
identifierHashes   (uint32[identifierCount])
smallStringTable   (uint32[stringCount])
overflowStringTable(uint64[overflowStringCount]   -- (offset,length) pairs)
stringStorage      (uint8[stringStorageSize])
literalValueBuffer / arrayBuffer  (uint8[...])
objKeyBuffer       (uint8[objKeyBufferSize])
objValueBuffer (≤v96)  |  objShapeTable (≥v97, 8 bytes each)
bigIntTable        ((uint32 offset, uint32 length)[bigIntCount])     -- ≥v87
bigIntStorage      (uint8[bigIntStorageSize])                        -- ≥v87
regExpTable        ((uint32 offset, uint32 length)[regExpCount])
regExpStorage      (uint8[regExpStorageSize])
cjsModuleTable     ((uint32,uint32)[cjsModuleCount])
functionSourceTable((uint32,uint32)[functionSourceCount])            -- ≥v84
--- end visit ---
function bytecode blobs (+ per-function jump tables)
function info sections  (large headers, exception tables, debug offsets)
debug info section      (at header.debugInfoOffset)
BytecodeFileFooter      (20-byte SHA-1 of everything above)
```

**Alignment rule.** Every `visit*` step and the debug-info section begin with
`pad(BYTECODE_ALIGNMENT)` where `BYTECODE_ALIGNMENT = alignof(uint32_t) = 4`. Each
sub-section of a function's *info* block is padded to `INFO_ALIGNMENT = 4`. Jump tables
appended to a function body are padded to 4 as well. **A parser must recompute each
section offset by walking this list with 4-byte alignment** — only `debugInfoOffset` is
stored explicitly.

### 1.1 Bytecode deduplication

`serializeFunctionsBytecode` deduplicates identical opcode arrays when optimisation is
on: two function-table entries can share one `offset`. Never assume function *N*'s body
ends where function *N+1*'s begins; use `bytecodeSizeInBytes`. Never assume offsets are
strictly increasing.

---

## 2. File header

```
off  size  field
  0     8  magic          = 0x1F1903C103BC1FC6   ("Hermes" in UTF-16BE, truncated)
  8     4  version        (uint32)
 12    20  sourceHash     (SHA-1 of the JS source)
 32     4  fileLength     (bytes, up to and including the footer)
 36     4  globalCodeIndex(index of the "global" function in the function table)
 40     4  functionCount
 44     4  stringKindCount
 48     4  identifierCount
 52     4  stringCount
 56     4  overflowStringCount
 60     4  stringStorageSize
```
then, **class C/D/E only** (v87+):
```
 64     4  bigIntCount
 68     4  bigIntStorageSize
```
then (offsets shown for class C/D/E; subtract 8 for classes A/B):
```
 72     4  regExpCount
 76     4  regExpStorageSize
 80     4  arrayBufferSize        (v≤96)  |  literalValueBufferSize (v≥97)
 84     4  objKeyBufferSize
 88     4  objValueBufferSize     (v≤96)  |  objShapeTableCount     (v≥97)
 --   [ 4  numStringSwitchImms — class E only, inserted here ]
 92     4  segmentID
 96     4  cjsModuleCount
100     4  functionSourceCount    (v≥84)
104     4  debugInfoOffset
108     1  options (bitfield)
109  19/15 padding (zeroes)
128        end of header
```
Class E shifts `segmentID`…`debugInfoOffset` up by 4 (→ 96/100/104/108), putting
`options` at 112 and 15 padding bytes after it.

`options` bits (LSB first): `staticBuiltins`, `cjsModulesStaticallyResolved`,
`hasAsync` (v≤96; dropped in the static_h line, where the byte is usually 0).

### 2.1 Verified against the fixtures

`tests/fixtures/hermes-dec-sample/v94.hbc` (2256 bytes):

```
magic=1f1903c103bc1fc6  version=94  fileLength=2256  globalCodeIndex=0
functionCount=8  stringKindCount=2  identifierCount=17  stringCount=34
overflowStringCount=0  stringStorageSize=238  bigIntCount=0  bigIntStorageSize=0
regExpCount=1  regExpStorageSize=66  arrayBufferSize=0  objKeyBufferSize=0
objValueBufferSize=0  segmentID=0  cjsModuleCount=0  functionSourceCount=2
debugInfoOffset=0x638  options=0x04   (hasAsync)
```
Derived section offsets: functionHeaders `0x80`, stringKinds `0x100`,
identifierHashes `0x108`, smallStringTable `0x14c`, stringStorage `0x1d4`,
regExpTable `0x2c4`, regExpStorage `0x2cc`, functionSourceTable `0x310`,
**first function bytecode `0x320`** — which matches function 0's stored `offset`.

`tests/fixtures/hermes-dec-sample/v99.hbc` (2999 bytes):

```
magic=1f1903c103bc1fc6  version=99  fileLength=2999  globalCodeIndex=0
functionCount=8  stringKindCount=2  identifierCount=19  stringCount=35
overflowStringCount=0  stringStorageSize=286  bigIntCount=0  bigIntStorageSize=0
regExpCount=1  regExpStorageSize=66  literalValueBufferSize=12  objKeyBufferSize=5
objShapeTableCount=1  numStringSwitchImms=0  segmentID=0  cjsModuleCount=0
functionSourceCount=2  debugInfoOffset=0xa24  options=0x00
```
Derived: functionHeaders `0x80` (8 × 12 = 96 bytes), stringKinds `0xe0`,
identifierHashes `0xe8`, smallStringTable `0x134`, stringStorage `0x1c0`,
literalValueBuffer `0x2e0`, objKeyBuffer `0x2ec`, objShapeTable `0x2f4`,
regExpTable `0x2fc`, regExpStorage `0x304`, functionSourceTable `0x348`,
**first function bytecode `0x358`** — matches function 0's large-header `offset`.

Both fixtures carry the same `sourceHash` (`a692192b…87c8`), confirming they are the
same source compiled by two different compilers.

`tests/fixtures/hermes-dec-sample/v84.hbc` (1898 bytes) confirms **class B**: with the
BigInt pair absent, `regExpCount`/`regExpStorageSize` sit at offsets 64/68,
`functionSourceCount` at 92, `debugInfoOffset` at 96, `options` at 100 and 27 padding
bytes follow. Decoded: `functionCount=8, stringKindCount=2, identifierCount=17,
stringCount=34, stringStorageSize=238, regExpCount=1, regExpStorageSize=66,
functionSourceCount=2, debugInfoOffset=0x620, options=0x04`. Section offsets come out
identical to v94's (first function bytecode at `0x320`), because v94's BigInt counts are
zero — a nice accident that makes the two directly comparable. Reading a v84 file with
the class-C field list produces obvious garbage (`cjsModuleCount = 1568`), which is a
cheap self-check.

`v99-public.hbc` (2981 bytes) is `source.js` recompiled here with the public
`hermes-compiler@260318099.0.1`. It is *not* byte-identical to `v99.hbc` (different
Hermes commit — see `docs/TOOLCHAIN.md`) but has the same section layout, the same
`literalValueBufferSize=12 / objKeyBufferSize=5 / objShapeTableCount=1 /
numStringSwitchImms=0`, the same first-bytecode offset `0x358`, and the same opening
byte sequence `40 03 00 43 10 00 00 00 …` — i.e. the same 220-opcode table.

---

## 3. Function headers

### 3.1 `SmallFuncHeader`, classes A–C (v51–v96) — 16 bytes

Little-endian bitfields, LSB first within each 32-bit word:

```
word 0:  offset               : 25   (file offset of the bytecode)
         paramCount           :  7   (includes `this`)
word 1:  bytecodeSizeInBytes  : 15
         functionName         : 17   (string-table index)
word 2:  infoOffset           : 25   (file offset of this function's info block)
         frameSize            :  7   (number of registers)
byte 12: environmentSize      :  8
byte 13: highestReadCacheIndex:  8
byte 14: highestWriteCacheIndex: 8
byte 15: flags                :  8
```

`flags` (LSB first): `prohibitInvoke:2` (0 = prohibit call, 1 = prohibit construct,
2 = none), `strictMode:1`, `hasExceptionHandler:1`, `hasDebugInfo:1`, `overflowed:1`,
2 unused bits.

If `overflowed` is set, **only** `flags` and `getLargeHeaderOffset()` are meaningful,
where `getLargeHeaderOffset() = (infoOffset << 16) | (offset & 0xffff)`. Everything else
comes from a full `FunctionHeader` at that offset.

**Large `FunctionHeader` (v51–v96), 31 bytes, packed:**
`uint32 offset, paramCount, bytecodeSizeInBytes, functionName, infoOffset, frameSize,
environmentSize; uint8 highestReadCacheIndex, highestWriteCacheIndex, flags`.

### 3.2 `SmallFuncHeader`, class D (v97/98-early) — 12 bytes

```
word 0:  offset               : 25
         paramCount           :  7
word 1:  bytecodeSizeInBytes  : 15
         functionName         : 17
byte  8: frameSize            :  8
byte  9: highestReadCacheIndex:  8
byte 10: highestWriteCacheIndex: 8
byte 11: flags                :  8
```
`infoOffset` and `environmentSize` are gone. `flags` gains `kind:2` in bits 6–7
(`FuncKind`: 0 = Normal, 1 = Generator, 2 = Async).
Overflow encoding: `getLargeHeaderOffset() = (functionName << 16) | (offset & 0xffff)`.
Large header: 23 bytes (`uint32 ×5` + `uint8 ×3`).

### 3.3 `SmallFuncHeader`, class E (v98-late/v99) — 12 bytes

```
word 0:  offset               : 25
         paramCount           :  5
         loopDepth            :  2
word 1:  bytecodeSizeInBytes  : 14
         functionName         :  8   (!!)
         numberRegCount       :  5
         nonPtrRegCount       :  5
byte  8: frameSize            :  8
byte  9: readCacheSize        :  8
byte 10: writeCacheSize       :  7
         privateNameCacheSize :  1
byte 11: flags                :  8   (prohibitInvoke:2, strictMode:1,
                                      hasExceptionHandler:1, hasDebugInfo:1,
                                      overflowed:1, kind:2)
```
Overflow encoding: `getLargeHeaderOffset() = (functionName << 24) | (offset & 0xffffff)`.

**Critical behavioural change in class E.** `overflowed` no longer means "a field did not
fit". `serializeFunctionInfo` writes an info block **iff** the function has an exception
handler, has debug info, or genuinely overflows; and `serializeFunctionTable` writes an
*overflowed* small header whenever an info offset exists. So in practice **almost every
real function is "overflowed"** in v99 (6 of 8 in our fixture), and functions with no
handlers and no debug info have **no info block at all**. Note also that
`functionName` is only 8 bits in the small header, so any function whose name string id
exceeds 255 is forced into the large header — in a real bundle that is nearly all of them.

**Large `FunctionHeader` (class E), 36 bytes, packed — v99 and v98-early(!) only.**
```
uint32 offset, paramCount, loopDepth, bytecodeSizeInBytes, functionName,
       numberRegCount, nonPtrRegCount, frameSize;
uint8  readCacheSize, writeCacheSize, privateNameCacheSize, flags;
```

**v98-late is 37 bytes, not 36 — `flags` is at offset 36, not 35.** Hermes
commit `f74f6bbe37` (present for `BYTECODE_VERSION == 98` only; reverted by
`913d31acd1` before v99 shipped) added a 1-bit `NumCacheNewObject` field to
class E's `FUNC_HEADER_FIELDS`. In the *packed* small header (above) this
costs nothing — it is squeezed into byte 10 alongside `writeCacheSize`
(7 bits to 6) with `privateNameCacheSize` unchanged at bit 7 — but the
*unpacked* large header gives every field its own byte-or-wider member
regardless of packed bit-width, so it inserts a whole extra `uint8` between
`writeCacheSize` and `privateNameCacheSize`:

```
uint32 offset, paramCount, loopDepth, bytecodeSizeInBytes, functionName,
       numberRegCount, nonPtrRegCount, frameSize;
uint8  readCacheSize, writeCacheSize, numCacheNewObject /* v98-late only */,
       privateNameCacheSize, flags;
```

This shifts `flags` from offset 35 to offset 36 for v98-late's large header —
get this wrong and every *overflowed* v98 function (the common case, see the
class-E overflow note above) reads `prohibitInvoke`/`strictMode`/
`hasExceptionHandler`/`hasDebugInfo`/`kind` from the wrong byte. `hermes-dec`'s
`hbc-disassembler` still has exactly this bug as of the version pinned by this
project (`docs/TOOLCHAIN.md`) — see `tests/gate/oracle/known-divergences.md`
item 9 for the byte-level evidence and the narrow, function-scoped allowlist
this project uses to work around it in the 7.B oracle diff. `numCacheNewObject`
itself is discarded on parse (not part of this project's public API); its
value is redundant with the small header's own packed copy.

### 3.4 Verified: v94 function table

| # | offset | params | size | nameID (string) | infoOffset | frame | env | flags |
|---|---|---|---|---|---|---|---|---|
| 0 | 0x320 | 1 | 235 | 7 `global` | 0x5c8 | 16 | 0 | 0x12 dbg |
| 1 | 0x40b | 2 | 30 | 17 `testx` | 0x5d4 | 15 | 0 | 0x11 dbg, prohibitConstruct |
| 2 | 0x429 | 2 | 9 | 2 `?anon_0_testx` | 0x5e0 | 1 | 0 | 0x01 |
| 3 | 0x432 | 2 | 124 | 1 `?anon_0_?anon_0_testx` | 0x5e0 | 16 | 0 | 0x12 dbg |
| 4 | 0x4ae | 1 | 9 | 19 `gen` | 0x5ec | 1 | 0 | 0x01 |
| 5 | 0x4b7 | 1 | 179 | 3 `?anon_0_gen` | 0x5ec | 17 | 0 | 0x1a dbg + exc |
| 6 | 0x56a | 1 | 54 | 25 `ze` | 0x620 | 12 | 1 | 0x12 dbg |
| 7 | 0x5a0 | 1 | 37 | 9 `zb` | 0x62c | 9 | 0 | 0x12 dbg |

(Functions 2 and 3 share an `infoOffset` because function 2 has an *empty* info block —
in v≤96 `infoOffset` is recorded for every function whether or not anything is written.)

### 3.5 Verified: v99 function table

Small headers at `0x80`, 12 bytes each. Six are `overflowed` (flags `0x20`), pointing at
info blocks `0x89c, 0x8c4, 0x8ec, 0x914, 0x97c, 0x9a4`. The two non-overflowed entries
are the generator *outer* stubs:

```
fn2: offset=0x463 params=1 loopDepth=0 size=24 nameID=19('gen')
     numberRegCount=1 nonPtrRegCount=0 frameSize=2 flags=0x41 → kind=1 (Generator)
fn4: offset=0x4d4 params=2 size=27 nameID=1('?anon_0_testx')
     frameSize=3 flags=0x41 → kind=1 (Generator)
```

Function 0's large header at `0x89c` decodes byte-for-byte as
`offset=0x358, paramCount=1, loopDepth=0, bytecodeSizeInBytes=236, functionName=6
('global'), numberRegCount=1, nonPtrRegCount=1, frameSize=18, readCacheSize=9,
writeCacheSize=5, privateNameCacheSize=0, flags=0x12` — 36 bytes, immediately followed
by a 4-byte `DebugOffsets` (`sourceLocations = 0`) and then function 1's info block at
`0x8c4`. Exactly as §4 predicts.

---

## 4. The per-function info block

At `infoOffset`, in this order, each sub-section 4-byte aligned:

1. **Large `FunctionHeader`** — present iff `flags.overflowed`.
2. **Exception handler table** — present iff `flags.hasExceptionHandler`:
   `uint32 count`, then `count × { uint32 start; uint32 end; uint32 target; }`.
   `start` is inclusive, `end` exclusive, both relative to the *function's* bytecode
   start; `target` is the handler entry, also function-relative.
3. **`DebugOffsets`** — present iff `flags.hasDebugInfo`:
   * v≤v83: `uint32 sourceLocations; uint32 lexicalData;` (8 bytes)
   * v84–v96: `uint32 sourceLocations; uint32 scopeDescData; uint32 textifiedCallees;`
     (12 bytes)
   * v97+: `uint32 sourceLocations;` (**4 bytes**)

   `0xFFFFFFFF` is the "no offset" sentinel.

> **hermes-dec is wrong here for v99.** It prints a two-field `DebugOffsets` for v99
> (e.g. `source_locs=0x66, scope_desc_data=0x47b` for function 1). `0x47b` is in fact
> the *next function's* bytecode offset — it has read 4 bytes past the end of the
> 4-byte v99 `DebugOffsets`. Do not copy that behaviour.

### 4.1 Verified: v94 function 5 (`?anon_0_gen`), info at `0x5ec`

```
0x5ec: count = 3
       [start=0x1e end=0x32 target=0x34]
       [start=0x1e end=0x47 target=0x49]
       [start=0x4b end=0x95 target=0x97]
0x618: DebugOffsets { sourceLocations=0x13c, scopeDescData=0, textifiedCallees=0 }
0x620: function 6's info block
```

### 4.2 Verified: v99 function 5 (`gen`, the generator body), info at `0x914`

```
0x914: FunctionHeader { offset=0x4ef, paramCount=1, loopDepth=1, size=489,
                        functionName=19, numberRegCount=0, nonPtrRegCount=0,
                        frameSize=32, readCache=6, writeCache=0, privName=0,
                        flags=0x1a (exc + dbg) }              [36 bytes]
0x938: count = 5
       [0x60,0x116,0x17b] [0x11e,0x125,0x17b] [0x131,0x157,0x17b]
       [0x15f,0x166,0x17b] [0x172,0x17b,0x17b]
0x978: DebugOffsets { sourceLocations=0x97 }                  [4 bytes]
0x97c: function 6's info block
```

### 4.3 Handler-table semantics

Handlers are stored innermost-first for a given range and may overlap and nest. To build
a CFG, sort by `(start, -end)`; for a given pc the *first* matching entry in file order
is the active handler. A `target` block always begins with a `Catch <reg>` instruction
which binds the thrown value. `finally` is **not** represented: the compiler duplicates
the finally body into the normal path and into a synthesised catch-and-rethrow handler.
Recovering `finally` therefore requires recognising duplicated blocks (see
`docs/PRIOR-ART.md` §7).

---

## 5. String table

Three parallel structures plus a byte blob.

### 5.1 String kinds (RLE)

`stringKinds` is `uint32[stringKindCount]`, each entry
`kind = datum >> 31` (0 = String, 1 = Identifier), `count = datum & 0x7fffffff`.
Expanding the runs gives one kind per string id, in order. Hermes emits all
non-identifier strings first, then all identifiers, so in practice you get two entries.

Verified — v94: `String ×17`, `Identifier ×17` (`identifierCount = 17` ✓).
v99: `String ×16`, `Identifier ×19` (`identifierCount = 19` ✓).

The kind matters for output: an *Identifier* is a property name / global name and may be
emitted as `obj.foo`; a *String* is a literal and must be quoted. Only identifiers get an
entry in `identifierHashes`.

### 5.2 `identifierHashes`

`uint32[identifierCount]` — the runtime's precomputed hashes, indexed by *identifier*
ordinal (not by string id). A decompiler can skip this section entirely; it only needs
its size (`4 × identifierCount`) to find the next section.

### 5.3 `SmallStringTableEntry` (4 bytes each, `stringCount` of them)

```
bit  0     : isUTF16
bits 1..23 : offset  (byte offset into stringStorage)
bits 24..31: length
```
`length == 0xFF` means the entry has overflowed: `offset` is then an index into
`overflowStringTable`, whose entries are `{ uint32 offset; uint32 length; }`.

`length` is in **characters**, so a UTF-16 string occupies `2 × length` bytes of storage.
UTF-16 storage is little-endian and may contain unpaired surrogates — decode leniently
and re-encode carefully (see §12).

Verified on v94: 34 entries, none overflowed, e.g. id 12 is the regexp pattern
`dkooDD JPOD D09D\n\\  @ .\r\n\t@ \x00 D+D  ` and id 16 is a UTF-16 string containing
U+202F. On v99 the same source yields 35 strings because the compiler adds
`"Generator functions may not be called on executing generators"` and the identifiers
`value` / `done` for the generator result objects.

---

## 6. Literal buffers

### 6.1 v≤96: three buffers

* `arrayBuffer` — serialised element lists for `NewArrayWithBuffer[Long]`.
* `objKeyBuffer` + `objValueBuffer` — parallel key/value lists for
  `NewObjectWithBuffer[Long]`, which carries **two** indices (Arg4 = key-buffer index,
  Arg5 = value-buffer index).

### 6.2 v≥97: one value buffer plus a shape table

* `literalValueBuffer` — values for both array and object literals.
* `objKeyBuffer` — keys.
* `objShapeTable` — `{ uint32 keyBufferOffset; uint32 numProps; }` per entry.
  `NewObjectWithBuffer` now takes only `(dest, shapeTableIndex, valueBufferOffset)`.

### 6.3 Serialized literal encoding (both eras)

A buffer is a sequence of *runs*. Each run starts with a tag:

* short form (1 byte), run length ≤ 15: `0 t t t l l l l`
* long form (2 bytes, big-endian-ish as written): `1 t t t l l l l  l l l l l l l l`
  — i.e. bit 15 set, `ttt` = type, low 12 bits = length (max 4095).

Tag types (`t` shifted into bits 4–6 of the first byte):

| Tag | Value | Payload per element |
|---|---|---|
| Null | 0 | none |
| True | 1 | none |
| False | 2 | none |
| Number | 3 | 8 bytes, IEEE-754 double, LE |
| LongString | 4 | 4 bytes, uint32 string id |
| ShortString | 5 | 2 bytes, uint16 string id |
| ByteString / **Undefined** | 6 | **v≤96: 1 byte, uint8 string id. v≥97: NO PAYLOAD — the element is `undefined`.** |
| Integer | 7 | 4 bytes, int32 |

**Tag 6 changed meaning at v≥97.** Hermes's
`include/hermes/BCGen/SerializedLiteralGenerator.h` at both vendored v98-late/v99
pins (639e5d6, 913d31a) defines `UndefinedTag = 6 << 4` and has no `ByteStringTag`
at all (with a TODO about restoring it); short string ids go through ShortString.
Reading it with a payload at v≥97 mis-decodes everything after it — measured:
`24-generator-return-throw` v99's finished-generator result comes out as
`{value: "next", done: 1}` instead of `{value: undefined, done: true}`. Measured
from bytes too: `47-typeof-instanceof-in` v99's value buffer reads
`71 01000000 | 61 | 72 0a000000 14000000` = Integer 1, tag 6 with no payload,
Integer 10, Integer 20 — and 0 of 162 v≥97 key buffers use tag 6 while all 51
legacy ones do. `src/emit/literals.ts` reads it per era.

So the old sentence "`undefined` has no tag — it is encoded as a string tag by
the generator, so treat 'string' as the fallback" holds only for **v≤96**. At
v≥97 `undefined` has its own tag and there is no string fallback.

Two related v99 facts: tag 0 is `ValueNullOrKeyPrivateNameTag` there — a null tag
in a *key* buffer means a **private name**, which `src/emit/literals.ts` refuses
with `E_EMIT_UNSUPPORTED` rather than decoding as `null` — and the exact
cut-over commit between v96 and 639e5d6 is not pinned; "≥97" is the boundary the
0/162-vs-51/51 counts support. All values little-endian.

---

## 7. BigInt table (v≥87)

`bigIntTable` is `{ uint32 offset; uint32 length; }[bigIntCount]`, indexing
`bigIntStorage`. The storage holds the bigint's **two's-complement little-endian byte
magnitude**; the sign is the top bit of the last byte. `LoadConstBigInt[LongIndex]`
takes a table index. To emit JS, convert to a decimal string and append `n`.

None of the `hermes-dec-sample` fixtures exercises this: the BigInt lines in
`tests/fixtures/hermes-dec-sample/source.js` are commented out, so `v94.hbc`/`v99.hbc`
all have `bigIntCount = 0` (v84 too — it predates the BigInt table anyway, being
layout class B). Real coverage comes from
`tests/fixtures/constructs/46-bigint-arithmetic` once it is compiled. Coverage gap
tracked in `docs/PRIOR-ART.md` §7.4.

---

## 8. RegExp table

`regExpTable` is `{ uint32 offset; uint32 length; }[regExpCount]` indexing
`regExpStorage`, which holds Hermes' *compiled regexp bytecode* — not the source.

**But the source is available anyway**: `CreateRegExp <dest>, <patternStringID>,
<flagsStringID>, <regexpTableIndex>` carries the pattern and flags as string-table ids.
For decompilation we can ignore `regExpStorage` entirely and emit
`new RegExp(pattern, flags)` (or a `/…/flags` literal when the pattern is safe to inline).

Verified on both fixtures: `regExpCount = 1`, `regExpStorageSize = 66`, and the
`CreateRegExp` in `global` references pattern string 12/11 and flags string 13/12
(`gmi`). We never need to decode the 66 bytes.

---

## 9. CJS module table & function source table

* `cjsModuleTable` — `(uint32, uint32)` pairs. If `options.cjsModulesStaticallyResolved`
  is set the pairs are `(functionIndex, moduleOffset)`; otherwise
  `(stringID, functionIndex)`. Only present for CJS-resolved bundles (Metro's
  `require` maps). `cjsModuleCount` counts *pairs*, so the section is `8 × count` bytes.
* `functionSourceTable` (v≥84) — `(uint32 functionIndex, uint32 stringID)` pairs
  recording the *original source text* of functions that need `Function.prototype.toString`
  fidelity (in practice: functions passed to `eval`-like APIs, and — as in both our
  fixtures, where `functionSourceCount = 2` — a couple of compiler-retained sources).
  **Free win:** if a function appears here, we can emit its original source verbatim
  instead of decompiling it.

---

## 10. Debug info section

At `header.debugInfoOffset`:

```
DebugInfoHeader:
  uint32 filenameCount
  uint32 filenameStorageSize
  uint32 fileRegionCount
  [v≤96 only] uint32 scopeDescDataOffset
  [v≤96 only] uint32 textifiedCalleeOffset
  [v≤96 only] uint32 stringTableOffset
  uint32 debugDataSize
then:
  StringTableEntry filenameTable[filenameCount]   (8 bytes each: offset, length)
  uint8            filenameStorage[filenameStorageSize]
  DebugFileRegion  files[fileRegionCount]         ({fromAddress, filenameId,
                                                    sourceMappingUrlId}, 12 bytes)
  uint8            data[debugDataSize]
```

`data` is a variable-length-encoded delta stream of `(address, line, column)` triples per
function, entered at each function's `DebugOffsets.sourceLocations`. **Debug info is
optional for us**: it is stripped from most shipped bundles, and per SPEC we do not
attempt name recovery. Parse the header (to skip the section correctly) and otherwise
ignore it, but *do* expose it: when present, `filenameTable` + line numbers make the
emitted JS dramatically easier to eyeball, and `functionSourceTable` (§9) plus filenames
give us a cheap module-boundary signal for large bundles.

---

## 11. Instruction encoding

### 11.1 Encoding rules

A function body is a flat byte string of length `bytecodeSizeInBytes` starting at the
header's `offset`. Instructions are:

```
uint8 opcode
operand ...        (fixed per opcode, little-endian, no alignment, no padding)
```

Operand types and widths (`DEFINE_OPERAND_TYPE` in `BytecodeList.def`):

| Type | Bytes | Meaning |
|---|---|---|
| `Reg8` | 1 | register index (frame slot) |
| `Reg32` | 4 | register index |
| `UInt8` | 1 | small immediate / cache index / slot index |
| `UInt16` | 2 | function id, string id (short form) |
| `UInt32` | 4 | string id, bigint id, regexp id, environment size |
| `Addr8` | 1 | **signed** jump displacement relative to the *start of the instruction* |
| `Addr32` | 4 | **signed** jump displacement relative to the *start of the instruction* |
| `Imm32` | 4 | signed 32-bit integer literal |
| `Double` | 8 | IEEE-754 double, little-endian |

Jump targets are relative to the **opcode byte**, not to the following instruction.
Every conditional/unconditional jump exists in a short (`Addr8`) and a `…Long`
(`Addr32`) variant, generated by the `DEFINE_JUMP_{1,2,3}` macros — which means the two
variants are always **adjacent opcode numbers**, short first.

`SwitchImm` (v≤96) / `UIntSwitchImm` (v≥99):
`(Reg8 value, UInt32 tableOffset, Addr32 defaultTarget, UInt32 min, UInt32 max)`.
The jump table is appended *after* the function's opcodes, padded to 4 bytes. For an
in-range value the entry is at `ip + tableOffset + 4*(value - min)` where `ip` is the
address of the `SwitchImm` opcode, and `tableOffset` itself must be rounded **up** to a
4-byte boundary at runtime ("Arg2 is *unaligned*; it is dynamically aligned"). Entries
are `int32` displacements relative to `ip`.

`StringSwitchImm` (v≥99): `(Reg8 value, UInt32 globalIndex, UInt32 tableOffset,
Addr32 defaultTarget, UInt32 tableSize)`; the table is a sequence of
`{ uint32 caseLabelStringID; int32 target; }` pairs, again 4-aligned and `ip`-relative.
`header.numStringSwitchImms` counts these instructions across the file.

### 11.2 Opcode numbering

Opcode numbers are **positional**: the *n*-th `DEFINE_OPCODE_*` in `BytecodeList.def`,
with each `DEFINE_JUMP_n(X)` expanding to two entries (`X`, `XLong`), and the
`HERMES_RUN_WASM` block excluded from release builds. `Unreachable` is deliberately
opcode 0.

**Therefore a table must be generated per bytecode version.** Adding one opcode anywhere
renumbers everything after it. Recommended: check a generated table into the repo
(`src/opcodes/vNN.ts`) produced by a script that parses `BytecodeList.def` from a pinned
Hermes commit, with the commit hash recorded in the generated file.

Table sizes (release build, no WASM intrinsics):

| Version | Opcodes | Notes |
|---|---|---|
| 83, 84 | 185 | |
| 85, 86 | 187 | `+Inc`, `+Dec` |
| 87–91 | 190 | `+LoadConstBigInt`, `+LoadConstBigIntLongIndex`, `+ToNumeric` |
| 92 | 192 | `+CreateInnerEnvironment`, `+ThrowIfHasRestrictedGlobalProperty` |
| 93 | 190 | those two reverted |
| 94, 95, 96 | 192 | re-added |
| 97 | 197 | static_h |
| 98 | 201 | |
| 99 (Feb 2026) | 219 | |
| 99 (Mar 2026+) | **220** | `+NewTypedObjectWithBuffer` **at index 4** |

Spot-checks that a parser should assert on startup (verified against the fixtures):

* **v94**: `DeclareGlobalVar = 0x34 (52)`, `GetGlobalObject = 0x30 (48)`,
  `CreateEnvironment = 0x32 (50)`, `PutById = 0x3b (59)`,
  `CreateAsyncClosure = 0x68 (104)`, `Ret = 92`, `Catch = 93`,
  `CreateRegExp = 132`, `SwitchImm = 133`.
  First bytes at `0x320` are `34 11 00 00 00 | 34 13 00 00 00 | 34 19 00 00 00 | 32 01 |
  68 02 01 01 00 | 30 00 | 3b 00 02 01 11 00` =
  `DeclareGlobalVar 'testx'; DeclareGlobalVar 'gen'; DeclareGlobalVar 'ze';
   CreateEnvironment r1; CreateAsyncClosure r2, r1, fn#1; GetGlobalObject r0;
   PutById r0, r2, cache 1, 'testx'`.
* **v99 (220-opcode table)**: `GetParentEnvironment = 52`, `GetGlobalObject = 61`,
  `CreateFunctionEnvironment = 64`, `CreateTopLevelEnvironment = 65`,
  `DeclareGlobalVar = 67`, `GetByIdShort = 68`, `TryGetById = 72`,
  `PutByIdLoose = 74`, `Ret = 118`, `Catch = 119`, `CreateClosure = 132`,
  `CreateRegExp = 166`, `UIntSwitchImm = 167`, `StringSwitchImm = 168`,
  `CreateGenerator = 169`.
  First bytes at `0x358` are `40 03 00 | 43 10 00 00 00 | 43 13 00 00 00 |
  43 22 00 00 00 | 3d 02 | 84 04 03 01 00 | 4a 02 04 00 10 00` =
  `CreateFunctionEnvironment r3, size 0; DeclareGlobalVar 'testx';
   DeclareGlobalVar 'gen'; DeclareGlobalVar 'ze'; GetGlobalObject r2;
   CreateClosure r4, r3, fn#1; PutByIdLoose r2, r4, cache 0, 'testx'`.
  Against the 219-opcode (Feb 2026) table every one of these is off by one and the
  stream misdecodes immediately — which is how we know which table the fixture uses.

### 11.3 Property caching operands

`GetById` / `PutById` / `GetByIdShort` etc. carry a `UInt8` inline-cache index between
the object register and the string id. It is a runtime optimisation slot and carries **no
semantic meaning** — ignore it when decompiling, but you must consume the byte. Note in
v≥97 `PROPERTY_CACHING_DISABLED` changed from `0` to `0xFF`; irrelevant to us except that
you cannot infer anything from a zero.

### 11.4 Builtins

`CallBuiltin <dest>, <builtinNumber>, <argCount>` and
`GetBuiltinClosure <dest>, <builtinNumber>` index a **version-dependent** table
generated from `include/hermes/FrontEndDefs/Builtins.def`. Example: `spawnAsync` is
builtin **52** in v94 but **58** in v99 as this project's v99 hermesc numbers them
(57 by a literal read of the vendored `913d31ac` `Builtins.def` — that compiler has
one extra private builtin, `setFunctionName`, at 55, which shifts everything above
it by one; see `patchHbc99Mar2026Builtins` in `tools/gen-tables/gen.ts`). **The
builtin table is not self-describing in the file**: two compilers can share an
opcode table and still disagree about builtin numbers, so a bundle built by a
Hermes revision older than `setFunctionName` will be mis-numbered above 54 with no
way to detect it from the bytecode alone. Generate this table per version alongside the
opcode table. `CallBuiltin` takes its arguments in reverse order from the end of the
current frame (registers `frameSize-1` downwards), like `Call`.

---

## 12. Parser checklist and known traps

1. **Recompute every section offset** by walking §1 with 4-byte alignment. Only
   `debugInfoOffset` is stored.
2. **Probe the layout class**, don't trust `version` (§0). Assert the file header is
   exactly 128 bytes and that the computed "first function bytecode offset" equals the
   minimum function `offset`.
3. **Function bodies can be shared** (dedup). Key any per-function cache on the function
   index, not the offset.
4. **v99: `overflowed` is the common case**, and the large header is 36 bytes, not 31.
5. **v99 `DebugOffsets` is 4 bytes**, not 12.
6. **String lengths are in characters**; multiply by 2 for `isUTF16`.
7. **Jump displacements are relative to the opcode byte** and are signed.
8. **Jump tables are 4-aligned *after* the opcodes**, and `bytecodeSizeInBytes` covers
   the opcodes only — the jump table lives beyond it. Compute a function's true extent as
   `max(offset + size, end of its jump tables)` if you need to slice.
9. **`Addr8` jumps can be negative**; `Addr32` can jump outside the current basic block
   but never outside the function.
10. **Trailing footer**: the last 20 bytes are a SHA-1. `fileLength` includes them. A
    truncated bundle (common when extracting from an APK) will fail this check — warn,
    don't abort.
11. **Segmented bundles**: `segmentID != 0` means this is a Metro split segment; string
    ids are segment-local. Out of scope for v1, but detect and report it.

## 13. Getting ground truth

See `docs/TOOLCHAIN.md` for the working recipe (`tools/get-hermesc.sh`). In short,
`hermesc` binaries are on npm and encode the bytecode version in their package version:

* `hermes-compiler@260318099.0.1` → bytecode **99** (the `260318099` release line)
* `hermes-compiler@250829098.0.17` → bytecode **98**
* older `hermes-compiler@0.x` / `hermes-engine-cli@0.x` → the v8x–v96 era

`hermesc -emit-binary -out=x.hbc x.js` (add `-O` to exercise the optimiser and bytecode
dedup, `-g` for debug info). This is the source of the round-trip oracle in
`docs/DECISIONS.md` D3. Note from `docs/TOOLCHAIN.md`: compilation is reproducible
(v94 recompiles byte-identically) **provided you pass a relative filename**, because the
name is embedded in the output.
