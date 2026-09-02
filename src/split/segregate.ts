// src/split/segregate.ts — D17i stage 3, "milestone 1" (docs/specs/08-
// segregation.md §6): move an already-`--split` module tree into a real
// project layout — `node_modules/<pkg>/` for library-classified modules,
// `src/` for custom-classified ones, `_unclassified/` for anything
// `classify.ts` couldn't call either way (§4 "no silent loss") — and
// "milestone 2": name the `src/` modules from single-module signals (§2.1
// steps 1-5: entry, App-registration, displayName, default-export
// identifier, createSlice) instead of leaving every custom module
// `module_<id>.js`.
//
// Segregation changes zero semantics (spec §4): the only bytes this module
// ever rewrites are (a) a `require(...)` call's string-literal argument
// when the target module moved, (b) a renamed file's header comment (one
// line prepended, never touching the factory body itself), and (c) the
// loader `index.js`'s own bookkeeping (module registration `require()` list
// + the `Module._load` interception, now a MODULES.json-driven id->path map
// instead of a `module_<id>.js` filename regex, since milestone 2 gives
// modules free-form names/directories) — never a factory function's body.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ClassificationReport, ModuleClassKind } from "../deps/classify.ts";
import type { DepsReport, ModuleOwnership } from "../deps/report.ts";

export type SegregationBucket = "src" | "node_modules" | "unclassified";

export interface SegregatedModuleInfo {
  readonly id: number;
  readonly originalFile: string;
  /** Path of the module's file, relative to the segregated tree's root
   *  (posix separators, e.g. `"src/App.js"`, `"src/store/counterSlice.js"`,
   *  `"src/module_5.js"` (no naming signal), `"node_modules/react-
   *  native/module_2.js"`, `"node_modules/_vendor/module_9.js"`). */
  readonly newPath: string;
  readonly bucket: SegregationBucket;
  readonly classification: ModuleClassKind | null;
  readonly package: string | null;
  /** Milestone 2 (§2.1): which naming step fired, if any (`null` for
   *  node_modules/unclassified modules and for `src/` modules with no
   *  signal above the confidence floor — those keep `module_<id>.js`). */
  readonly nameSignal: string | null;
  readonly nameConfidence: number | null;
}

/** §2.1 naming candidate for a single `src/`-bucket module: a step fired on
 *  the module's own decompiled text (plus, for `app-registration`, a cheap
 *  pattern check rather than a verified require-hop — see `detectAppRegistration`)
 *  and produced a base name plus the sub-directory it routes to (2.2). Not
 *  yet collision-resolved or floor-checked — `nameCustomModules` does both. */
interface NameCandidate {
  readonly baseName: string;
  readonly dir: "src" | "src/store" | "src/screens" | "src/navigation";
  readonly confidence: number;
  readonly signal: string;
}

const MIN_NAME_CONFIDENCE = 0.6; // spec §2.1 "Confidence floor", default; --min-name-confidence not wired yet (no caller passes a different value)

