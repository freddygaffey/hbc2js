// docs/specs/05-emitter.md §2, §6, §9, §10 — module emission.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";
import type { FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import { structure } from "../structure/index.ts";
import type { StructureOptions, StructuredFunction } from "../structure/index.ts";
import { getBuiltinTable } from "../tables/registry.ts";
import { helperPrelude } from "../runtime/helpers.ts";
import type { Stmt } from "./ast.ts";
import { id, lit } from "./ast.ts";
import { emitFunction, envDeclaringFunction, ownedEnvSlots } from "./function.ts";
import { checkBindings } from "./scope-check.ts";
import { printProgram } from "./print.ts";

export * from "./ast.ts";
export { printProgram } from "./print.ts";

export interface EmitOptions {
  /** Emit `"use strict"` per function when FunctionFlags.strictMode. Default true. */
  readonly strictDirectives?: boolean;
  /** Include `// fn#N @0x…` provenance comments. Default true. */
  readonly provenanceComments?: boolean;
  readonly helpers?: "inline" | "import";
  /** Spec 03 §6.4's R3 rule. Default true; false is `--lenient-env`. */
  readonly strictEnv?: boolean;
  readonly indent?: string;
  readonly moduleName?: string;
  readonly structure?: StructureOptions;
  /**
   * Spec 07's pass pipeline, run on every function's tree IR between the
   * structurer and emission. src/passes/index.ts `passHook` builds it; absent
   * (the M4 baseline) nothing runs.
   */
  readonly passes?: (fn: StructuredFunction, cfg: FunctionCfg) => { readonly fn: StructuredFunction; readonly diagnostics: readonly Diagnostic[] };
}

export interface LineMapEntry {
  readonly line: number;
  readonly functionIndex: number;
  readonly offset: number;
}

export interface EmitResult {
  readonly code: string;
  readonly helpersUsed: readonly string[];
  readonly lineMap: readonly LineMapEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

/** True when `block` lies on a cycle of the normal graph. */
function inCycle(cfg: import("../cfg/types.ts").FunctionCfg, block: number): boolean {
  const seen = new Set<number>();
  const stack = [...cfg.blocks[block]!.succs.map((e) => e.to)];
  while (stack.length > 0) {
    const b = stack.pop()!;
    if (b === block) return true;
    if (seen.has(b)) continue;
    seen.add(b);
    for (const e of cfg.blocks[b]!.succs) stack.push(e.to);
  }
  return false;
}

export function emitModule(analysis: ModuleAnalysis, opts: EmitOptions = {}): EmitResult {
  const mod = analysis.module;
  const provenanceComments = opts.provenanceComments ?? true;
  // Spec 03 §6.4's R3 rule, restated at emit time. Default strict; the CLI's
  // `--lenient-env` turns each unresolvable access into a loud marker instead
  // of refusing the module (review M4-H2).
  const strictEnv = opts.strictEnv ?? true;
  const indent = opts.indent ?? "  ";
  const diagnostics: Diagnostic[] = [];
  const envGraph = analysis.envGraph;
  const globalIndex = mod.header.globalCodeIndex;

  const builtinId = mod.layout.builtinTable;
  if (builtinId === undefined) {
    throw new Hbc2jsError(ErrorCode.E_UNSUPPORTED_VERSION, `no builtin table for bytecode version ${mod.header.version}`, { section: "emit" });
  }
  const builtins = getBuiltinTable(builtinId);

  // §6 "Function nesting": `_fn<n>` is emitted inside the function that owns its
  // `closureEnvOf` environment, so JS closure capture does the work and no
  // environment object exists at runtime. A function with no known creation site
  // is emitted at top level with a comment (W_ORPHAN_FUNCTION).
  const parentOf = new Map<number, number | null>();
  for (let i = 0; i < mod.functions.length; i++) {
    if (i === globalIndex) {
      parentOf.set(i, null);
      continue;
    }
    const env = envGraph.closureEnvOf.get(i);
    if (env === undefined || env === null) {
      parentOf.set(i, null);
      continue;
    }
    parentOf.set(i, envGraph.nodes[env]!.ownerFunction);
  }
  // Break any cycle (never observed, but a cycle would be an infinite emission).
  for (const [child] of parentOf) {
    const seen = new Set<number>([child]);
    let cur = parentOf.get(child) ?? null;
    while (cur !== null) {
      if (seen.has(cur)) {
        diagnostics.push({ severity: "warn", code: "W_CLOSURE_CYCLE", message: `function ${child}'s lexical parent chain is cyclic; emitting it at top level`, context: { functionIndex: child } });
        parentOf.set(child, null);
        break;
      }
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
  }

  const childrenOf = new Map<number, number[]>();
  for (const [child, parent] of parentOf) {
    if (parent === null || child === globalIndex) continue;
    const list = childrenOf.get(parent);
    if (list === undefined) childrenOf.set(parent, [child]);
    else list.push(child);
  }
  for (const l of childrenOf.values()) l.sort((a, b) => a - b);

  const isAncestor = (candidate: number, of: number): boolean => {
    let cur: number | null = of;
    const seen = new Set<number>();
    while (cur !== null && !seen.has(cur)) {
      if (cur === candidate) return true;
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return false;
  };
  const declaringFunction = envDeclaringFunction(envGraph, isAncestor);

  const usedHelpers = new Set<string>();
  const useHelper = (name: string): void => {
    usedHelpers.add(name);
  };

  // §6 note: an environment created *inside a loop* is a fresh record per
  // iteration, so its slots cannot be one function-top `let`. Such an env gets
  // its declaration at the `Create*Environment` instruction (a `let` in the loop
  // body's own block scope), and every closure created with it is emitted as a
  // function *expression* at its `CreateClosure` site so it captures that
  // iteration's bindings. The fallback stays available: if any access to the
  // slot happens in a different block, the ordinary hoisted form is used, since
  // the inline declaration would not be in scope there.
  const loopLocal = new Map<number, Map<number, string[]>>(); // fn -> createOffset -> slot names
  const inlineFunctions = new Set<number>();
  for (const node of envGraph.nodes) {
    const owner = node.ownerFunction;
    if ((declaringFunction.get(node.id) ?? owner) !== owner) continue;
    let cfg;
    try {
      cfg = analysis.cfg(owner);
    } catch {
      continue;
    }
    const createBlock = cfg.blocks.find((b) => b.start >= 0 && node.createOffset >= b.start && node.createOffset < b.end);
    if (createBlock === undefined) continue;
    if (!inCycle(cfg, createBlock.id)) continue;
    const accesses = envGraph.slots.filter((s) => s.env === node.id).flatMap((s) => s.accesses);
    const outside = accesses.some((a) => a.functionIndex === owner && !(a.offset >= createBlock.start && a.offset < createBlock.end));
    if (outside) {
      diagnostics.push({
        severity: "warn",
        code: "W_LOOP_LOCAL_ENV",
        message: `environment ${node.id} is created inside a loop but accessed outside its creating block; it keeps one binding per activation`,
        context: { functionIndex: owner, offset: node.createOffset },
      });
      continue;
    }
    let maxSlot = node.size - 1;
    for (const s of envGraph.slots) if (s.env === node.id && s.slot > maxSlot) maxSlot = s.slot;
    const names: string[] = [];
    for (let i = 0; i <= maxSlot; i++) names.push(`_e${node.id}_${i}`);
    const perFn = loopLocal.get(owner) ?? new Map<number, string[]>();
    perFn.set(node.createOffset, names);
    loopLocal.set(owner, perFn);
    for (const child of node.closures) inlineFunctions.add(child);
  }

  const emitted = new Set<number>();
  const emitOne = (index: number): Stmt => {
    if (emitted.has(index)) {
      throw new Hbc2jsError(ErrorCode.E_INTERNAL, `function ${index} emitted twice`, { functionIndex: index, section: "emit" });
    }
    emitted.add(index);
    const cfg = analysis.cfg(index);
    let structured = structure(cfg, opts.structure);
    for (const d of structured.diagnostics) diagnostics.push(d);
    if (opts.passes !== undefined) {
      const passed = opts.passes(structured, cfg);
      structured = passed.fn;
      for (const d of passed.diagnostics) diagnostics.push(d);
    }
    const kids = childrenOf.get(index) ?? [];
    const hoisted: Stmt[] = [];
    const inlined = new Map<number, Stmt>();
    for (const child of kids) {
      const body = emitOne(child);
      if (inlineFunctions.has(child)) inlined.set(child, body);
      else hoisted.push(body);
    }
    return emitFunction({
      analysis,
      envGraph,
      structured,
      cfg,
      fn: analysis.decoded(index),
      builtins,
      children: hoisted,
      inlineChildren: inlined,
      loopLocalEnvSlots: loopLocal.get(index) ?? new Map(),
      ownedEnvSlots: ownedEnvSlots(envGraph, index, declaringFunction).filter((name) => ![...(loopLocal.get(index)?.values() ?? [])].some((names) => names.includes(name))),
      useHelper,
      diagnostic: (d) => diagnostics.push(d),
      provenanceComments,
      strictEnv,
    });
  };

  const globalFn = emitOne(globalIndex);
  const orphans: Stmt[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    if (emitted.has(i)) continue;
    if (parentOf.get(i) !== null) continue;
    orphans.push({ k: "comment", text: `orphan: no closure creation site was found for fn#${i}` });
    orphans.push(emitOne(i));
  }
  for (let i = 0; i < mod.functions.length; i++) {
    if (emitted.has(i)) continue;
    diagnostics.push({ severity: "warn", code: "W_UNEMITTED_FUNCTION", message: `function ${i} was never emitted (its lexical parent was not reachable)`, context: { functionIndex: i } });
    orphans.push(emitOne(i));
  }

  const prelude = helperPrelude(usedHelpers);
  const inner: Stmt[] = [];
  if (prelude.code.length > 0) inner.push({ k: "raw", text: prelude.code });
  inner.push(...orphans);
  inner.push(globalFn);
  // The global function runs with `this` bound to the global object, exactly as
  // the VM invokes it. `.call` is not `.bind`: no function is allocated per call
  // and callee identity is untouched (EM-04).
  // `return` so the wrapper's completion value is the global function's own
  // return value: the trace records a program's result, and discarding it would
  // report `undefined` where the original yields (say) a Promise.
  inner.push({ k: "return", arg: { k: "call", callee: { k: "member", obj: id(`_fn${globalIndex}`), prop: lit("call"), computed: false }, args: [id("globalThis")] } });

  const program: Stmt[] = [
    { k: "comment", text: `hbc2js -- decompiled from ${opts.moduleName ?? "input.hbc"}` },
    { k: "comment", text: `HBC version ${mod.header.version}, layout ${mod.layout.layoutClass}, opcode table ${mod.layout.opcodeTable ?? "?"}` },
    { k: "iife", body: inner },
  ];

  checkBindings(program, prelude.names, globalIndex);

  const code = printProgram(program, { indent });
  return { code, helpersUsed: prelude.names, lineMap: [], diagnostics };
}
