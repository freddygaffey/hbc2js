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
  | "hbc84" | "hbc94" | "hbc99-feb2026" | "hbc99-mar2026";   // extend as tables are added
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

| tableId | bytecode version | opcodes | Hermes commit | Status |
|---|---|---|---|---|
| `hbc84` | 84 | 185 | **TBD — resolve per §5.3** | O-1 |
| `hbc94` | 94 | 192 | **TBD — resolve per §5.3** | O-1 |
| `hbc99-feb2026` | 99 | 219 | `42235b8d913f` (2026-02-12, the v99 bump) | from `docs/HBC-FORMAT.md` §0 |
| `hbc99-mar2026` | 99 | **220** | `913d31acd10a` (2026-03-05, "Revert bytecode version to 99"; inserts `NewTypedObjectWithBuffer` at index 4) | from `docs/HBC-FORMAT.md` §0 |

For completeness (not needed for M1, add when a v98 file appears): the v98-late
header layout first appears at `639e5d6afb16`, the parent of the v99 bump.

Both our v99 fixtures decode **only** against `hbc99-mar2026`
(`docs/HBC-FORMAT.md` §11.2). `hbc99-feb2026` is generated anyway, because it is
what makes the v99 probe a *choice between two tables* rather than an
assumption, and because bytecode built in the 2026-02-12…2026-03-05 window
exists in the wild.

### 5.3 Resolving the two TBD commits

Do not guess a SHA. Resolve them mechanically:

```sh
git clone --filter=blob:none https://github.com/facebook/hermes
cd hermes
# the commit that set BYTECODE_VERSION to N is the pin for version N:
git log --oneline -S'BYTECODE_VERSION = 84' -- include/hermes/BCGen/HBC/BytecodeVersion.h
git log --oneline -S'BYTECODE_VERSION = 94' -- include/hermes/BCGen/HBC/BytecodeVersion.h
```

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

1. Strip `//` and `/* */` comments. Process line by line.
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
| all | `opcodes[0].name === "Unreachable"`; names unique; every operand type known |
| `hbc84` | length 185 |
| `hbc94` | length 192; `DeclareGlobalVar`=52, `GetGlobalObject`=48, `CreateEnvironment`=50, `PutById`=59, `CreateAsyncClosure`=104, `Ret`=92, `Catch`=93, `CreateRegExp`=132, `SwitchImm`=133; builtin 52 === `spawnAsync` |
| `hbc99-feb2026` | length 219 |
| `hbc99-mar2026` | length 220; `GetParentEnvironment`=52, `GetGlobalObject`=61, `CreateFunctionEnvironment`=64, `CreateTopLevelEnvironment`=65, `DeclareGlobalVar`=67, `GetByIdShort`=68, `TryGetById`=72, `PutByIdLoose`=74, `Ret`=118, `Catch`=119, `CreateClosure`=132, `CreateRegExp`=166, `UIntSwitchImm`=167, `StringSwitchImm`=168, `CreateGenerator`=169; opcode 4 === `NewTypedObjectWithBuffer`; builtin 57 === `spawnAsync` |

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
| < 51 | — | — | `E_UNSUPPORTED_VERSION` |
| 51–83 | A | (none generated) | parse-only; `E_UNSUPPORTED_VERSION` on decode |
| 84 | B | `hbc84` | |
| 85–86 | B | (none) | parse works, decode unsupported |
| 87–96 | C | `hbc94` **only if version === 94** | 87–93, 95, 96 parse but do not decode |
| 97 | D | (none) | |
| **98** | **D and E** | (none) | **ambiguous — probe (§6.3)** |
| 99 | E | **`hbc99-mar2026` and `hbc99-feb2026`** | **ambiguous — probe (§6.4)** |
| > 99 | E (optimistic) | — | `E_UNSUPPORTED_VERSION` unless `options.layout` forces |

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
| P2.a | `min(header.offset over all functions) === sections.firstFunctionBodyOffset` |
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

There is no v98 fixture in the corpus (O-2). Until one exists, the D-vs-E path
is tested synthetically: construct a v98 file by taking a real v99 fixture and
rewriting `header.version` to 98 — the layout is then genuinely class E under a
98 version field, which is exactly the "v98-late" case, and the probe must pick
E. Symmetrically, a synthesized "v98-early" is out of reach and stays untested
until a real file appears.

