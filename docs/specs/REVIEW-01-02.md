# Adversarial review — specs 00 (project skeleton), 01 (parser), 02 (disassembler)

**Reviewer:** Sonnet, step 1b of `docs/AGENT-WORKFLOW.md`. Research/review only — no
source touched, no spec edited, `tools/equiv/` and `tests/fixtures/` untouched.

**Method.** Read the three specs against `docs/HBC-FORMAT.md`, `docs/DECISIONS.md`,
`docs/PRIOR-ART.md` and `tests/fixtures/README.md`. Recomputed byte-level claims
directly from the fixture binaries with `python3`/`struct` (not trusted from the
spec text). Actually ran both oracles (`tools/hermesc/v94/hermesc -dump-bytecode`,
`tools/hermesc/v99/hermesc -dump-bytecode`, `hbc-disassembler` 0.1.7) on
`hermes-dec-sample` and diffed their real output against spec 02 §7's normaliser
specs. Built a real 3-file TS project in scratch space mirroring spec 00 §4's
`tsconfig.json` and ran it under the installed Node (v25.9.0) and `tsc` 5.x.
Cloned `facebook/hermes` (partial clone, `--filter=blob:none`) to resolve spec 01
O-1's two TBD commit SHAs mechanically, per spec 01 §5.3's own procedure.

**Note on repo state.** `git status` shows uncommitted work from a concurrent agent
(`tools/equiv/`, `docs/EQUIVALENCE.md`, two new fixtures
`tests/fixtures/constructs/52-switch-jumptable/` and `53-switch-jumptable-large/`).
Per the specs' own "concurrency notice" this is expected; one finding below (B3)
is specifically about specs 01/02 being stale against this already-changed fixture
corpus.

**Counts:** 3 blocker, 6 should-fix, 5 nit.

---

## Blockers

### B1 — Spec 02 §7.A's hermesc normaliser regex does not match real `hermesc -dump-bytecode` output; the oracle test as specced fails on the very first fixture

**Section:** 02 §7.A, "Normaliser N-hermesc", regex
`^Function<(?<name>[^>]*)>\((?<p>\d+) params, (?<r>\d+) registers, (?<s>\d+) symbols\):$`

**Evidence.** Ran `tools/hermesc/v94/hermesc -emit-binary` + `-dump-bytecode
-pretty-disassemble=false` on `tests/fixtures/hermes-dec-sample/source.js` (byte-identical
to `v94.hbc`, confirmed via `cmp`). The real function-header lines are:

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

3 of the 8 functions (`testx`, `?anon_0_testx`, `gen` — exactly the three whose
`FunctionFlags.prohibitInvoke === "construct"`, i.e. small-header `flags` bit 0-1 = 1)
are printed as `NCFunction<...>`, not `Function<...>`. The spec's regex anchors on
`^Function<`, so it silently drops these three lines. Spec 02 §7.A explicitly says
*"Assert the counts match before comparing, so an ordering bug reports as a count
mismatch rather than 400 line diffs"* — with the regex as written, that assertion
fires immediately (5 matched vs. 8 real functions) on the canonical, byte-identical
v94 fixture, before a single instruction is compared.

