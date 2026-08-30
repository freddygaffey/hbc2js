// src/deps/confirm.ts — the D17a "confirm" stage: install a guessed
// candidate (and its own real dependency tree) into a scratch RN project,
// bundle + compile it with the toolchain matched to the target bundle's HBC
// version, fingerprint, and match against the target's own module
// inventory. On success the signature is written into the project-local DB
// (and user cache) so it's free next time (docs/DECISIONS.md D17a/D17b).
//
// Never executes the candidate's own code: `installCandidate` always passes
// `--ignore-scripts` (npm's documented, standard way to install a full
// dependency tree — the candidate's own listed dependencies included, not
// just the candidate itself — with no lifecycle script, of the candidate
// or of anything underneath it, ever running). The scratch project's *own*
// toolchain (react-native/metro, this repo's `tools/hermesc`) is ordinary
// trusted tooling, set up the same way every other Tier-2 bundle fixture in
// this repo already is.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunction } from "../disasm/decode.ts";
import { parseHbc } from "../parse/module.ts";
import { fingerprintModule } from "./fingerprint.ts";
import { matchInventory } from "./match.ts";
import type { ModuleInventory } from "./inventory.ts";
import type { PackageScore } from "./match.ts";
import { writeSignature } from "./db.ts";
import type { SigDbFile, SigFunction, SigModule } from "./sigdb-types.ts";

export interface ConfirmCandidate {
  readonly package: string;
  /** Null when the guess evidence that named this package carried no
   *  version (the common case — a `NativeModules.X` name or a package-name
   *  string with no `@version` suffix). `confirmCandidates` resolves it to
   *  the npm release nearest `ConfirmOptions.referenceDate` before packing. */
  readonly version: string | null;
}

// --- baseline subtraction (docs/PACKAGE-SIGNATURES.md §5.2/§6.4) ---------
//
// A raw fingerprint of `require(<candidate>)` bundled from a fresh RN
// scaffold always includes every function Metro pulled in — not just the
// candidate's own code, but the scaffold's shared Metro/RN runtime and
// polyfills too. Left in, that shared boilerplate collides against every
// *other* candidate's signature simultaneously and can clear "confirmed"
// tier on a package that contributed almost none of its own code (the same
// failure mode `tools/pkgsig/bulk/baseline-subtract.mjs` fixes for the bulk
// shared-DB build — ported here, scoped to `src/deps` per this task's
// ownership split, since no exported `src/deps` function did this before).

const BASELINE_KINDS = ["metro-toolchain-empty", "react-foundation", "react-native-foundation"] as const;

export interface BaselineHashes {
  readonly hashes: ReadonlySet<string>;
  readonly paths: readonly string[];
}

/** Union the exact-function-hash sets of every `_baselines/*__hbc<hbcVersion>.json`
 *  file found under any of `dbDirs` (checked in order given; a baseline kind
 *  found in an earlier dir is not re-read from a later one). Baselines are
 *  toolchain noise-cancellation, not curated package data, so callers pass
 *  every DB dir here (project, user cache, shared) regardless of
 *  `--no-shared-db` — that flag governs which *package* signatures are
 *  trusted for scoring, not this. */
export function computeBaselineHashes(dbDirs: readonly string[], hbcVersion: number): BaselineHashes {
  const hashes = new Set<string>();
  const paths: string[] = [];
  const seenKinds = new Set<string>();
  const suffix = `__hbc${hbcVersion}.json`;
  for (const dbDir of dbDirs) {
    const dir = join(dbDir, "_baselines");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json") || !name.endsWith(suffix)) continue;
      const kind = BASELINE_KINDS.find((k) => name.startsWith(`${k}@`));
      if (kind !== undefined && seenKinds.has(kind)) continue;
      let doc: { functions?: readonly { exactHash?: unknown }[] };
      try {
        doc = JSON.parse(readFileSync(join(dir, name), "utf8")) as typeof doc;
      } catch {
        continue; // mid-write or malformed — same tolerance as the bulk tool.
      }
      if (!Array.isArray(doc.functions)) continue;
      for (const f of doc.functions) {
        if (typeof f.exactHash === "string") hashes.add(f.exactHash);
      }
      if (kind !== undefined) seenKinds.add(kind);
      paths.push(`_baselines/${name}`);
    }
  }
  return { hashes, paths };
}

