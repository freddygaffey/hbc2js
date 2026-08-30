#!/usr/bin/env node
// tools/pkgsig/build-db.mjs — T8 prototype v2, task 3 (docs/PACKAGE-SIGNATURES.md §5).
//
// End-to-end signature-DB builder: bundle -> compile -> fingerprint -> write
// into tools/pkgsig/db/, for one npm package at one HBC version.
//
// Two modes:
//   (a) full pipeline — write a `require('<pkg>')` entry file into an
//       existing, already-`npm install`-ed project directory, bundle it with
//       Metro (`npx react-native bundle` or, with --bundler expo, `expo
//       export`), compile with the requested hermesc version, then
//       fingerprint. This is the real end-to-end path.
//   (b) --hbc-file <path> — skip bundling entirely and fingerprint an
//       already-produced single-package `.hbc` (e.g. one built by hand while
//       iterating, or one of this task's own out94/*.hbc scratch artifacts).
//       Still writes full provenance, just without re-running Metro.
//
// A --project directory is expected to already have the target package (and
// react-native, at the version whose hermesc you're targeting) installed —
// this script does not scaffold a fresh RN template itself (see
// tools/pkgsig/README.md for how to provision one; tests/fixtures/bundles/
// */BUILD.md's own scaffolding recipes are the reference). If the package
// isn't yet in the project's node_modules at the requested version, this
// script runs `npm install <pkg>@<ver> --legacy-peer-deps` in that project
// before bundling (real network access — intentional, matches how every
// other Tier-2 fixture in this repo is produced).
//
// Usage:
//   node build-db.mjs <pkg>@<ver> --project <dir> [--hbc 94|96|98|99]
//     [--bundler react-native|expo] [--entry-dir <dir-relative-to-project>]
//     [--hbc-file <path>] [--out tools/pkgsig/db] [--baseline <name>]
//
// Zero deps beyond Node stdlib + this repo's own src/** (parser/disasm only).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintModule } from "./lib/fingerprint.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const { parseHbc } = await import(join(repoRoot, "src", "index.ts"));
const { decodeFunction } = await import(join(repoRoot, "src", "disasm", "decode.ts"));

function sha256(s) {
  return createHash("sha256").update(s).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

/** Deterministic hash of a package's on-disk contents (provenance's
 *  "package sha" — docs §5.2), independent of npm registry tarball hashing:
 *  sha256 over a sorted `relpath\tsha256(file)` manifest. Skips any nested
 *  node_modules (transitive deps are their own provenance, not this
 *  package's). */
function hashPackageDir(dir) {
  const entries = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(full);
      if (st.isDirectory()) walk(full, r);
      else entries.push(`${r}\t${sha256File(full)}`);
    }
  };
  walk(dir, "");
  entries.sort();
  return sha256(entries.join("\n"));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
  } catch {
    return null;
  }
}

const HBC_RN_HINT = { 94: "0.72.x", 96: "0.73.x", 98: "0.85.x/0.86.x", 99: "0.87.x+" };

function findHermesc(hbcVersion) {
  const p = join(repoRoot, "tools", "hermesc", `v${hbcVersion}`, "hermesc");
  if (!existsSync(p)) {
    console.error(`hermesc v${hbcVersion} not found at ${p} — run tools/get-hermesc.sh ${hbcVersion} first.`);
    process.exit(2);
  }
  return p;
}

