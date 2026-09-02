# QUEUE — the orchestrator pops the top item each iteration

One item = one lean agent (Sonnet by default; Fable only where marked hard). When an item lands: merge → gate → push → its report goes to `docs/reports/<date>-<slug>.md` and one line to `docs/AGENT-LOG.md` (the append-only history). Fred sets direction (`docs/LANES.md`); the orchestrator orders this file.

## Now
- **[LANDED 2026-09-02, tools/metrics/collect.mjs + docs/reports/metrics/scoreboard.md + docs/METRICS.md — baseline row captured pre-reg-split-default-on; run at each landing/day] METRICS SCOREBOARD — standing, one row per day (Fred 2026-09-02: project runs a few more days, start collecting NOW; trends > snapshots).** Append-only table (extend the STATUS scoreboard / `docs/reports/metrics/`), a small collector script + a scheduled or landing hook. Collect:
  - **velocity/cost** — commits/day, and **tokens + $ per LANDED item, model mix, cost-per-test-added** (the cost-ordering feature: attribute spend to the queue item/commit in AGENT-LOG, then RANK — so "keep costs down" becomes "this item is 4x the median, look at it").
  - **volume** — LOC by category, comment %, docs:code ratio.
  - **goal proxies** — registers-named %, unresolved-env markers, `node --check` failures, rungs X/30.
  - **truth guard** — trace-oracle DIVERGENT count (must stay 0), test-count vs baseline, open BUGS.md rows.
  - **corpus/truth** — pass MATRIX per Hermes-version & bundler, # map-bearing apps, naming/structure accuracy on the ground-truth set, held-out vs held-in delta.
  Baseline snapshot (2026-09-02): src hand-written 24,754 code / 8,090 comment (24.6%); tests 14,068 / 3,754; 482 commits; **1 source map / 895 bundles** (ground-truth is the gap — see corpus note). Lean.