/** True when all three recognised baseline kinds contributed at least one
 *  file — informational only (`confirmCandidates` still subtracts whatever
 *  it found rather than refusing to run when the set is partial; a fresh
 *  HBC version with no baselines built yet should degrade to "no
 *  subtraction", not block `--confirm` outright). */
export function hasCompleteBaselineSet(paths: readonly string[]): boolean {
  return BASELINE_KINDS.every((kind) => paths.some((p) => p.includes(`/${kind}@`)));
}

/** Drop every function whose exact hash is one of the scaffold's own
 *  baseline hashes, and flag any module whose factory is baseline-owned
 *  (kept, not dropped, so the `__d()` module graph this package's real
 *  modules `depIds` reference stays complete) — mirrors
 *  `tools/pkgsig/bulk/baseline-subtract.mjs`'s `subtractBaseline` exactly. */
export function subtractBaseline(rawFunctions: readonly SigFunction[], rawModules: readonly SigModule[], baselineHashes: ReadonlySet<string>): { functions: SigFunction[]; modules: SigModule[] } {
  const functions = rawFunctions.filter((f) => !baselineHashes.has(f.exactHash));
  const modules = rawModules.map((m) => ({ ...m, factoryIsBaseline: m.factoryExactHash !== null && baselineHashes.has(m.factoryExactHash) }));
  return { functions, modules };
}

// --- RN-version bootstrap fallback ----------------------------------------
//
// `src/deps/report.ts`'s `detectReactNativeVersion` only sees a version once
// the *match* stage has already found a high/medium `react-native`
// signature — impossible on an empty/`--no-shared-db` DB, which is exactly
// when `--confirm` is most needed. The baseline files already on disk
// (`react-native-foundation@<version>__hbc<hbcVersion>.json`, built once per
// (RN, HBC) toolchain — see `tools/pkgsig/bulk/build-baselines.mjs`) already
// record which RN release this repo's own toolchain associates with a given
// HBC bytecode version. Reading that filename is not a package match — it
// never claims a dependency was found, only which RN release to `npm
// install` into the confirm scratch project so the candidates it builds
// share the target's actual toolchain era.
const BASELINE_FILENAME_VERSION = /^(?:react-native-foundation|react-native)@(.+)__hbc\d+\.json$/;

export function detectRnVersionFromBaselineFilenames(dbDirs: readonly string[], hbcVersion: number): string | null {
  const suffix = `__hbc${hbcVersion}.json`;
  for (const dbDir of dbDirs) {
    for (const sub of ["_baselines", "."]) {
      const dir = join(dbDir, sub);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(suffix)) continue;
        const m = BASELINE_FILENAME_VERSION.exec(name);
        if (m !== null) return m[1]!;
      }
    }
  }
  return null;
}

// --- version resolution ("nearest by date if absent") ---------------------

/** `registry.npmjs.org`'s per-package `time` map (version -> ISO publish
 *  date, plus `created`/`modified` keys this file filters out). Injectable
 *  for tests; the real implementation is the only network call here besides
 *  `npm pack` itself. */
export type FetchVersionTimes = (pkg: string) => Promise<Record<string, string> | null>;

function registryMetadataUrl(pkg: string): string {
  return pkg.startsWith("@") ? `https://registry.npmjs.org/${pkg.replace("/", "%2F")}` : `https://registry.npmjs.org/${pkg}`;
}

export const fetchVersionTimesFromRegistry: FetchVersionTimes = async (pkg) => {
  try {
    const res = await fetch(registryMetadataUrl(pkg), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = (await res.json()) as { time?: Record<string, string> };
    return data.time ?? null;
  } catch {
    return null;
  }
};

/** The version whose registry publish date is closest to `referenceIso` —
 *  "nearest by date" when a guess carried a package name but no version
 *  (the common case: a `NativeModules.X` hit never carries one). */
export function nearestVersionByDate(times: Record<string, string>, referenceIso: string): string | null {
  const ref = Date.parse(referenceIso);
  let best: string | null = null;
  let bestDiff = Infinity;
  for (const [version, iso] of Object.entries(times)) {
    if (version === "created" || version === "modified") continue;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) continue;
    const diff = Math.abs(t - ref);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = version;
    }
  }
  return best;
}

