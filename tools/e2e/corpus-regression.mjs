#!/usr/bin/env node
// tools/e2e/corpus-regression.mjs — CORPUS-WIDE end-to-end regression
// harness (Fred, 2026-09-02): "run much more end-to-end testing on almost
// all the binaries we have saved, checking changes aren't making anything
// else worse." Formalises an overseer one-off sweep that caught a real
// local-maximum: screen-naming heuristics tuned on au.gov.nsw.service
// produced garbage screen names (CSS/SVG/library tokens, ALL_CAPS
// constants) on com.brex.mobile and com.uniswap.mobile — plausible-looking
// improvements on the app being iterated on, silent regressions elsewhere.
//
// Pipeline scored per app, same shape as tools/app-metrics.mjs and
// tools/e2e/oss-benchmark.mjs but across the WHOLE proprietary local
// corpus and WITHOUT ground truth: decompile -> --split -> segregate (no
// `deps` -- brief: "no deps for speed"; segregate falls back to call/config
// shape alone for naming, see src/split/segregate.ts's `--deps-report`
// note). Unlike oss-benchmark.mjs this never compares to a real app's
// source tree -- there isn't one for these apps -- so instead of
// precision/recall it runs OVERFIT / LOCAL-MAXIMUM DETECTORS: heuristics
// that flag suspicious output with no ground truth at all (see
// `screenPlausibility` below).
//
// Corpus layout: ~/hbc2js-local-corpus/apks/<app-id>.apk (override with
// $HBC2JS_CORPUS_DIR). NEVER read into a git-tracked path, NEVER logged
// verbatim -- this script prints/writes metrics and generic tokens only.
// See docs/e2e/CORPUS-REGRESSION.md.
//
//   node tools/e2e/corpus-regression.mjs [--only app1,app2] [--on-deb]
//        [--corpus-dir DIR] [--json] [--out FILE]
//
// Robust to per-app failure by design (SCOPE GUARD, same convention as
// tools/app-metrics.mjs): a decompile crash, a missing bundle, or a
// segregate throw is captured as that app's own status, never thrown out
// of the sweep loop. Only a bug in this script itself should ever make the
// process exit nonzero without a per-app report to show for it.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, extname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { fileURLToPath } from "node:url";
import { splitProject } from "../../src/split/index.ts";
import { segregateSplitTree } from "../../src/split/segregate.ts";
import { Hbc2jsError } from "../../src/errors.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Config list (brief: "for each corpus app (config list; --only <app>)").
 *  App id == the APK's basename without `.apk` == its corpus filename. Not
 *  every id below need be present on disk -- a missing APK is reported as
 *  "no bundle found" (or skipped from the config's own coverage), never a
 *  crash. This is the FULL known corpus (28 apps, 2026-08-30 snapshot);
 *  `--only` restricts to a subset for a fast local run. Diversity note for
 *  future readers picking a small `--only` set: au.gov.nsw.service (the app
 *  screen-naming was tuned on), com.brex.mobile / com.uniswap.mobile (where
 *  the tuning leaked false positives), au.gov.vic.myvicroads (no bundle at
 *  the conventional path -- exercises the "no bundle found" path), and
 *  app.phantom (a known decompile crash, E_INTERNAL/CFG-05 class) are the
 *  five worth keeping in any reduced set. */
export const CORPUS_APPS = [
  "au.gov.nsw.service",
  "au.gov.vic.myvicroads",
  "app.phantom",
  "com.adidas.app",
  "com.baronapp.cameo",
  "com.bloomberg.android.plus",
  "com.brex.mobile",
  "com.discord",
  "com.facebook.katana",
  "com.flipkart.android",
  "com.microsoft.office.officehubrow",
  "com.microsoft.teams",
  "com.microsoft.xboxone.smartglass",
  "com.myklarnamobile",
  "com.oculus.twilight",
  "com.pinterest",
  "com.scee.psxandroid",
  "com.shopify.arrive",
  "com.shopify.mobile",
  "com.shopify.ping",
  "com.teslamotors.tesla",
  "com.uniswap.mobile",
  "com.wix.android",
  "host.exp.exponent",
  "io.metamask",
  "me.rainbow",
  "org.toshi",
  "xyz.blueskyweb.app",
];

/** Conventional bundle asset paths inside an RN APK, tried in order.
 *  au.gov.vic.myvicroads is the known example with no bundle at the first
 *  (most common) path -- brief: "handle a missing/alternate path
 *  gracefully". `*` entries are resolved against the zip's own file list. */
const CANDIDATE_ASSET_PATHS = ["assets/index.android.bundle", "assets/index.bundle", "assets/app.bundle", "assets/main.jsbundle"];

function defaultCorpusDir() {
  return process.env["HBC2JS_CORPUS_DIR"] ?? join(homedir(), "hbc2js-local-corpus", "apks");
}

/** Finds a bundle entry inside the APK zip: tries the conventional paths
 *  first, then falls back to any `assets/**` entry that looks like a
 *  Hermes/Metro bundle by name (`*.bundle`, `*.hbc`, or a large `main*`
 *  candidate). Returns the in-zip path, or null ("no bundle found"). */
function findBundleEntry(apkPath) {
  const listing = spawnSync("unzip", ["-Z1", apkPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (listing.status !== 0) return null;
  const entries = listing.stdout.split("\n").filter((l) => l.length > 0);
  for (const cand of CANDIDATE_ASSET_PATHS) {
    if (entries.includes(cand)) return cand;
  }
  const fallback = entries.find((e) => /^assets\/.*\.(bundle|hbc)$/i.test(e)) ?? entries.find((e) => /^assets\/.*bundle/i.test(e));
  return fallback ?? null;
}

/** Extracts one APK's bundle to a fresh temp dir and returns its local
 *  path, or null if no bundle entry was found ("no bundle found" per app,
 *  brief requirement). Caller owns cleanup of the returned dir. */
function extractBundle(apkPath, appName) {
  const entry = findBundleEntry(apkPath);
  if (entry === null) return { dir: null, path: null, entry: null };
  const dir = mkdtempSync(join(tmpdir(), `hbc2js-corpus-${appName}-`));
  const r = spawnSync("unzip", ["-o", "-q", "-j", apkPath, entry, "-d", dir], { encoding: "utf8" });
  if (r.status !== 0) return { dir, path: null, entry };
  const extracted = join(dir, basename(entry));
  return { dir, path: existsSync(extracted) ? extracted : null, entry };
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function per1k(text, lineCount, pattern) {
  const n = (text.match(pattern) ?? []).length;
  return { count: n, per1kLines: lineCount === 0 ? 0 : (n / lineCount) * 1000 };
}

function pct(n, total) {
  return total === 0 ? 0 : (n / total) * 100;
}

/** In-process syntax check (no subprocess per module -- a corpus app can
 *  have thousands of split modules, and `node --check` per file the way
 *  tools/decompile.ts's `nodeCheck` does for one whole-bundle output would
 *  dominate wall time here). `vm.Script` parses without executing, same
 *  guarantee `node --check` gives (SyntaxError on invalid source), cheaply
 *  enough to run over every module in the corpus. */
function isValidJs(code) {
  try {
    // eslint-disable-next-line no-new
    new Script(code, { filename: "candidate.js" });
    return true;
  } catch {
    return false;
  }
}

// --- overfit / local-maximum detectors (brief part 2) ----------------------

/** Names that are common library/CSS/SVG/RN-primitive tokens, not real app
 *  route/screen names -- the exact class of false positive the NSW ->
 *  Brex/Uniswap sweep caught (screen-naming heuristics matching generic
 *  identifiers instead of an actual route component). Lowercase-compared. */
const NON_ROUTE_TOKENS = new Set(
  [
    "index",
    "default",
    "styles",
    "style",
    "theme",
    "utils",
    "helpers",
    "types",
    "constants",
    "config",
    "icon",
    "icons",
    "button",
    "text",
    "view",
    "image",
    "scrollview",
    "flatlist",
    "touchableopacity",
    "svg",
    "path",
    "g",
    "rect",
    "circle",
    "line",
    "stop",
    "defs",
    "clippath",
    "lineargradient",
    "radialgradient",
    "animated",
    "stylesheet",
    "component",
    "fragment",
    "provider",
    "context",
    "wrapper",
    "container",
    "layout",
    "props",
    "state",
    "root",
    "app",
  ].map((s) => s.toLowerCase()),
);

/** True if `name` (a segregated screen module's basename, no extension)
 *  looks like a real screen/route identifier rather than a heuristic false
 *  positive. Exported so the sweep test and other tooling can reuse the
 *  exact same rule the baseline was scored with. */
export function isPlausibleScreenName(name) {
  if (name.startsWith("module_")) return true; // no name signal fired at all -- not a WRONG name, just an unnamed one; not evidence of overfit
  if (/^[a-zA-Z]$/.test(name)) return false; // single-letter (SVG "G" etc.)
  if (/^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1) return false; // ALL_CAPS_CONST
  if (/__closure/i.test(name)) return false;
  if (NON_ROUTE_TOKENS.has(name.toLowerCase())) return false;
  return true;
}

function screenNamesFromSegregate(seg) {
  return seg.modules.filter((m) => m.newPath.startsWith("src/screens/")).map((m) => basename(m.newPath, extname(m.newPath)));
}

function navigatorCountFromSegregate(seg) {
  return seg.modules.filter((m) => m.newPath.startsWith("src/navigation/")).length;
}

/** Per-app overfit/local-maximum flags -- everything here is a WARNING
 *  surfaced without ground truth, not proof of a bug (brief part 2). */
function detectOverfitFlags(appMetrics, corpusMedianVarNamedPct) {
  const flags = [];
  if (appMetrics.decompile.status === "crash") flags.push(`decompile crash (${appMetrics.decompile.errorCode ?? "?"})`);
  if (appMetrics.decompile.status === "ok" && appMetrics.totalModules > 0 && appMetrics.validJsPct === 0) flags.push("0% valid-JS modules");
  if (appMetrics.decompile.status === "ok" && appMetrics.screens.detected > 0 && appMetrics.navigators.detected === 0) {
    flags.push(`${appMetrics.screens.detected} screen(s) detected with 0 navigators (no navigator evidence)`);
  }
  if (appMetrics.decompile.status === "ok" && appMetrics.screens.detected >= 3 && appMetrics.screens.plausibilityRatio < 0.5) {
    flags.push(`low screen plausibility (${(appMetrics.screens.plausibilityRatio * 100).toFixed(0)}%) -- likely false-positive screen names`);
  }
  if (
    appMetrics.decompile.status === "ok" &&
    corpusMedianVarNamedPct !== null &&
    appMetrics.varNaming.pct < corpusMedianVarNamedPct - 20 &&
    appMetrics.varNaming.totalRegisters > 50
  ) {
    flags.push(`var-naming % (${appMetrics.varNaming.pct.toFixed(1)}%) far below corpus median (${corpusMedianVarNamedPct.toFixed(1)}%)`);
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Per-app run
// ---------------------------------------------------------------------------

/** Runs decompile -> split -> segregate (no deps) for one app and returns
 *  its metrics object. Never throws for an in-pipeline failure -- captured
 *  as `decompile.status` per the SCOPE GUARD convention (tools/app-
 *  metrics.mjs); only a bug in bundle extraction plumbing itself can throw,
 *  and the caller wraps this too, belt and braces (brief: "one app
 *  crashing must not abort the sweep"). */
export function measureCorpusApp(appName, bundlePath) {
  const bytes = new Uint8Array(readFileSync(bundlePath));
  const bundleBytes = bytes.length;
  let split;
  try {
    split = splitProject(bytes, { moduleName: appName, passes: {} });
  } catch (e) {
    const code = e instanceof Hbc2jsError ? e.code : e instanceof Error ? e.constructor.name : "UNKNOWN";
    const message = e instanceof Error ? e.message : String(e);
    return {
      app: appName,
      bundleBytes,
      decompile: { status: "crash", errorCode: code, errorMessage: message.split("\n")[0]?.slice(0, 200) },
    };
  }

  let seg;
  try {
    seg = segregateSplitTree(split.files, null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      app: appName,
      bundleBytes,
      decompile: { status: "ok", wallMs: null },
      totalModules: split.modules.length,
      segregate: { status: "crash", errorMessage: message.split("\n")[0]?.slice(0, 200) },
    };
  }

  // Validity: over every module_<id>.js in the raw split tree (pre-rename;
  // segregate never rewrites a factory body, only requires/paths/headers,
  // per src/split/segregate.ts's file header, so scoring the split tree is
  // equivalent and avoids double-parsing every file twice).
  let validCount = 0;
  let checkedCount = 0;
  let text = "";
  let lineCount = 0;
  for (const m of split.modules) {
    const content = split.files.get(m.file);
    if (content === undefined) continue;
    checkedCount++;
    if (isValidJs(content)) validCount++;
    text += content;
    text += "\n";
  }
  lineCount = text.length === 0 ? 0 : text.split("\n").length;

  const srcModules = seg.modules.filter((m) => m.bucket === "src");
  const nodeModulesModules = seg.modules.filter((m) => m.bucket === "node_modules");
  const unclassifiedModules = seg.modules.filter((m) => m.bucket === "unclassified");

  const screenNames = screenNamesFromSegregate(seg);
  const plausibleScreens = screenNames.filter(isPlausibleScreenName);
  const navigatorCount = navigatorCountFromSegregate(seg);

  const registerMatches = text.match(/\br\d+\b/g) ?? [];
  const totalRegisters = registerMatches.length;
  // "named" registers: every local var/param NOT matching the raw `rN`
  // pattern, over the same src-bucket text -- proxy for "% of registers a
  // naming pass gave a real name to" (brief: "var-naming % (registers
  // named)"). Counted as 1 - (raw registers / (raw registers + a rough
  // count of `var `/`let `/`const ` declarations that are NOT `rN`), since
  // there's no direct "this register got named" signal surfaced by
  // splitProject -- this is the same textual-proxy convention app-
  // metrics.mjs and oss-benchmark.mjs already use for readability.
  const declMatches = text.match(/\b(?:var|let|const)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g) ?? [];
  const namedDecls = declMatches.filter((d) => !/\br\d+$/.test(d)).length;
  const totalDecls = declMatches.length;
  const varNamingPct = totalDecls === 0 ? 0 : pct(namedDecls, totalDecls);

  return {
    app: appName,
    bundleBytes,
    decompile: { status: "ok" },
    totalModules: split.modules.length,
    validJsPct: checkedCount === 0 ? 0 : pct(validCount, checkedCount),
    validJsCounted: { valid: validCount, total: checkedCount },
    stubbedDiagnostics: split.diagnostics.length,
    split: { src: srcModules.length, node_modules: nodeModulesModules.length, unclassified: unclassifiedModules.length },
    screens: {
      detected: screenNames.length,
      plausible: plausibleScreens.length,
      plausibilityRatio: screenNames.length === 0 ? 1 : plausibleScreens.length / screenNames.length,
      sample: screenNames.slice(0, 8),
    },
    navigators: { detected: navigatorCount },
    varNaming: { pct: varNamingPct, totalRegisters, totalDecls, namedDecls },
    readability: {
      registers: per1k(text, lineCount, /\br\d+\b/g),
      reflectApply: per1k(text, lineCount, /Reflect\.apply\(/g),
      anonFnNames: per1k(text, lineCount, /\b_fn\d+\b/g),
    },
    lineCount,
  };
}

// ---------------------------------------------------------------------------
// deb offload
// ---------------------------------------------------------------------------

/** Extracts one app's bundle locally (cheap: unzip, not a decompile), scps
 *  it to deb, runs THIS script's `--bundle-file` single-bundle mode there
 *  over ssh (repo assumed already checked out at ~/hbc2js on deb, updated
 *  to a commit that has this file -- `docs/e2e/CORPUS-REGRESSION.md`
 *  documents the sync step), reads back its JSON, and cleans up both ends.
 *  Never sends the whole (large, proprietary) APK -- only the already-
 *  extracted bundle, per the brief. Fails loudly (captured as a `crash`
 *  status, never silently falls back to local -- that would defeat the
 *  point of "don't thrash the Mac"). */
function runOnDeb(appName, apkPath) {
  let extraction;
  try {
    extraction = extractBundle(apkPath, appName);
  } catch (e) {
    return { app: appName, decompile: { status: "crash", errorCode: "EXTRACT_ERROR", errorMessage: e instanceof Error ? e.message : String(e) } };
  }
  if (extraction.path === null) {
    if (extraction.dir !== null) rmSync(extraction.dir, { recursive: true, force: true });
    return { app: appName, decompile: { status: "no_bundle_found" } };
  }
  const remoteDir = `/tmp/hbc2js-corpus-${appName}-${process.pid}`;
  const remoteBundle = `${remoteDir}/${basename(extraction.path)}`;
  try {
    const mk = spawnSync("ssh", ["deb", `mkdir -p ${remoteDir}`], { encoding: "utf8" });
    if (mk.status !== 0) throw new Error(`mkdir on deb failed: ${mk.stderr}`);
    const scp = spawnSync("scp", ["-q", extraction.path, `deb:${remoteBundle}`], { encoding: "utf8" });
    if (scp.status !== 0) throw new Error(`scp to deb failed: ${scp.stderr}`);
    const remoteCmd = [
      `export PATH="$HOME/.local/share/fnm:$PATH"`,
      `cd ~/hbc2js`,
      `fnm exec --using 22 -- node tools/e2e/corpus-regression.mjs --bundle-file ${remoteBundle} --app ${appName}`,
    ].join(" && ");
    const r = spawnSync("ssh", ["deb", remoteCmd], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    spawnSync("ssh", ["deb", `rm -rf ${remoteDir}`], { encoding: "utf8" });
    if (r.status !== 0) {
      return { app: appName, decompile: { status: "crash", errorCode: "DEB_SSH_ERROR", errorMessage: (r.stderr || r.stdout || "").split("\n")[0]?.slice(0, 200) } };
    }
    const parsed = JSON.parse(r.stdout);
    return parsed.apps?.[0] ?? parsed;
  } catch (e) {
    return { app: appName, decompile: { status: "crash", errorCode: "DEB_OFFLOAD_ERROR", errorMessage: e instanceof Error ? e.message : String(e) } };
  } finally {
    if (extraction.dir !== null) rmSync(extraction.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function runSweep({ apps, corpusDir, onDeb = false } = {}) {
  const appList = apps ?? CORPUS_APPS;
  const results = [];
  for (const appName of appList) {
    const apkPath = join(corpusDir, `${appName}.apk`);
    if (!existsSync(apkPath)) {
      results.push({ app: appName, decompile: { status: "no_apk" } });
      continue;
    }
    if (onDeb) {
      results.push(runOnDeb(appName, apkPath));
      continue;
    }
    let extraction;
    try {
      extraction = extractBundle(apkPath, appName);
    } catch (e) {
      results.push({ app: appName, decompile: { status: "crash", errorCode: "EXTRACT_ERROR", errorMessage: e instanceof Error ? e.message : String(e) } });
      continue;
    }
    if (extraction.path === null) {
      results.push({ app: appName, decompile: { status: "no_bundle_found" } });
      if (extraction.dir !== null) rmSync(extraction.dir, { recursive: true, force: true });
      continue;
    }
    try {
      const m = measureCorpusApp(appName, extraction.path);
      results.push(m);
    } catch (e) {
      // Belt and braces per the brief -- measureCorpusApp already captures
      // in-pipeline failures, this only catches a bug in the harness itself
      // (e.g. bundle read I/O error) so one app truly cannot abort the sweep.
      results.push({ app: appName, decompile: { status: "crash", errorCode: "HARNESS_ERROR", errorMessage: e instanceof Error ? e.message : String(e) } });
    } finally {
      rmSync(extraction.dir, { recursive: true, force: true });
    }
  }

  const varNamingPcts = results.filter((r) => r.decompile.status === "ok" && r.varNaming?.totalDecls > 0).map((r) => r.varNaming.pct);
  const corpusMedianVarNamedPct = median(varNamingPcts);

  for (const r of results) {
    r.overfitFlags = r.decompile.status === "ok" ? detectOverfitFlags(r, corpusMedianVarNamedPct) : [];
  }

  return { generatedAt: new Date().toISOString(), corpusMedianVarNamedPct, apps: results };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let only = null;
  let onDeb = false;
  let corpusDir = defaultCorpusDir();
  let json = false;
  let out = null;
  let bundleFile = null;
  let bundleApp = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") only = argv[++i]?.split(",").map((s) => s.trim());
    else if (a === "--on-deb") onDeb = true;
    else if (a === "--corpus-dir") corpusDir = argv[++i];
    else if (a === "--json") json = true;
    else if (a === "--out") out = argv[++i];
    else if (a === "--bundle-file") bundleFile = argv[++i];
    else if (a === "--app") bundleApp = argv[++i];
  }
  return { only, onDeb, corpusDir, json, out, bundleFile, bundleApp };
}

function fmt(n, digits = 1) {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function toTable(sweep) {
  const header = ["app", "decompile", "valid-JS%", "screens", "plausible%", "var-named%", "flags"];
  const rows = sweep.apps.map((r) => [
    r.app,
    r.decompile.status === "ok" ? "ok" : r.decompile.status === "no_apk" ? "no-apk" : r.decompile.status === "no_bundle_found" ? "no-bundle" : `CRASH:${r.decompile.errorCode ?? "?"}`,
    r.decompile.status === "ok" ? fmt(r.validJsPct) : "-",
    r.decompile.status === "ok" ? String(r.screens.detected) : "-",
    r.decompile.status === "ok" ? fmt(r.screens.plausibilityRatio * 100) : "-",
    r.decompile.status === "ok" ? fmt(r.varNaming.pct) : "-",
    r.overfitFlags.length > 0 ? r.overfitFlags.join("; ") : "",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

async function main() {
  const { only, onDeb, corpusDir, json, out, bundleFile, bundleApp } = parseArgs(process.argv.slice(2));
  // Single-bundle mode (`--bundle-file X --app Y`): measures one already-
  // extracted bundle directly, no corpus dir / APK lookup at all. Used by
  // `runOnDeb` below to scp one bundle over and score it remotely without
  // needing the (large, proprietary, never-transferred-as-a-whole) corpus
  // directory to exist on deb.
  if (bundleFile !== null) {
    const appName = bundleApp ?? basename(bundleFile);
    let result;
    try {
      result = measureCorpusApp(appName, bundleFile);
    } catch (e) {
      result = { app: appName, decompile: { status: "crash", errorCode: "HARNESS_ERROR", errorMessage: e instanceof Error ? e.message : String(e) } };
    }
    result.overfitFlags = result.decompile.status === "ok" ? detectOverfitFlags(result, null) : [];
    const sweep = { generatedAt: new Date().toISOString(), corpusMedianVarNamedPct: null, apps: [result] };
    if (out !== null) writeFileSync(out, JSON.stringify(sweep, null, 2));
    console.log(JSON.stringify(sweep, null, 2));
    return;
  }
  const apps = only ?? CORPUS_APPS;
  const sweep = runSweep({ apps, corpusDir, onDeb });
  if (out !== null) writeFileSync(out, JSON.stringify(sweep, null, 2));
  if (json) console.log(JSON.stringify(sweep, null, 2));
  else console.log(toTable(sweep));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`corpus-regression: ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  });
}
