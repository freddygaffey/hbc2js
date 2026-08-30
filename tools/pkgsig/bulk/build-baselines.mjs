#!/usr/bin/env node
// tools/pkgsig/bulk/build-baselines.mjs — generates the three toolchain/
// foundation baseline signature files (docs/PACKAGE-SIGNATURES.md §5.2) for
// ONE (scaffold, hbcVersion) pair, straight from that scaffold's own
// installed react/react-native/metro versions — never hand-picked, per
// this task's fix for the version-mismatch risk flagged in §4 S2 (the
// repo's checked-in `tools/pkgsig/db/_baselines/react-native-foundation@
// 0.85.3__hbc98.json` doesn't match the bulk build's actual RN 0.87.1
// scaffold; `metro-toolchain-empty@0.83__hbc98.json` doesn't match its
// actual metro 0.87.0 either — both regenerated fresh here).
//
// Usage:
//   node build-baselines.mjs <hbcVersion> <scaffoldDir> <hermescPath> <outDbDir>
//
// Writes 3 files (metro-toolchain-empty, react-foundation,
// react-native-foundation) into <outDbDir>/_baselines/ via
// src/deps/db.ts's own writeSignature() (same function build-one.mjs uses),
// so the on-disk format is identical to the curated shared DB's baselines.
// Always overwrites (baselines are cheap to regenerate and must never be
// hand-merged) and is NOT run under the per-package `npm install` --
// react/react-native are already present in every scaffold by construction.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..", "..");

const { decodeFunction } = await import(join(REPO_ROOT, "src/disasm/decode.ts"));
const { parseHbc } = await import(join(REPO_ROOT, "src/parse/module.ts"));
const { fingerprintModule } = await import(join(REPO_ROOT, "src/deps/fingerprint.ts"));
const { writeSignature } = await import(join(REPO_ROOT, "src/deps/db.ts"));

const [hbcVersionStr, scaffoldDir, hermescPath, outDbDir] = process.argv.slice(2);
if (!hbcVersionStr || !scaffoldDir || !hermescPath || !outDbDir) {
  console.error("usage: build-baselines.mjs <hbcVersion> <scaffoldDir> <hermescPath> <outDbDir>");
  process.exit(2);
}
const hbcVersion = Number(hbcVersionStr);

function readInstalledVersion(pkgName) {
  const p = join(scaffoldDir, "node_modules", ...pkgName.split("/"), "package.json");
  if (!existsSync(p)) throw new Error(`scaffold ${scaffoldDir} has no node_modules/${pkgName}/package.json`);
  return JSON.parse(readFileSync(p, "utf8")).version;
}

// kind -> { package: baseline "package" name, versionOf: real npm package
// whose installed version names this baseline, entrySource: the probe
// bundle's entry-file body }
const KINDS = [
  { package: "metro-toolchain-empty", versionOf: "metro", entrySource: "module.exports = {};\n" },
  { package: "react-foundation", versionOf: "react", entrySource: 'const X = require("react");\nmodule.exports = X;\n' },
  { package: "react-native-foundation", versionOf: "react-native", entrySource: 'const X = require("react-native");\nmodule.exports = X;\n' },
];

function bundleAndCompile(kind, workDir) {
  const slug = `${kind.package}-${hbcVersion}`.replace(/[^a-zA-Z0-9._-]/g, "-");
  const entryFile = join(scaffoldDir, `__bulk_baseline_entry_${slug}__.js`);
  writeFileSync(entryFile, kind.entrySource);
  const bundlePath = join(workDir, "out.bundle");
  const assetsDir = join(workDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  try {
    execFileSync(
      "npx",
      ["react-native", "bundle", "--platform", "android", "--dev", "false", "--minify", "true", "--max-workers", "1", "--reset-cache", "--entry-file", entryFile, "--bundle-output", bundlePath, "--assets-dest", assetsDir],
      { cwd: scaffoldDir, stdio: ["ignore", "ignore", "pipe"], timeout: 120_000 },
    );
  } finally {
    rmSync(entryFile, { force: true });
  }
  const hbcPath = join(workDir, "out.hbc");
  execFileSync(hermescPath, ["-O", "-emit-binary", `-out=${hbcPath}`, bundlePath], { stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 });
  return hbcPath;
}

function buildOne(kind) {
  const version = readInstalledVersion(kind.versionOf);
  const workDir = mkdtempSync(join(tmpdir(), "hbc2js-baseline-"));
  try {
    const hbcPath = bundleAndCompile(kind, workDir);
    const bytes = new Uint8Array(readFileSync(hbcPath));
    const mod = parseHbc(bytes);
    if (mod.header.version !== hbcVersion) {
      throw new Error(`hermesc produced HBC version ${mod.header.version}, expected ${hbcVersion} (hermescPath=${hermescPath})`);
    }
    const { functions, modules } = fingerprintModule(mod, decodeFunction);
    const db = {
      schema: 2,
      package: kind.package,
      version,
      hbcVersion: mod.header.version,
      totalFunctions: functions.length,
      rawFunctionCount: functions.length,
      subtractedBaselines: [],
      functions,
      modules,
      toolchainBaseline: true,
      provenance: {
        packageSha256: null,
        metroVersion: kind.package === "metro-toolchain-empty" ? version : null,
        reactNativeVersion: kind.package === "react-native-foundation" ? version : null,
        hermescVersion: hbcVersion,
        hermescRnEra: null,
        repoCommit: null,
        builtAt: new Date().toISOString(),
      },
    };
    const written = writeSignature(outDbDir, db);
    console.log(JSON.stringify({ package: kind.package, version, hbcVersion, ok: true, functions: functions.length, modules: modules.length, writtenTo: written }));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

for (const kind of KINDS) {
  try {
    buildOne(kind);
  } catch (e) {
    console.log(JSON.stringify({ package: kind.package, hbcVersion, ok: false, reason: e instanceof Error ? e.message : String(e) }));
    process.exitCode = 1;
  }
}