function parsePkgSpec(spec) {
  // Handle scoped packages (@scope/name@version) — split on the *last* "@".
  const at = spec.lastIndexOf("@");
  if (at <= 0) {
    console.error(`expected <pkg>@<version>, got "${spec}"`);
    process.exit(2);
  }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

function main() {
  const argv = process.argv.slice(2);
  const pos = [];
  const opts = { hbc: "94", bundler: "react-native", out: join(__dirname, "db"), entryDir: "." };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") opts.project = argv[++i];
    else if (a === "--hbc") opts.hbc = argv[++i];
    else if (a === "--bundler") opts.bundler = argv[++i];
    else if (a === "--entry-dir") opts.entryDir = argv[++i];
    else if (a === "--hbc-file") opts.hbcFile = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--baseline") opts.baselineName = argv[++i];
    else if (a === "--subtract") opts.subtract = argv[++i];
    else pos.push(a);
  }
  const [pkgSpec] = pos;
  if (!pkgSpec) {
    console.error("usage: build-db.mjs <pkg>@<ver> --project <dir> [--hbc 94|96|98|99] [--bundler react-native|expo] [--hbc-file <path>] [--out tools/pkgsig/db] [--baseline <name>]");
    process.exit(2);
  }
  const { name: pkgName, version: pkgVersion } = parsePkgSpec(pkgSpec);
  const hbcVersion = Number(opts.hbc);
  const hermescPath = findHermesc(hbcVersion);

  let hbcPath;
  let cleanupDir = null;
  let projectMeta = { metroVersion: null, reactNativeVersion: null };

  if (opts.hbcFile) {
    hbcPath = opts.hbcFile;
  } else {
    if (!opts.project) {
      console.error("--project <dir> is required unless --hbc-file is given (see file header for why this script doesn't scaffold one itself).");
      process.exit(2);
    }
    const project = opts.project;
    const entryDir = join(project, opts.entryDir);
    const pkgDir = join(project, "node_modules", ...pkgName.split("/"));
    const installed = existsSync(join(pkgDir, "package.json")) ? readJson(join(pkgDir, "package.json")).version : null;
    if (installed !== pkgVersion) {
      console.log(`installing ${pkgName}@${pkgVersion} into ${project} (found ${installed ?? "nothing"})...`);
      execFileSync("npm", ["install", "--legacy-peer-deps", `${pkgName}@${pkgVersion}`], { cwd: project, stdio: "inherit" });
    }
    const entrySlug = pkgName.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    const entryFile = join(entryDir, `__pkgsig_entry_${entrySlug}__.js`);
    writeFileSync(entryFile, `const X = require(${JSON.stringify(pkgName)});\nmodule.exports = X;\n`);

    cleanupDir = mkdtempSync(join(tmpdir(), "pkgsig-build-"));
    const bundlePath = join(cleanupDir, "out.bundle");
    const assetsDir = join(cleanupDir, "assets");
    mkdirSync(assetsDir, { recursive: true });

    console.log(`bundling ${pkgName}@${pkgVersion} (${opts.bundler}, hbc${hbcVersion})...`);
    if (opts.bundler === "react-native") {
      execFileSync(
        "npx",
        [
          "react-native",
          "bundle",
          "--platform",
          "android",
          "--dev",
          "false",
          "--minify",
          "true",
          "--reset-cache",
          "--entry-file",
          relative(entryDir, entryFile) || `./${entrySlug}`,
          "--bundle-output",
          bundlePath,
          "--assets-dest",
          assetsDir,
        ],
        { cwd: entryDir, stdio: "inherit" }
      );
    } else {
      console.error(`--bundler ${opts.bundler} not implemented in this prototype (only "react-native" is automated end-to-end; expo-based projects were fingerprinted via a manual expo-export step for this task's HBC-98 measurement — see docs/PACKAGE-SIGNATURES.md §5).`);
      process.exit(2);
    }

    hbcPath = join(cleanupDir, "out.hbc");
    execFileSync(hermescPath, ["-O", "-emit-binary", `-out=${hbcPath}`, bundlePath], { stdio: "inherit" });

    const metroPkg = join(project, "node_modules", "metro", "package.json");
    const rnPkg = join(project, "node_modules", "react-native", "package.json");
    if (existsSync(metroPkg)) projectMeta.metroVersion = readJson(metroPkg).version;
    if (existsSync(rnPkg)) projectMeta.reactNativeVersion = readJson(rnPkg).version;
    projectMeta.packageSha256 = existsSync(pkgDir) ? hashPackageDir(pkgDir) : null;
  }

  const bytes = new Uint8Array(readFileSync(hbcPath));
  const mod = parseHbc(bytes);
  const { functions: rawFunctions, modules: rawModules } = fingerprintModule(mod, decodeFunction);

  // Baseline subtraction at DB-write time (docs/PACKAGE-SIGNATURES.md §5.1's
  // "layered foundations" — toolchain-empty, then react, then react-native):
  // any function whose exactHash is explained by a subtracted baseline is
  // dropped from the *stored* function list (kept in rawFunctionCount for
  // transparency) so a package that transitively pulls in react-native
  // (nearly every real-world RN package does) doesn't ship a second copy of
  // react-native's own ~4,000 functions in its own signature file — the
  // "keep each file small" requirement, and the reason match.mjs no longer
  // needs its own --baseline flag to avoid attribution noise (baselines are
  // subtracted once, here, not at every match). Foundational packages
  // (react, react-native themselves, and any explicit --baseline probe)
  // should not subtract themselves — callers building those pass no
  // --subtract.
  let subtractHashes = new Set();
  const subtractFiles = opts.subtract ? opts.subtract.split(",").filter(Boolean) : [];
  for (const f of subtractFiles) {
    const b = readJson(f);
    for (const fn of b.functions) subtractHashes.add(fn.exactHash);
  }
  const functions = subtractFiles.length > 0 ? rawFunctions.filter((f) => !subtractHashes.has(f.exactHash)) : rawFunctions;
  const modules = rawModules.map((m) => ({ ...m, factoryIsBaseline: subtractHashes.has(m.factoryExactHash) }));

  const db = {
    schema: 2,
    package: pkgName,
    version: pkgVersion,
    hbcVersion: mod.header.version,
    totalFunctions: functions.length,
    rawFunctionCount: rawFunctions.length,
    subtractedBaselines: subtractFiles.map((f) => relative(opts.out, f)),
    functions,
    modules,
    toolchainBaseline: Boolean(opts.baselineName),
    provenance: {
      packageSha256: projectMeta.packageSha256 ?? null,
      metroVersion: projectMeta.metroVersion ?? null,
      reactNativeVersion: projectMeta.reactNativeVersion ?? null,
      hermescVersion: hbcVersion,
      hermescRnEra: HBC_RN_HINT[hbcVersion] ?? null,
      repoCommit: gitCommit(),
      builtAt: new Date().toISOString(),
    },
  };

  const outDir = opts.baselineName ? join(opts.out, "_baselines") : opts.out;
  mkdirSync(outDir, { recursive: true });
  const safeName = opts.baselineName ?? pkgName.replace(/\//g, "__");
  const outPath = join(outDir, `${safeName}@${pkgVersion}__hbc${hbcVersion}.json`);
  writeFileSync(outPath, JSON.stringify(db));
  console.log(`${pkgName}@${pkgVersion} (hbc${hbcVersion}): ${functions.length} functions, ${modules.length} modules -> ${outPath}`);

  updateIndex(opts.out, { package: opts.baselineName ?? pkgName, version: pkgVersion, hbcVersion, path: relative(opts.out, outPath), totalFunctions: functions.length, isBaseline: Boolean(opts.baselineName) });

  if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
}

function updateIndex(dbDir, entry) {
  mkdirSync(dbDir, { recursive: true });
  const indexPath = join(dbDir, "index.json");
  let index = { schema: 1, entries: [] };
  if (existsSync(indexPath)) index = readJson(indexPath);
  index.entries = index.entries.filter((e) => !(e.package === entry.package && e.version === entry.version && e.hbcVersion === entry.hbcVersion));
  index.entries.push(entry);
  index.entries.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : a.hbcVersion - b.hbcVersion));
  writeFileSync(indexPath, JSON.stringify(index, null, 1));
}

main();
