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
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import { parseHbc } from "../parse/module.ts";
import type { HbcModule } from "../parse/types.ts";
import { astPassHook, passHook } from "../passes/index.ts";
import type { PassPipelineOptions } from "../passes/index.ts";
import { helperPrelude } from "../runtime/helpers.ts";
import { resolveEntryModuleId } from "./entry.ts";
import { rewriteFactoryBody } from "./rewrite.ts";

/**
 * `index.js`'s runtime: a Metro-style `__d`/`__r` registry (Gap A) plus the
 * hbc2js helper prelude installed as globals (Gap B), per
 * docs/e2e/STAGE3-FEASIBILITY.md §a/§e option 1.
 *
 * Ordering matters: every `module_<id>.js` is `require()`'d once up front
 * (plain Node CJS load — cheap, just runs the file's top-level `__d(factory,
 * id, deps)` call, registering the *unexecuted* factory) *before* `Module._load`
 * is patched, so that bootstrap loop itself is never rerouted through `__r`
 * — only the `require('./module_N.js')` calls src/split/rewrite.ts left
 * inside factory *bodies* are (those only run once a factory executes, i.e.
 * after the patch is installed). `__r(id)` then lazily runs a factory once,
 * caching the module object *before* invoking the factory (Metro's own
 * circular-dependency protocol: a cycle sees the partially-populated
 * `exports` of the module still executing, not an infinite loop).
 */
function buildLoaderIndexJs(modules: readonly SplitModuleInfo[], resolvedEntry: number | null, helpersUsed: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`// hbc2js --split -- entry point: a Metro-style __d/__r loader.`);
  lines.push(`// See docs/e2e/STAGE3-FEASIBILITY.md for the shape and why.`);
  lines.push(`"use strict";`);
  lines.push(``);

  const prelude = helperPrelude(helpersUsed);
  if (prelude.names.length > 0) {
    lines.push(`// Runtime helper prelude (src/runtime/helpers.ts) -- every module's factory`);
    lines.push(`// references these as bare globals, exactly as the single-file decompile()`);
    lines.push(`// path's prelude does within one shared top-level scope.`);
    lines.push(`Object.assign(globalThis, (function () {`);
    lines.push(prelude.code);
    lines.push(`  return { ${prelude.names.map((n) => `${n}: ${n}`).join(", ")} };`);
    lines.push(`})());`);
    lines.push(``);
  }

  lines.push(`var __hbc_split_registry = new Map();`);
  lines.push(`var __hbc_split_instances = new Map();`);
  lines.push(``);
  lines.push(`function __d(factory, id, deps) {`);
  lines.push(`  __hbc_split_registry.set(id, { factory: factory, deps: deps || [] });`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function __hbc_importDefault(id) {`);
  lines.push(`  var ns = __r(id);`);
  lines.push(`  return ns && ns.__esModule ? ns : { default: ns };`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function __hbc_importAll(id) {`);
  lines.push(`  var ns = __r(id);`);
  lines.push(`  if (ns && ns.__esModule) return ns;`);
  lines.push(`  var copy = {};`);
  lines.push(`  if (ns) for (var key in ns) if (Object.prototype.hasOwnProperty.call(ns, key)) copy[key] = ns[key];`);
  lines.push(`  copy.default = ns;`);
  lines.push(`  return copy;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function __r(id) {`);
  lines.push(`  var inst = __hbc_split_instances.get(id);`);
  lines.push(`  if (inst !== undefined) return inst.exports;`);
  lines.push(`  var entry = __hbc_split_registry.get(id);`);
  lines.push(`  if (entry === undefined) throw new Error("hbc2js split loader: module " + id + " is not registered");`);
  lines.push(`  var mod = { id: id, exports: {} };`);
  lines.push(`  __hbc_split_instances.set(id, mod);`); // cache before running: tolerates circular deps
  lines.push(`  var requireFn = function (depId) { return __r(depId); };`);
  lines.push(`  requireFn.importDefault = __hbc_importDefault;`);
  lines.push(`  requireFn.importAll = __hbc_importAll;`);
  lines.push(`  entry.factory(globalThis, requireFn, __hbc_importDefault, __hbc_importAll, mod, mod.exports, entry.deps);`);
  lines.push(`  // Optional test/instrumentation hook (tests/gate/split/loadable.test.ts):`);
  lines.push(`  // a no-op unless something defines it before requiring index.js.`);
  lines.push(`  if (typeof globalThis.__hbc_split_onModuleRun === "function") globalThis.__hbc_split_onModuleRun(id);`);
  lines.push(`  return mod.exports;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`globalThis.__d = __d;`);
  lines.push(`globalThis.__r = __r;`);
  lines.push(``);
  lines.push(`// Register every module -- runs each file's top-level __d() call only, no`);
  lines.push(`// factory executes yet (module_<id>.js no longer sets module.exports; see`);
  lines.push(`// src/split/index.ts).`);
  for (const m of modules) lines.push(`require('./${m.file}');`);
  lines.push(``);
  lines.push(`// From here on, a factory's own require('./module_N.js') call (the literal`);
  lines.push(`// rewrite src/split/rewrite.ts left in place) must resolve to the module's`);
  lines.push(`// real, *executed* exports, not Node's cached factory function -- intercept`);
  lines.push(`// at the Node module loader level and route it through __r.`);
  lines.push(`var __hbc_split_Module = require("module");`);
  lines.push(`var __hbc_split_origLoad = __hbc_split_Module._load;`);
  lines.push(`__hbc_split_Module._load = function (request, parent, isMain) {`);
  lines.push(`  var m = /^\\.\\/module_(\\d+)\\.js$/.exec(request);`);
  lines.push(`  if (m) return __r(Number(m[1]));`);
  lines.push(`  return __hbc_split_origLoad.apply(this, arguments);`);
  lines.push(`};`);
  lines.push(``);
  lines.push(resolvedEntry !== null ? `module.exports = __r(${resolvedEntry});` : `// entry module id could not be resolved; see MODULES.json's "entry" -- nothing invoked.`);
  lines.push(``);
  return lines.join("\n");
}

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
   * Run the readability pass pipeline (spec 07) on every function before it
   * is written, exactly as `decompile()` does. Default (undefined): no
   * passes — the M4 baseline shape, see the file header. Added for the E2E
   * tier-1 round-trip harness (`tools/e2e/roundtrip-corpus.ts`,
   * docs/TESTING.md "E2E tier 1"), which needs the split tree in both
   * modes; `{}` means "every registered pass at its default".
   */
  readonly passes?: PassPipelineOptions;
  /** D20 `--jsx`: the CLI passes `optIn: ["jsx-recover"]` in `passes` and sets
   *  this so `jsx` nodes print as JSX (`src/emit/print.ts` `PrintOptions.jsx`). */
  readonly jsx?: boolean;
}

