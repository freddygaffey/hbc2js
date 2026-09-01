#!/usr/bin/env node
// tools/pkgsig/bulk/candidates.mjs — D17c bulk signature build, round 2:
// builds candidates.json (same {name, versions[]} shape as packages.json,
// so continue-bulk.sh can reuse run.sh's own build_job_list x {94,96,98,99}
// expansion and build-one.mjs's existing alreadyBuilt() skip-if-present
// check unchanged) from four sources:
//
//   (a) every package+version in this repo's own truth fixtures
//       (tests/fixtures/bundles/**/deps-truth.json's "packages" map —
//       version strings only, `null` entries are unknown and skipped)
//   (b) a Service NSW `hbc2js deps --json` report (--nsw-json <path>):
//       hintedDeps + guessedDeps (both carry package+version already), plus
//       a best-effort scan of unattributedModules[].topStrings for
//       node_modules-path / require() literals, cross-referenced against
//       the static ecosystem list below for a version (a name found only
//       in bundle strings, with no matching curated version, is logged as
//       unresolved rather than guessed at)
//   (c) react-native 0.73.0-0.76.x, every patch — a static range from this
//       script's own author's knowledge of the real release history, NOT
//       scraped at runtime
//   (d) a static, hand-written RN-ecosystem package list (no scraping) —
//       fewer than the round-1-shaped "top 300 by weekly downloads" this
//       task named, because pinning exact current versions by hand for 300
//       packages without network access to npm is not reliably accurate;
//       this is a curated ~150-package set spanning the categories that
//       actually show up in RN bundles (navigation, state, forms, http,
//       animation, media, expo modules, ...). Extending it further is a
//       cheap, mechanical follow-up once round 2 has run once.
//
// Every (name, version) pair already present in the round-1 signature
// index (fetched from deb: ~/hbc2js-bulk/dist/index-partial-20260830.json,
// the union across every HBC version — round-1's *fullest* index, not the
// filtered/fixed subset, since "already attempted" is what matters here,
// not "already usable") is subtracted before writing candidates.json.
//
// Usage:
//   node tools/pkgsig/bulk/candidates.mjs [--nsw-json <path>]
//     [--round1-index <path>] [--out <path>] [--no-fetch-index]
//
// --round1-index lets you pass an already-fetched copy (e.g. scp'd by
// hand) instead of shelling out to `ssh deb cat ...` here. --no-fetch-index
// skips round-1 dedup entirely (candidates.json will then contain
// already-built pairs too — only useful for inspecting source counts).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function parseArgs(argv) {
  const out = { nswJson: null, round1Index: null, out: join(dirname(fileURLToPath(import.meta.url)), "candidates.json"), fetchIndex: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nsw-json") out.nswJson = argv[++i];
    else if (a === "--round1-index") out.round1Index = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--no-fetch-index") out.fetchIndex = false;
  }
  return out;
}

function findTruthFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e === "deps-truth.json") found.push(p);
    }
  };
  walk(root);
  return found;
}

function addPair(map, name, version, reason) {
  if (!name || !version) return false;
  if (!map.has(name)) map.set(name, { versions: new Set(), reasons: new Set() });
  const entry = map.get(name);
  const before = entry.versions.size;
  entry.versions.add(version);
  entry.reasons.add(reason);
  return entry.versions.size > before;
}

