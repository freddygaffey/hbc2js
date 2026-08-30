# Spec 01 — HBC parser (M1)

**Milestone:** M1
**Status:** ready to implement
**Owner model:** Sonnet for everything except `src/parse/layout.ts` and
`tools/gen-tables/gen.ts`, which want Opus or an Opus review (D5)
**Prerequisites:** spec 00
**Consumers:** spec 02 (disassembler), M3 harness, M4 CFG/emitter

Reference: `docs/HBC-FORMAT.md`. **You should not need to read it end to end.**
Every rule below cites the section it comes from; open only those. The
authoritative byte-level answers live there, this spec owns the *interfaces,
the probing strategy, the validation policy and the test plan*.

Licence rule that overrides everything (D4 / risk R6): tables are derived from
**MIT `facebook/hermes`** sources only. hermes-dec is an *output* oracle. Never
open its source, never vendor its generated tables.

> **Concurrency notice.** Do not create, edit or delete anything under
> `tests/fixtures/**` or `tools/equiv/**`. Stage files explicitly.

---

## 1. Scope

In scope for M1:

* File header, all five layout classes (`docs/HBC-FORMAT.md` §0.1, §2).
* Section offset computation by walking the serializer order (§1).
* String table: kinds, small/overflow entries, ASCII/UTF-16, identifier hashes (§5).
* Function headers: small + large, both eras, all flags including the v97+
  2-bit `kind` (§3).
* Per-function info blocks: exception handler tables, debug offsets (§4).
* Literal buffers (array / objKey / objValue) and the v97+ object shape table (§6).
* BigInt table + storage (§7), RegExp table (§8), CJS module table and function
  source table (§9).
* Debug info **header + filename table + file regions** only; the delta stream
  is exposed raw (§10, and O-3 below).
* Footer SHA-1 presence check (§12.10).
* Opcode + builtin table generation from pinned MIT Hermes commits (§11.2, §11.4).
* Layout probing per D8.

Out of scope for M1: instruction decoding (spec 02), the debug delta stream
decoder, segmented-bundle support beyond detection (§12.11).

---

## 2. Public API

```ts
// src/parse/module.ts  (re-exported from src/index.ts)

export function parseHbc(bytes: Uint8Array, options?: ParseOptions): HbcModule;

export interface ParseOptions {
  /** Force a layout class instead of probing. Diagnostic W_LAYOUT_FORCED is recorded. */
  readonly layout?: LayoutClass;
  /** Force an opcode table id instead of probing. */
  readonly opcodeTable?: OpcodeTableId;
  /** Compute and check the 20-byte SHA-1 footer. Default false (costs a full pass). */
  readonly verifyFooter?: boolean;
  /** Called for each Diagnostic as it is produced, in addition to collecting them. */
  readonly onDiagnostic?: (d: Diagnostic) => void;
  /** Hard ceiling on total bytes of function body the caller intends to decode.
   *  Purely advisory: the parser never eagerly reads bodies. Default Infinity. */
  readonly maxBodyBytes?: number;
}
```

`parseHbc` is **eager for tables, lazy for blobs**: it reads and validates every
fixed-size table (header, function headers, string entries, shape table, bigint
/ regexp / cjs / functionSource tables, per-function info blocks) and returns
views (not copies) for `stringStorage`, the literal buffers, `regExpStorage`,
`bigIntStorage`, function bodies and the debug data blob.

---

## 3. Types

All interfaces are fully `readonly`. Field names mirror `docs/HBC-FORMAT.md`.

### 3.1 Layout

```ts
export type LayoutClass = "A" | "B" | "C" | "D" | "E";
export type OpcodeTableId =
  | "hbc84" | "hbc94"
  | "hbc98-2024"        // the 201-opcode table at the v98 version bump (untested — no file known)
  | "hbc98-late"        // what hermes-compiler@250829098.0.10 actually emits (§5.2)
  | "hbc99-feb2026" | "hbc99-mar2026";                        // extend as tables are added
export type BuiltinTableId = OpcodeTableId;                   // same pinned commit

export interface LayoutProfile {
  readonly layoutClass: LayoutClass;
  readonly version: number;               // raw header value
  readonly opcodeTable: OpcodeTableId;
  readonly builtinTable: BuiltinTableId;
  readonly smallFuncHeaderSize: 12 | 16;
  readonly largeFuncHeaderSize: 23 | 31 | 36;
  readonly debugOffsetsSize: 4 | 8 | 12;
  readonly hasBigIntTable: boolean;        // classes C, D, E
  readonly hasShapeTable: boolean;         // classes D, E  (else objValueBuffer)
  readonly hasFunctionSourceTable: boolean;// classes B..E
  readonly hasStringSwitchImms: boolean;   // class E
  readonly funcKindInFlags: boolean;       // classes D, E
  readonly probe: ProbeReport;
}

export interface ProbeReport {
  readonly candidates: readonly ProbeCandidate[];
  readonly chosen: string;                 // "<layoutClass>/<opcodeTableId>"
  readonly forced: boolean;
  readonly decidedBy: readonly string[];   // ids of the probes that eliminated rivals
}
export interface ProbeCandidate {
  readonly layoutClass: LayoutClass;
  readonly opcodeTable: OpcodeTableId;
  readonly passed: boolean;
  readonly failedProbe?: string;           // e.g. "P2.a firstFunctionBodyOffset"
  readonly detail?: string;
}
```

### 3.2 Header

```ts
export interface HbcOptions {
  readonly staticBuiltins: boolean;
  readonly cjsModulesStaticallyResolved: boolean;
  readonly hasAsync: boolean;              // meaningful for v<=96 only
  readonly raw: number;                    // the whole byte, for diagnostics
}

export interface HbcHeader {
  readonly magic: bigint;                  // must be 0x1F1903C103BC1FC6n
  readonly version: number;
  readonly sourceHash: Uint8Array;         // 20 bytes, view
  readonly fileLength: number;
  readonly globalCodeIndex: number;
  readonly functionCount: number;
  readonly stringKindCount: number;
  readonly identifierCount: number;
  readonly stringCount: number;
  readonly overflowStringCount: number;
  readonly stringStorageSize: number;
  readonly bigIntCount: number;            // 0 in classes A/B
  readonly bigIntStorageSize: number;      // 0 in classes A/B
  readonly regExpCount: number;
  readonly regExpStorageSize: number;
  /** `arrayBufferSize` in classes A-C, `literalValueBufferSize` in D/E. One field. */
  readonly literalValueBufferSize: number;
  readonly objKeyBufferSize: number;
  readonly objValueBufferSize: number;     // classes A-C; 0 in D/E
  readonly objShapeTableCount: number;     // classes D/E; 0 in A-C
  readonly numStringSwitchImms: number;    // class E; 0 otherwise
  readonly segmentID: number;
  readonly cjsModuleCount: number;
  readonly functionSourceCount: number;    // 0 in class A
  readonly debugInfoOffset: number;
  readonly options: HbcOptions;
}
```

`docs/HBC-FORMAT.md` §2 gives the byte offsets per class. The header is
**always 128 bytes**; assert it.

### 3.3 Strings

```ts
export type StringKind = "String" | "Identifier";

export interface StringEntry {
  readonly id: number;
  readonly kind: StringKind;
  readonly isUTF16: boolean;
  readonly storageOffset: number;   // byte offset into stringStorage (post-overflow resolution)
  readonly length: number;          // in CHARACTERS (bytes = length * (isUTF16 ? 2 : 1))
  readonly overflowed: boolean;     // came from the overflow table
}

export interface StringTable {
  readonly count: number;
  readonly identifierCount: number;
  entry(id: number): StringEntry;                 // throws E_BAD_STRING_ID
  get(id: number): string;                        // decoded + cached
  kind(id: number): StringKind;
  /** Hash from the identifierHashes section, by *identifier ordinal*, or undefined
   *  for non-identifiers. See docs/HBC-FORMAT.md §5.2. */
  identifierHash(id: number): number | undefined;
  readonly storage: Uint8Array;                   // view
}
```

Decoding rules (§5.3, §12.6):

* `length` is in characters. UTF-16 strings occupy `2 * length` bytes.
* ASCII: decode byte-per-char with `String.fromCharCode` (equivalently latin-1)
  — **lossless even if a byte is ≥ 0x80**, which a corrupt file can produce.
* UTF-16: little-endian, decode code unit by code unit with
  `String.fromCharCode(lo | hi << 8)`. **Do not use `TextDecoder`** — it
  replaces unpaired surrogates, which HBC files legitimately contain.
* Build in chunks of ≤ 4096 code units and `join("")` to avoid
  `String.fromCharCode(...spread)` blowing the argument limit on long strings.
* Cache decoded strings in a `Map<number, string>`; a 12 MB bundle has
  ~10^5 strings and eager decoding is the main avoidable allocation.
* `stringKinds` is RLE: `kind = datum >>> 31`, `count = datum & 0x7fffffff`
  (§5.1). Expand to a `Uint8Array(stringCount)` once; assert the runs sum to
  exactly `stringCount` and that the number of `Identifier` entries equals
  `header.identifierCount`.

### 3.4 Functions

```ts
export type ProhibitInvoke = "call" | "construct" | "none";
export type FuncKind = "Normal" | "Generator" | "Async";

export interface FunctionFlags {
  readonly prohibitInvoke: ProhibitInvoke;
  readonly strictMode: boolean;
  readonly hasExceptionHandler: boolean;
  readonly hasDebugInfo: boolean;
  readonly overflowed: boolean;
  /** Classes D/E only. Classes A-C always report "Normal" with kindKnown=false —
   *  in those versions generator/async-ness is only visible from the *creation*
   *  opcode (CreateGeneratorClosure/CreateAsyncClosure) or StartGenerator in the
   *  body. See docs/HBC-FORMAT.md §3.2 and docs/PRIOR-ART.md §3.3. */
  readonly kind: FuncKind;
  readonly kindKnown: boolean;
  readonly raw: number;
}

export interface FunctionHeader {
  readonly index: number;
  readonly offset: number;                 // absolute file offset of the body
  readonly paramCount: number;             // includes `this`
  readonly bytecodeSizeInBytes: number;    // opcodes only; jump tables live beyond
  readonly functionNameStringId: number;
  readonly frameSize: number;
  readonly infoOffset: number | undefined;       // classes A-C, or D/E when overflowed
  readonly environmentSize: number | undefined;  // classes A-C only
  readonly loopDepth: number | undefined;        // class E
  readonly numberRegCount: number | undefined;   // class E
  readonly nonPtrRegCount: number | undefined;   // class E
  readonly readCacheSize: number;                // == highestReadCacheIndex pre-E
  readonly writeCacheSize: number;
  readonly privateNameCacheSize: number | undefined;  // class E
  readonly flags: FunctionFlags;
  readonly fromLargeHeader: boolean;
}

export interface ExceptionHandler {
  readonly start: number;   // function-relative, inclusive
  readonly end: number;     // function-relative, EXCLUSIVE
  readonly target: number;  // function-relative handler entry (begins with `Catch`)
}

export interface DebugOffsets {
  readonly sourceLocations: number | null;   // null == 0xFFFFFFFF sentinel
  readonly lexicalData: number | null;       // v<=83 only
  readonly scopeDescData: number | null;     // v84..v96 only
  readonly textifiedCallees: number | null;  // v84..v96 only
}

export interface FunctionRecord {
  readonly header: FunctionHeader;
  readonly name: string;                     // strings.get(functionNameStringId)
  readonly exceptionHandlers: readonly ExceptionHandler[];
  readonly debugOffsets: DebugOffsets | null;
  /** Zero-copy view of exactly `bytecodeSizeInBytes` bytes. Cached. */
  body(): Uint8Array;
  /** True when another function record has the same `offset` (dedup, §1.1). */
  readonly bodyShared: boolean;
}
```

