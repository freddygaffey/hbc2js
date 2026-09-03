#!/usr/bin/env node
// tools/appgen/build.mjs — app-generation fuzzer, BUILD PIPELINE
// (docs/specs/09-fuzzing.md §2.2 "No Gradle: how a triple is built cheaply",
// §2.4 disk bounds). First increment: ONE pinned config —
//   RN 0.73.11 (HBC 96, docs/TOOLCHAIN.md's "96: react-native@0.73.11" row),
//   Metro plain bundler, react-navigation (stack/tabs per generate.mjs),
//   no obfuscation.
// The next increment adds the remaining build-config axes (Expo, Metro RAM,
// obfuscation, RN-version rotation to reach 94/98/99) — see this file's
// header comment and the task report for what's deliberately NOT here yet.
//
// Pipeline (no Gradle, no Android SDK, no emulator — spec §2.2):
//   generate app source -> npm ci -> `react-native bundle` (Metro, with
//   --sourcemap-output) -> project's OWN hermesc -emit-binary
//   -output-source-map -> compose-source-maps.js (Metro map + Hermes map)
//   -> extract triple {bundle.hbc, bundle.map, source/, config.json,
//   package-lock.json, hashes.json} to $HBC2JS_APPGEN_DIR, workspace deleted.
//
// Usage: node tools/appgen/build.mjs --seed <seed> [--keep-workspace]
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateApp } from "./generate.mjs";
import { fingerprint, isDuplicate, loadStore, saveStore } from "./lib/manifest.mjs";
import { preflightDiskCheck } from "./lib/disk.mjs";

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

function buildOne(seed, { keepWorkspace = false, manifestPath = MANIFEST_PATH } = {}) {
  preflightDiskCheck(ROOT); // spec §2.4: refuse to start if free disk < 15 GB

  const store = loadStore(manifestPath, { existsSync, readFileSync: (p) => readFileSync(p, "utf8") });
  const { manifest } = generateApp(seed);
  if (isDuplicate(store, manifest.fingerprint)) {
    return { skipped: true, reason: "duplicate fingerprint", fingerprint: manifest.fingerprint };
  }

  const workspace = mkdtempSync(join(tmpdir(), "hbc2js-appgen-"));
  try {
    const { files } = generateApp(seed);
    mkdirSync(workspace, { recursive: true });
    for (const [rel, content] of files) {
      const full = join(workspace, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
    writeFileSync(join(workspace, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

    sh("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], workspace);

    sh(
      join(workspace, "node_modules/.bin/react-native"),
      ["bundle", "--platform", "android", "--dev", "false", "--entry-file", "index.js",
       "--bundle-output", "bundle.js", "--sourcemap-output", "bundle.js.map"],
      workspace,
    );

    const hermesc = join(
      workspace, "node_modules/react-native/sdks/hermesc",
      platform() === "darwin" ? "osx-bin" : "linux64-bin", "hermesc",
    );
    sh(hermesc, ["-emit-binary", "-output-source-map", "-out", "bundle.hbc", "bundle.js"], workspace);
    sh(
      "node",
      [join(workspace, "node_modules/react-native/scripts/compose-source-maps.js"),
       "bundle.js.map", "bundle.hbc.map", "-o", "bundle.compose.map"],
      workspace,
    );

    const id = manifest.fingerprint.slice(0, 16);
    const destDir = join(appgenDir(), "triples", id);
    mkdirSync(destDir, { recursive: true });
    cpSync(join(workspace, "bundle.hbc"), join(destDir, "bundle.hbc"));
    cpSync(join(workspace, "bundle.compose.map"), join(destDir, "bundle.map"));
    mkdirSync(join(destDir, "source"), { recursive: true });
    copySourceTree(workspace, join(destDir, "source"));

    const config = {
      id,
      seed: manifest.seed,
      fingerprint: manifest.fingerprint,
      rnVersion: manifest.rnVersion,
      hbcVersion: 96, // docs/TOOLCHAIN.md: react-native@0.73.11 -> HBC 96
      bundler: "metro-plain",
      compiler: "project-hermesc",
      router: manifest.routerShape,
      depStyle: manifest.depStyle,
      screens: manifest.screens,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(destDir, "config.json"), JSON.stringify(config, null, 2) + "\n");
    if (existsSync(join(workspace, "package-lock.json"))) {
      cpSync(join(workspace, "package-lock.json"), join(destDir, "package-lock.json"));
    }
    const hashes = {
      "bundle.hbc": sha256File(join(destDir, "bundle.hbc")),
      "bundle.map": sha256File(join(destDir, "bundle.map")),
    };
    writeFileSync(join(destDir, "hashes.json"), JSON.stringify(hashes, null, 2) + "\n");

    const sizeBytes =
      statSync(join(destDir, "bundle.hbc")).size + statSync(join(destDir, "bundle.map")).size;

    const entry = {
      id,
      seed: manifest.seed,
      fingerprint: manifest.fingerprint,
      createdAt: config.createdAt,
      rnVersion: manifest.rnVersion,
      hbcVersion: config.hbcVersion,
      bundler: config.bundler,
      router: manifest.routerShape,
      depStyle: manifest.depStyle,
      screens: manifest.screens,
      sha256: hashes["bundle.hbc"],
      sizeBytes,
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
  const out = { keepWorkspace: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed") out.seed = argv[++i];
    else if (argv[i] === "--keep-workspace") out.keepWorkspace = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.seed === undefined) {
    console.error("usage: node tools/appgen/build.mjs --seed <seed> [--keep-workspace]");
    process.exit(2);
  }
  const result = buildOne(args.seed, { keepWorkspace: args.keepWorkspace });
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();

export { buildOne, appgenDir };