// --- (a) repo truth fixtures ----------------------------------------------
function collectTruth(map) {
  let count = 0;
  for (const f of findTruthFiles(join(REPO_ROOT, "tests", "fixtures", "bundles"))) {
    let data;
    try {
      data = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    const packages = data.packages || {};
    for (const [name, version] of Object.entries(packages)) {
      if (typeof version === "string" && version.length > 0) {
        if (addPair(map, name, version, "truth-fixture")) count++;
      }
    }
  }
  return count;
}

// --- (c) react-native 0.73.0-0.76.x, every patch --------------------------
// Static, from this script's author's own knowledge of the RN release
// history at write time — not scraped at runtime.
const RN_PATCH_RANGES = { 73: 11, 74: 7, 75: 5, 76: 9 };
function collectRnPatches(map) {
  let count = 0;
  for (const [minor, maxPatch] of Object.entries(RN_PATCH_RANGES)) {
    for (let patch = 0; patch <= maxPatch; patch++) {
      if (addPair(map, "react-native", `0.${minor}.${patch}`, "rn-patch-range")) count++;
    }
  }
  return count;
}

// --- (d) static RN-ecosystem package list (no scraping) -------------------
// Curated, hand-written. Versions are this script author's best-effort
// recollection of a recent-ish real release for each package, not a live
// npm lookup — a wrong pin just fails that one `npm install` job (a
// tolerated, retryable failure class per docs/PACKAGE-SIGNATURES.md §6.2),
// it never corrupts the DB.
const ECOSYSTEM_PACKAGES = [
  ["react", "18.2.0"], ["react", "18.3.1"], ["react-dom", "18.3.1"],
  ["@react-navigation/native", "6.1.18"], ["@react-navigation/stack", "6.4.1"],
  ["@react-navigation/bottom-tabs", "6.6.1"], ["@react-navigation/drawer", "6.7.2"],
  ["@react-navigation/native-stack", "6.11.0"], ["@react-navigation/elements", "1.3.31"],
  ["@react-navigation/routers", "6.1.9"], ["@react-navigation/core", "6.4.17"],
  ["react-native-reanimated", "3.16.1"], ["react-native-reanimated", "3.6.2"],
  ["react-native-gesture-handler", "2.20.2"], ["react-native-gesture-handler", "2.14.1"],
  ["react-native-screens", "3.34.0"], ["react-native-screens", "3.29.0"],
  ["react-native-svg", "15.8.0"], ["react-native-svg", "13.14.0"],
  ["react-native-vector-icons", "10.2.0"], ["react-native-safe-area-context", "4.14.0"],
  ["react-native-safe-area-context", "4.10.1"], ["react-native-webview", "13.12.5"],
  ["react-native-webview", "13.8.6"], ["react-native-maps", "1.18.0"],
  ["react-native-pager-view", "6.4.1"], ["react-native-tab-view", "3.5.2"],
  ["@react-native-async-storage/async-storage", "1.24.0"],
  ["@react-native-async-storage/async-storage", "1.23.1"],
  ["@react-native-community/netinfo", "11.4.1"], ["@react-native-community/netinfo", "9.5.0"],
  ["react-native-mmkv", "3.1.0"], ["react-native-sqlite-storage", "6.0.1"],
  ["react-native-fast-image", "8.6.3"], ["react-native-image-picker", "7.2.2"],
  ["react-native-video", "6.7.0"], ["react-native-camera", "4.2.1"],
  ["react-native-permissions", "4.1.5"], ["react-native-device-info", "13.2.0"],
  ["react-native-keychain", "8.2.0"], ["react-native-config", "1.5.3"],
  ["react-native-dotenv", "3.4.11"], ["react-native-push-notification", "8.1.1"],
  ["@notifee/react-native", "9.1.2"], ["@react-native-firebase/app", "20.5.0"],
  ["@react-native-firebase/messaging", "20.5.0"], ["@react-native-firebase/analytics", "20.5.0"],
  ["@react-native-clipboard/clipboard", "1.14.1"], ["react-native-share", "11.0.3"],
  ["react-native-linear-gradient", "2.8.3"], ["lottie-react-native", "6.7.2"],
  ["react-native-animatable", "1.4.0"], ["react-native-paper", "5.12.5"],
  ["native-base", "3.4.28"], ["@rneui/base", "4.0.0-rc.8"], ["@rneui/themed", "4.0.0-rc.8"],
  ["nativewind", "4.1.23"], ["tamagui", "1.116.7"], ["styled-components", "6.1.13"],
  ["@shopify/restyle", "2.4.4"], ["redux", "5.0.1"], ["react-redux", "9.1.2"],
  ["@reduxjs/toolkit", "2.3.0"], ["redux-thunk", "3.1.0"], ["redux-saga", "1.3.0"],
  ["mobx", "6.13.5"], ["mobx-react", "9.2.0"], ["mobx-react-lite", "4.0.7"],
  ["zustand", "4.5.5"], ["zustand", "5.0.1"], ["recoil", "0.7.7"], ["jotai", "2.10.1"],
  ["valtio", "2.1.2"], ["easy-peasy", "6.0.5"], ["formik", "2.4.6"], ["yup", "1.4.0"],
  ["react-hook-form", "7.53.1"], ["zod", "3.23.8"], ["joi", "17.13.3"],
  ["axios", "1.7.9"], ["@apollo/client", "3.11.10"], ["graphql", "16.9.0"],
  ["urql", "4.2.0"], ["@tanstack/react-query", "5.59.16"], ["@tanstack/query-core", "5.59.16"],
  ["swr", "2.2.5"], ["lodash", "4.17.21"], ["ramda", "0.30.1"], ["moment", "2.30.1"],
  ["dayjs", "1.11.13"], ["date-fns", "4.1.0"], ["uuid", "10.0.0"], ["classnames", "2.5.1"],
  ["immer", "10.1.1"], ["rxjs", "7.8.1"], ["socket.io-client", "4.8.1"], ["ws", "8.18.0"],
  ["@sentry/react-native", "5.35.0"], ["@amplitude/react-native", "2.17.0"],
  ["@segment/analytics-react-native", "2.20.2"], ["react-native-mixpanel", "2.0.0"],
  ["i18next", "23.16.0"], ["react-i18next", "15.1.0"], ["react-native-localize", "3.2.1"],
  ["prop-types", "15.8.1"], ["invariant", "2.2.4"], ["warning", "4.0.3"],
  ["shallowequal", "1.1.0"], ["fbjs", "3.0.5"], ["scheduler", "0.24.0"],
  ["use-sync-external-store", "1.2.2"], ["hoist-non-react-statics", "3.3.2"],
  ["expo", "51.0.28"], ["expo", "52.0.11"], ["expo-constants", "17.0.3"],
  ["expo-font", "13.0.1"], ["expo-splash-screen", "0.29.13"], ["expo-status-bar", "2.0.0"],
  ["expo-linking", "7.0.3"], ["expo-updates", "0.26.10"], ["expo-file-system", "18.0.4"],
  ["expo-image-picker", "16.0.3"], ["expo-location", "18.0.3"], ["expo-notifications", "0.29.11"],
  ["expo-secure-store", "14.0.0"], ["expo-modules-core", "2.1.2"], ["expo-asset", "11.0.1"],
  ["expo-blur", "14.0.1"], ["expo-image", "2.0.0"], ["expo-av", "15.0.1"],
  ["semver", "7.6.3"], ["nanoid", "5.0.7"], ["query-string", "9.1.1"],
  ["fast-deep-equal", "3.1.3"], ["escape-string-regexp", "5.0.0"], ["react-freeze", "1.0.4"],
  ["react-native-tab-view", "4.0.5"], ["@react-native-vector-icons/common", "12.0.0"],
  ["react-is", "18.3.1"], ["memoize-one", "6.0.0"], ["nullthrows", "1.1.1"],
  ["stacktrace-parser", "0.1.10"], ["promise", "8.3.0"], ["regenerator-runtime", "0.14.1"],
  ["event-target-shim", "6.0.2"], ["base64-js", "1.5.1"], ["whatwg-fetch", "3.6.20"],
  ["abort-controller", "3.0.0"], ["flow-enums-runtime", "0.0.6"],
];

function collectEcosystem(map) {
  let count = 0;
  for (const [name, version] of ECOSYSTEM_PACKAGES) {
    if (addPair(map, name, version, "ecosystem-static")) count++;
  }
  return count;
}

// --- (b) Service NSW deps --json ------------------------------------------
function ecosystemVersionFor(name) {
  const hit = ECOSYSTEM_PACKAGES.find((p) => p[0] === name);
  return hit ? hit[1] : null;
}

function collectNsw(map, nswJsonPath) {
  if (!nswJsonPath) return { count: 0, unresolved: 0 };
  if (!existsSync(nswJsonPath)) {
    console.error(`--nsw-json ${nswJsonPath} not found; skipping source (b)`);
    return { count: 0, unresolved: 0 };
  }
  const report = JSON.parse(readFileSync(nswJsonPath, "utf8"));
  let count = 0;
  for (const dep of [...(report.hintedDeps || []), ...(report.guessedDeps || [])]) {
    if (dep && dep.package && dep.version) {
      if (addPair(map, dep.package, dep.version, "nsw-deps-json")) count++;
    }
  }
  // Best-effort: scan unattributed modules' top strings for
  // node_modules-path / require() literals, cross-referenced against the
  // static ecosystem list above for a usable version.
  const nameRe = /node_modules\/((?:@[\w.-]+\/)?[\w.-]+)\//;
  const requireRe = /require\((['"])((?:@[\w.-]+\/)?[\w.-]+)\1/;
  const foundNames = new Set();
  for (const mod of report.unattributedModules || []) {
    for (const s of mod.topStrings || []) {
      const m1 = nameRe.exec(s);
      if (m1) foundNames.add(m1[1]);
      const m2 = requireRe.exec(s);
      if (m2) foundNames.add(m2[2]);
    }
  }
  let unresolved = 0;
  for (const name of foundNames) {
    const version = ecosystemVersionFor(name);
    if (version) {
      if (addPair(map, name, version, "nsw-string-evidence")) count++;
    } else {
      unresolved++;
    }
  }
  return { count, unresolved };
}

// --- (d minus) round-1 index -----------------------------------------------
function fetchRound1Index(opts) {
  if (opts.round1Index) {
    return JSON.parse(readFileSync(opts.round1Index, "utf8"));
  }
  if (!opts.fetchIndex) return null;
  const remote = "deb:~/hbc2js-bulk/dist/index-partial-20260830.json";
  console.error(`fetching round-1 index from ${remote} ...`);
  const json = execSync(`ssh deb cat ~/hbc2js-bulk/dist/index-partial-20260830.json`, {
    maxBuffer: 1024 * 1024 * 256,
  }).toString("utf8");
  return JSON.parse(json);
}

function round1Pairs(index) {
  const pairs = new Set();
  if (!index || !index.packages) return pairs;
  for (const [name, versions] of Object.entries(index.packages)) {
    for (const version of Object.keys(versions)) {
      pairs.add(`${name}@${version}`);
    }
  }
  return pairs;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const map = new Map();

  const truthCount = collectTruth(map);
  const rnCount = collectRnPatches(map);
  const ecoCount = collectEcosystem(map);
  const nswResult = collectNsw(map, opts.nswJson);

  const totalBeforeDedup = [...map.values()].reduce((acc, e) => acc + e.versions.size, 0);

  const index = fetchRound1Index(opts);
  const already = round1Pairs(index);

  let excluded = 0;
  const packages = [];
  for (const [name, entry] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const versions = [...entry.versions].filter((v) => {
      const already1 = already.has(`${name}@${v}`);
      if (already1) excluded++;
      return !already1;
    });
    if (versions.length > 0) {
      packages.push({ name, versions: versions.sort(), reasons: [...entry.reasons].sort() });
    }
  }

  const totalAfterDedup = packages.reduce((acc, p) => acc + p.versions.length, 0);

  const out = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    description: "D17c bulk signature build round 2 candidates - see tools/pkgsig/bulk/candidates.mjs header.",
    sourceCounts: {
      truthFixturePairs: truthCount,
      rnPatchRangePairs: rnCount,
      ecosystemStaticPairs: ecoCount,
      nswDepsJsonPairs: nswResult.count,
      nswUnresolvedStringNames: nswResult.unresolved,
    },
    totalBeforeDedup,
    excludedAlreadyInRound1: excluded,
    packageCount: packages.length,
    totalVersionSelections: totalAfterDedup,
    packages,
  };

  writeFileSync(opts.out, JSON.stringify(out, null, 1));

  console.log(`sources: truth-fixture=${truthCount} rn-patch-range=${rnCount} ecosystem-static=${ecoCount} nsw-deps-json=${nswResult.count} (unresolved string names=${nswResult.unresolved})`);
  console.log(`total pairs before dedup=${totalBeforeDedup}, already in round-1 index=${excluded}, after dedup=${totalAfterDedup} across ${packages.length} packages`);
  console.log(`wrote ${opts.out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
