// src/deps/report.ts — assembles the D17a §5 report (human table + `--json`)
// from the match/guess/confirm stages, and the `package.json` a decompile
// project gets when at least one dependency is confirmed with confidence.

import type { ConfidenceTier, MatchReport } from "./match.ts";
import type { Evidence, ModuleGuess } from "./guess.ts";
import { isHintEligibleEvidence } from "./guess.ts";
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

/** A guess the precision rules (`GUESS_RULES` below) kept out of
 *  `guessedDeps`; listed so `--json` consumers can see what was weighed. */
export interface SuppressedGuess {
  readonly package: string;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly reason: "single-evidence-kind" | "below-confidence-floor" | "npm-search-only" | "db-match-negative";
}

/** A single-evidence-kind lead that survives only because its one clue is
 *  high-specificity (docs/DECISIONS.md D17a, extended 2026-08-30 —
 *  `isHintEligibleEvidence` in `src/deps/guess.ts`): a curated native-module
 *  name, a curated API-host constant, or a package-name string literal that
 *  itself carries a version. This is the tier that keeps a lead like
 *  `NativeModules.RNFBAnalytics` -> `@react-native-firebase/analytics`
 *  visible even when it's the *only* signal a module has — `guessedDeps`
 *  correctly requires >=2 independent kinds to reject collision-prone
 *  evidence, but that also drops every native-module-only lead, which is
 *  most of what's left once library versions have drifted from the
 *  signature DB (docs/DEPS.md's Discord/Shopify measurement). Never written
 *  into `package.json`, never counted in `attribution.percentAttributed` —
 *  reported for a human to look at, same spirit as `suppressedGuesses` but
 *  for evidence specific enough to be worth surfacing on its own. */
export interface HintedDep {
  readonly package: string;
  readonly version: string | null;
  readonly confidence: number;
  readonly evidenceKind: Evidence["kind"];
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
  readonly hintedDeps: readonly HintedDep[];
  readonly suppressedGuesses: readonly SuppressedGuess[];
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
/** Minimum aggregated confidence for a guessed dependency to be reported. */
export const GUESS_CONFIDENCE_FLOOR = 0.5;

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
  //
  // Precision rules (docs/reviews/deps-v1.md — the first version reported
  // six packages the rn-template fixture does not contain, all from a
  // single weak evidence kind):
  //   1. a low-tier DB score (fuzzy-only hits: bare mnemonic sequences of
  //      tiny functions collide across every package) is not evidence;
  //      a medium-tier one counts only when it has at least one exact hit;
  //   2. anything reported needs >= 2 independent evidence *kinds*;
  //   3. a confidence floor of GUESS_CONFIDENCE_FLOOR;
  //   4. npm-search hits never stand alone (rule 2 implies it, but the
  //      reason is named separately so the reader sees why);
  //   5. never report a package the DB explicitly scored negative — a
  //      signature for it at this HBC version exists and got no exact
  //      function or module hit at all;
  //   6. exactly one evidence kind is not automatically dropped: when that
  //      one kind is high-specificity (`isHintEligibleEvidence`), the
  //      package is reported as a `hint` instead of suppressed (2026-08-30,
  //      overseer decision after this same review — see `HintedDep` above).
  const dbNegative = new Set<string>();
  for (const p of matchReport.packages) {
    if (p.isBaseline) continue;
    if (p.exactHits === 0 && p.moduleExactHits === 0) dbNegative.add(p.package);
  }
  for (const p of matchReport.packages) {
    if (!p.isBaseline && (p.exactHits > 0 || p.moduleExactHits > 0)) dbNegative.delete(p.package);
  }
  type Agg = { version: string | null; confidence: number; modules: number; evidence: Set<string>; kinds: Set<string> };
  const guessedByPackage = new Map<string, Agg>();
  const addGuess = (pkg: string, version: string | null, confidence: number, modules: number, kind: string, evidence: string): void => {
    if (confirmedPackageNames.has(pkg)) return;
    const existing = guessedByPackage.get(pkg);
    if (existing === undefined) {
      guessedByPackage.set(pkg, { version, confidence, modules, evidence: new Set([evidence]), kinds: new Set([kind]) });
      return;
    }
    existing.version = existing.version ?? version;
    existing.confidence = Math.max(existing.confidence, confidence);
    existing.modules += modules;
    existing.evidence.add(evidence);
    existing.kinds.add(kind);
  };
  for (const p of matchReport.packages) {
    if (p.tier !== "medium" || p.exactHits === 0) continue;
    const pkg = p.isBaseline ? BASELINE_ALIAS.get(p.package) : p.package;
    if (pkg === null || pkg === undefined) continue; // metro-toolchain-empty, or an unrecognised baseline name
    addGuess(pkg, p.version, 0.6, p.moduleExactHits, "db-match", `db-match: exact ${(p.exactCoverage * 100).toFixed(1)}%, fuzzy ${(p.fuzzyCoverage * 100).toFixed(1)}%`);
  }
  const bestGuessByModule = new Map<number, string>();
  for (const g of guesses) {
    const best = g.candidates[0];
    if (best === undefined) continue;
    bestGuessByModule.set(g.factoryFunctionIndex, best.package);
    for (const e of best.evidence) addGuess(best.package, best.version, best.confidence, 1, e.kind, `${e.kind}: ${e.detail}`);
  }
  const guessedDeps: GuessedDep[] = [];
  const hintedDeps: HintedDep[] = [];
  const suppressedGuesses: SuppressedGuess[] = [];
  for (const [pkg, v] of guessedByPackage) {
    const row = { package: pkg, version: v.version, confidence: v.confidence, modules: v.modules, evidence: [...v.evidence] };
    const nonSearchKinds = [...v.kinds].filter((k) => k !== "npm-search");
    let reason: SuppressedGuess["reason"] | null = null;
    if (dbNegative.has(pkg)) reason = "db-match-negative";
    else if (nonSearchKinds.length === 0) reason = "npm-search-only";
    else if (v.kinds.size < 2) {
      const [soleKind] = nonSearchKinds;
      if (soleKind !== undefined && isHintEligibleEvidence(soleKind, v.version)) {
        hintedDeps.push({ package: pkg, version: v.version, confidence: v.confidence, evidenceKind: soleKind as Evidence["kind"], evidence: row.evidence });
        continue;
      }
      reason = "single-evidence-kind";
    } else if (v.confidence < GUESS_CONFIDENCE_FLOOR) reason = "below-confidence-floor";
    if (reason === null) guessedDeps.push(row);
    else suppressedGuesses.push({ package: pkg, confidence: v.confidence, evidence: row.evidence, reason });
  }
  guessedDeps.sort((a, b) => b.confidence - a.confidence);
  hintedDeps.sort((a, b) => b.confidence - a.confidence);
  suppressedGuesses.sort((a, b) => b.confidence - a.confidence);
  const reportedGuessNames = new Set(guessedDeps.map((d) => d.package));
  const hintedNames = new Set(hintedDeps.map((d) => d.package));

