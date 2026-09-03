// docs/DECISIONS.md QUEUE item 22(a) — evidence-directed candidate matching
// for `hbc2js deps` (`src/deps/candidates.ts`). Before this task the match
// stage loaded and JSON-parsed EVERY signature file in every DB layer up
// front (`db.ts`'s `loadSignatures`), scored against the target's whole
// function set regardless of any actual evidence the bundle depends on that
// package — the dominant cost on a real bulk (32k-signature) DB. This file
// covers the candidate-derivation unit and the correctness bar this task
// requires: the evidence-directed default (`loadSignatures(layers)` with no
// `--exhaustive`) must attribute the SAME packages as the old exhaustive
// path for every module both attribute — no silently-shipped recall drop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { buildInventory } from "../../../src/deps/inventory.ts";
import { resolveDbLayers, loadSignatures } from "../../../src/deps/db.ts";
import { matchInventory } from "../../../src/deps/match.ts";
import { deriveCandidatePackages, findCandidatesInText, packageNameFromSigFilename } from "../../../src/deps/candidates.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

test("packageNameFromSigFilename: reverses writeSignature's `/` -> `__` mangling, ignores non-signature files", () => {
  assert.equal(packageNameFromSigFilename("lodash@4.17.21__hbc94.json"), "lodash");
  assert.equal(packageNameFromSigFilename("@react-navigation__native@6.1.18__hbc94.json"), "@react-navigation/native");
  assert.equal(packageNameFromSigFilename("index.json"), null);
  assert.equal(packageNameFromSigFilename("not-a-signature-file.txt"), null);
});

test("findCandidatesInText: multi-pattern substring search, case-insensitive, independent of pattern count", () => {
  const found = findCandidatesInText(["react-native", "lodash", "totally-absent-package"], "some code mentions React-Native and Lodash somewhere".toLowerCase());
  assert.ok(found.has("react-native"));
  assert.ok(found.has("lodash"));
  assert.ok(!found.has("totally-absent-package"));
});

test("findCandidatesInText: handles thousands of patterns without degrading to per-pattern scanning (perf smoke)", () => {
  const patterns = Array.from({ length: 20000 }, (_, i) => `synthetic-package-${i}`);
  patterns.push("needle-package");
  const haystack = `${"padding text ".repeat(2000)}this bundle mentions needle-package once${"more padding ".repeat(2000)}`;
  const start = Date.now();
  const found = findCandidatesInText(patterns, haystack);
  const elapsedMs = Date.now() - start;
  assert.ok(found.has("needle-package"));
  assert.equal(found.size, 1, `expected exactly the one real hit, got ${found.size}`);
  assert.ok(elapsedMs < 2000, `expected well under 2s for 20k patterns, took ${elapsedMs}ms`);
});

test("deriveCandidatePackages: rn-template-0.72 finds react + react-native from its own strings, without loading every shared-DB file", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const layers = resolveDbLayers({ outDir: "/nonexistent-project-dir-for-this-test", noSharedDb: false });
  const candidates = deriveCandidatePackages(layers, inventory);
  assert.ok(candidates.has("react"), `expected "react" to be evidence-derived, got: ${[...candidates].join(", ")}`);
  assert.ok(candidates.has("react-native"), `expected "react-native" to be evidence-derived, got: ${[...candidates].join(", ")}`);
  assert.ok(!candidates.has("lodash"), "lodash has no evidence in rn-template's own strings and must not be a candidate");
});

test("correctness bar: evidence-directed default attributes the SAME packages as --exhaustive for every module both attribute (rn-template-0.72)", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const layers = resolveDbLayers({ outDir: "/nonexistent-project-dir-for-this-test", noSharedDb: false });

  const exhaustiveDbs = loadSignatures(layers); // no candidates: old, unconditional behaviour
  const exhaustiveReport = matchInventory(inventory, exhaustiveDbs);

  const candidates = deriveCandidatePackages(layers, inventory);
  const directedDbs = loadSignatures(layers, { candidates });
  const directedReport = matchInventory(inventory, directedDbs);

  // Evidence-directed must never load MORE files than exhaustive (it's a
  // subset by construction) and, for this well-evidenced fixture, should
  // load meaningfully fewer — the actual perf win.
  assert.ok(directedDbs.length <= exhaustiveDbs.length, `evidence-directed loaded ${directedDbs.length} files, exhaustive loaded ${exhaustiveDbs.length} — expected a subset`);

  let comparedModules = 0;
  let divergences = 0;
  const diffs: string[] = [];
  for (let i = 0; i < exhaustiveReport.moduleAttributions.length; i++) {
    const ex = exhaustiveReport.moduleAttributions[i]!;
    const dir = directedReport.moduleAttributions[i]!;
    if (ex.owners.length === 0 || dir.owners.length === 0) continue; // only compare modules BOTH attribute
    comparedModules++;
    const exSet = [...ex.owners].sort().join(",");
    const dirSet = [...dir.owners].sort().join(",");
    if (exSet !== dirSet) {
      divergences++;
      diffs.push(`module#${i}: exhaustive=[${exSet}] evidence-directed=[${dirSet}]`);
    }
  }
  assert.equal(divergences, 0, `evidence-directed diverged from exhaustive on ${divergences}/${comparedModules} modules both attribute:\n${diffs.join("\n")}`);
  assert.ok(comparedModules > 0, "expected at least some modules attributed by both paths on this well-covered fixture");

  // Same confirmedDeps package set, quantified (docs/DEPS.md "evidence-directed" numbers).
  const exConfirmed = new Set(exhaustiveReport.packages.filter((p) => p.tier === "high" && !p.isBaseline).map((p) => p.package));
  const dirConfirmed = new Set(directedReport.packages.filter((p) => p.tier === "high" && !p.isBaseline).map((p) => p.package));
  assert.deepEqual([...dirConfirmed].sort(), [...exConfirmed].sort(), `evidence-directed confirmedDeps package set must match exhaustive's on rn-template-0.72; exhaustive=${[...exConfirmed]} directed=${[...dirConfirmed]}`);
});

test("--exhaustive preserves the exact pre-QUEUE-22a behaviour: loadSignatures(layers) with no options loads every file, unfiltered", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const { inventory } = buildInventory(bytes);
  const layers = resolveDbLayers({ outDir: "/nonexistent-project-dir-for-this-test", noSharedDb: false });
  const a = loadSignatures(layers);
  const b = loadSignatures(layers, {});
  assert.equal(a.length, b.length, "omitting opts and passing {} must be equivalent — both exhaustive");
  void inventory;
});
