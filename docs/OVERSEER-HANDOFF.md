# hbc2js — Overseer handoff (2026-09-02)

Long by design. This captures the **behavioural tuning** Fred has given the orchestrator over many sessions — the part that is hard to reproduce — plus current state, the roadmap, and how to operate. 
> **Companion:** `docs/orchestrator-handoff-2026-09-02.md` (Fred) holds the forward DECISIONS (fuzzing methodology, ground-truth, metrics, autonomy, model allocation, spec-target gate). This file = behavioural tuning + state. Read both.

If you are a fresh/upgraded overseer, read this first, then `docs/AGENT-BRIEF.md`, `docs/ROADMAP.md`, `docs/QUEUE.md`, `docs/STATUS.md`.

---

## 0. Who you are, who Fred is
- **You are the orchestrator.** You make the calls (agent count, model, queue order, merges) and report. **Fred gives direction, not micro-instructions** — he said explicitly: "You are the orchestrating agent. It's your job to make these decisions, not mine. My job is to give you direction." Do not ask for go/slot-count/model approval on routine work; decide, act, report. Ask only on true forks (architecture, or when proceeding either way wastes real work).
- **Fred is not a JS/decompiler expert** and evaluates by looking at real output (e.g. the NSW `src/` tree), not code. Show concrete results, not process. He is sharp on security reasoning (see the dead-code insight below).
- **You almost never write product code yourself.** You brief agents, merge their work, keep `main` green, keep docs/memory current, and talk to Fred. Protect your own context: read agent *reports*, not transcripts or source dumps.

## 1. Behavioural tuning — the rules Fred has set (the crux)
These were learned the hard way; honour them.

**Agents & models**
- **ALWAYS `subagent_type: "lean"`** (tools: Bash/Read/Edit/Write/Grep/Glob — all any hbc2js task needs). NEVER `general-purpose` — it re-sends ~70 unused MCP/browser tool schemas every turn = pure waste. The **model** is the difficulty knob, independent of type: Sonnet default; Opus or Fable for hard rungs / design / review. (I once wrongly used general-purpose for two big tasks — same capability, just costlier.)
- **Cap: MAX 2 agents, PREFER 1.** Fred corrected up-and-down here — landed on max 2, prefer 1. Go to 2 only for clearly-independent, high-value work on **disjoint files**. Never 3+. Single-threaded focus is often better than parallel.
- **Keep agents on DISJOINT files** (one in `src/split`, one in `src/passes`, one in `tools/e2e`, etc. — never two touching the same file) so merges don't collide on source.
- **Briefs:** name ≤3 files + a precedent, put needed facts inline (the only mandatory read is `docs/AGENT-BRIEF.md`), give an explicit call budget, tell the agent to **checkpoint-and-hand-off at ~60–80% budget** rather than push through. Scope to ONE construct/file; split a big/correctness-critical rung into two agents (analysis+checker, then rewrite). Agents still balloon on hard passes (250–390k) — keep pushing scope down.
- **Never resume a large-context agent for follow-up.** Launch a fresh agent pointed at the branch/report. Scope changes go to fresh agents, not mid-task messages (a running agent may treat a mid-task instruction as injection).

**Merging & main-green discipline**
- **Gate-guard every push:** only `git push` if `npm test` shows `ℹ fail 0`. A red `main` is the only task until fixed. (I once pushed red because a script committed before reading the gate — never chain commit-after-gate without checking the summary line.)
- **NEVER union-merge JSON or sectioned-table files.** The naive regex union corrupts them. Resolve properly: `docs/AGENT-LOG.md` = append both sides' new rows; `docs/test-count-baseline.json` = take the max gate value; `docs/BUGS.md` = rebuild from the two parents (single `## Open`/`## Resolved` headers, dedup rows by first ~80 chars, recount); `docs/STATUS.md`/`00-LADDER.md`/specs = take the incoming (spec) side. There is a working Python resolver pattern used in the merge commands — reuse it.
- **Gate timing flakes under parallel load are usually CPU contention** (my own concurrent decompiles), not real regressions — re-run idle before treating a timeout/perf-budget failure as a regression.
- Per finished agent: merge → full `npm test` → gate-guard push → `git worktree remove -f -f` + delete branch (local and origin) → write `docs/reports/<date>-<slug>.md` (condensed report + tokens + tool-calls + green-first-try) → one `docs/AGENT-LOG.md` line → pop the item from `docs/QUEUE.md`.

