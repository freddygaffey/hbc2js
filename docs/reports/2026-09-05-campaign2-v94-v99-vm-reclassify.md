# 2026-09-05 — campaign-2 v94/v99 saved finds reclassified against real Hermes VMs (Mac)

`docs/reports/2026-09-05-campaign2-rediff.md` ran on deb, where only `hermesc` compilers
exist for v94/v99 — no `hermes` interpreter — so `chooseReference()` fell back to a
non-VM (Node/`expected.txt`) reference for those two versions, same silent-fallback shape
`docs/reports/2026-09-05-campaign2-v96-vm-rediff.md` found and fixed for v96
(`23b4996`, `tools/fuzz/reference-mode.mjs`). This Mac has real interpreters for both
(`tools/hermes-vm/v94/bin/hermes`, `tools/hermes-vm/v99/bin/hermes`), so the v94 (10
finds) and v99 (49 finds) halves of the saved campaign-2 finds were pulled from deb
(`~/hbc2js-rediff/reports/fuzz/finds/{v94,v99}-*.js` — `reports/fuzz/` is gitignored,
confirmed with `git check-ignore`) and reclassified here.

`tools/fuzz/reclassify-finds.mjs` has no `--dir`/input flag (its `FINDS_DIR` is
hardcoded to `reports/fuzz/finds`); rather than touch the shared `tools/fuzz/finds/`
directory or the tool itself (out of scope, `tools/**` is off-limits for this task), a
scratch copy with `FINDS_DIR` pointed at `reports/fuzz/finds-v94v99/` and absolute
`import` paths was used to drive the same `reclassifyOne`/`runOracleLadder` logic
unmodified. Every run/probe below was under `timeout`.

## Per-version table

| version | reference engine | total | PASS | DIVERGENT | INCONCLUSIVE | ERROR |
|---|---|---|---|---|---|---|
| v94 | hermes-vm | 10 | 0 | 0 | 10 | 0 |
| v99 | hermes-vm | 49 | 10 | 29 | 10 | 0 |
| **total** |  | **59** | **10** | **29** | **20** | **0** |

Both `referenceEngineBanner()` lines printed `engine = hermes-vm` for v94 and v99
before any classification ran, confirming this is a real VM cross-check
(`mode: "full-ladder"`), not the Node/`expected.txt` fallback the deb run silently used.

No (c) real value/branch divergence was found anywhere in this 59-find sample — every
surviving DIVERGENT or INCONCLUSIVE result reduces to (a) error-wording-only or (b)
budget/non-terminating, both confirmed by hand below.

## Family table

| family | finds (v94+v99) | verdict here | class | exemplar |
|---|---|---|---|---|
| `map-set-range-v99` (BUGS row) | 0+29 = 29 | DIVERGENT | (a) error-wording-only | `v99-seed2000298.js` |
| `counter-inc-dec-reset-RangeError` (BUGS row) | 8+5 = 13 | INCONCLUSIVE | (b) budget/resource-ceiling | `v94-seed2000137.js` |
| `arity/arguments-aliasing` (BUGS row) | 2+2 = 4 | INCONCLUSIVE | (b) non-terminating loop | `v94-seed2000502.js` |
| do/while executes body once (unnamed in BUGS.md) | 0+2 = 2 | INCONCLUSIVE | (b) budget/resource-ceiling | `v99-seed2001430.js` |
| let-in-loop per-iteration capture (unnamed in BUGS.md) | 0+1 = 1 | INCONCLUSIVE | (b) budget/resource-ceiling | `v99-seed2001096.js` |
| unlabelled `mode=grammar` mixed-construct programs | 0+10 = 10 | now PASS (false alarm) | — | `v99-seed2000048.js` |

10 + 13 + 4 + 2 + 1 + 29 = 59, matches the total exactly; every v94/v99 saved find is
accounted for in one of these six buckets.

### (a) `map-set-range-v99` — error-wording-only, verified directly

