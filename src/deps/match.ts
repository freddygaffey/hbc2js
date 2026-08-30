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
  let fuzzyOnlyHits = 0;
  let stringCorroborated = 0;
  for (const fn of eligible) {
    if (targetExact.has(fn.exactHash)) {
      exactHits++;
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
  // (docs/PACKAGE-SIGNATURES.md §1.2/§3.4/§5.4). Require either several
  // independent module hits or a non-trivial fraction of the package's own
  // module count before calling a whole package "high".
  const moduleCoverage = moduleTotal === 0 ? 0 : moduleExactHits / moduleTotal;
  const strongModuleSignal = moduleExactHits >= 3 || (moduleExactHits >= 1 && moduleCoverage >= 0.05);

  let tier: ConfidenceTier;
  if (strongModuleSignal || exactCoverage >= 0.9) tier = "high";
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
  const packages: PackageScore[] = [];
  for (const entry of eligibleDbs) {
    const score = scorePackage(entry, inventory, targetExact, targetFuzzy, targetStringHash, minInstr);
    if (score !== null) packages.push(score);
    for (const fn of entry.file.functions) {
      let owners = hashOwners.get(fn.exactHash);
      if (owners === undefined) {
        owners = [];
        hashOwners.set(fn.exactHash, owners);
      }
      owners.push(`${entry.file.package}@${entry.file.version}`);
    }
  }
  packages.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.exactCoverage - a.exactCoverage);

  const moduleAttributions: ModuleAttribution[] = inventory.modules.map((m) => {
    const owners = m.exactHash !== null ? (hashOwners.get(m.exactHash) ?? []) : [];
    return {
      localModuleId: m.localModuleId,
      factoryFunctionIndex: m.factoryFunctionIndex,
      depCount: m.depCount,
      nestedFunctionCount: m.nestedFunctionIndices.length,
      instrCount: m.instrCount,
      stringConstants: m.stringConstants,
      owners,
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
