# Review: M1 review-response fixes + M2 disassembler

**Reviewer:** Claude Sonnet 5 (adversarial review, step 3 per `docs/AGENT-WORKFLOW.md`)
**Range reviewed:** `82f9d68..fddf194` (`git diff 82f9d68..fddf194 -- src tests third_party docs/STATUS.md`)
**Scope:** review only — `src/**` not modified. `src/harness/**` and its tests are
another agent's concurrent work and are excluded from everything below.

## Verdict

| Component | Verdict |
|---|---|
| M1 review-response fixes (Findings 1–8 of `docs/reviews/M1-parser.md`) | **MERGE** |
| v98 class-E large-header fix (`fddf194`, the parse-side code itself) | **MERGE**, with a doc correction owed |
| M2 disassembler implementation (`c3e3e4f`, `src/disasm/**`, `src/tables/roles.ts`) | **MERGE** |
| M2's test suite as it now stands against `fddf194` | **FIX-THEN-MERGE** — not gate-ready |
| Overall (`npm run test:all` gate) | **NOT GREEN. Blocking for M4.** |

The disassembler's own code is solid — decoding, switch tables, labels, roles and
licence hygiene all check out under independent verification. The problem is
entirely in the interaction between the M1 flags fix and M2's oracle/golden tests,
which were never reconciled with it. **`docs/STATUS.md`'s "M2 ... 100% matched...
7.B: 250/250 (100%) at all five versions" is now false** against the tree at
`fddf194`, and the task brief's framing ("9 remaining failures") undersells the
actual damage by roughly 7x.

---

## 1. Independently measured gate state (not the brief's number)

`npm run test:all` on this tree: **707 tests, 640 pass, 65 fail, 2 skip.** Not 9.
Breakdown of the 65:

* **8 fixtures × `tests/gate/oracle/disasm/hermesc.test.ts`** (7.A) — uncaught
  `E_LAYOUT_AMBIGUOUS` thrown *inside* the test's own `parseHbc()` call, before
  the applicability gate or the diff even runs. This file never imports
  `tests/support/known-issues.ts`.
* **~52 of 53 v98 fixtures × `tests/gate/oracle/disasm/hermes-dec.test.ts`** (7.B)
  — genuine, well-understood, but **unimplemented** divergence (see §3 below).
  This dwarfs the other categories.
* **`tests/gate/disasm/golden.test.ts`** — fails on the *first* stale golden it
  hits (`constructs/01-if-else-chain/v98.txt`) and stops there, which hides that
  essentially all 53 v98 canonical `.txt` goldens are stale (none were touched by
  `fddf194`; confirmed with `git show fddf194 --stat`).
* 1 perf-budget flake (`tests/sweep/parse/bundles.test.ts` T9, 160ms vs an 87ms
  budget) and 2 `src/harness/**`-owned failures, both out of scope here.

