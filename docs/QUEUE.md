# QUEUE — the orchestrator pops the top item each iteration

One item = one lean agent (Sonnet by default; Fable/Opus only where marked hard). When an item lands: merge → gate → push → its report goes to `docs/reports/<date>-<slug>.md` and one line to `docs/AGENT-LOG.md` (the append-only history). Fred sets direction (`docs/LANES.md`); the orchestrator orders this file.

**Reconciled 2026-09-04** against `git log --since=2026-09-02`, `docs/AGENT-LOG.md`, `docs/STATUS.md`, `docs/BUGS.md` (Open), the 2026-09-0[3-5] reports, `docs/specs/hunt-tooling-backlog.md`, and `docs/UI.md`. Landed items are collapsed to one line with their sha. Items are tagged **LANDED / IN FLIGHT / OPEN / NEEDS FRED**.

---

## STANDING PRINCIPLES (Fred — verbatim, do not delete; reorganise only)

- **[STANDING PRINCIPLE] Hunt-driven tooling (Fred 2026-09-04): capability gaps found during real research ARE the roadmap.** When a live hunt needs something the tool lacks (native ingestion, `string-uses` verb, a scoped decompile, dataflow/taint, guess-confirm deps…), that gap becomes a first-class tool feature — build it INTO the tool, then use the improved tool to do the thing. Real testing/research feeds the build queue; the tool compounds. Don't work around gaps ad hoc without also queueing the fix.
- **[STANDING PRINCIPLE] Fix-first (Fred 2026-09-03 night).** A known-wrong output outranks a new feature: reduce and land the regression before adding capability. Every bug fix ships a regression test or a `docs/BUGS.md` row (CLAUDE.md hard rule).
- **[STANDING PRINCIPLE] Stage ordering (Fred 2026-09-02/04): Stage 2 (analysis/tagging substrate) → Stage 3 (RE UI) → Stage 4 (deobf/dead-code-annotate).** Correct first, readable second, then real apps. Stage-2/3 interleave once their two hard prerequisites (reg-split + Design-D overlay) are in — both landed.
- **[STANDING PRINCIPLE — Stage-2 success criteria, IN ORDER (Fred 2026-09-02): (1) TRUTH, then (2) TOOLS EFFICIENT TO USE, with valuable features.](verbatim)** (1) Truth is never traded away — a real finding, never a decompiler artifact; a sound tool over a fast wrong one; the right scoped context, never less than a correct answer needs. (2) Then efficient to USE — this is NOT rationing total tokens (spending tokens to do good work is fine), it is each tool being cheap to interact with: minimal token/context overhead per operation, exactly the scoped context the LLM needs, compactly, so the loop covers more code before exhausting context. Pursued WITHIN truth and WITHOUT dropping valuable features. A tool that re-parses per call or makes the model read a whole function to answer one question is inefficient to use; a tool that lowers interaction cost by emitting a less-true answer fails truth, which is worse. Each Stage-2 spec states the token cost of USING it and how that stays low.
- **[STANDING PRINCIPLE] FULL AUTONOMY (Fred): no manual ratification; AGENT gates only.** Outward-facing/irreversible (push outside freddygaffey, PRs, external publish, golden regen) still wait for Fred. Orchestrator=Fable (Opus if the Fable bucket is constrained); lean Sonnet impl.
- **[STANDING PRINCIPLE] Cost = TOKENS per landed item.** Each AGENT-LOG row carries a token field; rank so a >4x-median outlier is visible.
- **[STANDING PRINCIPLE — DEPRIORITISED per Fred 2026-09-02] OSS-project name-extraction benchmark.** Fred: "we do not need testing on open source projects and seeing if you can re-extract the names." Keep the existing ratchet as a guard only; do not invest further.

---

## Now — next candidates (ranked)

Concrete, non-overlapping. Model: **Opus** = design/hard/checker-critical or semantic; **Sonnet** = mechanical impl against a settled spec/BUGS row.

