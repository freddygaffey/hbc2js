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

### 3.1 Navigator detection (confidence 0.9 named / 0.6 unnamed / 0.6 shape-alone)
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

**Deps confirms, it does not gate (2026-09-02, Service NSW brief).** A
`--deps-report` is a *confirming* signal only: with no deps report at all
(Service NSW's own `deps` run takes >10 min — too slow to require before a
first, named `src/screens/` tree), the call/config shape ALONE still names
the module — confidence 0.6, the same floor as the "unnamed library-
classified" tier above, still clearing `MIN_NAME_CONFIDENCE`. When a deps
report *is* present but simply doesn't confirm this particular call (none
of its deps resolve to `@react-navigation/*` or a library), the call is
still rejected as before — a real classify.ts verdict that didn't confirm
is stronger negative evidence than no verdict at all, and weakening that
would regress the acceptance table below. Implemented in
`src/split/segregate.ts`'s `detectNavigator`/`nameCustomModules`
(`hasClassificationData` flag).

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

**Both config shapes are implemented, deps-free, in `traceModuleOrigins`**
(`src/split/segregate.ts`, regex-driven linear scan, not a real AST walk —
see its own doc comment): the pre-jsx-recover `{ RouteName: Component }`
registry (`routeObjRegs`) and, added 2026-09-02, the post-jsx-recover
`{ name: "<Lit>", component: <ref> }` props shape (`jsxScreenPending`,
gated on the module itself also matching 3.1's navigator call shape, to
keep the same "given a navigator module" framing and limit false positives
from an unrelated `.name =`/`.component =` pair elsewhere in a large
module). Neither shape's target resolution (`moduleOriginByReg`) needs a
`--deps-report` — the classification guard that used to require a
screen's *target* module be `classify.ts`-confirmed `custom` now only
applies when a deps report was actually supplied (`hasClassificationData`);
with none, a resolved literal-route hit is accepted on its own.

**Known gap, not silently dropped (`docs/BUGS.md`, 2026-09-02, revisited same
day):** the original hypothesis here — Service NSW's `component` target not
resolving because everything is called through `Reflect.apply(fn, thisArg,
[arg])` — turned out to be wrong on inspection: no `.component =` assignment
in the bundle actually goes through `Reflect.apply`. Three real, narrower
gaps were found and fixed instead (all with their own synthetic regression
test, no change to the acceptance table below): a `.component =
require(dep).NamedExport;` compiled as one statement rather than two; the
interop-default hop spelled `reg["default"]` (bracket notation) instead of
`.default`; and a real bug in `jsxScreenPending` where a route-props register
reused across sibling screens in the same navigator (Service NSW's own
`routeConfig`-shaped modules do this dozens of times per module) silently
kept only the *last* screen sharing that register instead of flushing each
complete pair before the reset. Even with all three fixed, Service NSW still
recovers 0 screens: the actual blocker is `detectNavigatorKind`'s call-shape
gate (`.create<X>Navigator(`/`.createStaticNavigation(`) never matching
Service NSW's own navigator-calling modules, which use the API's *other*
shape (destructure `{Navigator, Screen}` once, then use `Stack.Navigator`/
`Stack.Screen` as JSX components elsewhere) — so the JSX-props resolver never
even turns on for the modules holding Service NSW's real route config.
Tracked as an open `docs/BUGS.md` row rather than shipped unsafely; widening
the navigator call-shape gate to recognise `.Navigator`/`.Screen` JSX usage
needs the same over-matching care, with its own fixture-backed regression
bar, before it ships.

**Inlined lazy-require loader shape (2026-09-03, fix-wave item, appgen
triple `d4e1aacf818f482d`):** a source-level thin-loader IIFE (`function
loadFoo() { return require('./Foo').default; } const Foo = loadFoo();`,
called immediately — not `React.lazy`) compiles to no separate function at
all: Hermes inlines it, leaving the require + interop-`.default` hop +
closure-capture-slot write at the END of the navigator module's own
top-level statements, textually AFTER the nested `<Nav.Screen
component={Foo} />`-building closure that reads the slot back out — outside
`traceModuleOrigins`'s single left-to-right scan's reach. Fixed with a
self-contained regex resolving the slot's origin independent of text order,
consumed only when the read and the `.name=`/`.component=` use are the
immediately-next statement (no persistent forwarding into an ordinary,
reused-by-name register — see `docs/BUGS.md`, 2026-09-03, for the two unsafe
approaches tried and reverted first). `d4e1aacf818f482d`: 0/4 → 4/4 screens;
react-navigation-example-0.85.3's pinned acceptance numbers (§6) unchanged.

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