I reproduced the 8 ambiguous fixtures directly (`parseHbc` with no forced table)
and confirmed all 8 — and only those 8 — throw `E_LAYOUT_AMBIGUOUS`; the other 44
v98 construct fixtures auto-probe cleanly. I also confirmed the same 8 reproduce
identically under `.min.hbc` (minification doesn't touch the ambiguous opcodes).
`tests/support/fixtures.ts:40` explicitly skips `.obf.hbc`/`.min.hbc` as "variants,
not base binaries", so **the disassembler oracle suite (7.A/7.B) never runs
against any obfuscated or minified `.hbc` at all** — a real coverage gap for D13's
hardened tier, worth naming even though it's not new to this range. A smoke test
I ran (parse + decode every function, no oracle) succeeded on 132/136 sampled
`.obf`/`.min` v98 binaries; the 4 failures were the same known-ambiguous fixtures.

---

## 2. M1 review-response fixes — verified against `docs/reviews/M1-parser.md`

**Finding 1 (P3 tie-break redesign, HIGH) — correctly fixed.** Reproduced the
reviewer's own motivating case: `tests/gate/parse/layout.test.ts:104`
("hermes-dec-sample/v98.hbc fn2 ...") decodes the same 24 bytes cleanly but
differently under `hbc98-late` vs `hbc99-feb2026`, and the test asserts this and
passes. More importantly, I verified the new whole-file `decodeAndVerifyFunction`
mechanism on real corpus files, not just the synthetic case: exactly 8 real
`constructs/*/v98.hbc` fixtures (`20-let-const-tdz`, `22-nested-closures-counters`,
`33-class-inheritance-super`, `34-class-static-members`, `40-spread-array`,
`41-spread-object`, `43-template-literals`, `47-typeof-instanceof-in`) now throw
`E_LAYOUT_AMBIGUOUS` on auto-probe, and every other v98 construct fixture (44 of
them) still auto-probes cleanly to `hbc98-late`. This is materially safer than the
old array-order tie-break and matches `docs/STATUS.md`'s account exactly.

**Finding 2 (opcode 15 placeholder, MEDIUM) — correctly fixed.** The
`unverified`/fail-loud path did its job: `50-this-binding/v98.hbc` now throws
`E_UNKNOWN_OPCODE` on the un-fixed table and the real opcode was identified
(`CacheNewObject(Reg8,Reg8,UInt32,UInt8)`) and left unresolved in the generated
table rather than silently patched in — correctly deferred to the table owner
since it renumbers opcodes. Fine as-is.

**Findings 3, 4, 6 — verified fixed by inspection.** T8 mutant count is
2000/binary by default (`HBC2JS_FUZZ_MUTANTS_PER_BINARY` override), `known-divergences.md`
exists at the spec-named path, all six bare throws in `src/parse/layout.ts` now
carry `{ offset: ... }` (spot-checked lines around 329/331/345/417), and
`tests/sweep/parse/bundles.test.ts` asserts `probe.exhaustive === true`.

**Finding 4's RSS half** — plausible and consistent with the described
structure-of-arrays refactor in `src/parse/strings.ts`, but **not independently
re-measured here** (requires the 50.8 MB Discord bundle from the gitignored local
corpus, which I did not re-extract). Treat the ~2.6x figure as unverified by this
review, not as disproven.

**Findings 5, 7, 8** — accepted as documented (5 folds into 4; 7 deferred to
`src/cli.ts`'s owner; 8 is a deliberate convenience, no change needed).

---

## 3. The v98 class-E large-header fix (`fddf194`) — verified against bytes

**The +1 byte / offset-35-vs-36 claim is correct.** Independently reconstructed
from raw bytes (Python `struct`, no reliance on the project's own parser) for
`hermes-dec-sample/v98.hbc` function 0 (info block at `0x89c`): the 32-byte block
of eight `uint32` fields (`offset..frameSize`) matches `docs/HBC-FORMAT.md` §3.5's
own worked v99 example field-for-field; `readCacheSize=9`, `writeCacheSize=5`
follow at `+32/+33`; byte `+34` (would-be `privateNameCacheSize` under the old
36-byte layout) and byte `+35` (old `flags` position) are both `0x00`; byte `+36`
(new `flags` position) is `0x12`, decoding to `prohibitInvoke=none,
hasDebugInfo=true` — exactly matching what real `hermesc -dump-bytecode` shows
for `global` and exactly matching `known-divergences.md`'s before/after
description. Cross-checked the same way on `constructs/32-class-basic/v98.hbc`
and `constructs/01-if-else-chain/v98.hbc`: both reproduce the documented
before/after (`prohibitInvoke` and `hasExceptionHandler` fixes) exactly. **The fix
is real and correct.**

**`docs/HBC-FORMAT.md` is now stale and should be corrected.** §3.3 states "Large
`FunctionHeader` (class E), 36 bytes, packed" with no version qualifier, and
nowhere documents the v98-only `NumCacheNewObject` field, its position in
small-header byte 10, or the resulting 37-byte v98 large header. The document's
own stated goal is to be "complete enough that an implementation agent can write
a parser from this document alone" (line 6) — right now an implementer following
it verbatim would reproduce the exact bug `fddf194` just fixed. Recommend adding a
subsection to §3.3, in the same style as §0's "two incompatible header layouts"
callout: name the commit (`f74f6bbe37`, reverted by `913d31acd1` before v99),
state that it applies to v98-late only (not v99, not class D), and give the
37-byte field list. This is a doc fix, not a code blocker.

**The small-header byte-10 bit-split (`NumCacheNewObject`) is implemented but
unverified and currently unverifiable.** `readSmallHeaderAt`
(`src/parse/functions.ts`) correctly narrows `writeCacheSize` to 6 bits when
`hasNumCacheNewObjectField`, but this field is only meaningful for
**non-overflowed** functions (an overflowed function's small-header
frameSize/readCacheSize/writeCacheSize bytes are discarded entirely in favour of
the large header's own copy — confirmed by reading `readFunctionRecord`). I
enumerated every non-overflowed function across all 52 v98 construct fixtures:
**35 exist, and all 35 have `writeCacheSize === 0`** — a value that reads
identically whether byte 10 is split 6/1 or left at 7 bits. So this half of the
fix is correct by construction (bit 7 stays `privateNameCacheSize` either way)
but has **zero fixture coverage that could actually catch it being wrong**, and
`fddf194`'s own new test (`functions.test.ts`) only exercises **overflowed**
functions. Low practical severity (`writeCacheSize` isn't used for any decode
decision downstream), but worth a one-line acknowledgment in
`tests/gate/parse/functions.test.ts` or a `docs/STATUS.md` gap note rather than
silence.

**Class D (v97/98-early) correctly does not get the same treatment, on the
evidence available.** `hasNumCacheNewObjectField` is hardcoded `false` for class
D. `docs/STATUS.md`'s Finding-2 response dates `f74f6bbe37` (the commit that added
`NumCacheNewObject`) as an *ancestor* of `639e5d6a` (the commit that already has
class E's reshaped `FUNC_HEADER_FIELDS`), which means `f74f6bbe37` postdates the
D→E layout transition and never applied to class D's shape. This is a sound
inference from evidence already in the repo, but it is still an inference, not an
independent re-check of Hermes git history, and — per the pre-existing O-2 gap —
there is no class-D fixture anywhere to test it against either way. Fine to ship,
but the reasoning belongs next to `hasNumCacheNewObjectField`'s own comment in
`src/parse/header.ts`, not only in `docs/STATUS.md` prose, since that's where a
future reader will look when class D finally gets a fixture.

---

## 4. M2 disassembler (`c3e3e4f`) — spec 02 §9 checklist, independently checked

| Criterion | Verdict | Evidence |
|---|---|---|
| Every gate binary decodes with zero errors, `ip` lands on `bytecodeSizeInBytes` | **Met for the 44/53 non-ambiguous v98 + all v84/94/96/99** | `decodeAndVerifyFunction`'s own checks; spot-verified |
| §7.E re-encode round-trip byte-exact | **Met** | gate test passes (`✔ re-encode round-trip...`) |
| Jump targets resolve to instruction boundaries | **Met** | switch/label tests pass |
| Switch tables (52/53, all 4 versions incl. the v94 worked example) | **Met** | `✔ §4.1 worked example...`, `✔ §4.3...` both pass; verified the exact case list from the spec is asserted, not just "no throw" |
| 7.A hermesc diff empty | **NOT met** | 8 fixtures crash on `E_LAYOUT_AMBIGUOUS` before the diff step even runs — see §5 |
| N-hermesc header regex (3 shapes + `NC`/`Constructor` assertion) | **Met** | verified in `tests/gate/oracle/disasm/normalize.ts`; `Constructor<...>` shape correctly added |
| 7.B hbc-disassembler diff empty, ≤4-entry allowlist | **NOT met** | ~52/53 v98 fixtures fail on a real, documented, but *uncoded* 5th divergence — see §5 |
| v94/v99 spot-checks (exact opcode sequence) | **Met** | present and passing |
| v98/v99 one-byte-divergence assertion | **Met** | present and passing |
| Golden snapshots exist and byte-stable | **NOT met** | all 53 v98 `.txt` goldens stale post-`fddf194` (untouched by that commit) |
| Perf recorded, extrapolated to 12MB | **Met, but not reproduced here** | see §6 |
| `tests/fixtures/**`/`tools/**` untouched | **Met** | `git diff --stat 82f9d68..fddf194 -- tests/fixtures tools` empty |

**`src/tables/roles.ts` vs `BytecodeList.def` (9 v84 opcodes).** Verified directly
against `third_party/hermes/hbc84/BytecodeList.def`: `CreateClosure`,
`CreateClosureLongIndex`, `CreateGeneratorClosure`,
`CreateGeneratorClosureLongIndex`, `CreateAsyncClosure`,
`CreateAsyncClosureLongIndex`, `CreateGenerator`, `CreateGeneratorLongIndex`
(absent at v84, present at v94+ — not a discrepancy, just not exercised by that
table), `CallDirect` — all 9 match the file's operand lists exactly (3rd operand
is the function-id-shaped one in every case), and `OPERAND_FUNCTION_ID` is indeed
entirely absent from that file (`grep` returns nothing), confirming the override
is necessary, not decorative. `CallDirectLongIndex`'s 10th override is correctly
noted as unmatched by any version's own macros. No issues found.

**Licence hygiene.** `git grep` for hermes-dec markers in `src/`/`tools/gen-tables/`
returns only fixture-name mentions and D4-compliance comments. `hermes_dec`'s
installed package (`0.1.7`) has a single monolithic
`disassembly/hbc_disassembler.py`; this project's `src/disasm/` is split into
`decode.ts`/`labels.ts`/`switchtable.ts`/`print.ts` with no structural
correspondence — same conclusion the M1 reviewer reached for the parser. Clean.

---

## 5. HIGH — the real cause of the 7.A/7.B failures, and the fix

**5a. `tests/gate/oracle/disasm/hermesc.test.ts` never forces the table for
`KNOWN_AMBIGUOUS_V98` fixtures**, unlike `decode.test.ts`, `reencode.test.ts`,
`golden.test.ts`, `module.test.ts`, `strings.test.ts` and (partially) its own
sibling `hermes-dec.test.ts`. Its `ourRawText` helper (line 17) calls
`parseHbc(b.bytes())` with no options, which throws before the file's own
applicability gate (byte-reproducibility against a fresh `hermesc` recompile)
is even reached.

> **Fix:** import `isKnownAmbiguousV98` from `tests/support/known-issues.ts` and
> pass `{ opcodeTable: "hbc98-late" }` into that `parseHbc` call when it returns
> true — the exact one-line pattern already used at
> `tests/gate/oracle/disasm/hermes-dec.test.ts:34-35`.

**5b. `tests/gate/oracle/disasm/hermes-dec.test.ts` has no handling at all for
`known-divergences.md`'s item 9**, which is a *different* bug from the layout
ambiguity: hermes-dec's own `hbc-disassembler` still has the v98 large-header
flags bug this project just fixed, so its `exc`/`dbg` fields are wrong for every
overflowed v98 function that genuinely has a handler or debug info — i.e. nearly
all of them. I confirmed this is exactly what's firing:
`constructs/01-if-else-chain/v98`'s actual failure is
`ours="FUNC 0 124 1 20 0 1 1 332"` vs `theirs="FUNC 0 124 1 20 0 0 0 332"` — the
`exc`/`dbg` columns (positions 6/7) are the only difference, matching
`known-divergences.md`'s own quoted example almost verbatim. Everything after
that line then reports as "mismatched" too, purely because the line-by-line
comparator desyncs after the first real divergence — a second-order symptom, not
a second bug.

> **Fix:** this is real, evidenced, one-directional (hermes-dec is wrong, not us)
> tool disagreement — exactly the kind spec 02 §7.B says is legitimate to
> allowlist, not to paper over. Thread `version` into `ourFuncLine` (or into the
> comparison site in `hermes-dec.test.ts`) and, for `version === 98`, blank the
> `exc`/`dbg` fields on **both** sides before comparing (not just widen "theirs"),
> so a genuine future regression in *our* exc/dbg decoding for v98 still shows up
> as a mismatch everywhere else in the same FUNC line. Promote this into spec 02
> §7.B's numbered allowlist as item 5, updating the "at most four entries"
> acceptance-criterion text to five, with a citation to
> `known-divergences.md` item 9 (which already has the byte evidence — nothing
> new to write, just move it into the enforced allowlist instead of leaving it as
> prose).

**5c. `tests/gate/disasm/golden.test.ts`'s ~53 stale v98 goldens.** Mechanical:
regenerate the canonical `.txt` snapshots under `fddf194`'s corrected decode
(the M2 owner's equivalent of `UPDATE_GOLDEN=1`) and commit them alongside a
review response, the same way `fddf194` itself already regenerated the parse-level
`tests/golden/constructs/*/v98.json` files. Reviewer should diff the new goldens
and confirm the changes are limited to `flags=`/`prohibitInvoke`/exception-handler
lines matching `fddf194`'s commit message — anything broader would be a genuine
new regression, not fallout from this fix.

**Do not** fix any of 5a–5c by widening a normaliser to swallow more than the
named field, and do not skip whole fixtures where a narrower fix (5b) is
available — that would hide a real future regression in exactly the field this
milestone just spent effort getting right.

---

## 6. Performance — re-measured, inconclusive vs. `docs/STATUS.md`

Re-ran `tests/sweep/disasm/bundles.test.ts` on the 2.62 MB
`index.android.noopt.debug.hbc` fixture in this sandbox:
`decodeModule=295.1ms` (STATUS.md: 36.4ms), `raw print=698.9ms` (STATUS.md:
73.7ms), `canonical print=717.9ms` (STATUS.md: 90.7ms) — roughly **8x** slower
across all three disasm metrics. The sibling parse-level T9 perf test, by
contrast, measured close to its recorded baseline (19.5ms vs. 4–9ms, well within
budget) in the same run. All three disasm numbers still land comfortably inside
spec 02 §8's generous budgets (extrapolated 12MB figures of ~1.3s/3.2s/3.3s vs.
4s/15s/25s), so nothing *fails* — but the disproportionate slowdown specific to
decode/print (vs. parse) is worth a real re-measurement on a quiet machine rather
than trusting either number as-is; I cannot tell from one run here whether this is
sandbox noise or a real cost that crept into the decode/print hot path.

---

## 7. Recommended action before M4

1. Fix 5a/5b/5c above (test files only, no `src/**` change needed for 5a/5b; 5c is
   golden regeneration).
2. Update spec 02 §7.B's allowlist cap and §9's acceptance-criteria text to
   reflect the real, permanent hermes-dec divergence (item 9) as a 5th allowlist
   entry, not a waiver.
3. Add the `docs/HBC-FORMAT.md` §3.3 correction for v98's 37-byte large header
   (§3 above) — doc-only, unblocks nothing but should not be left stale.
4. Correct `docs/STATUS.md`'s M2 section: the "100%"/"250/250" claims predate
   `fddf194` and are no longer true; either update them with the real current
   numbers once 5a–5c land, or caveat them explicitly in the interim.
5. Re-measure disasm perf (§6) once on a quiet machine and record it, or at least
   note the environment this run's numbers came from.

None of the above requires reopening the M1 or M2 implementation work itself —
both are sound. The gate is red because two milestones' tests were never
reconciled with each other, not because either milestone's code is wrong.

---

Co-Authored-By: Claude Sonnet <noreply@anthropic.com>
