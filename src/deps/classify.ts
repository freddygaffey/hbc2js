// src/deps/classify.ts — D17i stage 2 / D17h: classify each Metro module as
// third-party LIBRARY (ignorable) vs the app's OWN CODE, without naming the
// package. Naming (D17a/D17f/D17g, `match.ts`/`guess.ts`) is the hard,
// slow-to-improve problem; classification is the easier one and delivers
// the headline goal on its own ("show me only the app's code").
//
// Signals, in priority order (D17h):
//   1. Cross-app recurrence (primary) — measured per FUNCTION, not per whole
//      module: each function's normalised exact-bytecode hash
//      (`sig-normalise.ts`'s `normaliseFunctionForSignature`, masking the
//      Metro dependency-map index, same hash `match.ts`'s signature DB
//      already uses) is looked up in a commonality index of hash ->
//      distinct-bundle-count. Whole-MODULE hashing was tried first and
//      measured far too strict: a library module's factory + every nested
//      closure must be byte-identical across builds for the module hash to
//      recur at all, which real apps rarely share (different RN/toolchain
//      versions perturb at least one nested closure almost everywhere).
//      Per-function hashing finds the same shared library CODE (a helper
//      like `invariant`/`_extends`/a React internal) even when the module
//      wrapping it differs build to build. A module is classified library
//      when the majority of its own instruction weight comes from functions
//      whose hash recurs in >= N distinct bundles (small/trivial functions
//      below `minInstr` are excluded from eligibility — same FLIRT-style
//      floor `match.ts`/`docs/PACKAGE-SIGNATURES.md` §2.4 uses, since tiny
//      functions collide across unrelated code by chance). An app's own
//      logic is not, by construction, also present byte-for-byte in
//      unrelated apps; a function whose exact bytecode recurs across
//      distinct apps is shared library code by definition. The recurrence
//      corpus is a committable "commonality index" of hash ->
//      distinct-bundle-count (never bundle content) built by
//      `buildCommonalityIndex` below and persisted at
//      `tools/pkgsig/commonality-index.json`
//      (`build-commonality-index.mjs` regenerates it; see docs/DEPS.md).
//   2. `node_modules/...` paths or `pkg@x.y.z`-shaped strings baked into a
//      module's string constants.
//   3. Structural shape — many small functions, no app-specific-looking
//      strings (routes, screens, asset paths) — a coarse, low-confidence
//      fallback signal.
//
// A module that clears none of these is left "app" (the default: false
// negatives here only mean some library code still shows up as app code,
// which is the safe direction to be wrong in) unless it is trivially empty,
// in which case it is "unknown".

import { readFileSync } from "node:fs";
import type { InventoryModule, ModuleInventory } from "./inventory.ts";

// ---------------------------------------------------------------------------
// Commonality index: per-FUNCTION exact-hash -> count of DISTINCT bundles it
// was seen in. Counts and hashes only, per D16 — never bundle content, never
// a bundle identifier that could be reversed to a proprietary app.
// ---------------------------------------------------------------------------

export interface CommonalityIndex {
  readonly version: 2;
  /** How many distinct bundles contributed to this index. */
  readonly bundleCount: number;
  /** per-function exact bytecode hash (`SigFunction.exactHash`) -> number of
   *  distinct contributing bundles that contained a function with this hash
   *  at or above `minInstr` instructions. */
  readonly hashes: Readonly<Record<string, number>>;
}

export const EMPTY_COMMONALITY_INDEX: CommonalityIndex = { version: 2, bundleCount: 0, hashes: {} };

/** FLIRT-style minimum-instruction floor before a function's exact hash is
 *  trusted as a commonality signal at all (same rationale/default as
 *  `match.ts`'s `--min-instr`, docs/PACKAGE-SIGNATURES.md §2.4): below this,
 *  tiny functions collide across unrelated code by chance and would produce
 *  false "library" hits. */
export const DEFAULT_MIN_INSTR = 8;

/** The set of distinct per-function exact hashes present in one bundle's
 *  inventory, at or above `minInstr` instructions — the unit
 *  `buildCommonalityIndex` counts recurrence over (a function appearing
 *  many times in the *same* bundle, or a module's own factory + nested
 *  closures sharing a hash, must not inflate its cross-app count). */
