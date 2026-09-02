// src/artifact/write.ts — writes the P2.1 artifact (manifest + semantic index
// files built so far) to disk. §1 layout, §1.3 immutability (E4).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { SplitResult } from "../split/index.ts";
import { analyseForArtifact, buildFunctionsIndex, buildManifest, buildModulesIndex, computeFnOwnership } from "./build.ts";
import { indexHeader, toJsonl, type Manifest } from "./schema.ts";

export interface WriteArtifactOptions {
  readonly bytes: Uint8Array;
  readonly splitResult: SplitResult;
  readonly outDir: string;
  readonly passes: unknown;
  readonly strictEnv: boolean;
  readonly form: "segregated" | "flat";
  /** §1.3/§10 E4: re-decompiling into a directory that already holds an
   *  artifact is refused unless explicit — an old artifact must stay
   *  internally consistent for anyone still holding it. */
  readonly overwrite?: boolean;
  readonly git?: string | null;
}

export interface WrittenArtifact {
  readonly manifest: Manifest;
  readonly functionCount: number;
  readonly moduleCount: number;
}

/** Builds and writes `manifest.json` + `index/functions.jsonl` +
 *  `index/modules.json` (§8 steps 1–2) into `opts.outDir`, alongside the
 *  already-written split tree. Refuses to overwrite an existing artifact
 *  directory without `overwrite: true` (E4). */
export function writeArtifact(opts: WriteArtifactOptions): WrittenArtifact {
  const manifestPath = join(opts.outDir, "manifest.json");
  if (existsSync(manifestPath) && opts.overwrite !== true) {
    throw new Hbc2jsError(
      ErrorCode.E_IO,
      `${opts.outDir} already holds an artifact (manifest.json exists); re-decompile refuses to overwrite an ` +
        `existing artifact directory by default (docs/specs/10-artifact-format.md §1.3/§10 E4) — pass --overwrite, ` +
        `or decompile into a fresh directory so the old artifact stays internally consistent for anyone still holding it`,
    );
  }

  const { module, parents } = analyseForArtifact(opts.bytes);
  const ownership = computeFnOwnership(module, parents, opts.splitResult.modules);
  const functionRows = buildFunctionsIndex(module, parents, ownership);
  const modulesIndex = buildModulesIndex(opts.splitResult, ownership);

  const functionsJsonl = toJsonl(indexHeader("functions"), functionRows);
  const modulesJson = JSON.stringify(modulesIndex, null, 2) + "\n";

  const semanticFiles = new Map<string, string>([
    ["index/functions.jsonl", functionsJsonl],
    ["index/modules.json", modulesJson],
  ]);

  const manifest = buildManifest({
    bytes: opts.bytes,
    module,
    splitResult: opts.splitResult,
    passes: opts.passes,
    strictEnv: opts.strictEnv,
    form: opts.form,
    semanticFiles,
    ...(opts.git !== undefined ? { git: opts.git } : {}),
  });

  mkdirSync(join(opts.outDir, "index"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(opts.outDir, "index", "functions.jsonl"), functionsJsonl);
  writeFileSync(join(opts.outDir, "index", "modules.json"), modulesJson);

  return { manifest, functionCount: functionRows.length, moduleCount: modulesIndex.modules.length };
}
