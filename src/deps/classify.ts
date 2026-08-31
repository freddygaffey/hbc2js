// src/deps/classify.ts — D17i stage 2 / D17h / D17j: classify each Metro
// module as third-party LIBRARY (ignorable) vs the app's OWN "custom" code,
// without naming the package. Naming (D17a/D17f/D17g, `match.ts`/`guess.ts`)
// is the hard, slow-to-improve problem; classification is the easier one
// and delivers the headline goal on its own ("show me only the app's
// code") — and, per D17j, delivers it on a BRAND-NEW app with NO
// cross-app corpus at all, since the primary signals below work from
// evidence inside the single bundle.
//
// Signals, in priority order:
//   0. Cross-app recurrence (D17h, kept as a BONUS on top of D17j's
//      corpus-free signals below, not required for them to work) — measured
//      per FUNCTION, not per whole module: each function's normalised
//      exact-bytecode hash (`sig-normalise.ts`'s
//      `normaliseFunctionForSignature`, masking the Metro dependency-map
//      index, same hash `match.ts`'s signature DB already uses) is looked
//      up in a commonality index of hash -> distinct-bundle-count.
//      Whole-MODULE hashing was tried first and measured far too strict: a
//      library module's factory + every nested closure must be
//      byte-identical across builds for the module hash to recur at all,
//      which real apps rarely share. Per-function hashing finds the same
//      shared library CODE even when the module wrapping it differs build
//      to build. A module is classified library when the majority of its
//      own instruction weight comes from functions whose hash recurs in >=
//      N distinct bundles (small/trivial functions below `minInstr` are
//      excluded — same FLIRT-style floor `match.ts` uses). Needs a
//      multi-bundle commonality index to ever fire; on a single brand-new
//      app with an empty/absent index this signal is simply silent and the
//      D17j signals below carry the whole result.
//   1. **node_modules path evidence (D17j, primary, strong).** A
//      `node_modules/<pkg>/...` substring, or a bare (prefix-stripped)
//      `<pkg>/lib|dist|src|.../*.js` package-relative path, in the module's
//      own string constants — package name extracted when present
//      (`libraryPathEvidence`). In practice this signal is silent on a
//      release/production bundle (Metro strips `node_modules/`-shaped
//      require paths from optimised output) and fires mainly on `-g`/debug
//      builds and source-mapped bundles — see the measured numbers in
//      docs/DEPS.md.
//   2. **App-vocabulary presence (D17j, primary, the key idea).** The
//      app's OWN vocabulary — its bundle id / reverse-DNS or scoped package
//      name, distinctive PascalCase Screen/Navigator/Component-shaped
//      identifiers, route paths, its own API hostnames, and other
//      string tokens that recur across several of ITS OWN modules but are
//      not generic JS/library boilerplate — is derived straight from the
//      bundle itself (`deriveAppVocabulary`, no cross-app corpus needed). A
//      module whose strings reference that vocabulary is classified
//      CUSTOM. This is what makes classification work out of the box on a
//      brand-new app the tool has never seen, and it is the signal that
//      carries almost the entire result on a release bundle where signal 1
//      is silent.
//   3. **Structural shape (D17j, weakest, last-checked).** Many small
//      functions, no strings, none of them app-specific/app-vocabulary —
//      library-leaning, but only once app-vocabulary has already been ruled
//      out for this module (a module with real app-domain strings never
//      falls through to this signal).
//
// Combination rule (D17j): a module is LIBRARY if node_modules-evidence
// OR (no app-vocab AND generic structural shape); CUSTOM if app-vocab is
// present; else UNKNOWN — doubt is reported honestly as "unknown" rather
// than defaulted either way, now that a real positive signal (app
// vocabulary) is available to decide CUSTOM instead of relying on absence
// of evidence.

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

// `node_modules/<pkg>/...` — captures the (possibly scoped) package name so
// callers get more than a boolean out of this, the strongest single signal.
const NODE_MODULES_PATH_RE = /\bnode_modules\/(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)/i;

// A bundler that stripped the `node_modules/` segment but left a bare
// `<pkg>/lib|dist|src|build|es|cjs|umd/....js` package-relative path —
// gated on a real subpath under a common library-output directory name AND
// a JS/JSON extension so an app's own route-ish path string
// (`"settings/profile"`) can't false-positive.
const BARE_PACKAGE_PATH_RE = /^(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*|[a-z0-9][\w.-]*)\/(?:lib|dist|src|build|es|cjs|umd)\/[\w./-]*\.(?:js|json)$/i;

