# Known oracle divergences

Every entry here must cite bytes, not just "the normaliser needed a tweak" — a
growing list without evidence is a defect signal. Widening a normaliser to
make a real bug pass is never the fix; if the bug is ours, fix the
decoder/printer, not the regex.

This file is shared by two specs' oracle cross-checks: spec 01 §8 T6
(`hbc-file-parser`, M1) below, and spec 02 §7 (the disassembler oracles,
`hermesc -dump-bytecode` / `hbc-disassembler`, M2) further down.

## T6 (`hbc-file-parser` — spec 01 §8, `tests/gate/oracle/hbc-file-parser.test.ts`)

Per docs/specs/01-parser.md §8 T6: "Any divergence not on it fails the test." Every
entry here must name the byte evidence, not just assert a difference exists.

| # | Divergence | Evidence |
|---|---|---|
| 1 | v99's `DebugOffsets` | hermes-dec reads a 12-byte, 2-field `DebugOffsets` (`source_locs`, `scope_desc_data`) for every version. The real v99 (class D/E) struct is 4 bytes, one field (`sourceLocations`) — docs/HBC-FORMAT.md §4. hermes-dec's `scope_desc_data` for a v99 function is actually the *next* function's bytecode offset (it reads 4 bytes past the end of the struct). We assert our own value and never compare this field. |
| 2 | v99 header field names | hermes-dec labels the static_h (class D/E) header fields with the classic (pre-v97) names positionally. `tests/gate/oracle/hbc-file-parser.test.ts` maps by the label hermes-dec actually prints (which happens to still read correctly for the fields this project checks), not assuming its printed name matches our field's semantic name for class D/E files. |
| 3 | v99 builtin names | hermes-dec's builtin table may not match this project's pinned commit (`hbc99-mar2026`, `913d31ac`) exactly for less common builtins. M1 does not decode builtin call sites at all (that's spec 02's `GetBuiltinClosure`/`CallBuiltin` operand resolution), so this test never compares builtin names or numbers — noted here for whoever writes that spec 02 oracle cross-check next, so the comparison is by builtin *number*, not name, from the start. |

This list must not grow without a new row explaining the byte evidence — see spec 01
§9's acceptance criterion ("T6 passes ... with an allowlist of at most the three
entries named in T6").

## 7.A (`hermesc -dump-bytecode`, `tests/gate/oracle/disasm/hermesc.test.ts`)

1. **`hermes-dec-sample/v99.hbc` is not byte-reproducible.** Built by a
   non-public Hermes commit (`docs/TOOLCHAIN.md`); a fresh `hermesc -emit-binary`
   of `source.js` never matches it byte-for-byte at any embedded filename tried.
   `hermes-dec-sample/v99-public.hbc` (a separate, reproducible fixture) covers
   the v99 hermesc comparison instead; `v99.hbc` is skipped from 7.A entirely
   (covered by 7.B, which reads `.hbc` directly and needs no recompile).

2. **`hermes-dec-sample/v94.hbc` reproduces only under the embedded filename
   `"sample.js"`, not `"source.js"`.** Verified directly: `hermesc -emit-binary
   -out=x.hbc source.js` (relative filename `source.js`, matching the fixture's
   on-disk name) differs from `v94.hbc` at byte 1630; the identical compile
   under the relative filename `sample.js` is byte-identical. `hermesc` embeds
   the invoked filename in the function-source table (`docs/TOOLCHAIN.md`), and
   `v94.hbc` is a **preserved historical original** (`tests/support/fixtures.ts`'s
   `NOT_REPRODUCIBLE` set), compiled before the fixture was renamed to
   `source.js`. Every other fixture in the corpus — including
   `hermes-dec-sample`'s own `v84`/`v96`/`v98`/`v99-public` — reproduces under
   `source.js` with no fallback needed. The test tries `"source.js"` first and
   falls back to `"sample.js"` **only** for this one documented (group, version)
   pair; a new fixture ever needing the fallback would itself be a bug (the
   test asserts this explicitly rather than widening the fallback silently).

