// docs/reviews/deps-v1.md — the guess stage's precision rules in
// `buildReport`. The first version reported six packages the rn-template
// fixture does not contain (@react-navigation/stack, react-redux, axios,
// ...), every one from a single weak evidence kind: a low/medium DB tier
// earned by fuzzy (mnemonic-only) hits on tiny functions. Synthetic
// MatchReport/guess shapes, no bundle needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, GUESS_CONFIDENCE_FLOOR } from "../../../src/deps/report.ts";
import type { MatchReport, PackageScore } from "../../../src/deps/match.ts";
import type { ModuleGuess, Evidence } from "../../../src/deps/guess.ts";

function score(overrides: Partial<PackageScore>): PackageScore {
  return { package: "x", version: "1.0.0", hbcVersion: 94, layer: "shared", isBaseline: false, eligibleFunctions: 100, exactHits: 0, fuzzyOnlyHits: 0, stringCorroborated: 0, exactCoverage: 0, fuzzyCoverage: 0, moduleExactHits: 0, moduleTotal: 10, tier: "none", ...overrides };
}

function matchReport(packages: PackageScore[]): MatchReport {
  return { hbcVersion: 94, totalFunctions: 1000, totalModules: 10, packagesChecked: packages.length, packages, moduleAttributions: [], unattributedModules: [] };
}

function guess(pkg: string, evidence: Evidence[], idx = 1, version: string | null = null): ModuleGuess {
  const confidence = Math.min(1, evidence.reduce((a, e) => a + e.weight, 0));
  return { factoryFunctionIndex: idx, localModuleId: idx, instrCount: 50, candidates: [{ package: pkg, version, confidence, evidence }] };
}

test("a low-tier DB score (fuzzy-only hits) is not a guess at all", () => {
  const r = buildReport("x", matchReport([score({ package: "axios", fuzzyOnlyHits: 3, fuzzyCoverage: 0.03, tier: "low" })]), []);
  assert.deepEqual(r.guessedDeps, []);
  assert.deepEqual(r.suppressedGuesses, []);
});

test("a medium-tier DB score alone is one evidence kind: suppressed, listed with its reason", () => {
  const r = buildReport("x", matchReport([score({ package: "@react-navigation/stack", exactHits: 1, exactCoverage: 0.001, moduleExactHits: 1, tier: "medium" })]), []);
  assert.deepEqual(r.guessedDeps, []);
  assert.equal(r.suppressedGuesses.length, 1);
  assert.equal(r.suppressedGuesses[0]!.package, "@react-navigation/stack");
  assert.equal(r.suppressedGuesses[0]!.reason, "single-evidence-kind");
});

test("a medium-tier DB score with no exact hit at all is dropped, not even listed", () => {
  const r = buildReport("x", matchReport([score({ package: "zustand", fuzzyOnlyHits: 60, fuzzyCoverage: 0.6, tier: "medium" })]), []);
  assert.deepEqual(r.guessedDeps, []);
  assert.deepEqual(r.suppressedGuesses, []);
});

test("npm-search results never stand alone", () => {
  const r = buildReport("x", matchReport([]), [guess("aliceblue", [{ kind: "npm-search", detail: 'query="add"', weight: 0.15 }])]);
  assert.deepEqual(r.guessedDeps, []);
  assert.equal(r.suppressedGuesses[0]!.reason, "npm-search-only");
  assert.equal(r.attribution.guessedModules, 0, "a module whose only guess was suppressed stays unattributed");
});

test("two independent evidence kinds above the floor are reported", () => {
  const ev: Evidence[] = [
    { kind: "native-module", detail: "RNGestureHandlerModule", weight: 0.75 },
    { kind: "package-name-string", detail: "react-native-gesture-handler", weight: 0.3 },
  ];
  const r = buildReport("x", matchReport([]), [guess("react-native-gesture-handler", ev)]);
  assert.equal(r.guessedDeps.length, 1);
  assert.equal(r.guessedDeps[0]!.package, "react-native-gesture-handler");
  assert.ok(r.guessedDeps[0]!.confidence >= GUESS_CONFIDENCE_FLOOR);
  assert.equal(r.attribution.guessedModules, 1);
});

