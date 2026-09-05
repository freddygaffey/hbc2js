// src/artifact/points-to.ts — the `require(N)` dynamic-dispatch points-to
// pass (docs/specs/17-mcp-harness.md §14.4, docs/specs/10-artifact-format.md
// §2.2a, docs/QUEUE.md #3). It resolves the RESIDUE `who-calls-by-name`
// (§14.1) leaves behind: the identity of the RECEIVER in the Metro/RN
// convention that dominates real bundles —
//
//     const m = require(dependencyMap[N]);   // once, usually into an env slot
//     ...
//     m.exportName(arg)                      // often from a nested closure
//
// `src/artifact/semantic-walk.ts` already resolves the `require(depMap[N])`
// CALL itself to `m:<moduleId>` (`kind: "require"`); what it cannot do is
// follow the RESULT, so the later `m.exportName(...)` lands in calls.jsonl as
// `callee: "?"`, `why: "computed-callee"`. This pass follows that result and
// emits a real, module-scoped edge for the call.
//
// **Lattice** (per register, straight-line, dropped at every branch target —
// the same reaching-definition idiom as `object-tables.ts` /
// `template-injections.ts`):
//
//   module M   a value proven to be module M's `module.exports` (the result
//              of `require(dependencyMap[i])` with `i` a compile-time index
//              inside a known factory, or a load of an environment slot every
//              one of whose writers proved module M)
//   export E   a `Get*ById "E"` off a `module M` value
//   unknown    everything else (absent from the map)
//
// **Sound refusal** (the rule that outranks coverage — a wrong edge is worse
// than a missing one; same style as `exported-names.ts`):
//  - an environment slot resolves ONLY when every one of its `store`
//    accesses (`EnvGraph`'s own access list, so a store this pass never even
//    visited still counts) is a proven store of the SAME module;
//  - an export name resolves to a function ONLY when exactly one closure in
//    that module's factory is stored under that name on a PROVEN exports
//    object (the factory's `exports` parameter, or `module.exports` read off
//    its `module` parameter); two closures under one name, or a put on an
//    object this pass cannot prove is the exports object, resolve to nothing;
//  - the ONE exception (spec 17 §14.4, docs/BUGS.md "export-side
//    resolution"): babel's `exports.default = void 0;` prologue. A store of a
//    value PROVEN to be `undefined` is set aside instead of poisoning the
//    name, and forgiven only if `provenLastWrite` proves over the factory's
//    CFG that the single closure store to that name always runs last (see
//    there for the five obligations). `_interopRequireDefault` wrappers and a
//    helper-assembled `module.exports` are still refused;
//  - any unresolved link in the chain drops the edge entirely. One edge per
//    call site, or none.
//
// **Environment identity** comes from the module's already-built `EnvGraph`
// (`ModuleAnalysis.envGraph`: `resolvedAt` maps a (function, offset) access
// site to its environment node, and `EnvSlot.accesses` enumerates every
// access to a slot bundle-wide) rather than from a hand-rolled
// `GetEnvironment`-level walk. Recorded as a decision (docs/DECISIONS.md
// D20): the env graph is the module's authoritative environment resolution,
// it is already computed for the artifact's own semantic walk (so it is free
// here), and a second, weaker implementation of the same analysis is exactly
// the kind of thing that produces a WRONG edge.
import { siteKey } from "../cfg/types.ts";
import type { BlockId, EnvNodeId, FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import type { Instruction } from "../disasm/decode.ts";
import type { HbcModule } from "../parse/types.ts";
import type { ResolvedCallRow } from "./schema.ts";

/** The one module fact this pass needs from `src/split` (`SplitResult.modules`
 *  rows, or the artifact's `modules.json`). */
export interface PointsToModule {
  readonly id: number;
  readonly factoryFunctionIndex: number;
  readonly deps: readonly number[];
}

export interface PointsToScan {
  readonly rows: readonly ResolvedCallRow[];
  /** Functions this pass actually decoded (factories + the readers of a
   *  resolved slot) — NOT the whole bundle. */
  readonly walked: number;
  /** Environment slots proven to hold one module's exports. */
  readonly resolvedSlots: number;
  /** Rounds the slot fixed point took (≤ `MAX_ROUNDS`). */
  readonly rounds: number;
  /** Call sites whose RECEIVER and property name were both proven (`export E
   *  of M`) — the population `rows` is drawn from. */
  readonly exportCalls: number;
  /** Of those, the ones dropped because the export name did not resolve to
   *  exactly one closure in M's factory (the sound-refusal tail, spec 17
   *  §14.4 "what still escapes"). */
  readonly unresolvedExportCalls: number;
}

/** Rounds of the slot fixed point before giving up. A chain longer than this
 *  (slot -> slot -> slot) simply resolves nothing: refusal, never a guess. */
const MAX_ROUNDS = 4;

const GET_BY_ID = /^(Try)?GetById(Short|Long)?$/;
const PUT_BY_ID = /^(Try)?PutById(Loose|Strict)?(Long)?$/;
const PROPKEY_DEF = /^(PutNewOwnById|DefineOwnById)(Long|Short)?$/;
const CREATE_CLOSURE = new Set([
  "CreateClosure",
  "CreateClosureLongIndex",
  "CreateGeneratorClosure",
  "CreateGeneratorClosureLongIndex",
  "CreateAsyncClosure",
  "CreateAsyncClosureLongIndex",
]);
const CALL_SMALL = new Set(["Call1", "Call2", "Call3", "Call4"]);
const CALL_GENERIC = new Set(["Call", "CallLong"]);
const LOAD_ENV = new Set(["LoadFromEnvironment", "LoadFromEnvironmentL"]);
const STORE_ENV = new Set(["StoreToEnvironment", "StoreToEnvironmentL", "StoreNPToEnvironment", "StoreNPToEnvironmentL"]);
const MOV = /^Mov(Long)?$/;
/** Same family the other scanners use: operand 0 is a SOURCE register. */
const NOT_A_DEF = /^(Put|Store|Define|Ret|Throw)/;

const V = (insn: Instruction, i: number): number => insn.operands[i]!.value;

/** Reserved key for "the module's whole export value" (`module.exports = f`),
 *  as opposed to a NAMED export. A module that also puts a real property with
 *  this name on its exports object simply makes the key ambiguous, and both
 *  resolve to nothing — the same refusal every other collision gets. */
export const MODULE_EXPORTS = "module.exports";

type Val =
  | { readonly t: "module"; readonly id: number }
  | { readonly t: "export"; readonly module: number; readonly name: string }
  | { readonly t: "param"; readonly slot: number }
  | { readonly t: "depIndex"; readonly index: number }
  | { readonly t: "constInt"; readonly value: number };

interface Factory {
  readonly id: number;
  readonly fn: number;
  readonly deps: readonly number[];
  /** Metro factory signature `(global, require, module, exports, depMap)`:
   *  slot 0 is `this`, so `require` is slot 2 and the dependency map is the
   *  LAST parameter (`buildFactoryInfo`, src/artifact/build.ts). */
  readonly requireSlot: number;
  readonly depMapSlot: number;
  readonly exportsSlot: number;
  readonly moduleSlot: number;
}

/** Registers whose ONLY writer in the whole function is one `LoadParam` of
 *  one slot — the same function-wide rule `semantic-walk.ts` uses (D17i:
 *  Metro factory params are read-only in every shape observed). */
function paramRegs(insns: readonly Instruction[]): ReadonlyMap<number, number> {
  const loads = new Map<number, Set<number>>();
  const other = new Set<number>();
  for (const insn of insns) {
    const op0 = insn.operands[0];
    if (op0 === undefined || (op0.type !== "Reg8" && op0.type !== "Reg32")) continue;
    if (insn.name === "LoadParam" || insn.name === "LoadParamLong") {
      const set = loads.get(op0.value) ?? new Set<number>();
      set.add(V(insn, 1));
      loads.set(op0.value, set);
    } else if (!NOT_A_DEF.test(insn.name)) {
      other.add(op0.value);
    }
  }
  const out = new Map<number, number>();
  for (const [reg, slots] of loads) if (slots.size === 1 && !other.has(reg)) out.set(reg, [...slots][0]!);
  return out;
}

/** Registers whose ONLY writer in the whole function is one `Create*Closure`
 *  of one function — the closure-register analogue of `paramRegs`, and the
 *  reason a `function foo(){}; exports.foo = foo` factory resolves even when
 *  the put is separated from the `CreateClosure` by a branch target. */
function uniqueClosureRegs(insns: readonly Instruction[]): ReadonlyMap<number, number> {
  const made = new Map<number, Set<number>>();
  const other = new Set<number>();
  for (const insn of insns) {
    const op0 = insn.operands[0];
    if (op0 === undefined || (op0.type !== "Reg8" && op0.type !== "Reg32")) continue;
    if (CREATE_CLOSURE.has(insn.name)) {
      const set = made.get(op0.value) ?? new Set<number>();
      set.add(V(insn, 2));
      made.set(op0.value, set);
    } else if (!NOT_A_DEF.test(insn.name)) {
      other.add(op0.value);
    }
  }
  const out = new Map<number, number>();
  for (const [reg, fns] of made) if (fns.size === 1 && !other.has(reg)) out.set(reg, [...fns][0]!);
  return out;
}

/** The block whose offset range contains `offset` (the §4.5 synthetic block
 *  has `start`/`end` of -1 and contains nothing). */
function blockAt(cfg: FunctionCfg, offset: number): BlockId | undefined {
  for (const b of cfg.blocks) if (b.start >= 0 && offset >= b.start && offset < b.end) return b.id;
  return undefined;
}

/**
 * The ordering proof behind the ONE widening this pass allows over "a name
 * written once with a proven closure and once with an unproven value has no
 * provable target": babel's `exports.default = void 0;` prologue (spec 17
 * §14.4). It returns true only when the closure store is PROVEN to be the
 * last write to the name that any exit can observe:
 *
 *  - the only other writes to the name are `undefOffsets`, each a store of a
 *    value this pass proved is `undefined` (the caller refuses outright if
 *    any other unproven value is written to the name, exactly as before);
 *  - every void-0 store DOMINATES the closure store, so it always runs first;
 *  - the closure store POST-DOMINATES every void-0 store — no path from a
 *    void-0 store reaches an exit without running it, so no exit can see
 *    `undefined` as the last write;
 *  - no exception region covers the span: a throw between the two stores
 *    could be caught and leave the hole observable;
 *  - the exports object is neither read nor escapes inside the span
 *    (`escapeOffsets`), so nothing can capture or observe the hole either.
 *
 * Anything else refuses, and the name resolves to nothing as it did before.
 */
function provenLastWrite(cfg: FunctionCfg | null, undefOffsets: readonly number[], closureOffset: number, escapeOffsets: readonly number[]): boolean {
  if (cfg === null || undefOffsets.length === 0) return false;
  const bC = blockAt(cfg, closureOffset);
  if (bC === undefined) return false;
  let lo = closureOffset;
  for (const off of undefOffsets) if (off < lo) lo = off;
  if (lo >= closureOffset) return false;
  for (const r of cfg.regions) if (r.startPc <= closureOffset && r.endPc > lo) return false;
  for (const off of escapeOffsets) if (off >= lo && off <= closureOffset) return false;
  // Blocks that reach an exit WITHOUT passing through the closure store's
  // block: backwards reachability over normal edges with `bC` removed.
  const escapesExit = new Set<BlockId>();
  const stack: BlockId[] = [];
  for (const e of cfg.exits) {
    if (e === bC || escapesExit.has(e)) continue;
    escapesExit.add(e);
    stack.push(e);
  }
  while (stack.length > 0) {
    const b = stack.pop()!;
    for (const p of cfg.blocks[b]!.preds) {
      if (p === bC || escapesExit.has(p)) continue;
      escapesExit.add(p);
      stack.push(p);
    }
  }
  for (const off of undefOffsets) {
    const bU = blockAt(cfg, off);
    if (bU === undefined) return false;
    // Same block: no branch between the two stores, so the closure store
    // always runs after this one.
    if (bU === bC) {
      if (off >= closureOffset) return false;
      continue;
    }
    if (!cfg.dom.dominates(bU, bC)) return false;
    if (escapesExit.has(bU)) return false;
  }
  return true;
}

/** Slot bookkeeping shared by the module-value and closure-value resolvers. */
interface SlotIndex {
  /** `${env}:${slot}` -> every store SITE key + every reading function. */
  readonly byKey: ReadonlyMap<string, { readonly storeSites: readonly string[]; readonly readers: readonly number[] }>;
  /** Slot INDEXES some store in the bundle writes through an environment the
   *  env graph could not resolve. Such a store could target ANY environment's
   *  slot of that index, so no slot with that index is ever resolved here —
   *  the alternative is an edge that a store this pass never saw could have
   *  invalidated (spec 17 §14.4 "sound refusal"). */
  readonly poisonedSlotIndexes: ReadonlySet<number>;
}

function resolveSlotValues<T>(index: SlotIndex, facts: ReadonlyMap<string, { readonly key: string; readonly value: T | null }>): Map<string, T> {
  const out = new Map<string, T>();
  for (const [key, slot] of index.byKey) {
    if (slot.storeSites.length === 0) continue;
    if (index.poisonedSlotIndexes.has(Number(key.split(":")[1]))) continue;
    let only: T | null = null;
    let ok = true;
    for (const site of slot.storeSites) {
      const fact = facts.get(site);
      if (fact === undefined || fact.value === null || fact.key !== key) {
        ok = false;
        break;
      }
      if (only === null) only = fact.value;
      else if (only !== fact.value) {
        ok = false;
        break;
      }
    }
    if (ok && only !== null) out.set(key, only);
  }
  return out;
}

/**
 * Name -> function index for module `m`'s exports, proven from its factory's
 * bytecode: a `CreateClosure` whose register is then put under a property
 * name on a PROVEN exports object. A name two different closures are stored
 * under maps to nothing (ambiguous -> refuse).
 */
function exportsOfModule(mod: HbcModule, analysis: ModuleAnalysis, f: Factory, index: SlotIndex): ReadonlyMap<string, number> {
  let insns: readonly Instruction[];
  let labels: ReadonlyMap<number, string>;
  try {
    const decoded = analysis.decoded(f.fn);
    insns = decoded.instructions;
    labels = decoded.labels;
  } catch {
    return new Map();
  }
  const params = paramRegs(insns);
  const uniqueClosures = uniqueClosureRegs(insns);
  // Only the void-0 ordering proof needs the CFG; a factory whose CFG cannot
  // be built simply keeps the old, stricter refusal.
  let cfg: FunctionCfg | null = null;
  try {
    cfg = analysis.cfg(f.fn);
  } catch {
    cfg = null;
  }
  const resolvedAt = analysis.envGraph.resolvedAt;
  // Two passes: the first learns which environment slots of this factory hold
  // one closure (a hoisted `function foo(){}` the factory later exports is
  // captured, so `exports.foo = foo` reads it back out of a slot); the second
  // reads those slots while collecting the export names.
  let closureSlots = new Map<string, number>();
  for (let pass = 0; pass < 2; pass++) {
    const storeFacts = new Map<string, { readonly key: string; readonly value: number | null }>();
    const found = exportsPass(mod, insns, labels, f, params, uniqueClosures, resolvedAt, closureSlots, storeFacts, cfg);
    if (pass === 1) return found;
    closureSlots = resolveSlotValues(index, storeFacts);
  }
  return new Map();
}

/** One pass of `exportsOfModule` (see there). Straight-line, dropped at every
 *  branch target, plus the two function-wide unique-writer rules. */
function exportsPass(
  mod: HbcModule,
  insns: readonly Instruction[],
  labels: ReadonlyMap<number, string>,
  f: Factory,
  params: ReadonlyMap<number, number>,
  uniqueClosures: ReadonlyMap<number, number>,
  resolvedAt: ReadonlyMap<string, EnvNodeId>,
  closureSlots: ReadonlyMap<string, number>,
  storeFacts: Map<string, { readonly key: string; readonly value: number | null }>,
  cfg: FunctionCfg | null,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const ambiguous = new Set<string>();
  // Offsets, per export name, of the stores of a PROVEN `undefined` (babel's
  // `exports.default = void 0;` prologue) and of the proven closure stores;
  // plus every offset at which the exports object is read or escapes. All
  // three feed `provenLastWrite` once the walk is over.
  const undefWrites = new Map<string, number[]>();
  const closureWrites = new Map<string, number[]>();
  const escapes: number[] = [];
  // Function-wide (`paramRegs`) OR straight-line: hermesc reuses a register
  // for `this`/temporaries and the `exports` parameter in the same factory
  // (`LoadParam r0, 4` after a `CreateEnvironment r0`), so the function-wide
  // rule alone proves almost no factory's exports parameter.
  let paramLocal = new Map<number, number>();
  const isExportsParam = (reg: number): boolean => (paramLocal.get(reg) ?? params.get(reg)) === f.exportsSlot;
  const isModuleParam = (reg: number): boolean => (paramLocal.get(reg) ?? params.get(reg)) === f.moduleSlot;

  // Straight-line, dropped at every branch target.
  let closures = new Map<number, number>(); // reg -> created fn
  let exportsRegs = new Set<number>(); // regs proven to hold the exports object
  let undefRegs = new Set<number>(); // regs proven to hold `undefined`
  const closureOf = (reg: number): number | undefined => closures.get(reg) ?? uniqueClosures.get(reg);
  const isExportsReg = (reg: number): boolean => exportsRegs.has(reg) || isExportsParam(reg);
  for (const insn of insns) {
    if (labels.has(insn.offset)) {
      closures = new Map();
      exportsRegs = new Set();
      undefRegs = new Set();
      paramLocal = new Map();
    }
    const name = insn.name;
    const dst = insn.operands[0]?.value;

    // Does the exports object leak here? Every SOURCE use of a proven-exports
    // register counts, except propagation through `Mov` and the object of a
    // put — so a property READ (`Get*ById` off exports) and any call argument
    // or environment store both count. Only `provenLastWrite` consults this.
    if (!MOV.test(name)) {
      const isPut = PUT_BY_ID.test(name) || PROPKEY_DEF.test(name);
      for (const [i, op] of insn.operands.entries()) {
        if (op.type !== "Reg8" && op.type !== "Reg32") continue;
        if (i === 0 && (isPut || !NOT_A_DEF.test(name))) continue;
        if (isExportsReg(op.value)) {
          escapes.push(insn.offset);
          break;
        }
      }
    }

    if (name === "LoadParam" || name === "LoadParamLong") {
      if (dst !== undefined) {
        paramLocal.set(dst, V(insn, 1));
        closures.delete(dst);
        exportsRegs.delete(dst);
        undefRegs.delete(dst);
      }
      continue;
    }
    if (name === "LoadConstUndefined") {
      if (dst !== undefined) {
        undefRegs.add(dst);
        closures.delete(dst);
        exportsRegs.delete(dst);
        paramLocal.delete(dst);
      }
      continue;
    }

    if (CREATE_CLOSURE.has(name)) {
      if (dst !== undefined) {
        closures.set(dst, V(insn, 2));
        exportsRegs.delete(dst);
        paramLocal.delete(dst);
        undefRegs.delete(dst);
      }
      continue;
    }
    if (MOV.test(name) && dst !== undefined) {
      const src = V(insn, 1);
      if (undefRegs.has(src)) undefRegs.add(dst);
      else undefRegs.delete(dst);
      const c = closureOf(src);
      if (c !== undefined) closures.set(dst, c);
      else closures.delete(dst);
      const srcParam = paramLocal.get(src) ?? params.get(src);
      if (srcParam === undefined) paramLocal.delete(dst);
      else paramLocal.set(dst, srcParam);
      if (exportsRegs.has(src) || isExportsParam(src)) exportsRegs.add(dst);
      else exportsRegs.delete(dst);
      continue;
    }
    if (LOAD_ENV.has(name)) {
      if (dst === undefined) continue;
      paramLocal.delete(dst);
      exportsRegs.delete(dst);
      undefRegs.delete(dst);
      const env = resolvedAt.get(siteKey(f.fn, insn.offset));
      const held = env === undefined ? undefined : closureSlots.get(`${env}:${V(insn, 2)}`);
      if (held === undefined) closures.delete(dst);
      else closures.set(dst, held);
      continue;
    }
    if (STORE_ENV.has(name)) {
      const env = resolvedAt.get(siteKey(f.fn, insn.offset));
      if (env !== undefined) {
        const held = closureOf(V(insn, 2));
        storeFacts.set(siteKey(f.fn, insn.offset), { key: `${env}:${V(insn, 1)}`, value: held ?? null });
      }
      continue;
    }
    if (GET_BY_ID.test(name)) {
      if (dst === undefined) continue;
      closures.delete(dst);
      paramLocal.delete(dst);
      undefRegs.delete(dst);
      let text: string | undefined;
      try {
        text = mod.strings.get(V(insn, 3));
      } catch {
        text = undefined;
      }
      if (text === "exports" && isModuleParam(V(insn, 1))) exportsRegs.add(dst);
      else exportsRegs.delete(dst);
      continue;
    }
    if (PUT_BY_ID.test(name) || PROPKEY_DEF.test(name)) {
      const obj = V(insn, 0);
      const sid = PUT_BY_ID.test(name) ? V(insn, 3) : V(insn, insn.operands.length - 1);
      let text: string;
      try {
        text = mod.strings.get(sid);
      } catch {
        continue;
      }
      // `module.exports = X` REPLACES the exports object: X is what
      // `require()` returns, so a later put on X is an export too, and X
      // itself is the module's whole export value (recorded under the
      // reserved key `MODULE_EXPORTS` — the dominant shape in real RN
      // bundles, e.g. rn-template's 435 factories).
      if (text === "exports" && isModuleParam(obj)) exportsRegs.add(V(insn, 1));
      if (!exportsRegs.has(obj) && !isExportsParam(obj) && !(text === "exports" && isModuleParam(obj))) continue;
      if (text === "exports" && isModuleParam(obj)) text = MODULE_EXPORTS;
      const fnIdx = closureOf(V(insn, 1));
      // A put of a value this pass cannot prove is a closure is exactly as
      // disqualifying as two different closures: at runtime the LAST write
      // wins, so a name written once with a proven closure and once with an
      // unproven value has no provable target. (Cost: babel's
      // `exports.default = void 0;` prologue is the ONE exception: a store of
      // a PROVEN `undefined` is set aside here and forgiven at the end only
      // if `provenLastWrite` proves a single later closure store always
      // overwrites it — spec 17 §14.4.)
      if (fnIdx === undefined) {
        if (undefRegs.has(V(insn, 1))) {
          const list = undefWrites.get(text);
          if (list === undefined) undefWrites.set(text, [insn.offset]);
          else list.push(insn.offset);
        } else ambiguous.add(text);
        continue;
      }
      const prev = out.get(text);
      if (prev !== undefined && prev !== fnIdx) {
        ambiguous.add(text);
        continue;
      }
      out.set(text, fnIdx);
      const written = closureWrites.get(text);
      if (written === undefined) closureWrites.set(text, [insn.offset]);
      else written.push(insn.offset);
      continue;
    }
    const op0 = insn.operands[0];
    if (dst !== undefined && op0 !== undefined && (op0.type === "Reg8" || op0.type === "Reg32") && !NOT_A_DEF.test(name)) {
      closures.delete(dst);
      exportsRegs.delete(dst);
      paramLocal.delete(dst);
      undefRegs.delete(dst);
    }
  }
  for (const name of ambiguous) out.delete(name);
  // A name that also took a void-0 store survives only with the full ordering
  // proof: exactly one closure store, and it provably runs last.
  for (const [name, offsets] of undefWrites) {
    if (!out.has(name)) continue;
    const written = closureWrites.get(name);
    if (written === undefined || written.length !== 1 || !provenLastWrite(cfg, offsets, written[0]!, escapes)) out.delete(name);
  }
  return out;
}

interface StoreFact {
  /** `${env}:${slot}` */
  readonly key: string;
  /** The module id stored, or `null` when this store's value is not a proven
   *  module value (which POISONS the slot). */
  readonly module: number | null;
}

interface WalkSink {
  readonly stores?: Map<string, StoreFact>; // `${fn}:${offset}` -> fact
  readonly edges?: Map<string, ResolvedCallRow>; // `${fn}:${offset}` -> edge
  /** `[exportCalls, unresolvedExportCalls]`, accumulated while emitting. */
  readonly counts?: { exportCalls: number; unresolved: number };
}

/**
 * One function, straight-line. Reads `resolved` (env slot -> module) and
 * writes whatever `sink` asks for.
 */
function walkOne(
  mod: HbcModule,
  analysis: ModuleAnalysis,
  fn: number,
  factory: Factory | undefined,
  resolved: ReadonlyMap<string, number>,
  exportsOf: (moduleId: number) => ReadonlyMap<string, number>,
  sink: WalkSink,
): void {
  let insns: readonly Instruction[];
  let labels: ReadonlyMap<number, string>;
  try {
    const decoded = analysis.decoded(fn);
    insns = decoded.instructions;
    labels = decoded.labels;
  } catch {
    return;
  }
  const params = paramRegs(insns);
  const resolvedAt = analysis.envGraph.resolvedAt;
  let vals = new Map<number, Val>();
  const valOf = (reg: number): Val | undefined => {
    const v = vals.get(reg);
    if (v !== undefined) return v;
    const slot = params.get(reg);
    return slot === undefined ? undefined : { t: "param", slot };
  };

  for (const insn of insns) {
    if (labels.has(insn.offset)) vals = new Map();
    const name = insn.name;
    const dst = insn.operands[0]?.value;

    if (MOV.test(name) && dst !== undefined) {
      const v = valOf(V(insn, 1));
      if (v === undefined) vals.delete(dst);
      else vals.set(dst, v);
      continue;
    }
    if (name === "LoadParam" || name === "LoadParamLong") {
      if (dst !== undefined) vals.set(dst, { t: "param", slot: V(insn, 1) });
      continue;
    }
    if (name === "LoadConstZero" || name === "LoadConstUInt8" || name === "LoadConstInt") {
      if (dst !== undefined) vals.set(dst, { t: "constInt", value: name === "LoadConstZero" ? 0 : V(insn, 1) });
      continue;
    }
    if (name === "GetByIndex" || name === "GetByVal") {
      if (dst === undefined) continue;
      const base = valOf(V(insn, 1));
      const idxVal = name === "GetByIndex" ? V(insn, 2) : ((): number | undefined => {
        const v = valOf(V(insn, 2));
        return v !== undefined && v.t === "constInt" ? v.value : undefined;
      })();
      if (factory !== undefined && base !== undefined && base.t === "param" && base.slot === factory.depMapSlot && idxVal !== undefined) {
        vals.set(dst, { t: "depIndex", index: idxVal });
      } else {
        vals.delete(dst);
      }
      continue;
    }
    if (LOAD_ENV.has(name)) {
      if (dst === undefined) continue;
      const env = resolvedAt.get(siteKey(fn, insn.offset));
      const moduleId = env === undefined ? undefined : resolved.get(`${env}:${V(insn, 2)}`);
      if (moduleId === undefined) vals.delete(dst);
      else vals.set(dst, { t: "module", id: moduleId });
      continue;
    }
    if (STORE_ENV.has(name)) {
      if (sink.stores === undefined) continue;
      const env: EnvNodeId | undefined = resolvedAt.get(siteKey(fn, insn.offset));
      if (env === undefined) continue; // an unresolved site cannot prove a slot either way
      const v = valOf(V(insn, 2));
      sink.stores.set(siteKey(fn, insn.offset), { key: `${env}:${V(insn, 1)}`, module: v !== undefined && v.t === "module" ? v.id : null });
      continue;
    }
    if (GET_BY_ID.test(name)) {
      if (dst === undefined) continue;
      const base = valOf(V(insn, 1));
      if (base !== undefined && base.t === "module") {
        let text: string;
        try {
          text = mod.strings.get(V(insn, 3));
        } catch {
          vals.delete(dst);
          continue;
        }
        vals.set(dst, { t: "export", module: base.id, name: text });
      } else {
        vals.delete(dst);
      }
      continue;
    }
    if (CALL_SMALL.has(name) || CALL_GENERIC.has(name)) {
      const callee = valOf(V(insn, 1));
      // `require(dependencyMap[i])` -> module value in `dst` (the same
      // recognition `semantic-walk.ts` uses for the call row itself).
      if (factory !== undefined && callee !== undefined && callee.t === "param" && callee.slot === factory.requireSlot && insn.operands.length === 4) {
        const arg = valOf(V(insn, 3));
        if (arg !== undefined && arg.t === "depIndex" && arg.index >= 0 && arg.index < factory.deps.length) {
          if (dst !== undefined) vals.set(dst, { t: "module", id: factory.deps[arg.index]! });
          continue;
        }
      }
      // Calling the module VALUE itself: `require(d[N])(...)`, i.e. the
      // module whose factory did `module.exports = function …`.
      const asExport: Val | undefined = callee !== undefined && callee.t === "module" ? { t: "export", module: callee.id, name: MODULE_EXPORTS } : callee;
      if (sink.edges !== undefined && asExport !== undefined && asExport.t === "export") {
        const target = exportsOf(asExport.module).get(asExport.name);
        if (sink.counts !== undefined) {
          sink.counts.exportCalls++;
          if (target === undefined) sink.counts.unresolved++;
        }
        if (target !== undefined) {
          const key = siteKey(fn, insn.offset);
          if (!sink.edges.has(key)) {
            sink.edges.set(key, { caller: fn, site: insn.offset, callee: target, module: asExport.module, name: asExport.name, confidence: "points-to" });
          }
        }
      }
      if (dst !== undefined) vals.delete(dst);
      continue;
    }
    const op0 = insn.operands[0];
    if (dst !== undefined && op0 !== undefined && (op0.type === "Reg8" || op0.type === "Reg32") && !NOT_A_DEF.test(name)) {
      vals.delete(dst);
    }
  }
}

/**
 * The whole pass. `modules` are `SplitResult.modules` (id + factory function
 * + dependency ids). Returns one resolved edge per proven call site, sorted
 * by `(caller, site)`.
 */
export function resolvePointsToCalls(mod: HbcModule, analysis: ModuleAnalysis, modules: readonly PointsToModule[]): PointsToScan {
  const paramCountOf = new Map<number, number>();
  for (const f of mod.functions) paramCountOf.set(f.header.index, f.header.paramCount);

  const factories = new Map<number, Factory>();
  const factoryOfModule = new Map<number, Factory>();
  for (const m of modules) {
    const paramCount = paramCountOf.get(m.factoryFunctionIndex);
    // Fewer than `(global, require, module, exports, depMap)` + `this`: the
    // exports/module parameters cannot be located, so refuse the module
    // outright rather than guess a slot.
    if (paramCount === undefined || paramCount < 6) continue;
    const depMapSlot = paramCount - 1;
    const f: Factory = {
      id: m.id,
      fn: m.factoryFunctionIndex,
      deps: m.deps,
      requireSlot: 2,
      depMapSlot,
      exportsSlot: depMapSlot - 1,
      moduleSlot: depMapSlot - 2,
    };
    factories.set(m.factoryFunctionIndex, f);
    if (!factoryOfModule.has(m.id)) factoryOfModule.set(m.id, f);
  }

  const slotOfKey = new Map<string, { readonly storeSites: readonly string[]; readonly readers: readonly number[] }>();
  for (const s of analysis.envGraph.slots) {
    const stores = s.accesses.filter((a) => a.kind === "store");
    slotOfKey.set(`${s.env}:${s.slot}`, { storeSites: stores.map((a) => siteKey(a.functionIndex, a.offset)), readers: [...s.readers] });
  }
  const poisonedSlotIndexes = new Set<number>();
  for (const a of analysis.envGraph.unresolved) if (a.kind === "store") poisonedSlotIndexes.add(a.slot);
  const slotIndex: SlotIndex = { byKey: slotOfKey, poisonedSlotIndexes };

  const exportsCache = new Map<number, ReadonlyMap<string, number>>();
  const exportsOf = (moduleId: number): ReadonlyMap<string, number> => {
    const hit = exportsCache.get(moduleId);
    if (hit !== undefined) return hit;
    const f = factoryOfModule.get(moduleId);
    const map = f === undefined ? new Map<string, number>() : exportsOfModule(mod, analysis, f, slotIndex);
    exportsCache.set(moduleId, map);
    return map;
  };

  const walked = new Set<number>(factories.keys());
  let resolved = new Map<string, number>();
  let rounds = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds = round + 1;
    const stores = new Map<string, StoreFact>();
    for (const fn of walked) walkOne(mod, analysis, fn, factories.get(fn), resolved, exportsOf, { stores });

    const next = resolveSlotValues(
      slotIndex,
      new Map([...stores].map(([site, fact]) => [site, { key: fact.key, value: fact.module }])),
    );

    let changed = next.size !== resolved.size;
    if (!changed) for (const [k, v] of next) if (resolved.get(k) !== v) changed = true;
    resolved = next;
    let grew = false;
    for (const key of resolved.keys()) {
      for (const reader of slotOfKey.get(key)?.readers ?? []) if (!walked.has(reader)) (walked.add(reader), (grew = true));
    }
    if (!changed && !grew) break;
  }

  const edges = new Map<string, ResolvedCallRow>();
  const counts = { exportCalls: 0, unresolved: 0 };
  for (const fn of walked) walkOne(mod, analysis, fn, factories.get(fn), resolved, exportsOf, { edges, counts });
  const rows = [...edges.values()].sort((a, b) => a.caller - b.caller || a.site - b.site);
  return { rows, walked: walked.size, resolvedSlots: resolved.size, rounds, exportCalls: counts.exportCalls, unresolvedExportCalls: counts.unresolved };
}
