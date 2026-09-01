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
//
// Round 2b adds a second mode, --registry, run ON deb (needs network) -
// see the "registry mode" section below for what it does. Usage:
//   node tools/pkgsig/bulk/candidates.mjs --registry [--top 3000]
//     [--concurrency 8] [--months 24] [--cache <path>] [--index-dir <path>]
//     [--out <path>]
// Defaults write outside the repo checkout (~/hbc2js-bulk/), since the
// output is thousands of packages - too big to commit (see docs/DEPS.md
// "Round 2b" and this repo's CLAUDE.md on not committing corpus/DB data).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function parseArgs(argv) {
  const out = {
    nswJson: null,
    round1Index: null,
    out: join(dirname(fileURLToPath(import.meta.url)), "candidates.json"),
    fetchIndex: true,
    // --registry mode (round 2b): build the candidate list from the live
    // npm registry instead of the static lists above.
    registry: false,
    top: 3000,
    concurrency: 8,
    months: 24,
    cache: join(homedir(), "hbc2js-bulk", "registry-cache.json"),
    indexDir: join(homedir(), "hbc2js-bulk", "dist"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nsw-json") out.nswJson = argv[++i];
    else if (a === "--round1-index") out.round1Index = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--no-fetch-index") out.fetchIndex = false;
    else if (a === "--registry") out.registry = true;
    else if (a === "--top") out.top = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--months") out.months = Number(argv[++i]);
    else if (a === "--cache") out.cache = argv[++i];
    else if (a === "--index-dir") out.indexDir = argv[++i];
  }
  if (out.registry && out.out === join(dirname(fileURLToPath(import.meta.url)), "candidates.json")) {
    // Registry-mode output is thousands of packages - default it outside
    // the repo checkout (never committed; see this script's header) unless
    // the caller passes --out explicitly.
    out.out = join(homedir(), "hbc2js-bulk", "candidates-registry.json");
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

// --- registry mode (round 2b): build candidates FROM the npm registry -----
//
// Run ON deb (network required). Three sources feed the same candidate
// name set, unioned:
//   - registry search `text=keywords:react-native`, paginated
//   - registry search `text=keywords:expo`, paginated
//   - registry search `text=react-native-` (name-prefix match), paginated
// Every found name is ranked by last-month download count
// (api.npmjs.org's batch point endpoint for unscoped names, one request
// per scoped name since the batch endpoint doesn't accept `@scope/name`).
// The top `--top` (default 3000) names are kept; for each, the registry
// doc's own `time` field gives every version's publish date - versions
// published within the last `--months` (default 24) are candidates.
// Politeness: concurrency capped at `--concurrency` (default 8), 429/5xx
// retried with exponential backoff + jitter, and every search page /
// downloads batch / package doc fetched is cached to `--cache` (default
// ~/hbc2js-bulk/registry-cache.json) so a re-run (e.g. widening --top)
// doesn't re-fetch what it already has.

function loadCache(path) {
  if (!existsSync(path)) return { search: {}, downloads: {}, packageDocs: {} };
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { search: data.search || {}, downloads: data.downloads || {}, packageDocs: data.packageDocs || {} };
  } catch {
    return { search: {}, downloads: {}, packageDocs: {} };
  }
}

function saveCache(path, cache) {
  writeFileSync(path, JSON.stringify(cache));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpGetJson(url, { retries = 5 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": "hbc2js-bulk-sigdb/round2b" } });
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(500 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === retries) throw new Error(`${url} -> HTTP ${res.status} (out of retries)`);
      await sleep(800 * 2 ** attempt + Math.random() * 500);
      continue;
    }
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${url} -> unreachable`);
}

// Small async pool - runs `fn` over `items` with at most `concurrency`
// in flight at once.
async function pMap(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function searchRegistryQuery(text, cache, cachePath, sourceTag, names) {
  const PAGE = 250;
  let from = 0;
  let total = Infinity;
  while (from < total && from < 5000) {
    const key = `${text}::${from}`;
    let page = cache.search[key];
    if (!page) {
      const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${PAGE}&from=${from}`;
      const json = await httpGetJson(url);
      page = { total: json.total, names: (json.objects || []).map((o) => o.package.name) };
      cache.search[key] = page;
      saveCache(cachePath, cache);
    }
    total = page.total;
    for (const n of page.names) {
      if (!names.has(n)) names.set(n, new Set());
      names.get(n).add(sourceTag);
    }
    if (page.names.length === 0) break;
    from += PAGE;
  }
}

async function collectRegistryNames(cache, cachePath) {
  const names = new Map(); // name -> Set(sourceTag)
  await searchRegistryQuery("keywords:react-native", cache, cachePath, "search-keyword-react-native", names);
  await searchRegistryQuery("keywords:expo", cache, cachePath, "search-keyword-expo", names);
  await searchRegistryQuery("react-native-", cache, cachePath, "search-name-react-native-", names);
  return names;
}

async function fetchDownloadsBatch(unscopedNames, cache, cachePath, concurrency) {
  // api.npmjs.org's bulk endpoint accepts up to 128 comma-separated
  // unscoped names per request.
  const BATCH = 120;
  const missing = unscopedNames.filter((n) => !(n in cache.downloads));
  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
  await pMap(batches, concurrency, async (batch) => {
    const url = `https://api.npmjs.org/downloads/point/last-month/${batch.map(encodeURIComponent).join(",")}`;
    let json;
    try {
      json = await httpGetJson(url);
    } catch {
      for (const n of batch) cache.downloads[n] = 0;
      saveCache(cachePath, cache);
      return;
    }
    // Single-name responses come back as {downloads, package}; multi-name
    // as {name: {downloads, package}, ...} (unresolved names are absent).
    if (typeof json.downloads === "number" && batch.length === 1) {
      cache.downloads[batch[0]] = json.downloads;
    } else {
      for (const n of batch) cache.downloads[n] = json[n]?.downloads ?? 0;
    }
    saveCache(cachePath, cache);
  });
}

