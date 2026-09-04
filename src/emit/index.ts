// docs/specs/05-emitter.md §2, §6, §9, §10 — module emission.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";
import type { ClosureCopy, FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import { structure } from "../structure/index.ts";
import type { StructureOptions, StructuredFunction } from "../structure/index.ts";
import { getBuiltinTable } from "../tables/registry.ts";
import { helperPrelude } from "../runtime/helpers.ts";
import type { Param, Stmt } from "./ast.ts";
import { id, lit, p } from "./ast.ts";
import { emitFunction, envDeclaringFunction, ownedEnvSlots } from "./function.ts";
import { closureFunctionId } from "./lower.ts";
import { resolveOrphanHosts } from "./placement.ts";
import { fnName, quote } from "./names.ts";
import { checkBindings, collectUnbound, unboundMessage } from "./scope-check.ts";
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
  /** D20 `--jsx`: print `jsx` nodes as JSX instead of lowering them back to
   *  their element-creation call (`src/emit/print.ts` `PrintOptions.jsx`). */
  readonly jsx?: boolean;
  readonly moduleName?: string;
  readonly structure?: StructureOptions;
  /**
   * Spec 07's pass pipeline, run on every function's tree IR between the
   * structurer and emission. src/passes/index.ts `passHook` builds it; absent
   * (the M4 baseline) nothing runs.
   */
  readonly passes?: (fn: StructuredFunction, cfg: FunctionCfg) => { readonly fn: StructuredFunction; readonly diagnostics: readonly Diagnostic[] };
  /**
   * F1's stage-B pipeline, run on the JS AST `emitFunction` just produced —
   * `emitOne` calls it right after `emitFunction(...)` returns and before the
   * parent splices the result in (innermost-function-first, `cfg` in hand),
   * and before `checkBindings` so EM-01 still double-guards every rename.
   * `src/passes/index.ts`'s `astPassHook` builds it; absent, nothing runs.
   */
  readonly astPasses?: (fn: Stmt, cfg: FunctionCfg) => { readonly fn: Stmt; readonly diagnostics: readonly Diagnostic[] };
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
  /**
   * Count of functions whose decompile/emit raised an `Hbc2jsError` and were
   * replaced with a throwing fallback stub (`W_FUNCTION_STUBBED` in
   * `diagnostics`) instead of aborting the whole module — see `emitOne`
   * below. Zero on every fixture; real apps can hit unsupported constructs
   * (docs/BUGS.md, integration/E_EMIT_UNSUPPORTED row).
   */
  readonly stubbedFunctions: number;
}

/**
 * A function's decompile/emit failed with `Hbc2jsError` `err` (e.g.
 * `E_EMIT_UNSUPPORTED` from `shapeKeyFor`; NOT `E_ENV_UNRESOLVED`, which is
 * the strict-env policy refusal and propagates). Per-function isolation (docs/BUGS.md's
 * integration/E_EMIT_UNSUPPORTED row): rather than let one unsupported
 * construct anywhere in a real app abort 100% of the output, stand in a
 * valid JS function with the same name and best-effort arity whose body
 * throws a descriptive `Error`, plus the raw error and (when cheap) the
 * function's own disassembly as comments. A successfully decompiled
 * function is untouched — this only ever replaces the failure path.
 */
function stubFor(analysis: ModuleAnalysis, index: number, err: Hbc2jsError): Stmt {
  const decoded = analysis.decoded(index);
  // Best-effort arity: mirrors `emitFunction`'s `namedParams` computation
  // for the common (non-rest-param) case without needing the builtin table
  // lookup that distinguishes a trailing `copyRestArgs`; a stub's `.length`
  // can therefore be off by one for a variadic function, which is harmless
  // since the stub only ever throws.
  const namedParams = Math.max(0, decoded.header.paramCount - 1);
  const params: Param[] = [];
  for (let i = 1; i <= namedParams; i++) params.push(p(`a${i}`));

  const offset = err.context.offset;
  const message = `hbc2js: could not decompile fn#${index} — ${err.code}${offset !== undefined ? ` at offset ${offset}` : ""}`;
  const body: Stmt[] = [{ k: "comment", text: `fn#${index} ${quote(decoded.name)} -- ISOLATED FAILURE\n${err.message}` }];
  const MAX_DISASM_LINES = 40;
  if (decoded.instructions.length > 0) {
    const shown = decoded.instructions.slice(0, MAX_DISASM_LINES).map((i) => `${i.offset}: ${i.name}`);
    if (decoded.instructions.length > MAX_DISASM_LINES) shown.push(`… ${decoded.instructions.length - MAX_DISASM_LINES} more instruction(s)`);
    body.push({ k: "comment", text: `raw disassembly:\n${shown.join("\n")}` });
  }
  body.push({ k: "throw", arg: { k: "new", callee: id("Error"), args: [lit(quote(message))] } });
  return { k: "func", name: fnName(index), params, body };
}

