#!/usr/bin/env node
// tools/e2e/oss-benchmark.mjs — OPEN-SOURCE APP GROUND-TRUTH BENCHMARK
// (docs/QUEUE.md "A", Fred 2026-09-02): Fred's north-star metric — how
// close is the decompiled `src/` tree hbc2js produces to the real app's
// repo, for a small set of public-source React Native apps we have both a
// Hermes bundle and *some* ground truth for.
//
// Pipeline scored: decompile -> --split -> deps (offline) -> segregate
// (docs/specs/08-segregation.md). For each configured app this runs that
// pipeline once and scores four things against the app's source map:
//   1. classification (app vs library) -- see the CLASSIFICATION CAVEAT
//      below before trusting the "precision/recall" numbers.
//   2. naming closeness -- FUZZY match, reusing name-accuracy.mjs's
//      similarity() (Levenshtein + token-set on tokenised basenames), not
//      reimplemented here.
//   3. structure -- which of src/screens, src/store, src/navigation the
//      pipeline created vs whether the real app's source paths suggest it
//      has those.
//   4. readability proxies (rN/1k, Reflect.apply/1k, _fnN/1k) computed
//      only over the segregated `src/` bucket's own text.
//
// CLASSIFICATION CAVEAT (read before trusting precision/recall): as
// name-accuracy.mjs documents, a Metro bundle's source-map `sources` array
// is NOT reliably indexed by module id for these fixtures -- there is no
// cheap way to say "module 42's real file is sources[42]". That rules out
// true per-module precision/recall (which needs module-id -> ground-truth
// alignment). Two honest, weaker metrics stand in instead:
//   - libraryPackagePrecision/Recall: PACKAGE-level, not module-level.
//     Every node_modules-bucket module the pipeline names a package for
//     (`deps` classify/match/guess) is checked against the *set* of
//     packages the map's own `node_modules/<pkg>/...` paths mention --
//     "did we guess a real dependency of this app", not "did we guess the
//     dependency this exact module came from" (precision), and "of the
//     real dependencies, how many did we name at least one module for"
//     (recall).
//   - aggregateRateAgreement: a coarse sanity check -- the pipeline's
//     library-module fraction vs the map's library-source fraction, with
//     no per-module claim at all.
// Naming inherits name-accuracy.mjs's own caveat (best-match against the
// single closest real basename, not an id-verified pairing).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { splitProject } from "../../src/split/index.ts";
import { segregateSplitTree } from "../../src/split/segregate.ts";
import { runDeps } from "../../src/deps/index.ts";
import { similarity, basenameNoExt } from "./name-accuracy.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Config array (per the brief): add an app by appending an entry here.
 *  `map: null` means "no source map available" -- the benchmark still
 *  reports pipeline-only numbers (module counts, dirs created) for that
 *  app but skips every ground-truth-scored field, never fabricating one. */
export const APPS = [
  {
    name: "react-navigation-example-0.85.3",
    hbc: join(ROOT, "tests/fixtures/bundles/react-navigation-example-0.85.3/react-navigation-example.hbc"),
    map: join(ROOT, "tests/fixtures/bundles/react-navigation-example-0.85.3/react-navigation-example.map"),
    // This fixture's map is from a pnpm monorepo: the demo app lives under
    // `/example/`, but react-navigation's OWN packages are workspace-linked
    // source under `/packages/*` -- real library code, never under a
    // `node_modules/` path in this map. "not under node_modules" is
    // therefore not a valid "is this app source" test here; `appSourcePrefix`
    // says which prefix genuinely is the app, so `/packages/*` is correctly
    // scored as library-ish ground truth instead of miscounted as app code.
    appSourcePrefix: "/example/",
  },
  {
    // Committed, tiny, real source is known -- but no source map is
    // shipped, so ground-truth scoring is skipped for now. Follow-up (see
    // docs/e2e/OSS-BENCHMARK.md): build one with `--sourcemap-output` or
    // diff directly against the committed source tree instead of a map.
    name: "rn-template-0.72",
    hbc: join(ROOT, "tests/fixtures/bundles/rn-template-0.72/index.android.hbc"),
    map: null,
  },
];

/** pnpm hoists real packages under `.../node_modules/.pnpm/<key>/node_modules/<pkg>/...`
 *  -- the FIRST `node_modules/` segment after a path like that is the pnpm
 *  store directory (`.pnpm`), not a package name, so this takes the LAST
 *  `node_modules/` occurrence (works for plain npm/yarn layouts too, where
 *  there's only one). */
