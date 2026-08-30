// src/deps/index.ts — `hbc2js deps` orchestration (docs/DECISIONS.md D17a/
// D17b): read the input, build the module inventory, run the match stage
// against the layered signature DB, run the guess stage on whatever's left,
// optionally run the confirm stage, and assemble the report.

import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { analyzeApk, apkHintsFromEvidence, extractBundleFromApk } from "./apk.ts";
import type { ApkEvidence } from "./apk.ts";
import { confirmCandidates } from "./confirm.ts";
import type { ConfirmResult } from "./confirm.ts";
import { resolveDbLayers, loadSignatures } from "./db.ts";
import { guessModules } from "./guess.ts";
import type { ModuleGuess } from "./guess.ts";
import { buildInventory } from "./inventory.ts";
import type { ModuleInventory } from "./inventory.ts";
import { matchInventory } from "./match.ts";
import type { MatchReport } from "./match.ts";
import { buildReport } from "./report.ts";
import type { DepsReport } from "./report.ts";

export interface DepsOptions {
  readonly out?: string;
  readonly confirm?: boolean;
  readonly offline?: boolean;
  readonly sigdb?: string;
  readonly noSharedDb?: boolean;
  readonly minInstr?: number;
  readonly scratchDir?: string;
  readonly hermescDir?: string; // defaults to `tools/hermesc` under the repo/package root
}

export interface DepsRunResult {
  readonly report: DepsReport;
  readonly inventory: ModuleInventory;
  readonly matchReport: MatchReport;
  readonly guesses: readonly ModuleGuess[];
  readonly confirmResults: readonly ConfirmResult[];
  readonly apkEvidence: ApkEvidence | null;
}

function readInputBytes(inputPath: string): { bytes: Uint8Array; apkEvidence: ApkEvidence | null } {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".apk") {
    const extracted = extractBundleFromApk(inputPath);
    if (!extracted.isHermes) {
      throw new Error(`${inputPath}: bundle at ${extracted.entryPath} is plain JS, not Hermes bytecode — plain-JS module inventory is not implemented yet (see docs/DECISIONS.md D18)`);
    }
    return { bytes: extracted.bytes, apkEvidence: analyzeApk(inputPath) };
  }
  if (ext === ".js") {
    throw new Error(`${inputPath}: plain-JS bundle input is not implemented yet for 'hbc2js deps' (see docs/DECISIONS.md D18 — the module inventory/signature DB are Hermes-bytecode-specific for now)`);
  }
  return { bytes: readFileSync(inputPath), apkEvidence: null };
}

export async function runDeps(inputPath: string, opts: DepsOptions = {}): Promise<DepsRunResult> {
  const { bytes, apkEvidence } = readInputBytes(inputPath);
  const { inventory } = buildInventory(bytes);

  const layers = resolveDbLayers({ ...(opts.out !== undefined ? { outDir: opts.out } : {}), ...(opts.sigdb !== undefined ? { sigdb: opts.sigdb } : {}), noSharedDb: opts.noSharedDb === true });
  const dbs = loadSignatures(layers);
  const matchReport = matchInventory(inventory, dbs, opts.minInstr !== undefined ? { minInstr: opts.minInstr } : {});

  const apkHints = apkEvidence !== null ? apkHintsFromEvidence(apkEvidence) : undefined;
  const knownPackages = new Set(dbs.map((d) => d.file.package));
  const guesses = await guessModules(inventory, matchReport, { offline: opts.offline === true, knownPackages, ...(apkHints !== undefined ? { apkHints } : {}) });

  let confirmResults: ConfirmResult[] = [];
  if (opts.confirm === true && opts.offline !== true) {
    const rnVersion = matchReport.packages.find((p) => p.package === "react-native" && (p.tier === "high" || p.tier === "medium"))?.version;
    const hermescPath = join(opts.hermescDir ?? join(process.cwd(), "tools", "hermesc"), `v${inventory.hbcVersion}`, "hermesc");
    if (rnVersion !== undefined) {
      const scratchDir = opts.scratchDir ?? join(opts.out ?? ".", ".hbc2js", "confirm-scratch");
      const candidates = guesses
        .map((g) => g.candidates[0])
        .filter((c): c is NonNullable<typeof c> => c !== undefined && c.version !== null)
        .map((c) => ({ package: c.package, version: c.version! }));
      const projectDbDir = resolveDbLayers({ ...(opts.out !== undefined ? { outDir: opts.out } : {}), ...(opts.sigdb !== undefined ? { sigdb: opts.sigdb } : {}) })[0]!.dir;
      const userCacheDbDir = resolveDbLayers({})[1]!.dir;
      confirmResults = await confirmCandidates(candidates, inventory, {
        scratchProjectDir: scratchDir,
        rnVersion,
        hbcVersion: inventory.hbcVersion,
        hermescPath,
        projectDbDir,
        userCacheDbDir,
        rateLimitMs: 500,
        failureLogPath: join(scratchDir, "..", "confirm-failures.json"),
      });
    }
  }

  const report = buildReport(inputPath, matchReport, guesses, confirmResults);
  return { report, inventory, matchReport, guesses, confirmResults, apkEvidence };
}

export type { DepsReport } from "./report.ts";
export { formatReportText, packageJsonDependencies } from "./report.ts";