3. **A third real header-line shape: `Constructor<Name>(...)`.** Not in spec 02
   §6.1's own list (`Function<...>` / `NCFunction<...>`, "nothing else
   observed"). Verified: `tools/hermesc/v98/hermesc -dump-bytecode` on
   `tests/fixtures/constructs/32-class-basic/source.js` (byte-identical to
   `v98.hbc`) prints `Point`'s constructor as
   `Constructor<Point>(3 params, 2 registers, 0 numbers, 0 non-pointers):`,
   while every other function in the same file (including `global`) uses
   `Function<...>`/`NCFunction<...>`. This lines up with `FunctionFlags.
   prohibitInvoke === "call"` (construct-only — the *call* path is what's
   prohibited), the mirror image of `"construct"` (not constructable, `NC`).
   Not a normaliser widening: `src/disasm/print.ts`'s `rawHeaderLine` now
   renders this case, and `normalize.ts`'s `HEADER_RE` accepts it as a third,
   explicit alternative (still failing loudly on anything else, per spec's own
   "fail loudly on any other prefix" instruction).

## Open, not a divergence in our code (blocking full 7.A agreement at v98)

4. **`FunctionHeader.flags` (`prohibitInvoke`, `hasExceptionHandler`, at least)
   is misdecoded for v98 (layout class E / `hbc98-late`) — a `src/parse/**`
   bug, outside spec 02's ownership.** Evidence:
   - `tests/fixtures/constructs/32-class-basic/v98.hbc`: every one of its 5
     functions, **including `global`**, decodes with `prohibitInvoke: "call"`
     and `overflowed: true`. Real `hermesc -dump-bytecode` (byte-identical
     recompile) shows `global` as a plain, unprefixed `Function<global>`, not
     `NCFunction`/`Constructor` — `prohibitInvoke` must be `"none"` for it.
   - `tests/fixtures/constructs/01-if-else-chain/v98.hbc`: `global`'s decoded
     `hasExceptionHandler` is `false` and its `exceptionHandlers` array is
     empty, but the real dump has a genuine `Exception Handlers:` block for
     `global` (one handler, `start=41,end=64` in file bytes — see the dump's
     `74:Exception Handlers:` line).
   - Cross-check: the same construct fixture's v94/v96/v99 builds decode these
     fields correctly (`global`'s `prohibitInvoke` is `"none"` at v94/v99 on
     `01-if-else-chain`). Only v98 is affected.
   - Every 7.A test failure observed in this milestone's implementation run
     traces to this one root cause (function-count-preserving header/handler
     mismatches) plus item 5 below — zero unrelated formatting bugs found.
   - Reported for the M1 owner; not fixed here (outside `src/disasm/**`
     ownership for M2). `src/disasm/print.ts`'s `Constructor<...>` rendering
     rule (item 3) is verified correct independent of this bug — it was
     confirmed against fixtures whose flags decode correctly.
   - **FIXED (M1, `src/parse/functions.ts`/`header.ts`).** Root cause: Hermes
     commit `f74f6bbe37` (present only for `BYTECODE_VERSION` 98, reverted by
     `913d31acd1` before v99 shipped) added an extra 1-bit `NumCacheNewObject`
     field to class E's `FUNC_HEADER_FIELDS`, squeezed into small-header byte
     10 alongside `writeCacheSize`/`privateNameCacheSize` (packed size
     unaffected) but promoted to its own full byte in the *unpacked* large
     header (one member per field, regardless of bit-width). That makes
     v98's large header 37 bytes, not 36, shifting `flags` from offset 35 to
     36 — every overflowed v98 function's flags were read one byte early.
     `classLayoutConstants` is now version-aware for class E
     (`largeFuncHeaderSize`: 37 for v98, 36 otherwise); see
     `tests/gate/parse/functions.test.ts`'s byte-exact v98 flags test (3
     fixtures, cross-checked against this project's own already-correct v99
     decode of the same sources). The `01-if-else-chain` handler above is
     `start=60,end=85,target=85` in this project's byte numbering (file
     offsets, not the disassembly-relative ones `hermesc -dump-bytecode`'s
     label view implies) — verified against the real `Exception Handlers:`
     block and against v99's decode of the same source, both byte-identical.
     This exposed a **matching, still-open bug in `hermes-dec`** itself — see
     7.B item 9 below.