function isFuncStmt(s: Stmt | undefined): s is Extract<Stmt, { k: "func" }> {
  return s !== undefined && s.k === "func";
}

/** Decompile every function once (no passes, no isomorphism verify — see the
 *  file header) and hand back each function's own top-level JS AST, keyed by
 *  function index, exactly as `decompileAst` does internally (spec 07 F1) but
 *  without running the pass pipeline. */
interface DecompiledBodies {
  readonly bodies: ReadonlyMap<number, Extract<Stmt, { k: "func" }>>;
  /** The whole module's helper set (`emitModule`'s own `helpersUsed`, EM-03) —
   *  used to build the split tree's shared runtime prelude (Gap B, see
   *  `helperGlobalsPrelude` below): every `__hbc_*` name any module's body
   *  references, computed once from the same single `emitModule` pass this
   *  function already runs (no second traversal). */
  readonly helpersUsed: readonly string[];
}

function decompileAllBodies(module: HbcModule, passes: PassPipelineOptions | undefined, diagnostics: string[]): DecompiledBodies {
  const analysis = analyseModule(module, { strictEnv: false });
  const bodies = new Map<number, Extract<Stmt, { k: "func" }>>();
  const hook = passes !== undefined ? astPassHook(analysis, passes) : undefined;
  let helpersUsed: readonly string[] = [];
  try {
    const result = emitModule(analysis, {
      moduleName: "input.hbc",
      provenanceComments: false,
      strictEnv: false,
      structure: { verify: false },
      ...(passes !== undefined ? { passes: passHook(analysis, passes) } : {}),
      astPasses: (fn, cfg) => {
        const out = hook !== undefined ? hook(fn, cfg) : { fn, diagnostics: [] };
        if (out.fn.k === "func") bodies.set(cfg.functionIndex, out.fn);
        return out;
      },
    });
    helpersUsed = result.helpersUsed;
  } catch (e) {
    // `emitModule`'s module-level scope check (`checkBindings`) runs after
    // every body has already reached this hook, so one function's unbound
    // identifier (docs/BUGS.md 2026-09-01, E_UNBOUND_IDENT on Service NSW)
    // need not take the whole split down: keep the bodies, report it.
    if (!(e instanceof Hbc2jsError) || e.code !== ErrorCode.E_UNBOUND_IDENT) throw e;
    diagnostics.push(`module-level scope check failed after every function was emitted (${e.code}: ${e.message}); bodies kept as emitted`);
  }
  return { bodies, helpersUsed };
}

