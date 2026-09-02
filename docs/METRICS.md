# Metrics scoreboard

Standing, one row per day (docs/QUEUE.md "## Now"). Trends over snapshots —
Fred 2026-09-02: "project runs a few more days, start collecting NOW".

## Running it

```
node tools/metrics/collect.mjs
```

Runs in ~1 s (git plumbing, doc/registry reads, and one corpus-metric import
already exercised by the gate — no corpus-wide sweep, no bundle decompile).
Appends one row to `docs/reports/metrics/scoreboard.md`, keyed by UTC date;
re-running the same day replaces that day's row (idempotent). `--dry-run`
prints the row without writing.

**When.** At landing time — an agent (or the orchestrator) runs it once per
day when work lands, not on a fixed schedule. A day with no commits still
gets a row (commits-today = 0) if the collector is run.

## Columns

| column | source | notes |
|---|---|---|
| commits total | `git rev-list --count HEAD` | |
| commits today | `git log --format=%ad --date=short`, filtered to today (UTC) | |
| rungs live/target | `src/passes/registry.ts` `REGISTRY.length` / 30 | the one machine-readable pass list; `docs/specs/passes/00-LADDER.md`'s table mixes rung-inventory rows with unrelated rows and isn't reliably regex-parseable. 30 is the ladder's documented target (`docs/STATUS.md`), recorded as a constant, not derived. Opt-in count (`Pass.optIn === true`) shown alongside. |
| gate tests (baseline) | `docs/test-count-baseline.json` `"gate"` field | the recorded baseline, not a live `npm test` run — CLAUDE.md forbids running the gate inside the collector. |
| BUGS open / resolved | `docs/BUGS.md` `"## Open — N rows"` / `"## Resolved — N rows"` headings | the table body has two historical column shapes and isn't reliably position-parseable; the section headings are the machine-readable source. |
| src code LOC | line count over `src/**/*.ts` (excluding `src/tables/generated`, generated opcode/builtin tables), minus comment and blank lines | see comment-line rule below. |
| src comment % | comment lines / (code + comment) over the same set | |
| tests LOC | line count over `tests/**/*.ts`, code + comment (blank excluded) | |
| registers-named % | `tools/passes-metrics.mjs`'s `measureVarNaming([94, 99], [""])` — the same construct-corpus method (~1 s) that produced the 3.1%/3.4%/4.1% figures in `docs/specs/passes/07-var-naming.md` §8 | this is the **construct-corpus** figure (v94+v99 base variants), not the heavier rn-template-**bundle** figure (`measureVarNamingBundle`, a full decompile) — that one is `n/a` here; see TODO below. |
| tokens/item median (k) | median of every `"<N>k / <M> calls"` occurrence in `docs/AGENT-LOG.md` | an "outliers" line under the table lists any value >4x the median, when present. |
| trace-oracle DIVERGENT | — | `n/a` — reserved column, wait on the fuzzing lane (docs/QUEUE.md Lane T) landing an oracle-backed run that produces this cheaply. |
| corpus pass matrix | — | `n/a` — reserved column, same reason (per Hermes-version × bundler pass matrix needs the held-out/ground-truth corpus work in Lane T). |

**Comment-line rule.** A line is "comment" if, trimmed, it starts with `//`,
`/*` or `*` — covers line comments and this repo's block-comment/JSDoc
continuation style. Cheap and slightly imprecise (a rare trailing-code-after-
`*/` line miscounts as comment) — same trade every other cheap counter in
this repo makes (`tools/passes-metrics.mjs`, `tests/gate/docs/test-count.test.ts`).

## TODO (tracked here, not silently dropped)

- **registers-named % on rn-template (bundle figure).** `measureVarNamingBundle`
  in `tools/passes-metrics.mjs` does the real decompile; not run by this
  collector (budget). Add as a second column once it's confirmed to run
  well under the collector's time budget, or keep it as a separate weekly
  `tools/app-metrics.mjs`-style job.
- **trace-oracle DIVERGENT count / corpus pass matrix.** Both `n/a` until
  Lane T's fuzzers (docs/QUEUE.md) land and produce these cheaply; the
  columns are reserved in the header now so the table shape doesn't change
  later.
- **$-per-item / model mix.** docs/QUEUE.md also asks for cost-per-test-added
  and model mix; `docs/AGENT-LOG.md` rows don't yet carry a structured
  per-item test-count-added field, so only tokens/item is collected today.

## Salvage note

`origin/worktree-agent-a99810bd07c13c086`'s `tools/app-metrics.mjs` was
inspected first. It is a different, heavier tool — one full decompile of a
real bundle (`tests/fixtures/bundles/rn-template-0.72`) with every pass on,
reporting per-bundle readability metrics (stubbed functions, register/
`Reflect.apply`/helper density per 1k lines, `--split` classification). It
doesn't cover the standing scoreboard's columns (commits, rungs, BUGS rows,
LOC, tokens/item) and its one full decompile is exactly the "heavy decompile"
this collector is required to avoid, so it was not reused here; it remains a
separate candidate CI job for a *bundle-level* metrics report (see its own
top-of-file comment for the `ci.yml` `app-metrics` job it was written for).