/** `node_modules/...` path evidence (D17j #1, strong/primary): returns the
 *  extracted package name when a module's string constants contain a
 *  `node_modules/<pkg>/...` path or a bare package-relative path shaped
 *  like a library's own output tree; `null` if neither is present. */
export function libraryPathEvidence(m: InventoryModule): string | null {
  for (const s of m.stringConstants) {
    const nm = NODE_MODULES_PATH_RE.exec(s);
    if (nm) return nm[1]!;
  }
  for (const s of m.stringConstants) {
    const bare = BARE_PACKAGE_PATH_RE.exec(s);
    if (bare) return bare[1]!;
  }
  return null;
}

// A bare or scoped npm package name immediately followed by a semver-ish
// version — the shape a library's own "X vN.N.N" banner/warning-prefix
// string takes (distinct from `guess.ts`'s curated evidence tables, which
// this file deliberately does not import — classification stays
// self-contained per this task's ownership split).
const PACKAGE_NAME_VERSION_RE = /^(@[a-z0-9][\w.-]*\/)?([a-z0-9][\w.-]*)[@ ]v?\d+\.\d+\.\d+/i;

function packageNameVersionMatch(m: InventoryModule): string | null {
  for (const s of m.stringConstants) {
    const match = PACKAGE_NAME_VERSION_RE.exec(s);
    if (match) return (match[1] ?? "") + match[2]!;
  }
  return null;
}

// Coarse "this string looks app-specific" filter — an asset path, a
// route/screen-ish identifier, or a reverse-DNS/URL naming this app's own
// backend all say "this module knows something about one particular app",
// which library glue does not. Used both to veto the structural-shape
// signal below and (D17j) as one input into app-vocabulary derivation.
const APP_SPECIFIC_STRING_RE = /\.(png|jpe?g|gif|svg|webp|ttf|otf|woff2?)$/i;
const SCREEN_OR_ROUTE_RE = /(Screen|Route|Navigator)$/;
const REVERSE_DNS_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*){2,}$/i; // e.g. com.example.myapp
const HOSTNAME_IN_URL_RE = /^https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/i;

function looksAppSpecific(s: string): boolean {
  return APP_SPECIFIC_STRING_RE.test(s) || SCREEN_OR_ROUTE_RE.test(s) || REVERSE_DNS_RE.test(s);
}

/** Structural-shape fallback (D17j #3): several smallish functions,
 *  reached only once app-vocabulary has already been ruled out for the
 *  module by the caller (the combination rule's "no app-vocab AND generic
 *  shape") — every one of the module's own strings has therefore already
 *  been confirmed NOT independently app-specific-looking
 *  (`isDistinctiveByShape`, which subsumes `looksAppSpecific`) and NOT a
 *  member of the bundle-derived vocabulary, so this signal doesn't need to
 *  re-check string content at all, only shape. Deliberately the
 *  lowest-confidence, last-checked signal. An earlier version additionally
 *  capped the module's raw string COUNT (<= 2) on the theory that library
 *  modules have few strings — measured false on real bundles (median 16
 *  string constants per module even in pure react-native runtime code, RN
 *  itself embeds plenty of warning/prop-name strings) and dropped: string
 *  CONTENT (already vetted above) is the signal, not string count. */
const STRUCTURAL_MIN_FUNCTIONS = 2;
const STRUCTURAL_MAX_AVG_INSTR = 75;

function hasStructuralLibraryShape(m: InventoryModule): boolean {
  const fnCount = m.functionIndices.length;
  if (fnCount < STRUCTURAL_MIN_FUNCTIONS) return false;
  const avgInstr = m.instrCount / fnCount;
  return avgInstr <= STRUCTURAL_MAX_AVG_INSTR;
}

// ---------------------------------------------------------------------------
// App vocabulary (D17j #2, the primary/key signal): derived from the
// bundle itself, no cross-app corpus required.
// ---------------------------------------------------------------------------

/** The app's own derived vocabulary — a set of string tokens (bundle id,
 *  hostnames, screen/route/component names, other cross-module app-specific
 *  strings) that, when found in a module's own string constants, mark that
 *  module CUSTOM. Opaque outside this file; build via `deriveAppVocabulary`. */
export type AppVocabulary = ReadonlySet<string>;
export const EMPTY_APP_VOCABULARY: AppVocabulary = new Set();