Header-size table (§3.1–3.3):

| Class | small | large | overflow offset formula | DebugOffsets |
|---|---|---|---|---|
| A, B, C | 16 B | 31 B | `(infoOffset << 16) \| (offset & 0xffff)` | 8 B (A) / 12 B (B, C) |
| D | 12 B | 23 B | `(functionName << 16) \| (offset & 0xffff)` | 4 B |
| E | 12 B | 36 B | `(functionName << 24) \| (offset & 0xffffff)` | 4 B |

Class A uses the 8-byte `{sourceLocations, lexicalData}` form; B and C use the
12-byte `{sourceLocations, scopeDescData, textifiedCallees}` form.

Info-block layout (§4), each sub-section 4-byte aligned, in this order:
large header (iff `overflowed`) → exception table (iff `hasExceptionHandler`:
`uint32 count` then `count × 3 × uint32`) → DebugOffsets (iff `hasDebugInfo`).

**Class E trap** (§3.3): `overflowed` no longer means "a field didn't fit" — it
means "an info block exists". Most real v99 functions are overflowed, and a
function with neither handlers nor debug info has **no info block at all**. Do
not treat a non-overflowed v99 function as anomalous.

### 3.5 Literal buffers and shapes

```ts
export type SerializedLiteral =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number }     // Number tag, IEEE-754
  | { readonly kind: "integer"; readonly value: number }    // Integer tag, int32
  | { readonly kind: "string"; readonly stringId: number }; // Byte/Short/LongString tags

export interface LiteralRun {
  readonly offset: number;      // start of the tag, within the buffer
  readonly tag: number;         // 0..7
  readonly count: number;
  readonly byteLength: number;  // tag bytes + payload bytes
}

/** Read exactly `count` values starting at `offset`, consuming as many runs as
 *  needed. `count` comes from the instruction operand, not from the buffer. */
export function readLiterals(buf: Uint8Array, offset: number, count: number): {
  readonly values: readonly SerializedLiteral[];
  readonly nextOffset: number;
};

/** Read one run header. Used for validation sweeps and for the disassembler's
 *  buffer dump. */
export function readLiteralRun(buf: Uint8Array, offset: number): LiteralRun;

export interface ObjectShape {   // v>=97, docs/HBC-FORMAT.md §6.2
  readonly index: number;
  readonly keyBufferOffset: number;
  readonly numProps: number;
}
```

Tag encoding (§6.3): short form `0ttt llll` (1 byte, len ≤ 15); long form
`1ttt llll llllllll` (2 bytes, len = low 12 bits, ≤ 4095). Tags: 0 Null,
1 True, 2 False, 3 Number (8 B double LE), 4 LongString (u32 id), 5 ShortString
(u16 id), 6 ByteString (u8 id), 7 Integer (i32 LE). All payloads little-endian.
Any other tag → `E_BAD_LITERAL_TAG`.

### 3.6 Other tables

```ts
export interface TableRef { readonly offset: number; readonly length: number; }

export interface BigIntEntry extends TableRef {
  readonly index: number;
  /** Two's-complement little-endian magnitude; sign is the top bit of the last byte.
   *  docs/HBC-FORMAT.md §7. */
  value(): bigint;
  readonly bytes: Uint8Array;   // view into bigIntStorage
}

export interface RegExpEntry extends TableRef {
  readonly index: number;
  readonly bytes: Uint8Array;   // compiled regexp bytecode — we never decode it (§8)
}

export interface CjsModuleEntry {
  readonly index: number;
  readonly first: number;
  readonly second: number;
  /** When header.options.cjsModulesStaticallyResolved: (functionIndex, moduleOffset);
   *  otherwise (stringId, functionIndex). docs/HBC-FORMAT.md §9. */
  readonly resolved: boolean;
}

export interface FunctionSourceEntry {
  readonly index: number;
  readonly functionIndex: number;
  readonly stringId: number;    // original source text — a free win for the emitter (§9)
}
```

BigInt decode algorithm (spec it exactly; there is no fixture-verified path yet
— see risk R5):

```
let n = 0n;
for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
if (bytes.length > 0 && (bytes[bytes.length - 1] & 0x80) !== 0)
  n -= 1n << BigInt(8 * bytes.length);      // sign-extend two's complement
return n;
```

Empty storage (`length === 0`) decodes to `0n`.

### 3.7 Debug info

```ts
export interface DebugFileRegion {
  readonly fromAddress: number;
  readonly filenameId: number;
  readonly sourceMappingUrlId: number;
}
export interface DebugInfo {
  readonly offset: number;               // == header.debugInfoOffset
  readonly filenameCount: number;
  readonly filenameStorageSize: number;
  readonly fileRegionCount: number;
  readonly scopeDescDataOffset: number | null;   // v<=96 only
  readonly textifiedCalleeOffset: number | null; // v<=96 only
  readonly stringTableOffset: number | null;     // v<=96 only
  readonly debugDataSize: number;
  readonly filenames: readonly string[];
  readonly fileRegions: readonly DebugFileRegion[];
  /** The variable-length delta stream. NOT decoded in M1 — see O-3. */
  readonly data: Uint8Array;
}
```

### 3.8 Sections and module

```ts
export type SectionName =
  | "header" | "functionHeaders" | "stringKinds" | "identifierHashes"
  | "smallStringTable" | "overflowStringTable" | "stringStorage"
  | "literalValueBuffer" | "objKeyBuffer" | "objValueBuffer" | "objShapeTable"
  | "bigIntTable" | "bigIntStorage" | "regExpTable" | "regExpStorage"
  | "cjsModuleTable" | "functionSourceTable"
  | "functionBodies" | "functionInfo" | "debugInfo" | "footer";

export interface SectionSpan {
  readonly name: SectionName;
  readonly offset: number;
  readonly size: number;       // 0 for absent sections; offset still meaningful
}

export interface SectionMap {
  span(name: SectionName): SectionSpan;
  readonly all: readonly SectionSpan[];        // in file order
  /** alignUp(end of functionSourceTable, 4) — must equal min(function offsets). */
  readonly firstFunctionBodyOffset: number;
}

export interface HbcModule {
  readonly bytes: Uint8Array;
  readonly layout: LayoutProfile;
  readonly header: HbcHeader;
  readonly sections: SectionMap;
  readonly strings: StringTable;
  readonly functions: readonly FunctionRecord[];
  readonly literalValueBuffer: Uint8Array;     // == arrayBuffer for v<=96
  readonly objKeyBuffer: Uint8Array;
  readonly objValueBuffer: Uint8Array;         // empty view for v>=97
  readonly shapes: readonly ObjectShape[];     // empty for v<=96
  readonly bigInts: readonly BigIntEntry[];
  readonly regExps: readonly RegExpEntry[];
  readonly cjsModules: readonly CjsModuleEntry[];
  readonly functionSources: readonly FunctionSourceEntry[];
  readonly debugInfo: DebugInfo | null;
  readonly footerSha1: Uint8Array | null;      // last 20 bytes, if present
  readonly diagnostics: readonly Diagnostic[];
}
```

---

## 4. Section walking

`docs/HBC-FORMAT.md` §1 gives the serializer order. Only `debugInfoOffset` is
stored; **everything else is computed** by walking with `alignUp(x, 4)` before
each step.

```ts
const ALIGN = 4;
let o = 128;                                   // end of the header, always
o = span("functionHeaders",   functionCount * layout.smallFuncHeaderSize);
o = span("stringKinds",       stringKindCount * 4);
o = span("identifierHashes",  identifierCount * 4);
o = span("smallStringTable",  stringCount * 4);
o = span("overflowStringTable", overflowStringCount * 8);
o = span("stringStorage",     stringStorageSize);
o = span("literalValueBuffer", literalValueBufferSize);
o = span("objKeyBuffer",      objKeyBufferSize);
if (layout.hasShapeTable) o = span("objShapeTable", objShapeTableCount * 8);
else                      o = span("objValueBuffer", objValueBufferSize);
if (layout.hasBigIntTable) { o = span("bigIntTable", bigIntCount * 8);
                             o = span("bigIntStorage", bigIntStorageSize); }
o = span("regExpTable",       regExpCount * 8);
o = span("regExpStorage",     regExpStorageSize);
o = span("cjsModuleTable",    cjsModuleCount * 8);
if (layout.hasFunctionSourceTable) o = span("functionSourceTable", functionSourceCount * 8);
firstFunctionBodyOffset = alignUp(o, ALIGN);
```

where `span(name, size)` records `{offset: alignUp(o, ALIGN), size}` and returns
`alignUp(o, ALIGN) + size`.

`functionBodies` / `functionInfo` spans are derived, not walked: bodies span
`[firstFunctionBodyOffset, min(infoOffsets))` and info spans
`[min(infoOffsets), debugInfoOffset || fileLength - 20)`. Both are advisory;
never use them to bound a read (bodies can be shared and info offsets can be
interleaved).

**Do not assume function offsets increase or that function *N*'s body ends
where *N+1*'s begins** — bytecode is deduplicated under `-O` (§1.1). Always use
`bytecodeSizeInBytes`.

---

## 5. Opcode and builtin table generation

### 5.1 Vendoring (`tools/gen-tables/vendor.sh`)

```
tools/gen-tables/vendor.sh <tableId> <hermesCommitSha>
```