function fileNameFor(moduleId: number): string {
  return `module_${moduleId}.js`;
}

export function splitProject(bytes: Uint8Array, opts: SplitOptions = {}): SplitResult {
  const module = parseHbc(bytes);
  const inventory = buildInventoryFromModule(module);
  const diagnostics: string[] = [];
  const { bodies, helpersUsed } = decompileAllBodies(module, opts.passes, diagnostics);
  const printOpts = { indent: "  ", jsx: opts.jsx === true };

  const files = new Map<string, string>();
  const modules: SplitModuleInfo[] = [];

  const known = new Set<number>();
  for (const m of inventory.modules) if (m.localModuleId !== null) known.add(m.localModuleId);

  // A module's factory Stmt (`bodies.get(factoryFunctionIndex)`) already embeds,
  // recursively, every descendant function whose lexical parent chain
  // (`envGraph.closureEnvOf`) stays inside the factory (`emitModule`'s
  // `childrenOf`/`inlineFunctions`, either hoisted siblings or inline
  // expressions — both print as `function _fnN(...)`, see `src/emit/print.ts`
  // "func"). But `emitModule`'s per-function closure-env analysis sometimes
  // finds no creation site for a function (an "orphan" — W_ORPHAN_FUNCTION /
  // W_UNEMITTED_FUNCTION) even though the factory's own decompiled body still
  // calls it by name; in the *unsplit* `decompile()` path this is harmless
  // because every function lands in the one shared top-level scope, but a
  // split module file only contains its factory's own subtree, so the
  // reference resolved to nothing and threw `ReferenceError` at runtime
  // (docs/BUGS.md "e2e split unmatched-closure", e.g. react-navigation's
  // module_8.js calling an undeclared `_fn1953`). Fix: after printing a
  // module's factory, scan the printed text for any `_fnN` reference not
  // declared anywhere in it, and pull that function's own body (already
  // decompiled into `bodies` — `decompileAllBodies`'s hook captures every
  // function `emitModule` reaches, orphans included) into the same file as
  // an extra declaration nested inside the factory (a real JS closure, not a
  // file-top-level sibling — see the nesting note further down), transitively
  // (that body may itself reference further undeclared functions). D17i is
  // silent on a function
  // referenced from *two different* modules (this only arises for orphans,
  // which by definition capture no shared closure environment, so duplicating
  // the declaration would be safe, but the design doesn't say to) — so the
  // first module (inventory order) to claim an orphan gets the declaration;
  // later modules record a diagnostic instead of guessing at sharing
  // semantics (docs/PUSHBACK.md P-7).
  const claimedBy = new Map<number, number>();
  const declFnRe = /function _fn(\d+)\(/g;
  const refFnRe = /_fn(\d+)/g;

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
      // Still registers with the loader's `__d` (see `buildLoaderIndexJs`
      // below) so a dependent module's `__r(id)` doesn't throw
      // "not registered" — it gets an empty exports object instead, same as
      // the pre-loader `module.exports = {}` shape this replaces.
      files.set(
        file,
        `// hbc2js --split -- module ${id}: factory fn#${m.factoryFunctionIndex} was not reachable from the module graph\nfunction factory(global, require, importDefault, importAll, module, exports, dependencyMap) {}\n__d(factory, ${id}, ${JSON.stringify(depIds)});\n`,
      );
      modules.push({ id, file, factoryFunctionIndex: m.factoryFunctionIndex, deps: depIds, requireRewrites: 0 });
      continue;
    }
    const { body, rewrites } = rewriteFactoryBody(fnStmt.body, fnStmt.params, m.depIds ?? []);
    const funcText = printProgram([{ ...fnStmt, name: "factory", body }], printOpts);

    // Pull in every function transitively referenced-but-undeclared, so no
    // reference in this file resolves to nothing (see comment above). These
    // become extra function *declarations at the top of the factory's own
    // body* (nested inside `factory`, not file-top-level siblings): a
    // top-level declaration would recompile as a module-scope function
    // (hermesc never emits a `CreateClosure` for it), tripping the E2E
    // harness's closure-tree comparison even harder than the original bug —
    // nesting them inside the factory keeps them "the factory plus every
    // nested function" (`tools/e2e/roundtrip-corpus.ts`'s own framing of what
    // one split module is), which is the closest approximation available
    // without knowing their true original nesting depth (that is the
    // still-open, harder half of docs/BUGS.md "e2e split unmatched-closure":
    // envGraph could not find a closure creation site for them at all).
    const declaredIdx = new Set<number>();
    const extraStmts: Extract<Stmt, { k: "func" }>[] = [];
    const queue: number[] = [];
    const scan = (text: string): void => {
      for (const mm of text.matchAll(declFnRe)) declaredIdx.add(Number(mm[1]));
      for (const mm of text.matchAll(refFnRe)) {
        const idx = Number(mm[1]);
        if (!declaredIdx.has(idx)) queue.push(idx);
      }
    };
    scan(funcText);
    while (queue.length > 0) {
      const idx = queue.shift()!;
      if (declaredIdx.has(idx)) continue;
      const owner = claimedBy.get(idx);
      if (owner !== undefined) {
        declaredIdx.add(idx);
        if (owner !== id) {
          diagnostics.push(
            `module ${id}: fn#${idx} (_fn${idx}) is referenced but was already written into module ${owner}'s split file, not duplicated (D17i has no shared-orphan-closure rule; PUSHBACK P-7)`,
          );
        }
        continue;
      }
      const extraFn = bodies.get(idx);
      if (!isFuncStmt(extraFn)) {
        declaredIdx.add(idx);
        diagnostics.push(`module ${id}: fn#${idx} (_fn${idx}) is referenced but has no emitted body; left undeclared (runtime ReferenceError if reached)`);
        continue;
      }
      claimedBy.set(idx, id);
      extraStmts.push(extraFn);
      scan(printProgram([extraFn], printOpts));
    }

    const finalFnStmt = extraStmts.length > 0 ? { ...fnStmt, name: "factory", body: [...extraStmts, ...body] } : { ...fnStmt, name: "factory", body };
    const finalFuncText = extraStmts.length > 0 ? printProgram([finalFnStmt], printOpts) : funcText;
    const file = fileNameFor(id);
    // `__d(factory, id, deps)` instead of `module.exports = factory` (Gap A,
    // docs/e2e/STAGE3-FEASIBILITY.md §a/§e): registers the factory with the
    // loader (`buildLoaderIndexJs`'s `index.js`) instead of handing back the
    // unexecuted factory function itself — a plain `require('./module_N.js')`
    // from another module's rewritten call site (src/split/rewrite.ts) is
    // intercepted at the `Module._load` level and routed through `__r(id)`,
    // which runs (once, memoised) the factory registered here and returns
    // its real `module.exports`.
    files.set(
      file,
      `// hbc2js --split -- Metro module ${id} (source fn#${m.factoryFunctionIndex}, ${opts.moduleName ?? "input.hbc"})\n${finalFuncText}\n__d(factory, ${id}, ${JSON.stringify(depIds)});\n`,
    );
    modules.push({ id, file, factoryFunctionIndex: m.factoryFunctionIndex, deps: depIds, requireRewrites: rewrites });
  }
  modules.sort((a, b) => a.id - b.id);

  const globalFn = bodies.get(module.header.globalCodeIndex);
  const entryModuleId = isFuncStmt(globalFn) ? resolveEntryModuleId(globalFn.body) : null;
  if (entryModuleId === null || !known.has(entryModuleId)) {
    diagnostics.push(`could not resolve an entry module id from the global function's __r() call`);
  }

  const resolvedEntry = entryModuleId !== null && known.has(entryModuleId) ? entryModuleId : null;
  files.set("index.js", buildLoaderIndexJs(modules, resolvedEntry, helpersUsed));

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
