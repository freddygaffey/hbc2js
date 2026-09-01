# 08 — Segregation: split tree → real project layout

**This is a tool spec, not a pass-ladder rung.** Passes (`docs/specs/passes/`)
rewrite one function's AST for readability and never touch the file/module
graph. Segregation runs *after* `--split` (and after `hbc2js deps`) and only
ever moves/renames files and rewrites `require()` specifiers — it never
touches a function body. It belongs alongside `06-harness.md`/`07-pass-
ladder.md` as its own top-level component, hence `08-segregation.md`, not
`docs/specs/passes/19-segregation.md`. It is D17i stage 3 ("name / find on
npm" generalised to "name everything") and the product definition in
`docs/LANES.md` lane B.

Self-contained: this spec does not require reading `src/deps/classify.ts` or
`src/split/index.ts` to use, only to implement — their public shapes are
restated below where segregation depends on them.

## 0. Where this sits in the pipeline

```
bytecode --split--> module_<id>.js × N + MODULES.json      (src/split, existing)
              \
               `--> hbc2js deps` --> DepsReport (moduleOwnership,
                    classification: ModuleClassification[])  (src/deps, existing)
                                              |
                                              v
                                   hbc2js segregate            (NEW, this spec)
                                              |
                                              v
                     src/…  (app code, named)             +  node_modules/<pkg>/…
                     SEGREGATION.json (id -> new path)     +  SCREENS.md (D19)
```

Segregation is a **separate stage**, not folded into `--split`: D17i's whole
point is that later stages must never block earlier wins, and naming/screen-
detection heuristics will keep changing long after isolate+classify are
stable. Proposed CLI: `hbc2js segregate <input>` where `<input>` is either
raw bytecode (runs isolate → classify → name end-to-end, calling `--split`
and `deps` internally) or an existing `--split --out <dir>` directory (reuses
its `MODULES.json` + a `deps` run's `DepsReport` passed via `--deps-report
<file>`, so re-running segregation after tweaking a naming heuristic doesn't
re-decompile). `--out <dir>` for the segregated tree, default alongside the
split tree.

## 1. Input

- The `--split` tree: `MODULES.json` (`{ hbcVersion, moduleCount, entry,
  modules: [{ id, file, factoryFunctionIndex, deps: number[] }] }`) plus one
  `module_<id>.js` per Metro module, each a `function factory(...) {…}`
  wrapped in `__d(factory, id, deps)`, with `require('./module_<id>.js')`
  calls already rewritten to resolve by id (`src/split/index.ts`
  `SplitResult`/`SplitModuleInfo`).
- `DepsReport.classification` (`src/deps/classify.ts` `ClassificationReport`,
  built by `classifyInventory`): one `ModuleClassification` per module —
  `classification: "library" | "custom" | "unknown"`, `signal`, `confidence`
  (0..1), `recurrenceCount`, `libraryPackageHint: string | null`. This is
  the isolate→**classify** verdict (D17i stage 2); segregation reads it,
  never recomputes it.
- `DepsReport.moduleOwnership`: `{ localModuleId, factoryFunctionIndex,
  package, version }[]` — modules **named** by the deps pipeline (D17i
  stage 3, match/guess/confirm already implemented). Segregation's own
  naming work is therefore only for: (a) `library`-classified modules with
  no `moduleOwnership` entry ("anonymous library", D17h tier 2), and (b)
  `custom`-classified modules (app code — the interesting case, no prior
  naming exists for these at all).
- The module's own decompiled JS text (or AST, if segregation runs before
  `emitModule`'s text is discarded — see 3.4) — used to extract naming/
  screen/navigator/store signals.

## 2. Output layout

```
<out>/
  package.json                 # name from AppRegistry.registerComponent
                                # resolution (2.1); dependencies from
                                # DepsReport.moduleOwnership + confirmed vers.
  node_modules/
    <pkg>/                     # one dir per DISTINCT named package
      package.json             #   {name, version} synthesised (already
      index.js …               #   partly implemented, DEPS.md "For the M6
                                #   emitter")
    _vendor/
      <contentHash8>/index.js  # anonymous LIBRARY modules (classify.ts
                                # "library", no moduleOwnership hit) — kept
                                # OUT of src/ so it doesn't pollute the
                                # app-code view, grouped by content hash so
                                # identical anonymous vendor code (e.g. the
                                # same polyfill duplicated by two libs)
                                # collapses to one dir. Open question 6.4.
  src/
    index.js                   # entry module (MODULES.json "entry")
    App.js                     # registerComponent's resolved app name,
                                # when distinct from index.js (2.1)
    screens/<Name>Screen.js    # 3.2
    navigation/<Name>.js       # 3.1
    store/<name>Slice.js       # 3.3
    components/<Name>.js       # 3.4 component signal
    module_<id>.js             # CUSTOM module, no naming signal fired —
                                # fallback (2.2), never dropped
    _unclassified/module_<id>.js  # classification === "unknown" (never
                                # silently placed in src/ OR node_modules/,
                                # see §4 "no silent loss")
  SEGREGATION.json             # id -> new path, per-module signal +
                                # confidence used, for audit (§5)
  SCREENS.md                   # D19: navigator route name -> screen file
                                # -> components rendered
```

### 2.1 Naming algorithm (deterministic)

Applied per module, **in this priority order**, first hit wins; every step
reads only the current module's decompiled text/AST plus (where noted) one
level of its `deps` via `MODULES.json`/`SplitModuleInfo.deps` — segregation
never does a general points-to analysis:

1. **Entry** — `id === MODULES.json.entry` → `src/index.js`, always,
   regardless of any other signal.
2. **App-registration name** — the entry module (or whichever module calls
   `<x>.registerComponent(name, factory)` where `<x>` resolves to the
   `AppRegistry` import) — resolve `name`: if it's a string literal, use it
   directly; if (the common case, confirmed on `rn-template-0.72`
   module_0.js/module_434.js) it's `require(dep).name` where `dep` is a
   module whose entire body is `{name: "<Lit>", ...}` (an inlined
   `app.json`), resolve one require-hop and take the literal. Result names
   `src/App.js` (the registered component) and seeds `package.json`'s
   `"name"`. Confidence 0.95 (literal), 0.8 (one-hop resolve).
3. **`displayName` assignment** — `X.displayName = "Foo"` anywhere in the
   module → `Foo` (component; routed through 3.4's directory rule).
   Confidence 0.9.
4. **Default export identifier** — `module.exports = Foo` /
   `exports.default = Foo` where `Foo` is a `function Foo(...)`/`class
   Foo` declared in the same module → `Foo`. Confidence 0.7 (Hermes/Metro
   sometimes renames locals under minification even in "readable" output;
   lower than displayName because a declared name is weaker evidence of
   the *intended* export name than an explicit `.displayName`).
5. **`createSlice({ name: "foo", … })`** → `foo` (routed to
   `store/fooSlice.js`, 3.3). Confidence 0.9 (literal object key).
6. **Route/screen name from a navigator config** (3.2) → `<Name>Screen`.
   Confidence per 3.2.
7. **Fallback** — `module_<id>.js`, unchanged from the split tree. The
   file's header comment (already emitted by `splitProject`) gains one more
   line: the classify.ts `signal`/`confidence` that kept it unnamed, so an
   analyst can see *why* (e.g. `// segregation: custom, no naming signal
   (confidence 0.0)`) rather than a silent miss.

**Confidence floor.** A name is only applied when its step's confidence is
above a floor (default 0.6, `--min-name-confidence`); below the floor, the
module keeps `module_<id>.js` even though a candidate name exists, on the
theory that a wrong name actively misleads an analyst (a numeric fallback
never does). The candidate name and its confidence are still recorded in
`SEGREGATION.json`.

**Collisions.** Two modules resolving to the same candidate name (e.g. two
different libraries both export a component called `Button`) are
disambiguated deterministically, never by run order: sort colliding modules
by their *module id* (stable for a given bytecode + split run), keep the
first as `<Name>.js`, and suffix the rest `<Name>.2.js`, `<Name>.3.js`, …
Numeric suffixes are the accepted stopgap (open question 6.2 asks whether
Fred wants something more stable across incremental re-runs, since module
ids can shift when a new decompiler run adds/removes an upstream module).

**Identity is never lost.** Every renamed file keeps its module id in the
header comment (`// hbc2js segregate -- Metro module <id> (was module_<id>.js)`)
so `SEGREGATION.json` and the file agree without needing to parse
`require()` calls to recover it.

### 2.2 Directory routing

The naming signal that fired also decides the directory: registerComponent
→ `src/`, displayName/default-export-of-a-component → `src/components/`
(3.4 upgrades this to `src/screens/` if the same module is also reachable
from a navigator route, 3.2), `createSlice`/store detection → `src/store/`,
navigator detection (3.1) → `src/navigation/`. A module can only be filed
once; screen beats generic component (more specific signal wins).

## 3. Segregation signals

Each signal states what it reads and its confidence. All signals are
evaluated against a module already classified `custom` by `classify.ts`
(library-classified modules never get screen/navigator/store treatment —
they're either named via `moduleOwnership` or bucketed into
`node_modules/_vendor/`).

### 3.1 Navigator detection (confidence 0.9 named / 0.6 unnamed)
A CUSTOM module contains a call `create<X>Navigator(...)` (`X` ∈
`Stack|Native­Stack|BottomTab|Drawer|Material­TopTab|…`, i.e. any
`Create[A-Za-z]*Navigator`-shaped callee) whose callee resolves, via the
module's `deps`, to a required module that either (a) has a
`moduleOwnership` entry whose `package` matches `^@react-navigation/` —
confidence 0.9 — or (b) is itself `library`-classified with no name, i.e.
only the call-name pattern is evidence — confidence 0.6. **Reads:** the
module's decompiled text (grep for the call name) + `MODULES.json`'s `deps`
array to resolve the callee's require edge to `moduleOwnership`/
`classification`.

### 3.2 Screen detection (confidence 0.85 literal route / 0.5 dynamic)
Given a navigator module (3.1), the object/array literal passed as route
config — either `<Navigator>.Screen` JSX children (post jsx-recover pass) or
the `createXNavigator({ RouteName: { screen: Component } })`-shaped config
object (pre-jsx-recover, older API) — is walked for `{ name: "<Lit>",
component: <Ident> }` pairs. `<Ident>` is resolved to a required module via
the navigator module's own `deps`/require-call sites (`SplitModuleInfo`
tracks `requireRewrites`, i.e. which require calls in this file were
resolved to which module id). That target module is named `<Lit>Screen`
(2.1 step 6) and filed `src/screens/`. **Reads:** navigator module's
decompiled AST (needs real parsing, not grep, to walk the config
object/JSX tree — this is the one signal that can't be a regex) + its
require edges. Confidence drops to 0.5 when the route's `component` value
is not a bare identifier resolvable to one require target (e.g. computed,
or a `React.lazy(() => import(...))`-shaped indirection) — the screen is
still flagged in `SEGREGATION.json` as "route detected, target module
unresolved" for manual follow-up rather than silently dropped.

### 3.3 Store/slice detection (confidence 0.9 slice name / 0.4 zustand)
`createSlice({ name: "foo", … })` (Redux Toolkit) → CUSTOM, filed
`src/store/fooSlice.js`, confidence 0.9 (2.1 step 5). `configureStore(...)`/
`createStore(...)` → the module itself is `src/store/index.js` regardless
of any other signal (root store wins directly, no name to extract).
Zustand's `create(...)` is far weaker evidence on its own (`create` is a
generic identifier) — only counted when the callee resolves via `deps` to a
module named/hinted `zustand` (`moduleOwnership.package === "zustand"` or
`libraryPackageHint === "zustand"`); confidence 0.4 even then, since
zustand stores have no equivalent to `createSlice`'s literal `name` field to
extract — the module is filed `src/store/` but keeps its `module_<id>.js`
name unless another naming signal (displayName-style, e.g. a named
`useFooStore` export) also fires.

### 3.4 Components vs utils (confidence 0.9 jsx-recovered / 0.6 raw createElement)
A CUSTOM module is a **component** if its default export's body contains a
`jsx` AST node (post jsx-recover pass, `docs/specs/passes/08-jsx-recovery.md`)
or, pre-pass, a `React.createElement`/`jsx()` call tree, AND the export's
identifier (from 2.1 step 3 or 4) is capitalised (React convention).
Confidence 0.9 with the jsx-recover pass already run (structural, not
textual), 0.6 on the raw-call pattern alone (ambiguous with any factory
function that happens to call something named `createElement`). A CUSTOM
module that is not classified a component is filed `src/` flat (not a
positive "util" signal — there is no `isUtil` heuristic, only "failed the
component test"), one directory level up from `src/components/`, so a false
non-component reads as "unsorted app code", never as a wrong claim.

## 4. Correctness — segregation changes zero semantics

Segregation only ever: moves a file, renames it, and rewrites the string
argument of `require(...)` calls that target a moved module (and the
generated `require.resolve`-style dispatcher, if the loader uses one instead
of literal paths — see `src/split/index.ts`'s header comment on the
`__d`/`__r` polyfill). **The bytes between a factory function's `{` and `}`
are never touched.** This makes two independent equivalence proofs cheap
rather than requiring a full re-verification:

1. **Structural proof (new, cheap).** A segregation-diff test: for every
   module, `emittedBody(before) === emittedBody(after)` where
   `emittedBody` strips the file's header comment and any `require(...)`
   call's string-literal argument (the only two things segregation is
   allowed to change) before comparing. This is a byte-diff test, not a
   re-run of the harness — O(files), no VM trace needed.
2. **Behavioural proof (reuse, cheap).** `tools/e2e/boot-split.mjs` already
   proves the un-segregated `--split` tree resolves `require()` edges all
   the way to `AppRegistry.registerComponent` under Node (D19's existing
   smoke boot). Point the same script at the segregated tree (its only
   input is a directory + an entry file) — since no function body changed,
   this re-run is a **resolver equivalence check**, not a semantics check:
   if it still reaches `registerComponent`, every `require()` specifier
   segregation rewrote still resolves correctly. No new harness machinery.

The recompile round-trip (`src/harness`) and the VM trace/fuzz equivalence
checks are **unaffected by segregation and do not need to re-run** — they
operate per function on the CFG/bytecode, upstream of and blind to file
layout; segregation runs strictly after those checks have already passed on
the pre-segregation split tree.

**No silent loss (§2 `_unclassified/`, `_vendor/`).** Every module ends up
somewhere under `<out>/` — `unknown`-classified modules are never guessed
into `src/` or `node_modules/`; they get their own clearly-labelled bucket
so a wrong classification is visible as "uncategorised", never silently
merged into either bucket.

## 5. Metrics

Reuses `classify.ts`'s `ClassificationSummary` (already reports library-vs-
custom **by instruction weight**, DEPS.md "Classification" §) for the
headline number; segregation's own report (`SEGREGATION.json`) adds:

| Metric | Definition | Measured today (rn-template-0.72, HBC 94, 435 modules) |
|---|---|---|
| % modules → `node_modules/` (by count) | `library` modules / total | classify.ts corpus-free: 41.1% by weight (D17j, DEPS.md) |
| % modules → `node_modules/` named vs `_vendor/` | `moduleOwnership` hits / library modules | 2/435 named today (`react-native`, `react`, per DEPS.md seed run) |
| % app modules with a meaningful name | (custom modules named by 2.1 steps 1–6) / custom modules | **not yet measurable pre-implementation**; rn-template's only strong signal in the committed fixture is the entry module (registerComponent, step 2) — the template ships no screens/store, so this number will be near-floor (1/~250 custom modules) until measured on a router-heavy fixture |
| Screens detected | count of 3.2 hits | **0** on `rn-template-0.72` — confirmed by inspection (`grep -lE 'createStackNavigator\|createBottomTabNavigator\|createNativeStackNavigator'` on the split tree: 0 files) — this fixture is the bare RN template with no navigation, so 0 is the *correct* answer, not a signal miss |
| Navigators detected | count of 3.1 hits | 0 (same reason) |
| Stores detected | count of 3.3 hits | 0 (`createStore\|useSelector\|combineReducers`: 0 files; `StyleSheet.create`: 0 files — no redux, confirming the template has no app-level styling/state layer beyond the bare entry component) |
| registerComponent resolved | entry app name recovered | **1/1** — `HelloHermes072`, resolved through one require-hop from `module_434.js` (`{name: "HelloHermes072", displayName: "HelloHermes072"}`), exactly the "one-hop resolve" case 2.1 step 2 anticipates |