5. **A real, previously-"unverified" `hbc98-late` opcode is now identified.**
   `src/tables/types.ts`'s `OpcodeDef.unverified` flag (opcode 15,
   `UnknownFastArrayOpcode98Late`, a placeholder with a guessed `(Reg8, Reg8)`
   signature — see `tools/gen-tables/gen.ts`'s `patchHbc98Late`) is genuinely
   exercised by `tests/fixtures/constructs/50-this-binding/v98.hbc` (function
   `Counter`, body offset 4). Real `hermesc -dump-bytecode` (byte-identical
   recompile) shows: `CacheNewObject 3<Reg8>, 2<Reg8>, 2<UInt32>, 0<UInt8>` — a
   **4-operand** `(Reg8, Reg8, UInt32, UInt8)` signature, not the placeholder's
   2-operand guess. `src/disasm/decode.ts` correctly refuses to decode this
   opcode (`E_UNKNOWN_OPCODE`, per the `unverified` contract — D8/R1: fail
   loudly rather than guess), so this fixture's decode currently throws.
   Fixing the generated table (`tools/gen-tables/gen.ts`'s `patchHbc98Late` and
   `src/tables/generated/opcodes-hbc98-late.ts`) is a `src/tables/**` /
   `tools/gen-tables/**` change outside this milestone's mandate to make
   unilaterally (it changes opcode *positional numbering* semantics pinned by
   spec 01) — reported for the table owner with the exact real name/signature.

## 7.B (`hbc-disassembler`, `tests/gate/oracle/disasm/hermes-dec.test.ts`)

Per spec 02 §7.B's own allowlist (all four items observed exactly as
documented there, no widening needed):

1. v99 `[Debug offsets:]` — dropped by the normaliser (hermes-dec reads 12
   bytes where the real struct is 4; spec 01 T3 asserts our own value).
2. Builtin numbering — compared as numbers only (comments dropped); no
   disagreement observed in this corpus.
3. v99 "not formally supported" stderr warning — ignored (stdout only).
4. Opcode names — no name-mapping in the normaliser; a mismatch would mean a
   wrong table pin, not a formatting difference. None observed.

Beyond that allowlist, three real bugs were found and fixed in this
milestone's own `normalize.ts` (none required widening — each is a genuine
shape the tool emits that the first draft's regex/parsing simply didn't
handle):

5. **Two more function-header shapes**: `=> [Generator function #N ...]:` and
   `=> [Async function #N ...]:`, for a compiler-synthesized generator/async
   body — neither has a companion plain `Function #N` line, so the
   header-only regex originally in place silently dropped the line entirely,
   desynchronising every function index after it by one (manifesting as
   `FUNC` lines lining up against instruction lines a few dozen lines later).
   Verified: `tests/fixtures/constructs/23-generator-basic/v98.hbc` function
   index 1 (`Generator function #1 "sequence"`) and
   `tests/fixtures/constructs/27-async-await-basic/v99.hbc` function index 2
   (`Async function #2 "sequence"`). `HD_FUNC_RE` now accepts both.
6. **The `<Type: value>` operand list keeps its own outer angle brackets** in
   `hbc-disassembler`'s raw line (`<DeclareGlobalVar>: <string_id: 17>`, not
   `<DeclareGlobalVar>: string_id: 17`) — an early draft of the operand
   splitter didn't strip that outer pair before splitting on `Type: value`,
   producing a stray `<`/`>` welded onto the first/last field (e.g.
   `17><<string_id>` instead of `17<string_id>`). Fixed in
   `normaliseHermesDec`.