export function functionHashesForCommonality(inventory: ModuleInventory, minInstr: number = DEFAULT_MIN_INSTR): ReadonlySet<string> {
  const out = new Set<string>();
  for (const f of inventory.functions) {
    if (f.instrCount >= minInstr) out.add(f.exactHash);
  }
  return out;
}

/** Builds a commonality index from one hash-set per contributing bundle.
 *  Pure aggregation — callers are responsible for producing each bundle's
 *  hash set (typically via `buildInventory` + `functionHashesForCommonality`)
 *  and for never passing anything but hashes across a D16 proprietary-corpus
 *  boundary. */
export function buildCommonalityIndex(perBundleHashSets: readonly ReadonlySet<string>[]): CommonalityIndex {
  const hashes: Record<string, number> = {};
  for (const set of perBundleHashSets) {
    for (const h of set) hashes[h] = (hashes[h] ?? 0) + 1;
  }
  return { version: 2, bundleCount: perBundleHashSets.length, hashes };
}

/** Merges two commonality indexes built from disjoint bundle sets (e.g. an
 *  open-source-corpus index plus a separately-built local/proprietary-corpus
 *  index) by summing per-hash counts and bundle counts. Still hash-only. */
export function mergeCommonalityIndexes(a: CommonalityIndex, b: CommonalityIndex): CommonalityIndex {
  const hashes: Record<string, number> = { ...a.hashes };
  for (const [h, n] of Object.entries(b.hashes)) hashes[h] = (hashes[h] ?? 0) + n;
  return { version: 2, bundleCount: a.bundleCount + b.bundleCount, hashes };
}

export function loadCommonalityIndex(path: string): CommonalityIndex {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return EMPTY_COMMONALITY_INDEX;
  }
  try {
    const parsed = JSON.parse(text) as Partial<CommonalityIndex>;
    if (parsed.version !== 2 || typeof parsed.hashes !== "object" || parsed.hashes === null) return EMPTY_COMMONALITY_INDEX;
    return { version: 2, bundleCount: typeof parsed.bundleCount === "number" ? parsed.bundleCount : 0, hashes: parsed.hashes as Record<string, number> };
  } catch {
    return EMPTY_COMMONALITY_INDEX;
  }
}

/** Default location of the committed commonality index — hashes + counts
 *  only, see the module doc comment and docs/DEPS.md's "Commonality index"
 *  section for how it's built and refreshed. */
export const DEFAULT_COMMONALITY_INDEX_PATH = "tools/pkgsig/commonality-index.json";

// ---------------------------------------------------------------------------
// Supporting signals
// ---------------------------------------------------------------------------

const NODE_MODULES_PATH_RE = /\bnode_modules\//;

function hasNodeModulesPathString(m: InventoryModule): boolean {
  return m.stringConstants.some((s) => NODE_MODULES_PATH_RE.test(s));
}

// A bare or scoped npm package name immediately followed by a semver-ish
// version — the shape a library's own "X vN.N.N" banner/warning-prefix
// string takes (distinct from `guess.ts`'s curated evidence tables, which
// this file deliberately does not import — classification stays
// self-contained per this task's ownership split).
const PACKAGE_NAME_VERSION_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*[@ ]v?\d+\.\d+\.\d+/i;

function hasPackageNameVersionString(m: InventoryModule): boolean {
  return m.stringConstants.some((s) => PACKAGE_NAME_VERSION_RE.test(s));
}

// Coarse "this string looks app-specific" filter used only to *veto* the
// structural-shape signal below — an asset path, a route/screen-ish
// identifier, or a URL naming this app's own backend all say "this module
// knows something about one particular app", which library glue does not.
const APP_SPECIFIC_STRING_RE = /\.(png|jpe?g|gif|svg|webp|ttf|otf|woff2?)$/i;
const SCREEN_OR_ROUTE_RE = /(Screen|Route|Navigator)$/;

function looksAppSpecific(s: string): boolean {
  return APP_SPECIFIC_STRING_RE.test(s) || SCREEN_OR_ROUTE_RE.test(s);
}

/** Structural-shape fallback (D17h): many small functions and few/no
 *  strings, none of them app-specific-looking. Deliberately the
 *  lowest-confidence, last-checked signal — library modules with a single
 *  large function or with genuinely no strings at all are common enough
 *  that this alone is coarse; it only fires when the module also cleared
 *  a minimum function count so a single tiny helper module doesn't trip it. */