Fetches, from `https://raw.githubusercontent.com/facebook/hermes/<sha>/`:

| File | Purpose |
|---|---|
| `include/hermes/BCGen/HBC/BytecodeList.def` | opcode numbering + operand types |
| `include/hermes/FrontEndDefs/Builtins.def` | builtin numbering |
| `include/hermes/BCGen/HBC/BytecodeVersion.h` | assert `BYTECODE_VERSION` |
| `LICENSE` | MIT text, kept beside the sources |

into `third_party/hermes/<tableId>/`, **committed to the repo**. Vendoring makes
table generation hermetic (CI's `gen:tables:check` needs no network) and makes
the provenance auditable. Record `sha256` of each file.

### 5.2 The pinned commits

| tableId | header version | opcodes | Hermes commit | Provenance |
|---|---|---|---|---|
| `hbc84` | 84 | 185 | **`c2cd9e38`** — the last commit touching `BytecodeVersion.h` in the v84 window `(19216441 … b74eb2d5)`; opcode-table content identical to `19216441`'s | resolved by the reviewer per §5.3; verified 185 opcodes and `Unreachable`=0 by positional parse |
| `hbc94` | 94 | 192 | **`1c717488`** ("Add bytecode support for block scoping", 2023-03-08) — introduces `BYTECODE_VERSION = 94`; the block-scoping *re-land* after `b544ff4a`=92 / `760d8659`=93-revert | resolved by the reviewer per §5.3; verified 192 opcodes and every §5.5 spot-check by positional parse |
| `hbc98-2024` | 98 | 201 | the commit that set `BYTECODE_VERSION = 98` (2024-08-30) — **resolve per §5.3** | no known file uses it (see below); generate it anyway so the v98 probe is a choice, not an assumption |
| `hbc98-late` | 98 | **≈219, to be measured** | **unresolved — resolve per §5.3 against the assertions in §5.5** | what `hermes-compiler@250829098.0.10` emits; byte-derived evidence below |
| `hbc99-feb2026` | 99 | 219 | `42235b8d913f` (2026-02-12, the v99 bump) | `docs/HBC-FORMAT.md` §0 |
| `hbc99-mar2026` | 99 | **220** | `913d31acd10a` (2026-03-05, "Revert bytecode version to 99"; inserts `NewTypedObjectWithBuffer` at index 4) | `docs/HBC-FORMAT.md` §0 |

The v98-late header layout first appears at `639e5d6afb16`, the parent of the v99
bump — that is the layout pin, not necessarily the opcode pin.

#### 5.2.1 Version 98 is a *third* opcode table, not one of the v99 pair

`tools/hermesc/v98` (`hermes-compiler@250829098.0.10`) and the 53 `v98.hbc`
fixtures now in the corpus were compared byte-for-byte against their v99
counterparts. The result rules out the obvious guesses:

* `hermes-dec-sample/v98.hbc` function 0 (`offset=0x358`, 236 bytes) differs from
  `v99.hbc`'s **in exactly one byte**: at body offset 81, v98 has `0xa5` (165)
  where v99 has `0xa6` (166) — that is `CreateRegExp`, which
  `docs/HBC-FORMAT.md` §11.2 pins at **166 for v99**. So v98's `CreateRegExp` is
  **165**.
* `constructs/52-switch-jumptable`: the switch opcode is `0xa6` (166) at v98 and
  `0xa7` (167) at v99. `docs/HBC-FORMAT.md` §11.2 pins `UIntSwitchImm` at **167
  for v99**. So v98's `UIntSwitchImm` is **166**. (v94's `SwitchImm` is `0x85` =
  133, matching §11.2 — an independent confirmation the method is sound.)
* Below that range they agree exactly: both v98 and v99 files start
  `40 03 00 | 43 10 00 00 00 …`, i.e. `CreateFunctionEnvironment`=64 and
  `DeclareGlobalVar`=67 in **both**, and `GetGlobalObject`=61, `PutByIdLoose`=74,
  `CreateClosure`=132 in both.

So the v98-public table is **not** the 201-opcode table from the v98 bump (it has
`UIntSwitchImm`, a v99-era opcode), and it is **not** `hbc99-feb2026` either: if
the only v99-vs-earlier difference were `NewTypedObjectWithBuffer` at index 4,
`DeclareGlobalVar` would be 66 in the earlier table, and it is 67. The public v98
compiler is built from a `static_h` commit that already has most of the v99
opcode work while still reporting version 98 — exactly the hazard D8 exists for,
and now the **second** independent instance of it.

`hbc98-late` is therefore a table we must generate and pin like any other. Its
resolution target is the assertion set in §5.5; the search window is `static_h`
commits with `BYTECODE_VERSION == 98`, walking backwards from the parent of the
v99 bump (`639e5d6afb16`).

### 5.3 Resolving a commit pin

Do not guess a SHA. `hbc84` and `hbc94` were resolved this way already (§5.2);
`hbc98-2024` and `hbc98-late` still need it. The procedure:

```sh
git clone --filter=blob:none https://github.com/facebook/hermes
cd hermes
# the commit that set BYTECODE_VERSION to N opens that version's window:
git log --oneline -S'BYTECODE_VERSION = 98' -- include/hermes/BCGen/HBC/BytecodeVersion.h
# ... and the bump to N+1 closes it. Every commit in between is a candidate.
```

**Use a local clone, not the GitHub REST API** (review N5): `GET
/repos/facebook/hermes/commits?path=…` returned only 10 of the 17 real commits
touching `BytecodeVersion.h`, silently omitting the block-scoping
revert/re-land commits that define v92/93/94. For this file the web API is not
merely less hermetic, it is wrong.

Take the commit that *introduces* the constant, verify
`BYTECODE_VERSION == <N>` in the file at that commit, and then **verify the
generated table** against §5.5 before recording the SHA in `PROVENANCE.md`. If
the opcode count or a spot-check fails, walk forward to the next commit that
touches `BytecodeList.def` while `BYTECODE_VERSION` is still `<N>` and retry —
the correct pin is any commit in the version's window whose table passes §5.5,
and the last such commit is preferable (it is what a late-in-life v84 compiler
shipped).

### 5.4 The generator (`tools/gen-tables/gen.ts`)

Input: `third_party/hermes/<tableId>/`. Output:
`src/tables/generated/opcodes-<tableId>.ts` and `builtins-<tableId>.ts`, plus a
rewritten `src/tables/generated/PROVENANCE.md`.

Parsing rules for `BytecodeList.def` (all derived from the file itself; cite
line numbers in comments):

**0. The file defines the very macros it then invokes — you must skip its
preamble and macro bodies, or you will count them as opcodes.** The real file
opens with a block of fallback definitions:

```c
// Define default versions of all macros used.
#ifndef DEFINE_OPERAND_TYPE
#define DEFINE_OPERAND_TYPE(...)
#endif
#ifndef DEFINE_OPCODE_1
#define DEFINE_OPCODE_1(name, ...) DEFINE_OPCODE(name)
#endif
...
```

and later defines the jump macros in terms of the opcode macros:

```c
#define DEFINE_JUMP_1(name)           \
  DEFINE_OPCODE_1(name, Addr8)        \
  DEFINE_OPCODE_1(name##Long, Addr32) \
```

After comment-stripping, those inner `DEFINE_OPCODE_1(name, Addr8)` lines are
syntactically indistinguishable from real invocations. A naive
`^DEFINE_OPCODE_(\d+)\(([A-Za-z0-9_]+)` scan over the real v94-era file yields
**198** "opcodes" — six of them literally named `name` — instead of the correct
**192**. The `hbc84`-era file has the same shape. Concretely, the parser must:

* **Skip every line whose first non-whitespace character is `#`** (`#define`,
  `#ifndef`, `#ifdef`, `#if`, `#else`, `#endif`, `#include`).
* **Skip every line that is part of a macro body**: track continuation, i.e.
  once a `#define` line is seen, keep skipping while the previous physical line
  ended with a backslash. This is what removes the `DEFINE_JUMP_n` bodies.
* Track `#if`/`#ifdef`/`#endif` nesting depth and only accept invocations at
  depth 0 (this is also what implements rule 5's `HERMES_RUN_WASM` exclusion,
  rather than a special case for that one symbol).
* Reject, loudly, any accepted invocation whose opcode name is `name`,
  `name##Long`, or contains `#` or `...` — those are macro placeholders that
  leaked through, and their presence means the skipping logic is wrong. Do not
  rely on §5.5's "names unique" assertion to catch this: it catches *today's*
  placeholder collision by luck, and a future Hermes that renames the
  placeholder per arity (`name0`, `name1`, …) would sail straight through with a
  silently wrong positional numbering — exactly the R1 failure mode.

1. Strip `//` and `/* */` comments. Process line by line, applying rule 0.
2. `DEFINE_OPERAND_TYPE(<name>, <ctype>)` builds the operand-type map. Width and
   signedness come from the C type: `uint8_t`→(1, unsigned), `int8_t`→(1,
   signed), `uint16_t`→(2, unsigned), `uint32_t`→(4, unsigned), `int32_t`→(4,
   signed), `double`→(8, float). Cross-check the result against
   `docs/HBC-FORMAT.md` §11.1's table (`Reg8`, `Reg32`, `UInt8`, `UInt16`,
   `UInt32`, `Addr8`, `Addr32`, `Imm32`, `Double`); a mismatch is a hard error.
3. `DEFINE_OPCODE_<n>(<Name>, <T1>, ..., <Tn>)` appends **one** opcode.
4. `DEFINE_JUMP_<n>(<Name>)` appends **two** opcodes, in this order:
   `<Name>` with operands `(Addr8, Reg8 × (n-1))` and `<Name>Long` with
   `(Addr32, Reg8 × (n-1))`. Short first (§11.1) — so the two are always
   adjacent numbers, which the disassembler relies on.
5. Everything inside `#ifdef HERMES_RUN_WASM … #endif` is **excluded** (release
   builds omit it, §11.2).
6. `DEFINE_RET_TARGET(...)`, `ASSERT_*`, `OPERAND_*` do not create opcodes.
7. `OPERAND_STRING_ID(<Op>, <n>)`, `OPERAND_BIGINT_ID`, `OPERAND_FUNCTION_ID`
   (1-based operand index, as in the file) are captured into an `idOperands`
   map. This is what lets the disassembler render `"testx"` instead of `17`
   and lets the parser range-check id operands during probing. If a macro name
   of this shape appears that we do not model, **fail** rather than ignore it.
8. Opcode numbers are positional: index of the emitted entry, starting at 0.
   `Unreachable` must come out as 0 (§11.2) — assert it.