### 6.4 The v99 219-vs-220 opcode-table probe

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

Empirically this terminates on the first few instructions:
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

Location: `tests/unit/parse/**` and `tests/oracle/**`. Fixture access via
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

**Regression guard:** assert `layout.debugOffsetsSize === 4` for v99 and that we
do *not* produce a `scopeDescData` field there. hermes-dec reads 4 bytes too far
here and reports `scope_desc_data=0x47b`, which is the next function's bytecode
offset (`docs/HBC-FORMAT.md` §4). This is the single most useful test in the
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

For every `(fixture, version)` pair (≈ 141 today), write a deterministic JSON
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

**Known-divergence allowlist** (`tests/oracle/known-divergences.md`, one row per
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
* Synthetic v98: take `v99.hbc`, write `98` at offset 8, parse. Expect class E
  chosen, `probe.decidedBy` containing `D1` or `P2.a`, and every other field
  identical to the v99 parse.
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

### T9 — Performance smoke (gated)

`HBC2JS_PERF=1` and `HBC2JS_BIG_BUNDLE=<path>` enable a test that parses the
bundle and asserts the §7.3 budgets. Skipped otherwise. No 12 MB bundle exists
in the corpus yet (O-4); until one does, a synthetic stand-in is acceptable:
concatenate the 51 construct sources into one file and compile it with
`hermesc -O`, which yields a few hundred KB — enough to catch O(n²), not enough
to validate the 12 MB target. Say which one ran in the assertion message.

### T10 — Untested-format-path coverage (risk R5)

The research recorded that literal buffers, BigInt, shape tables and switch
tables were all zero in the corpus. **That is now partly false** and the tests
must lock in the coverage that exists:

| Path | Fixture that exercises it (v94 unless noted) | Status |
|---|---|---|
| `arrayBuffer` / `literalValueBuffer` | `constructs/37-destructuring-array` (37 B), `40-spread-array` (19 B) | covered |
| `objKeyBuffer` | `constructs/41-spread-object` (7 B), `38-destructuring-object` (7 B), `45-regex-literals` (4 B) | covered |
| `objShapeTable` | `hermes-dec-sample/v99.hbc` (1 entry) | covered |
| `bigIntTable` | `constructs/46-bigint-arithmetic` (6 entries, v94/v99; **not v84** — no BigInt in class B) | covered |
| overflowed string entry (`length === 0xFF`) | **none** | **gap** |
| overflowed v≤96 function header | **none** | **gap** |
| `SwitchImm` / `UIntSwitchImm` / `StringSwitchImm` jump table | **none** — verified by disassembling all 51×2 construct binaries | **gap** |
| `cjsModuleTable`, `segmentID != 0` | **none** | **gap** (needs a real Metro bundle) |
| `-O` build (bytecode dedup, shared offsets) | **none** | **gap** |

Write the covered rows as real assertions now (decode the buffers and check the
values against the fixture's `source.js` literals). Write the gap rows as
`t.skip("no fixture exercises this — see docs/specs/01-parser.md T10")` so they
appear in the test output as a standing reminder, and raise O-4/O-5.

---

## 9. Acceptance criteria

- [ ] `parseHbc` parses all four `hermes-dec-sample/*.hbc` and every compiled
      `constructs/*/v{84,94,99}.hbc` (~141 binaries) with zero thrown errors and
      zero `warn`-severity diagnostics other than those listed in T10.
- [ ] T1/T2/T3/T4's byte-exact assertions all pass, hardcoded, no snapshot
      indirection.
- [ ] `layout.probe.chosen` is `B/hbc84`, `C/hbc94`, `E/hbc99-mar2026` for the
      respective fixtures, and `probe.candidates` records why each rival died.
- [ ] Forcing a wrong layout or a wrong opcode table throws, never silently
      succeeds (T7).
- [ ] `npm run gen:tables:check` passes: the committed tables regenerate
      byte-identically from `third_party/hermes/**`.
- [ ] Every §5.5 table assertion passes at load time; deliberately corrupting
      one generated opcode name makes a table test fail (verify, then revert).
- [ ] `third_party/hermes/<tableId>/LICENSE` (MIT) exists for every table, and
      `PROVENANCE.md` records commit SHA + sha256 per file.
- [ ] `grep -rIn 'hermes[-_]dec' src/` returns nothing (D4/R6).
- [ ] T6 passes against `hbc-file-parser` on every fixture, with an allowlist of
      at most the three entries named in T6.
- [ ] T8 fuzz: 2000 mutants per binary, zero non-`Hbc2jsError` escapes, zero
      timeouts.
- [ ] Golden snapshots exist for every `(fixture, version)` and are stable
      across two consecutive runs (`git diff --exit-code tests/golden`).
- [ ] `node src/cli.ts --info tests/fixtures/hermes-dec-sample/v99.hbc` prints
      version, layout class, opcode table id, probe decision, section map and
      function count, and exits 0.
- [ ] Peak RSS parsing the largest available fixture is < 3× its size.
- [ ] No file under `tests/fixtures/**` or `tools/equiv/**` was modified.

---

## 10. Estimated complexity

**Mostly Sonnet; two Opus-shaped pieces.**

| Component | Size | Model |
|---|---|---|
| `util/reader.ts`, `util/bits.ts`, `util/text.ts` | ~250 lines | Sonnet |
| `parse/header.ts`, `sections.ts`, `strings.ts`, `functions.ts`, `exceptions.ts` | ~700 lines, mechanical against §2–§5 of HBC-FORMAT | Sonnet |
| `parse/buffers.ts`, `bigint.ts`, `regexp.ts`, `cjs.ts`, `debug.ts` | ~300 lines | Sonnet |
| **`parse/layout.ts`** (the probe ladder) | ~350 lines, but it is where R1 lives | **Opus, or Sonnet + Opus review** |
| **`tools/gen-tables/gen.ts`** (C-macro parsing) | ~400 lines, fiddly, correctness is load-bearing for everything downstream | **Opus, or Sonnet + Opus review** |
| tests T1–T10 | ~1200 lines, repetitive | Sonnet |

Sequence: tables → reader → header+sections → strings → functions → info blocks
→ buffers → layout probe → tests. The layout probe is written **last**, once
three known-good files parse under forced layouts — that way the probe is
validated against known answers instead of defining them.

---

## 11. Open questions for the overseer

* **O-1 — the two unresolved Hermes commits.** `hbc84` and `hbc94` need pinned
  SHAs (§5.2). §5.3 gives a mechanical resolution procedure and §5.5 gives an
  independent verification, so the implementer can resolve them without a
  decision from you — but it needs network access to clone `facebook/hermes`.
  Confirm that is available, or supply the two SHAs.
* **O-2 — no v98 fixture.** The v98 D-vs-E ambiguity is the one hazard we cannot
  test against a real file. `hermes-compiler@250829098.0.x` is on npm
  (`docs/TOOLCHAIN.md`) and would produce a genuine v98 — but which of the two
  layouts it emits is itself unknown until we look. Worth adding
  `tools/get-hermesc.sh 98` and a v98 fixture set?
* **O-3 — debug delta stream.** M1 stops at the debug-info header. Decoding the
  `(address, line, column)` stream is worth real money later (line numbers in
  emitted JS, module boundaries in big bundles, and `hermesc -dump-bytecode`
  prints the decoded table so we have a free oracle). Fold it into M1, or defer
  to a separate spec?
* **O-4 — the 12 MB bundle.** "Definition of done" #4 needs one, and it is the
  only thing that will exercise `cjsModuleTable`, overflowed strings, overflowed
  function headers and `-O` dedup (T10's gaps). `docs/TEST-CORPUS.md` nominates
  Expensify/App (MIT). Who builds it, and does it get committed or fetched?
* **O-5 — no switch jump table anywhere in the corpus.** I disassembled all 51
  construct fixtures at v94 and v99: **not one `SwitchImm`/`UIntSwitchImm`**.
  `hermesc` lowers small `switch`es to comparison chains. A fixture with ~16
  dense integer cases (and a `-O` variant) is needed before spec 02's jump-table
  code can be tested at all. Should I write that fixture request up for the
  fixtures agent?
* **O-6 — parse-only versions.** §6.1 lets versions 85–93, 95–98 parse with no
  opcode table. Is that useful (`--info` on any bundle), or should an
  ungenerated table be a hard error to avoid implying support we do not have?
