# OSS ground-truth benchmark

Fred's north-star metric (docs/QUEUE.md "A", 2026-09-02): **how close is the
decompiled `src/` tree to the real app's own repo**, for public-source React
Native apps we have a Hermes bundle for. `tools/e2e/oss-benchmark.mjs` runs
the full pipeline — decompile → `--split` → `deps --offline` →
`segregate` (docs/specs/08-segregation.md) — on each configured app and
scores the result against ground truth pulled from the app's committed
source map.

## Run it

```sh
node tools/e2e/oss-benchmark.mjs                          # markdown table, all configured apps
node tools/e2e/oss-benchmark.mjs --app react-navigation-example-0.85.3 --json
```

`--app <name>` restricts to one app (name must match an entry in the `APPS`
array); `--json` emits the full scorecard instead of the summary table.

## Adding an app

Append an entry to the `APPS` array in `tools/e2e/oss-benchmark.mjs`:

```js
{ name: "my-app", hbc: "<path to .hbc>", map: "<path to .map>" | null }
```

- `map: null` is valid — the benchmark still reports pipeline-only numbers
  (module counts, dirs created, readability) but every ground-truth field
  (`classification`, `naming`, `structure`) comes back `null`. Use this for
  an app you have a bundle for but no source map (e.g. `rn-template-0.72`
  today — see the follow-up below).
- If the app is a monorepo where library packages live as workspace-linked
  sibling source (not under `node_modules/`, e.g. react-navigation-example's
  pnpm workspace, where react-navigation's own packages are `/packages/*`
  next to the demo app's `/example/*`), set `appSourcePrefix` to the one
  prefix that is genuinely app code. Without it, "not under `node_modules/`"
  is the app-source test, which is correct for a plain npm/yarn app but
  would wrongly count sibling library packages as app code in a monorepo.

**Follow-up (needs network/build; `deb` is down as of 2026-09-02, so this
was left for later — see docs/QUEUE.md):** add 2-3 more clonable OSS RN
apps (an Expo example, a small react-navigation demo) that build with
`npx expo export` / Metro to get a fresh bundle + map pair, rather than
relying only on the two bundles already committed to `tests/fixtures/bundles/`.

## What each score means (and its caveat)

**Classification (app vs library).** The brief asked for per-module
precision/recall against the `.map`. That needs a module-id → source-map
index alignment, and (as `tools/e2e/name-accuracy.mjs`'s header documents)
no such alignment reliably exists for these bundles — hand-verified: a
source map index does not correspond to the Metro module id of the same
number. Fabricating one would produce a precise-looking but false number, so
this benchmark reports two honest, weaker things instead:

- `libraryPackagePrecision` / `libraryPackageRecall`: **package-level**, not
  module-level. Precision = of the `node_modules`-bucket modules `deps`
  named a package for, what fraction of those package names are real
  dependencies of the app (appear under a `node_modules/<pkg>/` path in the
  map). Recall = of the real dependencies the map shows, what fraction did
  `deps` name at least one module for.
- `aggregateRateAgreement`: a coarse sanity check only — the pipeline's
  library-module fraction vs the map's library-source fraction. No
  per-module claim.

One more wrinkle this benchmark corrects for: pnpm hoists real packages
under `node_modules/.pnpm/<key>/node_modules/<pkg>/...` — the *first*
`node_modules/` segment in a path like that is the pnpm store directory
(`.pnpm`), not a package name, so package extraction uses the *last*
`node_modules/` occurrence in a path.

**Naming closeness (fuzzy).** Reuses `tools/e2e/name-accuracy.mjs`'s
`similarity()` (mean of normalised-Levenshtein and token-set Jaccard on
tokenised basenames) rather than reimplementing it. Each recovered `src/`
module name is scored against the single best-matching real app basename
in the map (not an id-verified pairing — same caveat as that script).
`meanFuzzySimilarity` is the mean across all named `src/` modules;
`pctAtLeast08` is the share scoring ≥ 0.8 (a "recognisable" name).

**Structure.** Whether the pipeline created each of `src/screens`,
`src/store`, `src/navigation`, and (a weak proxy) whether any real app
source path contains that segment as a directory name.

**Readability proxies.** `rN`/1k lines, `Reflect.apply(`/1k lines, `_fnN`/1k
lines — counted only over the segregated `src/` bucket's own text (library
code excluded), mirroring `tools/app-metrics.mjs`'s convention.

## Current numbers (react-navigation-example-0.85.3, 2026-09-02)

Baseline: `docs/e2e/oss-benchmark-baseline.json` (produced by this benchmark
run — regenerate with the run command above; regeneration needs Fred's
approval per `docs/CONSOLIDATION.md` §B item 9, same as any other golden
file). Ratcheted by `tests/sweep/e2e/oss-benchmark.test.ts`.

| metric | value |
| --- | --- |
| modules | 1782 (829 library, 726 src, 227 unclassified) |
| classification precision (package-level) | 52.2% (n=605 modules with a guessed package) |
| classification recall (package-level) | 6.1% (6/66 real dependencies named) |
| naming mean fuzzy similarity | 0.658 |
| naming % ≥ 0.8 | 8.6% |
| structure: `src/screens` created | yes (real app has a `screens`-named path: yes) |
| structure: `src/store` created | no (real app: no) |
| structure: `src/navigation` created | yes (real app: no — screens/navigators live under other paths in this app) |
| readability: `rN`/1k lines | 1298.8 |
| readability: `Reflect.apply(`/1k lines | 28.4 |
| readability: `_fnN`/1k lines | 35.9 |