Exemplar `v99-seed2000298.js` ("for...of over Map, Set, and a hand-rolled
`[Symbol.iterator]` object"). Bypassing the harness entirely and running the raw
binaries directly on the exemplar:

- `tools/hermes-vm/v99/bin/hermes` on the original `.hbc`: prints `map: a:1,b:2,c:3`,
  `set (dedup): 5,6,7`, then `Uncaught TypeError: Can't apply() to non-callable`.
- The decompiled candidate under plain `node` (with a `print` shim): prints the same
  two lines, then throws `TypeError: CreateListFromArrayLike called on non-object` at
  `r15.apply(r14, r13)` — the decompiled lowering of the custom object's `for...of`
  iterator-protocol call.

Both sides fail at the exact same point (after the `set` line, before `custom range:`
would print), on the same underlying operation (`Function.prototype.apply` on a
non-callable value) — Hermes's native error text differs from V8/Node's for that
built-in TypeError, nothing else. This matches the "known so far" note verbatim
(`v99-seed2000298`: `Can't apply() to non-callable` vs `CreateListFromArrayLike called
on non-object`). All 29 DIVERGENT finds share this exact family (`sed -n 2p` on every
finds file: all 29 are `// for...of over Map, Set, and a hand-rolled [Symbol.iterator]
object.`) and the same trailing `uncaught TypeError` shape in
`tools/fuzz/reclassify-finds.mjs`'s own signature output — only the `map`/`set`
literal values (masked to `#`) differ between finds, confirming one root cause, not 29
distinct ones. Whether hermesc v99 itself mis-lowers a computed `[Symbol.iterator]()`
method (making the ground-truth bytecode itself throw) was not root-caused further —
out of scope for a measurement task — but the decompiler correctly reproduces the
crash; only the two engines' native message text differs.

### (b) budget/resource-ceiling and non-terminating-loop families

`runOracleLadder`'s P-16 budget logic (`src/harness/ladder.ts`) correctly returns
INCONCLUSIVE, never DIVERGENT, for all 20 finds in this bucket:

- **`counter-inc-dec-reset-RangeError`** (13 of the row's finds, v94 8 + v99 5): every
  one reports `resource: the candidate hit an engine resource ceiling while the VM kept
  running; Hermes VM cross-check truncated by a budget after N identical line(s)`. The
  decompiled candidate (running under Node) hits its own resource ceiling (stack/heap)
  before the real Hermes VM does on the same construct (an `initial:`/`inc:`/`dec:`/
  `reset:` counter driven until `RangeError`), so the harness can only confirm
  agreement on the shared prefix and reports INCONCLUSIVE, not a value mismatch. The
  BUGS row's current description ("diverges later in its trace, at or near an uncaught
  RangeError") should be corrected for the 94/99 finds specifically — under the real VM
  none of the 13 sampled here are a confirmed value/branch divergence.
- **`arity/arguments-aliasing`** (4 of the row's finds, v94 2 + v99 2, including the
  cited `v94-seed2000502`/`v99-seed2000502`): every one reports `the candidate-vs-
  source.js divergence is refuted by the Hermes VM inside the observed prefix (D14);
  Hermes VM cross-check truncated by a budget`. This is exactly the known
  non-terminating `for (let i = -Infinity; i < arguments.length; i++)` loop — the real
  VM hangs too, and inside the portion it does observe it *agrees* with the candidate
  (refutes the earlier non-VM-reference "divergence"), so the D14 unmapped-copy
  `__hbc_arguments` lowering is verified correct at 94/99 exactly as the brief's
  known-so-far note states.
- Two small, previously-unnamed families surfaced only at v99 in this sample — 2 finds
  of "do/while executing its body at least once before the test fails" and 1 finding of
  "let-in-loop per-iteration binding" — both show the identical
  `resource: the candidate hit an engine resource ceiling while the VM kept running`
  shape as the counter family above (`v99-seed2001430.js`, `v99-seed2001758.js`,
  `v99-seed2001096.js`). Not proposing a new BUGS.md row for either: 1-3 finds each,
  same resource-ceiling shape, no confirmed value/branch divergence — flagged here for
  the orchestrator's awareness only.

### False alarms

The remaining 10 v99 finds (all `mode=grammar`, unlabelled mixed-construct programs,
e.g. `v99-seed2000048.js`) are now PASS — false alarms, same as the bulk of the
post-fix-wave-3 improvement the earlier campaign-2 reports already documented.

## Proposed `docs/BUGS.md` row moves

Not applied — one editor at a time, per the brief; the orchestrator applies these.

- **`map-set-range-v99`** (`2026-09-05 | campaign-2 rediff ... family map-set-range-v99`,
  21 finds / 9 signatures, v99 only): recommend **Resolved `d14-legit`** — the
  decompiler correctly reproduces the real v99 VM's crash; the only difference is
  Hermes's vs V8's native `TypeError` wording for a `Function.prototype.apply()`-on-
  non-callable failure (verified directly against both raw binaries on the row's own
  exemplar seed, all 29 saved finds in the family showing the identical shape). If the
  orchestrator instead wants oracle-level message normalisation (as the already-fixed
  `iterable-wording` row did for a different message), that is a viable alternative
  verdict, but the underlying decompiled bytecode behaviour is not wrong.
- **`arity/arguments-aliasing`** (20 finds / 3 signatures, all 4 traced versions):
  recommend the 94/99 finds be corrected from "unconfirmed"/possible-divergence to
  **INCONCLUSIVE / non-terminating loop, refuted-by-VM-in-observed-prefix** — under the
  real VM, none of the 4 v94/v99 finds sampled here are a confirmed divergence; the row
  should stay **Open** only on the strength of its 84/96 members (not sampled by this
  task), with the description corrected to note the 94/99 portion is a VM hang, not a
  value mismatch.
- **`counter-inc-dec-reset-RangeError`** (13 finds / 4 signatures, v84,94,99): all 13 of
  the row's finds are v94/v99 (0 v84 in the saved-finds sample), and all reclassify as
  **INCONCLUSIVE / budget-resource-ceiling**, not a confirmed value divergence. The
  row's "diverges... at or near an uncaught RangeError" description should be corrected
  to describe a resource-ceiling budget cutoff (candidate exhausts a Node engine
  ceiling before the real Hermes VM does), and the row's version-set note ("v84,94,99")
  re-examined — the sampled finds are only 94/99; whether an 84 member exists needs a
  v84 check this task did not do.

No (c) family (real value/branch divergence) was found, so no new BUGS.md row or
`src/` component is being nominated by this task.
