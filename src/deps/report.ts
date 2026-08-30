// src/deps/report.ts — assembles the D17a §5 report (human table + `--json`)
// from the match/guess/confirm stages, and the `package.json` a decompile
// project gets when at least one dependency is confirmed with confidence.

import type { ConfidenceTier, MatchReport } from "./match.ts";
import type { ModuleGuess } from "./guess.ts";
import type { ConfirmResult } from "./confirm.ts";

export interface ConfirmedDep {
  readonly package: string;
  readonly version: string;
  readonly confidence: ConfidenceTier;
  readonly modulesCovered: number;
  readonly moduleTotal: number;
  readonly source: "db-match" | "confirmed";
}

export interface GuessedDep {
  readonly package: string;
  readonly version: string | null;
  readonly confidence: number;
  readonly modules: number;
  readonly evidence: readonly string[];
}

export interface UnattributedModule {
  readonly localModuleId: number | null;
  readonly factoryFunctionIndex: number;
  readonly instrCount: number;
  readonly topStrings: readonly string[];
}

/** One Metro module confidently attributed to a confirmed dependency — the
 *  "module id -> package mapping" the M6 emitter (D19) needs to drop a
 *  recognised module from `<out>/src/` and list it in `package.json`
 *  instead, without re-deriving any of the match/guess logic itself. Only
 *  modules whose owner made it into `confirmedDeps` are listed here —
 *  medium/low/guessed attributions are evidence for a human, not something
 *  M6 should act on automatically. */
export interface ModuleOwnership {
  readonly localModuleId: number | null;
  readonly factoryFunctionIndex: number;
  readonly package: string;
  readonly version: string;
}

export interface DepsReport {
  readonly input: string;
  readonly hbcVersion: number;
  readonly totalFunctions: number;
  readonly totalModules: number;
  readonly reactNativeVersion: string | null;
  readonly confirmedDeps: readonly ConfirmedDep[];
  readonly guessedDeps: readonly GuessedDep[];
  readonly unattributedModules: readonly UnattributedModule[];
  /** Every module owned by a package in `confirmedDeps` — see `ModuleOwnership`. */
  readonly moduleOwnership: readonly ModuleOwnership[];
  readonly attribution: {
    readonly totalModules: number;
    readonly matchedModules: number;
    readonly guessedModules: number;
    readonly unattributedModules: number;
    readonly percentAttributed: number;
  };
}

/** The `react-native`/`react-native-foundation` package's own matched
 *  version is the most reliable RN-version signal available pre-`--confirm`
 *  (D17a: "detect the app's RN version ... since it pins the toolchain"). */
export function detectReactNativeVersion(matchReport: MatchReport): string | null {
  const candidates = matchReport.packages.filter((p) => (p.package === "react-native" || p.package === "react-native-foundation") && (p.tier === "high" || p.tier === "medium"));
  candidates.sort((a, b) => b.exactCoverage - a.exactCoverage);
  return candidates[0]?.version ?? null;
}

// Toolchain/foundation baseline files (docs/PACKAGE-SIGNATURES.md §5.2:
// metro-toolchain-empty, react-foundation, react-native-foundation) exist
// primarily to be *subtracted* from other packages' signatures at DB-build
// time — but `react-foundation`/`react-native-foundation` are still
// fingerprints of the real `react`/`react-native` npm packages (just named
// for their subtraction role), and every RN app genuinely depends on both.
// `metro-toolchain-empty` has no npm-package equivalent at all (it's
// Metro's own injected runtime, never a `require()`-able thing) and is
// dropped entirely. Some HBC versions in the starter DB (§5.5: HBC98) only
// ever got the `-foundation` flavour built, never a separate non-baseline
// `react@<ver>`/`react-native@<ver>` file — so this alias is often the
// *only* way those two show up in the report at all for those versions.
const BASELINE_ALIAS: ReadonlyMap<string, string | null> = new Map([
  ["react-foundation", "react"],
  ["react-native-foundation", "react-native"],
  ["metro-toolchain-empty", null],
]);