export interface AppVocabularyOptions {
  /** A candidate string must appear in the string constants of at least
   *  this many DISTINCT modules to qualify purely on frequency (default 3
   *  — "referenced from more than a couple of places in this app"; strings
   *  independently recognisable as app-specific by shape are included
   *  regardless of this floor, see below). */
  readonly minModuleFrequency?: number;
  /** A candidate present in more than this FRACTION of all modules is
   *  excluded — near-ubiquitous strings are far more likely to be shared
   *  runtime/polyfill glue than something distinctive to this one app
   *  (default 0.15 — deliberately tight: a large bundle has thousands of
   *  modules, and even a moderate absolute recurrence count can still be a
   *  tiny, meaningless fraction of them; the false-positive risk runs the
   *  other way here — too loose and library glue gets mislabelled custom,
   *  see docs/DEPS.md). */
  readonly maxModuleFraction?: number;
  /** Cap on how many frequency-derived tokens are kept (default 300) — a
   *  sanity bound, not expected to bind on most real bundles once the
   *  frequency window above is tight. */
  readonly maxVocabularySize?: number;
}

const DEFAULT_VOCAB_MIN_MODULE_FREQUENCY = 3;
const DEFAULT_VOCAB_MAX_MODULE_FRACTION = 0.15;
const DEFAULT_VOCAB_MAX_SIZE = 300;

// "This looks like generic JS/library boilerplate, not something this app's
// own developers wrote" — excludes candidates from the derived vocabulary.
// Deliberately over-inclusive: a string that slips past this filter and
// lands in the vocabulary by mistake only makes the CUSTOM signal a little
// less precise (false-positive risk discussed in docs/DEPS.md), it never
// hides real app code (the combination rule only ever uses vocabulary
// presence to say CUSTOM, never to say LIBRARY).
const GENERIC_BOILERPLATE_RE =
  /^(?:true|false|null|undefined|NaN|Infinity|function|object|string|number|boolean|symbol|bigint|constructor|prototype|toString|valueOf|hasOwnProperty|isPrototypeOf|propertyIsEnumerable|length|arguments|callee|caller|this|super|default|require|module|exports|__esModule|main|index)$/i;
const GENERIC_MESSAGE_RE =
  /^(?:Invariant Violation|Warning:|Minified React error|[A-Z][a-zA-Z]*Error:|is not a function|is not defined|Cannot read propert(?:y|ies) of (?:null|undefined)|\[object [A-Za-z]*\]|Symbol\(.*\)|use strict)/;
const NODE_MODULES_OR_PATHLIKE_RE = /node_modules\/|^\.{1,2}\//;
// A single bare identifier-shaped token starting lowercase or `_`
// (`render`, `forwardRef`, `componentWillUnmount`, `__detach`) — the shape
// of a property/method/API name, not app-specific vocabulary: these recur
// across nearly every module in ANY bundle (every module touches `Array`,
// calls `.bind`/`.forEach`, references React lifecycle names, ...) purely
// because they're common JS/React/Hermes surface, not because they say
// anything about this one app. Measured directly on rn-template-0.72 (a
// real bundle): before this exclusion the frequency-derived vocabulary was
// dominated by exactly this shape (`render`, `assign`, `forwardRef`,
// `isArray`, `displayName`, `componentWillUnmount`, `getEnforcing`, ...),
// see docs/DEPS.md. Multi-word UI copy (contains a space), paths (contains
// `/`), and PascalCase names remain eligible — those are the shapes real
// app vocabulary (route names, screen components, API paths) actually
// takes.
const BARE_IDENTIFIER_STARTING_LOWER_RE = /^[a-z_][a-zA-Z0-9_]*$/;
// Well-known JS/React/React-Native globals and lifecycle/API names that
// happen to be PascalCase (so the bare-lowercase check above doesn't catch
// them) but are equally generic — present in essentially every bundle
// regardless of app.
const KNOWN_JS_RN_GLOBAL_RE =
  /^(?:Array|Object|Error|TypeError|RangeError|SyntaxError|ReferenceError|EvalError|URIError|AggregateError|Math|JSON|Promise|Symbol|Map|Set|WeakMap|WeakSet|Proxy|Reflect|Function|RegExp|Date|Number|String|Boolean|ArrayBuffer|DataView|Int8Array|Uint8Array|Uint8ClampedArray|Int16Array|Uint16Array|Int32Array|Uint32Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array|BigInt|HermesInternal|Component|PureComponent|Fragment|StrictMode|Suspense|Children|Commands)$/;

