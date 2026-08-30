// src/deps/match.ts — the D17a "match" stage: score every layered signature
// DB entry against a target bundle's module inventory, with confidence
// tiers, and attribute each `__d()` module to its best-owning package.
// Promoted + adapted from `tools/pkgsig/match.mjs` v2
// (docs/PACKAGE-SIGNATURES.md §5.4).

import type { LoadedSig } from "./db.ts";
import type { ModuleInventory } from "./inventory.ts";
import type { SigDbFile } from "./sigdb-types.ts";

export type ConfidenceTier = "high" | "medium" | "low" | "none";

export interface PackageScore {
  readonly package: string;
  readonly version: string;
  readonly hbcVersion: number;
  readonly layer: LoadedSig["layer"];
  readonly isBaseline: boolean;
  readonly eligibleFunctions: number;
  readonly exactHits: number;
  readonly fuzzyOnlyHits: number;
  readonly stringCorroborated: number;
  readonly exactCoverage: number;
  readonly fuzzyCoverage: number;
  readonly moduleExactHits: number;
  readonly moduleTotal: number;
  readonly tier: ConfidenceTier;
}

export interface ModuleAttribution {
  readonly localModuleId: number | null;
  readonly factoryFunctionIndex: number;
  readonly depCount: number | null;
  readonly nestedFunctionCount: number;
  readonly instrCount: number;
  readonly stringConstants: readonly string[];
  readonly owners: readonly string[];
  /** How the owner was established: an exact factory-hash hit, or a fuzzy
   *  (mnemonic-only) factory hit corroborated by an identical string set
   *  — the latter is what survives `hermesc -g`'s different register
   *  allocation (docs/reviews/deps-v1.md). */
  readonly ownerBasis: "exact" | "fuzzy+strings" | null;
}

export interface MatchReport {
  readonly hbcVersion: number;
  readonly totalFunctions: number;
  readonly totalModules: number;
  readonly packagesChecked: number;
  readonly packages: readonly PackageScore[];
  readonly moduleAttributions: readonly ModuleAttribution[];
  readonly unattributedModules: readonly ModuleAttribution[];
}

const BASELINE_NAME = /^(metro-toolchain-empty|react-foundation|react-native-foundation)$/;

// Confidence-tier thresholds (docs/DEPS.md "Confidence tiers" table has the
// prose rationale keyed to these same names; docs/PACKAGE-SIGNATURES.md
// §6.6 is the measured false-positive this tightening fixes).
//
// `js-md5`/`@emotion/react` cleared the old "high" tier
// (`moduleExactHits >= 1 && moduleCoverage >= 0.05`) off a *single*
// coincidentally-matching module each: js-md5 (2 total modules) hit 1/2 =
// 50% coverage, @emotion/react (16-17 total modules) hit 1/16 ≈ 6% — both
// comfortably over the flat 5% floor despite being one lone hash collision.
// The fix has two independent legs, either of which alone would have
// stopped these two real cases, kept together for defense in depth:
//
//  1. The coverage-percentage path now needs *at least two* independent
//     module hits, never one — a single hit is FLIRT's classic
//     single-collision risk (§1.2/§3.4) regardless of what percentage that
//     one hit happens to represent of a small package's module count. It
//     also now requires a minimum fraction of the package's own *functions*
//     (not just modules) to have matched, so two module-level coincidences
//     in an otherwise-unmatched, function-rich package still don't clear it.
//  2. Genuinely tiny packages (few enough total modules that "two hits" may
//     not even be reachable) get a size-appropriate alternate path instead:
//     several sizeable functions exact-matching, not one. A tiny package
//     that matches most/all of its modules can still reach "high" via
//     STRONG_MODULE_HIT_COUNT or HIGH_EXACT_FUNCTION_COVERAGE below; this
//     leg exists only to give real-but-tiny packages a route to "high" that
//     doesn't require reaching that near-total bar.
const STRONG_MODULE_HIT_COUNT = 3;
const MIN_MODULE_HITS_FOR_COVERAGE_PATH = 2;
const MIN_MODULE_COVERAGE = 0.05;
const MIN_EXACT_FUNCTION_COVERAGE_FOR_COVERAGE_PATH = 0.1;
/** Below this many total (non-baseline, hashed) modules, the coverage-percentage
 *  path is disabled outright — matching 1 or 2 out of only 1 or 2 modules is
 *  not statistically distinguishable from a single coincidental hash collision. */
const TINY_PACKAGE_MODULE_TOTAL = 3;
const HIGH_EXACT_FUNCTION_COVERAGE = 0.9;
/** Tiny-package fallback: several exact-matched functions with real bulk
 *  (instruction-count) mass, never one — "never a single tiny function"
 *  (docs/PACKAGE-SIGNATURES.md §6.6). */