const STRUCTURAL_MIN_FUNCTIONS = 3;
const STRUCTURAL_MAX_AVG_INSTR = 40;
const STRUCTURAL_MAX_STRINGS = 2;

function hasStructuralLibraryShape(m: InventoryModule): boolean {
  const fnCount = m.functionIndices.length;
  if (fnCount < STRUCTURAL_MIN_FUNCTIONS) return false;
  if (m.stringConstants.length > STRUCTURAL_MAX_STRINGS) return false;
  if (m.stringConstants.some(looksAppSpecific)) return false;
  const avgInstr = m.instrCount / fnCount;
  return avgInstr <= STRUCTURAL_MAX_AVG_INSTR;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ModuleClassKind = "library" | "app" | "unknown";

export type ClassificationSignal = "cross-app-recurrence" | "node-modules-path" | "package-name-version-string" | "structural-shape" | "none";

export interface ModuleClassification {
  readonly localModuleId: number | null;
  readonly factoryFunctionIndex: number;
  readonly instrCount: number;
  readonly classification: ModuleClassKind;
  readonly signal: ClassificationSignal;
  /** How many distinct bundles in the commonality index this module's
   *  content hash was seen in (0 if the index has never seen it). Populated
   *  regardless of which signal ultimately decided the classification, so a
   *  near-miss (recurrence 1 below the threshold) is visible. */
  readonly recurrenceCount: number;
}

export interface ClassifyOptions {
  /** Minimum distinct-bundle recurrence count for a function's hash to count
   *  as "recurring" for the cross-app-recurrence signal (D17h: "N+ unrelated
   *  app bundles"). Default 2 — the smallest N that actually means "seen
   *  outside this one bundle"; raise it as the commonality index's bundle
   *  corpus grows to keep the signal meaning "genuinely common", not
   *  "happened to match one other app". */
  readonly recurrenceThreshold?: number;
  /** Same floor as `functionHashesForCommonality` — must match whatever the
   *  loaded index was built with, or recurrence counts silently under-count
   *  (an index built with a stricter floor than the target's own eligible
   *  set is harmless; the reverse just finds nothing new). */
  readonly minInstr?: number;
  /** Minimum fraction of a module's OWN instruction weight that must come
   *  from recurring functions for the whole module to be classified
   *  library. Default 0.5 (a simple majority) — a module that imports one
   *  small shared helper alongside a lot of its own logic should not be
   *  swept in. */
  readonly recurrenceFraction?: number;
}

const DEFAULT_RECURRENCE_THRESHOLD = 2;
const DEFAULT_RECURRENCE_FRACTION = 0.5;

/** One of a module's own functions, as needed to score the cross-app-
 *  recurrence signal — `classifyInventory` derives these from
 *  `ModuleInventory.functions` via each module's `functionIndices`; exposed
 *  so `classifyModule` itself stays a pure, easily-unit-tested function. */
export interface ModuleFunctionSample {
  readonly exactHash: string | null;
  readonly instrCount: number;
}

export function classifyModule(m: InventoryModule, functions: readonly ModuleFunctionSample[], index: CommonalityIndex, opts: ClassifyOptions = {}): ModuleClassification {
  const threshold = opts.recurrenceThreshold ?? DEFAULT_RECURRENCE_THRESHOLD;
  const minInstr = opts.minInstr ?? DEFAULT_MIN_INSTR;
  const fractionNeeded = opts.recurrenceFraction ?? DEFAULT_RECURRENCE_FRACTION;

  let recurringWeight = 0;
  let maxRecurrenceCount = 0;
  for (const f of functions) {
    if (f.exactHash === null || f.instrCount < minInstr) continue;
    const count = index.hashes[f.exactHash] ?? 0;
    if (count > maxRecurrenceCount) maxRecurrenceCount = count;
    if (count >= threshold) recurringWeight += f.instrCount;
  }
  const fraction = m.instrCount === 0 ? 0 : recurringWeight / m.instrCount;
  const base = { localModuleId: m.localModuleId, factoryFunctionIndex: m.factoryFunctionIndex, instrCount: m.instrCount, recurrenceCount: maxRecurrenceCount };

  if (fraction >= fractionNeeded && recurringWeight > 0) return { ...base, classification: "library", signal: "cross-app-recurrence" };
  if (hasNodeModulesPathString(m)) return { ...base, classification: "library", signal: "node-modules-path" };
  if (hasPackageNameVersionString(m)) return { ...base, classification: "library", signal: "package-name-version-string" };
  if (hasStructuralLibraryShape(m)) return { ...base, classification: "library", signal: "structural-shape" };

  // No library signal. A module with real content (instructions or its own
  // strings) is presumed the app's own code — the safe default direction
  // (D17h's goal is never hiding real app code); one with neither is too
  // small to say anything about either way.
  if (m.instrCount > 0 || m.stringConstants.length > 0) return { ...base, classification: "app", signal: "none" };
  return { ...base, classification: "unknown", signal: "none" };
}

export interface ClassificationSummary {
  readonly totalInstrWeight: number;
  readonly libraryInstrWeight: number;
  readonly appInstrWeight: number;
  readonly unknownInstrWeight: number;
  /** THE headline metric (D17h/brief): how much of the bundle, by
   *  instruction weight, is anonymous-or-named library code an analyst can
   *  ignore — computed without naming a single package. */
  readonly percentLibraryByWeight: number;
  readonly percentAppByWeight: number;
  /** `libraryInstrWeight` broken out by which signal decided it, so it's
   *  visible how much rests on the strong primary signal vs. the weaker
   *  supporting ones. */
  readonly libraryInstrWeightBySignal: Readonly<Record<Exclude<ClassificationSignal, "none">, number>>;
  readonly libraryModuleCount: number;
  readonly appModuleCount: number;
  readonly unknownModuleCount: number;
}

export function summarizeClassifications(classifications: readonly ModuleClassification[]): ClassificationSummary {
  let totalInstrWeight = 0;
  let libraryInstrWeight = 0;
  let appInstrWeight = 0;
  let unknownInstrWeight = 0;
  let libraryModuleCount = 0;
  let appModuleCount = 0;
  let unknownModuleCount = 0;
  const bySignal: Record<Exclude<ClassificationSignal, "none">, number> = {
    "cross-app-recurrence": 0,
    "node-modules-path": 0,
    "package-name-version-string": 0,
    "structural-shape": 0,
  };
  for (const c of classifications) {
    totalInstrWeight += c.instrCount;
    if (c.classification === "library") {
      libraryInstrWeight += c.instrCount;
      libraryModuleCount++;
      if (c.signal !== "none") bySignal[c.signal] += c.instrCount;
    } else if (c.classification === "app") {
      appInstrWeight += c.instrCount;
      appModuleCount++;
    } else {
      unknownInstrWeight += c.instrCount;
      unknownModuleCount++;
    }
  }
  return {
    totalInstrWeight,
    libraryInstrWeight,
    appInstrWeight,
    unknownInstrWeight,
    percentLibraryByWeight: totalInstrWeight === 0 ? 0 : (libraryInstrWeight / totalInstrWeight) * 100,
    percentAppByWeight: totalInstrWeight === 0 ? 0 : (appInstrWeight / totalInstrWeight) * 100,
    libraryInstrWeightBySignal: bySignal,
    libraryModuleCount,
    appModuleCount,
    unknownModuleCount,
  };
}

export interface ClassificationReport {
  readonly modules: readonly ModuleClassification[];
  readonly summary: ClassificationSummary;
  /** How many distinct bundles the commonality index used was built from —
   *  context for how much to trust `cross-app-recurrence` hits (a
   *  bundleCount of 1 means that signal can never fire at the default
   *  threshold). */
  readonly commonalityIndexBundleCount: number;
}

/** Classifies every module in a bundle's inventory (D17i stage 2). Pure
 *  function of the inventory + a pre-loaded/pre-built commonality index —
 *  callers (`src/deps/index.ts`) decide where that index comes from
 *  (`loadCommonalityIndex(DEFAULT_COMMONALITY_INDEX_PATH)`, typically). */
export function classifyInventory(inventory: ModuleInventory, index: CommonalityIndex, opts: ClassifyOptions = {}): ClassificationReport {
  const functionsByIndex = new Map(inventory.functions.map((f) => [f.index, f]));
  const modules = inventory.modules.map((m) => {
    const samples: ModuleFunctionSample[] = m.functionIndices.map((i) => {
      const f = functionsByIndex.get(i);
      return { exactHash: f?.exactHash ?? null, instrCount: f?.instrCount ?? 0 };
    });
    return classifyModule(m, samples, index, opts);
  });
  return { modules, summary: summarizeClassifications(modules), commonalityIndexBundleCount: index.bundleCount };
}