function isGenericBoilerplate(s: string): boolean {
  if (s.length < 4) return true;
  if (GENERIC_BOILERPLATE_RE.test(s)) return true;
  if (GENERIC_MESSAGE_RE.test(s)) return true;
  if (NODE_MODULES_OR_PATHLIKE_RE.test(s)) return true;
  if (BARE_IDENTIFIER_STARTING_LOWER_RE.test(s)) return true;
  if (KNOWN_JS_RN_GLOBAL_RE.test(s)) return true;
  if (!/[a-zA-Z]/.test(s)) return true; // pure punctuation/numeric
  return false;
}

/** True when a string is independently recognisable as app-specific by
 *  shape alone — included in the vocabulary regardless of frequency. */
function isDistinctiveByShape(s: string): boolean {
  if (looksAppSpecific(s)) return true;
  if (HOSTNAME_IN_URL_RE.test(s)) return true;
  return false;
}

function hostnameOf(s: string): string | null {
  const m = HOSTNAME_IN_URL_RE.exec(s);
  return m ? m[1]! : null;
}

/** Derives the app's own vocabulary from its bundle (D17j #2) — no
 *  cross-app corpus, works on a brand-new app the first time it's seen.
 *  Two contributions: (a) any string independently recognisable as
 *  app-specific by shape (bundle id, `Screen`/`Navigator`-suffixed
 *  identifiers, asset paths, URL hostnames — the hostname itself is added,
 *  not just the full URL string, so a module referencing the same host via
 *  a different concrete URL still matches), regardless of how many modules
 *  it appears in; (b) any other non-boilerplate string that recurs across
 *  several distinct modules (>= `minModuleFrequency`) without being
 *  near-ubiquitous (<= `maxModuleFraction` of all modules) — the shape a
 *  shared route name, UI-copy constant, or the app's own API path prefix
 *  takes. */
export function deriveAppVocabulary(inventory: ModuleInventory, opts: AppVocabularyOptions = {}): AppVocabulary {
  const minFreq = opts.minModuleFrequency ?? DEFAULT_VOCAB_MIN_MODULE_FREQUENCY;
  const maxFraction = opts.maxModuleFraction ?? DEFAULT_VOCAB_MAX_MODULE_FRACTION;
  const maxSize = opts.maxVocabularySize ?? DEFAULT_VOCAB_MAX_SIZE;
  const totalModules = inventory.modules.length;
  const maxCount = Math.max(minFreq, Math.floor(totalModules * maxFraction));

  const vocab = new Set<string>();
  const moduleCounts = new Map<string, number>();

  for (const m of inventory.modules) {
    for (const s of m.stringConstants) {
      if (isDistinctiveByShape(s)) {
        vocab.add(s);
        const host = hostnameOf(s);
        if (host !== null) vocab.add(host);
        continue;
      }
      if (isGenericBoilerplate(s)) continue;
      moduleCounts.set(s, (moduleCounts.get(s) ?? 0) + 1);
    }
  }

  const ranked = [...moduleCounts.entries()]
    .filter(([, count]) => count >= minFreq && count <= maxCount)
    .sort((a, b) => b[1] - a[1]);
  for (const [s] of ranked.slice(0, maxSize)) vocab.add(s);

  return vocab;
}

/** Matching string constants for the app-vocabulary signal — either direct
 *  membership in the derived vocabulary, or (independent of any derived
 *  vocabulary, and useful even with `EMPTY_APP_VOCABULARY`) a string that
 *  is itself recognisable as app-specific by shape within this one module. */