const MIN_TINY_PACKAGE_EXACT_FUNCTION_HITS = 5;
const MIN_TINY_PACKAGE_EXACT_FUNCTION_INSTR = 150;

function tierRank(t: ConfidenceTier): number {
  return { high: 3, medium: 2, low: 1, none: 0 }[t];
}

function buildIndex<K extends "exactHash" | "fuzzyHash" | "stringSetHash">(functions: ModuleInventory["functions"], key: K): Set<string> {
  const s = new Set<string>();
  for (const fn of functions) s.add(fn[key]);
  return s;
}

/** Score one package DB against the target's indices. Returns null if the
 *  package has no hbcVersion-eligible functions to score (e.g. built for a
 *  different HBC version than the target — never silently cross-compared). */
function scorePackage(entry: LoadedSig, target: ModuleInventory, targetExact: Set<string>, targetFuzzy: Set<string>, targetStringHash: Set<string>, minInstr: number): PackageScore | null {
  const pkg: SigDbFile = entry.file;
  if (pkg.hbcVersion !== target.hbcVersion) return null;
  const eligible = pkg.functions.filter((f) => f.instrCount >= minInstr);
  if (eligible.length === 0) return null;

  let exactHits = 0;
  let exactHitInstrSum = 0;
  let fuzzyOnlyHits = 0;
  let stringCorroborated = 0;
  for (const fn of eligible) {
    if (targetExact.has(fn.exactHash)) {
      exactHits++;
      exactHitInstrSum += fn.instrCount;
      continue;
    }
    if (targetFuzzy.has(fn.fuzzyHash)) {
      fuzzyOnlyHits++;
      if (targetStringHash.has(fn.stringSetHash)) stringCorroborated++;
    }
  }

  let moduleExactHits = 0;
  for (const m of pkg.modules) {
    if (m.factoryIsBaseline) continue;
    if (m.factoryExactHash !== null && targetExact.has(m.factoryExactHash)) moduleExactHits++;
  }
  const moduleTotal = pkg.modules.filter((m) => !m.factoryIsBaseline && m.factoryExactHash !== null).length;

  const exactCoverage = exactHits / eligible.length;
  const fuzzyCoverage = (exactHits + fuzzyOnlyHits) / eligible.length;

  // A single coincidentally-matching module is not "high" confidence for the
  // whole package — the FLIRT-style single-hash-collision risk
  // (docs/PACKAGE-SIGNATURES.md §1.2/§3.4/§5.4/§6.6). Require either several
  // independent module hits, or (for packages too small to ever reach that)
  // several sizeable exact-matched functions — never one coincidental hit of
  // either kind, regardless of what percentage it happens to represent of a
  // small package's own module count.
  const moduleCoverage = moduleTotal === 0 ? 0 : moduleExactHits / moduleTotal;
  const isTinyPackage = moduleTotal < TINY_PACKAGE_MODULE_TOTAL;
  const strongModuleSignal =
    moduleExactHits >= STRONG_MODULE_HIT_COUNT ||
    (!isTinyPackage &&
      moduleExactHits >= MIN_MODULE_HITS_FOR_COVERAGE_PATH &&
      moduleCoverage >= MIN_MODULE_COVERAGE &&
      exactCoverage >= MIN_EXACT_FUNCTION_COVERAGE_FOR_COVERAGE_PATH);
  const strongFunctionSignal =
    exactCoverage >= HIGH_EXACT_FUNCTION_COVERAGE ||
    (isTinyPackage && exactHits >= MIN_TINY_PACKAGE_EXACT_FUNCTION_HITS && exactHitInstrSum >= MIN_TINY_PACKAGE_EXACT_FUNCTION_INSTR);

  let tier: ConfidenceTier;
  if (strongModuleSignal || strongFunctionSignal) tier = "high";
  else if (fuzzyCoverage >= 0.5 || moduleExactHits >= 1) tier = "medium";
  else if (exactHits + fuzzyOnlyHits > 0) tier = "low";
  else tier = "none";

  return {
    package: pkg.package,
    version: pkg.version,
    hbcVersion: pkg.hbcVersion,
    layer: entry.layer,
    isBaseline: pkg.toolchainBaseline,
    eligibleFunctions: eligible.length,
    exactHits,
    fuzzyOnlyHits,
    stringCorroborated,
    exactCoverage,
    fuzzyCoverage,
    moduleExactHits,
    moduleTotal,
    tier,
  };
}

