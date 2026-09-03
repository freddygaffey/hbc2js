#!/usr/bin/env node
// tools/appgen/build.mjs — app-generation fuzzer, BUILD PIPELINE
// (docs/specs/09-fuzzing.md §2.2 "No Gradle: how a triple is built cheaply",
// §2.4 disk bounds). Increment 2 (this file) adds three build-config axes
// on top of increment 1's single pinned config:
//   - RN-version rotation (tools/appgen/lib/versions.mjs's RN_PINS table),
//     reaching HBC 98 via RN 0.86.0 alongside the existing HBC 96 pin.
//   - bundler: "metro-plain" (default) | "metro-ram" (`--indexed-ram-bundle`,
//     spec §2.1's Metro RAM value). NOTE: the Hermes indexed-RAM-bundle
//     output is not plain JS text, so feeding it to hermesc the same way as
//     a plain bundle may fail -- if so this is recorded as a build failure
//     (`config.json` `buildStatus: "failed"`), not silently worked around;
//     see docs/BUGS.md.
//   - obfuscation: off (default) | "metro-minify" (`--minify true`, Metro's
//     built-in terser-based minifier/mangler -- spec §2.1's "minified/
//     mangled (terser via Metro config)" value).
// Expo/libraries axes remain out of scope for this increment.
//
// Pipeline (no Gradle, no Android SDK, no emulator — spec §2.2):
//   generate app source -> npm install -> `react-native bundle` (Metro, with
//   --sourcemap-output, optionally --indexed-ram-bundle / --minify true) ->
//   project's OWN hermesc -emit-binary -output-source-map (or, marked
//   `compiler: "direct-hermesc"`, tools/hermesc/v98/hermesc as the spec §2.1
//   fallback) -> compose-source-maps.js (Metro map + Hermes map) -> extract
//   triple {bundle.hbc, bundle.map, source/, config.json,
//   package-lock.json, hashes.json} to $HBC2JS_APPGEN_DIR, workspace deleted.
//
// Usage: node tools/appgen/build.mjs --seed <seed> [--hbc 96|98]
//        [--bundler metro-plain|metro-ram] [--obfuscate] [--direct-hermesc]
//        [--keep-workspace]
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateApp } from "./generate.mjs";
import { fingerprint, isDuplicate, loadStore, saveStore } from "./lib/manifest.mjs";
import { preflightDiskCheck } from "./lib/disk.mjs";
import { RN_PINS, DEFAULT_RN_PIN, hermescPathForRn } from "./lib/versions.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST_PATH = join(ROOT, "tests/fixtures/appgen/manifest.json");
const TRIPLE_STORE_CAP = 24; // spec §2.4

function appgenDir() {
  return process.env.HBC2JS_APPGEN_DIR || join(homedir(), "hbc2js-appgen");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 * 64 }).toString();
}

/** Extract exactly what the triple needs (spec §2.2's list), skipping
 *  node_modules — the source tree we care about is what generate.mjs wrote,
 *  never the installed dependency code. */
function copySourceTree(workspace, destDir) {
  const files = [
    "package.json", "package-lock.json", "babel.config.js", "metro.config.js",
    "index.js", "App.js", "manifest.json",
  ];
  for (const f of files) {
    const src = join(workspace, f);
    if (existsSync(src)) cpSync(src, join(destDir, f));
  }
  cpSync(join(workspace, "src"), join(destDir, "src"), { recursive: true });
}