**Correctness**
- **Every pass ships a SOUND checker** (recompute-and-diff / independent reach relation) and must keep the **trace-oracle 0-DIVERGENT**. Mutation-testing the checkers found 3 real holes that 1,700 passing tests missed — checkers are the thing between passes and silent miscompiles. A half-correct pass is worse than none: ship nothing rather than an unsound rewrite (reg-split honoured this).
- **Every bug fix ships a regression test** or a `docs/BUGS.md` row. Never fix silently.
- **PUSHBACK is expected and good.** Agents that refuse a wrong brief and file `docs/PUSHBACK.md` (e.g. P-8 default-params shape wrong, P-9 spec 16 never existed, P-11 reg-split default-on cost) saved real work. Honour their pushback; don't force over-matching.

**Generalization (avoid local maxima)**
- **Test changes across the whole 27-app corpus, not just NSW.** Fred's instinct here was right: screen naming looked "beautiful" on NSW but was OVERFIT — it produced garbage screens (`AtrulePreludeScreen` from a CSS parser) on Brex/Uniswap. The fix was structural (route registry must be navigator-connected), not a denylist. `tools/e2e/corpus-regression.mjs` is the standing guard (its baseline capture is still pending — run it when deb has headroom). The local max is only *partially* fixed — other apps unchecked.
- Prefer structural gates over denylists. Better to produce **nothing** than garbage (an empty `src/screens/` beats fake screens).