function appVocabularyHits(m: InventoryModule, vocab: AppVocabulary): readonly string[] {
  const hits: string[] = [];
  for (const s of m.stringConstants) {
    if (vocab.has(s) || isDistinctiveByShape(s)) hits.push(s);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ModuleClassKind = "library" | "custom" | "unknown";

/** Signals that can decide a module LIBRARY. `app-vocabulary` is deliberately
 *  excluded — it only ever decides CUSTOM (see `ClassificationSignal`). */
export type LibrarySignal = "cross-app-recurrence" | "node-modules-path" | "package-name-version-string" | "structural-shape";
export type ClassificationSignal = LibrarySignal | "app-vocabulary" | "none";

export interface ModuleClassification {
  readonly localModuleId: number | null;
  readonly factoryFunctionIndex: number;
  readonly instrCount: number;
  readonly classification: ModuleClassKind;
  /** The signal that decided this classification. */
  readonly signal: ClassificationSignal;
  /** How confident this particular signal is, 0..1 (not a probability —
   *  a coarse ranking so a report can be sorted/filtered by trust: strong
   *  string evidence (node_modules path, package-name banner) near 1,
   *  app-vocabulary scaled by how many distinct vocabulary tokens matched,
   *  bare structural shape (the D17j "weakest, last-checked" signal)
   *  low, "none"/unknown 0. */
  readonly confidence: number;
  /** How many distinct bundles in the commonality index this module's
   *  content hash was seen in (0 if the index has never seen it, or if no
   *  index/an empty one was supplied — expected on a brand-new app with no
   *  cross-app corpus, D17j). Populated regardless of which signal
   *  ultimately decided the classification, so a near-miss (recurrence 1
   *  below the threshold) is visible. */
  readonly recurrenceCount: number;
  /** The package name extracted from node_modules-path or package-name-
   *  version-string evidence, when that's the deciding (or even just
   *  present) signal; `null` otherwise. A hint only — D17j classifies
   *  without naming; this is not run through `guess.ts`/`match.ts` naming
   *  logic and carries no confirmation. */
  readonly libraryPackageHint: string | null;
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
  /** Options forwarded to `deriveAppVocabulary` when `classifyInventory`
   *  derives the vocabulary itself (ignored by `classifyModule`, which
   *  always takes a pre-built `AppVocabulary`). */
  readonly appVocabulary?: AppVocabularyOptions;
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

/** Classifies one module. `appVocabulary` defaults to
 *  `EMPTY_APP_VOCABULARY` — the frequency-derived half of the app-vocabulary
 *  signal then contributes nothing, but per-module shape-based app-specific
 *  strings (`isDistinctiveByShape`, e.g. a `FooScreen`/asset-path/hostname
 *  string sitting right in this one module) still do, so the signal is
 *  never fully inert even for a lone module classified in isolation (as
 *  most of this file's own unit tests do). `classifyInventory` below is the
 *  normal caller and always supplies a real, bundle-derived vocabulary. */
export function classifyModule(
  m: InventoryModule,
  functions: readonly ModuleFunctionSample[],
  index: CommonalityIndex,
  appVocabulary: AppVocabulary = EMPTY_APP_VOCABULARY,
  opts: ClassifyOptions = {},
): ModuleClassification {
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
  const base = {
    localModuleId: m.localModuleId,
    factoryFunctionIndex: m.factoryFunctionIndex,
    instrCount: m.instrCount,
    recurrenceCount: maxRecurrenceCount,
  };

  // Signal 0: cross-app recurrence — bonus, corpus-dependent; silent (never
  // fires) on an empty/absent commonality index, which is the normal state
  // for a brand-new app with no corpus (D17j).
  if (fraction >= fractionNeeded && recurringWeight > 0) {
    return { ...base, classification: "library", signal: "cross-app-recurrence", confidence: Math.max(0.6, Math.min(1, fraction)), libraryPackageHint: null };
  }

  // Signal 1 (D17j, primary/strong): node_modules path evidence.
  const pathPackage = libraryPathEvidence(m);
  if (pathPackage !== null) {
    return { ...base, classification: "library", signal: "node-modules-path", confidence: 0.95, libraryPackageHint: pathPackage };
  }
  const versionedPackage = packageNameVersionMatch(m);
  if (versionedPackage !== null) {
    return { ...base, classification: "library", signal: "package-name-version-string", confidence: 0.85, libraryPackageHint: versionedPackage };
  }

  // Signal 2 (D17j, primary/key idea): app-vocabulary presence -> CUSTOM.
  const vocabHits = appVocabularyHits(m, appVocabulary);
  if (vocabHits.length > 0) {
    const confidence = Math.min(1, 0.55 + 0.15 * Math.min(vocabHits.length, 3));
    return { ...base, classification: "custom", signal: "app-vocabulary", confidence, libraryPackageHint: null };
  }

  // Signal 3 (D17j, weakest, only reached once app-vocabulary was already
  // ruled out for this module): generic structural shape -> LIBRARY-leaning.
  if (hasStructuralLibraryShape(m)) {
    return { ...base, classification: "library", signal: "structural-shape", confidence: 0.35, libraryPackageHint: null };
  }

  // No signal fired either way. Reported honestly as unknown rather than
  // defaulted to custom or library — D17j's app-vocabulary signal gives a
  // real positive way to decide CUSTOM, so "no evidence at all" no longer
  // needs to hide behind an assumed default.
  return { ...base, classification: "unknown", signal: "none", confidence: 0, libraryPackageHint: null };
}

export interface ClassificationSummary {
  readonly totalInstrWeight: number;
  readonly libraryInstrWeight: number;
  readonly customInstrWeight: number;
  readonly unknownInstrWeight: number;
  /** THE headline metric (D17h/D17j): how much of the bundle, by
   *  instruction weight, is anonymous-or-named library code an analyst can
   *  ignore — computed without naming a single package, and (D17j)
   *  without requiring any cross-app corpus. */
  readonly percentLibraryByWeight: number;
  /** The mirror headline (D17j): how much of the bundle, by instruction
   *  weight, is classified as the developer's OWN custom code. */
  readonly percentCustomByWeight: number;
  /** `libraryInstrWeight` broken out by which signal decided it, so it's
   *  visible how much rests on the strong node_modules-path/recurrence
   *  signals vs. the weaker structural-shape fallback. */
  readonly libraryInstrWeightBySignal: Readonly<Record<LibrarySignal, number>>;
  readonly libraryModuleCount: number;
  readonly customModuleCount: number;
  readonly unknownModuleCount: number;
}

export function summarizeClassifications(classifications: readonly ModuleClassification[]): ClassificationSummary {
  let totalInstrWeight = 0;
  let libraryInstrWeight = 0;
  let customInstrWeight = 0;
  let unknownInstrWeight = 0;
  let libraryModuleCount = 0;
  let customModuleCount = 0;
  let unknownModuleCount = 0;
  const bySignal: Record<LibrarySignal, number> = {
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
      if (c.signal !== "none" && c.signal !== "app-vocabulary") bySignal[c.signal] += c.instrCount;
    } else if (c.classification === "custom") {
      customInstrWeight += c.instrCount;
      customModuleCount++;
    } else {
      unknownInstrWeight += c.instrCount;
      unknownModuleCount++;
    }
  }
  return {
    totalInstrWeight,
    libraryInstrWeight,
    customInstrWeight,
    unknownInstrWeight,
    percentLibraryByWeight: totalInstrWeight === 0 ? 0 : (libraryInstrWeight / totalInstrWeight) * 100,
    percentCustomByWeight: totalInstrWeight === 0 ? 0 : (customInstrWeight / totalInstrWeight) * 100,
    libraryInstrWeightBySignal: bySignal,
    libraryModuleCount,
    customModuleCount,
    unknownModuleCount,
  };
}

export interface ClassificationReport {
  readonly modules: readonly ModuleClassification[];
  readonly summary: ClassificationSummary;
  /** How many distinct bundles the commonality index used was built from —
   *  context for how much to trust `cross-app-recurrence` hits (a
   *  bundleCount of 0 or 1 means that bonus signal can never fire at the
   *  default threshold; D17j's primary signals below don't need it). */
  readonly commonalityIndexBundleCount: number;
  /** How many string tokens the app-vocabulary signal derived from this
   *  bundle (D17j) — 0 on a bundle with no recurring/distinctive strings
   *  at all (unusual for a real app), context for how much the CUSTOM
   *  classification below actually rests on. */
  readonly appVocabularySize: number;
}

/** Classifies every module in a bundle's inventory (D17i stage 2 / D17j).
 *  Pure function of the inventory + a pre-loaded/pre-built commonality
 *  index — callers (`src/deps/index.ts`) decide where that index comes from
 *  (`loadCommonalityIndex(DEFAULT_COMMONALITY_INDEX_PATH)`, typically; an
 *  empty/absent index is fine — D17j's primary signals don't need one).
 *  The app vocabulary (D17j) is always derived fresh from this same
 *  inventory (`deriveAppVocabulary`, `opts.appVocabulary` tunes it) — no
 *  cross-app corpus, works the first time on a brand-new app. */
export function classifyInventory(inventory: ModuleInventory, index: CommonalityIndex, opts: ClassifyOptions = {}): ClassificationReport {
  const functionsByIndex = new Map(inventory.functions.map((f) => [f.index, f]));
  const vocabulary = deriveAppVocabulary(inventory, opts.appVocabulary);
  const modules = inventory.modules.map((m) => {
    const samples: ModuleFunctionSample[] = m.functionIndices.map((i) => {
      const f = functionsByIndex.get(i);
      return { exactHash: f?.exactHash ?? null, instrCount: f?.instrCount ?? 0 };
    });
    return classifyModule(m, samples, index, vocabulary, opts);
  });
  return { modules, summary: summarizeClassifications(modules), commonalityIndexBundleCount: index.bundleCount, appVocabularySize: vocabulary.size };
}
