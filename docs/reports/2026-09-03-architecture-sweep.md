# Architecture sweep — 2026-09-03

Scheduled whole-repo design-debt sweep (docs/orchestrator-handoff-2026-09-02.md decision 7).
Method: structural survey only — `wc`/`grep`/`ts-prune`/targeted reads; no heavy measurement
beyond one full gate run. Findings ranked by value/effort. Severity: H = costs us daily,
M = costs us at scale, L = hygiene.

## Ranked findings

### 1. [H, effort M, needs spec] `expressionOnlyCheck` still O(n²) via `defUse(after)` — the last known whole-file perf cliff

**Area: passes framework.** The effect-sequence half of the checker was made incremental
(prefix/suffix reference-equality strip, `src/passes/ast.ts:1454-1462`), but the
read-before-def half at `src/passes/ast.ts:1467` (`for (const [name, {defs, reads}] of defUse(after))`)
still walks the *entire* post-rewrite statement list once per applied site. On a module-root
function with thousands of statements and many sites this is the QUEUE "Perf part 3" item
(NSW whole-file 563 s, target < 120 s). The comment above it even documents why the naive
version was replaced for effects — the same argument (rewrites splice a small sub-range)
applies to def-use, but positions are global, so it needs incremental state.
**Fix shape:** maintain a per-function def-use index keyed by statement identity, patched at
each splice; or restrict the read-before-def re-check to names occurring in the changed
region ∪ names whose first def moved. Soundness-sensitive → spec + review gate (checker
change). Already queued; this sweep confirms it is the top remaining structural perf debt.

### 2. [H, effort S–M, no spec] Gate tests re-decompile the rn-template bundle independently — no shared decompile cache

**Area: tests.** 28 test files reference `rn-template`; in the gate alone,
`tests/gate/passes/pipeline-speed.test.ts` decompiles the full bundle at least twice
(lines 220, 254 — passes-on and passes-off), and `call-shape-metrics`, `template-literal`,
`jsx-recover` (plus `tests/gate/split/*.test.ts`, `tests/gate/tools/*.test.ts`,
`tests/artifact/*.test.ts`) each do their own full `decompile()` of the same bytes.
`tests/support/` has no decompile cache (`grep cache|once tests/support/m4.ts tests/support/tiers.ts`
→ nothing). Gate wall time is ~112 s and growing; the bundle decompile is the single
heaviest repeated unit. Separately, 20 test files hand-roll `readFileSync(...fixtures...)`
instead of `tests/support/fixtures.ts` (19 files use it) — two fixture-loading idioms.
**Fix shape:** a `tests/support/bundle.ts` memoised `decompileRnTemplate(opts)` keyed by
option hash (per-process cache; node --test runs files in separate processes, so also
consider an on-disk cache keyed by (bundle sha, src mtime-hash) — that part needs care,
process-local memoisation is the safe first step and still wins within multi-test files).
Migrating raw `readFileSync` callers to `support/fixtures.ts` is mechanical follow-up.
No spec; test-only. Test count must not drop (baseline 902).

### 3. [M, effort M, needs spec (D12a scope)] Third-copy AST walkers in passes — reg-split's private walker is ~150 lines of re-implemented `ast.ts` traversal

**Area: passes.** `src/passes/ast.ts` owns the shared traversal (`walk`, `mapExpr`,
`walkPattern`, `walkPatternElement`, plus shared queries `identUses`/`registerUses`/`freeNames`
— those ARE well shared: 18 files import `identUses`). But `src/passes/reg-split/match.ts:247-437`
re-implements `walkExpr`/`walkPattern`/`walkPatternElement`/`transformStmtExprs` privately
because it needs an occurrence-kind callback (`(reg, kind, strong, pattern) => rename`)
that `mapExpr` doesn't offer; `src/passes/var-naming/frame.ts:21 walkFrame` is another
partial copy. Every new node kind added to the AST must now be added to 3 traversals or
registers silently stop being seen by reg-split (soundness-adjacent: its checker would
catch a bad rename, but a *missed* occurrence in a new node kind means a missed split at
best, a wrong-classification at worst). `label-clean/match.ts:212` and `harness/tiers.ts:318`
walks are small/domain-specific — fine. `artifact/semantic-walk.ts` is bytecode-level
(different layer, fine) and `tools/artifact/check-index.ts`'s walker **must stay
independent** (spec 10 checker-independence) — explicitly out of scope.
**Fix shape:** extend `ast.ts` with one occurrence-visitor (`mapIdentOccurrences(list, cb)`
carrying kind/strength/pattern context), port reg-split and var-naming onto it. Touches a
sound pass's matcher → D12a spec addendum + checker-verified migration (checkers unchanged).