## TONIGHT (Fred GO 2026-09-02 ~22:15 Sydney) — TWO LANES, MAX 2 AGENTS (one per lane), NEVER 3
**METRICS FIRST (Fred ~22:30: "other metrics in place, I would do that first — then you've got better data"): the metrics scoreboard collector (## Now item) lands BEFORE any ladder change, capturing tonight's BASELINE row while reg-split is still opt-in.** Salvage candidate: origin/worktree-agent-a99810bd07c13c086 has an unmerged tools/app-metrics.mjs (written, never run).
If both slots are busy, WAIT — never launch a third. NO deobfuscation rungs (Stage 3, after Stage 2).

**Lane L — ladder (one lean Sonnet agent at a time):**
1. [DONE 2026-09-02, 9110fb9 — 7.7-10.7x, checker defUse recompute was the real cost] P-11a reg-split perf.
2a. [LAUNCHED 2026-09-03] STAGE-BOUNDARY REORDER + FLIP (Fred approved): move renaming rungs (reg-split, then var-naming) to run AFTER all structure-recovery rungs; flip reg-split default-on; write the 'structure before renaming — keep it in computer language until the end' invariant into DECISIONS + 00-LADDER; resolves the P-11b blocker below.
2b. MATCHER MIGRATION (standing, Fred agrees w/ CONSOLIDATION §B spirit): future pass specs MUST match def-use/value flow, not register identity (reviewer-enforced); gradually migrate highest-risk existing matchers, jsx-recover first. Lane L, low priority per slot availability.
2. [ATTEMPTED 2026-09-03, BLOCKED — 1a44914: default-on breaks jsx-recover (cross-pass bug, BUGS row w/ repro); regex widenings kept; flip reverted] P-11b NEW SHAPE: fix the reg-split x jsx-recover interaction (matcher sees through rN_j renaming, or reorder reg-split after jsx-recover), verify 59-jsx-runtime-calls v94/v99, THEN flip default-on.
3. var-naming compound: name the split ranges (loop->i, arrays, usage/alias/literal heuristics per reg-split spec s9 Q4; optionally a 2nd expr-rebuild pass). Target: registers-named 3-4% -> >=15% on rn-template + a real bundle.
4. Non-deobf body-cleanup rungs: literal-forms, try-clean, arguments-form, for-in/for-of. Each: lean, sound checker, corpus-guard clean.

**Lane T — testing decisions 1-4 of docs/orchestrator-handoff-2026-09-02.md (one agent at a time):**
1. [SPEC LANDED 2026-09-02, docs/specs/09-fuzzing.md, 4f39240 — now in step 2 review] SPEC (Fable): construct-level fuzzer (random valid JS -> hermesc -> decompile -> trace-compare, oracle-backed) + app-generation fuzzer (generate app SOURCE + BUILD config: vary framework / bundler [Metro plain/RAM, Expo] / router / libs / Hermes+RN version / obfuscation -> build -> (bundle, map, source) ground-truth triples; rotate a SAMPLE per run, reject same-app-N-times) + blind held-out set (some generated + some existing apps, never tuned against). Spec MUST state metric + target number + measurement method + held-out check (decision 8).
2. [DONE 2026-09-02, APPROVED w/ edits E1-E4, e4da11d — 0-novel-divergence bar; v98 confirmed; reports gitignored] REVIEW gate (Fable).
3. IMPL construct-level fuzzer (lean Sonnet). 4. IMPL app-generation fuzzer (lean Sonnet). 5. Wire held-out set + pass MATRIX per Hermes-version x bundler into the corpus harness.
**When Lane T's fuzzers are landed and generating unique bundles, Lane T's slot joins the ladder (both slots on Lane L, still max 2 / prefer 1).**

P2.1 artifact-format+xref spec: AFTER the above are moving (morning). Corpus regression harness guards every change.

## PIVOT (Fred 2026-09-03 morning): STAGE 2 TOOLING IS NOW THE PRIORITY
Fred: remaining rungs "aren't strictly necessary — the main body of most of the code reads quite nice." After the two in-flight agents land (stage-boundary reorder + P2.1 spec):
1. VAR-NAMING COMPOUND still runs (orchestrator judgment: the payoff of reg-split, one agent, biggest visible win). Target registers-named >=15%.
2. Then LADDER GOES OPPORTUNISTIC-ONLY: remaining rungs (for-in/for-of, try-clean, arguments-form, literal-forms, try-shape; hard: generators/async, class-recover, finally-dedup, closure-naming) are picked up ONLY when a Stage-2 need or fuzz finding demands one — no default ladder lane.
3. DEFAULT LANE = STAGE 2 sequence: P2.1 review gate -> P2.1 impl (artifact+xref) -> P2.2 project store -> P2.3 string/secrets indexer -> P2.4 reuse validation (Semgrep/OSV vs deps) -> P2.5 version diff -> P2.6/P2.7. Decision-8 spec+review gate for each. Stage 3 (deobf + dead-code-annotate) after Stage 2, unchanged.
Testing lane leftovers (app-gen fuzzer impl, divergence triage, held-out wiring) slot in as the second agent when disjoint.

1. **[LANDED 2026-09-02 — implemented opt-in; default-on + var-naming now tracked as Lane L above] REG-SPLIT**. Write docs/specs/passes/19-reg-split.md (Fable, design): a stage-B pass that runs BEFORE var-naming and splits each register's DISJOINT live ranges into separate variables, so a reused `rN` (Hermes reuses one register for unrelated values — why var-naming only reaches ~3%) becomes `rN`, `rN_2`, `rN_3`, each then nameable. Confirm the real IR shape on 04-for-loop-basic/a real module via --emit-tree; matcher = live-range analysis over the frame; writer = fresh var per range; checker MUST be sound (a split preserves every read's reaching def — recompute-and-diff / SSA-style verification; this is correctness-critical). Metric: registers-named % on rn-template + a real bundle before/after (target: big jump from ~3-4%). Then implement it (separate agent) + re-run var-naming. THIS is what makes the code inside src/ stop looking like assembly.
1. **B — classify.ts package-boundary fix (P-10, product)**: @react-navigation barrel/index files are misfiled to `src/` instead of `node_modules/@react-navigation/` — they get counted as app navigators. Fix classify.ts / the deps package attribution so a package barrel/index module files under node_modules. This will CHANGE react-navigation-example pins (its 4 mis-counted navigators move to node_modules — a CORRECTION, update the assert.equal pins to the corrected numbers + document why in P-10). Then the fuller navigator-detection fix (drop bare re-exports) can land without regressing. Improves BOTH classification accuracy and navigator naming. Hard: prove via the .map that the moved modules really are @react-navigation source.
- **C — spread-rest rung (spec 17, after:destructure) then optional-chain (18)**: implement per spec, sound checker, RUNG-OWNED assertions. src/passes/.
- **Perf part 3 — `passes/ast.ts` `expressionOnlyCheck` → `defUse(after)`** full-list walk per site (order check needs a global position; needs incremental state, soundness-sensitive). NSW whole-file 563 s / split 512 s on deb today; target < 120 s.