9. **Independent count cross-check.** Compute the expected total a second way,
   with a separate function that does not share code with the main scanner:
   `total = (# accepted DEFINE_OPCODE_* invocations) + 2 × (# accepted
   DEFINE_JUMP_* invocations)`. Assert it equals `opcodes.length`. For the
   v94-era file this is `142 + 2 × 25 = 192`. Two independent derivations
   agreeing is what makes rule 0's skipping logic auditable; a single
   implementation asserting against a hardcoded number only tests the number.

Parsing rules for `Builtins.def`: the builtin number is likewise positional
across the macro invocations in file order. Model the macro set the vendored
file actually uses (typically `BUILTIN_METHOD(Object, keys)` →
`"Object.keys"`, plus object/private/normal variants). Emit
`number → { name, object?, method? }`. If an unmodelled macro appears, fail.

Output shape:

```ts
// GENERATED by tools/gen-tables/gen.ts — DO NOT EDIT
// Source: facebook/hermes @ <sha> (MIT), include/hermes/BCGen/HBC/BytecodeList.def
// sha256(BytecodeList.def) = <hex>
import type { OpcodeTable } from "../types.ts";
export const HBC94: OpcodeTable = {
  id: "hbc94",
  bytecodeVersion: 94,
  hermesCommit: "<sha>",
  operandTypes: { Reg8: { bytes: 1, signed: false, kind: "reg" }, /* ... */ },
  opcodes: [
    { n: 0,  name: "Unreachable",      operands: [] },
    { n: 52, name: "DeclareGlobalVar", operands: ["UInt32"], ids: { 1: "string" } },
    /* ... exactly 192 entries ... */
  ],
} as const;
```

Formatting must be **deterministic** (one opcode per line, fixed key order, LF,
no timestamps) so `gen:tables:check` is a pure diff. `gen.ts --check`
regenerates into a temp dir and exits non-zero if any committed file differs.

### 5.5 Table self-verification (runs at table load, `src/tables/registry.ts`)

Assertions, each raising `E_TABLE_ASSERT` with the table id (all values from
`docs/HBC-FORMAT.md` §11.2 / §11.4):

| Table | Assertions |
|---|---|
| all | `opcodes[0].name === "Unreachable"`; names unique; no name is a macro placeholder (`name`, `name##Long`); every operand type known; §5.4 rule 9's independent count agrees |
| `hbc84` | length **185** |
| `hbc94` | length **192**; `DeclareGlobalVar`=52, `GetGlobalObject`=48, `CreateEnvironment`=50, `PutById`=59, `CreateAsyncClosure`=104, `Ret`=92, `Catch`=93, `CreateRegExp`=132, `SwitchImm`=133; builtin 52 === `spawnAsync` |
| `hbc98-2024` | length **201** |
| `hbc98-late` | `CreateFunctionEnvironment`=64, `DeclareGlobalVar`=67, `GetGlobalObject`=61, `PutByIdLoose`=74, `CreateClosure`=132, **`CreateRegExp`=165**, **`UIntSwitchImm`=166**; `StringSwitchImm`=167; `NewTypedObjectWithBuffer` **absent** |
| `hbc99-feb2026` | length **219** |
| `hbc99-mar2026` | length **220**; `GetParentEnvironment`=52, `GetGlobalObject`=61, `CreateFunctionEnvironment`=64, `CreateTopLevelEnvironment`=65, `DeclareGlobalVar`=67, `GetByIdShort`=68, `TryGetById`=72, `PutByIdLoose`=74, `Ret`=118, `Catch`=119, `CreateClosure`=132, `CreateRegExp`=166, `UIntSwitchImm`=167, `StringSwitchImm`=168, `CreateGenerator`=169; opcode 4 === `NewTypedObjectWithBuffer`; builtin 57 === `spawnAsync` |

The `hbc98-late` row is the **search key** for §5.3, not just a check: those
numbers were measured from the fixture bytes (§5.2.1), so a candidate commit is
the right pin iff its generated table satisfies them. `StringSwitchImm`=167 is
inferred from the v99 ordering (`CreateRegExp`, `UIntSwitchImm`,
`StringSwitchImm` adjacent) and is the one value in that row not directly
measured — treat a mismatch there as a signal to re-derive, not as proof the
commit is wrong.

`hbc84`'s numbering is not spot-checked in the research docs. Its verification
is behavioural instead, and is a **required** part of §5.3's resolution loop:
the table is correct iff every function in `tests/fixtures/hermes-dec-sample/v84.hbc`
and in the 43 v84 construct fixtures decodes cleanly end-to-end (spec 02 §3)
**and** the disassembly matches `tools/hermesc/v84/hbcdump` (MIT, reads `.hbc`
directly and is version-locked to 84 — the ideal oracle here) and
`hbc-disassembler`.

---

## 6. Layout probing (D8)

**The rule (D8, risk R1): the parser probes; it never switches on `version`
alone. On ambiguity it refuses.**

### 6.1 Version → candidate table

| `header.version` | Layout candidates | Opcode-table candidates | Note |
|---|---|---|---|
| < 51 | — | — | `E_UNSUPPORTED_VERSION` before any field is read |
| 51–83 | A | (none generated) | parse-only; `E_UNSUPPORTED_VERSION` on decode |
| 84 | B | `hbc84` | fixtures: 45 |
| 85–86 | B | (none) | parse works, decode unsupported |
| 87–96 | C | `hbc94` **only if version === 94** | fixtures: 47 at v94, plus every `bundles/**` file |
| 97 | D | (none) | **no fixture** — class D is untested (O-2) |
| **98** | **D and E** | **`hbc98-late`, `hbc98-2024`, `hbc99-feb2026`, `hbc99-mar2026`** | fixtures: 52 constructs + `hermes-dec-sample/v98.hbc`. **Every one of them is class E** (§6.3) |
| 99 | E | **`hbc99-mar2026`, `hbc99-feb2026`** | fixtures: 52 constructs + 2 sample files |
| > 99 | E (optimistic) | — | `E_UNSUPPORTED_VERSION` unless `options.layout` forces |

The v98 row is deliberately generous on opcode-table candidates: §5.2.1 showed
the public v98 compiler's table matches none of the tables we would have guessed,
so the probe must be allowed to choose across the whole static_h family and to
say `E_LAYOUT_AMBIGUOUS` if more than one fits. Class **D** remains without a
single fixture; the layout is implemented from `docs/HBC-FORMAT.md` §3.2 and
stays unverified (O-2).

A file whose layout parses but whose opcode table is not generated is a valid
`HbcModule`; only `disassemble()` fails, with `E_UNSUPPORTED_VERSION` naming the
missing table. This keeps `hbc2js --info` useful on any bundle.

### 6.2 The probe ladder

Probes run in order; each candidate that fails is eliminated with the probe id
recorded in `ProbeReport`.

**P0 — container sanity** (candidate-independent; failure is fatal for the file).
* `magic === 0x1F1903C103BC1FC6n`, else `E_BAD_MAGIC`.
* `fileLength >= 128 + 20` and `fileLength <= bytes.length`, else `E_TRUNCATED`.
* `bytes.length > fileLength` → diagnostic `W_TRAILING_BYTES` (an APK-extracted
  bundle often has padding), continue.

**P1 — header shape.** For each candidate layout class, read its field list
(§3.2 offsets from `docs/HBC-FORMAT.md` §2) and require:
* the field list ends at ≤ 128;
* every padding byte after `options` is `0`;
* `functionCount ≥ 1`, `globalCodeIndex < functionCount`;
* `stringCount ≥ identifierCount`, `overflowStringCount ≤ stringCount`;
* `debugInfoOffset === 0 || (debugInfoOffset ≥ 128 && debugInfoOffset < fileLength)`;
* every count satisfies `count * stride ≤ fileLength` (the anti-OOM guard, §7).

**P2 — section-walk consistency (the decisive probe).** Walk §4 with the
candidate's field values, then read the function-header table with the
candidate's small-header size and require **all** of:

| id | Check |
|---|---|
| P2.a | `min(resolvedOffset over all functions) === sections.firstFunctionBodyOffset` — see the warning below |
| P2.b | every `offset + bytecodeSizeInBytes ≤ (debugInfoOffset || fileLength - 20)` |
| P2.c | every `functionNameStringId < stringCount` |
| P2.d | every info offset (large-header or overflow-derived) is in `[firstFunctionBodyOffset, fileLength - 20)` and is 4-aligned |
| P2.e | reading each function's info block (large header + handler table + debug offsets) stays within the file and, for overflowed entries, the large header's `offset`/`bytecodeSizeInBytes` satisfy P2.b |
| P2.f | `sections.firstFunctionBodyOffset ≤ fileLength - 20` |

P2.a is the workhorse: a wrong field list shifts `cjsModuleCount` /
`functionSourceCount` / `debugInfoOffset`, which changes the computed
`firstFunctionBodyOffset`, which then disagrees with the stored function
offsets. `docs/HBC-FORMAT.md` §2.1 records the observed failure mode when v84 is
read as class C: `cjsModuleCount = 1568`, which P1's `count * stride ≤ fileLength`
already rejects.

> **`resolvedOffset`, not the raw small-header field.** In classes D and E an
> **overflowed** small header does not contain a usable `offset` at all: the
> field is half of the packed large-header pointer (`(functionName << 24) |
> (offset & 0xffffff)` for class E — §3.4). Taking `min` over the raw fields is
> wrong and quietly so. Measured on `hermes-dec-sample/v99.hbc`: the raw minimum
> is `0x463` (contributed by the two *non*-overflowed generator stubs), while the
> true first body offset — read from function 0's large header at `0x89c` — is
> `0x358`. A parser that used the raw value would compute a mismatch on a
> perfectly good file and reject every class-D/E input. So P2.a must resolve each
> overflowed entry's large header first and use *its* `offset`. The same applies
> to P2.b and P2.c: validate the resolved values, and validate the *packed* small
> header only to the extent of checking that the derived large-header offset is
> in range.

**P3 — opcode-table probe** (only when ≥ 2 opcode-table candidates survive, or
always under `--verify`). See §6.4.

**P4 — startup table assertions.** §5.5. These are properties of the *table*,
checked once per table load, not per file.

### 6.3 Byte-level discriminators for the v98 D-vs-E ambiguity

Class D and class E headers agree up to byte 88 and then diverge because E
inserts `numStringSwitchImms` at offset 92:

| offset | class D | class E |
|---|---|---|
| 88 | `objShapeTableCount` | `objShapeTableCount` |
| 92 | `segmentID` | **`numStringSwitchImms`** |
| 96 | `cjsModuleCount` | `segmentID` |
| 100 | `functionSourceCount` | `cjsModuleCount` |
| 104 | `debugInfoOffset` | `functionSourceCount` |
| 108 | `options` (1 byte) + 19 pad | `debugInfoOffset` |
| 112 | pad | `options` (1 byte) + 15 pad |

Fast discriminators, in order (each is a *hint* that short-circuits; P2 is still
run on the survivor to confirm):

* **D1 — pad bytes 109..111.** Under class D these are padding and must be `0`.
  Under class E they are the top three bytes of `debugInfoOffset`. So **any
  non-zero byte in 109..111 ⇒ class E**. This fires for essentially every file
  with debug info (`debugInfoOffset ≥ 0x100`).
* **D2 — u32 at 104 as an offset.** Under class D, `u32@104` is
  `debugInfoOffset`: either `0`, or in `[128, fileLength)` and 4-aligned. Under
  class E it is `functionSourceCount`, typically a small integer < 1000. If
  `u32@104` is in `[128, fileLength)` **and** `u32@108`'s upper three bytes are
  zero (a plausible `options` byte) ⇒ prefer class D.
* **D3 — u32 at 92.** Under class D this is `segmentID`, which is 0 in every
  non-split bundle and small otherwise. Under class E it is
  `numStringSwitchImms`, which is 0 in files with no string switches. Weak;
  use only as a tie-breaker input, never alone.
* **D4 — nothing decisive.** When `debugInfoOffset === 0`, `options === 0`,
  `segmentID === 0`, `numStringSwitchImms === 0` and the shifted counts happen
  to be self-consistent, D1–D3 are all silent. **P2.a still decides**, because
  the two readings produce `functionSourceCount` values four bytes apart in the
  walk and therefore different `firstFunctionBodyOffset`s (the tables differ in
  size by `8 × Δcount`). If P2 also cannot separate them, throw
  `E_LAYOUT_AMBIGUOUS`.

**Measured against the real v98 corpus.** 53 v98 files now exist
(52 `constructs/*/v98.hbc` + `hermes-dec-sample/v98.hbc`, all produced by
`hermes-compiler@250829098.0.10`). **Every one is class E**, and D1 decides them
all:

| file | bytes 108..111 | reading |
|---|---|---|
| `hermes-dec-sample/v98.hbc` | `3c 0a 00 00` | byte 109 = `0x0a` ≠ 0 ⇒ **E**; `debugInfoOffset = 0xa3c` |
| `constructs/52-switch-jumptable/v98.hbc` | `94 03 00 00` | byte 109 = `0x03` ≠ 0 ⇒ **E**; `debugInfoOffset = 0x394` |