function evictIfOverCap(store) {
  const evictable = store.filter((e) => !e.heldOut && !e.evicted);
  while (store.filter((e) => !e.evicted).length > TRIPLE_STORE_CAP && evictable.length > 0) {
    const oldest = evictable.shift();
    oldest.evicted = true;
    const dir = join(appgenDir(), "triples", oldest.id);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

function osdir() {
  return platform() === "darwin" ? "osx-bin" : "linux64-bin";
}

function buildOne(seed, options = {}) {
  const {
    keepWorkspace = false,
    manifestPath = MANIFEST_PATH,
    rnPin = DEFAULT_RN_PIN, // tools/appgen/lib/versions.mjs's RN_PINS entry
    bundler = "metro-plain", // "metro-plain" | "metro-ram"
    obfuscate = false, // spec §2.1 "obfuscation" axis: off | metro-minify
    directHermesc = false, // force the spec §2.1 fallback compiler
  } = options;

  preflightDiskCheck(ROOT); // spec §2.4: refuse to start if free disk < 15 GB

  const store = loadStore(manifestPath, { existsSync, readFileSync: (p) => readFileSync(p, "utf8") });
  const { manifest } = generateApp(seed, { rnVersion: rnPin.rnVersion });
  if (isDuplicate(store, manifest.fingerprint)) {
    return { skipped: true, reason: "duplicate fingerprint", fingerprint: manifest.fingerprint };
  }

  const workspace = mkdtempSync(join(tmpdir(), "hbc2js-appgen-"));
  try {
    const { files } = generateApp(seed, { rnVersion: rnPin.rnVersion });
    mkdirSync(workspace, { recursive: true });
    for (const [rel, content] of files) {
      const full = join(workspace, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    writeFileSync(join(workspace, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], workspace);

    const bundleArgs = [
      "bundle", "--platform", "android", "--dev", "false", "--entry-file", "index.js",
      "--bundle-output", "bundle.js", "--sourcemap-output", "bundle.js.map",
    ];
    if (bundler === "metro-ram") bundleArgs.push("--indexed-ram-bundle");
    if (obfuscate) bundleArgs.push("--minify", "true");

    const compiler = directHermesc ? "direct-hermesc" : "project-hermesc";
    const hermesc = directHermesc
      ? join(ROOT, "tools/hermesc", `v${rnPin.hbcVersion}`, "hermesc")
      : hermescPathForRn(rnPin.rnVersion)(workspace, osdir());

    const id = manifest.fingerprint.slice(0, 16) + "-" + createHash("sha256")
      .update(`${bundler}:${obfuscate}:${rnPin.rnVersion}`).digest("hex").slice(0, 8);
    const destDir = join(appgenDir(), "triples", id);
    mkdirSync(destDir, { recursive: true });
    mkdirSync(join(destDir, "source"), { recursive: true });
    copySourceTree(workspace, join(destDir, "source"));

    // Any pipeline stage (Metro's own bundle CLI rejecting an axis's flag,
    // or hermesc rejecting Metro's output) can fail -- the whole stage is
    // one try/catch so a failure is a STORED, provenance-carrying finding
    // (config.json `buildStatus: "failed"`) rather than an uncaught crash
    // that leaves no record (spec §2.5(ii) "unbuildable" + task brief's Metro
    // RAM axis note: "the triple still gets stored for when it can be
    // consumed").
    let buildStatus = "ok";
    let buildError = null;
    try {
      sh(join(workspace, "node_modules/.bin/react-native"), bundleArgs, workspace);
      sh(hermesc, ["-emit-binary", "-output-source-map", "-out", "bundle.hbc", "bundle.js"], workspace);
      sh(
        "node",
        [join(workspace, "node_modules/react-native/scripts/compose-source-maps.js"),
         "bundle.js.map", "bundle.hbc.map", "-o", "bundle.compose.map"],
        workspace,
      );
      cpSync(join(workspace, "bundle.hbc"), join(destDir, "bundle.hbc"));
      cpSync(join(workspace, "bundle.compose.map"), join(destDir, "bundle.map"));
    } catch (err) {
      buildStatus = "failed";
      buildError = String(err.stderr || err.message || err).slice(0, 4000);
      if (existsSync(join(workspace, "bundle.js"))) cpSync(join(workspace, "bundle.js"), join(destDir, "bundle.js"));
      if (existsSync(join(workspace, "bundle.js.map"))) cpSync(join(workspace, "bundle.js.map"), join(destDir, "bundle.js.map"));
    }

    const config = {
      id,
      seed: manifest.seed,
      fingerprint: manifest.fingerprint,
      rnVersion: rnPin.rnVersion,
      hbcVersion: rnPin.hbcVersion,
      bundler,
      compiler,
      obfuscation: obfuscate ? "metro-minify" : "off",
      router: manifest.routerShape,
      depStyle: manifest.depStyle,
      screens: manifest.screens,
      createdAt: new Date().toISOString(),
      buildStatus,
      buildError,
    };
    writeFileSync(join(destDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
    if (existsSync(join(workspace, "package-lock.json"))) {
      cpSync(join(workspace, "package-lock.json"), join(destDir, "package-lock.json"));
    }

    const hashes = {};
    if (buildStatus === "ok") {
      hashes["bundle.hbc"] = sha256File(join(destDir, "bundle.hbc"));
      hashes["bundle.map"] = sha256File(join(destDir, "bundle.map"));
    }
    writeFileSync(join(destDir, "hashes.json"), JSON.stringify(hashes, null, 2) + "\n");

    const sizeBytes = buildStatus === "ok"
      ? statSync(join(destDir, "bundle.hbc")).size + statSync(join(destDir, "bundle.map")).size
      : 0;

    const entry = {
      id,
      seed: manifest.seed,
      fingerprint: manifest.fingerprint,
      createdAt: config.createdAt,
      rnVersion: rnPin.rnVersion,
      hbcVersion: config.hbcVersion,
      bundler: config.bundler,
      compiler: config.compiler,
      obfuscation: config.obfuscation,
      router: manifest.routerShape,
      depStyle: manifest.depStyle,
      screens: manifest.screens,
      sha256: hashes["bundle.hbc"] || null,
      sizeBytes,
      buildStatus,
      // "unbuildable" per spec §2.5(ii): a config that fails to build is
      // recorded with its error class and counts against the build-success
      // rate. This increment records it on first failure (single attempt);
      // a driver retry policy for "fails twice" lives at the campaign layer.
      errorClass: buildError ? buildError.split("\n")[0].slice(0, 200) : null,
      // Component C (spec §3.1): every 3rd triple by creation order is
      // held-out, decided mechanically at creation time from the store's
      // current length (before this push) -- never curated.
      heldOut: store.length % 3 === 2,
      evicted: false,
    };
    store.push(entry);
    evictIfOverCap(store);
    saveStore(manifestPath, { writeFileSync: (p, s) => writeFileSync(p, s) }, store);

    return { skipped: false, id, destDir, config, entry };
  } finally {
    if (!keepWorkspace) rmSync(workspace, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = { keepWorkspace: false, bundler: "metro-plain", obfuscate: false, directHermesc: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") out.seed = argv[++i];
    else if (argv[i] === "--hbc") out.hbc = Number(argv[++i]);
    else if (argv[i] === "--bundler") out.bundler = argv[++i];
    else if (argv[i] === "--obfuscate") out.obfuscate = true;
    else if (argv[i] === "--direct-hermesc") out.directHermesc = true;
    else if (argv[i] === "--keep-workspace") out.keepWorkspace = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.seed === undefined) {
    console.error(
      "usage: node tools/appgen/build.mjs --seed <seed> [--hbc 96|98] " +
      "[--bundler metro-plain|metro-ram] [--obfuscate] [--direct-hermesc] [--keep-workspace]",
    );
    process.exit(2);
  }
  const rnPin = args.hbc ? RN_PINS[args.hbc] : DEFAULT_RN_PIN;
  if (!rnPin) {
    console.error(`unknown --hbc ${args.hbc}; known pins: ${Object.keys(RN_PINS).join(", ")}`);
    process.exit(2);
  }
  const result = buildOne(args.seed, {
    keepWorkspace: args.keepWorkspace,
    rnPin,
    bundler: args.bundler,
    obfuscate: args.obfuscate,
    directHermesc: args.directHermesc,
  });
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();

export { buildOne, appgenDir };