- **[IN PROGRESS, launched 2026-09-02] Bulk sigdb round 2b — registry-driven candidates (lane B)**: `tools/pkgsig/bulk/candidates.mjs --registry` (registry search + downloads ranking + per-package version-history fetch, cached, resumable) + `continue-bulk.sh` (reused unchanged via `HBC2JS_BULK_ROUND_TAG=round2b`) chained by `tools/pkgsig/bulk/round2b-runner.sh`, running unattended on `deb` — first `--top 500` proof slice launched, not yet measured. Resume/status/widen commands + design: `docs/DEPS.md` "Round 2b". To resume after any interruption: `ssh -f deb 'setsid bash ~/hbc2js-bulk/round2b-runner.sh < /dev/null > /dev/null 2>&1'`; to widen to the full top ~3000: same command with `HBC2JS_ROUND2B_TOP=3000` prefixed. Remaining: measure Service NSW/rn-template attribution once the first incremental assemble exists, record in DEPS.md, widen to 3000. Publish only when Fred says.

## Lanes (after cleanup; rotate A→B→C)
- **C — Implement batch-3 rungs (specs now exist)**: implement destructure (spec 16), then spread-rest (17, after:destructure), then optional-chain (18) — one lean Sonnet agent each, sound recompute-and-diff checker per spec, RUNG-OWNED test assertions, full gate green. 13→16 rungs.
15. B — `--split` passes default-on now that they're fast (branch a489f29 landed the option) + wire remaining passes; drop origin/worktree-agent-aa57ac33c4ce367cb.
19. C — next rung (NOT reg-split — needs Fred's decision, PUSHBACK P-6).
20. A — Tier 2: RN-web boot loop (from 14's plan).
22. **Parallelise `deps`** (not a bug — Fred: brute-force hashing of 43k fns vs 32k sigs is expected to take minutes): worker pool per module chunk, cache fingerprints keyed by bundle sha256, report progress. Goal: Service NSW well under 10 min on this Mac.
21. Held-out fixtures finish (1) from origin/worktree-agent-a95cf9a2d5716d76b.


## FROM FRED'S DECISIONS (docs/orchestrator-handoff-2026-09-02.md, 2026-09-02) — fold into the stages
- **[TESTING, high — MUST] Construct-level fuzzer**: random valid JS → hermesc → decompile → trace-compare (oracle-backed). Unbounded faithfulness coverage beyond hand-built fixtures. Stage-1/cross-cutting.
- **[TESTING, high — MUST] App-generation fuzzer**: generate app SOURCE + BUILD config (vary framework/bundler [Metro plain/RAM, Expo]/router/libs/Hermes+RN version/obfuscation) → build → `(bundle, map, source)` triples = GROUND TRUTH for naming/structure (fixes the 1-map/895-bundle gap). Rotate a SAMPLE per run (never full matrix; reject same-app-N-times).
- **[TESTING] Blind held-out set**: hold out some generated + some existing apps; never tune against them; measure generalisation there.
- **[TESTING] Corpus = fix ground truth not count**: keep the 27 ~as-is; grow map-bearing apps 1→~8-12 via the app fuzzer; report a pass MATRIX per Hermes-version × bundler, not one aggregate.
- **[PROCESS] Metrics scoreboard, one row/day** (trends over snapshots). Standing.
- **[PROCESS] Cost = TOKENS per landed item**: AGENT-LOG row carries a token field; rank so a >4x-median outlier is visible. (Already logging tokens in recent rows — formalise the field.)
- **[PROCESS] Scheduled /simplify + /code-review sweep** (whole-repo, on a cadence) to counter design-debt at ~140 commits/day.
- **[PROCESS, GATE] Specs must carry a measurable TARGET**: spec-agent states metric + target number + measurement + held-out check; a Fable REVIEWER agent verifies the spec has it and the target is sane BEFORE implementation launches. Replaces human ratification (full autonomy).
- **[MODE] FULL AUTONOMY**: no manual ratification; AGENT gates only. Outward-facing/irreversible (push outside freddygaffey, PRs, external publish, golden regen) still wait for Fred. Orchestrator=Fable (Opus if Fable bucket constrained); lean Sonnet impl.

## STAGE 2 — Analysis & tagging environment (RE / bug-finding; Design D naming overlay belongs here) (roadmap: docs/specs/re-tooling-roadmap-IDEAS.md, Fred 2026-09-02)
**Stage-2 success criteria, IN ORDER: (1) TRUTH, then (2) TOOLS EFFICIENT TO USE, with valuable features.** (1) Truth is never traded away — a real finding, never a decompiler artifact; a sound tool over a fast wrong one; the right scoped context, never less than a correct answer needs. (2) Then efficient to USE — this is NOT rationing total tokens (spending tokens to do good work is fine), it is each tool being cheap to interact with: minimal token/context overhead per operation, exactly the scoped context the LLM needs, compactly, so the loop covers more code before exhausting context. Pursued WITHIN truth and WITHOUT dropping valuable features. A tool that re-parses per call or makes the model read a whole function to answer one question is inefficient to use; a tool that lowers interaction cost by emitting a less-true answer fails truth, which is worse. Each Stage-2 spec states the token cost of USING it and how that stays low.
INTERLEAVE WITH PHASE 1 (Fred 2026-09-02: some Phase-2 tooling > finishing the ladder — start earlier). The ONLY hard prerequisites are reg-split (readable code) + Design D overlay ({fn,reg} addressing) — both in flight. The MOMENT those two merge, run Phase-2 tooling IN PARALLEL with remaining ladder rungs (do NOT wait for rung 30). P2.1 artifact-format+xref spec is the first Phase-2 launch. In order — each is a RESEARCHED SPEC by a STRONGER agent (Opus/Fable), in the Design-doc style, NOT an implementation until specced:
- **P2.1 ARTIFACT FORMAT + xref/call-graph index (GATES EVERYTHING — spec this FIRST, concretely)**: hbc2js's output contract becomes a structured artifact = rendered source + an index keyed to `{fn,reg}`/`fnIndex`: who-calls (call graph), string→use-site xref, global-read-where, native surface, module graph. Every analysis tool consumes THIS, never hbc2js internals. Pin the format down first (§7). Ours (touches Hermes/ids).
- **P2.1a IMPROVE THE RENAMING TOOL (Design D overlay) so it is EFFICIENT TO USE — low token/context overhead per operation (NOT token rationing): the loop should spend context on finding bugs, not on re-parsing/guessing/whole-function renders (hands-on test 2026-09-02; overlay v1 is CORRECT, but the loop AROUND it is slow + context-hungry)**. Evidence: one CLI `name set` = **1.23 s** on a 3 KB fixture — cold node + a full bundle RE-PARSE *per call*; scales terribly on a real bundle (~300x-heap parse every call). Fix set:
  - **(a) THROUGHPUT** — the loop must drive the resident `NameService` (parse once, frames stay warm), NOT the per-call CLI; add a **batch set** (many `{fn,reg}`→name in one warm pass) to the API + CLI. Independent of xref — quick win.
  - **(b) DISCOVERY/CONTEXT** (mostly lands WITH P2.1 xref) — add `name list <fn>` (the live, *nameable* registers, so the LLM stops guessing dead regs — a test call was wasted on `{0,9}` = `no-binding`) and `context {fn,reg}` (its defs/uses/assigned-from). Today the ONLY way to see a register's context is to render the WHOLE function. The gate ALREADY computes each register's role/uses (that is how it decides `reuse-conflict`/`no-binding`) — EXPOSE that instead of making the caller re-derive it.
  - **(c) VERIFY** — a targeted "render only the lines using `{fn,reg}`" or a rename-diff, so confirming one name is not a full-function render.
  - **(d) CHEAP DOC FIX** — `--help` omits `name`/`render` entirely (only RENAME.md documents them); an agent exploring via `--help` never finds them.
  Lean; (a)+(d) are quick wins independent of xref, (b)+(c) fold into P2.1. Full findings: this session's test of the overlay.
- **P2.2 project store** = the Design-D overlay generalized to hold comments, tags (source/sink/reviewed/suspicious), bookmarks, findings on the same ids. Our Ghidra-project/IDA-db. (Naming overlay = one record type in it.)
- **P2.3 string + secrets indexer** (string-table→use xref + entropy/pattern scan) — cheap, high hit rate, run first on a bundle.
- **P2.4 REUSE validation (not build)**: Semgrep JS taint on emitted JS; OSV/GHSA match against src/deps/ output (strongest reuse → realistic CVE outcome); CodeQL licensing/fit; androguard/apktool for manifest (exported components/permissions/deep-links). Spec = hands-on validation of each per §4/§7, not new tools.
- **P2.5 version/decompile diff** keyed to binding ids (new endpoints, removed checks between app versions) — high-leverage bug finder.
- **P2.6 Frida hook generation** (static→dynamic, keyed to fnIndex; own account/in-scope only) + **P2.7 orchestration+verify loop** (LLM bug-finding driver over all the above; decompilation-fidelity check so a "bug" is never an artifact). Last.
- Also missing from the sketch (add when speccing): type/shape recovery, protocol/wire-format reconstruction, coverage-guided input gen, a disclosure findings/report format.
Set aside (documented): Ghidra/IDA/BinDiff — native-address tools, wrong fit for a JS VM; revisit only if a native component enters scope.


## STAGE 3 — Deobfuscation + dead-code (AFTER Stage 2's analysis & tagging, Fred 2026-09-02)
Lowest priority; only after Stage 2 is standing.
- **Deobfuscation**: string-array-decode (obfuscator string-array accessor `_0x..(i)` → literal) + the other obfuscation rungs. Hard rungs, spec-then-implement.
- **Dead-code = ANNOTATE, NOT DELETE** (security-critical, Fred): truly-dead (no path can reach it) → TAG "provably-dead" in the project store (a removed check is a vuln lead), NEVER delete. "Reachable-but-not-from-UI" (hidden admin routes/debug/feature-flagged — LIVE, attacker-reachable) → SURFACE as a FINDING (orphan-but-live handlers, registered-but-UI-unreachable routes). Built on Stage-2's xref/project-store, hence Stage 3.

## Parked
- **[DEPRIORITISED per Fred 2026-09-02] OSS-project name-extraction benchmark**: Fred: "we do not need testing on open source projects and seeing if you can re-extract the names." Do NOT add more OSS apps to oss-benchmark.mjs / expand name-accuracy validation. Keep the existing ratchet as a guard only; do not invest further.
 (needs Fred)
- reg-split rung (P-6) — unlocks real variable names.
- Device round-trip on a real app (tablet).
- **Add clonable OSS apps (Expo examples) to the OSS ground-truth benchmark**: `tools/e2e/oss-benchmark.mjs`'s `APPS` array today has react-navigation-example-0.85.3 (scored, has a `.map`) and rn-template-0.72 (pipeline-only, no `.map`). Adding 2-3 more (an Expo example, a small react-navigation demo) needs cloning + building each with `npx expo export`/Metro to get a fresh bundle+map pair — network/build work `deb` would normally do, and `deb` is down as of 2026-09-02. Docs: docs/e2e/OSS-BENCHMARK.md "Adding an app".
