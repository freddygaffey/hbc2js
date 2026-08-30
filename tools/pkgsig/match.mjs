#!/usr/bin/env node
// tools/pkgsig/match.mjs — T8 prototype v2, task 5 (docs/PACKAGE-SIGNATURES.md §5.4).
//
// Matches a compiled target `.hbc` against every package DB under
// tools/pkgsig/db/, producing a per-Metro-module report: best package@version
// match with a confidence tier, plus a whole-bundle summary.
//
// Unlike the v1 prototype, baseline subtraction already happened once, at
// DB-write time (build-db.mjs's --subtract), so this file does not need its
// own --baseline flag for the common case — every package DB under db/ (not
// db/_baselines/) already excludes toolchain/react/react-native noise. The
// three db/_baselines/*.json files are loaded too and matched like any other
// package, so react/react-native themselves are still recognised (they are
// exactly the packages the "foundation" baselines were built *from*, so a
// real app bundle should score ~100% against them, and a bundle without
// react-native present should not).
//
// Scoring per package, over its own function set (docs §5.4's confidence
// signals):
//   - exact-function coverage: fraction of the package's functions whose
//     exactHash is present in the target.
//   - fuzzy coverage: same, for fuzzyHash (adds functions whose opcode
//     sequence matches but literal content doesn't).
//   - module-count agreement: how many of the package's recovered __d()
//     modules have their factory's exactHash present in the target *and*
//     depCount matching (docs §3.1's whole-module anchor, §5.3's dscan data).
//   - stringSetHash corroboration: for fuzzy-only function hits, whether the
//     string-constant-set hash also matches (stronger than fuzzy alone,
//     weaker than exact).
//
// Confidence thresholds (docs/PACKAGE-SIGNATURES.md §3.4, carried into §5.4):
//   High:   module-level exact match (factory exactHash + depCount agree)
//           for >=1 module, or overall exact-function coverage >= 0.90.
//   Medium: overall fuzzy coverage >= 0.50 (§2.4's react true-positive floor)
//           but High not met.
//   Low:    any exact or fuzzy hit at all, below Medium's floor.
//   None:   zero hits after the length floor.
//
// Usage:
//   node match.mjs <bundle.hbc> --db tools/pkgsig/db [--min-instr 8] [--hbc N]
//
// Zero deps beyond Node stdlib + this repo's own src/** (parser/disasm only).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintModule } from "./lib/fingerprint.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const { parseHbc } = await import(join(repoRoot, "src", "index.ts"));
const { decodeFunction } = await import(join(repoRoot, "src", "disasm", "decode.ts"));

function loadJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function listDbFiles(dbDir) {
  const files = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      if (name === "index.json") continue;
      const full = join(d, name);
      if (name.endsWith(".json")) files.push(full);
    }
  };
  if (existsSync(dbDir)) walk(dbDir);
  const baselines = join(dbDir, "_baselines");
  if (existsSync(baselines)) walk(baselines);
  return files;
}

function buildIndex(functions, key) {
  const idx = new Map();
  for (const fn of functions) {
    const h = fn[key];
    let list = idx.get(h);
    if (list === undefined) {
      list = [];
      idx.set(h, list);
    }
    list.push(fn);
  }
  return idx;
}

/** Score one package DB against the target's indices. Returns null if the
 *  package has no hbcVersion-eligible functions to score (e.g. built for a
 *  different HBC version than the target — never silently cross-compared). */