Under a class-D reading those same bytes would be `options = 0x3c` followed by
non-zero padding, which P1 rejects outright — so D1 and P1 agree, and P2.a then
confirms (`firstFunctionBodyOffset = 0x358` for the sample file, matching
function 0's resolved large-header offset).

Two consequences:

* **The E branch is now well tested and the D branch is not.** No v97 or
  v98-early file is known to exist anywhere in the corpus, so class D is
  implemented from `docs/HBC-FORMAT.md` §3.2 alone. Keep D4's
  `E_LAYOUT_AMBIGUOUS` path live rather than short-circuiting to E "because
  every real file is E" — that shortcut is precisely how R1 materialises.
* Add a **negative** test: rewrite `header.version` in a v99 fixture to 97 and
  assert the parse fails (class D against class-E bytes) rather than producing a
  plausible-looking module.

### 6.4 The opcode-table probe (v98 family, v99 219-vs-220)

`NewTypedObjectWithBuffer` was inserted at index 4 (`docs/HBC-FORMAT.md` §0),
so every opcode ≥ 4 shifts by one and a wrong table misdecodes immediately.

Procedure, per candidate table:

1. Pick the probe set: the function at `globalCodeIndex`, plus functions
   `0..min(functionCount, 32)`, plus — for files < 2 MB — **all** functions.
   For larger files add 32 more chosen by a deterministic stride
   (`i * ceil(functionCount / 32)`) so the sample is reproducible.
2. Linearly decode each probe function's body (spec 02 §3). The candidate
   **fails** on the first of:
   * unknown opcode number;
   * an operand read that would pass `offset + bytecodeSizeInBytes`;
   * the decode not landing exactly on `bytecodeSizeInBytes` (a trailing partial
     instruction);
   * an operand annotated `string` in `idOperands` with value `≥ stringCount`;
   * an operand annotated `function` with value `≥ functionCount`;
   * a jump displacement whose target leaves `[0, bytecodeSizeInBytes)`.
3. Exactly one survivor → chosen, `decidedBy: ["P3"]`. Zero → `E_LAYOUT_NO_CANDIDATE`.
   Two or more → `E_LAYOUT_AMBIGUOUS` (do **not** prefer the newer table
   silently; the error message may *suggest* `--opcode-table=hbc99-mar2026`).
4. **The choice is provisional on a sampled file** (review S1). For a file where
   step 1 sampled rather than decoded everything, record
   `probe.exhaustive = false` together with `probe.sampledFunctions` and
   `probe.totalFunctions` in `ProbeReport`. Spec 02's `decodeModule` must then
   attach a hint to any `E_UNKNOWN_OPCODE` / `E_OPERAND_OVERRUN` raised on a
   function that was **not** in the probe sample:
   *"the opcode table may be wrong: only N of M functions were probed; re-run
   with `--verify` to probe exhaustively, or force a table with
   `--opcode-table=`"*. Without that, a table that is subtly wrong deep in the
   opcode space surfaces as a random-looking decoder bug instead of the loud,
   actionable layout error D8 intends. `--verify` sets `exhaustive` mode and
   should be the first thing anyone tries on an unfamiliar bundle.

Empirically this terminates almost immediately for the cases we can measure —
but note it is **not** guaranteed to: the v98-vs-v99 tables agree on every opcode
below 165 (§5.2.1), so a small function using only common opcodes decodes cleanly
under both and contributes nothing. `hermes-dec-sample`'s function 0 separates
them at body offset 81 (`CreateRegExp`), and `52-switch-jumptable` separates them
at the switch. This is exactly why step 1 prefers whole-file decoding for files
< 2 MB and why step 4 exists for the ones above it.

`docs/HBC-FORMAT.md` §11.2 records that the v99 fixtures' opening bytes
`40 03 00 | 43 10 00 00 00 …` decode as
`CreateFunctionEnvironment r3, size 0; DeclareGlobalVar 'testx'; …` under the
220-table and are off-by-one garbage under the 219-table.

### 6.5 Reporting

`LayoutProfile.probe` is part of the parse result, is printed by
`hbc2js --info`, and is included in every golden snapshot (§8 T5). A change in
the chosen layout for an existing fixture must therefore show up as a snapshot
diff — that is the standing alarm for a silent-misdecode regression (R1).

---

## 7. Invariants, validation and fuzz resistance

### 7.1 Invariants

Fatal (`throw`) vs. diagnostic (`record and continue`) is fixed here; do not
improvise.

| # | Invariant | Violation |
|---|---|---|
| INV-00 | `bytes.length ≥ 128` — checked **before any field is read** | fatal `E_TRUNCATED` |
| INV-01 | magic equals `0x1F1903C103BC1FC6` | fatal `E_BAD_MAGIC` |
| INV-02 | `fileLength ≤ bytes.length` | fatal `E_TRUNCATED` |
| INV-03 | `bytes.length === fileLength` | diag `W_TRAILING_BYTES` |
| INV-04 | header occupies exactly 128 bytes; padding after `options` is zero | fatal `E_SECTION_MISMATCH` |
| INV-05 | for every table: `count * stride ≤ fileLength` | fatal `E_SECTION_OVERRUN` |
| INV-06 | every section span lies in `[0, fileLength)` | fatal `E_SECTION_OVERRUN` |
| INV-07 | `min(function offsets) === firstFunctionBodyOffset` | fatal `E_SECTION_MISMATCH` |
| INV-08 | `globalCodeIndex < functionCount` | fatal `E_BAD_FUNCTION_ID` |
| INV-09 | every `functionNameStringId < stringCount` | fatal `E_BAD_STRING_ID` |
| INV-10 | `offset + bytecodeSizeInBytes ≤ fileLength - 20` | fatal `E_SECTION_OVERRUN` |
| INV-11 | string-kind runs sum to `stringCount`; identifier count matches header | fatal `E_SECTION_MISMATCH` |
| INV-12 | every string entry's `[offset, offset + bytes)` is inside `stringStorage` | fatal `E_SECTION_OVERRUN` |
| INV-13 | overflow entries only when `length === 0xFF`; overflow index `< overflowStringCount` | fatal `E_BAD_STRING_ID` |
| INV-14 | handler `start < end`, both `≤ bytecodeSizeInBytes`, `target < bytecodeSizeInBytes` | fatal `E_BAD_HANDLER` |
| INV-15 | handler count `× 12 + 4` fits before the next info sub-section | fatal `E_SECTION_OVERRUN` |
| INV-16 | info block sub-sections are 4-aligned and monotonically inside the file | fatal `E_SECTION_OVERRUN` |
| INV-17 | class E: a function with `hasExceptionHandler` or `hasDebugInfo` **is** overflowed | diag `W_UNEXPECTED_INFO_FLAGS` |
| INV-18 | literal tag ∈ 0..7 and payload fits in the buffer | fatal `E_BAD_LITERAL_TAG` |
| INV-19 | every shape's `keyBufferOffset < objKeyBuffer.length` | fatal `E_SECTION_OVERRUN` |
| INV-20 | every bigint/regexp `[offset, offset+length)` inside its storage | fatal `E_SECTION_OVERRUN` |
| INV-21 | `functionSourceTable[i].functionIndex < functionCount`, `.stringId < stringCount` | fatal `E_BAD_FUNCTION_ID` / `E_BAD_STRING_ID` |
| INV-22 | `segmentID === 0` | diag `W_SEGMENTED_BUNDLE` (§12.11: detect and report, v1 does not support) |
| INV-23 | unknown bits set in `options` | diag `W_UNKNOWN_OPTIONS` |
| INV-24 | debug info header + tables fit inside `[debugInfoOffset, fileLength-20)` | fatal `E_SECTION_OVERRUN` |
| INV-25 | footer SHA-1 matches (only when `verifyFooter`) | diag `W_BAD_FOOTER` (§12.10 says warn, don't abort) |
| INV-26 | no two functions claim overlapping *info* blocks, except identical `infoOffset` (legal in v≤96, §3.4) | diag `W_INFO_OVERLAP` |

INV-00 exists because reading `fileLength` (bytes 32..36) itself needs bytes to
be there: without it, a 20-byte input trips the generic `BinaryReader` bounds
check and reports `E_SECTION_OVERRUN`, while a 200-byte truncated file reports
`E_TRUNCATED` — the same root cause with two different codes, and T8 (which only
asserts `instanceof Hbc2jsError`) would never notice. Add a test pinning the code
for inputs of length 0, 7, 8, 100 and 127 to `E_TRUNCATED`.

### 7.2 `BinaryReader` contract (`src/util/reader.ts`)

```ts
export class BinaryReader {
  constructor(bytes: Uint8Array, section?: string);
  offset: number;
  readonly length: number;
  u8(): number; u16(): number; u32(): number; i8(): number; i32(): number;
  f64(): number; u64(): bigint;
  bytes(n: number): Uint8Array;              // view, not copy
  skip(n: number): void;
  align(n: number): void;
  seek(offset: number): void;
  /** Peek forms with an explicit offset, for probing without moving the cursor. */
  peekU32(at: number): number;
  /** Throws E_SECTION_OVERRUN with {offset, section} if fewer than n bytes remain. */
  require(n: number): void;
}
```

Every read calls `require()` first. There is exactly one place in the codebase
that can read out of bounds, and it throws instead. This is the whole of the
memory-safety story.

### 7.3 Fuzz resistance

A 12 MB bundle and a maliciously crafted 200-byte file must both be safe.

1. **Never allocate from an untrusted count before validating it.** Every array
   allocation is preceded by INV-05. Concretely: `new Array(functionCount)` is
   only legal after `functionCount * smallFuncHeaderSize ≤ fileLength`.
2. **No copies.** `stringStorage`, the literal buffers, `regExpStorage`,
   `bigIntStorage`, function bodies and debug `data` are `subarray` views. Total
   parser allocation is O(functionCount + stringCount), not O(fileLength).
3. **No eager string decoding.** `strings.get(id)` decodes on demand and caches.
4. **No recursion over file data.** Section walking, function-table reading and
   info-block reading are loops. The only recursion allowed anywhere is bounded
   by the number of layout candidates (≤ 4).
5. **No unbounded loops.** Every loop is bounded by a validated count. The
   literal-run reader is bounded by the requested `count` *and* by the buffer
   length; it throws `E_BAD_LITERAL_TAG` rather than spinning on a zero-length
   run.
6. **No exceptions other than `Hbc2jsError`.** A `TypeError`, `RangeError` or
   `OOM` escaping `parseHbc` is a bug, and the fuzz test (§8 T8) asserts it
   never happens.

**Budgets** (measured on CI hardware; record actuals in `docs/STATUS.md`):

| Input | Target |
|---|---|
| 12 MB bundle, `parseHbc` (tables only, no bodies decoded) | ≤ 400 ms, peak RSS ≤ 3 × file size |
| 12 MB bundle, `parseHbc` + `strings.get()` for every string | ≤ 2.5 s |
| any fixture (< 10 KB) | ≤ 5 ms |
| any 2000-byte mutated input | ≤ 20 ms, always terminates |

---

## 8. Test plan

Location: `tests/gate/parse/**`, with the `bundles/**` rows of T10 in
`tests/sweep/parse/**` (spec 00 §2.1). Fixture access via
`tests/support/fixtures.ts` (spec 00 §7.1). **Read-only** with respect to
`tests/fixtures/`.

### T1 — Header, byte-exact, per fixture

Assert every field of `HbcHeader` and every entry of `SectionMap` against
literals. Values for the three canonical files come from
`docs/HBC-FORMAT.md` §2.1 and must be hardcoded in the test:

`hermes-dec-sample/v94.hbc` (2256 bytes, class C, `hbc94`):
```
version=94 fileLength=2256 globalCodeIndex=0 functionCount=8 stringKindCount=2
identifierCount=17 stringCount=34 overflowStringCount=0 stringStorageSize=238
bigIntCount=0 bigIntStorageSize=0 regExpCount=1 regExpStorageSize=66
literalValueBufferSize=0 objKeyBufferSize=0 objValueBufferSize=0 segmentID=0
cjsModuleCount=0 functionSourceCount=2 debugInfoOffset=0x638 options.raw=0x04
sourceHash=a692192bdc8ee6f7b2b9918faf18a64db39587c8
sections: functionHeaders=0x80 stringKinds=0x100 identifierHashes=0x108
          smallStringTable=0x14c stringStorage=0x1d4 regExpTable=0x2c4
          regExpStorage=0x2cc functionSourceTable=0x310
          firstFunctionBodyOffset=0x320
```

`hermes-dec-sample/v99.hbc` (2999 bytes, class E, `hbc99-mar2026`):
```
version=99 fileLength=2999 functionCount=8 stringKindCount=2 identifierCount=19
stringCount=35 stringStorageSize=286 regExpCount=1 regExpStorageSize=66
literalValueBufferSize=12 objKeyBufferSize=5 objShapeTableCount=1
numStringSwitchImms=0 cjsModuleCount=0 functionSourceCount=2
debugInfoOffset=0xa24 options.raw=0x00
sections: functionHeaders=0x80 stringKinds=0xe0 identifierHashes=0xe8
          smallStringTable=0x134 stringStorage=0x1c0 literalValueBuffer=0x2e0
          objKeyBuffer=0x2ec objShapeTable=0x2f4 regExpTable=0x2fc
          regExpStorage=0x304 functionSourceTable=0x348
          firstFunctionBodyOffset=0x358
```

`hermes-dec-sample/v84.hbc` (1898 bytes, class B, `hbc84`):
```
version=84 fileLength=1898 functionCount=8 stringKindCount=2 identifierCount=17
stringCount=34 stringStorageSize=238 regExpCount=1 regExpStorageSize=66
functionSourceCount=2 debugInfoOffset=0x620 options.raw=0x04
firstFunctionBodyOffset=0x320   (same as v94 — v94's bigint counts are zero)
```

`hermes-dec-sample/v98.hbc` (3005 bytes, **class E**, `hbc98-late`) — measured
from the bytes for this revision:
```
version=98 fileLength=3005 globalCodeIndex=0 functionCount=8 stringKindCount=2
identifierCount=19 stringCount=35 overflowStringCount=0 stringStorageSize=286
bigIntCount=0 bigIntStorageSize=0 regExpCount=1 regExpStorageSize=66
literalValueBufferSize=12 objKeyBufferSize=5 objShapeTableCount=1
numStringSwitchImms=0 segmentID=0 cjsModuleCount=0 functionSourceCount=2
debugInfoOffset=0xa3c options.raw=0x00   (bytes 113..127 all zero)
sections: functionHeaders=0x80 stringKinds=0xe0 identifierHashes=0xe8
          smallStringTable=0x134 stringStorage=0x1c0 literalValueBuffer=0x2e0
          objKeyBuffer=0x2ec objShapeTable=0x2f4 regExpTable=0x2fc
          regExpStorage=0x304 functionSourceTable=0x348
          firstFunctionBodyOffset=0x358
```
Identical to `v99.hbc` in every field except `fileLength` and `debugInfoOffset` —
which makes the pair the cleanest possible test that layout selection and opcode
selection are *independent* decisions.

`hermes-dec-sample/v99-public.hbc` (2981 bytes): same layout class, same
`literalValueBufferSize=12 / objKeyBufferSize=5 / objShapeTableCount=1 /
numStringSwitchImms=0`, same `firstFunctionBodyOffset=0x358`, same
`hbc99-mar2026` table.

### T2 — Function table, byte-exact

v94 (`docs/HBC-FORMAT.md` §3.4), all 8 rows asserted exactly:

| # | offset | params | size | nameId | infoOffset | frame | env | flags |
|---|---|---|---|---|---|---|---|---|
| 0 | 0x320 | 1 | 235 | 7 | 0x5c8 | 16 | 0 | 0x12 |
| 1 | 0x40b | 2 | 30 | 17 | 0x5d4 | 15 | 0 | 0x11 |
| 2 | 0x429 | 2 | 9 | 2 | 0x5e0 | 1 | 0 | 0x01 |
| 3 | 0x432 | 2 | 124 | 1 | 0x5e0 | 16 | 0 | 0x12 |
| 4 | 0x4ae | 1 | 9 | 19 | 0x5ec | 1 | 0 | 0x01 |
| 5 | 0x4b7 | 1 | 179 | 3 | 0x5ec | 17 | 0 | 0x1a |
| 6 | 0x56a | 1 | 54 | 25 | 0x620 | 12 | 1 | 0x12 |
| 7 | 0x5a0 | 1 | 37 | 9 | 0x62c | 9 | 0 | 0x12 |

Also assert: names resolve to `global, testx, ?anon_0_testx,
?anon_0_?anon_0_testx, gen, ?anon_0_gen, ze, zb`; functions 2 and 3 share
`infoOffset` (legal, §3.4); flag decoding (`0x11` ⇒ `prohibitInvoke:"construct"`
+ `hasDebugInfo`; `0x1a` ⇒ `hasExceptionHandler` + `hasDebugInfo` + strict).

v99 (§3.5): six functions overflowed with info blocks at
`0x89c, 0x8c4, 0x8ec, 0x914, 0x97c, 0x9a4`; the two non-overflowed are fn2
(`offset=0x463 params=1 loopDepth=0 size=24 nameId=19 numberRegCount=1
nonPtrRegCount=0 frameSize=2 flags=0x41 kind="Generator"`) and fn4
(`offset=0x4d4 params=2 nameId=1 frameSize=3 flags=0x41 kind="Generator"`).
Function 0's large header at `0x89c`: `offset=0x358 paramCount=1 loopDepth=0
bytecodeSizeInBytes=236 functionName=6 numberRegCount=1 nonPtrRegCount=1
frameSize=18 readCacheSize=9 writeCacheSize=5 privateNameCacheSize=0
flags=0x12`, followed by a 4-byte `DebugOffsets{sourceLocations: 0}` and then
function 1's info block at `0x8c4`.

### T3 — Exception handlers and debug offsets

v94 fn5 (`§4.1`), info at `0x5ec`: 3 handlers
`[0x1e,0x32,0x34] [0x1e,0x47,0x49] [0x4b,0x95,0x97]`, then
`DebugOffsets{sourceLocations:0x13c, scopeDescData:0, textifiedCallees:0}` at
`0x618`, and function 6's info at `0x620`.

v99 fn5 (`§4.2`), info at `0x914`: large header (36 B) with
`offset=0x4ef size=489 loopDepth=1 frameSize=32 flags=0x1a`, then 5 handlers
`[0x60,0x116,0x17b] [0x11e,0x125,0x17b] [0x131,0x157,0x17b] [0x15f,0x166,0x17b]
[0x172,0x17b,0x17b]`, then a **4-byte** `DebugOffsets{sourceLocations:0x97}` at
`0x978`, and function 6's info at `0x97c`.

**Regression guard:** assert `layout.debugOffsetsSize === 4` for v98/v99 and that
we do *not* produce a `scopeDescData` field there.

Two separate, both-true observations about hermes-dec here (review S4 — the
earlier one-sentence version conflated them):

1. **It never prints `textifiedCallees`, for any version.** On the v94 fixture it
   prints a two-field `[Debug offsets: source_locs=0x0, scope_desc_data=0x0]`,
   but v84–v96's real `DebugOffsets` has **three** fields
   (`sourceLocations`, `scopeDescData`, `textifiedCallees` —
   `docs/HBC-FORMAT.md` §4). That is a display omission, harmless.
2. **For v99 it additionally reads past the end of the struct.** Static Hermes
   shrank `DebugOffsets` to a single `uint32`, so the `scope_desc_data=0x47b` it
   prints for v99 function 1 is the *next function's* bytecode offset. That is a
   real misparse.

Only (2) is a correctness claim, and it is the single most useful test in the
suite for proving we are not copying the oracle.

### T4 — String table

v94: 34 entries, kinds `String × 17` then `Identifier × 17`; `identifierHash`
defined for exactly ids 17..33 and undefined below; id 12 is the regexp pattern,
id 13 is `gmi`, id 16 is UTF-16 and contains U+202F; `strings.get(7) === "global"`.
v99: 35 entries, `String × 16` then `Identifier × 19`; contains
`"Generator functions may not be called on executing generators"` and the
identifiers `value` and `done`.

Plus property tests over **all** fixtures: every entry's byte range is inside
`stringStorage`; `get(id).length === entry.length` for non-UTF16 and for UTF-16
(code-unit count); decoding is idempotent and cached (second call is the same
object identity for the cache map, and cheap).

### T5 — Golden snapshots (the ratchet)

For every gate `(fixture, version)` pair (**201** binaries today: 196 in
`constructs/`, 5 in `hermes-dec-sample/` — re-derive before hardcoding), write a
deterministic JSON
snapshot to `tests/golden/<group>/<name>/v<NN>.json` containing: the whole
header, `LayoutProfile` (including `probe.chosen` and `probe.decidedBy`), every
section span, every function header + handlers + debug offsets, the string table
as `[{id,kind,isUTF16,length,text}]`, the shape table, the counts of every other
table, and the decoded bigints. Sort keys; no absolute paths; no timings.

`UPDATE_GOLDEN=1 npm run test:unit` rewrites them. A snapshot diff in review is
the signal that a parser change altered observable output — including a layout
re-decision (R1's alarm).

### T6 — Oracle cross-check: `hbc-file-parser`

For every fixture binary, run `hbc-file-parser <file>` and parse its stdout
(**stdout only** — D4). It prints a two-column ASCII table of header fields,
then `=> <StringKind.X: n>: '...'` lines, then
`=> [Function #N name of S bytes]: P params @ offset 0xX`.

Compare this mapping:

| Ours | Theirs |
|---|---|
| `header.version` | `Version` |
| `header.fileLength` | `FileLength` |
| `header.functionCount` | `FunctionCount` |
| `header.stringCount` / `identifierCount` / `overflowStringCount` / `stringStorageSize` | same names |
| `header.bigIntCount` / `bigIntStorageSize` / `regExpCount` / `regExpStorageSize` | same names |
| `header.literalValueBufferSize` | `ArrayBufferSize` (v≤96 only) |
| `header.objKeyBufferSize` / `objValueBufferSize` | same names (v≤96 only) |
| `header.segmentID` / `cjsModuleCount` / `functionSourceCount` / `debugInfoOffset` | same names |
| `options.staticBuiltins` / `.cjsModulesStaticallyResolved` / `.hasAsync` | `StaticBuiltins` / `CjsModulesStaticallyResolved` / `HasAsync` |
| `strings.get(i)` + `kind(i)` for all i | the `=> <StringKind...>` lines, in order |
| each function's `index, name, bytecodeSizeInBytes, paramCount, offset` | the `=> [Function #N ...]` lines |

**Known-divergence allowlist** (`tests/gate/oracle/known-divergences.md`, one row per
entry, each with a reason and a link to the doc section):

* v99 `DebugOffsets` — hermes-dec reads 12 bytes where the format has 4
  (`docs/HBC-FORMAT.md` §4). We assert *our* value and skip theirs.
* v99 header field names — hermes-dec labels the static_h fields with the
  classic names; map by position, not by label, for class D/E files.
* v99 builtin names — hermes-dec's builtin table may not match the pinned
  commit; compare builtin *numbers*, not names.

The allowlist must not grow without an entry explaining the byte evidence. Any
divergence not on it fails the test.

### T7 — Layout probing

* Forcing the wrong class must fail: `parseHbc(v84bytes, {layout: "C"})` throws
  (P1's `count * stride` guard trips on `cjsModuleCount = 1568`).
* Forcing `hbc99-feb2026` on a v99 fixture must throw `E_UNKNOWN_OPCODE` or
  `E_OPERAND_OVERRUN` within the first 16 bytes of the global function.
* Auto-probing every fixture chooses: v84 → `B/hbc84`, v94 → `C/hbc94`,
  v99 and v99-public → `E/hbc99-mar2026`.
* **Real v98** (no longer synthetic): all 53 v98 fixtures choose `E/hbc98-late`,
  with `probe.decidedBy` containing `D1`. `hermes-dec-sample/v98.hbc` must agree
  with `v99.hbc` on every header field except `fileLength` and `debugInfoOffset`.
* Negative layout test: rewrite `header.version` to `97` in a v99 fixture and
  assert the parse **fails** (class D read against class-E bytes) rather than
  producing a plausible module.
* Cross-table negative: forcing `hbc98-late` on a v99 fixture must fail at the
  first `CreateRegExp`/switch site, and forcing `hbc99-mar2026` on a v98 fixture
  likewise — the two tables agree below opcode 165, so the test must use a
  fixture that reaches one of those opcodes (`hermes-dec-sample`, or
  `52-switch-jumptable`).
* Synthetic corruption: zero the magic → `E_BAD_MAGIC`; set `fileLength` to
  `bytes.length + 1` → `E_TRUNCATED`; set `functionCount = 0xFFFFFFF0` →
  `E_SECTION_OVERRUN` (and not an OOM).

### T8 — Fuzz

Deterministic, seeded (xorshift32, seed printed on failure). For each fixture
binary, generate 2000 mutants: single-byte flips, byte-range zeroing,
truncations at random lengths, and count-field maximisation (write `0xFFFFFFFF`
at each header u32 slot in turn). For each mutant assert:

* `parseHbc` either returns an `HbcModule` or throws an `Hbc2jsError`
  (`instanceof` check) — never a `TypeError`/`RangeError`/`OOM`;
* it returns within 20 ms;
* if it returns a module, every `FunctionRecord.body()` view is inside the file
  and `strings.get(i)` for all `i` does not throw anything other than
  `Hbc2jsError`.

Run with `--test-concurrency=1` and a per-test timeout; keep the whole T8 file
under 30 s.

### T9 — Performance (sweep tier)

Real inputs now exist. `tests/sweep/parse/perf.test.ts` parses each
`bundles/rn-template-0.72/*.hbc` and asserts the §7.3 budgets, scaled to the
file's size. The largest is `index.android.noopt.debug.hbc` at **2.7 MB**
(4314 functions, 5268 strings, 12 overflow strings) — roughly a quarter of
SPEC's 12 MB "definition of done" target, so the test asserts the budget
*pro rata* and the report states the linear extrapolation to 12 MB explicitly
rather than pretending the target was met. Record the measured numbers in
`docs/STATUS.md`; a regression is only visible against a written-down baseline.

`HBC2JS_BIG_BUNDLE=<path>` points the same test at a larger local bundle
(C5 / `local-corpus/`, D16) when one is available; absent, that leg is
INCONCLUSIVE, never PASS.

### T10 — Format-path coverage (risk R5) — re-surveyed

The research recorded that literal buffers, BigInt, shape tables and switch
tables were all zero in the corpus. **That is now substantially false**, and this
revision re-measured the whole tree. Lock in what exists; keep the rest visible.

| Path | Fixture that exercises it | Status |
|---|---|---|
| `arrayBuffer` / `literalValueBuffer` | `constructs/37-destructuring-array` (37 B), `40-spread-array` (19 B); `bundles/rn-template-0.72` (8559 B) | **covered** |
| `objKeyBuffer` | `constructs/41-spread-object` (7 B), `38-destructuring-object` (7 B), `45-regex-literals` (4 B); bundle (2061 B) | **covered** |
| `objValueBuffer` (v≤96) | `bundles/rn-template-0.72/*.hbc` (1524 B) | **covered** |
| `objShapeTable` (v≥97) | `hermes-dec-sample/v98.hbc`, `v99.hbc` (1 entry) | **covered** |
| `bigIntTable` | `constructs/46-bigint-arithmetic` (6 entries at v94/v98/v99; absent at v84 — class B predates BigInt) | **covered** |
| `SwitchImm` (v≤96) | `constructs/52-switch-jumptable` v84/v94: `SwitchImm r0, 253, +223, 0, 12`; `53-switch-jumptable-large` (40 cases) | **covered** |
| `UIntSwitchImm` (v≥98) | same two fixtures at v98/v99 | **covered** |
| overflowed string entry (`length === 0xFF`) | `bundles/rn-template-0.72/*.hbc` — **12** overflow entries | **covered (sweep tier)** |
| overflowed v≤96 function header | `bundles/rn-template-0.72/index.android.hbc` — **2** overflowed | **covered (sweep tier)** |
| bytecode dedup / shared bodies (§1.1) | same bundle — **165** offsets shared by ≥ 2 functions | **covered (sweep tier)** |
| `-O` optimised build | the whole `bundles/rn-template-0.72` set. **Note:** this hermesc build optimises *by default* — no-flags output is byte-identical to `-O`; only explicit `-O0` disables it, so `noopt` variants are the unoptimised control | **covered (sweep tier)** |
| debug info present (`-g`) | `bundles/rn-template-0.72/index.android.debug.hbc`, `*.noopt.debug.hbc` | **covered (sweep tier)** |
| `StringSwitchImm` (v≥99) | **none** — 52/53 are integer switches | **gap** (O-1) |
| `cjsModuleTable` non-empty | **none** — the RN template bundle has `cjsModuleCount = 0` | **gap** (O-3) |
| `segmentID != 0` (split bundle) | **none** | **gap** (O-3) |
| layout class A (v51–83), class D (v97 / v98-early) | **none** | **gap** (O-2) |

Write the covered rows as real assertions, filed by tier: `constructs/**` and
`hermes-dec-sample/**` rows in `tests/gate/`, every `bundles/**` row in
`tests/sweep/`. Write the gap rows as skips whose message names this table so
they show up in the test output as a standing reminder.

---

## 9. Acceptance criteria

Counts below were measured for this revision (53 `constructs/` dirs; 196
`constructs/*/v*.hbc`; 5 `hermes-dec-sample/*.hbc`; 4 `bundles/rn-template-0.72/*.hbc`).
**Re-derive them from the tree before hardcoding** — the corpus is growing under
another agent.

- [ ] `parseHbc` parses all **201** gate-tier binaries (196 + 5) with zero thrown
      errors and zero `warn`-severity diagnostics other than those listed in T10.
- [ ] `parseHbc` parses all four `bundles/rn-template-0.72/*.hbc` (sweep tier),
      including the 12 overflowed strings, the 2 overflowed function headers and
      the 165 shared body offsets.
- [ ] T1/T2/T3/T4's byte-exact assertions all pass, hardcoded, no snapshot
      indirection — including the new v98 header block.
- [ ] `layout.probe.chosen` is `B/hbc84`, `C/hbc94`, `E/hbc98-late`,
      `E/hbc99-mar2026` for the respective fixtures, and `probe.candidates`
      records why each rival died.
- [ ] Forcing a wrong layout or a wrong opcode table throws, never silently
      succeeds (T7), including the v98↔v99 cross-table cases.
- [ ] `probe.exhaustive` is `true` for every fixture and for every bundle under
      4 MB; where it is `false`, spec 02's decode errors carry the §6.4 step-4
      hint.
- [ ] `npm run gen:tables:check` passes: the committed tables regenerate
      byte-identically from `third_party/hermes/**`.
- [ ] The `.def` parser rejects macro placeholders: feeding it the real
      `BytecodeList.def` yields exactly 185 / 192 / 201 / 219 / 220 opcodes for
      the respective pins, and §5.4 rule 9's independent count agrees. A test
      feeds it a synthetic `.def` whose preamble names its placeholder `name0`
      instead of `name` and asserts the parser still returns the right count
      (this is the case §5.5's uniqueness check would miss).
- [ ] Every §5.5 table assertion passes at load time; deliberately corrupting one
      generated opcode name makes a table test fail (verify, then revert).
- [ ] `third_party/hermes/<tableId>/LICENSE` (MIT) exists for every table, and
      `PROVENANCE.md` records commit SHA + sha256 per file — with `hbc94` =
      `1c717488` and `hbc84` = `c2cd9e38` as resolved in §5.2.
- [ ] `git grep -In 'hermes[-_]dec' -- src/` returns nothing (D4/R6).
- [ ] T6 passes against `hbc-file-parser` on every gate binary, with an allowlist
      of at most the three entries named in T6.
- [ ] T8 fuzz: 2000 mutants per gate binary, zero non-`Hbc2jsError` escapes, zero
      timeouts; inputs of length 0/7/8/100/127 all report `E_TRUNCATED`.
- [ ] Golden snapshots exist for every gate `(fixture, version)` and are stable
      across two consecutive runs (`git diff --exit-code tests/golden`).
- [ ] `node src/cli.ts --info tests/fixtures/hermes-dec-sample/v98.hbc` prints
      version, layout class, opcode table id, probe decision, section map and
      function count, and exits 0.
- [ ] Peak RSS parsing `bundles/rn-template-0.72/index.android.noopt.debug.hbc`
      (2.7 MB) is < 3× its size, and parse time is recorded in `docs/STATUS.md`.
- [ ] Nothing under `tests/fixtures/**` or `tools/**` was modified.

---

## 10. Estimated complexity

**Mostly Sonnet; two Opus-shaped pieces.**

| Component | Size | Model |
|---|---|---|
| `util/reader.ts`, `util/bits.ts`, `util/text.ts` | ~250 lines | Sonnet |
| `parse/header.ts`, `sections.ts`, `strings.ts`, `functions.ts`, `exceptions.ts` | ~700 lines, mechanical against §2–§5 of HBC-FORMAT | Sonnet |
| `parse/buffers.ts`, `bigint.ts`, `regexp.ts`, `cjs.ts`, `debug.ts` | ~300 lines | Sonnet |
| **`parse/layout.ts`** (the probe ladder) | ~400 lines, and it is where R1 lives — now with five layout candidates and six opcode tables | **Opus, or Sonnet + Opus review** |
| **`tools/gen-tables/gen.ts`** (macro-aware C parsing, §5.4 rule 0) | ~450 lines; the review found the naive version over-counts by 6 | **Opus, or Sonnet + Opus review** |
| tests T1–T10 | ~1300 lines, repetitive | Sonnet |

Sequence: tables → reader → header+sections → strings → functions → info blocks
→ buffers → layout probe → tests. Write the layout probe **last**, once four
known-good files (v84, v94, v98, v99) parse under forced layouts — that way the
probe is validated against known answers instead of defining them.

---

## 11. Open questions for the overseer

* **O-1 — `StringSwitchImm` has no fixture.** 52/53 close the integer-switch gap
  at all four versions, but neither is a `switch` over string literals, so
  `StringSwitchImm` (v≥99, and the `numStringSwitchImms` header field) is still
  entirely untested. One more fixture — `54-switch-string`, a `switch` over ~8
  string cases — would close it. Approve, and who writes it?
* **O-2 — layout classes A and D have no fixture.** Class D (v97 / v98-early) is
  the one the probe must distinguish from E, and we have no example of it; class
  A (v51–83) is legacy. `hermes-engine-cli@0.7.x` gives HBC 76 (class A) and
  would at least exercise that branch. Is v97 obtainable at all, or do we mark
  class D "implemented, unverified" in `docs/STATUS.md` and move on?
* **O-3 — `cjsModuleTable` and `segmentID`.** The RN template bundle has
  `cjsModuleCount = 0`, so Metro's `require` map and split segments remain
  untested. `react-navigation-example-0.85.3` is scaffolded but not yet built —
  will it produce a CJS-resolved bundle, or do we need `--experimental-bundle`
  style Metro flags?
* **O-4 — the 12 MB target.** SPEC's "definition of done" #4 wants ~12 MB; the
  largest input in the tree is 2.7 MB. `docs/TEST-CORPUS.md` nominates
  Expensify/App (MIT). Do we build it, or restate the target as "the largest
  real bundle in the corpus" and record the extrapolation?
* **O-5 — debug delta stream.** M1 stops at the debug-info header. Decoding the
  `(address, line, column)` stream buys line numbers in emitted JS and module
  boundaries in big bundles, and `hermesc -dump-bytecode` prints the decoded
  table (`bc 24: line 7 col 1 …`) so the oracle is free. Fold into M1, or a
  separate spec?
* **O-6 — parse-only versions.** §6.1 lets versions 85–93, 95–97 parse with no
  opcode table. Useful (`--info` on any bundle), or should an ungenerated table
  be a hard error to avoid implying support we do not have?

---

## 12. Review responses (`docs/specs/REVIEW-01-02.md`)

| Item | Verdict | Where |
|---|---|---|
| **B2** `.def` parser counts the file's own macro preamble and `DEFINE_JUMP_n` bodies (198 vs 192) | **Fixed** | §5.4 rule 0: skip `#`-directive lines, skip backslash-continued `#define` bodies, `#if` depth tracking (which subsumes the `HERMES_RUN_WASM` special case), and a hard reject of placeholder names. §5.4 rule 9 adds the independent `142 + 2×25 = 192` cross-check. §5.5 adds the 192 assertion for `hbc94` and a synthetic-`.def` test for the `name0` future-proofing the review asked for. §5.2 records the resolved SHAs `1c717488` / `c2cd9e38` |
| **B3** specs stale against the fixture corpus | **Fixed** | Whole-tree re-survey: §6.1, T1 (new v98 block), T7, **T10** (rewritten — 12 of 16 rows now covered), §9 counts. Old O-1/O-4/O-5 deleted; new O-1..O-4 are the gaps that actually remain |
| **S1** probe samples rather than verifies on large files | **Fixed** | §6.4 step 4: `probe.exhaustive` / `sampledFunctions` / `totalFunctions` in `ProbeReport`, a required hint on decode errors outside the sample, and `--verify` for exhaustive probing. Also §6.4 now warns that v98-vs-v99 tables agree below opcode 165, so early termination is *not* guaranteed |
| **S4** hermes-dec debug-offsets claim conflates two things | **Fixed** | T3 now states them separately: it never prints `textifiedCallees` (any version, harmless) *and* it over-reads by 4 bytes on v99 (a real misparse) |
| **S6** no "shorter than a header" invariant | **Fixed** | INV-00 (`bytes.length ≥ 128` before any field read) plus a test pinning lengths 0/7/8/100/127 to `E_TRUNCATED` |
| **N1** `tests/fixtures/README.md`'s "51 total" is stale | **Relayed, not fixed here** | That file belongs to another agent. §9 and spec 00 §7.1 now instruct the implementer to re-derive counts from the tree rather than trust any written number, which is the durable fix on our side |
| **N4** the `< 51` row is correct | **Acknowledged, no change** | Verified independently; §6.1 keeps the row |
| **N5** GitHub REST API misses commits for `BytecodeVersion.h` | **Fixed** | §5.3 now states the local-clone requirement is a correctness requirement, not just hermeticity, and cites the 10-of-17 undercount |
| B1, S2, S3, S5, N2, N3 | Not this spec's | B1/N3 in spec 02; S2/S3/S5/N2 in spec 00 |

**Not adopted:** nothing from the review was rejected outright. The one place I
went further than asked is §6.2's `resolvedOffset` warning — while re-measuring
the v98/v99 files for B3 I found that P2.a as originally written takes `min` over
the *raw* small-header `offset` field, which for class D/E overflowed entries is
half of a packed pointer. On `hermes-dec-sample/v99.hbc` that yields `0x463`
instead of the true `0x358`, i.e. the probe would have rejected every valid
class-E file. That is a latent blocker the review did not catch.
