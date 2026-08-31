// src/split/index.ts — D17i stage 1 (ISOLATE): turn a decompiled Metro bundle
// into a project tree, one file per `__d(factory, id, deps)` registration,
// with `require()` edges restored (docs/DECISIONS.md D17i point 1, D19).
//
// Module boundaries come from `src/deps/inventory.ts` (structural, via
// `dscan.ts`'s bytecode-level `__d()` scan — never by decompiling
// everything, D17a). Each module's *body* comes from one full-module
// decompile that runs through the exact same M5 pass pipeline as the normal
// path (`src/decompile.ts`'s `decompile()`): same `REGISTRY`, same order,
// same `SplitOptions.passes`/`--no-pass`/`--passes=none` opt-out, wired via
// the same `passHook`/`astPassHook` helpers (spec 07) — no separate
// pass-wiring code lives here. The structurer's isomorphism verifier stays
// off (`structure: { verify: false }`): that check is orthogonal to
// readability and expensive on a real app, and it is unrelated to what this
// module's own tests assert. Readability passes make full-bundle decompiles
// meaningfully slower (docs/STATUS.md's M5 call-shape note — 4199-function
// bundles are excluded from the *gate's* time budget with passes on), which
// is why `tests/gate/split/split.test.ts`'s structural checks pass
// `{ none: true }` explicitly and the passes-on behaviour proven by
// `tests/gate/decompile/split-passes.test.ts` only asserts a couple of
// modules rather than re-running the whole file's assertions with passes on.
// The consequence of the M4 baseline (`{ none: true }`) is that every call in
// the emitted files is still `Reflect.apply(callee, this, args)` *except* the
// specific `require(dependencyMap[i])` calls src/split/rewrite.ts recognises
// and rewrites to a real `require('./module_<id>.js')` — with passes on,
// call-shape/expr-rebuild/etc. clean that up exactly as they do on the normal
// path.
import { analyseModule } from "../cfg/index.ts";
import { buildInventoryFromModule } from "../deps/inventory.ts";
import type { Stmt } from "../emit/ast.ts";
import { emitModule } from "../emit/index.ts";
import { printProgram } from "../emit/print.ts";
import { parseHbc } from "../parse/module.ts";
import type { HbcModule } from "../parse/types.ts";
import { astPassHook, passHook } from "../passes/index.ts";
import type { PassPipelineOptions } from "../passes/index.ts";
import { resolveEntryModuleId } from "./entry.ts";
import { rewriteFactoryBody } from "./rewrite.ts";

export interface SplitModuleInfo {
  readonly id: number;
  readonly file: string;
  readonly factoryFunctionIndex: number;
  readonly deps: readonly number[];
  readonly requireRewrites: number;
}

export interface SplitResult {
  readonly files: ReadonlyMap<string, string>;
  readonly modules: readonly SplitModuleInfo[];
  readonly entryModuleId: number | null;
  readonly diagnostics: readonly string[];
}

export interface SplitOptions {
  readonly moduleName?: string;
  /**
   * Spec 07's pass pipeline, wired exactly as `src/decompile.ts`'s
   * `decompile()` wires it (same `passHook`/`astPassHook` helpers, same
   * `REGISTRY`, same order). Every registered pass runs by default;
   * `{ none: true }` is `--passes=none`, `{ skip: [...] }` is `--no-pass`.
   */
  readonly passes?: PassPipelineOptions;
}

function isFuncStmt(s: Stmt | undefined): s is Extract<Stmt, { k: "func" }> {
  return s !== undefined && s.k === "func";
}

/** Decompile every function once (isomorphism verify off — see the file
 *  header) and hand back each function's own top-level JS AST, keyed by
 *  function index, exactly as `decompileAst` does internally (spec 07 F1):
 *  `passHook`/`astPassHook` build the same stage-A/stage-B hooks
 *  `src/decompile.ts` uses, so the split path runs through the identical
 *  pass pipeline instead of a second, hand-rolled wiring. */