It gets worse for v99 (class E). Ran `tools/hermesc/v99/hermesc -dump-bytecode` on
the same source (used per spec's own instructions for the v99-public comparison,
since raw v99.hbc isn't byte-reproducible — `docs/TOOLCHAIN.md`):

```
Function<global>(1 params, 18 registers, 1 numbers, 1 non-pointers):
NCFunction<testx>(2 params, 16 registers, 0 numbers, 1 non-pointers):
NCFunction<gen>(1 params, 2 registers, 1 numbers, 0 non-pointers):
Function<ze>(1 params, 13 registers, 0 numbers, 1 non-pointers):
NCFunction<?anon_0_testx>(2 params, 3 registers, 1 numbers, 0 non-pointers):
Function<gen>(1 params, 32 registers, 0 numbers, 0 non-pointers):
Function<zb>(1 params, 11 registers, 0 numbers, 1 non-pointers):
Function<?anon_0_testx>(2 params, 20 registers, 0 numbers, 0 non-pointers):
```

For class E, hermesc doesn't print `"N symbols"` at all — it prints `"N registers,
N numbers, N non-pointers"` (`numberRegCount`/`nonPtrRegCount`). The spec's regex
literally cannot match **any** of these 8 lines (no capture group named `s` can
bind to `"1 numbers, 1 non-pointers"`). Spec 02 §6.1's own worked example
("`K symbols` is `environmentSize` for v≤96 and `0` for v≥97") is also wrong for
class E — the field isn't `0 symbols`, the word "symbols" doesn't appear in the
real output at all for v99.

**Impact.** As written, T-level acceptance criterion "hermesc diff (7.A) is empty
for every fixture where the .hbc reproduces byte-identically, at v84, v94 and v99"
(§9) cannot pass for *any* fixture with a `prohibitInvoke: construct` function
(functions passed only as arguments / never `new`'d — routine in real code) or any
class-E file. An implementer following the spec literally will spend real time
debugging what looks like a decoder bug in their own code before discovering the
oracle's own output shape isn't what the spec described.

**Fix.** Change the header regex to something like:
```
^N?C?Function<(?<name>[^>]*)>\((?<p>\d+) params, (?<r>\d+) registers, (?:(?<s>\d+) symbols|(?<nr>\d+) numbers, (?<npr>\d+) non-pointers)\):$
```
and normalise the `NC`/`C` prefix away (or, better, cross-check it against our own
`FunctionFlags.prohibitInvoke === "construct"` as an extra assertion — it's free
ground truth for that flag). Update §6.1's prose describing the v≥97 header line
shape; it is not "0 symbols", it is a different field pair entirely.

---

### B2 — Spec 01 §5.4's `BytecodeList.def` parsing rules don't exclude the file's own macro-definition preamble; a literal implementation double(-ish)-counts opcodes

**Section:** 01 §5.4 rules 1–4, 01 §5.5 (table self-verification)

**Evidence.** Cloned `facebook/hermes` for real and checked out the commit that
introduces `BYTECODE_VERSION = 94` (`1c717488`, found below in B/O-1). The real
`include/hermes/BCGen/HBC/BytecodeList.def` opens with:

```c
#define DEFINE_OPCODE_0(name) DEFINE_OPCODE(name)
// Define default versions of all macros used.
#ifndef DEFINE_OPERAND_TYPE
#define DEFINE_OPERAND_TYPE(...)
#endif
#ifndef DEFINE_OPCODE_0
#define DEFINE_OPCODE_0(name) DEFINE_OPCODE(name)
#endif
#ifndef DEFINE_OPCODE_1
#define DEFINE_OPCODE_1(name, ...) DEFINE_OPCODE(name)
#endif
... (through DEFINE_OPCODE_6) ...
```

and, later, the `DEFINE_JUMP_n` macro's own body is itself written using the exact
same call shape as a real opcode declaration:

```c
#define DEFINE_JUMP_1(name)               \
  DEFINE_OPCODE_1(name, Addr8)        \
  DEFINE_OPCODE_1(name##Long, Addr32) \
```

A parser built exactly to spec 01 §5.4's rules — "strip comments... process line
by line... `DEFINE_OPCODE_<n>(<Name>, ...)` appends **one** opcode" — with no
additional rule to skip preprocessor lines will match the `#define
DEFINE_OPCODE_N(name) ...` fallback-definitions *and* the `DEFINE_JUMP_n` macro
body's internal `DEFINE_OPCODE_1(name, Addr8)`/`DEFINE_OPCODE_1(name##Long,
Addr32)` lines, because after comment-stripping they are syntactically
indistinguishable from real invocations. Verified empirically: a straightforward
`re.match(r'^DEFINE_OPCODE_(\d+)\(([A-Za-z0-9_]+)', line.strip())` over the real
v94-era file produces **198** matched opcodes (6 of them the literal name `"name"`,
colliding into a single duplicate-name bucket) instead of the correct **192**
(confirmed independently by counting only lines that are not preprocessor
directives: 142 `DEFINE_OPCODE_*` + 25 `DEFINE_JUMP_*`×2 = 192, matching spec 01
§5.5's asserted `hbc94` length exactly). The v84-era file (`19216441`) has the same
preamble shape and the same trap.

**Why this is a blocker, not a nit.** Opcode numbers are positional (§11.2); the
spec itself calls this out as catastrophic under R1 ("adding one opcode anywhere
renumbers everything after it... a table must be generated per bytecode version").
§5.5's assertions (`opcodes[0].name === "Unreachable"`, "names unique", the named
spot-checks) happen to catch *this specific* instance because the spurious lines
collide on the literal string `"name"` — but that's luck, not design: a
differently-shaped macro preamble (or a future Hermes commit that renames the
placeholder parameter from `name` to something unique per arity, e.g. `name0`,
`name1`) would produce a *silent, uncaught* wrong count and wrong positional
numbering, which is exactly the failure mode D8/R1 exist to prevent.

**Fix.** Add an explicit rule to §5.4: skip any line whose first non-whitespace
character is `#` (all preprocessor directives — `#define`, `#ifndef`, `#endif`,
`#if`, `#else`), and/or don't start scanning for opcode-defining macros until past
the last `#endif` of the default-macro-definition block. Add a second, independent
self-check to §5.5 beyond "names unique": assert the total opcode count equals
`(count of real DEFINE_OPCODE_* invocations) + 2×(count of real DEFINE_JUMP_*
invocations)` computed by two independent methods (e.g. one that tracks
`#ifdef`/`#endif` nesting depth and rejects anything not at depth 0 outside a
`#define`), so a future placeholder-name collision doesn't silently pass.