function extractPackageFromNodeModulesPath(path) {
  const idx = path.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  const rest = path.slice(idx + "node_modules/".length);
  const parts = rest.split("/");
  if (parts.length === 0 || parts[0] === "" || parts[0] === ".pnpm") return null;
  if (parts[0].startsWith("@") && parts.length > 1) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

/** Ground truth extracted from a bundle's `.map` `sources` array -- parsed,
 *  never `cat`, since these files run into the tens of MB. `appSourcePrefix`
 *  (per-app config, optional) is the one genuinely-app path prefix; every
 *  other source -- `node_modules/`, or, for a monorepo fixture, workspace-
 *  linked sibling packages -- counts as library-ish. Falls back to "not
 *  under node_modules" when an app config doesn't set it (correct for a
 *  plain npm/yarn app, the common case; see the react-navigation-example
 *  config for why a monorepo needs the explicit prefix instead). */
function loadTruth(mapPath, appSourcePrefix) {
  const map = JSON.parse(readFileSync(mapPath, "utf8"));
  const sources = map.sources ?? [];
  const isJsLike = (s) => /\.(tsx?|jsx?)$/.test(s);
  const isApp = appSourcePrefix === undefined ? (s) => !s.includes("node_modules") : (s) => s.startsWith(appSourcePrefix);
  const appSources = sources.filter((s) => isApp(s) && isJsLike(s));
  const libPackages = new Set();
  for (const s of sources) {
    if (!s.includes("node_modules/")) continue;
    const pkg = extractPackageFromNodeModulesPath(s);
    if (pkg !== null) libPackages.add(pkg);
  }
  return {
    appSources,
    appBasenames: appSources.map(basenameNoExt),
    appSourceCount: appSources.length,
    libSourceCount: sources.length - appSources.length,
    totalSourceCount: sources.length,
    libPackages,
  };
}

function per1k(text, lineCount, pattern) {
  const n = (text.match(pattern) ?? []).length;
  return { count: n, per1kLines: lineCount === 0 ? 0 : (n / lineCount) * 1000 };
}

function scoreClassification(seg, truth) {
  const pipelineNM = seg.modules.filter((m) => m.bucket === "node_modules");
  const pipelineSrc = seg.modules.filter((m) => m.bucket === "src");
  const pipelineUnclassified = seg.modules.filter((m) => m.bucket === "unclassified");

  const withPkg = pipelineNM.filter((m) => m.package !== null);
  const withPkgHits = withPkg.filter((m) => truth.libPackages.has(m.package));
  const guessedPkgs = new Set(withPkg.map((m) => m.package));
  let recallHits = 0;
  for (const p of truth.libPackages) if (guessedPkgs.has(p)) recallHits++;

  const pipelineTotal = pipelineNM.length + pipelineSrc.length;
  const pipelineLibraryFraction = pipelineTotal === 0 ? 0 : pipelineNM.length / pipelineTotal;
  const truthTotal = truth.appSourceCount + truth.libSourceCount;
  const truthLibraryFraction = truthTotal === 0 ? 0 : truth.libSourceCount / truthTotal;

  return {
    pipelineModuleCounts: { library: pipelineNM.length, src: pipelineSrc.length, unclassified: pipelineUnclassified.length },
    libraryPackagePrecision: {
      value: withPkg.length === 0 ? null : withPkgHits.length / withPkg.length,
      sampleSize: withPkg.length,
    },
    libraryPackageRecall: {
      value: truth.libPackages.size === 0 ? null : recallHits / truth.libPackages.size,
      truthPackageCount: truth.libPackages.size,
      detectedPackageCount: guessedPkgs.size,
    },
    aggregateRateAgreement: {
      pipelineLibraryFraction,
      truthLibraryFraction,
      absDelta: Math.abs(pipelineLibraryFraction - truthLibraryFraction),
    },
    caveat:
      "package-level precision/recall (not module-level -- no reliable module-id -> source-map alignment exists for these bundles, see the file header) plus a coarse aggregate library-fraction sanity check. libraryPackageRecall's truthPackageCount only counts packages literally under a node_modules/ path in the map -- workspace-linked monorepo packages (see appSourcePrefix) are real dependencies too but are undercounted here since their map path never contains node_modules/.",
  };
}

function scoreNaming(seg, truth) {
  const named = seg.modules.filter((m) => m.bucket === "src" && m.nameSignal !== null);
  const scored = named.map((m) => {
    const recovered = basenameNoExt(m.newPath);
    let best = { truth: null, score: 0 };
    for (const t of truth.appBasenames) {
      const s = similarity(recovered, t);
      if (s > best.score) best = { truth: t, score: s };
    }
    return { id: m.id, recovered: m.newPath, ...best };
  });
  const srcTotal = seg.modules.filter((m) => m.bucket === "src").length;
  const mean = scored.length === 0 ? 0 : scored.reduce((s, x) => s + x.score, 0) / scored.length;
  const atLeast08 = scored.filter((x) => x.score >= 0.8).length;
  return {
    srcTotal,
    srcNamed: named.length,
    pctSrcNamed: srcTotal === 0 ? 0 : named.length / srcTotal,
    meanFuzzySimilarity: mean,
    pctAtLeast08: scored.length === 0 ? 0 : atLeast08 / scored.length,
    caveat: "best-match fuzzy similarity vs the single closest real app basename (see tools/e2e/name-accuracy.mjs header) -- not an id-verified pairing.",
  };
}

const STRUCTURE_DIRS = [
  { dir: "src/screens", truthSegment: "screens" },
  { dir: "src/store", truthSegment: "store" },
  { dir: "src/navigation", truthSegment: "navigation" },
];

function scoreStructure(seg, truth) {
  const pipelineDirs = {};
  for (const { dir } of STRUCTURE_DIRS) pipelineDirs[dir] = seg.modules.some((m) => m.newPath.startsWith(`${dir}/`));
  const truthDirs = {};
  for (const { dir, truthSegment } of STRUCTURE_DIRS) {
    const re = new RegExp(`(^|/)${truthSegment}(/|$)`, "i");
    truthDirs[dir] = truth.appSources.some((s) => re.test(s));
  }
  return { pipelineDirs, truthDirs };
}

function scoreReadability(seg) {
  const srcPaths = new Set(seg.modules.filter((m) => m.bucket === "src").map((m) => m.newPath));
  let text = "";
  for (const [path, content] of seg.files) {
    if (srcPaths.has(path)) text += `${content}\n`;
  }
  const lineCount = text.length === 0 ? 0 : text.split("\n").length;
  return {
    lineCount,
    registers: per1k(text, lineCount, /\br\d+\b/g),
    reflectApply: per1k(text, lineCount, /Reflect\.apply\(/g),
    anonFnNames: per1k(text, lineCount, /\b_fn\d+\b/g),
  };
}

/** Runs the full decompile -> split -> deps -> segregate pipeline for one
 *  app config and scores it. Ground-truth-scored fields (`classification`,
 *  `naming`, `structure`) are `null` when `app.map` is `null` -- reported,
 *  never fabricated. */
export async function runBenchmark(app) {
  if (!existsSync(app.hbc)) {
    return { name: app.name, ok: false, reason: `bundle not present: ${app.hbc}` };
  }
  const bytes = readFileSync(app.hbc);
  const split = splitProject(bytes, { moduleName: app.name });
  const depsRun = await runDeps(app.hbc, { offline: true });
  const seg = segregateSplitTree(split.files, depsRun.report);
  const readability = scoreReadability(seg);

  if (app.map === null || !existsSync(app.map)) {
    return {
      name: app.name,
      ok: true,
      hasGroundTruth: false,
      moduleCount: seg.modules.length,
      readability,
    };
  }

  const truth = loadTruth(app.map, app.appSourcePrefix);
  return {
    name: app.name,
    ok: true,
    hasGroundTruth: true,
    moduleCount: seg.modules.length,
    classification: scoreClassification(seg, truth),
    naming: scoreNaming(seg, truth),
    structure: scoreStructure(seg, truth),
    readability,
  };
}

function fmtPct(n) {
  return n === null || n === undefined ? "n/a" : `${(n * 100).toFixed(1)}%`;
}

function toMarkdown(results) {
  const lines = [];
  lines.push("# OSS ground-truth benchmark");
  lines.push("");
  lines.push("| app | modules | classification precision (pkg) | recall (pkg) | naming mean fuzzy | naming >=0.8 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of results) {
    if (!r.ok) {
      lines.push(`| ${r.name} | skipped (${r.reason}) | | | | |`);
      continue;
    }
    if (!r.hasGroundTruth) {
      lines.push(`| ${r.name} | ${r.moduleCount} | no ground truth (.map) | | | |`);
      continue;
    }
    lines.push(
      `| ${r.name} | ${r.moduleCount} | ${fmtPct(r.classification.libraryPackagePrecision.value)} | ${fmtPct(r.classification.libraryPackageRecall.value)} | ${r.naming.meanFuzzySimilarity.toFixed(3)} | ${fmtPct(r.naming.pctAtLeast08)} |`,
    );
  }
  lines.push("");
  lines.push(
    "Caveats: classification precision/recall is package-level, not module-level (no reliable module-id -> source-map alignment for these bundles); naming similarity is best-match fuzzy against the closest real basename, not an id-verified pairing. See tools/e2e/oss-benchmark.mjs header and docs/e2e/OSS-BENCHMARK.md.",
  );
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  let appFilter = null;
  let json = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a.startsWith("--app=")) appFilter = a.slice("--app=".length);
    else if (a === "--app") appFilter = "__next__";
    else if (appFilter === "__next__") appFilter = a;
  }
  return { appFilter, json };
}

async function main() {
  const { appFilter, json } = parseArgs(process.argv.slice(2));
  const apps = appFilter === null ? APPS : APPS.filter((a) => a.name === appFilter);
  const results = [];
  for (const app of apps) results.push(await runBenchmark(app));
  if (json) {
    process.stdout.write(`${JSON.stringify(apps.length === 1 ? results[0] : results, null, 2)}\n`);
  } else {
    process.stdout.write(toMarkdown(results));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`oss-benchmark: ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  });
}
