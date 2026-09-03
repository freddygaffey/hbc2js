// src/artifact/write.ts — writes the P2.1 artifact (manifest + semantic index
// files built so far) to disk. §1 layout, §1.3 immutability (E4).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { SplitResult } from "../split/index.ts";
import { analyseForArtifact, buildFactoryInfo, buildFunctionsIndex, buildManifest, buildModulesIndex, buildRangesIndex, computeFnOwnership } from "./build.ts";
import { buildNativeIndex } from "./native.ts";
import { buildSemanticIndexes } from "./semantic-walk.ts";
import { indexHeader, rangesHeader, sha256Hex, toJsonl, type Manifest } from "./schema.ts";
import { buildStringsIndex } from "./strings.ts";

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
  /** §1.2 `render.overlayHash` (§4.2 staleness): path to the Design-D
   *  overlay store file in scope for this render (the same path
   *  `ArtifactService`'s `opts.overlayStorePath` is later constructed with).
   *  When given and the file exists, its content is sha256-hashed into
   *  `manifest.render.overlayHash`; omitted or missing -> `null` (no overlay
   *  store was in scope for this render — the honest v1 default before this
   *  option was wired, docs/BUGS.md 2026-09-03 "overlayHash always null"). */
  readonly overlayStorePath?: string;
}

export interface WrittenArtifact {
  readonly manifest: Manifest;
  readonly functionCount: number;
  readonly moduleCount: number;
  readonly rangeCount: number;
  readonly callCount: number;
  readonly stringCount: number;
  readonly stringUseCount: number;
  readonly globalCount: number;
  readonly nativeCount: number;
  /** `?`-callee count and their `why` classes (the honesty measure, §8's
   *  landing-report requirement). */
  readonly unknownCallees: Readonly<Record<string, number>>;
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

  const { module, analysis, parents } = analyseForArtifact(opts.bytes, { module: opts.splitResult.module, analysis: opts.splitResult.analysis });
  const ownership = computeFnOwnership(module, parents, opts.splitResult.modules);
  const functionRows = buildFunctionsIndex(module, parents, ownership);
  const modulesIndex = buildModulesIndex(opts.splitResult, ownership);
  const factoryInfo = buildFactoryInfo(module, opts.splitResult.modules);

  const { callRows, globalRows, stringUseRows } = buildSemanticIndexes(module, analysis, factoryInfo);
  const stringsIndex = buildStringsIndex(module);
  const nativeRows = buildNativeIndex(callRows, globalRows);

  const functionsJsonl = toJsonl(indexHeader("functions"), functionRows);
  const modulesJson = JSON.stringify(modulesIndex, null, 2) + "\n";
  const callsJsonl = toJsonl(indexHeader("calls"), callRows);
  const stringsJson = JSON.stringify(stringsIndex, null, 2) + "\n";
  const stringUsesJsonl = toJsonl(indexHeader("string-uses"), stringUseRows);
  const globalsJsonl = toJsonl(indexHeader("globals"), globalRows);
  const nativeJsonl = toJsonl(indexHeader("native"), nativeRows);

  const semanticFiles = new Map<string, string>([
    ["index/functions.jsonl", functionsJsonl],
    ["index/modules.json", modulesJson],
    ["index/calls.jsonl", callsJsonl],
    ["index/strings.json", stringsJson],
    ["index/string-uses.jsonl", stringUsesJsonl],
    ["index/globals.jsonl", globalsJsonl],
    ["index/native.jsonl", nativeJsonl],
  ]);

  const rangeRows = buildRangesIndex(opts.splitResult.functionRanges);

  const overlayHash = opts.overlayStorePath !== undefined && existsSync(opts.overlayStorePath) ? sha256Hex(readFileSync(opts.overlayStorePath, "utf8")) : null;

  const manifest = buildManifest({
    bytes: opts.bytes,
    module,
    splitResult: opts.splitResult,
    passes: opts.passes,
    strictEnv: opts.strictEnv,
    form: opts.form,
    semanticFiles,
    overlayHash,
    ...(opts.git !== undefined ? { git: opts.git } : {}),
  });

  const rangesJsonl = toJsonl(rangesHeader(manifest.render.hash), rangeRows);

  mkdirSync(join(opts.outDir, "index"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(opts.outDir, "index", "functions.jsonl"), functionsJsonl);
  writeFileSync(join(opts.outDir, "index", "modules.json"), modulesJson);
  writeFileSync(join(opts.outDir, "index", "ranges.jsonl"), rangesJsonl);
  writeFileSync(join(opts.outDir, "index", "calls.jsonl"), callsJsonl);
  writeFileSync(join(opts.outDir, "index", "strings.json"), stringsJson);
  writeFileSync(join(opts.outDir, "index", "string-uses.jsonl"), stringUsesJsonl);
  writeFileSync(join(opts.outDir, "index", "globals.jsonl"), globalsJsonl);
  writeFileSync(join(opts.outDir, "index", "native.jsonl"), nativeJsonl);

  const unknownCallees: Record<string, number> = {};
  for (const c of callRows) {
    if (c.callee !== "?") continue;
    const why = c.why ?? "unknown";
    unknownCallees[why] = (unknownCallees[why] ?? 0) + 1;
  }

  return {
    manifest,
    functionCount: functionRows.length,
    moduleCount: modulesIndex.modules.length,
    rangeCount: rangeRows.length,
    callCount: callRows.length,
    stringCount: stringsIndex.entries.length,
    stringUseCount: stringUseRows.length,
    globalCount: globalRows.length,
    nativeCount: nativeRows.length,
    unknownCallees,
  };
}