---

### B3 — Specs 01/02 are already stale against the fixture corpus: the "no switch fixture" gap they both flag is closed, but the specs (and their open questions) don't know it

**Sections:** 02 §4.3, 02 O-1, 02 §9 acceptance bullet, 01 T10, 01 O-5

**Evidence.** `tests/fixtures/constructs/` currently has **53** directories, not the
51 that `tests/fixtures/README.md` and spec 01/02 describe throughout (`ls
tests/fixtures/constructs | wc -l` → 53). The two extra directories are
`52-switch-jumptable/` and `53-switch-jumptable-large/` (uncommitted, added by a
concurrently-running agent — see the repo-state note above), and they are not
placeholders: both compile at v84/v94/v99 and both **genuinely exercise the jump
table**. Confirmed directly:

```
$ hermesc -dump-bytecode -pretty-disassemble=false 52-switch-jumptable/source.js  # v94
[@ 7] SwitchImm 0<Reg8>, 253<UInt32>, 223<Addr32>, 0<UInt32>, 12<UInt32>
$ hermesc -dump-bytecode -pretty-disassemble=false 52-switch-jumptable/source.js  # v99
[@ 7] UIntSwitchImm 0<Reg8>, 253<UInt32>, 223<Addr32>, 0<UInt32>, 12<UInt32>
```
(`53-switch-jumptable-large` likewise, with a 39-entry table.)

This directly contradicts:
* 02 §4.3: *"No fixture in the corpus contains any switch instruction... Everything
  in §4 is therefore written blind (risk R5)."* — no longer true.
* 02 O-1: *"I would like the fixtures agent to add `52-switch-dense-int`..."* —
  already added (under a slightly different name), so answering this open question
  as posed wastes an implementer's time filing a request for something that exists.
* 02 §9's acceptance bullet: *"either a fixture exercises `UIntSwitchImm`/`SwitchImm`
  ... or the skip message names §4.3 and the overseer waiver is recorded"* — the
  waiver branch should no longer be an option; this should become a hard
  requirement now that ground truth exists.
* 01 T10's row `SwitchImm/... jump table | none — gap` and 01 O-5 — same issue.

**What's still actually true:** neither new fixture exercises `StringSwitchImm`
(switch over string literals) — 53 is a *larger integer* switch (0..39), not a
string switch. So O-1's second half (a `53-switch-string` fixture) is genuinely
still open; only the integer-switch half of the gap is closed. An implementer
reading spec 02 today would not know this distinction.

**Fix.** Before handing 01/02 to an implementation agent, re-run
`tests/fixtures/README.md`'s own count check and re-scan for what fixtures
actually exist (the specs' own "concurrency notice" already warns that
`tests/fixtures/**` is being authored by another agent in parallel — this is that
warning materialising). Update §4.3/O-1/T10/O-5 to (a) drop the now-satisfied
integer-switch request, (b) keep the `StringSwitchImm` request open and precise,
and (c) make switch-table coverage a hard acceptance requirement, not an
either/or with a waiver.

---

## Should-fix