  // A module only counts as "guessed" when its best candidate survived the
  // precision rules — otherwise it is still unattributed. A `hint` never
  // counts as attributed either (HintedDep's own contract) — it's simply
  // dropped from the printed unattributed list so it isn't shown twice (once
  // with its evidence under `== hints ==`, once bare under `== unattributed
  // modules ==`); `attribution.unattributedModules` below is unaffected,
  // since it's derived from counts, not from this filtered display list.
  const guessedModuleIds = new Set([...bestGuessByModule].filter(([, pkg]) => reportedGuessNames.has(pkg)).map(([idx]) => idx));
  const hintedModuleIds = new Set([...bestGuessByModule].filter(([, pkg]) => hintedNames.has(pkg)).map(([idx]) => idx));
  const unattributedModules: UnattributedModule[] = matchReport.unattributedModules
    .filter((m) => !guessedModuleIds.has(m.factoryFunctionIndex) && !hintedModuleIds.has(m.factoryFunctionIndex))
    .map((m) => ({ localModuleId: m.localModuleId, factoryFunctionIndex: m.factoryFunctionIndex, instrCount: m.instrCount, topStrings: m.stringConstants.slice(0, 8) }));

  const matchedModules = matchReport.totalModules - matchReport.unattributedModules.length;
  const guessedModulesCount = guessedModuleIds.size;
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
    hintedDeps,
    suppressedGuesses,
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
  if (report.suppressedGuesses.length > 0) lines.push(`  (${report.suppressedGuesses.length} weak guess${report.suppressedGuesses.length === 1 ? "" : "es"} suppressed — single evidence kind, below the ${GUESS_CONFIDENCE_FLOOR} floor, npm-search only, or DB-negative; --json lists them)`);
  lines.push("");
  lines.push(`== hints (${report.hintedDeps.length}, single high-specificity evidence — not in package.json, not counted in attribution) ==`);
  if (report.hintedDeps.length === 0) lines.push("  (none)");
  for (const d of report.hintedDeps) {
    lines.push(`  ${d.package}${d.version !== null ? `@${d.version}` : ""}  confidence=${d.confidence.toFixed(2)}  [${d.evidenceKind}: ${d.evidence.join("; ")}]`);
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