function decompileAllBodies(module: HbcModule, passes: PassPipelineOptions = {}): ReadonlyMap<number, Extract<Stmt, { k: "func" }>> {
  const analysis = analyseModule(module, { strictEnv: false });
  const bodies = new Map<number, Extract<Stmt, { k: "func" }>>();
  const astHook = astPassHook(analysis, passes);
  emitModule(analysis, {
    moduleName: "input.hbc",
    provenanceComments: false,
    strictEnv: false,
    structure: { verify: false },
    passes: passHook(analysis, passes),
    astPasses: (fn, cfg) => {
      const passed = astHook(fn, cfg);
      if (passed.fn.k === "func") bodies.set(cfg.functionIndex, passed.fn);
      return passed;
    },
  });
  return bodies;
}

function fileNameFor(moduleId: number): string {
  return `module_${moduleId}.js`;
}

export function splitProject(bytes: Uint8Array, opts: SplitOptions = {}): SplitResult {
  const module = parseHbc(bytes);
  const inventory = buildInventoryFromModule(module);
  const bodies = decompileAllBodies(module);

  const diagnostics: string[] = [];
  const files = new Map<string, string>();
  const modules: SplitModuleInfo[] = [];

  const known = new Set<number>();
  for (const m of inventory.modules) if (m.localModuleId !== null) known.add(m.localModuleId);

  for (const m of inventory.modules) {
    const id = m.localModuleId;
    if (id === null) {
      diagnostics.push(`factory fn#${m.factoryFunctionIndex} has no resolved local module id; skipped`);
      continue;
    }
    const fnStmt = bodies.get(m.factoryFunctionIndex);
    const depIds = (m.depIds ?? []).filter((d) => known.has(d));
    if (!isFuncStmt(fnStmt)) {
      diagnostics.push(`module ${id}: factory fn#${m.factoryFunctionIndex} was not emitted; wrote an empty stub`);
      const file = fileNameFor(id);
      files.set(file, `// hbc2js --split -- module ${id}: factory fn#${m.factoryFunctionIndex} was not reachable from the module graph\nmodule.exports = {};\n`);
      modules.push({ id, file, factoryFunctionIndex: m.factoryFunctionIndex, deps: depIds, requireRewrites: 0 });
      continue;
    }
    const { body, rewrites } = rewriteFactoryBody(fnStmt.body, fnStmt.params, m.depIds ?? []);
    const funcText = printProgram([{ ...fnStmt, name: "factory", body }]);
    const file = fileNameFor(id);
    files.set(file, `// hbc2js --split -- Metro module ${id} (source fn#${m.factoryFunctionIndex}, ${opts.moduleName ?? "input.hbc"})\n${funcText}\nmodule.exports = factory;\n`);
    modules.push({ id, file, factoryFunctionIndex: m.factoryFunctionIndex, deps: depIds, requireRewrites: rewrites });
  }
  modules.sort((a, b) => a.id - b.id);

  const globalFn = bodies.get(module.header.globalCodeIndex);
  const entryModuleId = isFuncStmt(globalFn) ? resolveEntryModuleId(globalFn.body) : null;
  if (entryModuleId === null || !known.has(entryModuleId)) {
    diagnostics.push(`could not resolve an entry module id from the global function's __r() call`);
  }

  const resolvedEntry = entryModuleId !== null && known.has(entryModuleId) ? entryModuleId : null;
  files.set("index.js", resolvedEntry !== null ? `// hbc2js --split -- entry point (Metro module ${resolvedEntry})\nmodule.exports = require('./${fileNameFor(resolvedEntry)}');\n` : `// hbc2js --split -- entry module id could not be resolved; see MODULES.json's "entry"\n`);

  files.set(
    "MODULES.json",
    JSON.stringify(
      {
        hbcVersion: module.header.version,
        moduleCount: modules.length,
        entry: resolvedEntry,
        modules: modules.map((m) => ({ id: m.id, file: m.file, factoryFunctionIndex: m.factoryFunctionIndex, deps: m.deps })),
      },
      null,
      2,
    ) + "\n",
  );

  return { files, modules, entryModuleId: resolvedEntry, diagnostics };
}