### S1 — Layout/opcode-table probe (§6.4) samples, doesn't exhaustively verify, on large files — a wrong table can be chosen without ever producing `E_LAYOUT_AMBIGUOUS`

**Section:** 01 §6.4 step 1 ("Pick the probe set... for larger files add 32 more
chosen by a deterministic stride")

For a file ≥ 2 MB, P3 only decodes ≤ ~64 sampled functions per candidate table
before committing to a choice. The whole point of D8/R1 is "refuse to parse rather
than guess" — but a candidate table that happens to decode all *sampled* functions
plausibly (passes every check in §6.4 step 2) while being subtly wrong on an
unsampled function will be chosen silently; the failure only surfaces later, as an
opaque decode error deep in M2's `decodeModule`, not as the loud, actionable
`E_LAYOUT_AMBIGUOUS`/`E_LAYOUT_NO_CANDIDATE` the design intends. Given the actual
219-vs-220 case is described as failing "on the first few instructions" this is
low-probability for that *specific* hazard, but the spec frames P3 as the general
mechanism for future opcode-table ambiguities too, where a shift might be much
deeper in the opcode space.

**Fix.** State explicitly that the probe's table choice is provisional evidence,
not proof, for large files; have `decodeModule` (spec 02) tag any
`E_UNKNOWN_OPCODE`/`E_OPERAND_OVERRUN` that occurs on a function that was *not*
part of the original probe sample with a hint pointing back at the layout probe
(e.g. "this may indicate the wrong opcode table was chosen; only N of M functions
were probed"), so the failure mode stays diagnosable rather than looking like a
random decoder bug.

### S2 — `tsc` does not preserve/set the executable bit on `dist/cli.js`

**Section:** 00 §3 (`bin` field), §10 acceptance criteria

Verified directly: `npx tsc -p tsconfig.build.json` (mirroring spec 00's exact
`tsconfig.build.json`) emits `dist/cli.js` — shebang intact — as `-rw-r--r--`.
`./dist/cli.js` fails with `permission denied` (exit 126) until manually
`chmod +x`'d; `npm install`/`npm link` normally fixes this via `bin` handling, and
spec 00's own acceptance criterion wisely uses `node dist/cli.js --help` (which
sidesteps the issue). But nothing in spec 00 documents this, and a future test or
doc that assumes `./dist/cli.js` is directly runnable right after `npm run build`
(no intervening `npm link`/`pack`) will fail identically on macOS and Linux.

**Fix.** Either add `chmod +x dist/cli.js` as a step in the `build` script, or add
one sentence to §3/§10 noting direct execution requires the npm bin-linking step.

### S3 — Node-floor claim (`>=22.18.0`) not verified against that exact version in this environment

**Section:** 00 §1, §12 O-1

Everything spec 00 claims about the toolchain — `erasableSyntaxOnly` making `tsc`
and Node's type-stripping fail identically on `enum` (confirmed: both reject it,
`tsc` with `TS1294`, Node with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`),
`rewriteRelativeImportExtensions` rewriting `.ts`→`.js` on build (confirmed:
`import { add } from "./util/reader.ts"` became `.js` in `dist/`), `node --test`
accepting glob-string args over `.ts` files (confirmed) — was verified and works
correctly, but only against the Node available in this sandbox (v25.9.0). No
22.18.0 binary was reachable here (no nvm/n/fnm/volta installed) to confirm the
stated floor itself. This is already flagged as O-1 in the spec; recommend closing
it by actually running the CI matrix's `22.18` leg once CI exists, rather than
inferring from a later version.

### S4 — Debug-info divergence note in HBC-FORMAT §4 / spec 01 T3 slightly overstates itself as v99-specific

**Section:** 01 §3.7/T3, `docs/HBC-FORMAT.md` §4

The doc says hermes-dec's 2-field `[Debug offsets: ...]` print is a v99 misparse
(reading 4 bytes past the true 4-byte v99 struct). Verified: `hbc-disassembler`
also prints exactly 2 fields (`source_locs`, `scope_desc_data`) for the **v94**
fixture, e.g. `[Debug offsets: source_locs=0x0, scope_desc_data=0x0]` for function
0 — but v94's real `DebugOffsets` struct has **3** fields
(`sourceLocations`,`scopeDescData`,`textifiedCallees`); hermes-dec simply never
prints `textifiedCallees` at all, for any version. Functionally harmless (spec
02's normaliser drops the whole `[Debug offsets: ...]` line unconditionally
regardless of version), but the stated *reason* is incomplete and could mislead
someone auditing hermes-dec's behaviour across versions later.

**Fix.** Rephrase to "hermes-dec's debug-offsets print never includes
`textifiedCallees` (v84-96) and additionally reads 4 bytes past the end of the
struct for v99" — two separate, both-true observations, not one.

### S5 — Licence-guard regex (`_fun[0-9]*_ip`) is a plausible false-positive against hbc2js's own D6/D7 debug escape hatch

**Section:** 00 §8 (licence-guard job), forward reference to D6/D7's
`for(;;) switch(ip)` tier-(-1) fallback (M4, out of this review's direct scope but
the CI gate spec 00 defines here will apply to it)

hermes-dec's decompiler names its dispatch variable `_fun5_ip` (see
`docs/PRIOR-ART.md` §1.1's quoted example) precisely because that's the natural
name for "function 5's instruction pointer" — which is exactly the concept
hbc2js's own retained-as-a-debug-escape-hatch `for(;;) switch(ip)` fallback (D6/D7)
will need to name too. If that M4 code independently converges on a
similarly-shaped identifier, spec 00's own licence-guard CI job will fail on
legitimately original code. Not a defect in 00/01/02 today (the fallback is M4),
but worth flagging now since spec 00 is what defines the CI gate.

**Fix.** Note in spec 00 §8 (or forward to the M4 spec) that the debug fallback's
variable naming must deliberately avoid the `_funN_ip` shape (e.g. `__ip`,
`_pc`, `dispatchPc`) specifically to keep the licence guard meaningful rather than
requiring an allowlist entry that weakens it.

### S6 — No explicit "shorter than the 128-byte header" invariant

**Section:** 01 §7.1 (invariants table)

INV-01 (magic) and INV-02 (`fileLength ≤ bytes.length`) are the first checks, but
reading `header.fileLength` itself requires bytes 32..36 to exist. A file shorter
than ~36 bytes (or even shorter than 8, for the magic) will hit the generic
`BinaryReader.require()` bounds check (§7.2) before any header invariant can even
be evaluated, producing whatever generic `E_SECTION_OVERRUN`-shaped error the
reader throws rather than a clean, specific `E_TRUNCATED`. T8's fuzz suite
("truncations at random lengths") will exercise this path but only asserts the
result `instanceof Hbc2jsError` — it does not pin down *which* code a
sub-header-length file should produce, so this inconsistency (a good short file
gets `E_TRUNCATED`, a garbage-short file gets a different code for the same root
cause) could ship unnoticed.

**Fix.** Add an explicit INV-0: `bytes.length ≥ 128` → `E_TRUNCATED`, checked
before any field is read, so every "not even a full header" input produces the
same, specific, documented error code.

---

## Nits

### N1 — `tests/fixtures/README.md`'s "51 total" is already off by 2 (input inconsistency, not this review's to fix)

Already covered as evidence for B3; noted separately here because it's a
`tests/fixtures/README.md` claim, not a spec 00/01/02 claim, and that file is
owned by another agent. Worth relaying so whoever reconciles fixtures updates the
table (and the `~141`/`~147` binary counts in spec 01 §7.1/§9, which will drift
again once 52/53 land with 3 `.hbc` files each).

### N2 — `grep -rn ": any\b\|as any" src/` (00 §10) has no comment/string exclusion

A source comment saying `// never write "as any" here` would trip this check.
Low risk in a small codebase with named-export-only, no-`any` conventions, but a
`git grep -w` or a tiny AST-based check would be more robust if it ever
false-positives.

### N3 — Spec 02's canonical-mode example (`§6.2`) renders `s12` with an ellipsis mid-string (`"dkooDD JPOD D09D\n\\  @ .…"`) without specifying the exact truncation point relative to `maxStringPreview: 32`

Minor: the worked example is illustrative, but since golden snapshots are
byte-exact and this string is a *real* fixture string (verified directly: id 12 in
`v94.hbc`, 43 characters, containing a literal NUL and `\r\n\t`), an implementer
copying the example literally could produce an off-by-one truncation boundary
that differs from whatever `printFunction` actually computes. Worth either
generating this example from real code once §6.2 exists, or stating the
truncation rule precisely (e.g. "first `maxStringPreview` *escaped output*
characters, not source characters").

### N4 — Spec 01 §6.1's version→layout table doesn't mention what happens for `version` between 97 and the "≥ 51 and < 84" boundary if `< 51`

Already handled (`E_UNSUPPORTED_VERSION`), just noting the table's row for "< 51"
correctly short-circuits before layout classes are even considered — verified
this is consistent with class A starting at 51 per `docs/HBC-FORMAT.md` §0.1. No
action needed; recorded because it was checked and found correct, not to pad the
list.

### N5 — `docs/PRIOR-ART.md`'s per-commit narrative for v87-96 isn't reproducible via GitHub's REST "commits by path" API

Not a defect in specs 00-02 (spec 01 §5.3 already prescribes a local
`git clone` + `git log -S`, which is the *correct* method and is what resolved
O-1 below) — recorded as a caution for whoever next tries to audit this history:
`GET /repos/facebook/hermes/commits?path=...` returned only 10 of the 17 real
commits touching `include/hermes/BCGen/HBC/BytecodeVersion.h` (confirmed via a
real `--filter=blob:none` clone and `git log --follow`), silently omitting the
exact block-scoping revert/re-land commits that define v92/93/94. A local clone
is not just "more hermetic" as §5.1 already argues — for this specific file it is
also the only *correct* method; the GitHub web API is unreliable for this task.

---

## Verified claims (recomputed from bytes, not trusted from spec text)

Per the task's instruction, recomputed byte-exact values directly from
`tests/fixtures/hermes-dec-sample/{v84,v94,v99,v99-public}.hbc` with
`python3`/`struct`, independent of `docs/HBC-FORMAT.md`'s own worked examples.
**Zero mismatches found** across all of the following (far more than the
requested 10):

* Magic (`c6 1f bc 03 c1 03 19 1f` LE → `0x1F1903C103BC1FC6`), version, fileLength
  for all 4 files.
* Full header field set (functionCount, stringKindCount, identifierCount,
  stringCount, overflowStringCount, stringStorageSize, bigIntCount/StorageSize,
  regExpCount/StorageSize, literalValueBufferSize/objKeyBufferSize/
  objValueBufferSize or objShapeTableCount, numStringSwitchImms, segmentID,
  cjsModuleCount, functionSourceCount, debugInfoOffset, options) for v84 (class
  B), v94 (class C), v99 & v99-public (class E) — all match HBC-FORMAT.md §2.1
  and spec 01 T1 exactly.
* Full section-offset walk for v94 (functionHeaders 0x80, stringKinds 0x100,
  identifierHashes 0x108, smallStringTable 0x14c, stringStorage 0x1d4,
  regExpTable 0x2c4, regExpStorage 0x2cc, functionSourceTable 0x310,
  firstFunctionBodyOffset 0x320) and for v99 (0x80, 0xe0, 0xe8, 0x134, 0x1c0,
  literalValueBuffer 0x2e0, objKeyBuffer 0x2ec, objShapeTable 0x2f4, regExpTable
  0x2fc, regExpStorage 0x304, functionSourceTable 0x348, firstFunctionBodyOffset
  0x358) — bit-for-bit from a from-scratch reimplementation of the §4 walk
  algorithm, not copied from the doc.
* All 8 rows of v94's `SmallFuncHeader` table (offset/params/size/nameID/
  infoOffset/frame/env/flags) — exact match to HBC-FORMAT.md §3.4 / spec 01 T2.
* v99's class-E small headers: overflow flag + `getLargeHeaderOffset()` for the 6
  overflowed functions (info offsets 0x89c/0x8c4/0x8ec/0x914/0x97c/0x9a4) and the
  full bitfield decode of the 2 non-overflowed generator stubs (fn2, fn4) —
  exact match.
* v99 function 0's 36-byte large `FunctionHeader` at 0x89c and function 5's
  (5-handler) exception table + 4-byte `DebugOffsets` at 0x914 — exact match,
  including the "next info block starts exactly here" chaining check.
* v94's exception-handler table for function 5 (3 handlers) via direct decode of
  `hermesc -dump-bytecode`'s own `Exception Handlers:` block, cross-checked
  against the binary's raw bytes independently — exact match both ways.
* String-kind RLE expansion for v94 (String×17, Identifier×17) and v99
  (String×16, Identifier×19); decoded string entries 7 (`"global"`), 12 (the
  regexp pattern, including its embedded NUL and `\r\n\t`), 13 (`"gmi"`), 16
  (UTF-16, containing U+202F) — exact match.
* First ~15 opcode bytes of v94 function 0 and v99 function 0, decoded against
  the opcode numbers HBC-FORMAT.md §11.2 claims (`0x34`=52=`DeclareGlobalVar` for
  v94; `0x40`=64=`CreateFunctionEnvironment`, `0x43`=67=`DeclareGlobalVar`,
  `0x3d`=61=`GetGlobalObject`, `0x84`=132=`CreateClosure`, `0x4a`=74=
  `PutByIdLoose` for v99) — exact match.
* Spec 01 T7's specific claim that misreading `v84.hbc` under class-C field
  offsets yields `cjsModuleCount = 1568` (which P1's `count*stride ≤ fileLength`
  guard then rejects, since `1568*8 = 12544 > 1898`) — reproduced exactly.
* Independently re-derived, from the real vendored `BytecodeList.def` at the
  resolved `hbc84`/`hbc94` commits (see below), the full opcode numbering and
  confirmed every one of spec 01 §5.5's named spot-checks
  (`DeclareGlobalVar`=52, `GetGlobalObject`=48, `CreateEnvironment`=50,
  `PutById`=59, `CreateAsyncClosure`=104, `Ret`=92, `Catch`=93, `CreateRegExp`=132,
  `SwitchImm`=133 for hbc94; `Unreachable`=0 and total length 185 for hbc84; total
  length 192 for hbc94) by mechanically parsing the real file — not by trusting
  the doc's assertion of what the count should be.

Where actual mismatches were found, they were not in these byte-level claims —
they were in **how the specs describe oracle behaviour and generator-tooling
robustness** (B1, B2) and in **spec-vs-fixture-corpus staleness** (B3). The
HBC-FORMAT.md byte-level research holds up completely under adversarial
re-derivation.

---

## Resolution of spec 01 O-1 (the two TBD Hermes commit SHAs)

Per spec 01 §5.3's own procedure, executed against a real `--filter=blob:none`
clone of `facebook/hermes` (network was available):

* **`hbc94` → commit `1c717488`** ("Add bytecode support for block scoping",
  2023-03-08). `git log -S'BYTECODE_VERSION = 94' --
  include/hermes/BCGen/HBC/BytecodeVersion.h` returns exactly two hits
  (`1c717488` introducing it, `f6b56d33` on 2023-03-28 bumping to 95); content at
  `1c717488` confirmed `BYTECODE_VERSION = 94`. This is also the "re-land" commit
  PRIOR-ART.md §3.2 describes ("94 ≡ v92 opcode-wise" after 92→93 revert→94
  re-land — confirmed: `b544ff4a`=92, `760d8659`=93 (revert), `1c717488`=94
  (re-land)). Verified 192 opcodes and every named §5.5 spot-check by direct
  positional parse of the real file at this commit (see "Verified claims" above).
* **`hbc84` → any commit in the window `(19216441, b74eb2d5)`**, i.e. after
  "un-bump the bytecode version bump for Wasm intrinsics" (2021-07-27) and before
  "Add Inc/Dec instructions" bumps to 85 (2022-03-22). The last commit touching
  `BytecodeVersion.h` in that window is `c2cd9e38` ("Update copyright headers from
  Facebook to Meta", 2021-12-30, copyright-only — doesn't touch
  `BytecodeList.def`, so the opcode table is identical to `19216441`'s). Per
  §5.3's own preference ("the last such commit is preferable — it is what a
  late-in-life v84 compiler shipped"), record `c2cd9e38` as the pin. Verified 185
  opcodes and `Unreachable`=0 by direct positional parse of `19216441`'s
  `BytecodeList.def` (identical content to `c2cd9e38`'s, since no opcode-affecting
  commits fall in between).

Recommend the architect drop O-1 from spec 01 and record these two SHAs (plus
sha256 of the vendored files, per §5.1) in `PROVENANCE.md` once table generation
exists.
