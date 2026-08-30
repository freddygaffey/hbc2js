#!/usr/bin/env node
// tools/deps-truth.mjs — D17d ground truth for `hbc2js deps`.
//
//   node tools/deps-truth.mjs <bundle.hbc> <bundle.map> --bundle-js <bundle.js> [--write-truth <truth.json>] [--also-hbc <debug.hbc>] [--json]
//   node tools/deps-truth.mjs <bundle.hbc> <truth.json> [--json]
//
// Metro's source map (`--sourcemap-output`) records the source file of every
// generated line; each `__d(...)` module is one line of the minified bundle
// ending in `},<id>,[deps]);`, so line -> source path -> `node_modules/<pkg>`
// (+ that package's package.json version) is per-module truth. A compact
// `truth.json` (module id -> package@version, plus the .hbc's sha256) is
// what fixtures commit, so scoring never needs the 3+ MB map or a
// node_modules tree. Scores the deps report: precision/recall for the
// confirmed and guessed tiers, per-module attribution accuracy, and the
// false positives / misses by name.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runDeps } from "../src/deps/index.ts";

const BASELINE_ALIAS = { "react-foundation": "react", "react-native-foundation": "react-native", "metro-toolchain-empty": null };

// --- source map ----------------------------------------------------------

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeVlq(seg) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (const ch of seg) {
    const digit = B64.indexOf(ch);
    if (digit < 0) throw new Error(`bad VLQ char ${ch}`);
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

/** Dominant source index per generated line (null when a line has no mapping). */
function sourcePerLine(map) {
  const lines = map.mappings.split(";");
  let src = 0;
  return lines.map((line) => {
    if (line === "") return null;
    const counts = new Map();
    for (const seg of line.split(",")) {
      if (seg === "") continue;
      const f = decodeVlq(seg);
      if (f.length >= 4) {
        src += f[1];
        counts.set(src, (counts.get(src) ?? 0) + 1);
      }
    }
    let best = null;
    let bestN = 0;
    for (const [s, n] of counts) if (n > bestN) [best, bestN] = [s, n];
    return best;
  });
}

function packageFromSource(source) {
  const idx = source.lastIndexOf("node_modules/");
  if (idx < 0) return null;
  const rest = source.slice(idx + "node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  const root = source.slice(0, idx + "node_modules/".length) + name;
  return { name, root };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function truthFromMap(hbcPaths, mapPath, bundleJsPath) {
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const srcPerLine = sourcePerLine(map);
  const jsLines = readFileSync(bundleJsPath, "utf8").split("\n");
  const modules = {};
  const versions = new Map();
  jsLines.forEach((text, i) => {
    if (!text.startsWith("__d(")) return;
    const m = /\},(\d+),\[[\d,]*\]\);\s*$/.exec(text);
    if (m === null) return;
    const srcIdx = srcPerLine[i];
    const source = srcIdx === null || srcIdx === undefined ? null : map.sources[srcIdx];
    const pkg = source === null ? null : packageFromSource(source);
    let version = null;
    if (pkg !== null) {
      if (!versions.has(pkg.root)) {
        try {
          versions.set(pkg.root, JSON.parse(readFileSync(join(pkg.root, "package.json"), "utf8")).version ?? null);
        } catch {
          versions.set(pkg.root, null);
        }
      }
      version = versions.get(pkg.root);
    }
    modules[m[1]] = { package: pkg?.name ?? null, version, source: source === null ? null : source.slice(source.lastIndexOf("node_modules/") >= 0 ? source.lastIndexOf("node_modules/") : Math.max(0, dirname(bundleJsPath).length + 1)) };
  });
  const packages = {};
  const roots = new Map();
  for (const m of Object.values(modules)) {
    if (m.package === null || m.package in packages) continue;
    packages[m.package] = m.version;
    roots.set(m.package, [...versions.keys()].find((r) => r.endsWith(`node_modules/${m.package}`)));
  }
  // A truth package that some other truth package declares as a dependency
  // is "transitive": the signature DB fingerprints a package *with* its
  // dependencies bundled (minus the toolchain baselines), so e.g. every
  // @babel/runtime helper module in an RN app is, by the DB's construction,
  // attributed to react-native. Recall is therefore reported over direct
  // (top-level) packages as well as over all of them.
  const transitiveOf = {};
  for (const [pkg, root] of roots) {
    if (root === undefined) continue;
    let deps = {};
    try {
      const pj = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      deps = pj.dependencies ?? {};
    } catch {
      continue;
    }
    for (const dep of Object.keys(deps)) {
      if (dep in packages && dep !== pkg) (transitiveOf[dep] ??= []).push(pkg);
    }
  }
  // Direct dependencies: what the app's own package.json (next to the
  // bundle, when the bundle was built in the project root) declares.
  let direct = null;
  try {
    const app = JSON.parse(readFileSync(join(dirname(bundleJsPath), "package.json"), "utf8"));
    direct = Object.keys(app.dependencies ?? {}).filter((d) => d in packages).sort();
  } catch {
    // no app package.json reachable — scoring falls back to "not transitive".
  }
  const hbcSha256s = {};
  for (const h of hbcPaths) hbcSha256s[h.slice(h.lastIndexOf("/") + 1)] = sha256File(h);
  return { hbcSha256s, moduleCount: Object.keys(modules).length, packages, direct, transitiveOf, modules };
}

// --- scoring -------------------------------------------------------------

function ownerPackage(owner) {
  const raw = owner.slice(0, owner.lastIndexOf("@"));
  return raw in BASELINE_ALIAS ? BASELINE_ALIAS[raw] : raw;
}

export async function scoreAgainstTruth(hbcPath, truth, depsOptions = { offline: true }) {
  const result = await runDeps(hbcPath, depsOptions);
  const r = result.report;
  const truthPkgs = new Set(Object.keys(truth.packages));
  const confirmed = new Set(r.confirmedDeps.map((d) => d.package));
  const guessed = new Set(r.guessedDeps.map((d) => d.package));
  const inter = (a, b) => [...a].filter((x) => b.has(x));
  const directPkgs = new Set(truth.direct ?? [...truthPkgs].filter((p) => !(p in (truth.transitiveOf ?? {}))));
  const confirmedTP = inter(confirmed, truthPkgs);
  const guessedTP = inter(guessed, truthPkgs);
  const remaining = new Set([...truthPkgs].filter((p) => !confirmed.has(p)));
  const ratio = (n, d) => (d === 0 ? null : n / d);

  const perModule = { withTruth: 0, correct: 0, viaDependent: 0, wrong: 0, unattributed: 0, appModulesAttributed: 0 };
  const wrongModules = [];
  for (const m of result.matchReport.moduleAttributions) {
    const t = m.localModuleId === null ? undefined : truth.modules[String(m.localModuleId)];
    const owner = m.owners[0] === undefined ? null : ownerPackage(m.owners[0]);
    if (t === undefined) continue;
    if (t.package === null) {
      if (owner !== null) perModule.appModulesAttributed++;
      continue;
    }
    perModule.withTruth++;
    if (owner === null) perModule.unattributed++;
    else if (owner === t.package) perModule.correct++;
    else if ((truth.transitiveOf?.[t.package] ?? []).includes(owner)) perModule.viaDependent++;
    else {
      perModule.wrong++;
      wrongModules.push({ id: m.localModuleId, truth: t.package, reported: owner, basis: m.ownerBasis });
    }
  }

  return {
    input: hbcPath,
    hbcSha256Matches: Object.values(truth.hbcSha256s ?? {}).includes(sha256File(hbcPath)),
    reactNativeVersion: r.reactNativeVersion,
    truthPackages: [...truthPkgs].sort(),
    directPackages: [...directPkgs].sort(),
    confirmed: { reported: [...confirmed].sort(), precision: ratio(confirmedTP.length, confirmed.size), recall: ratio(confirmedTP.length, truthPkgs.size), directRecall: ratio(inter(confirmed, directPkgs).length, directPkgs.size), falsePositives: [...confirmed].filter((p) => !truthPkgs.has(p)), misses: [...truthPkgs].filter((p) => !confirmed.has(p)) },
    guessed: { reported: [...guessed].sort(), precision: ratio(guessedTP.length, guessed.size), recall: ratio(inter(guessed, remaining).length, remaining.size), falsePositives: [...guessed].filter((p) => !truthPkgs.has(p)), misses: [...remaining].filter((p) => !guessed.has(p)) },
    versionMismatches: r.confirmedDeps.filter((d) => truthPkgs.has(d.package) && truth.packages[d.package] !== null && truth.packages[d.package] !== d.version).map((d) => `${d.package}: reported ${d.version}, truth ${truth.packages[d.package]}`),
    perModule: { ...perModule, accuracy: ratio(perModule.correct, perModule.withTruth), wrongModules },
    attribution: r.attribution,
  };
}

function pct(x) {
  return x === null ? "n/a" : `${(x * 100).toFixed(1)}%`;
}

export function formatScore(s) {
  const lines = [];
  lines.push(`deps-truth: ${s.input}${s.hbcSha256Matches ? "" : "  (WARNING: .hbc sha256 differs from the truth file's)"}`);
  lines.push(`  truth: ${s.truthPackages.length} packages (${s.directPackages.length} direct: ${s.directPackages.join(", ")}); react-native detected: ${s.reactNativeVersion ?? "null"}`);
  lines.push(`  confirmed: ${s.confirmed.reported.length} reported, precision ${pct(s.confirmed.precision)}, recall ${pct(s.confirmed.recall)} of all / ${pct(s.confirmed.directRecall)} of direct`);
  if (s.confirmed.falsePositives.length > 0) lines.push(`    FALSE POSITIVES: ${s.confirmed.falsePositives.join(", ")}`);
  if (s.confirmed.misses.length > 0) lines.push(`    misses: ${s.confirmed.misses.join(", ")}`);
  if (s.versionMismatches.length > 0) lines.push(`    version mismatches: ${s.versionMismatches.join("; ")}`);
  lines.push(`  guessed: ${s.guessed.reported.length} reported, precision ${pct(s.guessed.precision)}, recall-of-remaining ${pct(s.guessed.recall)}`);
  if (s.guessed.falsePositives.length > 0) lines.push(`    false positives: ${s.guessed.falsePositives.join(", ")}`);
  if (s.guessed.misses.length > 0) lines.push(`    misses: ${s.guessed.misses.join(", ")}`);
  const m = s.perModule;
  lines.push(`  per-module: ${m.withTruth} library modules — ${m.correct} correct (${pct(m.accuracy)}), ${m.viaDependent} attributed to the package that depends on them, ${m.wrong} wrong package, ${m.unattributed} unattributed; ${m.appModulesAttributed} app modules wrongly attributed`);
  for (const w of m.wrongModules.slice(0, 10)) lines.push(`    module ${w.id}: truth ${w.truth}, reported ${w.reported} (${w.basis})`);
  return lines.join("\n");
}

async function main(argv) {
  const positional = [];
  let bundleJs;
  let writeTruth;
  const alsoHbc = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--bundle-js") bundleJs = argv[++i];
    else if (a === "--write-truth") writeTruth = argv[++i];
    else if (a === "--also-hbc") alsoHbc.push(argv[++i]);
    else if (a === "--json") json = true;
    else positional.push(a);
  }
  const [hbcPath, truthOrMap] = positional;
  if (hbcPath === undefined || truthOrMap === undefined) {
    process.stderr.write("usage: deps-truth.mjs <bundle.hbc> <bundle.map|truth.json> [--bundle-js <bundle.js>] [--write-truth <truth.json>] [--also-hbc <other.hbc>] [--json]\n");
    return 2;
  }
  let truth;
  if (truthOrMap.endsWith(".map")) {
    if (bundleJs === undefined) {
      process.stderr.write("--bundle-js <bundle.js> is required with a .map (module ids come from the bundle's __d lines)\n");
      return 2;
    }
    truth = truthFromMap([hbcPath, ...alsoHbc], truthOrMap, bundleJs);
    if (writeTruth !== undefined) writeFileSync(writeTruth, JSON.stringify(truth, null, 1) + "\n");
  } else {
    truth = JSON.parse(readFileSync(truthOrMap, "utf8"));
  }
  const score = await scoreAgainstTruth(hbcPath, truth);
  process.stdout.write((json ? JSON.stringify(score, null, 2) : formatScore(score)) + "\n");
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
