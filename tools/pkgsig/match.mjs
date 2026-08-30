#!/usr/bin/env node
// tools/pkgsig/match.mjs — T8 prototype (docs/PACKAGE-SIGNATURES.md).
//
// Matches one or more package signature DBs (from build-signatures.mjs)
// against a target module's own signature DB, and reports, per package:
//   - exact-match rate:  fraction of the *package's own* functions whose
//     exactHash appears somewhere in the target (package-side recall — "if
//     we shipped this package, would D17 have found it?").
//   - fuzzy-match rate:  same, but for fuzzyHash (a function counts once it
//     has *any* fuzzy hit, whether or not it was already an exact hit).
//   - collision rate:    how many of the package's exactHash/fuzzyHash
//     values are non-unique *within its own DB* (trivial one-instruction
//     functions collide with each other; this is the same problem FLIRT/
//     Function-ID solve by requiring a minimum function length before a
//     signature is trusted).
//   - stringSet Jaccard: for fuzzy-only hits, the median string-set overlap
//     with the best-matching target function, as a secondary confidence
//     signal on top of the fuzzy opcode-sequence hash.
//
// Usage:
//   node match.mjs <target.sig.json> <pkg1.sig.json> [pkg2.sig.json ...] [--min-instr N] [--baseline metro-baseline.sig.json]
//
// --baseline should point at a signature DB built from a *minimal, no-npm-
// dependency* entry point (`module.exports = {}`) bundled with the exact
// same Metro/Babel/hermesc toolchain as everything else. Its functions are
// Metro's own require-runtime + injected polyfills, which every bundle from
// that toolchain contains byte-for-byte regardless of which npm packages are
// actually present — without subtracting them, match rates (and especially
// false-positive rates for absent packages) are inflated by this constant
// per-toolchain floor. See docs/PACKAGE-SIGNATURES.md §2 ("Metro/Babel
// toolchain baseline").
//
// Do NOT use another *real* package's DB as a stand-in for this (e.g. "hash
// shared by react's DB and lodash's DB must be baseline noise") — two real
// packages can legitimately share code via a common dependency (react-native
// depends on react itself), which would then be wrongly subtracted as
// "noise" and erase genuine matches. Only a deliberately dependency-free
// probe bundle is safe to use this way.
//
// Zero deps.

import { readFileSync } from "node:fs";

function loadDb(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jaccard(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const s of setA) if (setB.has(s)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

function buildIndex(db, key) {
  const index = new Map();
  for (const fn of db.functions) {
    const h = fn[key];
    let list = index.get(h);
    if (list === undefined) {
      list = [];
      index.set(h, list);
    }
    list.push(fn);
  }
  return index;
}

function main() {
  const args = process.argv.slice(2);
  let minInstr = 0;
  let baselinePath = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min-instr") {
      minInstr = Number(args[++i]);
    } else if (args[i] === "--baseline") {
      baselinePath = args[++i];
    } else {
      pos.push(args[i]);
    }
  }
  const [targetPath, ...pkgPaths] = pos;
  if (!targetPath || pkgPaths.length === 0) {
    console.error("usage: match.mjs <target.sig.json> <pkg1.sig.json> [pkg2.sig.json ...] [--min-instr N] [--baseline metro-baseline.sig.json]");
    process.exit(2);
  }

  const target = loadDb(targetPath);
  const targetExact = buildIndex(target, "exactHash");
  const targetFuzzy = buildIndex(target, "fuzzyHash");

  // Toolchain-baseline subtraction (see usage comment above): exactHash
  // values from a dedicated dependency-free probe bundle, excluded from
  // every package's rate below because they're Metro/Babel runtime code,
  // not that package's own identity.
  const baselineHashes = new Set();
  if (baselinePath !== null) {
    const baseline = loadDb(baselinePath);
    for (const f of baseline.functions) baselineHashes.add(f.exactHash);
    console.log(`toolchain baseline: ${baseline.package}@${baseline.version} — ${baselineHashes.size} hashes excluded from rates below`);
  }

  console.log(`target: ${target.package}@${target.version} (hbc v${target.hbcVersion}, ${target.totalFunctions} functions)`);
  if (minInstr > 0) console.log(`(functions with < ${minInstr} instructions excluded from rates — trivial-function collision floor)`);
  console.log("");

  for (const pkgPath of pkgPaths) {
    const pkg = loadDb(pkgPath);
    const pkgExact = buildIndex(pkg, "exactHash");
    const pkgFuzzy = buildIndex(pkg, "fuzzyHash");

    const eligible = pkg.functions.filter((f) => f.instrCount >= minInstr && !baselineHashes.has(f.exactHash));
    let exactHits = 0;
    let fuzzyOnlyHits = 0;
    const jaccardSamples = [];

    for (const fn of eligible) {
      const exactMatches = targetExact.get(fn.exactHash);
      if (exactMatches !== undefined) {
        exactHits++;
        continue;
      }
      const fuzzyMatches = targetFuzzy.get(fn.fuzzyHash);
      if (fuzzyMatches !== undefined) {
        fuzzyOnlyHits++;
        let best = 0;
        for (const cand of fuzzyMatches) best = Math.max(best, jaccard(fn.stringSet, cand.stringSet));
        jaccardSamples.push(best);
      }
    }

    // Self-collision rate: how many distinct hash values in the package's
    // own DB are shared by >1 function (a same-package internal collision —
    // signals how much of this DB is "too generic to trust alone").
    let exactCollisions = 0;
    for (const list of pkgExact.values()) if (list.length > 1) exactCollisions += list.length;
    let fuzzyCollisions = 0;
    for (const list of pkgFuzzy.values()) if (list.length > 1) fuzzyCollisions += list.length;

    const total = eligible.length;
    const exactRate = total === 0 ? 0 : exactHits / total;
    const fuzzyRate = total === 0 ? 0 : (exactHits + fuzzyOnlyHits) / total;
    const medianJaccard = jaccardSamples.length === 0 ? null : jaccardSamples.sort((a, b) => a - b)[Math.floor(jaccardSamples.length / 2)];

    console.log(`== ${pkg.package}@${pkg.version} (${pkg.totalFunctions} functions, ${total} eligible after baseline+min-instr filtering) ==`);
    console.log(`  exact-match rate:  ${exactHits}/${total}  (${(exactRate * 100).toFixed(1)}%)`);
    console.log(`  fuzzy-match rate:  ${exactHits + fuzzyOnlyHits}/${total}  (${(fuzzyRate * 100).toFixed(1)}%)  [of which ${fuzzyOnlyHits} fuzzy-only]`);
    if (medianJaccard !== null) console.log(`  median stringSet Jaccard on fuzzy-only hits: ${medianJaccard.toFixed(2)}`);
    console.log(`  self-collisions (own DB): exact ${exactCollisions}/${pkg.totalFunctions}, fuzzy ${fuzzyCollisions}/${pkg.totalFunctions}`);
    console.log("");
  }
}

main();
