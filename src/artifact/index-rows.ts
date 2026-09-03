// src/artifact/index-rows.ts — §8 step 2 (docs/specs/16-project-db.md §2.4,
// §4.1): the same row builders `src/artifact/write.ts` uses to emit
// `index/*.jsonl`, orchestrated once so a second sink (the project DB's
// `ix_*` tables, `src/projdb/ix-write.ts`) can consume the exact same rows
// without re-deriving them. "the extractors are reused verbatim, only the
// sink changes" (§4.1 step 3) — this file IS that reuse point; it duplicates
// none of `write.ts`'s builder calls' logic, only the orchestration glue
// (which stays intentionally trivial so the two call sites cannot diverge in
// substance, only in what they do with the result).
import { existsSync, readFileSync } from "node:fs";
import type { SplitResult } from "../split/index.ts";
import { analyseForArtifact, buildFactoryInfo, buildFunctionsIndex, buildManifest, buildModulesIndex, buildRangesIndex, computeFnOwnership } from "./build.ts";
import { buildNativeIndex } from "./native.ts";
import { buildSemanticIndexes } from "./semantic-walk.ts";
import { sha256Hex, type CallRow, type FunctionRow, type GlobalRow, type Manifest, type ModulesIndex, type NativeRow, type RangeRow, type StringsIndex, type StringUseRow } from "./schema.ts";
import { buildStringsIndex } from "./strings.ts";

export interface BuildIndexRowsOptions {
  readonly bytes: Uint8Array;
  readonly splitResult: SplitResult;
  readonly passes: unknown;
  readonly strictEnv: boolean;
  readonly form: "segregated" | "flat";
  readonly git?: string | null;
  readonly overlayStorePath?: string;
}

export interface IndexRows {
  readonly manifest: Manifest;
  readonly functionRows: readonly FunctionRow[];
  readonly modulesIndex: ModulesIndex;
  readonly callRows: readonly CallRow[];
  readonly stringsIndex: StringsIndex;
  readonly stringUseRows: readonly StringUseRow[];
  readonly globalRows: readonly GlobalRow[];
  readonly nativeRows: readonly NativeRow[];
  readonly rangeRows: readonly RangeRow[];
}

/** Builds every §2 index row + the `manifest.json` shape from `opts`,
 *  independent of whichever sink (JSONL files, `write.ts`; DB rows,
 *  `src/projdb/ix-write.ts`) consumes them next. */
export function buildIndexRows(opts: BuildIndexRowsOptions): IndexRows {
  const { module, analysis, parents } = analyseForArtifact(opts.bytes, { module: opts.splitResult.module, analysis: opts.splitResult.analysis });
  const ownership = computeFnOwnership(module, parents, opts.splitResult.modules);
  const functionRows = buildFunctionsIndex(module, parents, ownership);
  const modulesIndex = buildModulesIndex(opts.splitResult, ownership);
  const factoryInfo = buildFactoryInfo(module, opts.splitResult.modules);

  const { callRows, globalRows, stringUseRows } = buildSemanticIndexes(module, analysis, factoryInfo);
  const stringsIndex = buildStringsIndex(module);
  const nativeRows = buildNativeIndex(callRows, globalRows);
  const rangeRows = buildRangesIndex(opts.splitResult.functionRanges);

  // Empty on purpose: `manifest.index.semanticHash` (over `index/*.jsonl`
  // content) has no DB-path analogue — the DB sink never serialises JSONL —
  // so callers of `buildIndexRows` must not read `manifest.index.semanticHash`
  // for anything; every field the project-DB `meta` stratum actually needs
  // (`bundle`, `producer`, `render.hash`) is unaffected by this map's content.
  const semanticFiles = new Map<string, string>();
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

  return { manifest, functionRows, modulesIndex, callRows, stringsIndex, stringUseRows, globalRows, nativeRows, rangeRows };
}
