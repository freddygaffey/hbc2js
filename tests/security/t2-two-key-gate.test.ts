// tests/security/t2-two-key-gate.test.ts — T2 (spec 13 §3.2, §10). Pure unit
// test of Lane O's claim/candidate classifier on a fabricated DepsReport, no
// network.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DepsReport, ConfirmedDep, GuessedDep, HintedDep } from "../../src/deps/report.ts";
import { gateDependency } from "../../src/security/osv-gate.ts";

/** A minimal-but-DepsReport-shaped fixture: only the fields the gate reads
 *  (`confirmedDeps`/`guessedDeps`/`hintedDeps`) vary per case, everything
 *  else is a fixed, valid-but-empty skeleton (structural typing means the
 *  gate never looks at the rest, but the type must still line up). */
function fabricateReport(over: { confirmedDeps?: ConfirmedDep[]; guessedDeps?: GuessedDep[]; hintedDeps?: HintedDep[] }): DepsReport {
  return {
    input: "fabricated.hbc",
    hbcVersion: 96,
    totalFunctions: 0,
    totalModules: 0,
    reactNativeVersion: null,
    reactNativeVersionConsistentWithHbc: null,
    reactNativeVersionExpectedRange: null,
    confirmedDeps: over.confirmedDeps ?? [],
    guessedDeps: over.guessedDeps ?? [],
    hintedDeps: over.hintedDeps ?? [],
    suppressedGuesses: [],
    unattributedModules: [],
    moduleOwnership: [],
    attribution: {
      totalModules: 0,
      matchedModules: 0,
      guessedModules: 0,
      unattributedModules: 0,
      percentAttributed: 0,
      totalInstrWeight: 0,
      matchedInstrWeight: 0,
      guessedInstrWeight: 0,
      hintedInstrWeight: 0,
      unattributedInstrWeight: 0,
      matchedInstrWeightByBasis: { exact: 0, fuzzyStrings: 0, fuzzyOnly: 0 },
      percentAttributedByWeight: 0,
      percentVerifiedByWeight: 0,
    },
    classification: null,
  } as unknown as DepsReport;
}

test("T2: High tier + exact-hash version -> claim", () => {
  const report = fabricateReport({
    confirmedDeps: [{ package: "lodash", version: "4.17.15", confidence: "high", modulesCovered: 3, moduleTotal: 3, source: "db-match", versionEvidence: "exact-hash" }],
  });
  const gate = gateDependency(report, "lodash");
  assert.equal(gate.tier, "claim");
  assert.equal(gate.hasIdentity, true);
  assert.equal(gate.hasDirectVersion, true);
  assert.equal(gate.version, "4.17.15");
});

test("T2: High tier + date-inferred version -> candidate (version key fails)", () => {
  const report = fabricateReport({
    confirmedDeps: [{ package: "axios", version: "0.21.0", confidence: "high", modulesCovered: 2, moduleTotal: 2, source: "confirmed", versionEvidence: "date-inferred" }],
  });
  const gate = gateDependency(report, "axios");
  assert.equal(gate.tier, "candidate");
  assert.equal(gate.hasIdentity, true);
  assert.equal(gate.hasDirectVersion, false);
});

test("T2: confidence 0.6 guess + versioned literal -> no record (identity key fails; PUSHBACK P-13, spec §3.2 vs §10)", () => {
  const report = fabricateReport({
    guessedDeps: [{ package: "minimist", version: null, confidence: 0.6, modules: 1, evidence: ["package-name-string: minimist", "dependency-edge: 1/1 deps owned by minimist@0.0.8"] }],
    hintedDeps: [{ package: "minimist", version: "0.0.8", confidence: 0.3, evidenceKind: "package-name-string", evidence: ["package-name-string: minimist@0.0.8"] }],
  });
  const gate = gateDependency(report, "minimist");
  assert.equal(gate.hasIdentity, false); // 0.6 < 0.75 identity floor
  assert.equal(gate.tier, "none"); // no identity key at all -> no record, even with a direct version
});

test("T2: confidence >=0.75 guess with only 1 evidence kind -> no record (identity needs >=2 kinds)", () => {
  const report = fabricateReport({
    guessedDeps: [{ package: "minimist", version: "0.0.8", confidence: 0.9, modules: 1, evidence: ["package-name-string: minimist@0.0.8"] }],
  });
  const gate = gateDependency(report, "minimist");
  assert.equal(gate.hasIdentity, false);
  assert.equal(gate.tier, "none");
});

test("T2: confidence >=0.75 guess with >=2 evidence kinds + no direct version -> candidate", () => {
  const report = fabricateReport({
    guessedDeps: [{ package: "minimist", version: "0.0.8", confidence: 0.8, modules: 1, evidence: ["package-name-string: minimist@0.0.8", "dependency-edge: 2/2 deps owned by minimist@0.0.8"] }],
  });
  const gate = gateDependency(report, "minimist");
  assert.equal(gate.hasIdentity, true);
  assert.equal(gate.identityBasis, "guessed-strong");
  assert.equal(gate.hasDirectVersion, false); // guess confidence, no db-match/confirm/hint
  assert.equal(gate.tier, "candidate");
});

test("T2: Low/hint dep with no identity signal -> no record at all", () => {
  const report = fabricateReport({
    hintedDeps: [{ package: "left-pad", version: "1.3.0", confidence: 0.3, evidenceKind: "package-name-string", evidence: ["package-name-string: left-pad@1.3.0"] }],
  });
  const gate = gateDependency(report, "left-pad");
  assert.equal(gate.hasIdentity, false);
  assert.equal(gate.tier, "none");
});

test("T2: R-T demotion tripwire caps a guessed-strong identity claim at candidate", () => {
  const report = fabricateReport({
    guessedDeps: [{ package: "minimist", version: "0.0.8", confidence: 0.8, modules: 1, evidence: ["package-name-string: minimist@0.0.8", "dependency-edge: 2/2 deps owned by minimist@0.0.8"] }],
    hintedDeps: [{ package: "minimist", version: "0.0.8", confidence: 0.3, evidenceKind: "package-name-string", evidence: ["package-name-string: minimist@0.0.8"] }],
  });
  const undemoted = gateDependency(report, "minimist");
  assert.equal(undemoted.tier, "claim"); // hint literal supplies the direct version key
  const demoted = gateDependency(report, "minimist", { demoteGuessedIdentityClaims: true });
  assert.equal(demoted.tier, "candidate");
});