7. **`Double` renders with Python's `repr(float)` convention** (a decimal
   point always present, e.g. `9007199254740992.0`), not JS's default
   `String(value)` (`9007199254740992`, no point for a whole number).
   Verified: `constructs/46-bigint-arithmetic` v94's
   `LoadConstDouble 5<Reg8>, 9007199254740992.0<Double>`. `ourInstructionLine`
   now special-cases `Double` to match (append `.0` when JS's own string form
   has neither `.` nor `e`) — this is `normalize.ts`-only; `src/disasm/print.ts`'s
   `canonical` mode correctly keeps plain `String(value)` per spec 02 §6.2,
   and `raw` mode keeps hermesc's own `%e` convention (see item 3's sibling
   note above) — three oracles, three legitimately different float
   conventions for the same underlying value.
8. **A zero-operand instruction's operand list is `<>`, not absent** (e.g.
   `<StartGenerator>: <>`), which normalises to a lone trailing space after
   the mnemonic (`"0 StartGenerator "`) rather than nothing. `ourInstructionLine`
   now always emits that trailing space + (possibly empty) operand text to
   match, instead of conditionally omitting it.
9. **`hbc-disassembler` (hermes-dec) has the same v98/`hbc98-late` large-header
   flags bug this project's own parser had (see item 4 above, now fixed) —
   its `FUNC` line's `strict`/`exc`/`dbg` fields are read from the wrong byte
   for essentially every overflowed v98 function.** Evidence:
   `constructs/01-if-else-chain/v98.hbc` `global` (real `hermesc
   -dump-bytecode`: has both a handler and debug info) — ours: `FUNC 0 124 1
   20 0 1 1 332`; hermes-dec: `FUNC 0 124 1 20 0 0 0 332` (`exc dbg` wrong).
   `constructs/02-while-loop/v98.hbc`'s function 0 (debug info only, no
   handler) shows the same one-field pattern (`dbg`: ours `1`, hermes-dec
   `0`). **`strict` is affected too, not just `exc`/`dbg`** (all three bits
   live in the one misread byte): `constructs/32-class-basic/v98.hbc`
   function `Point` — a class constructor, necessarily strict — decodes
   `strict=1` on our side; hermes-dec prints `strict=0`. A second, distinct
   consequence of the same wrong byte: when hermes-dec's own (wrong) `exc`
   bit reads `0` for a function that genuinely has a handler, it doesn't
   print an `[Exception handlers: ...]` line for that function *at all*
   (verified: `hbc-disassembler` on `01-if-else-chain/v98.hbc` prints "exc
   handler=0" for `global` and no handler block, while the real bytecode has
   one covering bytes 60..85) — so naively comparing line-by-line
   desynchronises every line after the first affected function, which is why
   this looked like ~52/53 fixtures failing outright rather than one
   understood field-level divergence. Before this project's v98 flags bug was
   fixed, our decoder's flags were *also* wrong in a way that happened to
   agree with hermes-dec's wrongness, so this test passed by coincidence;
   fixing our decoder (item 4) correctly diverges from hermes-dec here rather
   than reintroducing our own bug to match it.

   **Now enforced, narrowly** (`tests/gate/oracle/disasm/hermes-dec.test.ts`'s
   `applyV98Allowlist`/`maskV98FuncExcDbg`, v98 only): split both sides into
   one block per function; when hermes-dec's own `FUNC` line for a function
   claims `exc=0`, drop our `EH ...` lines for that same function before
   comparing (the direct, understood consequence above — not a blanket
   "ignore all EH lines" rule); then mask only the `strict`/`exc`/`dbg` fields
   (indices 5/6/7) of every `FUNC` line on both sides. Every other field in
   that line, every `EH` line that survives the drop, and every instruction
   line in the file are still compared verbatim — a real future regression in
   *our* v98 `strict`/`exc`/`dbg`/handler decoding still fails everywhere else
   in the same function's output. Affects every gate-tier v98 construct
   fixture whose overflowed functions have `hasExceptionHandler` and/or
   `hasDebugInfo` and/or `strictMode` true (the common case — see item 4's
   "almost every real v98 function is overflowed"). This is spec 02 §7.B's
   allowlist, 5th entry (the spec text still says "at most the four entries
   in §7.B" — that acceptance-criteria wording needs the architect's update,
   not made here since it's outside this pass's authorized doc-edit scope).