export function buildReport(input: string, matchReport: MatchReport, guesses: readonly ModuleGuess[], confirmResults: readonly ConfirmResult[] = []): DepsReport {
  const confirmedDeps: ConfirmedDep[] = [];
  const confirmedNamesFromRealPackages = new Set<string>();
  for (const p of matchReport.packages) {
    if (p.tier === "high" && !p.isBaseline) {
      confirmedDeps.push({ package: p.package, version: p.version, confidence: p.tier, modulesCovered: p.moduleExactHits, moduleTotal: p.moduleTotal, source: "db-match" });
      confirmedNamesFromRealPackages.add(p.package);
    }
  }
  // Baseline entries only fill in react/react-native when no real,
  // non-baseline file already reported them (dedup — some toolchains have
  // both, e.g. HBC94/96's starter set).
  for (const p of matchReport.packages) {
    if (p.tier !== "high" || !p.isBaseline) continue;
    const alias = BASELINE_ALIAS.get(p.package);
    if (alias === null || alias === undefined || confirmedNamesFromRealPackages.has(alias)) continue;
    confirmedDeps.push({ package: alias, version: p.version, confidence: p.tier, modulesCovered: p.moduleExactHits, moduleTotal: p.moduleTotal, source: "db-match" });
    confirmedNamesFromRealPackages.add(alias);
  }
  for (const r of confirmResults) {
    if (r.ok && r.score !== undefined) {
      confirmedDeps.push({ package: r.candidate.package, version: r.candidate.version, confidence: r.score.tier, modulesCovered: r.score.moduleExactHits, moduleTotal: r.score.moduleTotal, source: "confirmed" });
    }
  }
  const confirmedPackageNames = new Set(confirmedDeps.map((d) => d.package));

  // Guessed candidates are aggregated per package name (rather than reported
  // once per guessed module) so the report reads as "these are the
  // dependencies worth investigating", not one row per unresolved function.
  const guessedByPackage = new Map<string, { version: string | null; confidence: number; modules: number; evidence: Set<string> }>();
  const addGuess = (pkg: string, version: string | null, confidence: number, modules: number, evidence: string): void => {
    if (confirmedPackageNames.has(pkg)) return;
    const existing = guessedByPackage.get(pkg);
    if (existing === undefined) {
      guessedByPackage.set(pkg, { version, confidence, modules, evidence: new Set([evidence]) });
      return;
    }
    existing.version = existing.version ?? version;
    existing.confidence = Math.max(existing.confidence, confidence);
    existing.modules += modules;
    existing.evidence.add(evidence);
  };
  for (const p of matchReport.packages) {
    if (p.tier !== "medium" && p.tier !== "low") continue;
    const pkg = p.isBaseline ? BASELINE_ALIAS.get(p.package) : p.package;
    if (pkg === null || pkg === undefined) continue; // metro-toolchain-empty, or an unrecognised baseline name
    addGuess(pkg, p.version, p.tier === "medium" ? 0.6 : 0.3, p.moduleExactHits, `db-match: exact ${(p.exactCoverage * 100).toFixed(1)}%, fuzzy ${(p.fuzzyCoverage * 100).toFixed(1)}%`);
  }
  for (const g of guesses) {
    const best = g.candidates[0];
    if (best === undefined) continue;
    for (const e of best.evidence) addGuess(best.package, best.version, best.confidence, 1, `${e.kind}: ${e.detail}`);
  }
  const guessedDeps: GuessedDep[] = [...guessedByPackage.entries()]
    .map(([pkg, v]) => ({ package: pkg, version: v.version, confidence: v.confidence, modules: v.modules, evidence: [...v.evidence] }))
    .sort((a, b) => b.confidence - a.confidence);

  const guessedModuleIds = new Set(guesses.map((g) => g.factoryFunctionIndex));
  const unattributedModules: UnattributedModule[] = matchReport.unattributedModules
    .filter((m) => !guessedModuleIds.has(m.factoryFunctionIndex))
    .map((m) => ({ localModuleId: m.localModuleId, factoryFunctionIndex: m.factoryFunctionIndex, instrCount: m.instrCount, topStrings: m.stringConstants.slice(0, 8) }));

  const matchedModules = matchReport.totalModules - matchReport.unattributedModules.length;
  const guessedModulesCount = guesses.length;
  const trulyUnattributed = matchReport.unattributedModules.length - guessedModulesCount;
  const percentAttributed = matchReport.totalModules === 0 ? 0 : ((matchedModules + guessedModulesCount) / matchReport.totalModules) * 100;

  const confirmedVersionByPackage = new Map(confirmedDeps.map((d) => [d.package, d.version]));
  const moduleOwnership: ModuleOwnership[] = [];
  for (const m of matchReport.moduleAttributions) {
    const ownerRaw = m.owners[0];
    if (ownerRaw === undefined) continue;
    const rawPkg = ownerRaw.slice(0, ownerRaw.lastIndexOf("@"));
    const pkg = BASELINE_ALIAS.has(rawPkg) ? BASELINE_ALIAS.get(rawPkg) : rawPkg;
    if (pkg === null || pkg === undefined) continue;
    const version = confirmedVersionByPackage.get(pkg);
    if (version === undefined) continue; // only confirmed-tier owners, per this field's contract
    moduleOwnership.push({ localModuleId: m.localModuleId, factoryFunctionIndex: m.factoryFunctionIndex, package: pkg, version });
  }

  return {
    input,
    hbcVersion: matchReport.hbcVersion,
    totalFunctions: matchReport.totalFunctions,
    totalModules: matchReport.totalModules,
    reactNativeVersion: detectReactNativeVersion(matchReport),
    confirmedDeps,
    guessedDeps,
    unattributedModules,
    moduleOwnership,
    attribution: {
      totalModules: matchReport.totalModules,
      matchedModules,
      guessedModules: guessedModulesCount,
      unattributedModules: Math.max(0, trulyUnattributed),
      percentAttributed,
    },
  };
}