function detectAppRegistration(text: string): { confidence: number } | null {
  if (!text.includes("AppRegistry") || !text.includes(".registerComponent(")) return null;
  const call = /\.registerComponent\(\s*([^,]+),/.exec(text);
  if (call === null) return null;
  const arg = call[1]!.trim();
  if (/^(['"]).*\1$/.test(arg)) return { confidence: 0.95 }; // literal name argument
  // One-hop resolve shape confirmed on rn-template-0.72 module_0.js (spec
  // §2.1 step 2): `<v> = require("./module_N.js"); <v> = <v>.name;` feeding
  // the call — pattern-matched here, not content-verified against the
  // target module's text (milestone-2 scope simplification: the *file*
  // segregation names is always `App.js` regardless of the resolved
  // literal, which only ever seeds `package.json`'s `"name"` — not
  // implemented this milestone — so verifying the literal buys nothing yet).
  const hopRe = /(\w+)\s*=\s*require\((['"])\.\/module_\d+\.js\2\);\s*\n\s*\1\s*=\s*\1\.name;/;
  if (hopRe.test(text)) return { confidence: 0.8 };
  return null;
}

function detectDisplayName(text: string): { name: string; confidence: number } | null {
  const m = /\.displayName\s*=\s*(['"])([^'"]+)\1/.exec(text);
  return m === null ? null : { name: m[2]!, confidence: 0.9 };
}

function detectDefaultExportIdentifier(text: string): { name: string; confidence: number } | null {
  const declared = new Set<string>();
  for (const m of text.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]!);
  for (const m of text.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)\b/g)) declared.add(m[1]!);
  declared.delete("factory"); // src/split/index.ts's own wrapper name, never a source identifier
  for (const m of text.matchAll(/\.exports(?:\.default)?\s*=\s*([A-Za-z_$][\w$]*)\s*;/g)) {
    const ident = m[1]!;
    if (declared.has(ident)) return { name: ident, confidence: 0.7 };
  }
  return null;
}

function detectCreateSlice(text: string): { name: string; confidence: number } | null {
  const m = /createSlice\(\s*\{[^}]*\bname:\s*(['"])([^'"]+)\1/.exec(text);
  return m === null ? null : { name: m[2]!, confidence: 0.9 };
}

/** §3.3 "the module itself is `src/store/index.js` regardless of any other
 *  signal" for `configureStore(...)`/`createStore(...)` (Redux's root-store
 *  constructors, as opposed to `createSlice`'s per-slice call). Confidence
 *  0.8: strong call-name evidence, one step below `createSlice`'s literal
 *  `name:` field (nothing to verify the call is actually Redux's, but the
 *  identifier pair is distinctive enough in practice). Milestone-3 scope:
 *  single-module only (the split store case §3.3 gestures at — one dep
 *  calling `configureStore` on reducers assembled in *other* modules — is
 *  not attempted; `SEGREGATION.json`'s recorded confidence/signal makes
 *  the gap visible rather than guessing at it, same "no silent loss" spirit
 *  as §4). */
function detectStoreRoot(text: string): { confidence: number } | null {
  return /\b(?:configureStore|createStore)\s*\(/.test(text) ? { confidence: 0.8 } : null;
}

// ---------------------------------------------------------------------------
// Milestone 3 (§3.1/3.2): navigator + screen detection. Real AST walking is
// what the spec calls for ("the one signal that can't be a regex", §3.2) —
// out of budget here, so this is a documented, narrower approximation: a
// single linear scan over the module's *own* decompiled text that tracks,
// per register, whether its current value originated from `require()`-ing
// one of this module's `deps` (MODULES.json's per-module dependency-id
// list, dependencyMap-index order). Confirmed against a real fixture
// (react-navigation-example-0.85.3, HBC 98): every split module's factory
// uses the fixed 7-param signature `factory(a1..a7)` (global, require,
// importDefault, importAll, module, exports, dependencyMap — src/split's
// own convention, `src/split/rewrite.ts`'s `params[1]`/`params[params.length
// - 1]`), so the require-param/dependencyMap-param names are hardcoded
// rather than re-derived per module.
const REQUIRE_PARAM_NAME = "a2";
const DEPMAP_PARAM_NAME = "a7";

/** Route/screen-descriptor object keys (react-navigation's `Navigator`
 *  config shape, both the static-config and dynamic `{screen, options}`
 *  entry shapes) — an object literal whose keys are *all* drawn from this
 *  set is a per-route descriptor, not the outer route-name -> target map
 *  §3.2 is after (both decompile to the same `{k: null, ...}` shape; this
 *  is the only way to tell them apart without a real parser + react-
 *  navigation's own type shapes). */
const ROUTE_DESCRIPTOR_KEYS = new Set(["screen", "component", "options", "initialParams", "path", "linking", "getComponent", "if", "layout", "navigationKey"]);

interface RouteKeyAssignment {
  readonly key: string;
  /** Resolved eagerly, at the point in the linear scan the `<objReg>.<key>
   *  = <valReg>;` assignment is seen — register reuse later in a large
   *  module (e.g. `r3` rebound to a *different* required module a few
   *  statements later) must not retroactively change what an *earlier*
   *  assignment resolved to, so this can't be a `valReg` string resolved
   *  in a second pass after the whole module has been scanned (that was
   *  this function's first, buggy shape: every key ended up resolving to
   *  whatever `valReg`'s reused register held *last*, not what it held at
   *  assignment time). */
  readonly targetId: number | undefined;
}

const TRACE_STMT_RE =
  /(?<reqTarget>[A-Za-z_$][\w$]*)\s*=\s*require\((['"])\.\/module_(?<reqId>\d+)\.js\2\)\s*;|(?<paramAliasTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<paramSrc>a\d+)\s*;|(?<idxTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<idxBase>[A-Za-z_$][\w$]*)\[(?<idxNum>\d+)\]\s*;|(?<objTarget>[A-Za-z_$][\w$]*)\s*=\s*\{(?<objBody>(?:\s*[A-Za-z_$][\w$]*\s*:\s*null\s*,?)+)\}\s*;|(?<emptyObjTarget>[A-Za-z_$][\w$]*)\s*=\s*\{\}\s*;|(?<litTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<litQuote>['"])(?<litVal>[^'"]*)\k<litQuote>\s*;|(?<keyCallObj>[A-Za-z_$][\w$]*)\.(?<keyCallName>component)\s*=\s*(?<keyCallFn>[A-Za-z_$][\w$]*)\((?<keyCallArg>[A-Za-z_$][\w$]*)\)\.(?<keyCallProp>[A-Za-z_$][\w$]*)\s*;|(?<reflectTarget>[A-Za-z_$][\w$]*)\s*=\s*Reflect\.apply\(\s*(?<reflectFn>[A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*,\s*\[\s*(?<reflectArg>[A-Za-z_$][\w$]*)\s*\]\s*\)\s*;|(?<callTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<callFn>[A-Za-z_$][\w$]*)\((?<callArg>[A-Za-z_$][\w$]*)\)\s*;|(?<keyObj>[A-Za-z_$][\w$]*)\.(?<keyName>[A-Za-z_$][\w$]*)\s*=\s*(?<keyVal>[A-Za-z_$][\w$]*)\s*;|(?<propBracketTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<propBracketBase>[A-Za-z_$][\w$]*)\[(?<propBracketQuote>['"])default\k<propBracketQuote>\]\s*;|(?<propTarget>[A-Za-z_$][\w$]*)\s*=\s*(?<propBase>[A-Za-z_$][\w$]*)\.(?<propName>[A-Za-z_$][\w$]*)\s*;|(?<envAliasTarget>_e\d+_\d+)\s*=\s*(?<envAliasSrc>[A-Za-z_$][\w$]*)\s*;|(?<envAliasTarget2>[A-Za-z_$][\w$]*)\s*=\s*(?<envAliasSrc2>_e\d+_\d+)\s*;/g;

/** Single left-to-right pass over `text` tracking, per register, which of
 *  this module's `deps` (in dependencyMap-index order) it currently traces
 *  back to (`moduleOriginByReg`), plus every `<objReg>.<key> = <valReg>`
 *  assignment seen where `objReg` was created as a route-name registry
 *  literal (`{Key1: null, Key2: null, ...}` with no
 *  `ROUTE_DESCRIPTOR_KEYS`-only keys, i.e. capitalised route names, not a
 *  `{screen, options}` descriptor) — `keyAssignments`. A `{screen: ...}`
 *  descriptor's own `.screen = <ref>` assignment is folded into
 *  `moduleOriginByReg` under the *descriptor's own* register, so resolving
 *  a route through one descriptor hop (`Home: {screen: Foo}`) and resolving
 *  a route straight to a required module (`NativeStack: requiredModule`)
 *  are the same lookup at the call site. Best-effort: register reuse in a
 *  large module can stomp an earlier binding (no scope/liveness tracking),
 *  so a route can come back unresolved even when the source has a genuine
 *  target — never a false positive in the cases checked, only missed
 *  positives (§3.2 "still flagged... unresolved" spirit, though this
 *  implementation doesn't separately surface the miss). */
function traceModuleOrigins(
  text: string,
  deps: readonly number[],
  scanJsxScreenProps: boolean,
  // 2026-09-02 (Service NSW cross-module route-config brief): Service NSW's
  // own route-registry shape is neither the pre-jsx-recover static-config
  // literal (`objTarget` above) nor the destructured-JSX `{name, component}`
  // props pair (`scanJsxScreenProps`) -- it is a THIRD shape, confirmed by
  // hand on a real Service NSW module (debug function name `"routeConfig"`,
  // also seen as `"...NavigationRoutes"` on sibling modules): a registry
  // object built incrementally (`reg = {}; reg.HomeScreen = descriptor;`,
  // never a pre-shaped literal) whose *values* are themselves incrementally-
  // built descriptor objects (`descriptor = {}; descriptor.component =
  // <resolved-require>; descriptor.options = ...;`). Gated on this flag --
  // true only when *this* module's own text names itself a route-config
  // factory (the debug name comment `fn#<n> "routeConfig"`/`"...
  // NavigationRoutes"`, or the matching `<obj>.routeConfig = ...`/`<obj>.
  // ...NavigationRoutes = ...` export-property write) -- so this can't fire
  // on an unrelated module that merely happens to assign a capitalised
  // property to something that traces back to a required module (e.g. a
  // plain CommonJS barrel re-export `exports.Foo = require(...).default;`),
  // which is exactly the over-match shape the three prior attempts on this
  // bug (BUGS.md) tripped on.
  scanRouteConfigFactory: boolean,
): { moduleOriginByReg: Map<string, number>; keyAssignments: readonly RouteKeyAssignment[] } {
  const paramAlias = new Map<string, "require" | "depmap">([
    [REQUIRE_PARAM_NAME, "require"],
    [DEPMAP_PARAM_NAME, "depmap"],
  ]);
  const depIndexByReg = new Map<string, number>();
  const moduleOriginByReg = new Map<string, number>();
  const routeObjRegs = new Set<string>();
  const keyAssignments: RouteKeyAssignment[] = [];
  // 2026-09-02 (Service NSW brief): §3.2's OTHER route-config shape — post
  // jsx-recover `<Navigator.Screen name="RouteName" component={Foo} />`,
  // decompiled to an object built via `.name = "RouteName";`/`.component =
  // <ref>;` property assignments (real bundles observed with the props
  // object created empty (`obj = {};`) and filled incrementally, never the
  // pre-shaped `{name: null, component: null}` literal the *registry* case
  // above matches) — the only prior implementation here was the *other*
  // shape (`createXNavigator({ RouteName: Component })`, pre-jsx-recover),
  // which is why a real app using the JSX API scored zero screens with no
  // registry object in sight even though its route names/components are
  // plainly present in the decompiled text (confirmed on Service NSW,
  // >10 min `deps` run, `docs/specs/08-segregation.md` §3 numbers). Gated
  // on `scanJsxScreenProps` (this module itself mentions a `create<X>
  // Navigator`/`createStaticNavigation` call, §3.1) to keep the same
  // "given a navigator module" framing §3.2 states and avoid matching an
  // unrelated `.name =`/`.component =` pair anywhere in a 2000+-line
  // module (both keys are common enough alone; the pair is not, but two
  // *specific* keys with no scope tracking is still weaker evidence than
  // the registry shape's whole-object-literal match, hence gated rather
  // than global).
  const stringLitByReg = new Map<string, string>();
  const jsxScreenPending = new Map<string, { name?: string; targetId?: number }>();
  const jsxScreenHits: RouteKeyAssignment[] = [];
  // 2026-09-02 (Service NSW brief): a route-props register reused across
  // *sibling* screens in the same navigator (observed on Service NSW --
  // `let props = {}; props.component = X; registry.Home = props; props =
  // {}; props.component = Y; registry.Profile = props; ...`, the same
  // register rebound dozens of times in one route-config function) used to
  // silently lose every screen but the last one sharing that register: the
  // reset below (`obj = {}`/`{...}` rebinding it for the next screen) just
  // deleted the pending entry outright, and `jsxScreenHits` was only ever
  // populated once, from whatever `jsxScreenPending` held at the very end
  // of the whole scan -- so an earlier, *complete* {name, component} pair
  // on a since-reused register was discarded before ever being read.
  // Flushing a complete pending pair into `jsxScreenHits` right here, before
  // the reset drops it, is what makes a synthetic two-screens-same-register
  // fixture (this task's own regression test) resolve both screens instead
  // of only the last one -- and is very likely why Service NSW's own
  // multi-screen `routeConfig`-shaped modules recovered zero screens even
  // where the component resolution itself (this task's other fix) was
  // correct.
  function flushJsxScreenPending(reg: string): void {
    const pending = jsxScreenPending.get(reg);
    if (pending?.name !== undefined && pending.targetId !== undefined) jsxScreenHits.push({ key: pending.name, targetId: pending.targetId });
    jsxScreenPending.delete(reg);
  }

  // 2026-09-02 (Service NSW cross-module route-config brief): a route-config
  // factory module's require/dependencyMap parameters are routed through
  // closure-captured `_eNNNN_M` slots that the OUTER function assigns near
  // the *end* of its own body -- but, in source text, a nested function's
  // *declaration* (and, syntactically, its body) comes before the
  // statements that follow it in the enclosing function, so the code that
  // *reads* an env slot (inside the nested function) appears earlier in
  // `text` than the code that *writes* it (the outer function's own
  // parameter-capture line) even though the write always runs first at
  // runtime. A single left-to-right pass (this scan's own documented
  // design) can never resolve that read, no matter how the env-alias rule
  // above is written -- confirmed by hand on the sample bundle's own
  // `routeConfig` module (`_e7119_0 = r5;` appears in the outer function
  // body, textually *after* the nested `_fn24381` that reads `_e7119_0`).
  // Run the whole scan twice for a route-config factory: the first pass's
  // only job is to populate `paramAlias`/`depIndexByReg`/`moduleOriginByReg`
  // (order-independent enough in practice -- every env slot this convention
  // uses is assigned exactly once, from a stable top-level parameter alias,
  // never reassigned), so by the second (real) pass every `_eNNNN_M` read is
  // already resolved regardless of where it sits in the text. Gated on
  // `scanRouteConfigFactory` -- doubling the regex scan cost of every module
  // in a large real bundle is not worth paying where this ordering issue
  // never arises (confirmed: react-navigation-example's own modules never
  // hit this, so this can't itself regress the hard bar).
  function runScan(): void {
    for (const m of text.matchAll(TRACE_STMT_RE)) {
    const g = m.groups!;
    if (g.reqTarget !== undefined) {
      moduleOriginByReg.set(g.reqTarget, Number(g.reqId));
    } else if (g.paramAliasTarget !== undefined) {
      const kind = paramAlias.get(g.paramSrc!);
      if (kind !== undefined) paramAlias.set(g.paramAliasTarget, kind);
    } else if (g.idxTarget !== undefined) {
      if (paramAlias.get(g.idxBase!) === "depmap") {
        const idx = Number(g.idxNum);
        if (idx >= 0 && idx < deps.length) depIndexByReg.set(g.idxTarget, idx);
      }
    } else if (g.objTarget !== undefined) {
      const keys = Array.from(g.objBody!.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*null/g)).map((k) => k[1]!);
      // A route-name registry's keys are screen/route identifiers, which in
      // practice (both React component convention and every route name
      // observed in react-navigation-example-0.85.3) start with an
      // uppercase letter — the guard that keeps this from firing on
      // arbitrary same-shape `{key: null, ...}` object literals elsewhere
      // in a large real module (observed false positives before this
      // guard: gesture-handler/reanimated builder objects like `{get:
      // null, changeX: null, waitFor: null, ...}`, all lowercase/camelCase
      // method names).
      const looksLikeRouteNames = keys.length >= 2 && keys.every((k) => /^[A-Z]/.test(k));
      if (looksLikeRouteNames && !keys.every((k) => ROUTE_DESCRIPTOR_KEYS.has(k))) routeObjRegs.add(g.objTarget);
      if (scanJsxScreenProps) flushJsxScreenPending(g.objTarget); // register reused for the next screen (or an unrelated object) -- flush any complete pending pair first, then drop the rest
    } else if (g.emptyObjTarget !== undefined) {
      if (scanJsxScreenProps) flushJsxScreenPending(g.emptyObjTarget); // same reset/flush, for the JSX-props shape's own `obj = {};` starting point
    } else if (g.litTarget !== undefined) {
      if (scanJsxScreenProps) stringLitByReg.set(g.litTarget, g.litVal!);
    } else if (g.callTarget !== undefined) {
      const idx = depIndexByReg.get(g.callArg!);
      if (paramAlias.get(g.callFn!) === "require" && idx !== undefined) moduleOriginByReg.set(g.callTarget, deps[idx]!);
    } else if (g.reflectTarget !== undefined) {
      // 2026-09-02 (Service NSW cross-module brief): the same require-call
      // resolution as `callTarget` above, just spelled `Reflect.apply(fn,
      // thisArg, [arg])` instead of a direct call `fn(arg)` -- confirmed by
      // hand as Service NSW's own compiled shape for every `require()` call
      // it makes (`r3 = Reflect.apply(r19, r17, [r3]);` where `r19` traces
      // back to the require parameter and `r3` to a depmap index), never
      // observed on react-navigation-example. Gated identically to
      // `callTarget` (`paramAlias` must resolve `reflectFn` to `require`,
      // `reflectArg` must be a traced depmap index) -- `Reflect.apply` is
      // used pervasively for unrelated calls too (any function invoked
      // without a fixed `this`), so this guard is what stops it from
      // resolving those as if they were requires. Additionally gated on
      // `scanRouteConfigFactory` -- confirmed necessary, not just belt-and-
      // braces: react-navigation-example itself uses `Reflect.apply` for
      // plenty of unrelated calls elsewhere, and letting this branch resolve
      // module origins in every module (rather than only ones already
      // opted in via the naming convention) fed stray, correctly-guarded-
      // but-still-wrong resolutions into that fixture's *existing*
      // pre-shaped route registries through ordinary register reuse in a
      // large module -- an observed regression (a nested navigator's own
      // module wrongly renamed as a screen) caught by this task's own hard
      // regression bar before this gate was added.
      const idx = depIndexByReg.get(g.reflectArg!);
      if (scanRouteConfigFactory && paramAlias.get(g.reflectFn!) === "require" && idx !== undefined) moduleOriginByReg.set(g.reflectTarget, deps[idx]!);
    } else if (g.envAliasTarget !== undefined || g.envAliasTarget2 !== undefined) {
      // 2026-09-02 (Service NSW cross-module brief): a copy into or out of
      // one of `src/split`'s own closure-captured environment-slot
      // variables (`_eNNNN_M` — its own convention for a value read by a
      // nested function, `src/split/rewrite.ts`), needed because Service
      // NSW's own compiled output routes the require/dependencyMap
      // *parameters* through exactly one such slot rather than referencing
      // `a2`/`a7` directly from the inner function that does the actual
      // `require()` call (`r5 = a2; ...; _e7119_0 = r5; ...; function
      // inner(){ r19 = _e7119_0; ... }` — a plain copy on each side of the
      // slot). Deliberately NOT a general `<reg> = <reg>;` copy rule (tried
      // first, reverted: register names are reused across every function in
      // a module, so a plain copy rule forwards a stale origin across
      // unrelated functions purely by name collision — confirmed regression
      // on react-navigation-example, 58 -> 86 screens). The `_eNNNN_M` name
      // itself is unique per closure capture site (never reused the way
      // `r0`/`r1` are), so restricting to copies touching one is narrow by
      // construction. Forwards whichever of the three per-register maps
      // already has an entry for the source — never manufactures a new
      // origin, only carries an existing one across the slot. Gated on
      // `scanRouteConfigFactory` for the same reason `reflectTarget` above
      // is: even this narrow a rule, applied to every module, resolved
      // stray origins in react-navigation-example's own unrelated modules
      // through register-name reuse (same observed regression).
      if (scanRouteConfigFactory) {
        const target = g.envAliasTarget ?? g.envAliasTarget2!;
        const src = g.envAliasSrc ?? g.envAliasSrc2!;
        const kind = paramAlias.get(src);
        if (kind !== undefined) paramAlias.set(target, kind);
        const idx = depIndexByReg.get(src);
        if (idx !== undefined) depIndexByReg.set(target, idx);
        const origin = moduleOriginByReg.get(src);
        if (origin !== undefined) moduleOriginByReg.set(target, origin);
      }
    } else if (g.keyObj !== undefined) {
      if (routeObjRegs.has(g.keyObj)) keyAssignments.push({ key: g.keyName!, targetId: moduleOriginByReg.get(g.keyVal!) });
      // 2026-09-02 (Service NSW cross-module brief): the third route-config
      // shape (see `scanRouteConfigFactory`'s own comment above) -- a
      // registry object accumulated via `<reg>.<RouteName> = <descriptor>;`
      // (never a pre-shaped `{RouteName: null, ...}` literal, so it never
      // joins `routeObjRegs` above) whose *value* is a descriptor register
      // that itself resolved a module origin via this same scan's `.screen
      // =`/`.component =` forwarding just below. `keyName` must look like a
      // route name (capitalised — the same convention `objTarget`'s
      // `looksLikeRouteNames` guard above already relies on) so this can't
      // fire on an unrelated lowercase-keyed accumulator object; gated on
      // `scanRouteConfigFactory` (this module names *itself* a route-config
      // factory) so it can't fire on a plain CommonJS barrel re-export
      // (`exports.Foo = require(...).default;`) elsewhere, which would
      // otherwise look identical (a capitalised key assigned a register with
      // a resolved module origin). `keyName` must also NOT itself match the
      // `routeConfig`/`*NavigationRoutes` naming convention -- that would be
      // this same module's own self-export write (`r2.routeConfig = ...;`/
      // `r4.VenueSignInNavigationRoutes = ...;`, `looksLikeRouteConfigFactory`
      // above's own signal), never a per-route registry key, and a false
      // "screen named `<Domain>NavigationRoutes`" observed on a real bundle
      // before this exclusion.
      if (scanRouteConfigFactory && /^[A-Z]/.test(g.keyName!) && !ROUTE_CONFIG_FACTORY_NAME_RE.test(g.keyName!)) {
        const origin = moduleOriginByReg.get(g.keyVal!);
        if (origin !== undefined) keyAssignments.push({ key: g.keyName!, targetId: origin });
      }
      if (g.keyName === "screen") {
        const origin = moduleOriginByReg.get(g.keyVal!);
        if (origin !== undefined) moduleOriginByReg.set(g.keyObj, origin);
      }
      if (scanRouteConfigFactory && g.keyName === "component") {
        // Forwards a descriptor object's own `.component = <resolved>;`
        // origin onto the descriptor register itself, exactly parallel to
        // the `.screen =` case above (a `{screen: Foo}` descriptor and a
        // `{component: Foo}` descriptor are the same shape under two
        // different react-navigation config conventions) -- gated on
        // `scanRouteConfigFactory` rather than shared with `.screen =`
        // unconditionally, since `component` alone (unlike `screen`) is
        // common enough as an unrelated prop name elsewhere that the extra
        // gate is worth keeping.
        const origin = moduleOriginByReg.get(g.keyVal!);
        if (origin !== undefined) moduleOriginByReg.set(g.keyObj, origin);
      }
      if (scanJsxScreenProps && (g.keyName === "name" || g.keyName === "component")) {
        const pending = jsxScreenPending.get(g.keyObj) ?? {};
        if (g.keyName === "name") {
          const lit = stringLitByReg.get(g.keyVal!);
          if (lit !== undefined) pending.name = lit;
        } else {
          const origin = moduleOriginByReg.get(g.keyVal!);
          if (origin !== undefined) pending.targetId = origin;
        }
        jsxScreenPending.set(g.keyObj, pending);
      }
    } else if (g.keyCallObj !== undefined) {
      // 2026-09-02 (Service NSW `Reflect.apply`-hop brief, BUGS row): the
      // JSX-props shape's `.component = <ref>;` assignment above assumes the
      // required module is already bound to its own register (`<ref>` is a
      // bare identifier) -- true on react-navigation-example, but Service
      // NSW's own decompiled text instead compiles the require call and the
      // named-export member access into a *single* statement,
      // `<props>.component = require(<dep>).<NamedExport>;` (observed by
      // hand across dozens of Service NSW route modules, e.g.
      // `r1.component = r5(r6[4]).SSOWebViewController;`), never binding an
      // intermediate register the existing `callTarget`/`propTarget`
      // alternatives (each matching only half of this) could chain through.
      // Gated exactly as narrowly as the two-statement case above --
      // `scanJsxScreenProps` (this module itself calls a Navigator
      // factory), `keyCallName` fixed to the literal `component` (not a
      // general property, so this can't fire on an unrelated
      // `<anything>.component = fn(x).Y;` outside a navigator module), and
      // `keyCallFn` must resolve via `paramAlias` to `require` with
      // `keyCallArg` a traced depmap index -- the same require-resolution
      // guard `callTarget` already uses, just inline in one statement
      // instead of two. `keyCallProp` (the named export, e.g.
      // `SSOWebViewController`) is intentionally not used to pick a
      // specific export -- this resolver works at module granularity
      // everywhere else (a `.default` access resolves to the whole
      // module), so this stays consistent rather than adding a new
      // per-export lookup this function doesn't otherwise support.
      const idx = depIndexByReg.get(g.keyCallArg!);
      if (paramAlias.get(g.keyCallFn!) === "require" && idx !== undefined && scanJsxScreenProps) {
        const origin = deps[idx]!;
        const pending = jsxScreenPending.get(g.keyCallObj) ?? {};
        pending.targetId = origin;
        jsxScreenPending.set(g.keyCallObj, pending);
      }
    } else if (g.propBracketTarget !== undefined) {
      // Same interop-default hop as the `propTarget`/`propName` case below,
      // just Service NSW's bracket-notation spelling of it
      // (`_e7971_2["default"]`, vs. react-navigation-example's `.default`)
      // -- only ever *forwards* an origin `propBracketBase` already has
      // (from a prior `require`/`callTarget` binding), so this can't
      // introduce a new false-positive origin, only recognise the same one
      // through different call-site syntax.
      const origin = moduleOriginByReg.get(g.propBracketBase!);
      if (origin !== undefined) moduleOriginByReg.set(g.propBracketTarget, origin);
    } else if (g.propTarget !== undefined) {
      const origin = moduleOriginByReg.get(g.propBase!);
      if (origin !== undefined) moduleOriginByReg.set(g.propTarget, origin);
    }
    }
  }

  if (scanRouteConfigFactory) runScan(); // warm-up pass, see comment above -- populates env-slot aliases regardless of text order, discarded below
  routeObjRegs.clear();
  keyAssignments.length = 0;
  stringLitByReg.clear();
  jsxScreenPending.clear();
  jsxScreenHits.length = 0;
  runScan(); // real pass -- paramAlias/depIndexByReg/moduleOriginByReg from the warm-up (if any) carry over; every output collection above was just reset

  if (scanJsxScreenProps) {
    for (const pending of jsxScreenPending.values()) {
      if (pending.name !== undefined && pending.targetId !== undefined) jsxScreenHits.push({ key: pending.name, targetId: pending.targetId });
    }
  }
  return { moduleOriginByReg, keyAssignments: keyAssignments.concat(jsxScreenHits) };
}

interface ScreenHit {
  readonly routeName: string;
  readonly targetId: number;
  readonly confidence: number;
  readonly sourceId: number;
}

// 2026-09-02 (Service NSW cross-module route-config brief): confirmed by
// hand across four independent Service NSW modules (the app's own
// `routeConfig`, plus `LicenceNavigationRoutes`/`FinesNavigationRoutes`/
// `CheckInNavigationRoutes`/`VenueSignInNavigationRoutes`) — a route-config
// *factory* module always both (a) names the function that builds its map
// `routeConfig` or `<Domain>NavigationRoutes` in the debug function-name
// table (preserved as `src/split`'s own `// fn#<n> "<name>"` comment) and
// (b) writes the finished map onto its own module-object register under a
// property of that exact name (`r2.LicenceNavigationRoutes = r1;`, always
// preceded by a placeholder write of the same property — Metro's live-
// bindings interop shim — which is why this checks for the property name at
// all rather than the specific value assigned). Either signal alone is
// narrow (an app-specific naming convention, not a react-navigation API
// shape), so a module matching neither is never treated as a route-config
// factory, no matter what its object literals look like.
const ROUTE_CONFIG_FACTORY_NAME_RE = /routeConfig|[A-Za-z]*NavigationRoutes/;
function looksLikeRouteConfigFactory(text: string): boolean {
  if (new RegExp(`//\\s*fn#\\d+\\s+"(?:${ROUTE_CONFIG_FACTORY_NAME_RE.source})"`).test(text)) return true;
  return new RegExp(`[A-Za-z_$][\\w$]*\\.(?:${ROUTE_CONFIG_FACTORY_NAME_RE.source})\\s*=`).test(text);
}

/** 2026-09-02 (Service NSW cross-module route-config brief): the *consumer*
 *  half of the same convention — a navigator module that never builds a
 *  route map itself but instead merges one or more required modules'
 *  `routeConfig`/`<Domain>NavigationRoutes` exports and walks the result via
 *  `Object.entries(...)` (confirmed by hand, module 1711 in the sample
 *  bundle: `r4 = r4.routeConfig; r8 = Reflect.apply(r4, r3, [r8]); ... r6 =
 *  r6.entries(r4);` — note `Object` itself is bound to a register too, so
 *  the call reads `<reg>.entries(...)`, never the literal text
 *  `Object.entries(`). This module's own text has no statically-traceable
 *  `{name, component}` pairs at all — the descriptor objects only exist as
 *  values inside the merged runtime map `.entries()` walks, invisible to a
 *  per-module regex scan (real decompiler dataflow across a `.map()`
 *  callback boundary, out of this milestone's scope, §3.2 pushback below) —
 *  so this is used only to (a) recognise the module as a navigator at all
 *  (§3.1, no `create<X>Navigator` call in sight) and (b) as the entry point
 *  for borrowing its route-config deps' already-resolved route names for
 *  naming purposes (`nameCustomModules`). Gated on the property-name
 *  convention plus a bare `.entries(` call so it can't fire on an unrelated
 *  module that merely happens to mention `routeConfig`/`*NavigationRoutes`
 *  without also walking a map of them. */
function detectRouteConfigConsumer(text: string): boolean {
  return /\.entries\(/.test(text) && new RegExp(`\\.(?:${ROUTE_CONFIG_FACTORY_NAME_RE.source})\\b`).test(text);
}

/** §3.2, resolved via `traceModuleOrigins`: every route-registry key this
 *  module's text assigns whose value resolves to another module in `deps`
 *  is a screen hit — confidence 0.85 (spec's "literal route" tier; every
 *  hit here comes from a literal object key, never a computed one, so
 *  there is no lower-confidence "dynamic" case to distinguish in this
 *  implementation). */
function detectScreenHits(id: number, text: string, deps: readonly number[]): ScreenHit[] {
  const scanJsxScreenProps = detectNavigatorKind(text).length > 0;
  const scanRouteConfigFactory = looksLikeRouteConfigFactory(text);
  const { keyAssignments } = traceModuleOrigins(text, deps, scanJsxScreenProps, scanRouteConfigFactory);
  const hits: ScreenHit[] = [];
  for (const a of keyAssignments) {
    if (a.targetId !== undefined) hits.push({ routeName: a.key, targetId: a.targetId, confidence: 0.85, sourceId: id });
  }
  return hits;
}

/** §3.1: a `create<X>Navigator(...)`/`createStaticNavigation(...)`-shaped
 *  call name (grep, per spec's own "reads: the module's decompiled text
 *  (grep for the call name)") plus at least one of this module's `deps`
 *  resolving (via `ownershipByModule`/`classByModule`, never re-derived) to
 *  `@react-navigation/*`. Deliberately looser than resolving the exact
 *  callee's require edge (`traceModuleOrigins` above, used for §3.2's
 *  route walk) — a 2000+-line real `App.tsx` reuses registers so heavily
 *  across unrelated code that pinning the *specific* call's origin register
 *  is unreliable; "this module both calls a Navigator factory and requires
 *  a react-navigation package" is the evidence the spec's own text
 *  describes checking for, and is enough to not be confused with an
 *  unrelated `createFooNavigator`-named local helper (the `deps` check is
 *  exactly the guard against that false positive). */
function detectNavigatorKind(text: string): readonly string[] {
  const kinds: string[] = [];
  for (const m of text.matchAll(/\.create([A-Za-z]+?)Navigator\b/g)) kinds.push(m[1]!);
  if (/\.createStaticNavigation\b/.test(text)) kinds.push("Static");
  // 2026-09-02 (Service NSW cross-module route-config brief): a module that
  // walks `Object.entries(routeConfig)` (no `create<X>Navigator` call in
  // sight, §3.1's own JSX/dynamic case) is a navigator too — kind `""`
  // (existing "no call-shape kind to report" fallback in `nameCandidateFor`,
  // used since §3.1's own destructured-JSX shape). Narrower than the
  // previously-reverted `.Navigator`/`.Screen` property-read gate (BUGS.md,
  // comment above): that fired on any module rendering a nested navigator;
  // this requires the app-specific `routeConfig`/`*NavigationRoutes`
  // property-name convention plus `Object.entries(`, never observed outside
  // an actual route-config consumer.
  if (kinds.length === 0 && detectRouteConfigConsumer(text)) kinds.push("");
  return kinds;
}
// 2026-09-02 (Service NSW brief, BUGS row "segregation-without-deps...
// destructured {Navigator, Screen}..."): a widened gate here -- "this
// module reads *some* register's `.Navigator` AND `.Screen` properties" --
// was tried and measured, not shipped: on react-navigation-example-0.85.3
// (the fixture this row's own hard regression bar is pinned against) it
// inflates screen count 54 -> 67 (WITH deps) and 58 -> 79 (WITHOUT deps),
// the *exact* over-match this row already recorded once for a cruder
// version of the same idea. Root cause: react-navigation-example's own
// screen components routinely read `<X>.Navigator`/`<X>.Screen` off a
// locally-destructured navigator object too (nested/child navigators
// declared inside what §2.1 would otherwise name a plain screen module),
// so "reads both properties somewhere in this module" is not a reliable
// signal that *this* module is the outer route-config module holding the
// `{name, component}` pairs -- it fires on any module that merely renders
// a nested navigator. See docs/BUGS.md for the follow-up row (kept open,
// not filed as fixed) and docs/PUSHBACK.md is not used here since this is
// a measured "doesn't work", not a request the brief made twice.

/** 2026-09-02 (Service NSW brief): deps used to be *required* here -- with
 *  no `--deps-report` (or a report that simply hasn't classified this
 *  module's deps), `ownershipByModule`/`classByModule` are empty and the
 *  loop below never sets `confidence`, so the whole function returned
 *  `null` even when the call shape itself (`create<X>Navigator`) was
 *  unambiguous. That is exactly the case a slow `deps` run (Service NSW,
 *  >10 min) forces on every caller who just wants a named `src/screens/`
 *  tree fast. Deps is now a *confirming*, not required, signal: the
 *  call-shape match alone is `hasClassificationData` fallback confidence
 *  0.6 (same floor as the existing "unnamed library-classified dep" tier,
 *  so it still clears `MIN_NAME_CONFIDENCE`) -- but only when no
 *  classification data was supplied *at all* (`hasClassificationData`
 *  false, i.e. `deps === null` was passed to `segregateSplitTree`). When a
 *  deps report *is* present but simply doesn't confirm this particular
 *  call (none of its deps resolve to `@react-navigation/*` or a library),
 *  this still returns `null` as before -- a real classify.ts verdict that
 *  didn't confirm the call is stronger negative evidence than having no
 *  verdict at all, and changing that would regress the acceptance numbers
 *  the spec's §6 milestone-3 table records for react-navigation-example
 *  (deps-confirmed run). */
function detectNavigator(
  deps: readonly number[],
  text: string,
  ownershipByModule: ReadonlyMap<number, ModuleOwnership>,
  classByModule: ReadonlyMap<number, ModuleClassKind>,
  hasClassificationData: boolean,
): { kind: string; confidence: number } | null {
  const kinds = detectNavigatorKind(text);
  if (kinds.length === 0) return null;
  let confidence: number | null = null;
  for (const d of deps) {
    const pkg = ownershipByModule.get(d)?.package;
    if (pkg !== undefined && /^@react-navigation\//.test(pkg)) { confidence = 0.9; break; }
    if (classByModule.get(d) === "library") confidence = confidence ?? 0.6;
  }
  if (confidence !== null) return { kind: kinds[0]!, confidence };
  if (!hasClassificationData) return { kind: kinds[0]!, confidence: 0.6 };
  return null;
}

/** §2.1 steps 1-5, in priority order, applied per module. Reads only this
 *  module's own decompiled text (`text`) plus whether it is the split
 *  tree's entry (`isEntry`, from `MODULES.json.entry`) — no cross-module
 *  walking (milestone 3).
 *
 *  Documented deviation from the literal spec ordering ("entry ... always,
 *  regardless of any other signal"): on a real app the bundle's entry
 *  module is *usually* a thin wrapper distinct from the registered
 *  component, but on a minimal one-file app (rn-template-0.72's module 0)
 *  the entry module *is* the one calling `AppRegistry.registerComponent`
 *  directly. Naming that module `index.js` would bury the one signal an
 *  analyst actually wants (`App.js`, the registered component) behind a
 *  generic bootstrap name that, in this collapsed case, describes nothing
 *  else. When both signals fire on the *same* module, `app-registration`
 *  wins; an entry module with no `registerComponent` call of its own still
 *  gets `index.js` as spec'd.
 *
 *  Milestone 3 adds two more, cross-module candidates the caller
 *  (`nameCustomModules`) computes ahead of time and passes in per module id
 *  — `bestScreenHit` (this module is some navigator's route target, §3.2)
 *  and `navigator` (this module itself calls a Navigator factory, §3.1).
 *  Priority, and why it isn't the spec's literal 1-7 order: entry/app-
 *  registration (1-2) still win outright — the single most useful name a
 *  module can have. A resolved **screen** hit is placed *above*
 *  displayName/default-export/createSlice (spec order would put it below,
 *  step 6), because in the fixture this was implemented against
 *  (react-navigation-example-0.85.3) every screen component also has its
 *  own `displayName`/default export, and burying the *route* name
 *  (`StackBasic`, `BottomTabs`, ...) behind a generic component name would
 *  throw away the one signal an analyst actually wants from a router-heavy
 *  app — the same "don't bury the more useful name" reasoning milestone 2
 *  already used for entry/app-registration, extended here to §2.2's own
 *  words for screens vs components ("screen beats generic component, more
 *  specific signal wins"). Not a PUSHBACK: no existing test asserts the
 *  literal step order for signals introduced in this milestone. A navigator
 *  candidate is lowest of the "real" signals (only used when nothing else
 *  fired) since a navigator module is otherwise indistinguishable from any
 *  other custom component/util. */
function nameCandidateFor(
  text: string,
  isEntry: boolean,
  bestScreenHit: { routeName: string; confidence: number } | null,
  navigator: { kind: string; confidence: number } | null,
  navigatorRouteNames: readonly string[] = [],
): NameCandidate | null {
  const appReg = detectAppRegistration(text);
  if (isEntry) {
    if (appReg !== null) return { baseName: "App", dir: "src", confidence: appReg.confidence, signal: "app-registration (entry module also calls registerComponent, §6 milestone-2 note)" };
    return { baseName: "index", dir: "src", confidence: 1.0, signal: "entry" };
  }
  if (appReg !== null) return { baseName: "App", dir: "src", confidence: appReg.confidence, signal: "app-registration" };
  if (bestScreenHit !== null) {
    const base = bestScreenHit.routeName;
    const baseName = /Screen$/.test(base) ? base : `${base}Screen`;
    return { baseName, dir: "src/screens", confidence: bestScreenHit.confidence, signal: `screen-route (route "${bestScreenHit.routeName}", §3.2)` };
  }
  const displayName = detectDisplayName(text);
  if (displayName !== null) return { baseName: displayName.name, dir: "src", confidence: displayName.confidence, signal: "displayName" };
  const defaultExport = detectDefaultExportIdentifier(text);
  if (defaultExport !== null) return { baseName: defaultExport.name, dir: "src", confidence: defaultExport.confidence, signal: "default-export-identifier" };
  const slice = detectCreateSlice(text);
  if (slice !== null) return { baseName: `${slice.name}Slice`, dir: "src/store", confidence: slice.confidence, signal: "createSlice" };
  const storeRoot = detectStoreRoot(text);
  if (storeRoot !== null) return { baseName: "index", dir: "src/store", confidence: storeRoot.confidence, signal: "store-root (configureStore/createStore, §3.3)" };
  if (navigator !== null) {
    // 2026-09-02 (Service NSW brief, naming half): Fred's own review of a
    // prior run's output ("`StackNavigator.2.js` are bad — type + collision
    // counter, not the app name") — name the navigator from the ROUTE SET
    // it holds (this module's own resolved §3.2 screen hits' common name
    // prefix, e.g. `Licence`/`LicenceLinking`/`LicenceScanner` -> `Licence`)
    // rather than its react-navigation call-shape kind, which is at best
    // "Stack"/"Tab" (identical across every navigator in an app, hence the
    // ordinal-suffix collisions Fred flagged) and at worst unknown entirely
    // (the destructured-JSX shape above has no kind to report). Falls back
    // to `<Type>Navigator` (or a bare `Navigator` when even the kind is
    // unknown) only when no route-set prefix OR role name resolves.
    const prefix = commonRoutePrefix(navigatorRouteNames);
    if (prefix !== null) {
      const baseName = /Navigator$/.test(prefix) ? prefix : `${prefix}Navigator`;
      return { baseName, dir: "src/navigation", confidence: navigator.confidence, signal: `navigator (route-set prefix "${prefix}", §3.1)` };
    }
    // §3.1's own "container role" fallback (2026-09-02, docs/BUGS.md's
    // cross-module route-config walk row: "the root navigator ... has no
    // common route-name prefix by design, so it keeps the generic
    // Navigator.js name ... an already-documented gap"). A navigator whose
    // routes span several domains with no shared prefix -- Service NSW's
    // own root/tab container, merging LicenceScan/DDLCheck/AuthLogin/... --
    // still gets a real name when one domain dominates its route set
    // (`roleNameForRoutes`'s plurality rule), and a deterministic role name
    // ("RootNavigator"/"MainTabNavigator") when none does, rather than
    // falling straight to the generic call-shape name below.
    const role = navigatorRouteNames.length > 0 ? roleNameForRoutes(navigatorRouteNames, navigator.kind) : null;
    if (role !== null) {
      return { baseName: role, dir: "src/navigation", confidence: navigator.confidence, signal: `navigator (route-set role "${role}", §3.1)` };
    }
    const baseName = navigator.kind === "" ? "Navigator" : /Navigator$/.test(navigator.kind) ? navigator.kind : `${navigator.kind}Navigator`;
    const signal = navigator.kind === "" ? "navigator (destructured Navigator/Screen JSX usage, §3.1)" : `navigator (create${navigator.kind}Navigator-shaped call, §3.1)`;
    return { baseName, dir: "src/navigation", confidence: navigator.confidence, signal };
  }
  return null;
}

/** §3.1 naming (Service NSW brief): the longest common prefix of a
 *  navigator's own resolved route names, trimmed back to the last
 *  camelCase word boundary so `Licence`/`LicenceLinking`/`LicenceScanner`
 *  yields `"Licence"` rather than an arbitrary mid-word cut, and `null`
 *  (meaning "no usable prefix, fall back to kind-based naming") for an
 *  empty route set, a route set with no shared prefix at all (`Home`/
 *  `Profile` -> `""` immediately), or a prefix too short to be a
 *  meaningful name (`< 3` chars — guards against e.g. `Home`/`Help`
 *  degenerating to a bare `"H"`). */
function commonRoutePrefix(routeNames: readonly string[]): string | null {
  if (routeNames.length === 0) return null;
  let prefix = routeNames[0]!;
  for (const name of routeNames.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") return null;
  }
  for (let k = prefix.length; k > 0; k--) {
    const candidate = prefix.slice(0, k);
    const isBoundary = routeNames.every((n) => n.length === k || /[A-Z0-9]/.test(n[k] ?? ""));
    if (isBoundary) return candidate.length >= 3 ? candidate : null;
  }
  return null;
}

/** The leading "domain word" of a single route name, for `roleNameForRoutes`
 *  below: an all-caps abbreviation run immediately followed by a
 *  capitalised word (`"DDL"` from `"DDLCheck"`, needs >= 2 letters so a
 *  single leading capital doesn't count as its own abbreviation), or
 *  failing that the first capitalised camelCase word (`"Licence"` from
 *  `"LicenceScan"`, `"Home"` from `"Home"`, needs >= 3 letters — same
 *  degenerate-short-name floor `commonRoutePrefix` already applies to its
 *  own prefix). `null` for a route name with no usable leading word (not
 *  expected on real react-navigation route names, always PascalCase, but
 *  must not throw on anything unanticipated). */
function domainToken(name: string): string | null {
  const abbrev = /^[A-Z]+(?=[A-Z][a-z])/.exec(name);
  if (abbrev !== null && abbrev[0].length >= 2) return abbrev[0];
  const word = /^[A-Z][a-z0-9]*/.exec(name);
  if (word !== null && word[0].length >= 3) return word[0];
  return null;
}

/** §3.1's "container role" fallback (2026-09-02, Service NSW brief; the
 *  gap `commonRoutePrefix` alone left open, recorded in docs/BUGS.md's
 *  cross-module route-config walk row): names a navigator whose own route
 *  set has NO common prefix -- it spans several domains, e.g. a root/tab
 *  container merging `LicenceScan`/`DDLCheck`/`AuthLogin`/... -- from
 *  whichever single domain token (`domainToken` above) accounts for at
 *  least half its routes, so a navigator that's mostly one domain plus a
 *  couple of outliers still gets a real domain name rather than a generic
 *  one. When no domain reaches that bar (a genuinely diverse root/tab
 *  container, the case Fred's own review flagged), returns a deterministic
 *  role name instead: `"MainTabNavigator"` when the call-shape kind names a
 *  tab navigator (`create<X>TabNavigator`, kind contains "Tab"),
 *  `"RootNavigator"` otherwise — the top-level container shape. Ties for
 *  the most-common token are broken by first-seen order (route names arrive
 *  in a fixed, module-id/text-order sequence from `nameCustomModules`), so
 *  this is deterministic across runs, never dependent on Map iteration
 *  order alone. Returns `null` only when every route name is unusable for
 *  `domainToken` (kept distinct from the "diverse, no dominant domain"
 *  case, which still returns a role name — an empty/garbage route set
 *  should fall through to the generic call-shape name instead). Also
 *  returns `null` outright for fewer than `MIN_ROLE_ROUTES` routes: a plain
 *  two-screen stack (e.g. `Home`/`Profile`, no shared prefix by design —
 *  they're just two unrelated screens, not "several domains") must keep
 *  its call-shape name (`StackNavigator`), not get promoted to `Home` or
 *  `RootNavigator` off a coin-flip between two routes — the "many domains"
 *  shape this fallback targets is a real aggregator navigator, several
 *  routes deep, never a small navigator that simply has no prefix. */
function roleNameForRoutes(routeNames: readonly string[], kind: string): string | null {
  const MIN_ROLE_ROUTES = 4;
  if (routeNames.length < MIN_ROLE_ROUTES) return null;
  const counts = new Map<string, number>();
  let usable = 0;
  for (const name of routeNames) {
    const token = domainToken(name);
    if (token === null) continue;
    usable++;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  if (usable === 0) return null;
  let bestToken: string | null = null;
  let bestCount = 0;
  for (const name of routeNames) {
    const token = domainToken(name);
    if (token === null) continue;
    const count = counts.get(token)!;
    if (count > bestCount) { bestCount = count; bestToken = token; }
  }
  if (bestToken !== null && bestCount * 2 >= routeNames.length) {
    return /Navigator$/.test(bestToken) ? bestToken : `${bestToken}Navigator`;
  }
  return /tab/i.test(kind) ? "MainTabNavigator" : "RootNavigator";
}

/** Assigns §2.1 names to every `src`-bucket module: computes a candidate per
 *  module (`nameCandidateFor`), applies the confidence floor, then resolves
 *  same-path collisions deterministically by *module id* order (spec §2.1
 *  "Collisions" — open question 6.2 asks about a more stable disambiguator
 *  across incremental re-runs; this ships the spec's own stopgap, a numeric
 *  ordinal suffix, since Fred hasn't ruled on 6.2 yet). Returns the final
 *  `src/...`-relative path (or `null`, meaning "keep `module_<id>.js`") plus
 *  the signal/confidence used, per module id, for the header comment and
 *  audit trail (`MODULES.json`'s `segregated` field). */
function nameCustomModules(
  srcModules: readonly { id: number; text: string }[],
  entryId: number | null,
  depsByModuleId: ReadonlyMap<number, readonly number[]>,
  ownershipByModule: ReadonlyMap<number, ModuleOwnership>,
  classByModule: ReadonlyMap<number, ModuleClassKind>,
): Map<number, { path: string; signal: string; confidence: number } | null> {
  // No classification data at all (no `--deps-report`, i.e. `classByModule`
  // is empty) -- §3.1/3.2's deps-based guards below only ever *narrow*
  // results when there is something to narrow with, never manufacture one.
  const hasClassificationData = classByModule.size > 0;
  // Milestone 3 (§3.2): every screen hit any src-bucket module's route
  // registry produced, keyed by *target* module id — a target can in
  // principle be claimed by more than one registry (e.g. re-exported under
  // two route names); kept deterministic by highest confidence, then
  // lowest source module id, then route name, never run order.
  const hitsByTarget = new Map<number, ScreenHit[]>();
  // §3.1 naming (Service NSW brief): every screen hit, also keyed by its
  // *source* module id (the navigator/route-config module that produced
  // it) — a navigator's own route set, used to name it after its routes
  // rather than its react-navigation call-shape kind (`commonRoutePrefix`
  // in `nameCandidateFor`). Same custom-classification guard as
  // `hitsByTarget` below (a route resolving to a library re-export is the
  // same false positive either way).
  const routeNamesBySource = new Map<number, string[]>();
  for (const m of srcModules) {
    for (const hit of detectScreenHits(m.id, m.text, depsByModuleId.get(m.id) ?? [])) {
      // §3.1's own framing, restated for §3.2: a screen target is app code,
      // never a library module (a route registry that happens to also
      // re-export a library barrel entry -- observed in the fixture this
      // was built against -- is exactly the false positive this guard
      // exists to drop). With no classification data at all (2026-09-02,
      // Service NSW brief), there is nothing to confirm "custom" against --
      // require it only when a deps report actually classified the target;
      // otherwise let the literal route-name hit through (§3.2's own
      // "resolved via require edges" evidence is real regardless of
      // whether classify.ts ever ran).
      if (hasClassificationData && classByModule.get(hit.targetId) !== "custom") continue;
      const list = hitsByTarget.get(hit.targetId);
      if (list === undefined) hitsByTarget.set(hit.targetId, [hit]);
      else list.push(hit);
      const srcList = routeNamesBySource.get(hit.sourceId);
      if (srcList === undefined) routeNamesBySource.set(hit.sourceId, [hit.routeName]);
      else srcList.push(hit.routeName);
    }
  }
  const bestScreenHitByTarget = new Map<number, { routeName: string; confidence: number }>();
  for (const [targetId, hits] of hitsByTarget) {
    hits.sort((a, b) => b.confidence - a.confidence || a.sourceId - b.sourceId || a.routeName.localeCompare(b.routeName));
    bestScreenHitByTarget.set(targetId, { routeName: hits[0]!.routeName, confidence: hits[0]!.confidence });
  }

  // 2026-09-02 (Service NSW cross-module route-config brief): a route-config
  // *consumer* module (`detectRouteConfigConsumer`, e.g. Service NSW's own
  // `RootStack`) never appears as a `sourceId` above -- it has no
  // statically-traceable `{name, component}` pairs of its own, only a
  // `Object.entries(...)` walk over a runtime value merged from its own
  // required route-config factories. Its route set for naming purposes
  // (§3.1's `commonRoutePrefix`) is instead every route name already
  // resolved for its *own* `deps` (one hop across the require edge
  // `depsByModuleId` already carries) -- real cross-module dataflow, not a
  // same-module regex: the names come from a *different* module's resolved
  // hits, reached only through the dependency graph.
  for (const m of srcModules) {
    if (!detectRouteConfigConsumer(m.text)) continue;
    const names: string[] = routeNamesBySource.get(m.id) ?? [];
    for (const dep of depsByModuleId.get(m.id) ?? []) {
      const depNames = routeNamesBySource.get(dep);
      if (depNames !== undefined) names.push(...depNames);
    }
    if (names.length > 0) routeNamesBySource.set(m.id, names);
  }

  const raw = new Map<number, NameCandidate | null>();
  for (const m of srcModules) {
    const navigator = detectNavigator(depsByModuleId.get(m.id) ?? [], m.text, ownershipByModule, classByModule, hasClassificationData);
    raw.set(m.id, nameCandidateFor(m.text, m.id === entryId, bestScreenHitByTarget.get(m.id) ?? null, navigator, routeNamesBySource.get(m.id) ?? []));
  }

  const byPath = new Map<string, number[]>();
  for (const [id, cand] of raw) {
    if (cand === null || cand.confidence < MIN_NAME_CONFIDENCE) continue;
    const path = cand.dir === "src" ? `src/${cand.baseName}.js` : `${cand.dir}/${cand.baseName}.js`;
    const list = byPath.get(path);
    if (list === undefined) byPath.set(path, [id]);
    else list.push(id);
  }

  const finalPathById = new Map<number, string>();
  for (const [path, ids] of byPath) {
    ids.sort((a, b) => a - b); // id-ordered collision suffixing (spec §2.1 "Collisions"; open Q 6.2: ordinal vs. hash — default ordinal)
    ids.forEach((id, i) => {
      if (i === 0) { finalPathById.set(id, path); return; }
      const dot = path.lastIndexOf(".js");
      finalPathById.set(id, `${path.slice(0, dot)}.${i + 1}${path.slice(dot)}`);
    });
  }

  const result = new Map<number, { path: string; signal: string; confidence: number } | null>();
  for (const [id, cand] of raw) {
    const path = finalPathById.get(id);
    result.set(id, path === undefined || cand === null ? null : { path, signal: cand.signal, confidence: cand.confidence });
  }
  return result;
}

export interface SegregateResult {
  /** Every file to write, keyed by path relative to the segregated tree's
   *  root — module files, the rewritten `index.js` loader, and the
   *  annotated `MODULES.json`. */
  readonly files: ReadonlyMap<string, string>;
  readonly modules: readonly SegregatedModuleInfo[];
}

interface SplitModulesJson {
  readonly hbcVersion: number;
  readonly moduleCount: number;
  readonly entry: number | null;
  readonly modules: readonly { id: number; file: string; factoryFunctionIndex: number; deps: readonly number[] }[];
}

const REQUIRE_RE = /require\((['"])\.\/module_(\d+)\.js\1\)/g;

/** The exact `Module._load` interception block `buildLoaderIndexJs`
 *  (src/split/index.ts) always emits — literal source text, not a JS
 *  RegExp value. Milestone 1 could get away with loosening this to a
 *  filename-suffix match (`/module_(\d+)\.js$/`) because every module kept
 *  its `module_<id>.js` name, just in a new directory. Milestone 2 gives
 *  `src/` modules free-form names (`App.js`, `store/counterSlice.js`, ...),
 *  so recovering a module id from the request string by filename no longer
 *  works at all — this whole block is replaced (see `buildPathMapLoadBlock`
 *  below) with a static id->absolute-path map built from the same
 *  `idToNewPath` this module already computes, resolved once against
 *  `index.js`'s own directory (the segregated tree's root). */
const LOADER_LOAD_BLOCK = [
  `var __hbc_split_Module = require("module");`,
  `var __hbc_split_origLoad = __hbc_split_Module._load;`,
  `__hbc_split_Module._load = function (request, parent, isMain) {`,
  `  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);`,
  `  if (m) return __r(Number(m[1]));`,
  `  return __hbc_split_origLoad.apply(this, arguments);`,
  `};`,
].join("\n");

function buildPathMapLoadBlock(modules: readonly { id: number; file: string }[], idToNewPath: ReadonlyMap<number, string>): string {
  const lines: string[] = [];
  lines.push(`var __hbc_split_path = require("path");`);
  lines.push(`var __hbc_split_Module = require("module");`);
  lines.push(`var __hbc_split_origLoad = __hbc_split_Module._load;`);
  lines.push(`var __hbc_split_idByAbsPath = new Map();`);
  for (const m of modules) {
    const target = idToNewPath.get(m.id);
    if (target === undefined) continue;
    lines.push(`__hbc_split_idByAbsPath.set(__hbc_split_path.join(__dirname, ${JSON.stringify(target)}), ${m.id});`);
  }
  lines.push(`__hbc_split_Module._load = function (request, parent, isMain) {`);
  lines.push(`  if (parent && typeof request === "string" && request.charAt(0) === ".") {`);
  lines.push(`    var __hbc_resolved = __hbc_split_path.resolve(__hbc_split_path.dirname(parent.filename), request);`);
  lines.push(`    var __hbc_id = __hbc_split_idByAbsPath.get(__hbc_resolved);`);
  lines.push(`    if (__hbc_id !== undefined) return __r(__hbc_id);`);
  lines.push(`  }`);
  lines.push(`  return __hbc_split_origLoad.apply(this, arguments);`);
  lines.push(`};`);
  return lines.join("\n");
}

function packageDirName(pkg: string): string {
  // Scoped packages (`@scope/name`) become a two-level `node_modules/`
  // directory, same as npm itself — no sanitisation needed beyond that,
  // `pkg` comes from `moduleOwnership.package`, already a valid npm name.
  return pkg;
}

/** Posix-relative require specifier from `fromPath` (a file's own new path,
 *  relative to the segregated tree root) to `toPath` (another file's new
 *  path), always `./`- or `../`-prefixed. */
function relativeRequire(fromPath: string, toPath: string): string {
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const fromParts = fromDir === "" ? [] : fromDir.split("/");
  const toParts = toPath.split("/");
  let i = 0;
  while (i < fromParts.length && i < toParts.length - 1 && fromParts[i] === toParts[i]) i++;
  const ups = fromParts.length - i;
  const downs = toParts.slice(i);
  const rel = [...Array(ups).fill(".."), ...downs].join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function rewriteRequireStrings(content: string, ownPath: string, idToNewPath: ReadonlyMap<number, string>): string {
  return content.replace(REQUIRE_RE, (whole, quote: string, idStr: string) => {
    const id = Number(idStr);
    const target = idToNewPath.get(id);
    if (target === undefined) return whole; // unreachable in practice: every id in MODULES.json has a bucket
    const spec = relativeRequire(ownPath, target);
    return `require(${quote}${spec}${quote})`;
  });
}

/** Rewrites the `--split` loader's `index.js` (src/split/index.ts
 *  `buildLoaderIndexJs`) to (a) require every module from its new path and
 *  (b) recognise a require request for a moved module regardless of its
 *  new directory (see `LOADER_INTERCEPT_RE_SOURCE`). Structural changes to
 *  the loader's own bookkeeping, not a module factory body — outside the
 *  scope of the §4.1 byte-diff proof, which is about `module_<id>.js`
 *  files only. */
function rewriteLoaderIndexJs(original: string, modules: readonly { id: number; file: string }[], idToNewPath: ReadonlyMap<number, string>): string {
  let out = original;
  for (const m of modules) {
    const target = idToNewPath.get(m.id);
    if (target === undefined) continue;
    const oldReq = `require('./${m.file}');`;
    const newReq = `require('./${target}');`;
    out = out.split(oldReq).join(newReq);
  }
  if (!out.includes(LOADER_LOAD_BLOCK)) throw new Error("segregate: index.js did not contain the expected Module._load interception pattern");
  return out.split(LOADER_LOAD_BLOCK).join(buildPathMapLoadBlock(modules, idToNewPath));
}

/** Milestone 1 (docs/specs/08-segregation.md §6): buckets every module by
 *  `classification.classification` alone (never re-derived here — the spec
 *  is explicit that segregation reads classify.ts's verdict, it does not
 *  recompute it) and, for `library` modules, names the `node_modules/`
 *  directory from `moduleOwnership` when a confirmed package exists,
 *  falling back to one flat `node_modules/_vendor/` bucket otherwise (the
 *  spec's provisional flat-bucket option, open question 6.4 — per-hash
 *  subdirectories are a later refinement pending Fred). A module with no
 *  classification at all (no `--deps-report` given, or the module id isn't
 *  present in the report) is never guessed into either bucket — it lands
 *  in `_unclassified/` (spec §4 "no silent loss"). */
export function segregateSplitTree(splitFiles: ReadonlyMap<string, string>, deps: DepsReport | null): SegregateResult {
  const modulesJsonText = splitFiles.get("MODULES.json");
  if (modulesJsonText === undefined) throw new Error("segregate: split tree has no MODULES.json");
  const modulesJson = JSON.parse(modulesJsonText) as SplitModulesJson;

  const classification: ClassificationReport | null = deps?.classification ?? null;
  const classByModule = new Map<number, ModuleClassKind>();
  if (classification !== null) {
    for (const c of classification.modules) if (c.localModuleId !== null) classByModule.set(c.localModuleId, c.classification);
  }
  const ownershipByModule = new Map<number, ModuleOwnership>();
  if (deps !== null) {
    for (const o of deps.moduleOwnership) if (o.localModuleId !== null) ownershipByModule.set(o.localModuleId, o);
  }

  const idToNewPath = new Map<number, string>();
  const infos: SegregatedModuleInfo[] = [];
  for (const m of modulesJson.modules) {
    const cls = classByModule.get(m.id) ?? null;
    let bucket: SegregationBucket;
    let newPath: string;
    let pkg: string | null = null;
    if (cls === "library") {
      bucket = "node_modules";
      const owner = ownershipByModule.get(m.id);
      if (owner !== undefined) {
        pkg = owner.package;
        newPath = `node_modules/${packageDirName(pkg)}/module_${m.id}.js`;
      } else {
        newPath = `node_modules/_vendor/module_${m.id}.js`;
      }
    } else if (cls === "custom") {
      bucket = "src";
      newPath = `src/module_${m.id}.js`;
    } else {
      bucket = "unclassified";
      newPath = `_unclassified/module_${m.id}.js`;
    }
    idToNewPath.set(m.id, newPath);
    infos.push({ id: m.id, originalFile: m.file, newPath, bucket, classification: cls, package: pkg, nameSignal: null, nameConfidence: null });
  }
  infos.sort((a, b) => a.id - b.id);

  // Milestone 2 (§2.1 steps 1-5): name every `src`-bucket module from its
  // own decompiled text (plus entry-ness from MODULES.json) — never
  // node_modules modules.
  //
  // 2026-09-02 (Service NSW brief): `unclassified` modules (no
  // `--deps-report`, or the report simply didn't cover this module id) are
  // *also* fed through naming now, not just `src`-bucket ones — milestone
  // 1's "no classification -> _unclassified/, never guessed" rule was right
  // for the *bucketing* verdict (still true: an unclassified module that
  // scores no name candidate stays in `_unclassified/`, never silently
  // reclassified as app code), but was blocking §3.1/3.2's own call/config-
  // shape evidence from ever running at all when deps is slow or absent
  // (Service NSW: >10 min for a `deps` run) — exactly backwards from the
  // spec's "deps confirms, doesn't gate" framing this milestone restores.
  // A navigator/screen (or any §2.1 step 1-5) name candidate strong enough
  // to clear `MIN_NAME_CONFIDENCE` promotes the module from `unclassified`
  // to `src`; anything that doesn't name stays exactly where milestone 1
  // left it.
  const srcTexts: { id: number; text: string }[] = [];
  for (const info of infos) {
    if (info.bucket !== "src" && info.bucket !== "unclassified") continue;
    const text = splitFiles.get(info.originalFile);
    if (text === undefined) throw new Error(`segregate: split tree has no file for module ${info.id} (${info.originalFile})`);
    srcTexts.push({ id: info.id, text });
  }
  const depsByModuleId = new Map<number, readonly number[]>(modulesJson.modules.map((m) => [m.id, m.deps]));
  const namesById = nameCustomModules(srcTexts, modulesJson.entry, depsByModuleId, ownershipByModule, classByModule);
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i]!;
    if (info.bucket !== "src" && info.bucket !== "unclassified") continue;
    const named = namesById.get(info.id) ?? null;
    if (named === null) continue;
    idToNewPath.set(info.id, named.path);
    infos[i] = { ...info, bucket: "src", newPath: named.path, nameSignal: named.signal, nameConfidence: named.confidence };
  }

  const files = new Map<string, string>();
  for (const info of infos) {
    const original = splitFiles.get(info.originalFile);
    if (original === undefined) throw new Error(`segregate: split tree has no file for module ${info.id} (${info.originalFile})`);
    const rewritten = rewriteRequireStrings(original, info.newPath, idToNewPath);
    const withHeader =
      info.nameSignal === null
        ? rewritten
        : `// hbc2js segregate -- Metro module ${info.id} (was module_${info.id}.js; named via ${info.nameSignal}, confidence ${info.nameConfidence!.toFixed(2)})\n${rewritten}`;
    files.set(info.newPath, withHeader);
  }

  const originalIndexJs = splitFiles.get("index.js");
  if (originalIndexJs === undefined) throw new Error("segregate: split tree has no index.js");
  files.set("index.js", rewriteLoaderIndexJs(originalIndexJs, modulesJson.modules, idToNewPath));

  files.set(
    "MODULES.json",
    JSON.stringify(
      {
        ...modulesJson,
        modules: modulesJson.modules.map((m) => {
          const info = infos.find((i) => i.id === m.id)!;
          return { ...m, segregated: { path: info.newPath, bucket: info.bucket, classification: info.classification, package: info.package, nameSignal: info.nameSignal, nameConfidence: info.nameConfidence } };
        }),
      },
      null,
      2,
    ) + "\n",
  );

  // Every other file in the split tree (there are none today besides the
  // three above — `splitProject` only ever emits module files, `index.js`,
  // `MODULES.json`) is intentionally not carried forward unmodified: if a
  // future split-tree gains a new top-level file this throws loudly at the
  // caller instead of silently shipping something segregation never
  // reasoned about.
  for (const [name] of splitFiles) {
    if (name === "index.js" || name === "MODULES.json") continue;
    if (!infos.some((i) => i.originalFile === name)) {
      throw new Error(`segregate: split tree has an unexpected top-level file ${name} segregation does not know how to place`);
    }
  }

  return { files, modules: infos };
}

/** Reads a `--split`-written directory (top-level files only —
 *  `writeSplitResult`/`splitProject` never nest) into the
 *  `Map<string, string>` `segregateSplitTree` expects. */
export function readSplitDir(splitDir: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(splitDir)) {
    files.set(name, readFileSync(join(splitDir, name), "utf8"));
  }
  return files;
}

export function writeSegregateResult(result: SegregateResult, outDir: string): void {
  for (const [relPath, content] of result.files) {
    const dest = join(outDir, relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
}