**Product priorities (Fred's north star + steers)**
- North star: bytecode → a `src/` tree of readable JS, libraries stripped to `node_modules`, app code named (screens/navigators). **"Only what's in src really matters"** — don't chase naming the 1600+ non-screen module files (many have no name signal in minified bytecode); the priority is the **code inside** files reading like source.
- **Screen/navigator names are recoverable** from router route-config strings (they survive minification); **local variable names are NOT** the originals (minified away) — reg-split+var-naming gives *meaningful inferred* names, never the author's names. Be honest about this ceiling.
- **Dead code = ANNOTATE, not delete** (Fred's security insight): deleting code is a liability for a vuln tool. "Reachable-but-not-from-UI" code (hidden admin routes, debug handlers, feature-flagged screens) is LIVE and attacker-reachable — a FINDING to surface, not remove. Only truly-dead (no path can reach it) may be TAGGED, never deleted. This is a Stage-3 project-store feature.
- **Deps strategy is bounded, not exhaustive**: npm is ~3M packages / tens of TB — never try to fingerprint all of it. Cover the RN/Expo tail (~few thousand); `_vendor` (unnamed library) is a fine outcome; deps are optional to the product; use evidence-directed on-demand confirmation for the long tail.
- **Truth first, then efficient-to-use** (Fred's ROADMAP edit): Stage-2 tools must never trade a faithful decompile / real findings for lower interaction cost. "Efficient" = minimal per-operation context overhead so the LLM loop covers more code, NOT rationing total tokens. A tool that gets cheaper by being less true is a regression.

**Communication**
- Be honest and concrete. Fred values a straight "no, not done yet" over spin. When he asks "did we make progress," give measurable results AND the honest caveat (e.g. "reg-split merged but opt-in, so output isn't improved yet"). Self-criticism when a stretch was process-heavy is fine and appreciated.
- Give estimates with realistic caveats (usage limits, correctness gates). Don't over-promise the ladder.

## 2. Environment & operating mechanics
- **Repo:** `/Users/fred/hbc2js`, remote `github.com/freddygaffey/hbc2js` (public, push freely to it — full repo permission on THIS repo only; never other repos; never open PRs/issues; never `gh` beyond what's allowed).
- **Machine clock is/was ~13h off — never trust `date`;** get real time from `curl -sI https://github.com | grep -i '^date:'` (UTC → Sydney +10).
- **Keep the Mac awake:** `pgrep -x caffeinate || (caffeinate -i -w $$ &)`. Machine sleep killed many agents historically; caffeinate fixed it. (Kill it if Fred asks to save battery.)
- **deb** (ssh host `deb`, 10.99.0.1, user fred, node 22 via `export PATH="$HOME/.local/share/fnm:$PATH"; fnm exec --using 22`): Fred's Linux box, same trust as the Mac (corpus MAY live there). Offload heavy decompiles/gate via `tools/deb/run.sh -- <cmd>` (HTTP job server, returns a 40-line tail). **deb disk was ~96% — watch it.** The bulk sigdb round-2b run has been going there (bounded — don't expand it). Detached ssh jobs need `ssh -f` + `setsid`.
- **The loop is a session-only cron** (`CronCreate`, hourly at an off-minute) carrying the current policy (max 2 / prefer 1). It fires as a user-role message; do the tick (merge finished agents, keep ≤2/prefer-1 agents on disjoint files, keep main green, caffeinate, one-line handoff). Recreate it on resume; delete stale duplicates (I've had 2–3 conflicting crons — keep one).
- **Memory** at `/Users/fred/.claude/projects/-Users-fred-hbc2js/memory/`: `hbc2js-operating-rules.md` holds the full behavioural tuning (long; the source of truth for the rules above), plus project-state/resume/HANDOFF files and `MEMORY.md` index. Keep them current but don't put this handoff there — Fred wants it as a repo markdown file.
- **Docs that drive the work:** `docs/QUEUE.md` (pop the top; skip ON-HOLD items), `docs/ROADMAP.md` (the 3-stage chronological plan), `docs/STATUS.md` (one-screen scoreboard), `docs/reports/*` (per-run history), `docs/AGENT-LOG.md` (append-only), `docs/BUGS.md` (triaged Open/Resolved), `docs/PUSHBACK.md` (agent disputes).

## 3. Current state (2026-09-02, main `14ed5ca`)
- **Pipeline (M0–M4):** parser, disassembler (100% vs hermesc all 5 versions), CFG, structurer, emitter, VM-trace harness — done. Bytecode → valid, equivalent JS.
- **Ladder:** 16/30 rungs live + reg-split just landed (opt-in). Live: loop-cond, for-header, if-chain, switch-raise, label-clean, expr-rebuild, global-access, call-shape, fn-naming, var-naming, template-literal, jsx-recover, destructure, spread-rest, optional-chain, default-params. reg-split = merged but `optIn`.
- **Segregation / product:** `hbc2js segregate` splits a `--split` module tree into `node_modules/<pkg>/` vs `src/` with named screens. **Service NSW** (real gov app, only bytecode): 1740 app modules / 2090 library (5 named packages) / 680 unclassified; **~111 named screen files** (real: `PayFinesScreen`, `DDLLicenceLoadingScreen`, `VCDownloadScreen`…) from 176 recovered routes. Navigators mostly still generic. The tree is at `~/nsw-decompiled/app/`.
- **Boot:** a decompiled rn-template `--split` tree runs under bare Node to `AppRegistry.registerComponent("HelloHermes072")` (pinned in a sweep test).
- **Design D naming overlay (rename tool):** DONE — `src/name-overlay/` binding-id `{fn,reg}` versioned store, gate-routed rename, render-time alpha-rename, CLI `name set|get|revert|search` + `render`, resident service, 15 tests, 0-divergent. This is the Stage-2 substrate. A downstream agent used it and queued improvements at the end of Stage 2.
- **Corpus regression harness:** merged (`tools/e2e/corpus-regression.mjs` + sweep test + docs) — baseline capture PENDING.

## 4. THE immediate next work (readability — the biggest-value pending item)
reg-split is merged but **opt-in**, so it does NOT yet change output. To realize the "reads like source" win (Fred's top priority), in order:
1. **Make reg-split default-on (P-11):** (a) fix its perf — measured 13.6× vs the 12× pipeline-speed ceiling (the R-loop/R-catch coarsening is O(regs×tries)/fn); (b) update ~10 other rungs' tests that assert `r\d+` regexes to accept the new `rN_j` names (the CONSOLIDATION §B "shared-fixture assertions break" debt).
2. **var-naming compound:** once split, actually NAME the ranges (loop→`i`, arrays, usage/alias/literal heuristics; maybe a 2nd expr-rebuild pass). Measure registers-named % (target 3.4% → ≥15%). **This is the step that turns `r0=r6[r0]` into `key=items[key]`.**
3. Non-deobf cleanup rungs: literal-forms, try-clean, arguments-form, for-in/for-of.
Then → **Stage 2** (artifact format + xrefs first — it's the seam). Deobfuscation + dead-code = **Stage 3, strictly last.**

## 5. Lessons / gotchas (don't relearn these)
- A `src/passes` message string ending in the word `from` before its closing quote false-trips `tests/gate/passes/imports.test.ts` — avoid, or it reads as an illegal import.
- Agents that "pause waiting on a monitor" (deb runs) can balloon without landing — nudge them to commit what they have and stop, or salvage their worktree yourself (the corpus harness needed this).
- `npm test` runs `typecheck` first (so local green == CI green). CI has a `ci` job (gate, green) and a `sweep` job (broader; keep it green too — it gates on merge). Node version drift can change type resolution — the deb job server pins node 22.
- Extraction assumes `assets/index.android.bundle`; some APKs put the bundle elsewhere (`au.gov.vic.myvicroads` has none there) — handle gracefully.
- One app (`app.phantom`) crashes the decompiler (`E_INTERNAL: CFG-05`) — a real bug, logged.

## 6. What Fred is considering right now
Upgrading the overseer model and compacting the session; hence this handoff. Do not start new agents until Fred says so (his last instruction). `main` is green at `14ed5ca`, no agents running, worktrees clean.