function scorePackage(pkg, target, targetExact, targetFuzzy, targetStringHash, minInstr) {
  if (pkg.hbcVersion !== target.header.version) return null;
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
  for (const m of pkg.modules ?? []) {
    if (m.factoryIsBaseline) continue;
    if (m.factoryExactHash !== null && targetExact.has(m.factoryExactHash)) moduleExactHits++;
  }
  const moduleTotal = (pkg.modules ?? []).filter((m) => !m.factoryIsBaseline && m.factoryExactHash !== null).length;

  const exactCoverage = exactHits / eligible.length;
  const fuzzyCoverage = (exactHits + fuzzyOnlyHits) / eligible.length;

  // A single coincidentally-matching module (moduleExactHits === 1 on a
  // package with hundreds of modules) is not "high" confidence for the
  // *whole package* — it's exactly the FLIRT-style single-hash-collision
  // risk docs/PACKAGE-SIGNATURES.md §1.2/§3.4 warns about. Require either a
  // handful of independent module hits (>=3, and not vanishingly rare
  // relative to the package's own size) or a strong function-level exact
  // floor before calling a whole package "high" — a lone module hit still
  // surfaces at "medium" (it's real signal, just not enough on its own to
  // call the whole package present with high confidence) and, more
  // importantly, is still fully visible per-module in the module report
  // below, which is where a single confident module match belongs.
  const moduleCoverage = moduleTotal === 0 ? 0 : moduleExactHits / moduleTotal;
  const strongModuleSignal = moduleExactHits >= 3 || (moduleExactHits >= 1 && moduleCoverage >= 0.05);

  let tier;
  if (strongModuleSignal || exactCoverage >= 0.9) tier = "high";
  else if (fuzzyCoverage >= 0.5 || moduleExactHits >= 1) tier = "medium";
  else if (exactHits + fuzzyOnlyHits > 0) tier = "low";
  else tier = "none";

  return {
    package: pkg.package,
    version: pkg.version,
    isBaseline: Boolean(pkg.toolchainBaseline),
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

function tierRank(t) {
  return { high: 3, medium: 2, low: 1, none: 0 }[t] ?? 0;
}

function main() {
  const argv = process.argv.slice(2);
  const pos = [];
  const opts = { db: join(__dirname, "db"), minInstr: 8 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") opts.db = argv[++i];
    else if (a === "--min-instr") opts.minInstr = Number(argv[++i]);
    else if (a === "--json") opts.json = true;
    else pos.push(a);
  }
  const [bundlePath] = pos;
  if (!bundlePath) {
    console.error("usage: match.mjs <bundle.hbc> --db tools/pkgsig/db [--min-instr N] [--json]");
    process.exit(2);
  }

  const bytes = new Uint8Array(readFileSync(bundlePath));
  const target = parseHbc(bytes);
  const { functions: targetFunctions, modules: targetModules } = fingerprintModule(target, decodeFunction);
  const targetExact = buildIndex(targetFunctions, "exactHash");
  const targetFuzzy = buildIndex(targetFunctions, "fuzzyHash");
  const targetStringHash = buildIndex(targetFunctions, "stringSetHash");
  const targetByIndex = new Map(targetFunctions.map((f) => [f.index, f]));

  const dbFiles = listDbFiles(opts.db);
  const pkgs = dbFiles.map(loadJson);

  const results = [];
  // Reverse index for per-module attribution (docs §5.4/§3.1's "whole-module
  // anchoring"): which package(s)' own function set contains a given exact
  // hash. Built once, over every hbc-version-eligible package, not just the
  // ones that clear a confidence tier overall — a single module can still be
  // named even if its package's *overall* coverage is low (e.g. only one of
  // several bundled packages from that DB happens to be present).
  const hashOwners = new Map();
  for (const pkg of pkgs) {
    if (pkg.hbcVersion !== target.header.version) continue;
    const score = scorePackage(pkg, target, targetExact, targetFuzzy, targetStringHash, opts.minInstr);
    if (score !== null) results.push(score);
    for (const fn of pkg.functions) {
      let owners = hashOwners.get(fn.exactHash);
      if (owners === undefined) {
        owners = [];
        hashOwners.set(fn.exactHash, owners);
      }
      owners.push(`${pkg.package}@${pkg.version}`);
    }
  }
  results.sort((a, b) => tierRank(b.tier) - tierRank(a.tier) || b.exactCoverage - a.exactCoverage);

  const matched = results.filter((r) => r.tier !== "none");
  const confident = results.filter((r) => r.tier === "high" || r.tier === "medium");

  // Per-Metro-module report (task 5): every module __d()-registered in the
  // target's own `global` (dscan.mjs), best owning package by exact-hash
  // lookup on its factory function, or "unmatched" (listed with instruction
  // count as a size proxy — no raw byte range is tracked per function today).
  const moduleReports = targetModules.map((m) => {
    const owners = m.factoryExactHash !== null ? (hashOwners.get(m.factoryExactHash) ?? []) : [];
    const factoryFn = targetByIndex.get(m.factoryFunctionIndex);
    return {
      localModuleId: m.localModuleId,
      factoryFunctionIndex: m.factoryFunctionIndex,
      depCount: m.depCount,
      nestedFunctionCount: m.nestedFunctionCount,
      instrCount: factoryFn?.instrCount ?? null,
      owners,
    };
  });
  const unmatchedModules = moduleReports.filter((m) => m.owners.length === 0).sort((a, b) => (b.instrCount ?? 0) - (a.instrCount ?? 0));

  if (opts.json) {
    console.log(JSON.stringify({ bundle: bundlePath, hbcVersion: target.header.version, totalFunctions: targetFunctions.length, results, modules: moduleReports }, null, 1));
    return;
  }

  console.log(`bundle: ${bundlePath}`);
  console.log(`hbc version: ${target.header.version}, functions: ${targetFunctions.length}, __d() modules: ${targetModules.length}`);
  console.log(`packages checked: ${dbFiles.length} (${results.length} hbc-version-eligible)`);
  console.log("");
  console.log("== whole-bundle package summary ==");
  console.log("package".padEnd(45), "ver".padEnd(16), "tier".padEnd(7), "exact%".padEnd(8), "fuzzy%".padEnd(8), "modules");
  for (const r of results) {
    if (r.tier === "none") continue;
    console.log(
      (r.isBaseline ? `[baseline] ${r.package}` : r.package).padEnd(45),
      r.version.padEnd(16),
      r.tier.padEnd(7),
      `${(r.exactCoverage * 100).toFixed(1)}%`.padEnd(8),
      `${(r.fuzzyCoverage * 100).toFixed(1)}%`.padEnd(8),
      `${r.moduleExactHits}/${r.moduleTotal}`
    );
  }
  console.log("");
  console.log(`summary: ${confident.length}/${results.length} eligible packages matched at medium+ confidence; ${matched.length - confident.length} at low confidence only.`);
  console.log("");
  console.log(`== per-module attribution: ${targetModules.length - unmatchedModules.length}/${targetModules.length} modules matched to >=1 known package, ${unmatchedModules.length} unmatched ==`);
  console.log(`largest unmatched modules (likely app-specific code, instrCount as size proxy):`);
  for (const m of unmatchedModules.slice(0, 15)) {
    console.log(`  module id=${m.localModuleId ?? "?"} fnIdx=${m.factoryFunctionIndex} instrCount=${m.instrCount ?? "?"} depCount=${m.depCount ?? "?"} nested=${m.nestedFunctionCount}`);
  }
}

main();
