#!/usr/bin/env node
// tools/appgen/compare.mjs — PROVE THE LOOP (task step 3): run one appgen
// triple's bundle through our own decompile -> split -> segregate pipeline
// and compare the result against the triple's own source map (the ground
// truth minted by build.mjs). This increment does NOT tune the decompiler
// on the result — it is the measuring instrument, a poor score is a finding
// (see the task report), not something this script fixes.
//
// Usage: node tools/appgen/compare.mjs <triple-dir>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { splitProject } from "../../src/split/index.ts";
import { segregateSplitTree } from "../../src/split/segregate.ts";
import { runDeps } from "../../src/deps/index.ts";

async function main() {
  const tripleDir = process.argv[2];
  if (!tripleDir) {
    console.error("usage: node tools/appgen/compare.mjs <triple-dir>");
    process.exit(2);
  }
  const bytes = new Uint8Array(readFileSync(join(tripleDir, "bundle.hbc")));
  const map = JSON.parse(readFileSync(join(tripleDir, "bundle.map"), "utf8"));
  const config = JSON.parse(readFileSync(join(tripleDir, "config.json"), "utf8"));

  const split = splitProject(bytes, { moduleName: "bundle.hbc" });
  // Offline deps (no npm network calls) so segregation gets the same
  // classification/ownership evidence the real pipeline uses (matches
  // tools/e2e/oss-benchmark.mjs's convention) rather than the degenerate
  // "no report at all" case.
  const depsRun = await runDeps(join(tripleDir, "bundle.hbc"), { offline: true });
  const seg = segregateSplitTree(split.files, depsRun.report);

  const mapSources = map.sources || [];
  const appSourceIsOurs = (s) => s.includes("/src/") || s.endsWith("/App.js") || s.endsWith("/index.js");
  const groundTruthAppFileCount = mapSources.filter(appSourceIsOurs).length;

  const namedModules = seg.modules.filter((m) => m.bucket === "src" && m.nameSignal !== null);
  const screenHits = config.screens.filter((name) =>
    seg.modules.some((m) => m.newPath.includes(name)),
  );
  const navigatorDetected = seg.modules.some((m) => /navigation|navigator/i.test(m.newPath));

  const report = {
    triple: config.id,
    hbcVersion: config.hbcVersion,
    router: config.router,
    depStyle: config.depStyle,
    moduleCountTotal: split.modules.length,
    groundTruthAppFileCount,
    srcBucketModules: seg.modules.filter((m) => m.bucket === "src").length,
    namedSrcModules: namedModules.length,
    screensInManifest: config.screens.length,
    screensDetectedByName: screenHits.length,
    screensDetected: screenHits,
    navigatorDetected,
  };
  console.log(JSON.stringify(report, null, 2));
}

main();