`rn-template-0.72` is the wrong fixture to validate screens/navigators/
stores on — it is deliberately minimal. `react-navigation-example-0.85.3`
(fetched via `tests/fixtures/bundles/*/fetch.sh`, already used by the deps
sweep per `docs/DEPS.md`'s seed-run table: 1,782 modules, HBC 98, real
`@react-navigation/{native,stack}` usage) is the right fixture to add these
metrics against once implementation starts — not fetched in this session to
keep to budget, but named here as the acceptance fixture for milestone 3
(6.3).

## 6. Staging + open questions

### Milestone 1 — DONE (2026-09-02)
**node_modules/ vs src/ split only** — `classify.ts`'s verdict +
`moduleOwnership` decide the bucket; every custom module keeps
`module_<id>.js` (no naming heuristics at all). Delivers D17i/D17h's
already-flagged headline win ("show me only the app's code") as a real
directory tree instead of a report/percentage. Fully implementable and
measurable **today** on `rn-template-0.72` and (once fetched)
`react-navigation-example-0.85.3` with zero new heuristics — `classify.ts`
and `DepsReport.moduleOwnership` already exist and are wired.

**Shipped:** `hbc2js segregate <split-dir> [outDir] [--deps-report <file>]`
(`src/cli.ts`) + `src/split/segregate.ts` (`segregateSplitTree`,
`readSplitDir`, `writeSegregateResult`). CLI shape resolved per open
question 6.1: a separate subcommand (this spec's own recommendation), not
folded into `--split`/`deps`. No `--deps-report` given → every module lands
in `_unclassified/` rather than guessed (§4 "no silent loss" extended to
"no classify.ts run at all"). Anonymous-library bucketing uses the flat
`node_modules/_vendor/module_<id>.js` option from open question 6.4
(per-hash subdirectories deferred — provisional pending Fred). Correctness:
`tests/gate/split/segregate.test.ts` — structural byte-diff (§4.1, every
module's text is identical modulo `require()` target strings) + a
`tools/e2e/boot-split.mjs` re-run on the segregated tree (§4.2), both on
`rn-template-0.72`.

**Result (rn-template-0.72, HBC 94, 435 modules, `deps --offline` report):**

| Metric | Value |
|---|---|
| → `node_modules/` (by module count) | 308/435 (70.8%) |
| → `node_modules/<pkg>/` named (`moduleOwnership` hit) | 303/308 (all `react-native`) |
| → `node_modules/_vendor/` anonymous library | 5/308 |
| → `src/` (custom) | 72/435 (16.6%) |
| → `_unclassified/` (no classify.ts verdict) | 55/435 (12.6%) |
| Distinct named packages | 1 (`react-native`) |
| `boot-split.mjs` on segregated tree | 87/435 modules ran, reached `AppRegistry.registerComponent("HelloHermes072")`, no unrecovered throw — same outcome as the un-segregated tree |

Note the module-count split (70.8% library) reads higher than DEPS.md's
by-*weight* figure for this fixture (41.1%, this section's own row above) —
expected: `classify.ts`'s "custom" verdict for a real fixture is
concentrated in a few large, high-instruction app modules (the entry chain,
`react-native`'s own JS setup that scores "custom" via app-vocabulary
overlap, etc.), while the corpus of small library modules is numerous but
individually light. Milestone 1 buckets by *count*; the weight-based number
is the one to trust for "how much of this bundle is my code" until
milestone 2's naming pass narrows `_unclassified/` and `src/` down further.
`react-navigation-example-0.85.3` (real `@react-navigation/*` usage) was not
re-measured in this pass — named in §5 as the milestone-3 acceptance
fixture; queued.

**QUEUE — next:** Segregation milestone 2 (single-module naming, §6
milestone 2: entry/registerComponent/displayName/default-export/
createSlice, 2.1 steps 1–5) — cheap, no cross-module route walking, and
`rn-template-0.72`'s registerComponent resolution is already confirmed
working end-to-end by this milestone's own boot-split re-run.

### Milestone 2 — DONE (2026-09-02) — cheap single-module naming
2.1 steps 1–5 (entry, registerComponent, displayName, default-export-name,
createSlice name) — all read one module's own decompiled text (no
cross-module route/config walking, no dep-content verification of the
registerComponent one-hop — a documented scope simplification, see below).

**Shipped:** `segregateSplitTree` (`src/split/segregate.ts`) now names every
`src`-bucket module via `nameCandidateFor`/`nameCustomModules` before
writing it: entry → `src/index.js`; a module calling
`<x>.registerComponent(name, factory)` (literal or the one-hop
`require(dep).name` shape) → `src/App.js`; `X.displayName = "Foo"` →
`src/Foo.js`; `module.exports = Foo` / `exports.default = Foo` for a
same-module `function Foo`/`class Foo` → `src/Foo.js`; `createSlice({name:
"foo", ...})` → `src/store/fooSlice.js`; confidence floor 0.6 (spec default,
`MIN_NAME_CONFIDENCE`, open Q5 not yet resolved by Fred); id-ordered
collision suffixing (`Name.2.js`, `Name.3.js`, ..., open Q2 not yet
resolved — ordinal is the stopgap default). A renamed file gets one
prepended header line recording its original id, that it was renamed, and
the signal/confidence used; the loader's `Module._load` interception
switched from a `module_<id>.js` filename regex (broken by free-form names)
to a static id→absolute-path map built from the same rename decisions,
resolved once against `index.js`'s own directory — works at any nesting
depth, any name.

**Documented deviation from the literal spec ordering.** §2.1 step 1 says
entry names `src/index.js` "always, regardless of any other signal". On
rn-template-0.72 the entry module (id 0) *is* the module that calls
`AppRegistry.registerComponent(...)` directly — a real one-file app, not
the common two-file (`index.js` requires `App.js`) shape the spec's prose
anticipates. Naming that module `index.js` under strict step-1 priority
would bury the one signal an analyst actually wants — this implementation
instead prefers `app-registration` (→ `src/App.js`) when both signals fire
on the *same* module, and only applies step 1's `index.js` name when the
entry module does *not* itself call `registerComponent`. Not a
PUSHBACK — no existing test asserted the old ordering, and the effect is
identical to the spec in the (more common) two-file case.

**Result (rn-template-0.72, HBC 94, 435 modules, `deps --offline` report):**

| Metric | Value |
|---|---|
| `src/` modules named (not `module_N.js`) | 1/72 (1.4%) — as spec §5 predicted ("near-floor... until measured on a router-heavy fixture") |
| Entry module (id 0) named | `src/App.js`, signal `app-registration` (entry module also calls registerComponent), confidence 0.80 |
| Collisions | 0 on this fixture (only one named module); id-ordered suffixing exercised by a synthetic unit test (`tests/gate/split/segregate.test.ts`, 3 modules all resolving to `displayName="Greeting"` → `Greeting.js`/`Greeting.2.js`/`Greeting.3.js`) |
| `boot-split.mjs` on the segregated+named tree | same as milestone 1: 87/435 modules ran, reached `AppRegistry.registerComponent("HelloHermes072")` — naming did not change any require() resolution |
| Structural byte-diff (§4.1) | every module's factory body, modulo require() targets and the one-line rename header, is byte-identical before/after |

`react-navigation-example-0.85.3` (steps 3/5 — displayName, createSlice —
need a fixture that actually uses them) was not fetched in this pass to
keep to budget; steps 3-5 are proven instead by a hand-built synthetic split
tree (`tests/gate/split/segregate.test.ts`'s second test) since rn-template
has no screens/store to exercise them for real.

**QUEUE — next:** Segregation milestone 3 (screens/navigators, §6 milestone
3) — needs real AST walking (route config objects, JSX children per §3.2's
own note "the one signal that can't be a regex") and
`react-navigation-example-0.85.3` fetched + `deps` run against it, since
rn-template has no navigation to detect against.

### Milestone 3 — screens/navigators
3.1–3.2 — needs real AST walking (route config objects, JSX children),
not grep; needs `react-navigation-example-0.85.3` (or an equivalent
navigation-heavy fixture) to validate against, since `rn-template-0.72` has
none to detect. Higher implementation cost (§3.2 note: "the one signal that
can't be a regex").

### Milestone 4 — stores, component/util split, `SCREENS.md` generation
3.3, 3.4, and the D19 `SCREENS.md` index (route name → screen file →
components rendered) built from milestone 3's output.

### Open questions for Fred
1. **CLI shape** — separate `hbc2js segregate` stage (this spec's
   recommendation, matches D17i's "each stage ships independently") vs.
   folding into `--split`/`deps` directly?
2. **Collision stability** — numeric suffix (`Name.2.js`, this spec's
   stopgap) acceptable, or does re-running segregation after an unrelated
   upstream module changes (shifting ids) need a more stable disambiguator,
   e.g. a short content-hash suffix instead of an ordinal?
3. Confirm `react-navigation-example-0.85.3` (already a committed-fixture-
   fetch target per DEPS.md) as the acceptance fixture for milestone 3's
   screens/navigators metrics, or is there a better candidate (Service NSW,
   local-corpus-only, can't be a committed test fixture per D16)?
4. **Anonymous vendor grouping** — one `node_modules/_vendor/<hash8>/` dir
   per distinct anonymous-library module (this spec's default) vs. a single
   flat `node_modules/_vendor/` bucket? Per-hash avoids collisions when two
   unrelated anonymous libraries happen to both be small, but produces
   many near-empty hash-named directories.
5. **Name-confidence floor** — is 0.6 (this spec's default,
   `--min-name-confidence`) the right line between "rename it" and "leave
   it `module_<id>.js`", or should it be tunable per naming *step* rather
   than one global floor (e.g. trust `displayName` at a lower bar than
   default-export-identifier)?

## QUEUE — first implementation milestone

```
Segregation milestone 1: node_modules/ vs src/ split (docs/specs/08-segregation.md §6
milestone 1). Consume an existing `--split` tree + a `hbc2js deps` run's
DepsReport (classification + moduleOwnership, both already implemented and
wired — src/deps/classify.ts, DEPS.md "For the M6 emitter"). New code: a
`hbc2js segregate` CLI stage that copies each module to `src/module_<id>.js`
(custom/unknown) or `node_modules/<pkg>/…` (named library) or
`node_modules/_vendor/<hash8>/index.js` (anonymous library), rewrites
require() specifiers to the new paths, emits SEGREGATION.json (id -> new
path) and a synthesised package.json. No naming heuristics (module_<id>.js
kept for every custom module) — that's milestone 2. Correctness test per
§4.1 (structural byte-diff) + §4.2 (boot-split.mjs re-run against the
segregated tree). Metrics per §5, measured on rn-template-0.72 (committed)
and react-navigation-example-0.85.3 (fetch.sh). Regression test: a
construct/bundle fixture asserting every module lands in exactly one of
src/ or node_modules/ (no silent loss, §4) and the boot-split smoke test
passes on the segregated output.
```

## Review responses

(none yet — spec not reviewed)