export interface ConfirmOptions {
  /** A scratch directory this call owns (repeat candidates reuse the same
   *  RN scaffold to avoid re-scaffolding per package). Never the repo. */
  readonly scratchProjectDir: string;
  readonly rnVersion: string;
  readonly hbcVersion: number;
  readonly hermescPath: string;
  readonly projectDbDir: string;
  readonly userCacheDbDir: string;
  readonly rateLimitMs?: number;
  /** Skip candidates already recorded as a failure in
   *  `<projectDbDir>/../confirm-failures.json` from a previous run. */
  readonly failureLogPath?: string;
  /** Directories to search for `_baselines/*__hbc<hbcVersion>.json` to
   *  subtract from every candidate's raw fingerprint (see "baseline
   *  subtraction" above). Defaults to `[]` — no subtraction — when omitted,
   *  so existing callers keep their current (unsubtracted) behaviour unless
   *  they opt in. */
  readonly baselineDirs?: readonly string[];
  /** Anchor for "nearest by date" version resolution when a candidate's
   *  evidence carried no version. Defaults to `rnVersion`'s own npm publish
   *  date (falling back to `new Date().toISOString()` only if that lookup
   *  fails) — *not* wall-clock "now": several of this ecosystem's packages
   *  (react-native, react-native-reanimated, react-native-screens,
   *  react-native-gesture-handler, ...) publish nightly builds continuously,
   *  so "nearest to now" silently resolves to whatever nightly shipped
   *  today regardless of which release the target bundle actually contains
   *  — measured live: every one of those came back a today-dated nightly
   *  and failed to bundle/match, while the target bundle is really several
   *  days old. `rnVersion`'s own publish date is the one concrete
   *  toolchain-era signal already in hand. */
  readonly referenceDate?: string;
  /** Injectable for tests (no network); defaults to `fetchVersionTimesFromRegistry`. */
  readonly fetchVersionTimes?: FetchVersionTimes;
  /** Called once per candidate, before and after each attempt — a `--confirm`
   *  run has no other output for potentially several minutes otherwise, and
   *  "time per confirmed package" is otherwise unobservable from outside.
   *  Never called by the tests above (no default; silent unless a caller
   *  opts in, e.g. `hbc2js`'s CLI writing to stderr). */
  readonly onProgress?: (message: string) => void;
}

/** A candidate whose version is known (either it was evidenced, or
 *  `resolveCandidateVersion` resolved it) — what everything past that point
 *  (`npm pack`, the Metro bundle, the written `SigDbFile`) actually needs. */
export interface ResolvedCandidate {
  readonly package: string;
  readonly version: string;
}

// A discriminated union on `ok`: a successful confirmation always reached a
// concrete (non-null) version (only then did it get as far as `npm pack`),
// so `report.ts`'s `confirmedDeps` — which needs a real `string` version —
// can read `r.candidate.version` straight off an `ok: true` result with no
// cast. A failure still reports whatever version it got to (possibly `null`,
// when "nearest by date" resolution itself is what failed).
export interface ConfirmSuccess {
  readonly candidate: ResolvedCandidate;
  readonly ok: true;
  readonly score: PackageScore;
  readonly writtenTo: readonly string[];
}

export interface ConfirmFailure {
  readonly candidate: { readonly package: string; readonly version: string | null };
  readonly ok: false;
  readonly reason: string;
  readonly score?: PackageScore;
}

export type ConfirmResult = ConfirmSuccess | ConfirmFailure;

/** One candidate per package (`docs/DEPS.md` §4: "the best-ranked guessed
 *  candidate per module" is the *input*, but every module belonging to the
 *  same not-yet-attributed package would otherwise re-propose it — often
 *  hundreds of times over on a real app — wasting an `npm pack` + Metro
 *  bundle + `hermesc` compile on the same package repeatedly). Kept in
 *  first-seen order; prefers a candidate that already carries a version
 *  (self-corroborating evidence) over one that doesn't. */
export function dedupeCandidatesByPackage(candidates: readonly ConfirmCandidate[]): ConfirmCandidate[] {
  const byPackage = new Map<string, ConfirmCandidate>();
  for (const c of candidates) {
    const existing = byPackage.get(c.package);
    if (existing === undefined || (existing.version === null && c.version !== null)) byPackage.set(c.package, c);
  }
  return [...byPackage.values()];
}

interface FailureLog {
  [key: string]: { reason: string; at: string };
}