test("two kinds below the confidence floor are suppressed", () => {
  const ev: Evidence[] = [
    { kind: "apk", detail: "BILLING", weight: 0.2 },
    { kind: "npm-search", detail: 'query="billing"', weight: 0.15 },
  ];
  const r = buildReport("x", matchReport([]), [guess("react-native-iap", ev)]);
  assert.deepEqual(r.guessedDeps, []);
  assert.equal(r.suppressedGuesses[0]!.reason, "below-confidence-floor");
});

test("a package the DB scored explicitly negative is never reported as guessed, whatever the other evidence", () => {
  const ev: Evidence[] = [
    { kind: "native-module", detail: "RNGestureHandlerModule", weight: 0.75 },
    { kind: "package-name-string", detail: "react-native-gesture-handler", weight: 0.3 },
  ];
  const negative = score({ package: "react-native-gesture-handler", fuzzyOnlyHits: 2, fuzzyCoverage: 0.02, tier: "low" });
  const r = buildReport("x", matchReport([negative]), [guess("react-native-gesture-handler", ev)]);
  assert.deepEqual(r.guessedDeps, []);
  assert.equal(r.suppressedGuesses[0]!.reason, "db-match-negative");
  // ...unless some version of it in the DB did get an exact hit.
  const positive = score({ package: "react-native-gesture-handler", version: "2.0.0", exactHits: 4, exactCoverage: 0.04, tier: "low" });
  const r2 = buildReport("x", matchReport([negative, positive]), [guess("react-native-gesture-handler", ev)]);
  assert.equal(r2.guessedDeps.length, 1);
});

test("confirmed packages are never also guessed", () => {
  const ev: Evidence[] = [
    { kind: "native-module", detail: "DevSettings", weight: 0.75 },
    { kind: "package-name-string", detail: "react-native", weight: 0.3 },
  ];
  const r = buildReport("x", matchReport([score({ package: "react-native", exactHits: 900, exactCoverage: 0.9, moduleExactHits: 10, tier: "high" })]), [guess("react-native", ev)]);
  assert.equal(r.confirmedDeps.length, 1);
  assert.deepEqual(r.guessedDeps, []);
});

// `hint` tier (2026-08-30, overseer decision after this same review):
// exactly one evidence kind is no longer an automatic drop when that one
// kind is high-specificity enough to stand alone — the RNFBAnalytics-style
// native-module-only lead this was added for.

test("a lone native-module evidence is a hint, not suppressed", () => {
  const ev: Evidence[] = [{ kind: "native-module", detail: "RNFBAnalyticsModule", weight: 0.75 }];
  const r = buildReport("x", matchReport([]), [guess("@react-native-firebase/analytics", ev)]);
  assert.deepEqual(r.guessedDeps, []);
  assert.deepEqual(r.suppressedGuesses, []);
  assert.equal(r.hintedDeps.length, 1);
  assert.equal(r.hintedDeps[0]!.package, "@react-native-firebase/analytics");
  assert.equal(r.hintedDeps[0]!.evidenceKind, "native-module");
  assert.ok(r.hintedDeps[0]!.confidence >= 0.75);
  assert.equal(r.attribution.guessedModules, 0, "a hint is never counted as attributed");
});

test("a lone url-host evidence is a hint, not suppressed", () => {
  const ev: Evidence[] = [{ kind: "url-host", detail: "api.stripe.com", weight: 0.4 }];
  const r = buildReport("x", matchReport([]), [guess("@stripe/stripe-react-native", ev)]);
  assert.deepEqual(r.guessedDeps, []);
  assert.deepEqual(r.suppressedGuesses, []);
  assert.equal(r.hintedDeps.length, 1);
  assert.equal(r.hintedDeps[0]!.evidenceKind, "url-host");
});