### 4. [M, effort S, no spec] QUEUE.md is no longer a queue — landed/stale items outnumber live ones

**Area: docs/orchestration.** `docs/QUEUE.md` (96 lines) contains four generations of
structure ("## Now" with a LANDED item, "## TONIGHT (2026-09-02)" fully landed/blocked,
"## PIVOT" — the actual current state, "## Lanes (after cleanup)" referencing rungs that
landed days ago, plus two stale numbered stragglers 15/19 and a duplicate "1." REG-SPLIT
item marked LANDED). An orchestrator popping "the top item" gets a landed metrics item.
This is the direct cause of briefs contradicting reality (~140 commits/day means the queue
rots in hours, not days).
**Fix shape:** mechanical rewrite: move every [DONE/LANDED/ATTEMPTED-BLOCKED] line to
AGENT-LOG/STATUS-ARCHIVE (they're already logged there), keep only live items under the
PIVOT ordering. One lean agent, docs-only, orchestrator reviews. Not done in this sweep —
the concurrent spec-11 agent and in-flight lane items make ordering judgement calls that
belong to the orchestrator.

### 5. [M, effort S, decision needed] `tools/equiv/` (128 K, 10 modules) deprecated at M3, unreferenced by code, still shipped

**Area: tools / write-only artifacts.** Commit `baf9972` ("deprecate tools/equiv in favour
of src/harness") is the last touch; no import anywhere in `src/`, `tests/`, or `tools/`
(only comments: `src/harness/*.ts` headers say "port of tools/equiv/src/*.mjs, unchanged").
It is exactly the "trim write-only artifacts" case from the handoff — **but** deletion is
not trivially safe: `docs/EQUIVALENCE.md` (the M3 design study) says every number in it is
reproducible via `node tools/equiv/selftest.mjs` — deleting the tree breaks that document's
reproducibility claim. Needs a call: (a) delete + reword EQUIVALENCE.md to cite the commit
hash for reproduction, or (b) keep as historical record. Either is a 15-minute docs+`git rm`
task once decided. Same review should sweep `tools/` for other orphans (e.g.
`tools/irreducibility.mjs`, `tools/harvest-hermes-lit.ts` — not verified here).

### 6. [M, effort M, needs spec] `astPassHook` hands passes `fn.body` only — orphan functions never see stage B (existing BUGS row, structural not incidental)

**Area: passes framework seam.** The open BUGS.md row (51-default-params v99): orphans are
inserted into the module's `orphans` list at final assembly (`src/emit/index.ts`), so no
stage-B pass ever touches their `params`; `astPassHook` (`src/passes/index.ts:125`) also
only passes `fn.body`, so `default-params` can't rewrite params even for functions it does
see — it works around this via `pruneRegisterDecls(r.body, fn.params)` special-casing
(`src/passes/index.ts` F15 comment), which is the tell: the hook shape forces per-feature
workarounds in the driver. This sweep's note: fix the *hook shape* (pass the whole `fn`
node, return a whole `fn`), not another workaround, and route orphans through the same
hook. Soundness-relevant (checkers currently check body-lists) → spec.

### 7. [L, effort S, no spec] Error-code discipline stops at the emit boundary

**Area: consistency.** `src/errors.ts` (Hbc2jsError + codes) is used faithfully in
parse/disasm/tables, but newer subsystems throw bare `Error`: `src/split/segregate.ts` (6),
`src/passes/spread-rest/rewrite.ts` (5), `src/deps/apk.ts` (3), 25 sites total across 13
files. A CLI user hitting a segregate bug gets an uncoded stack trace; the `--json` error
paths can't classify them. **Fix shape:** mechanical migration to `Hbc2jsError` with an
`E_INTERNAL`/per-subsystem code, one file at a time; no behaviour change, gate guards it.

### 8. [L, effort S, no spec] Hermesc discovery duplicated 2×

**Area: toolchain plumbing.** `src/harness/roundtrip.ts:56 findHermesc` and
`tests/support/hermesc.ts:17 findHermesc` are parallel implementations of
"find `tools/hermesc/vNN/hermesc`" (plus `tools/pkgsig/bulk/*.mjs` spawn it with their own
path logic). `src/deps/confirm.ts` legitimately differs (npm-install + metro pipeline).
**Fix shape:** tests/support importing the src/harness one (tests already import src freely),
or a tiny `src/util/toolchain.ts`. Low value alone; do it when either file is next touched.

### 9. [L, effort S] `src/split/segregate.ts` is a 1398-line single file (26 functions)

**Area: split.** Largest non-generated file after `passes/ast.ts`; it mixes tree
segregation, naming milestones, and result I/O (`segregateSplitTree`, `readSplitDir`,
`writeSegregateResult`). Not urgent — cohesion is arguably fine — but it is the file most
likely to become unreviewable next time a milestone lands. Split by milestone
(classify / name / write) when next materially edited; do not do a pure-move commit now
(P2.x work is active in this area).

### 10. [L] Micro-duplication / micro-perf noted in passing

- `src/passes/index.ts` `pruneRegisterDecls` calls `identUses(paramInits, n)` twice per
  name in the same boolean expression (line ~117: `.reads + ...writes` re-invokes) — free 2× on that path.
- `src/emit/function.ts:606 _unusedHelpers` — deliberate (spec 05 §2 surface), leave it.
- `harness/fuzz|mutate` vs `fuzzgen/*`: NOT duplication — differential-corpus vs
  generation-grammar, and `tools/fuzz/construct-fuzz.mjs` correctly imports `src/fuzzgen`.
- def-use walkers overall census: passes/ast.ts `defUse` (shared), reg-split flow analysis
  (private, finding 3), `cfg/reg-effects.ts` (bytecode-level, single copy, re-exported by
  `cfg/index.ts` — clean), artifact/semantic-walk (bytecode, artifact-owned),
  check-index (independent by design). Four layers, one true redundancy (finding 3).

## Docs drift (spot-checks)

- `docs/AGENT-BRIEF.md` says "57 constructs × 5 versions", "~70 s", "800+ tests";
  reality: 61 numbered construct fixtures, gate baseline 902 tests, gate wall time
  measured this sweep (see AGENT-LOG line / gate.log). **Fixed in this commit** (brief
  numbers only).
- `docs/QUEUE.md` — finding 4 above (left for orchestrator).
- `docs/STATUS.md` — internally consistent on spot-check; scoreboard rows carry their own
  dates/sources, which is why it survives the commit rate and QUEUE doesn't.

## Not examined (honest section)

- `src/cfg`, `src/structure`, `src/parse` internals beyond export surfaces — M4-era, stable,
  gate-guarded; skipped deliberately.
- `src/deps/*` logic depth (630-line classify.ts etc.) — active P-10/pkgsig lanes own it.
- `tools/pkgsig`, `tools/e2e`, `tools/metrics` invocation liveness — only sampled.
- Runtime helpers (`src/runtime/helpers.ts`) semantics.
- Any dynamic profiling; all perf statements are static reads + existing QUEUE/BUGS numbers.
- `docs/specs/11-project-store.md` (concurrent agent).
- ts-prune raw output is ~90 % false positives here (tests/barrels invisible to it);
  every dead-code claim above was verified by direct grep, the rest of its output was
  discarded, not audited.

## Mechanical fixes applied in this commit

- `docs/AGENT-BRIEF.md`: fixture count 57→61, test count, gate time refreshed.
- Nothing in `src/` — every code finding above is semantic/structural and stays a finding.