function loadFailureLog(path: string | undefined): FailureLog {
  if (path === undefined || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FailureLog;
  } catch {
    return {};
  }
}

function saveFailureLog(path: string | undefined, log: FailureLog): void {
  if (path === undefined) return;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(log, null, 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const METRO_CONFIG_JS = `const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
module.exports = mergeConfig(getDefaultConfig(__dirname), {});
`;

/** Install one package, at `rnVersion` if that exact version exists on the
 *  registry, `latest` otherwise (`@react-native-community/cli`'s own
 *  version numbers don't track `react-native`'s at all — `@0.85.3` 404s,
 *  `@latest` is what actually resolves). One package *at a time*, in its
 *  own `npm install` call: an earlier version of this function installed
 *  `react-native` together with the CLI/Metro-config packages in one call,
 *  pinned-else-all-fall-back-to-latest together — when the CLI/metro-config
 *  pin 404'd (the common case, per above), *that* silently pulled
 *  `react-native` itself up to `latest` too, and once left broken by a
 *  second, conflicting install right after fixed the version string in
 *  `package.json` but left `node_modules` an inconsistent mix (measured
 *  live: `react-native`'s own declared dependency
 *  `@react-native/assets-registry` went missing, breaking every bundle).
 *  Never touching `react-native`'s own install call is what avoids this. */
function installOneWithVersionFallback(dir: string, pkg: string, rnVersion: string): void {
  try {
    execFileSync("npm", ["install", "--legacy-peer-deps", `${pkg}@${rnVersion}`], { cwd: dir, stdio: "ignore" });
  } catch {
    execFileSync("npm", ["install", "--legacy-peer-deps", `${pkg}@latest`], { cwd: dir, stdio: "ignore" });
  }
}

/** Ensure the scratch project has everything a real `npx react-native
 *  bundle` needs — reused across every candidate in one `--confirm` run
 *  (the expensive part of the pipeline, done once). Newer `react-native`
 *  releases (measured live against 0.85.3) don't bundle their own CLI: a
 *  bare `npm install react-native@<version>` leaves `npx react-native
 *  bundle` failing with "depends on @react-native-community/cli" and then,
 *  once that's added, "No Metro config found" and "Unable to resolve module
 *  react" — `@react-native-community/cli`, `@react-native/metro-config` (plus
 *  a `metro.config.js` that actually calls it — installing the package alone
 *  isn't enough), and `react-native`'s own declared peer version of `react`
 *  are all real, separate requirements, not implied by `react-native` alone. */
function ensureScratchProject(dir: string, rnVersion: string): void {
  mkdirSync(dir, { recursive: true });
  const pkgJsonPath = join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({ name: "hbc2js-deps-confirm-scratch", version: "0.0.0", private: true }, null, 2));
  }
  const rnDir = join(dir, "node_modules", "react-native");
  const installedVersion = existsSync(join(rnDir, "package.json")) ? (JSON.parse(readFileSync(join(rnDir, "package.json"), "utf8")) as { version: string }).version : null;
  if (installedVersion !== rnVersion) {
    // `react-native` alone, pinned exactly, in its own call — see
    // `installOneWithVersionFallback`'s doc comment for why the CLI/
    // metro-config packages must never share this call.
    execFileSync("npm", ["install", "--legacy-peer-deps", `react-native@${rnVersion}`], { cwd: dir, stdio: "ignore" });
    installOneWithVersionFallback(dir, "@react-native-community/cli", rnVersion);
    installOneWithVersionFallback(dir, "@react-native/metro-config", rnVersion);
    const peerReact = (JSON.parse(readFileSync(join(rnDir, "package.json"), "utf8")) as { peerDependencies?: { react?: string } }).peerDependencies?.react ?? "*";
    execFileSync("npm", ["install", "--legacy-peer-deps", `react@${peerReact}`], { cwd: dir, stdio: "ignore" });
  }
  const metroConfigPath = join(dir, "metro.config.js");
  if (!existsSync(metroConfigPath)) writeFileSync(metroConfigPath, METRO_CONFIG_JS);
}