/**
 * Replace the body of every named function *statement* in `program` whose name
 * is a key of `targets` with a comment + `throw`, in place. Returns the names
 * actually found. Used only by the EM-01 isolation path above; a stub body
 * declares nothing and reads nothing but `Error`, so it can never itself fail
 * the scope check.
 */
function stubFunctionsByName(program: readonly Stmt[], targets: ReadonlyMap<string, readonly string[]>): Set<string> {
  const found = new Set<string>();
  const walk = (body: readonly Stmt[]): void => {
    for (const s of body) {
      switch (s.k) {
        case "func": {
          const reasons = targets.get(s.name);
          if (reasons !== undefined) {
            found.add(s.name);
            (s as unknown as { body: readonly Stmt[] }).body = [
              { k: "comment", text: `${s.name} -- ISOLATED FAILURE (E_UNBOUND_IDENT)\n${reasons.join("\n")}` },
              { k: "throw", arg: { k: "new", callee: id("Error"), args: [lit(quote(`hbc2js: could not decompile ${s.name} -- E_UNBOUND_IDENT`))] } },
            ];
            continue; // its own nested functions went with the body
          }
          walk(s.body);
          continue;
        }
        case "iife":
          walk(s.body);
          continue;
        case "if":
          walk(s.then);
          walk(s.else);
          continue;
        case "while":
        case "do-while":
        case "for":
        case "labeled":
          walk(s.body);
          continue;
        case "try":
          walk(s.block);
          walk(s.handler);
          continue;
        case "switch":
          for (const c of s.cases) walk(c.body);
          continue;
        default:
          continue;
      }
    }
  };
  walk(program);
  return found;
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

  // §6 "Function nesting" (placement, docs/BUGS.md 2026-09-04): an orphan used
  // to be emitted at MODULE level, outside the global function, where nothing
  // any function body declares is in scope — so every `_e<env>_<slot>` its body
  // reads was unbound (481 of them on react-navigation-example). `resolveOrphanHosts`
  // moves each orphan into the function that leaves the fewest names unbound;
  // module level is always in the running, so this can only ever bind more.
  {
    const envsUsedIn = new Map<number, Set<number>>();
    for (const slot of envGraph.slots) {
      for (const access of slot.accesses) {
        if (access.env === null) continue;
        const set = envsUsedIn.get(access.functionIndex);
        if (set === undefined) envsUsedIn.set(access.functionIndex, new Set([access.env]));
        else set.add(access.env);
      }
    }
    let anyOrphanUsesEnv = false;
    for (const [child, parent] of parentOf) {
      if (parent !== null || child === globalIndex) continue;
      if ((envsUsedIn.get(child)?.size ?? 0) > 0) anyOrphanUsesEnv = true;
    }
    if (anyOrphanUsesEnv) {
      // The `_fn<n>` half of the cost needs the creation sites the env graph
      // could not resolve, which only the instruction stream has.
      const creationSitesOf = new Map<number, Set<number>>();
      for (let i = 0; i < mod.functions.length; i++) {
        let cfg;
        try {
          cfg = analysis.cfg(i);
        } catch {
          continue;
        }
        for (const b of cfg.blocks) {
          for (const insn of b.instructions) {
            const child = closureFunctionId(insn);
            if (child === undefined) continue;
            const set = creationSitesOf.get(child);
            if (set === undefined) creationSitesOf.set(child, new Set([i]));
            else set.add(i);
          }
        }
      }
      const placements = resolveOrphanHosts({
        functionCount: mod.functions.length,
        globalIndex,
        parentOf,
        envsUsedIn,
        declaringFunction: envDeclaringFunction(envGraph, isAncestor),
        creationSitesOf,
      });
      for (const pl of placements) {
        parentOf.set(pl.orphan, pl.host);
        diagnostics.push({
          severity: "info",
          code: "W_ORPHAN_HOSTED",
          message: `function ${pl.orphan} has no resolved closure creation environment; emitting it inside fn#${pl.host}, which declares the environment slots it reads (${pl.unboundAtModule} name(s) would be unbound at module level, ${pl.unboundAtHost} here)`,
          context: { functionIndex: pl.orphan },
        });
      }
    }
  }

  // §4 of docs/reports/2026-09-05-ambiguous-closure-env.md — per-creation-context
  // bodies. A function created with more than one environment has one lexical
  // identity per environment; `envGraph.closureCopies` carries them, each with
  // the env remap that turns copy 0's `_e<env>_<slot>` names into that copy's.
  // Copy 0 keeps the plain `_fn<n>` name and its ordinary `parentOf` home, so
  // any reference the env graph did not record (a `CallDirect`, say) still
  // resolves exactly as it does today; copy i>0 is `_fn<n>__c<i>`, emitted
  // inside the owner of the environment *it* captured. Every recorded
  // `Create*Closure` site names its own copy, so no site is left referring to a
  // body it cannot see.
  const copyNameOf = (fn: number, copy: number): string => (copy === 0 ? fnName(fn) : `${fnName(fn)}__c${copy}`);
  /** siteKey(creator, offset) -> the `_fn…` name that site must emit. */
  const closureNameAt = new Map<string, string>();
  /** siteKey -> the copy that site creates, for both the name and the remap. */
  const copyAt = new Map<string, ClosureCopy>();
  /** host function -> the extra copies (i>0) emitted inside it. */
  const extraCopies = new Map<number, { fn: number; copy: ClosureCopy }[]>();
  for (const [fn, copies] of envGraph.closureCopies) {
    for (const copy of copies) {
      for (const site of copy.sites) {
        closureNameAt.set(site, copyNameOf(fn, copy.index));
        copyAt.set(site, copy);
      }
      if (copy.index === 0) continue;
      const host = envGraph.nodes[copy.env]!.ownerFunction;
      const list = extraCopies.get(host);
      if (list === undefined) extraCopies.set(host, [{ fn, copy }]);
      else list.push({ fn, copy });
    }
  }
  for (const list of extraCopies.values()) list.sort((a, b) => a.fn - b.fn || a.copy.index - b.copy.index);

  // Report §5 item 1 — the creation-site-only children. `closureCreationSites`
  // is keyed by the function *created*; inverting it gives, per creating
  // function, every closure its body makes and the `siteKey` that makes it.
  // A child whose `closureEnvOf` environment is owned by an ANCESTOR (it was
  // created inside `f` over an environment `f` itself captured) is placed by
  // `parentOf` beside copy 0, where no other copy of `f` can see it; the loop
  // in `emitBody` gives it one instance per copy instead.
  const createdIn = new Map<number, { readonly fn: number; readonly key: string }[]>();
  for (const [fn, sites] of envGraph.closureCreationSites) {
    for (const key of sites.keys()) {
      const creator = Number(key.slice(0, key.indexOf(":")));
      if (!Number.isInteger(creator)) continue;
      const list = createdIn.get(creator);
      if (list === undefined) createdIn.set(creator, [{ fn, key }]);
      else list.push({ fn, key });
    }
  }
  for (const l of createdIn.values()) l.sort((a, b) => a.fn - b.fn || (a.key < b.key ? -1 : 1));

  // Report §5 "Landing item 2" — recursion GROUPS. Two duplicated functions are
  // in the same group when each reaches the other through creation sites
  // (Tarjan's SCCs over the "creates" relation restricted to duplicated
  // functions; a function that creates itself is a group of one). react-navigation's
  // `_fn12406`/`_fn12407` create each other AND themselves over an environment
  // one of them owns, so the copy captured there is hosted *inside the group*:
  // hosting it once, beside copy 0, leaves it invisible to every other instance
  // of the group. `emitBody` hosts such a copy inside every instance instead.
  const recursionGroupOf = new Map<number, number>();
  {
    const members = [...envGraph.closureCopies.keys()].sort((a, b) => a - b);
    const duplicated = new Set(members);
    const edgesOf = new Map<number, number[]>();
    for (const f of members) {
      const out = new Set<number>();
      for (const site of createdIn.get(f) ?? []) if (duplicated.has(site.fn)) out.add(site.fn);
      edgesOf.set(f, [...out].sort((a, b) => a - b));
    }
    const idx = new Map<number, number>();
    const low = new Map<number, number>();
    const onStack = new Set<number>();
    const stack: number[] = [];
    let counter = 0;
    let nextGroup = 0;
    // Iterative Tarjan: the recursion depth of the recursive form is the
    // creation-site chain, which on a real bundle is thousands deep.
    const run = (root: number): void => {
      const work: { v: number; i: number }[] = [{ v: root, i: 0 }];
      idx.set(root, counter), low.set(root, counter), counter++, stack.push(root), onStack.add(root);
      while (work.length > 0) {
        const frame = work[work.length - 1]!;
        const succs = edgesOf.get(frame.v) ?? [];
        if (frame.i < succs.length) {
          const w = succs[frame.i++]!;
          if (!idx.has(w)) {
            idx.set(w, counter), low.set(w, counter), counter++, stack.push(w), onStack.add(w);
            work.push({ v: w, i: 0 });
          } else if (onStack.has(w)) low.set(frame.v, Math.min(low.get(frame.v)!, idx.get(w)!));
          continue;
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1]!.v;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
        }
        if (low.get(frame.v) === idx.get(frame.v)) {
          const scc: number[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
            if (w === frame.v) break;
          }
          // A one-member SCC is a group only when the member creates itself.
          if (scc.length > 1 || (edgesOf.get(frame.v) ?? []).includes(frame.v)) {
            const g = nextGroup++;
            for (const m of scc) recursionGroupOf.set(m, g);
          }
        }
      }
    };
    for (const f of members) if (!idx.has(f)) run(f);
  }

  /** `outer ∘ inner`: a copy nested inside another copy's subtree. */
  const composeRemap = (outer: ReadonlyMap<number, number> | undefined, inner: ReadonlyMap<number, number>): ReadonlyMap<number, number> => {
    if (outer === undefined) return inner;
    const out = new Map<number, number>(outer);
    for (const [from, to] of inner) out.set(from, outer.get(to) ?? to);
    return out;
  };

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
    const inCreateBlock = (offset: number): boolean => offset >= createBlock.start && offset < createBlock.end;
    const accesses = envGraph.slots.filter((s) => s.env === node.id).flatMap((s) => s.accesses);
    // A closure that captures a loop-local env is emitted *inline at its
    // CreateClosure site* (lower.ts), and its body reads the `_e<env>_<slot>`
    // names — so that site is an access to this declaration exactly as a
    // Load/StoreToEnvironment is, even though the env graph books it under the
    // child function. The structurer routinely puts the create block and the
    // CreateClosure block in sibling labelled blocks of one loop body
    // (`L3: { let _e2326_0; … } … L7: { r32 = function _fn13735 () { … _e2326_0 … }; }`),
    // where a `let` emitted in the first is not in scope in the second:
    // E_UNBOUND_IDENT on react-navigation-example `_e2326_0` (BUGS 2026-09-04).
    // A closure whose creation site is not found at all is treated the same
    // way — the inline form would be unreachable — so the hoisted fallback,
    // which is always in scope, is used instead.
    const closureSites = new Map<number, number[]>();
    for (const b of cfg.blocks) {
      for (const insn of b.instructions) {
        const child = closureFunctionId(insn);
        if (child === undefined || !node.closures.includes(child)) continue;
        const list = closureSites.get(child);
        if (list === undefined) closureSites.set(child, [insn.offset]);
        else list.push(insn.offset);
      }
    }
    const closuresOutside = node.closures.some((child) => {
      const sites = closureSites.get(child);
      return sites === undefined || sites.length === 0 || sites.some((o) => !inCreateBlock(o));
    });
    const outside = closuresOutside || accesses.some((a) => a.functionIndex === owner && !inCreateBlock(a.offset));
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
  /** One key per *instance*: a copy's subtree is emitted once per copy. */
  const emittedInstances = new Set<string>();
  const pendingCopies = new Set<string>();
  for (const [fn, copies] of envGraph.closureCopies) for (const c of copies) if (c.index > 0) pendingCopies.add(`${fn}#${c.index}`);
  let stubbedFunctions = 0;
  interface CopyCtx {
    /** Distinguishes the instances of one function index; "" is the original. */
    readonly path: string;
    readonly remap: ReadonlyMap<number, number> | undefined;
    /** The name of THIS instance only. It must never reach a child: a copy's
     *  children keep their own `_fn<n>` names (see `childCtx`). */
    readonly name?: string;
    /** The `_fn<n>__c<i>` names an ENCLOSING instance already hoisted for this
     *  instance's recursion group (report §5 "Landing item 2"). A group copy in
     *  here is in scope already and is not emitted again; for the copy that
     *  hosts itself the set contains its own name, which is what terminates
     *  the recursion — that self-reference is bound by its own declaration. */
    readonly hosted?: ReadonlySet<string>;
  }
  const ROOT_CTX: CopyCtx = { path: "", remap: undefined };
  const active = new Set<number>();
  const emitOne = (index: number, ctx: CopyCtx = ROOT_CTX): Stmt => {
    const instance = `${ctx.path}/${index}`;
    if (emittedInstances.has(instance)) {
      throw new Hbc2jsError(ErrorCode.E_INTERNAL, `function ${index} emitted twice`, { functionIndex: index, section: "emit" });
    }
    emittedInstances.add(instance);
    emitted.add(index);
    active.add(index);
    try {
      return emitBody(index, ctx);
    } finally {
      active.delete(index);
    }
  };
  const emitBody = (index: number, ctx: CopyCtx): Stmt => {
    let cfg: FunctionCfg | undefined;
    // Per-function isolation (docs/BUGS.md integration/E_EMIT_UNSUPPORTED):
    // any `Hbc2jsError` here — cfg build, structure, a pass, `emitFunction`,
    // an AST pass — is this ONE function's problem. Catching it here, at the
    // single point every function's decompile/emit funnels through (shared by
    // `decompile()` and `--split`'s `emitModule` call alike), means it cannot
    // abort the rest of the module: substitute a throwing stub and continue.
    try {
      cfg = analysis.cfg(index);
      let structured = structure(cfg, opts.structure);
      for (const d of structured.diagnostics) diagnostics.push(d);
      if (opts.passes !== undefined) {
        const passed = opts.passes(structured, cfg);
        structured = passed.fn;
        for (const d of passed.diagnostics) diagnostics.push(d);
      }
      // `name` renames the *instance*, not its subtree: passing `ctx` itself to
      // a child emitted `function _fn<f>__c<i>()` for the child too, so every
      // reference to the child inside the copy stayed `_fn<child>` and was
      // unbound (and, worse, shadowed the copy's own name inside its body).
      // The extra creation-context copies whose captured environment this
      // function owns, chosen BEFORE anything is emitted because the children
      // below are hoisted into the same body and must see them.
      const inherited = new Set<string>(ctx.hosted ?? []);
      if (ctx.name !== undefined) inherited.add(ctx.name);
      const extrasHere: { readonly fn: number; readonly copy: ClosureCopy; readonly name: string }[] = [];
      for (const extra of extraCopies.get(index) ?? []) {
        const name = copyNameOf(extra.fn, extra.copy.index);
        const group = recursionGroupOf.get(index);
        const sameGroup = extra.fn === index || (group !== undefined && group === recursionGroupOf.get(extra.fn));
        if (sameGroup) {
          // Report §5 "Landing item 2": a copy whose host is a member of its
          // own recursion group is hosted inside EVERY instance of that host,
          // not once beside copy 0 — the other instances (and the group's other
          // members' instances) reference it too and copy 0's body is not in
          // their scope. `inherited` stops it: once the name is in scope the
          // reference resolves, and the copy that would nest inside itself
          // finds its own declaration.
          if (inherited.has(name)) continue;
        } else if (active.has(extra.fn)) continue;
        extrasHere.push({ fn: extra.fn, copy: extra.copy, name });
      }
      const hosted: ReadonlySet<string> = new Set([...inherited, ...extrasHere.map((e) => e.name)]);
      // `name` renames the *instance*, not its subtree: passing `ctx` itself to
      // a child emitted `function _fn<f>__c<i>()` for the child too (below).
      const childCtx: CopyCtx = { path: ctx.path, remap: ctx.remap, hosted };
      const kids = childrenOf.get(index) ?? [];
      const hoisted: Stmt[] = [];
      const inlined = new Map<number, Stmt>();
      for (const child of kids) {
        const body = emitOne(child, childCtx);
        if (inlineFunctions.has(child)) inlined.set(child, body);
        else hoisted.push(body);
      }
      // They travel with their whole lexical subtree, under the composed
      // remap, and are hoisted like any other child.
      for (const extra of extrasHere) {
        pendingCopies.delete(`${extra.fn}#${extra.copy.index}`);
        hoisted.push(
          emitOne(extra.fn, {
            path: `${ctx.path}/${index}c${extra.fn}_${extra.copy.index}`,
            remap: composeRemap(ctx.remap, extra.copy.envRemap),
            name: extra.name,
            hosted,
          }),
        );
      }
      // Report §5 item 1: per-copy travel. Placement is a property of the
      // INSTANCE being emitted, not of the function index. A closure `g`
      // created inside this body over an environment this function *captured*
      // has `closureEnvOf(g)` pointing at an ancestor's environment, so
      // `parentOf` hosts it beside copy 0 and every other copy references a
      // `_fn<g>` it cannot see. Inside a copy (`ctx.path !== ""`) `g` therefore
      // gets its own instance here, under the name its creation site emits and
      // under this instance's remap, shadowing the copy-0 one. Copy 0 itself is
      // untouched, so every non-duplicated site keeps the binding it has today
      // — that is exactly what the reverted "reparent the function index
      // inward" attempt (report §5) got wrong.
      if (ctx.path !== "") {
        // Seeded with the copies hoisted just above: travelling one again at
        // the same level is a pure duplicate declaration, not a shadow.
        const travelled = new Set<string>(extrasHere.map((e) => e.name));
        for (const site of createdIn.get(index) ?? []) {
          const g = site.fn;
          if (g === index || active.has(g)) continue;
          const home = parentOf.get(g) ?? null;
          if (home === null) continue; // module level: in scope from everywhere
          if (isAncestor(index, home)) continue; // already emitted in this subtree
          if (isAncestor(g, index)) continue; // travelling it would re-emit this body
          const name = closureNameAt.get(site.key) ?? fnName(g);
          if (travelled.has(name)) continue;
          travelled.add(name);
          const copy = copyAt.get(site.key);
          const isExtra = copy !== undefined && copy.index > 0;
          if (isExtra) pendingCopies.delete(`${g}#${copy.index}`);
          hoisted.push(
            emitOne(g, {
              path: `${ctx.path}/${index}t${g}_${copy?.index ?? 0}`,
              remap: isExtra ? composeRemap(ctx.remap, copy.envRemap) : ctx.remap,
              hosted,
              ...(name !== fnName(g) ? { name } : {}),
            }),
          );
        }
      }
      let out = emitFunction({
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
        ...(ctx.name !== undefined ? { emitName: ctx.name } : {}),
        ...(ctx.remap !== undefined ? { envRemap: ctx.remap } : {}),
        closureNameAt,
      });
      if (opts.astPasses !== undefined) {
        const passed = opts.astPasses(out, cfg);
        out = passed.fn;
        for (const d of passed.diagnostics) diagnostics.push(d);
      }
      return out;
    } catch (e) {
      if (!(e instanceof Hbc2jsError)) throw e;
      // Spec 03 §6.4's strict-env refusal is a module-level POLICY with its
      // own escape hatch (`--lenient-env`), not an unsupported construct:
      // it must still refuse the module by default (review-M4-H2), so it is
      // never downgraded to a stub here.
      if (e.code === ErrorCode.E_ENV_UNRESOLVED) throw e;
      stubbedFunctions++;
      const stub = stubFor(analysis, index, e);
      if (ctx.name !== undefined) (stub as { name: string }).name = ctx.name;
      diagnostics.push({
        severity: "warn",
        code: "W_FUNCTION_STUBBED",
        message: `fn#${index} could not be decompiled (${e.code}); emitted a throwing stub instead of aborting the module`,
        context: { functionIndex: index, section: "emit", ...(e.context.offset !== undefined ? { offset: e.context.offset } : {}) },
      });
      // `cfg` may not have been assigned (the failure could be the cfg build
      // itself). When it was, still run the caller's AST-pass hook on the
      // stub — `--split`'s hook is how a function's body reaches its output
      // file at all (src/split/index.ts's `decompileAllBodies`), so skipping
      // it would silently fall back to that path's own generic "not
      // emitted" placeholder instead of this more informative stub. Never
      // let the hook itself take the whole run down over a stub.
      if (opts.astPasses !== undefined && cfg !== undefined) {
        try {
          const passed = opts.astPasses(stub, cfg);
          for (const d of passed.diagnostics) diagnostics.push(d);
          return passed.fn;
        } catch {
          return stub;
        }
      }
      return stub;
    }
  };

  const globalFn = emitOne(globalIndex);
  const orphans: Stmt[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    if (emitted.has(i)) continue;
    if (parentOf.get(i) !== null) continue;
    orphans.push({ k: "comment", text: `orphan: no closure creation site was found for fn#${i}` });
    orphans.push(emitOne(i));
  }
  // A copy whose host was never reached (its owner is itself unemitted, or the
  // copy is hosted inside its own subtree) would leave its creation sites naming
  // a body that does not exist. Emit it at module level, exactly where an
  // unplaceable orphan goes today.
  for (const [fn, copies] of envGraph.closureCopies) {
    for (const c of copies) {
      if (c.index === 0 || !pendingCopies.has(`${fn}#${c.index}`)) continue;
      pendingCopies.delete(`${fn}#${c.index}`);
      diagnostics.push({
        severity: "warn",
        code: "W_ORPHAN_FUNCTION",
        message: `copy ${c.index} of function ${fn} could not be emitted inside fn#${envGraph.nodes[c.env]!.ownerFunction}, which owns the environment it captures; emitting it at module level`,
        context: { functionIndex: fn },
      });
      orphans.push(emitOne(fn, { path: `/module_c${fn}_${c.index}`, remap: c.envRemap, name: copyNameOf(fn, c.index) }));
    }
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

  // EM-01 with per-function isolation. An unbound identifier is an emitter bug
  // wherever it appears, but losing a 12 MB module's entire output because one
  // nested function out of 43,000 has one is worse than shipping that function
  // as a throwing stub next to a loud comment (docs/BUGS.md 2026-09-01, Service
  // NSW). So: collect *every* unbound identifier, replace the innermost emitted
  // function statement each one sits under with a stub, and re-run the check —
  // which must then pass, or the bug is not per-function and still throws.
  const unbound = collectUnbound(program, prelude.names, globalIndex);
  if (unbound.length > 0) {
    const targets = new Map<string, string[]>(); // function name -> reasons
    for (const u of unbound) {
      const fn = u.path.length > 1 ? u.path[u.path.length - 1]! : undefined;
      if (fn === undefined) {
        // Module scope itself: nothing smaller to isolate. Fail as before.
        throw new Hbc2jsError(ErrorCode.E_UNBOUND_IDENT, unboundMessage(u), { section: "emit/scope-check" });
      }
      const list = targets.get(fn);
      if (list === undefined) targets.set(fn, [unboundMessage(u)]);
      else list.push(unboundMessage(u));
    }
    const stubbedNames = stubFunctionsByName(program, targets);
    for (const [name, reasons] of targets) {
      if (!stubbedNames.has(name)) continue;
      stubbedFunctions++;
      diagnostics.push({
        severity: "warn",
        code: "W_UNBOUND_ISOLATED",
        message: `function ${name} referenced an identifier no enclosing scope declares; its body was replaced with a throwing stub (${reasons.join("; ")})`,
        context: { section: "emit/scope-check" },
      });
    }
  }
  checkBindings(program, prelude.names, globalIndex);

  const code = printProgram(program, { indent, jsx: opts.jsx === true });
  return { code, helpersUsed: prelude.names, lineMap: [], diagnostics, stubbedFunctions };
}