async function fetchDownloadsScoped(scopedNames, cache, cachePath, concurrency) {
  const missing = scopedNames.filter((n) => !(n in cache.downloads));
  await pMap(missing, concurrency, async (n) => {
    const url = `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(n)}`;
    try {
      const json = await httpGetJson(url);
      cache.downloads[n] = json.downloads ?? 0;
    } catch {
      cache.downloads[n] = 0;
    }
    saveCache(cachePath, cache);
  });
}

async function rankByDownloads(names, cache, cachePath, concurrency) {
  const all = [...names.keys()];
  const unscoped = all.filter((n) => !n.startsWith("@"));
  const scoped = all.filter((n) => n.startsWith("@"));
  await fetchDownloadsBatch(unscoped, cache, cachePath, concurrency);
  await fetchDownloadsScoped(scoped, cache, cachePath, concurrency);
  return all.sort((a, b) => (cache.downloads[b] || 0) - (cache.downloads[a] || 0));
}

async function fetchPackageVersionsInWindow(name, cache, cachePath, months) {
  let doc = cache.packageDocs[name];
  if (!doc) {
    const url = `https://registry.npmjs.org/${name.startsWith("@") ? name.replace("/", "%2F") : name}`;
    try {
      const json = await httpGetJson(url);
      doc = { time: json.time || {} };
    } catch (e) {
      doc = { time: {}, error: String(e) };
    }
    cache.packageDocs[name] = doc;
    saveCache(cachePath, cache);
  }
  const cutoff = Date.now() - months * 30 * 24 * 60 * 60 * 1000;
  const out = [];
  for (const [version, iso] of Object.entries(doc.time || {})) {
    if (version === "created" || version === "modified") continue;
    const t = Date.parse(iso);
    if (!Number.isNaN(t) && t >= cutoff) out.push(version);
  }
  return out;
}

function loadIndexDirPairs(dir) {
  const pairs = new Set();
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("index-") && f.endsWith(".json"));
  } catch {
    return pairs;
  }
  for (const f of files) {
    let index;
    try {
      index = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    for (const p of round1Pairs(index)) pairs.add(p);
  }
  return pairs;
}

async function runRegistryMode(opts) {
  const cache = loadCache(opts.cache);
  console.error(`registry mode: searching (cache=${opts.cache}) ...`);
  const names = await collectRegistryNames(cache, opts.cache);
  console.error(`registry search found ${names.size} distinct package names; ranking by last-month downloads (concurrency=${opts.concurrency}) ...`);
  const ranked = await rankByDownloads(names, cache, opts.cache, opts.concurrency);
  const top = ranked.slice(0, opts.top);
  console.error(`ranked ${ranked.length}, keeping top ${top.length}; fetching per-package version history (window=${opts.months}mo) ...`);

  const map = new Map();
  let versionsBeforeDedup = 0;
  await pMap(top, opts.concurrency, async (name) => {
    const versions = await fetchPackageVersionsInWindow(name, cache, opts.cache, opts.months);
    for (const v of versions) {
      addPair(map, name, v, "registry-search");
      versionsBeforeDedup++;
    }
  });

  const already = loadIndexDirPairs(opts.indexDir);
  let excluded = 0;
  const packages = [];
  for (const [name, entry] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const versions = [...entry.versions].filter((v) => {
      const hit = already.has(`${name}@${v}`);
      if (hit) excluded++;
      return !hit;
    });
    if (versions.length > 0) packages.push({ name, versions: versions.sort(), reasons: [...entry.reasons].sort() });
  }
  const totalAfterDedup = packages.reduce((acc, p) => acc + p.versions.length, 0);

  const out = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    description: "D17c bulk signature build round 2b registry candidates - see tools/pkgsig/bulk/candidates.mjs header (--registry mode).",
    sourceCounts: {
      registryNamesFound: names.size,
      rankedKeptTop: top.length,
      versionsBeforeDedup,
    },
    excludedAlreadyInIndex: excluded,
    packageCount: packages.length,
    totalVersionSelections: totalAfterDedup,
    packages,
  };
  writeFileSync(opts.out, JSON.stringify(out, null, 1));
  console.log(`registry: names found=${names.size}, ranked+kept top=${top.length}, versions before dedup=${versionsBeforeDedup}, excluded already-in-index=${excluded}, after dedup=${totalAfterDedup} across ${packages.length} packages`);
  console.log(`wrote ${opts.out}`);
}

// --- (d minus) round-1 index -----------------------------------------------
function fetchRound1Index(opts) {
  if (opts.round1Index) {
    return JSON.parse(readFileSync(opts.round1Index, "utf8"));
  }
  if (!opts.fetchIndex) return null;
  const remote = "deb:~/hbc2js-bulk/dist/index-partial-20260830.json";
  console.error(`fetching round-1 index from ${remote} ...`);
  const json = execSync(`ssh deb 'cat ~/hbc2js-bulk/dist/index-partial-20260830.json'`, {
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

  if (opts.registry) {
    await runRegistryMode(opts);
    return;
  }

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
