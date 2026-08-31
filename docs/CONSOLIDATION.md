# Consolidation sprint — before rung 8

Source: Fred's external review list (2026-08-31), triaged by the orchestrator.
Purpose: turn "492/492 green" into evidence that survives a fresh set of eyes,
and fix the process debts that made the last two days expensive. Nothing on the
ladder (rung 8+) starts until §A is done. Work runs in the standard two slots
(1 ladder / 1 support) — during the sprint both slots are sprint items.

Verdicts: **adopt** · **adopted** (already in force) · **modify** (adopted with a
change, stated) · **defer** (after the sprint, reason stated). Cost S/M/L is
agent time (S < 30 min, M ~1 h, L multi-agent).

## A. Sprint items (in execution order)

| # | Item | Verdict | Cost | Notes / owner |
|---|------|---------|------|---------------|
| 0 | **Pass pipeline is ~250× slower than baseline on a real bundle** (rn-template 4199 fns: 0.7 s passes-off → >180 s passes-on; PUSHBACK P-1) | adopt (added; not on the external list) | M | Profile, find the superlinear pass, fix. Blocks #2, `--split` passes, CI app-metrics. Fable. |
| 3 | Bisect + fix `01-if-else-chain.min@84/94` wrong output; delete `KNOWN_WRONG_OUTPUT` (`src/harness/tiers.ts:162`); confirm the hang P0 is closed beyond label-clean | adopt | M | `KNOWN_HANGS` is already deleted (e239662); the remaining exclusion is a real wrong-output bug → construct fixture + fix. |
| 1 | Held-out fixtures: 20+ new construct programs by a fresh agent that never saw the build; trace-oracle pass rate reported separately from the 59-fixture number | adopt | M | Fresh Sonnet, `tests/fixtures/heldout/` (own build.sh), report in STATUS as its own line. Fixtures are frozen after the first run; build agents never edit them. |
| 2 | Behavioural verification on a real bundle: per-module recompile-and-diff, or `tools/device-roundtrip.sh` on react-navigation-example | adopt | M–L | Needs #0 first (passes-on decompile must finish). Device run needs the tablet attached — Fred. |
| 26 | Triage the two v99 findings (20-symbol-keyed-properties, 21-class-private-fields) | **done** | S | **21 = real `src/emit` bug** (class getter/setter pair lowered as two half-`undefined` `DefineOwnGetterSetterByVal`; emit's full `{get,set}` clobbers the first half) — reproducer `constructs/58-class-accessor-pair-split` (v98/v99, failing-by-design via `KNOWN_WRONG_OUTPUT`), fix is a separate item. **20 = toolchain/harness artefact**: npm hermesc v99 (`260318099`) emits `HermesBuiltin.setFunctionName` at builtin 55, which the source-built VM (`913d31a`) and the decompiler's table both read as `functionPrototypeApply` — the VM crashes on the original bytecode, the decompiler matches it; same index shift is the real root cause of `VM_LIMITATIONS`. Follow-ups (post-03-18 v99 builtin table + `setFunctionName` emit, matching VM rebuild, `ladder.ts` VM-overrules-Node) in docs/BUGS.md. 02-proxy-trap-counting confirmed PASS at all versions; README status corrected. |
| 24 | Adversarial fixtures 28/29 have wrong `expected.txt` (force-parsed as ES modules) | **done** | S | Claim confirmed (Node-as-script and Hermes v94/v96/v99 all agree against the committed ESM output). Files regenerated (28, 29, plus ESM-frame-tainted 36, 41); gate test `tests/gate/harness/adversarial-expected.test.ts` re-derives every adversarial expected.txt in script mode. |
| 25 | Fixture 36: `ladder.ts` compares printLines projection vs VM raw stdout+stderr → legitimately-crashing programs look divergent | **done** | S | Claim confirmed (36 DIVERGENT at v94/v96/v99 with identical prints, VM side carrying `Uncaught TypeError…`). Both sides now project print lines + `uncaught <Name>` (`printProjection` / `hermesPrintProjection`); regression test `tests/gate/harness/ladder-uncaught.test.ts`; 36 now PASS at all three versions. |
| 4 | Mutation-test the pass checkers (Stryker over `src/passes/*/check.ts`) | adopt | M | The harness proves itself; the checkers do not yet. One agent, report survivors as BUGS rows. |
| 5 | Stage-B framework gap: no sibling/parent-list visibility for AST passes; capping several rungs below spec | adopt | M | One framework change with its own spec section in `src/passes/README.md`; re-measure the capped rungs after. |
| 27 | Gate layout classes A/D, the arm64 build, and the placeholder opcode behind a flag or an "unverified" marker that refuses real input | adopt | S–M | Unevidenced code must not run silently. |
| 28 | Partial bulk sigdb must not be layered into a real DB until baseline subtraction is done — hard check in `tools/pkgsig/fetch-db.sh` | adopt | S | Currently a doc note. |
| 29 | **CI red on `main` since `8f38749` (2026-08-31 ~19:00)**: `npm run typecheck` fails on all build-test matrix jobs and `oracle-hermes-dec` fails at `test:gate`; last green `c6b5f41`. Local gate (`npm test`) does not run `typecheck`, so agents' "gate green" was blind to it | in progress | S–M | (1) DONE by hand 2026-08-31 (3 TS errors + VM-optional skip in ladder-uncaught.test.ts); (2) DONE: `npm test` now runs `typecheck` first (cccd765+1); (3) orchestrator checks CI conclusion on each merge via the public runs API before declaring landed. |
| 30 | **Service NSW end-to-end (2026-09-01)**: whole-file decompile fails at module-level scope-check (`E_UNBOUND_IDENT r15`, zero output) after 452 s; `deps` >10 min; `--split` fine (13 s, no passes). Three BUGS rows dated 2026-09-01. | adopt | M | (1) scope-check isolation per function; (2) profile the 43k-fn superlinear term; (3) profile deps; (4) then re-run this E2E as the real-app benchmark (item 2/18 reuse). Fable. |
| 31 | **Stage-3 feasibility analysis (Fred, 2026-09-01): can a decompiled tree be re-bundled and BOOTED?** Design-only doc `docs/e2e/STAGE3-FEASIBILITY.md`: (a) what the `--split` tree needs to be Metro-loadable (module ids → requires, `__d`/`__r` runtime shim vs rewriting to relative paths, entry/`index.js`); (b) react-native-web path: inventory of native modules actually touched by rn-template and Service NSW (grep `NativeModules`/`TurboModuleRegistry`/`requireNativeComponent` in the split trees), stub strategy, headless-Chrome boot check; (c) device path via `tools/device-roundtrip.sh`; (d) a 30-min spike: try to load rn-template's split tree under Node+jsdom+RN-web with a Metro-runtime shim and report how far it gets; (e) effort/risk table and the recommended first milestone. | adopt — QUEUED next free slot | M | Fable. Launch after JSX or E2E tier 1 lands. |
| 6 | Soften "provably equivalent" in README (`README.md:44`) to what is evidenced until #1 and #2 pass | adopt | S | Orchestrator does this by hand now. |

## B. Testing rules → `CLAUDE.md`, each enforced by a gate test

| # | Rule | Verdict | Notes |
|---|------|---------|-------|
| 7 | No exact-output assertions on shared fixtures; a rung test asserts rung-owned properties or uses a rung-private fixture | adopted (2026-09-01) | Known design debt (every new rung broke the previous rungs' string assertions). Enforced like `tests/gate/passes/imports.test.ts`, in CLAUDE.md + `tests/gate/docs/testing-rules.test.ts`. |
| 8 | Only the spec agent writes tests; any diff under `tests/` is flagged; CI fails if test count or coverage drops | **modified — adopted (2026-09-01)** | The spec agent writes the *acceptance* tests (they ship with the spec, before implementation). Implementers may add regression tests — the "every bug fix ships a test" rule requires it — but every `tests/` diff is listed in the landing report and reviewed. Test-count-drop CI check: `tests/gate/docs/test-count.test.ts` + `docs/test-count-baseline.json` (coverage not measured by this repo's gate). |
| 9 | Golden/snapshot regeneration needs Fred's approval, reviewed as a batch | adopted (2026-09-01) | In CLAUDE.md. Orchestrator queues them; never regenerated inside an implementation task. |
| 10 | No fixture leaves the gate without an issue and an owner; exclusion tables are debt | adopted (2026-09-01) | `tiers.ts` exclusions must cite a BUGS row; enforced in `tests/gate/docs/testing-rules.test.ts` (currently a vacuous pass — no exclusion table exists in `tiers.ts` today). |

## C. Agent workflow

| # | Rule | Verdict | Notes |
|---|------|---------|-------|
| 11 | One worktree per agent; nothing lands red; full gate on a clean checkout of main after every merge | adopted (2026-08-31) | Worktrees under `.claude/worktrees/`; orchestrator merges, gates, pushes. |
| 12 | "Attributable to concurrent work" is not a landing note; reproduce in isolation or fix | adopt | Goes in AGENT-BRIEF. |
| 13 | "Not pushed" is not a state; push on landing | adopted | Orchestrator pushes every landed commit and every WIP branch. |
| 14 | STATUS.md → one screen, fixed template (milestones, gate numbers, open bugs, blocked, decisions needed); narrative → AGENT-LOG | adopt | It is 986 lines today. One Sonnet task; the template goes in `docs/AGENT-WORKFLOW.md`. |
| 15 | Orchestrator restarts from a handoff doc when context fills | adopted | Memory HANDOFF + this doc. |
| 16 | Adversarial reviewers: fresh context, different model family where possible | adopt | Sonnet reviews Fable/Opus work and vice-versa. |
| 17 | Cheap validators produce findings, not verdicts; the suite is the gate | adopt | Reviewer reports list findings; MERGE is decided by the gate + orchestrator. |

## D. Ladder, after the sprint

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 18 | Order rungs by measured construct frequency on real bundles (extend `tools/passes-metrics.mjs` to react-navigation/expensify for every rung) | adopt | Needs #0. Re-orders batches 2/3; specs already written stay valid. |
| 19 | Keep measured-not-hoped floors; show gap-to-spec-target as a number in STATUS | adopt | Part of #14's template. |
| 20 | Full sweep on every merge to main or nightly | adopt | `sweep.yml` exists; make it nightly + on merge. |

## E. Fred's side (not agent work)
21 review in sessions at set times, batch decisions · 22 one afternoon reading loop-cond's match/rewrite/check + ten gate tests · 23 don't run continuously yourself.

## Not adopted / deferred
- Nothing rejected outright. #2's device leg and #22 need Fred physically.
