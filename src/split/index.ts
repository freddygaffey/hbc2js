// src/split/index.ts — D17i stage 1 (ISOLATE): turn a decompiled Metro bundle
// into a project tree, one file per `__d(factory, id, deps)` registration,
// with `require()` edges restored (docs/DECISIONS.md D17i point 1, D19).
//
// Module boundaries come from `src/deps/inventory.ts` (structural, via
// `dscan.ts`'s bytecode-level `__d()` scan — never by decompiling
// everything, D17a). Each module's *body* comes from one full-module
// decompile with passes and the structurer's isomorphism verifier both
// switched off: readability passes used to make this ~150x slower on a real app (fixed 2026-08-31, PUSHBACK P-1: now ≈7x — the default here can be revisited)
// (docs/STATUS.md's M5 call-shape note — 4199-function bundles are excluded
// from the gate's time budget with passes on) and stage 1 only needs a
// structurally faithful split, not readable output; classify/name (D17i
// stages 2/3) and the readability ladder both operate on this tree later.
// The consequence: every call in the emitted files is still the M4 baseline's
// `Reflect.apply(callee, this, args)` shape *except* the specific
// `require(dependencyMap[i])` calls src/split/rewrite.ts recognises and
// rewrites to a real `require('./module_<id>.js')` — good enough to prove
// the require graph, not a readability pass.
import { analyseModule } from "../cfg/index.ts";
import { buildInventoryFromModule } from "../deps/inventory.ts";
import type { Stmt } from "../emit/ast.ts";
import { emitModule } from "../emit/index.ts";
import { printProgram } from "../emit/print.ts";
import { parseHbc } from "../parse/module.ts";
import type { HbcModule } from "../parse/types.ts";
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
}

function isFuncStmt(s: Stmt | undefined): s is Extract<Stmt, { k: "func" }> {
  return s !== undefined && s.k === "func";
}

/** Decompile every function once (no passes, no isomorphism verify — see the
 *  file header) and hand back each function's own top-level JS AST, keyed by
 *  function index, exactly as `decompileAst` does internally (spec 07 F1) but
 *  without running the pass pipeline. */
function decompileAllBodies(module: HbcModule): ReadonlyMap<number, Extract<Stmt, { k: "func" }>> {
  const analysis = analyseModule(module, { strictEnv: false });
  const bodies = new Map<number, Extract<Stmt, { k: "func" }>>();
  emitModule(analysis, {
    moduleName: "input.hbc",
    provenanceComments: false,
    strictEnv: false,
    structure: { verify: false },
    astPasses: (fn, cfg) => {
      if (fn.k === "func") bodies.set(cfg.functionIndex, fn);
      return { fn, diagnostics: [] };
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
