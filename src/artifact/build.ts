// src/artifact/build.ts — P2.1 semantic-layer builders (§8 steps 1–2).
//
// Deliberately re-parses + re-analyses the bundle rather than reusing
// `splitProject`'s internal pass: the index build is its own branch off the
// bytecode in the spec's own diagram (§0), independent of the render branch.
// Keeping the two passes separate is what lets the render be re-run (names
// change) without touching the semantic layer at all (§0's whole point).
import { VERSION } from "../version.ts";
import { analyseModule } from "../cfg/index.ts";
import { parseHbc } from "../parse/module.ts";
import type { HbcModule } from "../parse/types.ts";
import type { SplitResult } from "../split/index.ts";
import type { FactoryInfo } from "./semantic-walk.ts";
import {
  ARTIFACT_SCHEMA,
  hashRenderedFiles,
  sha256Hex,
  type FunctionRow,
  type Manifest,
  type ModuleEntry,
  type ModulesIndex,
  type RangeRow,
} from "./schema.ts";

/** Immediate lexical parent of every function: the function that created the
 *  environment `fn`'s closure captured (`envGraph.closureEnvOf(fn)` -> that
 *  env node's `ownerFunction`). `null` for functions with no known/ambiguous
 *  enclosing environment (global code, orphans — §2.1 `parent`). */
export function computeLexicalParents(module: HbcModule, analysis: ReturnType<typeof analyseModule>): ReadonlyMap<number, number | null> {
  const parents = new Map<number, number | null>();
  for (const fn of module.functions) {
    const idx = fn.header.index;
    const env = analysis.envGraph.closureEnvOf.get(idx) ?? null;
    parents.set(idx, env === null ? null : (analysis.envGraph.nodes[env]?.ownerFunction ?? null));
  }
  return parents;
}

/** §2.1: owning module id of every function — walk the lexical-parent chain
 *  up from `fn` until it lands on a module's factory function (the factory
 *  itself is owned by its own module); `null` if the chain never reaches one
 *  (functions outside any `__d` factory, e.g. the global wrapper). */
export function computeFnOwnership(
  module: HbcModule,
  parents: ReadonlyMap<number, number | null>,
  splitModules: SplitResult["modules"],
): ReadonlyMap<number, number | null> {
  const factoryToModule = new Map<number, number>();
  for (const m of splitModules) factoryToModule.set(m.factoryFunctionIndex, m.id);
  const ownership = new Map<number, number | null>();
  for (const fn of module.functions) {
    const idx = fn.header.index;
    let cur: number | null = idx;
    const seen = new Set<number>();
    let owner: number | null = null;
    while (cur !== null && !seen.has(cur)) {
      const direct = factoryToModule.get(cur);
      if (direct !== undefined) {
        owner = direct;
        break;
      }
      seen.add(cur);
      cur = parents.get(cur) ?? null;
    }
    ownership.set(idx, owner);
  }
  return ownership;
}

const KIND_MAP = { Normal: "normal", Generator: "generator", Async: "async" } as const;

/** §2.1 `functions.jsonl` rows, one per bytecode function, sorted by `fn`
 *  (primary-key sort, §1.1). No `overlayName` (E1) — the query layer joins
 *  the overlay store live. */
export function buildFunctionsIndex(module: HbcModule, parents: ReadonlyMap<number, number | null>, ownership: ReadonlyMap<number, number | null>): FunctionRow[] {
  const rows: FunctionRow[] = [];
  for (const fn of module.functions) {
    const h = fn.header;
    rows.push({
      fn: h.index,
      name: fn.name.length > 0 ? fn.name : null,
      params: h.paramCount,
      module: ownership.get(h.index) ?? null,
      parent: parents.get(h.index) ?? null,
      kind: KIND_MAP[h.flags.kind],
      offset: h.offset,
      size: h.bytecodeSizeInBytes,
    });
  }
  rows.sort((a, b) => a.fn - b.fn);
  return rows;
}

/** §2.6 `modules.json` — re-emits `SplitResult.modules` under the index
 *  schema header; nothing new computed except `fnOwnership` (§2.1's own
 *  computation, reused here so the two files agree by construction).
 *  `segment` is always 0: the current splitter does not do segment-aware
 *  (multi-bundle) splitting yet (M6 future work) — this is the true value
 *  for every artifact this builder can currently produce, not a guess. */
