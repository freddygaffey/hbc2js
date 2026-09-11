// src/readability/scope.ts -- spec 28 section 7's "src/" scope: which
// bytecode functions belong to a module the segregation classifier (spec 08,
// `src/split/segregate.ts`) buckets as `src` (app code), as opposed to
// `node_modules`/`unclassified`. `tools/readability/record.ts`'s `--only src`
// flag uses this to bound the held-out-app recording to the coverage
// target's own population (spec 28 section 7: "src/ registers"/"src/
// modules") instead of walking the whole bundle (~15k functions on the
// held-out app).
//
// Deliberately the SAME call path `hbc2js segregate` and
// `tests/gate/split/segregate.test.ts`'s own react-navigation-example-0.85.3
// acceptance tests use: `splitProject` then `segregateSplitTree`, with a
// local (`--offline`) `runDeps` for the classification report -- no network,
// no model call, so this is safe for the gate and for a dry run alike.
// `runDeps({ offline: true })` never queries the npm registry (`src/deps/
// guess.ts`'s own comment: "network only, callers gate on --offline").
import { runDeps } from "../deps/index.ts";
import { splitProject } from "../split/index.ts";
import { segregateSplitTree } from "../split/segregate.ts";
import type { HbcModule } from "../parse/types.ts";
import type { ModuleAnalysis } from "../cfg/types.ts";

export interface SrcScope {
  /** Reused by the caller instead of a second parse+analyse pass --
   *  `splitProject` already builds both with the same `{strictEnv: false}`
   *  options `tools/readability/record.ts` used before this module existed. */
  readonly module: HbcModule;
  readonly analysis: ModuleAnalysis;
  /** Bytecode function indices that belong to a `src`-bucket module --
   *  the module's own factory AND every nested closure printed inside it
   *  (`SplitResult.functionRanges`), since a closure's registers are just as
   *  much "src/ registers" as its enclosing module's. */
  readonly srcFns: ReadonlySet<number>;
  readonly srcModuleCount: number;
  readonly totalModuleCount: number;
}

export interface ComputeSrcScopeOptions {
  readonly moduleName?: string;
}

/** `hbcPath` is needed (not just `bytes`) because `runDeps` reads the bundle
 *  from disk itself (spec 08's deps pipeline; it also re-runs hermesc-backed
 *  steps that need a real file path, gated off here by `offline: true`). */
export async function computeSrcScope(hbcPath: string, bytes: Uint8Array, opts: ComputeSrcScopeOptions = {}): Promise<SrcScope> {
  const split = splitProject(bytes, opts.moduleName !== undefined ? { moduleName: opts.moduleName } : {});
  const depsRun = await runDeps(hbcPath, { offline: true });
  const seg = segregateSplitTree(split.files, depsRun.report);

  const srcModuleIds = new Set(seg.modules.filter((m) => m.bucket === "src").map((m) => m.id));
  const fileToModuleId = new Map(split.modules.map((m) => [m.file, m.id]));

  const srcFns = new Set<number>();
  for (const [fn, range] of split.functionRanges) {
    const moduleId = fileToModuleId.get(range.file);
    if (moduleId !== undefined && srcModuleIds.has(moduleId)) srcFns.add(fn);
  }

  return {
    module: split.module,
    analysis: split.analysis,
    srcFns,
    srcModuleCount: srcModuleIds.size,
    totalModuleCount: seg.modules.length,
  };
}