test("a lone package-name-string with no version stays suppressed, not a hint", () => {
  const ev: Evidence[] = [{ kind: "package-name-string", detail: "react-native-gesture-handler", weight: 0.3 }];
  const r = buildReport("x", matchReport([]), [guess("react-native-gesture-handler", ev, 1, null)]);
  assert.deepEqual(r.hintedDeps, []);
  assert.equal(r.suppressedGuesses.length, 1);
  assert.equal(r.suppressedGuesses[0]!.reason, "single-evidence-kind");
});

test("a lone package-name-string with a version is a hint", () => {
  const ev: Evidence[] = [{ kind: "package-name-string", detail: "react-native-gesture-handler@2.14.0", weight: 0.3 }];
  const r = buildReport("x", matchReport([]), [guess("react-native-gesture-handler", ev, 1, "2.14.0")]);
  assert.deepEqual(r.suppressedGuesses, []);
  assert.equal(r.hintedDeps.length, 1);
  assert.equal(r.hintedDeps[0]!.version, "2.14.0");
  assert.equal(r.hintedDeps[0]!.evidenceKind, "package-name-string");
});

test("a lone dependency-edge or apk evidence is never a hint", () => {
  const depEdge: Evidence[] = [{ kind: "dependency-edge", detail: "2/2 deps owned by some-pkg@2.0.0", weight: 0.4 }];
  const r1 = buildReport("x", matchReport([]), [guess("some-pkg", depEdge)]);
  assert.deepEqual(r1.hintedDeps, []);
  assert.equal(r1.suppressedGuesses[0]!.reason, "single-evidence-kind");

  const apkOnly: Evidence[] = [{ kind: "apk", detail: "BILLING", weight: 0.2 }];
  const r2 = buildReport("x", matchReport([]), [guess("react-native-iap", apkOnly, 2)]);
  assert.deepEqual(r2.hintedDeps, []);
  assert.equal(r2.suppressedGuesses[0]!.reason, "single-evidence-kind");
});

test("a package the DB scored explicitly negative is never hinted either", () => {
  const ev: Evidence[] = [{ kind: "native-module", detail: "RNGestureHandlerModule", weight: 0.75 }];
  const negative = score({ package: "react-native-gesture-handler", fuzzyOnlyHits: 2, fuzzyCoverage: 0.02, tier: "low" });
  const r = buildReport("x", matchReport([negative]), [guess("react-native-gesture-handler", ev)]);
  assert.deepEqual(r.hintedDeps, []);
  assert.equal(r.suppressedGuesses[0]!.reason, "db-match-negative");
});

test("confirmed packages are never also hinted", () => {
  const ev: Evidence[] = [{ kind: "native-module", detail: "DevSettings", weight: 0.75 }];
  const r = buildReport("x", matchReport([score({ package: "react-native", exactHits: 900, exactCoverage: 0.9, moduleExactHits: 10, tier: "high" })]), [guess("react-native", ev)]);
  assert.equal(r.confirmedDeps.length, 1);
  assert.deepEqual(r.hintedDeps, []);
});

test("a hinted module is excluded from the printed unattributedModules list but stays counted as unattributed", () => {
  const ev: Evidence[] = [{ kind: "native-module", detail: "RNFBAnalyticsModule", weight: 0.75 }];
  const unattributed = [{ localModuleId: 1, factoryFunctionIndex: 1, depCount: 0, nestedFunctionCount: 0, instrCount: 30, stringConstants: ["RNFBAnalyticsModule"], owners: [], ownerBasis: null }];
  const r = buildReport("x", { hbcVersion: 94, totalFunctions: 1, totalModules: 1, packagesChecked: 0, packages: [], moduleAttributions: unattributed, unattributedModules: unattributed }, [guess("@react-native-firebase/analytics", ev)]);
  assert.equal(r.hintedDeps.length, 1);
  assert.deepEqual(r.unattributedModules, []);
  assert.equal(r.attribution.unattributedModules, 1);
  assert.equal(r.attribution.guessedModules, 0);
});
