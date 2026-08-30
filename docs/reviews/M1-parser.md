# Review: M1 parser (spec 00 + spec 01)

**Reviewer:** Claude Sonnet 5 (adversarial review, step 3 per `docs/AGENT-WORKFLOW.md`)
**Range reviewed:** `8b98877..82f9d68` (`git diff 644652c..82f9d68`)
**Scope:** review only — `src/**` not modified by this review.

## Verdict: **FIX-THEN-MERGE**

This is careful, well-tested work: `npm run typecheck`/`build`/`gen:tables:check`
all pass cleanly, all 81 gate + 4 sweep tests pass, no `any` in `src/`, no
hermes-dec contamination, and every byte-level field I independently
re-derived from raw bytes (10+ fields across v84/v94/v96/v98/v99, §2 below)
matched the parser's output exactly. The three headline deviations in
`docs/STATUS.md` are reasonable engineering calls, honestly disclosed, and
mostly don't need reversing.

The reason this isn't a clean MERGE: I found and *demonstrated* (not just
theorized) a real gap in the one piece of code whose entire job is to prevent
silent misdecode (D8's P3 opcode-table probe), plus an unverified-guess
opcode sitting at a low, commonly-hit opcode number, plus a couple of
spec-compliance nits (missing error offsets, an undisclosed 4th/5th
deviation). None of these are active bugs against the current corpus — I
checked — but M2's disassembler is about to build directly on these tables,
and the fixes are cheap. See Finding 1 and 2 for why I weight this as
FIX-THEN-MERGE rather than MERGE-with-followups.

---

## 1. Spec conformance — `docs/specs/01-parser.md` §9 checklist

| # | Criterion (abridged) | Verdict | Evidence |
|---|---|---|---|
| 1 | 201 gate binaries parse, zero throws, only T10-listed warn diagnostics | **Met** | `npm run test:gate` (`HBC2JS_REQUIRE_ORACLES=1`): 81/81 pass, incl. "every gate-tier binary parses without throwing, with only allowed diagnostics". `ALLOWED_DIAGNOSTIC_CODES` in `tests/gate/parse/module.test.ts` = `{W_OPCODE_TABLE_TIEBREAK}` only. |
| 2 | All 4 `bundles/rn-template-0.72/*.hbc` parse (sweep), incl. overflow strings/headers/shared bodies | **Met** | `npm run test:sweep`: 4/4 pass, incl. T10 overflow/dedup assertions; 1 local-corpus test correctly INCONCLUSIVE (no `.hbc` under `tests/fixtures/local-corpus`). |
| 3 | T1–T4 byte-exact, hardcoded | **Met** | Tests present and passing; independently re-verified 10+ fields myself from raw bytes (§2). |
| 4 | `probe.chosen` matches for canonical fixtures | **Met** | Test passes; `--info --json` output cross-checked manually for v96/v98. |
| 5 | Wrong layout/table forcing always throws | **Met** | Gate test + my own adversarial script (§3): version-swapped v98/v99 files, forced-wrong-table cases all throw or self-correct via structural probing — never a silent wrong parse. |
| 6 | `probe.exhaustive === true` for every fixture **and every bundle < 4 MB** | **Partial** | True for all gate fixtures (tested). **Not asserted for bundles** — `tests/sweep/parse/bundles.test.ts` never reads `probe.exhaustive`, even though all four bundles are ≤2.7 MB and the criterion explicitly calls this out. Cheap one-line gap (Finding 6). |
| 7 | `gen:tables:check` reproducible | **Met** | Ran directly: "all 15 generated files match". |
| 8 | `.def` parser rejects macro placeholders, correct counts, survives renamed placeholder | **Met** | Tests present and passing (incl. the `name0` renamed-placeholder case spec 01 §9 specifically demands). |
| 9 | §5.5 assertions pass; corrupting a name fails a test | **Met** | Assertions verified passing (`verifyTables()` ran clean for all 7 tables). The "corrupt then revert" is phrased as a one-off manual check in the spec, not a standing test — I did it myself against `registry.ts`'s logic by inspection; the fail path (`fail()`) is exercised structurally by the assertion helpers themselves. |
| 10 | `LICENSE` + `PROVENANCE.md` w/ SHAs | **Met** | All 7 `third_party/hermes/<id>/` dirs have MIT `LICENSE` + `VENDOR.yml` with commit + per-file sha256; `PROVENANCE.md` generated and matches. |
| 11 | `git grep hermes[-_]dec -- src/` empty | **Met** | Ran it: only hits are the fixture directory name `hermes-dec-sample` and comments saying "not derived from hermes-dec" — none cite it as a source. |
| 12 | T6 oracle cross-check, ≤3-entry allowlist | **Met, with a nit** | `hbc-file-parser` cross-check test passes on all 6 canonical fixtures. The allowlist is an inline code comment in `tests/gate/oracle/hbc-file-parser.test.ts`, not the spec-named `tests/gate/oracle/known-divergences.md` file (Finding 3). |
| 13 | T8 fuzz: 2000 mutants/binary | **Deviation, undisclosed to STATUS.md** | Actual: ~200 mutants/binary (~50k total across 249 binaries), explicitly commented as a deliberate scale-down from the spec's 2000/binary to fit the 30s budget. Reasonable call, but not mentioned in `docs/STATUS.md`'s M1 section (Finding 3). Zero non-`Hbc2jsError` escapes either way (verified). |
| 14 | Golden snapshots stable | **Met** | Test passes; `git status --porcelain tests/golden` is clean after a run. |
| 15 | `--info` prints correctly, exit 0 | **Met** | Ran `dist/cli.js --info <file> --json` and the plain-text form manually; both correct. Found a minor argument-order footgun (Finding 7), not spec-mandated behavior either way. |
| 16 | Peak RSS < 3× on the 2.7 MB fixture, recorded in STATUS.md | **Met for the in-repo fixture; gap at real scale** | STATUS.md records ~4–9ms/2.62MB, well inside budget. I additionally measured a real 50.8 MB production bundle (Finding 5) and found ~4.5× RSS overhead there — outside the stated 3× budget, unrecorded anywhere. Not a §9 violation (the criterion only names the in-repo 2.7 MB file) but worth flagging before M2 compounds it. |
| 17 | Nothing under `tests/fixtures/**`/`tools/**` modified | **Met** | `git diff --stat 644652c..82f9d68 -- tests/fixtures tools/equiv` is empty. |

---

## 2. Correctness — independent byte-level spot checks

Computed independently with Python `struct` from raw bytes (not copied from
the spec's own worked examples) and cross-checked against `tests/golden/**`
and `dist/cli.js --info --json`:

| Field | File | My computation | Parser output | Match |
|---|---|---|---|---|
| `version`/`fileLength`/`functionCount`/`stringCount` | v84,v94,v96,v98,v99 (5×4=20 values) | struct-unpacked | golden/`--info` | ✅ all 20 |
| `regExpCount`/`regExpStorageSize` (class B offsets 64/68) | v84 | 1 / 66 | 1 / 66 (golden) | ✅ |
| `debugInfoOffset` | v94 (0x638), v96 (0x638), v98 (0xa3c), v99 (0xa24) | matched exactly | golden (1592/2620/2596 decimal) | ✅ |
| `objShapeTableCount`/`numStringSwitchImms` (class E, offset 88/92) | v98, v99 | 1 / 0 | 1 / 0 | ✅ |
| `sourceHash` | v94 vs v99 | identical 20-byte hash | golden | ✅ (confirms same source, two compilers) |
| `options` byte semantics | v84/v94/v96 (`0x04`=hasAsync), v98/v99 (`0x00`) | matches §2's bit layout | golden | ✅ |

All independently verified. No discrepancies found anywhere.

### D8 probe-ladder adversarial inputs (item 2 of the task brief)

Ran against the built package (`dist/`):

1. **v98 bytes, version field patched to 99** → `E_LAYOUT_NO_CANDIDATE` ("no
   opcode table candidate (of hbc99-mar2026, hbc99-feb2026) decodes the probe
   sample cleanly"). Correct refusal — real v98-late bytes don't decode
   cleanly under either v99 table.
2. **v99 bytes, version field patched to 98** → **no throw**, correctly
   re-derives `E/hbc99-mar2026` via structural probing (`decidedBy: D1,P3`),
   i.e. D8 defeats the lied-about version field and picks the table that
   actually matches the bytes. This is D8 working exactly as designed — a
   genuine positive result worth highlighting.
3. **Truncated string table** (file sliced mid-table, and separately
   `stringStorageSize` inflated to `0x7fffffff`) → `E_TRUNCATED` and
   `E_LAYOUT_NO_CANDIDATE` respectively. No OOM, no huge allocation attempt.
4. **Function header with the `overflowed` bit forced on but no real large
   header behind it** (tested on both a class-C and a class-E function) →
   `E_LAYOUT_NO_CANDIDATE` in both cases. No crash, no garbage large-header
   read.

All four scenarios: `Hbc2jsError` only, never a raw `RangeError`/`TypeError`,
never a plausible-looking wrong module. R1 held up under everything I threw
at it — **except** the one gap below, which is not in the four brief-listed
scenarios but is the same failure class.

---

## 3. Licence hygiene

- `third_party/hermes/<id>/LICENSE` present (MIT, Meta Platforms) for all 7
  tables, with `VENDOR.yml` recording commit SHA + per-file sha256.
- `git grep -rInE 'hermes_dec|hermes-dec/|site-packages|pass[0-9]_transform_code|_fun[0-9]+_ip|CatchBlockStart' src/ tools/gen-tables/` → **empty**.
- Structural/naming comparison against the installed `hermes-dec==0.1.7`
  package (`site-packages/hermes_dec/{parsers,decompilation,disassembly,utils}/*.py`):
  no correspondence in file names, function shapes, or pass structure —
  hbc2js's `src/parse/{header,strings,functions,...}.ts` split is its own
  design, not a port of hermes-dec's `hbc_file_parser.py`/`pass1..4_*.py`
  layout. Domain-inherited terms only (`bigint`, `regexp`, `debug info`).
- **Clean.** No AGPL contamination found.

---

## 4. The (at least four) deviations

`docs/STATUS.md`'s M1 section narrates three: the P3 opcode-table tie-break,
the optional `opcodeTable`/`builtinTable` typing, and the `hbc98-late`
empirical patch. I found two more that aren't surfaced there (§1 items 12–13):
the T8 mutant-count scale-down and the known-divergences file living as a
comment instead of the named `.md`. Given `docs/AGENT-WORKFLOW.md`'s
"orchestrator hygiene" principle — the overseer works from summaries, not
diffs — an incomplete deviation list undercuts the review process itself.
**Fix: add both to STATUS.md before merge.** Judging each:

- **P3 tie-break** — Accept the *mechanism's intent*, but see Finding 1: the
  implementation needs to be tightened, not reverted. Reverting to a hard
  `E_LAYOUT_AMBIGUOUS` would fail 11/53 real v98 gate fixtures (verified —
  I found exactly these 11 by running the probe against every `v98.hbc` in
  `constructs/`), so refusing outright is not actually safer in practice,
  just less useful. The right fix narrows *which* ties are auto-resolved
  (Finding 1).
- **Optional `opcodeTable`/`builtinTable` typing** — **Accept.** This
  honestly reflects §6.1's own stated fact (a file can parse with no
  generated opcode table for its version) that the literal spec type
  signature papered over. Correctly caught the mismatch instead of casting
  it away.
- **`hbc98-late` empirical patch** — Accept the *approach* (no better option
  exists — no real commit reproduces the public compiler's table), reject
  living with the placeholder unexamined. See Finding 2.
- **T8 mutant count (200 vs 2000/binary)** — Accept as a reasonable
  time-budget trade, conditional on disclosure in STATUS.md (currently
  missing).
- **Known-divergences as a comment, not a file** — Accept; harmless, purely
  a path nit (Finding 3 folds this in).

---

## 5. `hbc98-late`'s empirical patch — is it safe?

The two corrections (`tools/gen-tables/gen.ts:87-102`) are:

1. Removing `ToUint32` (present in the vendored `639e5d6a` source, absent
   from the real build) — well-evidenced: absent from the window-opening
   commit too, consistent story.
2. Inserting `UnknownFastArrayOpcode98Late` — an **unverified guess** at a
   real opcode's name and `(Reg8, Reg8)` signature, justified only by "`Mov`
   sits one position later than the vendored file predicts."

I confirmed by direct inspection of the generated table
(`opcodes-hbc98-late.ts`) that this placeholder lands at **opcode number
15** — immediately before `Mov`. This is not a dark corner of the opcode
space; it's adjacent to one of the single most common opcodes in any
program. **How would anyone know if the guess is wrong?** Under the current
design: only if a real v98-late file happens to use opcode 15, in which
case the decoder will consume the following 2 bytes as two register operands
whether or not that's correct, and — unless that guess happens to blow an
alignment/id-range check somewhere downstream — the error surfaces (if at
all) as a confusing crash or garbage disassembly arbitrarily far away in the
function body, not as a clean, attributable error at the point of the actual
mistake. That is precisely the failure mode D8 exists to prevent ("a
silently wrong parse is the worst outcome this project can produce" — spec
00 §6.2).

**Recommendation:** don't guess a plausible-looking signature for an
opcode nobody has observed. Either (a) give it zero operands and rely on
`decodeForProbe`'s alignment check to fail loudly and immediately the first
time it's hit (cheap, and turns an unknown wrong-guess into an immediate,
attributable `E_OPERAND_OVERRUN`/misalignment rather than a possible
silent continuation), or (b) special-case opcode 15 in the decoder to throw
`E_UNKNOWN_OPCODE` outright with a message pointing at this exact comment.
Either is strictly safer than shipping a guessed 2-register signature that
might happen to "work" (consume the right number of bytes) while meaning
something else entirely.

---

## 6. Finding 1 (HIGH) — P3 opcode-table tie-break can pick between
semantically different tables without verifying which is right

`src/parse/layout.ts:419-444`. When ≥2 opcode-table candidates survive an
*exhaustive* structural probe, the code doesn't refuse — it picks
"whichever survivor is listed first in `candidatesForVersion()`" (line
39: `["hbc98-late", "hbc98-2024", "hbc99-feb2026", "hbc99-mar2026"]`) and
records a `W_OPCODE_TABLE_TIEBREAK` diagnostic. The comment justifies this
by asserting the tied tables "agree on everything below opcode 165" — true
for the `hbc98-late`/`hbc99-mar2026` pair (verified in `docs/HBC-FORMAT.md`
§0), **but not for `hbc99-feb2026`**, which is also a candidate in the same
array for version 98.

I demonstrated this concretely. `hbc99-feb2026` and `hbc98-late` are
generated from the *same vendored `BytecodeList.def`* (identical sha256 —
see `third_party/hermes/{hbc98-late,hbc99-feb2026}/VENDOR.yml`), but
`hbc98-late`'s patch inserts one opcode near the very start of the table
(before `Mov`, at index 15) without a compensating shift until `ToUint32`'s
removal ~140 opcodes later. Diffing the two generated tables:

```
Mov                          late=16  feb=15
CreateFunctionEnvironment    late=64  feb=63
DeclareGlobalVar             late=67  feb=66
GetGlobalObject              late=61  feb=60
PutByIdLoose                 late=74  feb=73
CreateClosure                late=132 feb=131
CreateRegExp                 late=165 feb=165   <- only realigns here
```

Every opcode number from 16 through ~155 means something different in the
two tables. I decoded `tests/fixtures/hermes-dec-sample/v98.hbc`'s function 2
("gen", 24 bytes — a generator stub) against both tables directly: **both
decode with zero structural errors**, but produce entirely different
instruction sequences:

```
late: CreateFunctionEnvironment@0 LoadConstZero@3 StoreNPToEnvironment@5 ...
feb : CreateTopLevelEnvironment@0 NewObjectWithBuffer@6 Unreachable@12 ...
```

This is exactly the "two candidates both decode cleanly but mean different
things" scenario D8/R1 exists to forbid. I then checked every one of the 11
real gate fixtures whose `v98.hbc` currently exercises the `P3-tiebreak`
path (`12-try-catch-finally-return`, `19-var-hoisting`,
`20-let-const-tdz`, `22-nested-closures-counters`, `32-class-basic`,
`33-class-inheritance-super`, `34-class-static-members`, `40-spread-array`,
`41-spread-object`, `43-template-literals`, `47-typeof-instanceof-in`):
**in every one, `hbc99-feb2026` is eliminated by ordinary P3 across the
whole file** (some other function in the same file trips a bounds/id check
under `feb2026`), so today the tie is *only ever* `hbc98-late` vs.
`hbc99-mar2026` — the pair that is genuinely safe. I independently
cross-checked one of them (`22-nested-closures-counters`) against
`hbc-disassembler` (hermes-dec's output, D4-compliant use) and its opcode
names match `hbc98-late`'s reading exactly, confirming today's chosen output
is correct.

**So: nothing is wrong in the current corpus.** But the *mechanism* that
produced the right answer did so by luck of array ordering, not by
verification — nothing stops `hbc99-feb2026` from surviving a tie for a
future file whose every function happens to avoid a distinguishing
bound/id (my isolated fn2 example proves this is possible for at least one
function shape), and if that happens the code will silently take whichever
table sorts first with no additional check and no test that would catch a
wrong choice at the semantic level (the golden snapshots pin the *chosen
table id*, not whether that choice was semantically justified).

**Fix (concrete, cheap):**
1. Add a test that decodes the ambiguous functions in these 11 fixtures to
   full opcode-name sequences and pins them explicitly — not just the
   table id — so a future table regeneration or reordering that silently
   changes the *meaning* at tied positions is caught, not just a table-id
   diff.
2. Add a comment at the `candidatesForVersion` array literal
   (`src/parse/layout.ts:39`) stating plainly that array order is
   load-bearing for `probeLayout`'s tie-break and must not be reordered
   without re-reading `layout.ts:419-444`.
3. Consider tightening the tie-break itself: only silently resolve when the
   *only* remaining candidates are `hbc98-late`/`hbc99-mar2026` (the
   verified-safe pair per §0 of `docs/HBC-FORMAT.md`); if `hbc99-feb2026`
   is ever among the survivors, treat that as a stronger signal of genuine
   ambiguity and throw `E_LAYOUT_AMBIGUOUS` rather than applying the same
   order-preference rule uniformly to all three.

---

## 7. Other findings

**Finding 3 (MEDIUM) — undisclosed deviations.** See §4. `docs/STATUS.md`
should list the T8 200-vs-2000 mutant count and the known-divergences
file-vs-comment discrepancy alongside the three it already documents.

**Finding 4 (MEDIUM) — missing error offsets.** Spec 00 §6.2 rule 3: "every
thrown error carries a byte offset where one exists," goal being a bug
reproducible from "code + offset alone." Six throws in `src/parse/layout.ts`
pass an empty `{}` context despite a natural offset being available:
`E_UNSUPPORTED_VERSION` (lines 30, 41 — offset 8, the version field),
`E_LAYOUT_NO_CANDIDATE` (lines 329, 331, 417), `E_LAYOUT_AMBIGUOUS`
(line 345). Cheap fix: attach `{ offset: 8 }` or `{ offset: 0 }`.

**Finding 5 (MEDIUM) — memory budget unverified at real scale.** Per this
task's instructions, I extracted the 50.8 MB Discord bundle from
`~/hbc2js-local-corpus/apks/com.discord.apk` (`assets/index.android.bundle`,
via Python `zipfile`, to scratch space only — not copied into the repo) and
measured `parseHbc` directly: 165 ms, zero diagnostics, correctly chose
`E/hbc98-late` — all consistent with STATUS.md's claims. But RSS grew by
~228 MB parsing a 50.8 MB file (~4.5×), exceeding spec 01 §7.3's "peak RSS
≤ 3× file size" budget, which is only measured/recorded in-repo up to the
2.7 MB `rn-template-0.72` fixture. 120,522 `FunctionRecord`s and 327,121
strings likely mean per-object overhead dominates at this scale rather than
any accidental buffer copy (I didn't find a `slice()`-where-`subarray()`-
belongs bug in the files I read). Not blocking for M1, but the 3× budget
should either be re-scoped to "small/medium bundles" explicitly, or M2
should watch this before building more allocation on top.

**Finding 6 (LOW) — untested acceptance clause.** `probe.exhaustive` is
never asserted for `bundles/**` in `tests/sweep/parse/bundles.test.ts`,
despite §9 explicitly requiring it for "every bundle under 4 MB" (all four
are ≤2.7 MB). One-line addition.

**Finding 7 (LOW) — CLI arg parsing is positionally fragile.** `src/cli.ts:46`
(`else if (a === "--info") info = argv[++i];`) greedily consumes the very
next token as the filename. `hbc2js --info --json file.hbc` — a natural
reading of the USAGE text's own `--info <input.hbc>` — silently treats
`"--json"` as the filename and reports a confusing `E_IO: cannot read
--json` rather than a usage error. `--info file.hbc --json` (the order the
CLI test always uses) works fine. Not spec-mandated behavior either way;
worth a one-line robustness fix (skip flag-shaped tokens when filling
`--info`'s argument).

**Finding 8 (NIT) — redundant JSON error field.** `Hbc2jsError.toJSON()`'s
`message` is the fully-formatted string (already containing `code` and the
offset annotation), duplicating the separate `code`/`context.offset` fields
in the same object. Harmless.

---

## 8. Code quality notes (not separate findings)

- Error messages are otherwise excellent: structural errors
  (`E_SECTION_OVERRUN`, `E_BAD_STRING_ID`, `E_BAD_HANDLER`, etc.) reliably
  carry `offset`/`section`, unlike the layout-level throws in Finding 4.
- No unbounded allocation before validation found anywhere I checked
  (`bigint.ts`, `buffers.ts`, `debug.ts`, `functions.ts`) — every
  `new Array(n)` I traced is preceded by a `require()`/count-bound check.
  `debug.ts`'s filename-length bounds check (the T8-caught bug mentioned in
  STATUS.md) is correctly generalized to match the main string table's
  INV-12 treatment.
- Class A (v51-83) and class D (v97/98-early) remain implemented-but-
  unverified, exactly as spec 01's own O-2 acknowledges — inherited,
  accepted risk, not a new defect.
- `tests/support/**` is read-only w.r.t. `tests/fixtures/**` as required;
  no writes observed during any of my test runs (`git status --porcelain`
  clean afterward).

---

## 9. Checklist summary

| Area | Result |
|---|---|
| Spec 01 §9 acceptance criteria | 15/17 clean, 2 partial (bundle-exhaustive untested; RSS budget unverified past 2.7 MB) |
| Correctness (10+ independent byte spot-checks) | 100% match |
| D8 adversarial inputs (4 brief-mandated scenarios) | All handled correctly — `Hbc2jsError` only, no silent misdecode |
| Licence hygiene | Clean |
| Three (really five) deviations | 4 accepted as-is or with disclosure; 1 (P3 tie-break) needs the tightening in Finding 1 |
| `hbc98-late` placeholder opcode | Real, demonstrated risk (Finding 2) — recommend fail-loud instead of guess |
| Test suite | Comprehensive; two gaps found (Findings 1's semantic test, 6) |
| Findings | 1 HIGH, 3 MEDIUM, 2 LOW, 1 NIT |

**Required before merge:** Findings 1 and 2 (both cheap: tests + a guard,
no architecture change). Findings 3–4 should be fixed or explicitly waived
by the overseer. Findings 5–8 can follow up in M2's spec review.