export function buildModulesIndex(splitResult: SplitResult, ownership: ReadonlyMap<number, number | null>): ModulesIndex {
  const modules: ModuleEntry[] = splitResult.modules.map((m) => ({
    id: m.id,
    file: m.file,
    factoryFn: m.factoryFunctionIndex,
    deps: m.deps,
    segment: 0,
  }));
  const fnOwnership: Record<string, number> = {};
  for (const [fn, moduleId] of ownership) if (moduleId !== null) fnOwnership[String(fn)] = moduleId;
  return {
    schema: "hbc2js-index/1",
    kind: "modules",
    renderIndependent: true,
    modules,
    entry: splitResult.entryModuleId,
    fnOwnership,
  };
}

/** §2.7 `ranges.jsonl` rows, sorted by `fn` (§1.1 primary-key sort) — a
 *  direct re-emission of `SplitResult.functionRanges` (`src/split/index.ts`,
 *  populated by the renderer's own `onFunctionRange` hook, `src/emit/
 *  print.ts`) under the index schema. No fabrication for functions the
 *  render never printed (see that map's own doc). */
export function buildRangesIndex(functionRanges: SplitResult["functionRanges"]): RangeRow[] {
  const rows: RangeRow[] = [];
  for (const [fn, r] of functionRanges) rows.push({ fn, file: r.file, lines: r.lines });
  rows.sort((a, b) => a.fn - b.fn);
  return rows;
}

export interface BuildManifestOptions {
  readonly bytes: Uint8Array;
  readonly module: HbcModule;
  readonly splitResult: SplitResult;
  readonly passes: unknown;
  readonly strictEnv: boolean;
  readonly form: "segregated" | "flat";
  readonly semanticFiles: ReadonlyMap<string, string>;
  readonly git?: string | null;
}

/** §1.2 `manifest.json` — the root of trust tying bundle bytes, render and
 *  semantic index together via hashes. */
export function buildManifest(opts: BuildManifestOptions): Manifest {
  const bundleSha256 = sha256Hex(opts.bytes);
  const producer = {
    hbc2js: VERSION,
    git: opts.git ?? null,
    passes: opts.passes,
    strictEnv: opts.strictEnv,
  };
  const renderHash = hashRenderedFiles(opts.splitResult.files);
  const semanticHash = hashRenderedFiles(opts.semanticFiles);
  return {
    schema: ARTIFACT_SCHEMA,
    bundle: {
      sha256: bundleSha256,
      bytes: opts.bytes.length,
      hbcVersion: opts.module.header.version,
      functionCount: opts.module.header.functionCount,
    },
    producer,
    render: {
      hash: renderHash,
      form: opts.form,
      ts: new Date().toISOString(),
      overlayHash: null,
    },
    index: {
      semanticHash,
      builtFor: { bundleSha256, producer: sha256Hex(JSON.stringify(producer)) },
    },
    ...(opts.splitResult.diagnostics.length > 0 ? { degraded: opts.splitResult.diagnostics } : {}),
  };
}

/** §2.2/§2.4 `FactoryInfo` per module factory function: the `require`/
 *  `dependencyMap` param slots (Metro's factory signature is positional —
 *  `require` is always the 2nd declared param, `dependencyMap` the last —
 *  the same convention `src/split/rewrite.ts`'s recogniser relies on) plus
 *  the module's own `deps` array, so `src/artifact/semantic-walk.ts` can
 *  recognise `require(dependencyMap[i])` -> `m:<depIds[i]>` without
 *  reparsing the factory shape a second way. */
export function buildFactoryInfo(module: HbcModule, splitModules: SplitResult["modules"]): ReadonlyMap<number, FactoryInfo> {
  const byIndex = new Map<number, number>();
  for (const fn of module.functions) byIndex.set(fn.header.index, fn.header.paramCount);
  const out = new Map<number, FactoryInfo>();
  for (const m of splitModules) {
    const paramCount = byIndex.get(m.factoryFunctionIndex);
    if (paramCount === undefined) continue;
    out.set(m.factoryFunctionIndex, { requireSlot: 2, depMapSlot: Math.max(0, paramCount - 1), deps: m.deps });
  }
  return out;
}

/** Re-parses + re-analyses `bytes` (deliberately independent of the render
 *  pass, see file header) and returns everything the manifest + step-1/2
 *  index files need. */
export function analyseForArtifact(bytes: Uint8Array): { module: HbcModule; analysis: ReturnType<typeof analyseModule>; parents: ReadonlyMap<number, number | null> } {
  const module = parseHbc(bytes);
  const analysis = analyseModule(module, { strictEnv: false });
  const parents = computeLexicalParents(module, analysis);
  return { module, analysis, parents };
}