/** Install a candidate — and, critically, its own real dependency tree —
 *  into the scratch project's `node_modules`, `--ignore-scripts` throughout
 *  so no lifecycle script (the candidate's own, or any transitive
 *  dependency's) ever runs; `--no-save` so it never lands in the scratch
 *  project's own `package.json`/lockfile (each candidate is fetched fresh
 *  and discarded after fingerprinting, on top of whatever `ensureScratchProject`
 *  set up once).
 *
 *  An earlier version of this function used `npm pack` + manual `tar`
 *  extraction instead, reasoning that *not* using `npm install` was itself
 *  the script-safety measure — but that only ever placed the candidate's
 *  *own* files, never its dependencies (metro then fails to resolve them:
 *  measured live, `react-native-reanimated` requiring `react-native-worklets`,
 *  `react-native-is-edge-to-edge`), silently breaking every candidate with a
 *  real dependency of its own — which is most of them. `--ignore-scripts`
 *  is the actual, standard way to install a full tree with no code
 *  execution (documented npm behaviour, applies to every package in the
 *  resolved tree, not just the top one), so this switches to a real `npm
 *  install` under it. Peer dependencies matter here too — `worklets` above
 *  is one — so this does *not* pass `--legacy-peer-deps` (unlike
 *  `ensureScratchProject`'s own react-native install, which does, to dodge
 *  unrelated peer noise on that one scaffold-wide install): a real
 *  `--legacy-peer-deps` skips installing them at all. Falls back to
 *  `--legacy-peer-deps` only if the strict resolution itself fails (an
 *  unrelated peer conflict must not block an otherwise-installable
 *  candidate), accepting that fallback may leave a real peer dependency
 *  like `worklets` missing for that one candidate. */
function installCandidate(candidate: ResolvedCandidate, scratchProjectDir: string): void {
  const spec = `${candidate.package}@${candidate.version}`;
  try {
    execFileSync("npm", ["install", "--ignore-scripts", "--no-save", spec], { cwd: scratchProjectDir, stdio: "ignore" });
  } catch {
    execFileSync("npm", ["install", "--ignore-scripts", "--no-save", "--legacy-peer-deps", spec], { cwd: scratchProjectDir, stdio: "ignore" });
  }
}

function bundleAndCompile(pkg: string, scratchProjectDir: string, hermescPath: string, workDir: string): string {
  const entrySlug = pkg.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  const entryFile = join(scratchProjectDir, `__hbc2js_confirm_entry_${entrySlug}__.js`);
  writeFileSync(entryFile, `const X = require(${JSON.stringify(pkg)});\nmodule.exports = X;\n`);
  const bundlePath = join(workDir, "out.bundle");
  const assetsDir = join(workDir, "assets");
  mkdirSync(assetsDir, { recursive: true });
  execFileSync(
    "npx",
    ["react-native", "bundle", "--platform", "android", "--dev", "false", "--minify", "true", "--reset-cache", "--entry-file", entryFile, "--bundle-output", bundlePath, "--assets-dest", assetsDir],
    { cwd: scratchProjectDir, stdio: "ignore" },
  );
  const hbcPath = join(workDir, "out.hbc");
  execFileSync(hermescPath, ["-O", "-emit-binary", `-out=${hbcPath}`, bundlePath], { stdio: "ignore" });
  return hbcPath;
}

/** Resolve a candidate's version ("nearest by date" when the guess evidence
 *  that named it carried none — docs/DEPS.md §4). Returns `null` when there
 *  was nothing to resolve to (no version evidence *and* the registry lookup
 *  failed or came back empty) — `confirmCandidates` records that as a
 *  failure and never calls `npm pack` for it. */
async function resolveCandidateVersion(candidate: ConfirmCandidate, referenceDate: string, opts: ConfirmOptions): Promise<string | null> {
  if (candidate.version !== null) return candidate.version;
  const fetchTimes = opts.fetchVersionTimes ?? fetchVersionTimesFromRegistry;
  const times = await fetchTimes(candidate.package);
  if (times === null) return null;
  return nearestVersionByDate(times, referenceDate);
}

/** `rnVersion`'s own npm publish date — see `ConfirmOptions.referenceDate`'s
 *  doc comment for why "now" is the wrong default anchor. */
async function defaultReferenceDate(rnVersion: string, opts: ConfirmOptions): Promise<string> {
  const fetchTimes = opts.fetchVersionTimes ?? fetchVersionTimesFromRegistry;
  const times = await fetchTimes("react-native");
  return times?.[rnVersion] ?? new Date().toISOString();
}