### Milestone 3 — DONE (2026-09-02) — screens/navigators

**Shipped:** `segregateSplitTree` now also runs, per `src`-bucket module,
§3.1 navigator detection (`detectNavigator`: a `create<X>Navigator`/
`createStaticNavigation`-shaped property-access grep, gated on at least one
of the module's own `MODULES.json` `deps` resolving via `moduleOwnership`
to `^@react-navigation/` — confidence 0.9 — or to a `library`-classified,
unnamed dep — confidence 0.6) and §3.2 screen detection (`detectScreenHits`
via `traceModuleOrigins`: a single left-to-right symbolic scan of the
module's own decompiled text that tracks, per register, which of the
module's `deps` it traces back to through the fixed 7-param `factory(a1..
a7)` calling convention — `a2`=`require`, `a7`=`dependencyMap`, confirmed
uniform across all 1782 modules of the acceptance fixture — then reads off
every `<routeRegistryObj>.<RouteName> = <ref>;` assignment whose `RouteName`
key set is not react-navigation's own descriptor-key vocabulary
(`screen`/`options`/`component`/...) and whose `ref` resolves to another
`deps` entry classified `custom`). Screen hits are named `<RouteName>Screen`
(§2.1 step 6) into `src/screens/`; navigator hits are named `<Kind>Navigator`
into `src/navigation/`.

**Documented deviation from the spec's literal 1-7 priority order** (full
rationale + a synthetic acceptance test in `nameCandidateFor`'s own comment,
`src/split/segregate.ts`): a resolved screen hit is placed *above*
displayName/default-export/createSlice, not below (step 6) — every screen
component in the acceptance fixture also has its own displayName/default
export, and burying the route name behind it would throw away the more
useful signal, the same reasoning §2.2 already states for screen-vs-
component directory routing. Not a PUSHBACK (no existing test asserted the
literal order for these new signals). Also added, single-module only:
§3.3's `configureStore`/`createStore` → `src/store/index.js` (confidence
0.8) — the cross-module "store assembled from reducers in other modules"
half of §3.3 is not attempted (recorded here, not silently dropped, per §4
"no silent loss" spirit).

**Real-world approximation, not the spec's literal AST walk** (§3.2's own
words: "the one signal that can't be a regex") — `traceModuleOrigins` is a
regex-driven linear scan with no real scope/liveness tracking, so register
reuse in a large module can silently miss a route (never, in the cases
checked, silently invent a wrong one) — see the function's own doc comment.
A route-registry object literal is told apart from a same-shape
`{screen, options}` route *descriptor* only by its keys not being in a
fixed descriptor-keyword set (both decompile to `{k: null, ...}`) and by
requiring capitalised keys (screen/route-name convention) — without this
guard, unrelated same-shape config objects elsewhere in a 2000+-line real
`App.tsx` (gesture-handler/reanimated builder objects, `{get: null,
changeX: null, ...}`, all lowercase) fired false positives; confirmed fixed
by hand before shipping.

**Result (react-navigation-example-0.85.3, HBC 98, 1782 modules, `deps
--offline` report; `tools/e2e/name-accuracy.mjs`):**

| Metric | Value |
|---|---|
| Navigators detected | 4 |
| Screens detected | 54 |
| `src/` modules named (of 726 custom) | 58 (8.0%) |
| Ground-truth app basenames (`.map` `sources`, non-`node_modules`, `.tsx`/`.ts`) | 340 |
| Mean fuzzy similarity (best-match; see caveat below) | 0.68 |
| % named modules with similarity ≥ 0.8 | 10.3% |
| Sample recovered → best-match truth pairs | `src/screens/ActivityModesScreen.js` → `ActivityModes` (0.83); `src/screens/AuthFlowScreen.js` → `AuthFlow` (0.83); `src/screens/BottomTabsScreen.js` → `BottomTabs` (0.80); `src/navigation/DrawerNavigator.js` → (no ≥0.5 match — real app has no file named similarly) |
| No-silent-loss / collisions | 0 collisions across the whole tree (§4) |
| Structural byte-diff (§4.1) | every module's factory body, modulo require() targets and rename headers, byte-identical before/after — including the require() *target string* itself changing when segregation renames a module another module requires (new in milestone 3; the acceptance test's own byte-diff helper had to stop assuming a require() target is always `module_<N>.js`-shaped) |
| `boot-split.mjs` re-run | not run on this fixture — `--split` alone already emits a module-level scope-check diagnostic on it (a pre-existing, unrelated decompile-emission gap), so it is not a clean boot-equivalence signal here; rn-template-0.72's existing test already covers §4.2 end-to-end |

**Ground-truth mapping caveat (read before trusting the similarity
numbers):** the brief's suggested id → source-map-index correspondence does
**not** hold on this fixture — verified by hand: `sources[986]` (Metro
module id 986 is this bundle's `--split` entry) is an unrelated
`node_modules` file, and `sources[1086]`/`sources[1368]` (real, by-content,
`/example/App.tsx`-shaped and screen-registry app modules) are also
unrelated `node_modules` paths. There is no cheap module-id ↔ source-path
correspondence recoverable from this bundle's own metadata. Rather than
present a misleadingly-precise id-verified score, `name-accuracy.mjs`
scores each recovered name against the single **best-matching** real
app-source basename anywhere in the `.map`'s non-`node_modules` `sources`
list — "did hbc2js recover a name close to some real file in this app", a
weaker but honest claim, stated in the tool's own header comment.

**No-deps proof (2026-09-02, Service NSW brief) — numbers only, no bundle
content committed, per repo policy on proprietary local-corpus APKs:**

| Bundle | Modules | Navigators (no deps) | Screens (no deps) |
|---|---|---|---|
| react-navigation-example-0.85.3 (HBC 98, own fixture) | 1782 | 6 | 58 (mean fuzzy 0.654, vs 0.686 WITH deps — expected: no deps means no `classify.ts`-"custom" guard narrowing screen targets, and a few more shape-alone navigator hits than the deps-confirmed 4) |
| Service NSW (HBC 96, local/proprietary — hash only, see `tests/fixtures/bundles/hardened/BUILD.md` convention) | 4510 | 26 | 0 — still, after fixing the component-resolution gaps this task found (see `docs/BUGS.md` 2026-09-02 row, revisited): the real blocker is `detectNavigatorKind` never matching Service NSW's own navigator-calling modules (`.Navigator`/`.Screen` JSX usage, not `.create<X>Navigator(` calls), so the (now-fixed) resolver never gets a module to run on |

react-navigation-example WITH deps stays exactly at the milestone-3 table's
own numbers above (4 navigators, 54 screens, mean fuzzy 0.686 ≥ 0.68) —
the deps-optional change adds a fallback path, it does not touch the
deps-confirmed one. Service NSW's 26 navigators (real call-shape matches;
some plausibly count a library's own factory *definition* alongside actual
app *usage* sites, since with no deps there is no way to tell them apart —
an honest limitation of shape-alone detection, not claimed as 26 confirmed
app navigators) is still strictly better than milestone 1/2's status quo
with no `--deps-report`: previously **every** module landed in
`_unclassified/`, zero names, zero screens, zero navigators, because
naming only ever ran on the `classify.ts`-confirmed `src` bucket.

**Second revisit (2026-09-02, navigator detection + naming brief) — measured, not both shipped:**

- *Naming, shipped:* `nameCandidateFor`'s navigator branch now names a
  navigator from its own §3.2 route hits' common name prefix
  (`commonRoutePrefix` — e.g. routes `Licence`/`LicenceLinking`/
  `LicenceScanner` → `LicenceNavigator.js`), falling back to
  `<Kind>Navigator` only when no prefix resolves (≥3 chars, trimmed to a
  camelCase word boundary) — fixes Fred's own review flag that
  `StackNavigator.2.js`-style ordinal-suffix names are "type + counter, not
  the app name". Gate-tested (`tests/gate/split/segregate.test.ts`), zero
  effect on react-navigation-example's pinned numbers or byte-diff (naming
  only, never touches a factory body).
- *Detection widening, measured and reverted:* the `.Navigator`/`.Screen`-
  JSX-usage heuristic `docs/BUGS.md`'s row called for (a module reading
  both properties off some register, without a literal `.create<X>
  Navigator(` call) was implemented and run against react-navigation-
  example — it reproduces the exact over-match this row already warned
  about (screens 54→67 WITH deps, 58→79 WITHOUT; navigators 4→3, 6→5),
  because react-navigation-example's own screen modules routinely render a
  *nested* navigator the same way, so "reads both properties somewhere" is
  not specific to the outer route-config module. Not shipped. Service
  NSW's own real navigator-consuming module was hand-read as part of this:
  its route names/`.component=` targets live in a *separate sibling*
  module (a `require`d "routeConfig" builder, iterated at runtime via
  `Object.entries`, not re-emitted as one `.name=`/`.component=` pair per
  route in the JSX-consuming module's own text) — so even a heuristic that
  didn't over-match on react-navigation-example still wouldn't reach NSW's
  real screens; the actual fix needs a cross-module route-config walk, not
  a same-module regex. Full detail and the standing verdict: `docs/BUGS.md`
  2026-09-02 row (second revisit). NSW's own numbers are therefore
  unchanged from the table above (26-27 navigators depending on exact split
  run, 0 screens) except that its `src/navigation/` names are still
  `<Type>Navigator[.N].js` — the naming fix above has nothing of its own to
  name them from, since none of NSW's navigator-calling modules hold their
  own resolved routes.

**Third revisit (2026-09-02, cross-module route-config walk brief) — shipped,
the actual blocker fixed:** the second revisit's own conclusion (a real
cross-module walk, not a same-module regex) was implemented.
`looksLikeRouteConfigFactory` recognises a route-config *producer* module
from its own naming convention (debug function name `routeConfig`/`<Domain>
NavigationRoutes`, or a matching self-export property write — confirmed
across four independent modules in the sample bundle by hand); gated behind
it, three new resolution primitives handle shapes only Service NSW's own
compiled output uses: a `Reflect.apply(require, thisArg, [depmapIndex])`
call spelling; a copy into/out of `src/split`'s own closure-captured
`_eNNNN_M` environment slots (needed because the require/dependencyMap
parameters are routed through one); and a two-pass scan (a nested function's
*read* of an env slot appears in the text before the enclosing function's
own *write* of it — a syntax-order problem, not a shape-recognition one, no
gating alone fixes it). A third route-registry shape is recognised inside a
factory module: `<reg>.<RouteName> = <descriptor>;` where `<descriptor>`
resolved its own `.component =`/`.screen =` assignment (distinct from the
pre-shaped-literal and JSX-props shapes already handled). The *consumer*
half — `detectRouteConfigConsumer`, a navigator module with no `create<X>
Navigator` call at all, only a `.entries(` walk over a required module's
`routeConfig`/`*NavigationRoutes` property — feeds the existing kind-`""`
fallback, and `nameCustomModules` borrows such a consumer's route set for
naming purposes from its own `deps`' already-resolved hits: real cross-
module dataflow, the names a navigator gets named from live in a different
module's text entirely. Every one of these is gated tightly enough that
ungating any single one regressed react-navigation-example through ordinary
register-name reuse in an unrelated module — caught by this task's own hard
bar (§6's pinned table below) before each gate was added, not by inspection.
Gate-tested with a hand-built fixture reproducing the exact shape (the real
bundle can't be committed): `tests/gate/split/segregate.test.ts`,
"cross-module route-config walk". **Result, Service NSW (never committed,
numbers only):** 0 → 36 screens recovered (real names: `CommonUIErrorScreen`,
`DisasterHubScreen`, `Auth0LoginErrorScreen`, `ChangePinScreen`,
`AnyFineDetailsScreen`, `CertificateOfRegistrationScreen`, ...), 26
navigators (mostly still call-shape-named, since NSW's own navigator-calling
modules still don't hold *their own* resolved routes to name themselves
from beyond the one consumer this walk now resolves). react-navigation-
example's pinned numbers (4/54 WITH deps, 6/58 WITHOUT) are unchanged. Full
detail, including the two known remaining gaps (a route's depmap index
compiled as two statements rather than one is not traced; the root
navigator's route set spans too many domains to share a name prefix, so it
keeps the generic `Navigator.js` name) in `docs/BUGS.md`'s now-**resolved**
2026-09-02 row.

**Fourth revisit (2026-09-02, "container role" fallback brief) — shipped,
the third revisit's own remaining gap closed:** a navigator's route set can
now resolve (third revisit, above) without `commonRoutePrefix` ever firing
— a root/tab container merging several unrelated domains has no shared
prefix by design, so it kept the generic `<Type>Navigator.js` name even
after its full route set was known. `roleNameForRoutes` (`src/split/
segregate.ts`) closes this: for a navigator with >= 4 resolved routes (a
plain two-screen stack keeps its call-shape name — this fallback targets a
real aggregator, not a small navigator that merely lacks a shared prefix),
it names the navigator after whichever single "domain token" (`domainToken`
— the leading all-caps abbreviation or camelCase word of each route name,
e.g. `"DDL"` from `"DDLCheck"`, `"Licence"` from `"LicenceScan"`) covers at
least half its routes (a real majority-domain navigator with one or two
outliers still gets a domain name), falling back to a deterministic role
name — `MainTabNavigator` when the call-shape kind names a tab factory
(`create<X>TabNavigator`), `RootNavigator` otherwise — when no domain
dominates a genuinely diverse route set. Three new fixtures (`tests/gate/
split/segregate.test.ts`): diverse-domain stack → `RootNavigator`,
diverse-domain `createBottomTabNavigator` → `MainTabNavigator`,
dominant-domain-plus-outlier → `LicenceNavigator`; the three existing
2-route `Home`/`Profile` `StackNavigator` fixtures are unchanged (below the
>= 4-route floor). react-navigation-example's pinned numbers (4/54 WITH
deps, 6/58 WITHOUT) are unchanged — none of its own navigators' route sets
resolve on this fixture, so every one of its navigator names is unchanged
too (this revisit is a pure addition, not a rename, on that fixture).
**Result, Service NSW (never committed, numbers only, no `--deps-report`,
same fast path as the third revisit):** of 26 navigators, 3 now get a
route/role-derived name (`VenueSignInNavigator` from a resolved route-set
prefix, two `RootNavigator`s from the new role fallback) vs 23 still on the
generic call-shape fallback — real screens count unchanged at 36 (naming
only, no new resolution paths). The remaining 23 generic navigators are a
resolution gap, not a naming-rule miss: `roleNameForRoutes`/
`commonRoutePrefix` only ever act on a route set that's already been
resolved, and most of those 23 have none yet (the third revisit's own two
tracked gaps). Full detail: `docs/BUGS.md` 2026-09-02 row (fourth entry).

**Fifth revisit (2026-09-02, "resolve more route entries" brief) — shipped,
one of the third revisit's two tracked gaps closed:** the third revisit's
own remaining-gaps note flagged "a route's depmap index compiled as two
statements ... is not traced" — `traceModuleOrigins`'s `idxTarget`
alternative only matched a literal digit inside the bracket (`r20[1]`);
Service NSW's own compiled output sometimes hoists the index into its own
register first (`r8 = 1; r3 = r20[r8];`) rather than folding it into the
bracket. Closed with a new `numLitByReg` map (`<reg> = <digit literal>;`,
tracked unconditionally — it only ever feeds the existing `idxBase ===
"depmap"` gate, so recording it costs nothing extra to guard) and a second
`idxTarget` bracket alternative (`idxRegRef`) that looks the bracket
register up in it when the bracket contents isn't a literal digit. Not
gated on `scanRouteConfigFactory` — the depmap-only reads it is folded
into already make it narrow (a `<reg> = <number>;` statement is common
in real bundles, loop counters and flags among them, but harmless to
record since it is never read except through the depmap-index lookup).
Gate-tested with a hand-built fixture (the real bundle can't be committed):
`tests/gate/split/segregate.test.ts`, "resolves a route whose depmap index
is built as two statements". react-navigation-example's pinned numbers
(4/54 WITH deps, 6/58 WITHOUT) are unchanged — it never uses this call
spelling. **Result, Service NSW (never committed, numbers only, no
`--deps-report`):** screens 36 → **176** (a ~5x jump — most of NSW's own
route-config factory modules used this exact two-statement spelling for
at least one of their routes); real names now include `PayFinesScreen`,
`RegistrationsScreen`, `CertificateOfRegistrationScreen`,
`ChangePinScreen`, `Auth0LoginErrorScreen`, `DisasterHubScreen`. Navigators
recognised dropped 26 → 18 and route/role-named navigators dropped 3 → 1
(`RootNavigator`) as a side effect, not a regression in this change:
several modules previously fell back to a generic navigator name only
because the route pointing *to* them (from a different, sibling navigator's
route config) hadn't resolved yet — `nameCandidateFor` already prefers a
resolved screen-route hit over a module's own navigator-ness (existing
precedence, unchanged by this task), so a nested navigator used as another
navigator's route target now correctly resolves as that route's screen
(e.g. former `src/navigation/VenueSignInNavigator.js` is now
`src/screens/VenueSignInScannerScreen.js`, since a sibling route config
names it `"VenueSignInScanner"`). This is filing it under the tree where
the route table would find it, matching react-navigation's own model
(a Stack/Tab navigator embedded as a screen component is a screen from its
parent's perspective) — not a loss of information. Investigated but not
shipped: most of NSW's remaining 18 "navigators" are modules that only
re-export a bare `create<X>Navigator` factory result (`r2.Stack =
Reflect.apply(r1, r0, [])`, no route registry of their own at all) rather
than an actual per-domain navigator instance — `detectNavigatorKind`'s
call-shape regex matches the factory-result property access the same way
it matches a real call site, a pre-existing (not introduced by this task)
shape-detection imprecision, out of this task's scope (route *resolution*,
not navigator *detection*); no fixture attempted, no BUGS row opened since
it produces no false-positive screen/route, only a less-specific navigator
name, and is not confirmed as a bug rather than working-as-designed shape
ambiguity. The third revisit's OTHER tracked gap (root navigator, no common
route-name prefix across domains) is unaffected by this task; already
handled by the fourth revisit's `roleNameForRoutes` fallback.

**Sixth revisit (2026-09-02, navigator-detection tightening brief) —
shipped, narrowly: the fifth revisit's own flagged imprecision partly
closed.** §3.1's `detectNavigator` now requires a call-shape match to also
*own* a route registry (`traceModuleOrigins`'s `keyAssignments` non-empty,
counted whether or not the target resolves — ownership and resolution are
separate questions) or *consume* one (`detectRouteConfigConsumer`) before
it counts as a navigator, UNLESS the module has more than one `function`
declaration in its own text (`looksLikeBareFactoryReexportShape`) — the
flatness escape hatch exists only because the fuller, unrestricted gate
regresses this spec's own pinned react-navigation-example-0.85.3 acceptance
numbers (§6 milestone 3's hard bar): hand-inspection found all 4 of that
fixture's currently-counted navigators are actually `@react-navigation/*`
package barrel/index files (many nested lazy-getter re-exports, several
unrelated properties alongside the Navigator one), 3 of which are the exact
bare-reexport shape this revisit targets — the unrestricted gate correctly
drops them (4→1, 6→1) but that regresses the pin, which the task brief
that authorised this revisit explicitly forbade touching without Fred's
review (`docs/PUSHBACK.md` P-10 has the full evidence). Shipped instead:
the narrower flatness-gated version, which keeps the pin exactly (4/54 WITH
deps, 6/58 WITHOUT, unchanged) and closes only the cleanest sub-case (a
single flat factory function, no nested closures at all). New committed
fixture (`tests/gate/split/segregate.test.ts`, "a bare create<X>Navigator
re-export ... is not counted as a navigator") hand-builds that exact shape.
**Result, Service NSW (never committed, numbers only, no `--deps-report`):**
navigators 18 → **17** (one genuinely flat bare re-export dropped);
route/role-named unchanged at 1. Hand inspection of the remaining 16 found
most (12/17 total) actually own a `.name =`/`.component =` registry
already (just with incidental nested closures — e.g. arrow-function
screen-option callbacks — that the flatness gate conservatively leaves
alone) — the fifth revisit's "most of NSW's remaining 18 ... only re-export
a bare factory" guess was itself too broad; only a handful (5-7, the
`StaticNavigator`/`MaterialTopTabNavigator`-named ones with no own
registry) remain real candidates for the fuller fix. P-10 is open, tracking
the fuller ownership-only gate pending Fred's sign-off on re-pinning
react-navigation-example's milestone-3 hard bar (4→2 navigators, screens
unaffected).

**Seventh revisit (2026-09-02, "package barrel/index modules misfiled into
`src/`" brief) — P-10 resolved, at the segregation layer rather than
`detectNavigator`.** The sixth revisit's own diagnosis was right that this
fixture's 4 counted navigators are misfiled *because of* a package-boundary
gap, but the gap is one stage upstream of `detectNavigator`: `segregate.ts`
bucketed every module by `classify.ts`'s heuristic `classification` alone,
so a module classify.ts's app-vocabulary signal calls "custom" (a package
barrel/index's re-exported names — `createStaticNavigation`,
`createMaterialTopTabNavigator`, ... — shape-match the app's own PascalCase
Screen/Navigator vocabulary token) gets filed to `src/` even when
`runDeps`'s own `moduleOwnership` (hash-matched against the signature DB,
confirmed-tier only — `src/deps/report.ts`'s own contract comment on that
field) already resolves that exact module id to a real package. Fixed in
`segregateSplitTree` (`src/split/segregate.ts`): a confirmed per-module
`moduleOwnership` entry now takes precedence over classify.ts's
classification when the two disagree — never the reverse, and never
invented where match.ts has no confirmed evidence, so this is a stronger-
evidence override, not a weakened verdict. Module 1122 (of the fixture's 4)
is that exact case: `moduleOwnership` resolves it to `@react-navigation/
native` directly; it now files to `node_modules/@react-navigation/native/`
instead of `src/navigation/StaticNavigator.js` and drops out of the
`src`-bucket set naming ever considers, so it stops being counted as a
navigator without any change to `detectNavigator`, `nameCandidateFor`, or
the sixth revisit's flatness gate. **Result, react-navigation-example-
0.85.3: 4→3 navigators, 54→50 screens (WITH deps only — the WITHOUT-deps
run has no `moduleOwnership` to read and is unchanged at 6/58).** This is
narrower than the sixth revisit's "4→2" prediction: hand-checking the other
3 previously-counted navigators against this fixture's `deps-truth.json`
(test-only ground truth built from the example app's real npm install,
never read by production code) found module 1641 is genuinely app code
(`package: null`, source ending `.../MyStackNavigator.tsx`, real per-route
logic in its decompiled text, not a barrel shape — the sixth revisit's hand
inspection over-called it as one of the "3 bare-factory-reexport" modules)
and module 1611 IS a `@react-navigation/material-top-tabs` barrel by that
same ground truth but has no `moduleOwnership` entry to act on because
`material-top-tabs` isn't in the signature DB at all — match.ts never gets
a chance to confirm it (BUGS.md follow-up: add `@react-navigation/material-
top-tabs` to the signature DB; once confirmed, this module moves too with
no further segregate.ts changes). `tests/gate/split/segregate.test.ts`'s
pinned `assert.equal`s are updated to 3/50 (WITH deps) with the full
before/after evidence inline; 6/58 (WITHOUT deps) is untouched. OSS-
benchmark precision/recall (`tools/e2e/oss-benchmark.mjs`) measured
before→after in `docs/STATUS.md`'s stage-4 cell.

**Eighth revisit (2026-09-02, generalization-sweep brief) — false-positive
screens on non-navigator apps, shipped.** A generalization sweep across
real (proprietary, local-corpus) apps found `detectScreenHits` firing on
apps with **no react-navigation usage at all**: Brex (71 fake "screens"),
Uniswap (45). Root cause: the pre-jsx-recover `{ RouteName: Component }`
registry literal shape (`routeObjRegs` in `traceModuleOrigins`, §3.2's
first bullet) was the *one* route-registry shape in that function never
gated on any navigator evidence — every other shape (`jsxScreenPending`,
`scanRouteConfigFactory`'s own `.keyName =` branch) requires the module to
already show a `create<X>Navigator` call or the NSW `routeConfig`/
`*NavigationRoutes` naming convention. `{ Key1: null, Key2: null, ... }`
with 2+ capitalised keys, later filled `.Key1 = <resolved-require>`, is not
unique to route configs: Brex's own css-tree dependency has a node-type
registry of the identical shape (`{AtrulePrelude: null, AttributeSelector:
null, ...}`, one required module per AST node type — `AtrulePreludeScreen`,
`AttributeSelectorScreen`, ... were the observed fake screens), and
register reuse in a large bundled module let an unrelated *lowercase*-keyed
assignment on the same reused register ride along too (Uniswap:
`allowedPrivateKeyLengthsScreen`, `__closureScreen`).

Fixed with two structural gates, both in `traceModuleOrigins`
(`src/split/segregate.ts`), no denylist of specific tokens:
1. The registry-literal shape (`routeObjRegs`) is only trusted when the
   containing module shows navigator evidence itself (`scanJsxScreenProps`/
   `scanRouteConfigFactory`, the same gate every other shape already uses)
   **or** is a direct dependency of some other module that does
   (`consumedByNavigator`, a new one-hop-only reverse-dependency check
   computed once in `nameCustomModules` — deliberately not a transitive
   closure over the whole graph, which would reopen the same over-match:
   almost every module in a real app is reachable from *some* navigator
   given enough hops). The one-hop case is real, not just a safety margin:
   react-navigation-example-0.85.3's own top-level `SCREENS` registry
   (module 1368) never calls `create<X>Navigator` itself and doesn't follow
   the NSW naming convention either — it's required directly by a
   `createDrawerNavigator`-calling module (1086) that builds the app's
   actual navigation from it, and without the one-hop allowance this
   fixture's own real screens would have been dropped too.
2. At the consumption site, the assigned key must *itself* look like a
   route name (`/^[A-Z]/`, the same convention the literal's own key check
   already enforces) — defense against register reuse forwarding a stale
   `routeObjRegs` membership onto an unrelated later assignment on the same
   register name, regardless of the module-level gate (fix 1 alone did not
   catch `allowedPrivateKeyLengthsScreen`; this did).

**Result:** Brex 71→0 screens, Uniswap 45→0 (no `--deps-report`, shape
alone — both apps have zero react-navigation usage hbc2js can detect,
confirmed no navigators wrongly kept either). Service NSW (WITHOUT deps,
local corpus, same split): **176→176 screens, 17→17 navigators — exactly
unchanged**, confirming NSW's real route configs are all navigator-
connected already (no tension to push back on here, unlike the brief's own
anticipated risk). react-navigation-example-0.85.3 WITH deps: 3/50
unchanged (§6 milestone-3 table). WITHOUT deps: navigators unchanged at 6;
screens re-pinned 58→52 in `tests/gate/split/segregate.test.ts` — the 6
dropped were themselves instances of the *same* bug, bundled inside this
fixture's own dependency tree (module 582, an unrelated font-weight-
constants module with no navigator anywhere in sight, shape-matched a
route registry exactly the same way Brex's css-tree did — confirmed by
hand, see the test's own inline comment). `docs/BUGS.md`: new row, closed
in the same commit as opened (fix shipped immediately, not left open).

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