/** `<out-dir>/package.json` dependency entries — only written by the CLI
 *  when `report.confirmedDeps` is non-empty ("when confident", D17a §5). */
export function packageJsonDependencies(report: DepsReport): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const d of report.confirmedDeps) deps[d.package] = d.version;
  return deps;
}

export function formatReportText(report: DepsReport): string {
  const lines: string[] = [];
  lines.push(`hbc2js deps: ${report.input}`);
  lines.push(`  hbc version: ${report.hbcVersion}, functions: ${report.totalFunctions}, modules: ${report.totalModules}`);
  if (report.reactNativeVersion !== null) lines.push(`  react-native: ${report.reactNativeVersion} (detected from matched module signatures)`);
  lines.push("");
  lines.push(`== confirmed dependencies (${report.confirmedDeps.length}) ==`);
  if (report.confirmedDeps.length === 0) lines.push("  (none)");
  for (const d of report.confirmedDeps) {
    lines.push(`  ${d.package}@${d.version}  [${d.confidence}${d.source === "confirmed" ? ", npm-confirmed" : ""}]  modules ${d.modulesCovered}/${d.moduleTotal}`);
  }
  lines.push("");
  lines.push(`== guessed / unconfirmed (${report.guessedDeps.length}) ==`);
  if (report.guessedDeps.length === 0) lines.push("  (none)");
  for (const d of report.guessedDeps) {
    lines.push(`  ${d.package}${d.version !== null ? `@${d.version}` : ""}  confidence=${d.confidence.toFixed(2)}  [${d.evidence.join("; ")}]`);
  }
  lines.push("");
  lines.push(`== unattributed modules (${report.unattributedModules.length}, likely this app's own code) ==`);
  for (const m of report.unattributedModules.slice(0, 15)) {
    lines.push(`  module id=${m.localModuleId ?? "?"} fnIdx=${m.factoryFunctionIndex} instrCount=${m.instrCount} strings=[${m.topStrings.slice(0, 3).join(", ")}]`);
  }
  lines.push("");
  lines.push(`summary: ${report.attribution.percentAttributed.toFixed(1)}% of modules attributed (${report.attribution.matchedModules} matched + ${report.attribution.guessedModules} guessed of ${report.attribution.totalModules})`);
  return lines.join("\n");
}