1. **`query string-uses <id>` verb — return the use SITES, not just id+count** — *Sonnet*. Hunt-backlog gap #2 ("easy, high-value"); data already sits in `index/string-uses.jsonl` (14 MB). Files: `src/artifact/`, `src/mcp/`, `docs/specs/10` §3.1 / `docs/specs/17`. Why: unblocks every string→code hunt without a whole-function render.
2. **Scoped single-function readable decompile** — *Opus (touches emit/scope isolation)*. Hunt-backlog gap #3 + P2.1a: one function's readable JS today costs a whole-module/bundle run (90 s timeout). Files: `src/artifact/`, `src/cli`, `src/emit` isolation. Why: the LLM-loop token win and per-lead context; also unblocks candidate #3.
3. **`require(N)` dynamic-dispatch points-to / dataflow pass** — *Opus (hard, dataflow)*. Hunt Round-2 DOMINANT gap: `who-calls-by-name` (LANDED `ca0a9cd`) is a superset with false positives; the residue is the receiver's identity when `require(list[N]).method(...)` is register/list-indexed. Files: `src/artifact/`, new dataflow module, `docs/specs/17`. Why: the app's dominant calling convention; blocked B1/D3/A4 leads.
4. **Copy-`envRemap` declaration-site fix — the 2 `_e2192_0`** — *Opus*. Closure-dup leftover 3 (`docs/reports/2026-09-05-ambiguous-closure-env.md` §"Remaining work", item 3): push each copy's `envRemap` through the access set before `ownedEnvSlots`/`envDeclaringFunction` choose where an env's `let` is declared, so a remapped read declares its variable. Files: `src/cfg/env-graph.ts`, `src/emit`. Why: concrete, bounded, and a real unbound-name defect.
5. **destructure array-pattern: nested per-element default** (BUGS 2026-09-02 row) — *Sonnet*. `src/passes/destructure/match.ts` recognises only flat labeled blocks; a default nested inside an array pattern is missed. Sound recompute-and-diff checker; rung-owned assertions.
6. **optional-chain matcher without a base guard** (BUGS 2026-09-02 row) — *Sonnet*. `src/passes/optional-chain/match.ts` `matchBaseGuard` requires every run to open with a base guard; holds at v94, not elsewhere. Rung-owned assertions.
7. **object-literal rung** (BUGS 2026-09-01 row) — *Opus (new rung spec + checker)*. `NewObject`+`PutById` chains come back as `r3 = {}; r3.x = …` instead of an object literal with own-property definitions. Files: `src/emit` / M5 ladder + spec. Why: readability of `src/` module bodies.
8. ~~**native `bridge-module` surface**~~ — **DONE** (BUGS 2026-09-02 row, FIXED 2026-09-04: `src/artifact/native-boundary-packages.ts` + `src/artifact/native.ts` `nativeBoundaryModuleIds`/`buildNativeIndex`). Feeds the NativeModules JS↔native linkage (hunt gap #1); built on by spec 27 (`docs/specs/27-native-side.md`).
9. **AST pattern "template literal containing a quoted string containing `${…}`"** — *Sonnet*. Hunt Round-2 verb: surfaces the WebView-injection anti-pattern (lead C1) bundle-wide. Files: `src/artifact/` pattern-match verb + `docs/specs/17`.
10. **CFG recursion-guard on flat block chains** (BUGS 2026-08-30 row) — *Opus (hard)*. `src/structure/structure.ts` `ramsey` `maxDepth` (1500) overflows V8's real call stack on a long flat chain with no nesting; make the structurer iterative or raise/guard soundly.
11. **Reduce the 4 remaining fuzz DIVERGENT finds to fixtures** (BUGS 2026-09-04 family-F2 row) — *Opus (semantic)*. 3 share the per-iteration-`let`-capture signature (`src/cfg` env/closure graph); 1 (`v99-seed777142`) is a mis-lowered loop condition. Reduce each with a signature-preserving predicate via `tools/fuzz/minimise-live.mjs`, land as a construct/adversarial fixture, move to PASS.
12. **material-top-tabs sigdb coverage** (BUGS 2026-09-02 row) — *Sonnet*. `tools/pkgsig/db` has no `@react-navigation/material-top-tabs`; react-navigation-example module 1611 is a pure barrel/index that goes unattributed. Cheap, closes a classification gap.

---

## IN FLIGHT

- **Campaign runners on deb (own clone).** `deb` is BACK and runs the 8 live `campaign2-*` `campaign-runner.sh` loops (heavy fuzz compute stays on deb per the deb-compute rule; Mac keeps UI + gates). NOTE (`docs/reports/2026-09-05-campaign2-rediff.md`): the live runners were found to be on a checkout PRE-dating the P-16/fix-wave-3 harness fixes and produced stale finds — needs the deb clone refreshed before more compute (NEEDS FRED item below).
- **object-tables verb consumers.** `query object-tables` LANDED (`docs/specs/hunt-tooling-backlog.md`); wiring it into the endpoint-table hunt UI/leads is the follow-through.
- **Bulk sigdb round 2b — registry-driven candidates (lane B).** `tools/pkgsig/bulk/round2b-runner.sh` on `deb`; remaining = measure Service NSW / rn-template attribution once the first incremental assemble exists (record in `docs/DEPS.md`), widen to top ~3000. Publish only when Fred says.

---

## LANDED since 2026-09-02 (collapsed — one line each)

- **SPEC 18 — project storage/integrity/`hbcproj` CLI** — LANDED, SPEC 18 COMPLETE (steps 0–5: `607fe1e`, `d74e4d5`, `30f79eb`, `b57b777`, `6c80598`; review `docs/reports/2026-09-04-spec18-*`). DB=operational store, hash-locked sharded JSON=durable git-tracked authority; `hbcproj` git-style porcelain; pre-commit hook + CI `verify`; content-hash finding ids.
- **SPEC 17 — MCP harness business-logic surface** — LANDED, MCP COMPLETE (`7134a97` finish A, `70fb6ea`/`0f9c984` finish B; provenance tier `5bbdde3`). Read core + leads/search/scan + action tools (request_fidelity_check, recompile_edit, generate_documentation).
- **SPEC 16 — project DB (`.hbcproj`)** — LANDED (`c7afe76` spec, review + projdb steps `607fe1e`/`d74e4d5`/`06f45c7`). SQLite operational store behind a backend interface; JSON fallback.
- **SIGDB migration** — LANDED (import `3c0bfbe`, write-path `78e8f27`; review `docs/reports/2026-09-04-sigdb-*`). Remaining: real-data deb run + export/tiered download (part of round-2b, above).
- **P2.1 artifact format + xref/call-graph index** — COMPLETE 2026-09-03 (`2069f3d` close-out); semantic indexes `f07dc98`, query CLI/checker `2179863`.
- **P2.2 project store** — COMPLETE (spec `a237fe8`, steps through `a803482`; ProjectService + CLI in projdb steps).
- **P2.3 string+secrets indexer** — COMPLETE 2026-09-03 (`a2cf275` finisher: recall 100/100, FP within target; CLI `de0be98`). §3.4 xref gating v1-optional (standing).
- **P2.4 reuse validation** — Lane O LANDED (`c156c58`, two-key gate, recall 100%); Lanes S then M remain OPEN.
- **P2.5 version/decompile diff** — spec+review APPROVED 2026-09-04 (`7023f34`); impl step 0 is a candidate slot; step 7 waits for appgen-2.
- **Var-naming compound** — DONE 2026-09-03 (`a480a4c`, bundle 20.2%). Default ladder work COMPLETE; ladder is opportunistic-only per the PIVOT.
- **Reg-split** — LANDED opt-in + default-on (`docs/reports/2026-09-03-p11b-regsplit-default-on.md`).
- **Metrics scoreboard** — LANDED 2026-09-02 (`tools/metrics/collect.mjs`, `docs/METRICS.md`).
- **Parallelise decompile pipeline part 1** — LANDED (`8d6b06d`, pool correct + byte-identical). Parts 2–3 (stage-B decoupling, per-fn cache) queued; measure NSW stage shares first.
- **Decompile-cache for the gate** — LANDED (`docs/reports/2026-09-03-gate-decompile-cache.md`, cross-process on-disk `cachedDecompile`/`cachedSplitProject`).
- **FIX WAVE — lazyRequire/deferred-require screens invisible to detection** — FIXED 2026-09-04 (`eb8f3ca`, `src/split/segregate.ts`; 0/4 → 4/4; `tests/gate/split/segregate.test.ts`).
- **Fuzz fix-wave families F1–F2** — F1 spread-rest fix (`67062d3`), F2 expr-rebuild for-header (`2daa8f3`, `f0500d0`), budget-cut = INCONCLUSIVE (`b5362b0`), D14 VM-evidence keep (`50b87c3`). Residual 4 finds → candidate #11.
- **Campaign-2 re-diff / real-VM reclassify** — LANDED as docs (`docs/reports/2026-09-05-campaign2-*`, `5d71765`, `bf7774b`, `2c59265`, `9a415f2`): v96 members D14-legit against a real v96 VM (deb); v94/v99 INCONCLUSIVE against Mac VMs; only unsampled v84 members keep the arity/counter rows open.
- **deps evidence-directed matching (part a)** — LANDED (`377abff`, ~27x at scale, 0-divergence bar). Pool (b) + cache (c) HELD. deps-confirm-tool = spec `docs/specs/deps-confirm-tool-IDEAS.md` (needs full spec before build).
- **classify.ts navigator/package-boundary + segregation route-config walk** — LANDED across the segregation BUGS rows (NSW 0 → 176 screens); `/api/segregation` name-recovered module tree (`c61acd1`), persisted off-thread (`06f45c7`).

### Stage-3 UI (spec 22/23) — LANDED
- Stage-3 shell + token-lint gate (`07f2ec5`); action registry wired to menu/palette/keymap (`b30a05b`, `22db122`).
- Real listing: module tree, CodeMirror file view, wired search (`0714fe2`); whole-file view splices renames (`0e00e51`); left-tree virtualised, 10k cap lifted (`9400d5d`, `7e54b56`).
- Screens-first module tree (`188076c`); live activity feed (`53845ca`); AI WorkersPane jobs/presence/accept-reject (`869e5d6`, `f545c4c`, `5385cec`).
- Strings & globals xref panel (`ca761e8`); by-name caller candidates in Xrefs (`5eb0fbe`); inline fn names on xref/string rows (`363b098`).
- Source↔disasm line-map alignment (`c7c9c80`, `08df578`) incl. following the cursor into a nested closure (`894a8e2`, `a5b0e5c`).
- Package panel de-stubbed + `/api/package-id` (`838b990`, `34212f1`); view.fold/unfold/rawHermes (`bb7dfb9`); rename→`reg:F:R` identifier-level (`7d4a318`); Playwright smoke suite (`32c71f3`, e2e fixes `c5303e3`/`4481ba9`).
- UI investigation + aesthetics/libs research docs LANDED (`docs/reports/2026-09-04-ui-investigation.md`, `-ui-aesthetics-libs.md`) — stack/testing recommendation; owner decisions reserved (NEEDS FRED).

### Closure-duplication (report §4) — LANDED, with named leftovers
- Per-creation-context bodies for `W_AMBIGUOUS_CLOSURE_ENV` (`01a2973`, `4285fab`), per-instance placement (`12c547e`, `9d9dcc1`), copies over loop-local envs (`a58ac14`), joined-function LCA hosting (`bc596e3`, `22de7ad`), CreateClosure-nothing-captured fix (`6a418ca`), orphan-placement by cost (`94457f8`). react-navigation-example: 178 ambiguous → 18. Remaining leftovers are candidate #4 (leftover 3) + OPEN/NEEDS-FRED below.
- Global-access fold guards — conditions 5 & 6 LANDED (`5846d92` loop-body clobber / BUGS T14, `8838ddf` pre-guard write / spec 03 §4 condition 6).
- `--split` object-shape resolution across blocks — LANDED (`acff415`, BUGS 2026-08-31).

---

## OPEN (unblocked bug work not yet in the ranked list, and standing lanes)

- **P2.4 Lanes S then M** (reuse validation: Semgrep JS taint on emitted JS; OSV/GHSA match; CodeQL fit; androguard/apktool manifest). Spec `docs/specs/13-reuse-validation.md`.
- **P2.6 Frida hook generation + P2.7 orchestration/verify loop** (last of Stage 2; own-account/in-scope only). Business-logic draft `docs/specs/llm-harness-IDEAS.md`.
- **Native-side ingestion + JS↔native linkage** (hunt-backlog gap #1, biggest): ingest APK native (smali/DEX + resources + manifest + assets) into ONE project; map `NativeModules.<X>.<method>` JS ↔ native impl; label first-party vs third-party. Powers seam bug-finding. Spec 27 in progress (2026-09-05) — `docs/specs/27-native-side.md`; builds on candidate #8 (bridge-module surface, DONE).
- **BUGS Open rows not otherwise scheduled** (see `docs/BUGS.md` "Open"): captured-variable declaration order (2026-09-01, emit-shape); LoadThisNS sloppy-`this` (2026-09-01); register prologue dead `LoadConstUndefined` (2026-09-01); r0=globalThis dead store (2026-09-01, global-access); v98 private-field computed access (2026-09-01); SecretsService DB-backed read path (2026-09-04); several projdb read/export re-scan perf rows (2026-09-04); set_name DB-only (2026-09-04). Each has an owner or a "QUEUE N" citation per the ledger gate.
- **Whole-file O(n²) name bookkeeping** — PARKED (Fred 2026-09-03: whole-file mode only; product/CI use `--split`, 12 s NSW). Touch only if fast whole-file output is ever needed. Fix shape when needed: shard the taken-name set per scope or O(1) per-prefix name allocation.
- **Comment/docs over-production trim** — PARKED, low priority (only when an agent is otherwise idle; keep spec-citing/rationale comments).

---

## SPEC 26 — FULL STAGE-3 IDE (the MVP defaults are retired)

Spec: `docs/specs/26-ui-full-ide.md`. Decision: **D29** (Fred 2026-09-05: *"use the real one from now on"* — specs 19/20/21 recommendations ratified). Ten landings, one lean agent each, ordered so contract-affecting work lands before anything is written against it. NOT re-planned there and not listed here: the key-bindings/settings landing and the spec-25 graph view (both in flight) and spec 23's workers rail (partly shipped).

| # | Landing | Model | Depends on | Spec §2 |
|---|---|---|---|---|
| 26.1 | Live update: in-process `wrote(seq, targets)` bus + shard-addressed delta apply (today an agent's write reaches the Activity feed and no pane) | Sonnet | — | L1 |
| 26.2 | Loopback auth: per-run token, kernel-assigned port, `--no-auth` for the e2e rigs | Sonnet | — | L2 |
| 26.3 | Token layer completion (type ramp, elevation, borders, shared syntax palette) + `docs/ui-refs/` + lint extended to spacing/type | Sonnet | — | L3 |
| 26.4 | listing-2: hierarchical screens tree + navigation arrows, over a new `GET /api/screens` | **Opus** | 26.1 | L4 |
| 26.5 | Virtualised sortable result tables everywhere; delete `LeftPane.tsx`'s silent `slice(0,100/200)` caps | Sonnet | 26.3 | L5 |
| 26.6 | Findings/leads full workflow: status transitions, evidence state, lead→finding promotion, per-target history | Sonnet | 26.1, 26.5 | L6 |
| 26.7 | The two missing test layers: DOM tests + visual baselines + kitchen-sink route (**baselines need Fred**) | Sonnet | 26.3–26.6 | L7 |
| 26.8 | Worktree/scratch sandbox for `recompile_edit` + the attended UI flow (**needs Fred**) | **Opus** | 26.2 | L8 |
| 26.9 | Graph CFG mode + `GET /api/fn/{fn}/cfg` (spec 25 §7's named follow-up) | **Opus** | graph landing | L9 |
| 26.10 | Workspace: URL-addressed selection (kills the `fn ?? 0` console error), multi-panel docking, saved layouts | Sonnet | 26.5, 26.6 | L10 |

Each landing names its acceptance test files and exact test titles in spec 26 §2; the implementer creates the file and bumps `docs/test-count-baseline.json` once, re-derived from committed HEAD.

---

## NEEDS FRED (morning decisions)

1. **Golden/snapshot regeneration batch.** The orchestrator queues regenerations; regen needs Fred's approval, reviewed as a batch (CLAUDE.md testing rules). Nothing regenerated inside an impl task.
2. **`MIN_HOSTED` sweep ratchet** dropped 100 → 10 by design (`docs/AGENT-LOG.md` 2026-09-05: placement now has almost nothing to place). Confirm the new floor is the intended standing bar (with new `MIN_DUPLICATED`/`MAX_STILL_AMBIGUOUS`).
3. **The 18 unaligned closure chains** (`docs/reports/2026-09-05-ambiguous-closure-env.md` leftover 4, 19 of the 26 residual unbound names). Decide: chain alignment by *owner function* rather than position, OR leave them as `W_AMBIGUOUS_CLOSURE_ENV` forever, recorded in `docs/DECISIONS.md`. Fred, not an implementer.
4. **`namesAgreeAcrossSites` trade** (leftover 7, the 3 `_fn<n>` children that stay behind). Either one instance per creation context (per-instance `parentOf`) or a creation-based `lexicalSubtree` so the join never fires for them and they duplicate instead — a `src/cfg/**`/whole-emitter change needing its own spec. Fred's call on which.
5. **Graph-view library: dagre vs elkjs — DECIDED 2026-09-05 (delegated to the orchestrator by Fred): React Flow (`@xyflow/react`, MIT) + `@dagrejs/dagre` (MIT); elkjs rejected (EPL-2.0). Recorded as `docs/DECISIONS.md` D28, implemented per `docs/specs/25-ui-graph-view.md`.** Still reserved for Fred: the rest of the UI stack in that report (art-direction seed, token format, reference set/match strictness, lint hard-fail vs warn).
6. **Refresh the deb clone before more campaign-2 compute.** The live `campaign2-*` runners are on a checkout pre-dating P-16/fix-wave-3 (`docs/reports/2026-09-05-campaign2-rediff.md`), so their finds are stale. Approve pulling deb's `~/hbc2js` current before relaunching, and confirm which campaigns continue.
7. **v84 members of the arity/arguments-aliasing and counter-inc-dec-reset rows** (`docs/BUGS.md` 2026-09-05, both `open`): v94/v99 reclassified INCONCLUSIVE, v96 D14-legit; only the unsampled v84 members keep both rows open. Decide whether to obtain/point a v84 VM to close them or accept them as INCONCLUSIVE.
8. **Fixture 47 (`tests/fixtures/adversarial/47-spread-non-iterable-message`) registration.** The fix (`228c53c`, `9a415f2`) placed it in `adversarial/` because a `constructs/` home would need a `KNOWN_DIVERGENT_FIXTURES` entry in `src/harness/reference-policy.ts` — tried and reverted (its ratchet test is out of scope for a shared-tree task). Decide whether to register it properly.
9. **INCONCLUSIVE rate.** With INCONCLUSIVE never counted as PASS (D-rule) and several campaign-2 families now INCONCLUSIVE, decide the target/threshold for the scoreboard's INCONCLUSIVE column and whether it gates.
10. **`--split` per-module isolation failure-mode.** `acff415` resolves object shapes across blocks for `--split`; confirm the standing policy for a module that still fails isolation under `--split` (stub-and-continue vs fail-closed), since `--split` is the product path.
11. **Nested-closure disasm-follow default.** `894a8e2` makes the disasm pane follow the cursor into a nested closure (spec 05 §16.2). Confirm this is the default behaviour (vs opt-in) for the shipped UI.
12. **Static-proof finding confirmation** (carried from spec 17 / spec 11 §4.1): `open→confirmed` currently requires a DYNAMIC evidence ref, so a statically-provable finding (parsed-but-never-checked signature, hardcoded key) can't reach `confirmed`. Decide whether to allow confirmation via a fidelity-checked STATIC proof — touches spec 11's finding-status model.
13. **Delete-or-keep deprecated `tools/equiv/`** (128K, provably unimported since M3 `baf9972`; 2026-09-03 sweep finding 5). Deletion requires rewording `docs/EQUIVALENCE.md`'s reproducibility claim.
14. **UI art-direction seed** (spec 26 §4.1, spec 20 §1.5) — the one input the whole aesthetics playbook rests on. Any ONE of: edit `ui/themes/dark.json`'s ~20 values, name a theme ("Darcula-like"), or drop 2–3 reference screenshots into `docs/ui-refs/`. Blocks landing 26.3's values (not its structure).
15. **Visual-baseline approval** (spec 26 §4.2) — landing 26.7 wants the FIRST commit of Playwright screenshot baselines; golden artifacts, so Fred approves the batch (CLAUDE.md testing rules).
16. **`recompile_edit` from the UI** (spec 26 §4.3, spec 17 §13, spec 21 §5.2) — may the UI drive the one operation that produces a modified binary, and is its sandbox a git worktree or a temp copy? Blocks landing 26.8.
17. **First-run information hierarchy** (spec 26 §4.4, spec 20 §1.6) — which panes are open on opening a project, what is one click vs three. One sentence or one screenshot; landing 26.10 implements whatever it says.

---

## Reference — the full Stage plan (Fred's roadmap text, kept for provenance)

### PIVOT (Fred 2026-09-03 morning): STAGE 2 TOOLING IS NOW THE PRIORITY
Fred: remaining rungs "aren't strictly necessary — the main body of most of the code reads quite nice." The ladder is OPPORTUNISTIC-ONLY: remaining rungs (for-in/for-of, try-clean, arguments-form, literal-forms, try-shape; hard: generators/async, class-recover, finally-dedup, closure-naming) are picked up ONLY when a Stage-2 need or fuzz finding demands one — no default ladder lane. Default lane = the Stage-2 sequence (P2.1 → P2.7), each a researched spec by a stronger agent behind a decision-8 spec+review gate; testing-lane leftovers slot in as the second agent when disjoint.

### STAGE 2 — Analysis & tagging environment (roadmap: docs/specs/re-tooling-roadmap-IDEAS.md)
P2.1 artifact format + xref (gates everything) → P2.1a efficient renaming tool → P2.2 project store (SQLite behind a backend interface; JSON fallback → SQLite default → Postgres only if real concurrency demands) → P2.3 string+secrets → P2.4 reuse validation → P2.5 version diff → P2.6 Frida hooks → P2.7 orchestration/verify loop. Set aside (documented): Ghidra/IDA/BinDiff native-address tools — wrong fit for a JS VM; revisit only if a native component enters scope.

### STAGE 3 — Ghidra-like RE UI (Fred 2026-09-04)
A graphical RE front-end over the Stage-2 substrate; consumes the SAME project-DB + sharded-file read/write API as the MCP (one backend contract; UI == graphical MCP client). Surface: function/module navigator, source + raw-disasm views, xref panels, call-graph/CFG view, evidence-gated rename/comment/tag/finding write UI, search, leads/security-sinks panel. Human-editing UI (spec 18) lives here. **Post-UI hunt-driven tooling backlog: `docs/specs/hunt-tooling-backlog.md`** (native ingestion + JS↔native linkage [top], `string-uses` verb, scoped single-fn decompile, xref dynamic-dispatch, artifact/tree drift→spec18). Cycle: hunt→gap→build→hunt-better→repeat.

### STAGE 4 — Deobfuscation + dead-code (AFTER Stage 3)
Lowest priority. Deobfuscation: string-array-decode + the other obfuscation rungs (spec-then-implement). **Dead-code = ANNOTATE, NOT DELETE** (security-critical, Fred): truly-dead → TAG "provably-dead" in the project store (a removed check is a vuln lead), NEVER delete; reachable-but-not-from-UI (hidden admin/debug/feature-flagged routes) → SURFACE as a FINDING. Built on Stage-2's xref/project-store.

### Parked (needs Fred)
- reg-split rung (P-6) — LANDED default-on; the standalone rung item is retired.
- Device round-trip on a real app (tablet).
- Add clonable OSS apps (Expo examples) to the OSS ground-truth benchmark — deprioritised (see standing principle); network/build work for `deb`.
