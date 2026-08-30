// src/deps/confirm.ts — the D17a "confirm" stage: `npm pack` a guessed
// candidate, bundle + compile it with the toolchain matched to the target
// bundle's HBC version, fingerprint, and match against the target's own
// module inventory. On success the signature is written into the
// project-local DB (and user cache) so it's free next time
// (docs/DECISIONS.md D17a/D17b).
//
// Never executes the candidate's own code: it is fetched with `npm pack`
// (a plain tarball download — no install-time scripts run on the package
// itself) and extracted by hand into a scratch project's `node_modules`,
// never `npm install`-ed. The scratch project's *own* toolchain
// (react-native/metro, this repo's `tools/hermesc`) is ordinary trusted
// tooling, set up the same way every other Tier-2 bundle fixture in this
// repo already is.

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
import type { SigDbFile } from "./sigdb-types.ts";

export interface ConfirmCandidate {
  readonly package: string;
  readonly version: string;
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
}

export interface ConfirmResult {
  readonly candidate: ConfirmCandidate;
  readonly ok: boolean;
  readonly reason?: string;
  readonly score?: PackageScore;
  readonly writtenTo?: readonly string[];
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

/** Ensure the scratch project has `react-native@<rnVersion>` (and whatever
 *  Metro/CLI it pulls in) installed. Reused across every candidate in one
 *  `--confirm` run — the expensive part of the pipeline, done once. */
function ensureScratchProject(dir: string, rnVersion: string): void {
  mkdirSync(dir, { recursive: true });
  const pkgJsonPath = join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({ name: "hbc2js-deps-confirm-scratch", version: "0.0.0", private: true }, null, 2));
  }
  const rnDir = join(dir, "node_modules", "react-native");
  const installedVersion = existsSync(join(rnDir, "package.json")) ? (JSON.parse(readFileSync(join(rnDir, "package.json"), "utf8")) as { version: string }).version : null;
  if (installedVersion !== rnVersion) {
    execFileSync("npm", ["install", "--legacy-peer-deps", `react-native@${rnVersion}`], { cwd: dir, stdio: "ignore" });
  }
}

/** `npm pack` a candidate into a scratch tarball dir (cached across runs by
 *  version) and extract it by hand into the scratch project's
 *  `node_modules/<pkg>` — never `npm install <pkg>` (would run its scripts). */
function fetchAndExtractCandidate(candidate: ConfirmCandidate, scratchProjectDir: string, tarballCacheDir: string): void {
  mkdirSync(tarballCacheDir, { recursive: true });
  const spec = `${candidate.package}@${candidate.version}`;
  const before = new Set(existsSync(tarballCacheDir) ? readdirSync(tarballCacheDir) : []);
  execFileSync("npm", ["pack", spec, "--pack-destination", tarballCacheDir, "--ignore-scripts"], { stdio: "ignore" });
  const after = readdirSync(tarballCacheDir);
  const tarballName = after.find((f) => !before.has(f)) ?? after.filter((f) => f.endsWith(".tgz")).sort().at(-1);
  if (tarballName === undefined) throw new Error(`npm pack produced no tarball for ${spec}`);
  const tarballPath = join(tarballCacheDir, tarballName);

  const destDir = join(scratchProjectDir, "node_modules", ...candidate.package.split("/"));
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  // npm tarballs always wrap contents in a top-level "package/" directory.
  execFileSync("tar", ["-xzf", tarballPath, "-C", destDir, "--strip-components=1"], { stdio: "ignore" });
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

export async function confirmCandidates(candidates: readonly ConfirmCandidate[], target: ModuleInventory, opts: ConfirmOptions): Promise<ConfirmResult[]> {
  const failureLog = loadFailureLog(opts.failureLogPath);
  const results: ConfirmResult[] = [];

  ensureScratchProject(opts.scratchProjectDir, opts.rnVersion);
  const tarballCacheDir = join(opts.scratchProjectDir, ".hbc2js-tarball-cache");

  for (const candidate of candidates) {
    const key = `${candidate.package}@${candidate.version}__hbc${opts.hbcVersion}`;
    const cachedFailure = failureLog[key];
    if (cachedFailure !== undefined) {
      results.push({ candidate, ok: false, reason: `previously failed (${cachedFailure.at}): ${cachedFailure.reason}` });
      continue;
    }

    let workDir: string | null = null;
    try {
      fetchAndExtractCandidate(candidate, opts.scratchProjectDir, tarballCacheDir);
      workDir = mkdtempSync(join(tmpdir(), "hbc2js-confirm-"));
      const hbcPath = bundleAndCompile(candidate.package, opts.scratchProjectDir, opts.hermescPath, workDir);

      const bytes = new Uint8Array(readFileSync(hbcPath));
      const mod = parseHbc(bytes);
      const { functions, modules } = fingerprintModule(mod, decodeFunction);

      const db: SigDbFile = {
        schema: 2,
        package: candidate.package,
        version: candidate.version,
        hbcVersion: mod.header.version,
        totalFunctions: functions.length,
        rawFunctionCount: functions.length,
        subtractedBaselines: [],
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
      } else {
        const reason = score === undefined ? "no eligible functions after fingerprinting" : `confidence tier ${score.tier} too low (exact ${(score.exactCoverage * 100).toFixed(1)}%)`;
        failureLog[key] = { reason, at: new Date().toISOString() };
        results.push({ candidate, ok: false, reason, ...(score !== undefined ? { score } : {}) });
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failureLog[key] = { reason, at: new Date().toISOString() };
      results.push({ candidate, ok: false, reason });
    } finally {
      if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
    }

    if (opts.rateLimitMs !== undefined && opts.rateLimitMs > 0) await sleep(opts.rateLimitMs);
  }

  saveFailureLog(opts.failureLogPath, failureLog);
  return results;
}
