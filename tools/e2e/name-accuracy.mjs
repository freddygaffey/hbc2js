#!/usr/bin/env node
// tools/e2e/name-accuracy.mjs — docs/specs/08-segregation.md milestone 3
// scorecard: how close are hbc2js segregate's recovered `src/` names to the
// real app's file names?
//
// Ground-truth caveat (read before trusting the numbers): a bundle's source
// map `sources` array is NOT indexed by Metro module id for this fixture —
// verified by hand (`sources[986]` is an unrelated node_modules file while
// module 986 is the split tree's *entry*; `sources[1086]`/`sources[1368]`
// are also unrelated node_modules paths for modules that are, by content,
// real `/example/` app code). There is no cheap, reliable module-id ->
// source-path correspondence recoverable from this bundle's own metadata,
// so this script does not attempt one. Instead it scores each *recovered*
// app-module name against the SINGLE BEST-matching real app source
// basename (fuzzy, over the whole non-`node_modules` `sources` list) --
// "did hbc2js recover a name close to *some* real file in this app",
// not "did it recover *the* file this exact module came from". That is a
// weaker claim than an id-verified pairing would be, stated here rather
// than implied by a clean-looking score.
//
// Usage: node tools/e2e/name-accuracy.mjs <bundle.hbc> <source.map> [--json]
import { readFileSync } from "node:fs";
import { splitProject } from "../../src/split/index.ts";
import { segregateSplitTree } from "../../src/split/segregate.ts";
import { runDeps } from "../../src/deps/index.ts";

// Exported for reuse by tools/e2e/oss-benchmark.mjs (the OSS ground-truth
// benchmark builds on this milestone-3 fuzzy name scorer instead of
// reimplementing it -- one similarity metric, one place it can be wrong).
export function basenameNoExt(path) {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(tsx?|jsx?)$/, "");
}

/** Splits a name into lowercase tokens on camelCase/PascalCase boundaries,
 *  underscores, and hyphens -- e.g. "BottomTabsPreloadFlow" ->
 *  ["bottom","tabs","preload","flow"]. */
export function tokenise(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

/** 0..1 similarity: average of normalised-Levenshtein on the token-joined
 *  string and a token-set (Jaccard) ratio -- "fuzzy" per the brief: neither
 *  a strict rename bar (Levenshtein alone penalises reordering, e.g.
 *  "TabsScreen" vs "ScreenTabs") nor a bag-of-words-only match (which
 *  would call "Home" and "HomeScreen" identical). */
export function similarity(a, b) {
  const ta = tokenise(a);
  const tb = tokenise(b);
  const ja = ta.join("");
  const jb = tb.join("");
  const maxLen = Math.max(ja.length, jb.length, 1);
  const levSim = 1 - levenshtein(ja, jb) / maxLen;
  const sa = new Set(ta);
  const sb = new Set(tb);
  const inter = [...sa].filter((t) => sb.has(t)).length;
  const union = new Set([...sa, ...sb]).size || 1;
  const tokenSim = inter / union;
  return (levSim + tokenSim) / 2;
}

async function main() {
  const [, , bundlePath, mapPath, ...rest] = process.argv;
  const asJson = rest.includes("--json");
  // 2026-09-02 (Service NSW brief): proves navigator/screen detection works
  // from call/config shape alone, with no `deps` run at all (the whole
  // point -- Service NSW's own `deps` run takes >10 min). `--no-deps` skips
  // `runDeps` entirely and passes `null` to `segregateSplitTree`, same as
  // the CLI's `hbc2js segregate` with no `--deps-report`.
  const noDeps = rest.includes("--no-deps");
  if (bundlePath === undefined || mapPath === undefined) {
    process.stderr.write("usage: name-accuracy.mjs <bundle.hbc> <source.map> [--json] [--no-deps]\n");
    process.exit(2);
  }

  const bytes = readFileSync(bundlePath);
  const split = splitProject(bytes, { moduleName: bundlePath.split("/").pop() });
  const report = noDeps ? null : (await runDeps(bundlePath, { offline: true })).report;
  const seg = segregateSplitTree(split.files, report);

  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const truthBasenames = map.sources.filter((s) => !s.includes("node_modules") && /\.(tsx?|jsx?)$/.test(s)).map(basenameNoExt);

  const named = seg.modules.filter((m) => m.bucket === "src" && m.nameSignal !== null);
  const scored = named.map((m) => {
    const recovered = basenameNoExt(m.newPath);
    let best = { truth: null, score: 0 };
    for (const t of truthBasenames) {
      const s = similarity(recovered, t);
      if (s > best.score) best = { truth: t, score: s };
    }
    return { id: m.id, recovered: m.newPath, signal: m.nameSignal, ...best };
  });

  const srcTotal = seg.modules.filter((m) => m.bucket === "src").length;
  const mean = scored.length === 0 ? 0 : scored.reduce((s, x) => s + x.score, 0) / scored.length;
  const atLeast08 = scored.filter((x) => x.score >= 0.8).length;
  const screens = seg.modules.filter((m) => m.nameSignal?.startsWith("screen-route")).length;
  const navigators = seg.modules.filter((m) => m.nameSignal?.startsWith("navigator")).length;

  const result = {
    srcTotal,
    srcNamed: named.length,
    pctSrcNamed: srcTotal === 0 ? 0 : named.length / srcTotal,
    screensDetected: screens,
    navigatorsDetected: navigators,
    truthBasenameCount: truthBasenames.length,
    meanSimilarity: mean,
    pctAtLeast08: scored.length === 0 ? 0 : atLeast08 / scored.length,
    samples: scored
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 15),
  };

  if (asJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  process.stdout.write(`name-accuracy: ${bundlePath}\n`);
  process.stdout.write(`  src/ modules: ${result.srcTotal}, named: ${result.srcNamed} (${(result.pctSrcNamed * 100).toFixed(1)}%)\n`);
  process.stdout.write(`  screens detected: ${result.screensDetected}, navigators detected: ${result.navigatorsDetected}\n`);
  process.stdout.write(`  ground-truth app basenames (from .map, non-node_modules): ${result.truthBasenameCount}\n`);
  process.stdout.write(`  mean fuzzy similarity (best-match, see caveat at top of this file): ${result.meanSimilarity.toFixed(3)}\n`);
  process.stdout.write(`  % named modules with similarity >= 0.8: ${(result.pctAtLeast08 * 100).toFixed(1)}%\n`);
  process.stdout.write(`  sample recovered -> best-match truth pairs:\n`);
  for (const s of result.samples) process.stdout.write(`    ${s.recovered}  ->  ${s.truth}  (${s.score.toFixed(2)}, ${s.signal})\n`);
}

// Guarded (not an unconditional top-level call) since tools/e2e/oss-
// benchmark.mjs now imports this module's pure functions for reuse -- a
// bare `main()` at import time would try to parse the importer's argv as
// this script's own <bundle.hbc> <source.map> CLI args and crash.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