export async function confirmCandidates(candidates: readonly ConfirmCandidate[], target: ModuleInventory, opts: ConfirmOptions): Promise<ConfirmResult[]> {
  const failureLog = loadFailureLog(opts.failureLogPath);
  const results: ConfirmResult[] = [];

  ensureScratchProject(opts.scratchProjectDir, opts.rnVersion);
  const referenceDate = opts.referenceDate ?? (await defaultReferenceDate(opts.rnVersion, opts));
  const baseline = computeBaselineHashes(opts.baselineDirs ?? [], opts.hbcVersion);

  for (const rawCandidate of dedupeCandidatesByPackage(candidates)) {
    const resolvedVersion = await resolveCandidateVersion(rawCandidate, referenceDate, opts);
    if (resolvedVersion === null) {
      results.push({ candidate: { package: rawCandidate.package, version: null }, ok: false, reason: "no version evidenced and no npm registry release found to resolve 'nearest by date' against" });
      if (opts.rateLimitMs !== undefined && opts.rateLimitMs > 0) await sleep(opts.rateLimitMs);
      continue;
    }
    const candidate: ResolvedCandidate = { package: rawCandidate.package, version: resolvedVersion };
    const startedAt = Date.now();
    const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

    const key = `${candidate.package}@${candidate.version}__hbc${opts.hbcVersion}`;
    const cachedFailure = failureLog[key];
    if (cachedFailure !== undefined) {
      results.push({ candidate, ok: false, reason: `previously failed (${cachedFailure.at}): ${cachedFailure.reason}` });
      continue;
    }

    opts.onProgress?.(`confirming ${candidate.package}@${candidate.version} (hbc${opts.hbcVersion})...`);
    let workDir: string | null = null;
    try {
      installCandidate(candidate, opts.scratchProjectDir);
      workDir = mkdtempSync(join(tmpdir(), "hbc2js-confirm-"));
      const hbcPath = bundleAndCompile(candidate.package, opts.scratchProjectDir, opts.hermescPath, workDir);

      const bytes = new Uint8Array(readFileSync(hbcPath));
      const mod = parseHbc(bytes);
      const { functions: rawFunctions, modules: rawModules } = fingerprintModule(mod, decodeFunction);
      const { functions, modules } = subtractBaseline(rawFunctions, rawModules, baseline.hashes);

      const db: SigDbFile = {
        schema: 2,
        package: candidate.package,
        version: candidate.version,
        hbcVersion: mod.header.version,
        totalFunctions: functions.length,
        rawFunctionCount: rawFunctions.length,
        subtractedBaselines: baseline.paths,
        functions,
        modules,
        toolchainBaseline: false,
        provenance: {
          packageSha256: null,
          metroVersion: null,
          reactNativeVersion: opts.rnVersion,
          hermescVersion: opts.hbcVersion,
          hermescRnEra: null,
          repoCommit: null,
          builtAt: new Date().toISOString(),
        },
      };

      const scored = matchInventory(target, [{ file: db, layer: "project", path: "<confirm-candidate>" }], { minInstr: 8 });
      const score = scored.packages.find((p) => p.package === candidate.package && p.version === candidate.version);

      if (score !== undefined && (score.tier === "high" || score.tier === "medium")) {
        const written = [writeSignature(opts.projectDbDir, db), writeSignature(opts.userCacheDbDir, db)];
        results.push({ candidate, ok: true, score, writtenTo: written });
        opts.onProgress?.(`  -> confirmed ${candidate.package}@${candidate.version} at ${score.tier} (${elapsed()})`);
      } else {
        const reason = score === undefined ? "no eligible functions after fingerprinting" : `confidence tier ${score.tier} too low (exact ${(score.exactCoverage * 100).toFixed(1)}%)`;
        failureLog[key] = { reason, at: new Date().toISOString() };
        results.push({ candidate, ok: false, reason, ...(score !== undefined ? { score } : {}) });
        opts.onProgress?.(`  -> not confirmed: ${reason} (${elapsed()})`);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failureLog[key] = { reason, at: new Date().toISOString() };
      results.push({ candidate, ok: false, reason });
      opts.onProgress?.(`  -> failed: ${reason.split("\n")[0]} (${elapsed()})`);
    } finally {
      if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
    }

    if (opts.rateLimitMs !== undefined && opts.rateLimitMs > 0) await sleep(opts.rateLimitMs);
  }

  saveFailureLog(opts.failureLogPath, failureLog);
  return results;
}