export interface MatchOptions {
  /** FLIRT-style minimum-instruction floor before a hash is trusted at all. */
  readonly minInstr?: number;
}

export function matchInventory(inventory: ModuleInventory, dbs: readonly LoadedSig[], opts: MatchOptions = {}): MatchReport {
  const minInstr = opts.minInstr ?? 8;
  const targetExact = buildIndex(inventory.functions, "exactHash");
  const targetFuzzy = buildIndex(inventory.functions, "fuzzyHash");
  const targetStringHash = buildIndex(inventory.functions, "stringSetHash");

  const eligibleDbs = dbs.filter((d) => d.file.hbcVersion === inventory.hbcVersion);

  // Reverse index for per-module attribution: which package(s)' own function
  // set contains a given exact hash. A module can still be named even if its
  // package's overall coverage is low.
  const hashOwners = new Map<string, string[]>();
  // Fallback index for module factories whose exact hash differs only by
  // register allocation (release vs `-g` builds of the same source): the
  // factory's mnemonic-only fuzzy hash *and* its full string set must both
  // match, and the factory must be big enough (instruction and string
  // count) that the pair is not a trivial-module collision — a bare
  // `module.exports = require(dep#)` re-export has no strings and the same
  // mnemonics in every package. Keys claimed by more than one distinct
  // non-baseline package are ambiguous and never attribute.
  const fallbackEligible = (instrCount: number, stringCount: number): boolean => instrCount >= minInstr && (stringCount >= 1 || instrCount >= 16);
  const fuzzyStringOwners = new Map<string, string[]>();
  const packages: PackageScore[] = [];
  for (const entry of eligibleDbs) {
    const score = scorePackage(entry, inventory, targetExact, targetFuzzy, targetStringHash, minInstr);
    if (score !== null) packages.push(score);
    const owner = `${entry.file.package}@${entry.file.version}`;
    const fnByIndex = new Map(entry.file.functions.map((f) => [f.index, f]));
    for (const fn of entry.file.functions) {
      let owners = hashOwners.get(fn.exactHash);
      if (owners === undefined) {
        owners = [];
        hashOwners.set(fn.exactHash, owners);
      }
      owners.push(owner);
    }
    for (const m of entry.file.modules) {
      if (m.factoryIsBaseline || m.factoryFuzzyHash === null) continue;
      const factory = fnByIndex.get(m.factoryFunctionIndex);
      if (factory === undefined || !fallbackEligible(factory.instrCount, factory.stringCount)) continue;
      const key = `${m.factoryFuzzyHash}|${factory.stringSetHash}`;
      let owners = fuzzyStringOwners.get(key);
      if (owners === undefined) {
        owners = [];
        fuzzyStringOwners.set(key, owners);
      }
      if (!owners.includes(owner)) owners.push(owner);
    }
  }
  packages.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.exactCoverage - a.exactCoverage);

  const moduleAttributions: ModuleAttribution[] = inventory.modules.map((m) => {
    let owners = m.exactHash !== null ? (hashOwners.get(m.exactHash) ?? []) : [];
    let ownerBasis: ModuleAttribution["ownerBasis"] = owners.length > 0 ? "exact" : null;
    if (owners.length === 0 && m.fuzzyHash !== null && m.factoryStringSetHash !== null) {
      const factoryInstr = inventory.functions[m.factoryFunctionIndex]?.instrCount ?? 0;
      if (fallbackEligible(factoryInstr, m.factoryStringCount)) {
        const candidates = fuzzyStringOwners.get(`${m.fuzzyHash}|${m.factoryStringSetHash}`) ?? [];
        const distinctPackages = new Set(candidates.map((o) => o.slice(0, o.lastIndexOf("@"))).filter((p) => !BASELINE_NAME.test(p)));
        if (candidates.length > 0 && distinctPackages.size <= 1) {
          owners = candidates;
          ownerBasis = "fuzzy+strings";
        }
      }
    }
    return {
      localModuleId: m.localModuleId,
      factoryFunctionIndex: m.factoryFunctionIndex,
      depCount: m.depCount,
      nestedFunctionCount: m.nestedFunctionIndices.length,
      instrCount: m.instrCount,
      stringConstants: m.stringConstants,
      owners,
      ownerBasis,
    };
  });
  const unattributedModules = moduleAttributions.filter((m) => m.owners.length === 0).sort((a, b) => b.instrCount - a.instrCount);

  return {
    hbcVersion: inventory.hbcVersion,
    totalFunctions: inventory.totalFunctions,
    totalModules: inventory.modules.length,
    packagesChecked: dbs.length,
    packages,
    moduleAttributions,
    unattributedModules,
  };
}
