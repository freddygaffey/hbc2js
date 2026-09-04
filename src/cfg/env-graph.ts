// docs/specs/03-cfg.md §3.5, §6 — the environment / closure graph.
//
// This is risk R3. hermes-dec emits `_closure1_slot1` identifiers that are never
// declared; the output throws ReferenceError before semantics are in question.
// The rule here (§6.4) is that an unresolved (env, slot) is a hard error, never
// a dangling name.
//
// The analysis is a whole-module fixed point over three interdependent facts:
//   closureEnvOf(f)      which environment function f's closure captured,
//   EnvNode.parent       the static parent of each created environment,
//   slotHoldsEnv(e,s)    a slot whose only stored values are environments
//                        (v>=97 stores an inner environment into an outer slot
//                         and reads it back — see the v99 dump of
//                         23-generator-basic function #3, offsets 0x14e/0x8b).
// Each round runs the §6.2 register tracker per function; the rounds stop when
// nothing new is learned. Every step only ever *adds* knowledge, so it converges.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";
import type { DecodedFunction, Instruction } from "../disasm/decode.ts";
import type { HbcModule } from "../parse/types.ts";
import { writtenRegisters } from "./reg-effects.ts";
import { siteKey } from "./types.ts";
import type { BlockId, EnvAccess, EnvGraph, EnvNode, EnvNodeId, EnvSlot, FunctionCfg } from "./types.ts";

// ---------------------------------------------------------------------------
// Opcode groups (§6.1)
// ---------------------------------------------------------------------------

const CLOSURE_CREATE_OPS: ReadonlySet<string> = new Set([
  "CreateClosure",
  "CreateClosureLongIndex",
  "CreateGeneratorClosure",
  "CreateGeneratorClosureLongIndex",
  "CreateAsyncClosure",
  "CreateAsyncClosureLongIndex",
  "CreateGenerator",
  "CreateGeneratorLongIndex",
]);
const CLASS_CREATE_OPS: ReadonlySet<string> = new Set(["CreateBaseClass", "CreateBaseClassLongIndex", "CreateDerivedClass", "CreateDerivedClassLongIndex"]);
const LOAD_ENV_OPS: ReadonlySet<string> = new Set(["LoadFromEnvironment", "LoadFromEnvironmentL"]);
const STORE_ENV_OPS: ReadonlySet<string> = new Set(["StoreToEnvironment", "StoreToEnvironmentL", "StoreNPToEnvironment", "StoreNPToEnvironmentL"]);

/** True when this instruction creates an environment record. */
export function isEnvCreate(name: string): boolean {
  return name === "CreateEnvironment" || name === "CreateInnerEnvironment" || name === "CreateFunctionEnvironment" || name === "CreateTopLevelEnvironment";
}

// ---------------------------------------------------------------------------
// §6.2 lattice
// ---------------------------------------------------------------------------

// "none" is the *undefined* environment operand. Hermes >= v96 compiles a
// function that captures nothing to `LoadConstUndefined rE; CreateClosure rD,
// rE, fn` — `rE` is not an unknown environment, it is the definite statement
// that this closure has no environment at all (probe: `nocap` in
// tests/fixtures/constructs/61-closure-no-capture, v99 `[@30] LoadConstUndefined
// 1; [@32] CreateClosure 3, 1, 3`). Treating it as UNKNOWN made every such
// function an orphan, and — worse — left its own `selfEnv` unknown, so its
// `CreateFunctionEnvironment` had no parent and every closure *it* created
// cascaded into an orphan too (docs/BUGS.md 2026-09-04, cause b: 2,254 + 1,755
// on react-navigation-example).
type EnvValue =
  | { readonly t: "env"; readonly node: EnvNodeId }
  | { readonly t: "closure"; readonly fn: number; readonly env: EnvNodeId | null }
  | { readonly t: "none" }
  | { readonly t: "unknown" };

const UNKNOWN: EnvValue = { t: "unknown" };
const NO_ENV: EnvValue = { t: "none" };

function sameValue(a: EnvValue, b: EnvValue): boolean {
  if (a.t !== b.t) return false;
  if (a.t === "env" && b.t === "env") return a.node === b.node;
  if (a.t === "closure" && b.t === "closure") return a.fn === b.fn && a.env === b.env;
  return true;
}

type State = Map<number, EnvValue>;

function mergeState(into: State, from: State): boolean {
  let changed = false;
  for (const [reg, v] of from) {
    const cur = into.get(reg);
    if (cur === undefined) {
      into.set(reg, v);
      changed = true;
    } else if (!sameValue(cur, v) && cur.t !== "unknown") {
      into.set(reg, UNKNOWN);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------

interface NodeDraft {
  readonly id: EnvNodeId;
  readonly ownerFunction: number;
  readonly createOffset: number;
  readonly createOpcode: string;
  parent: EnvNodeId | null | undefined; // undefined = not yet known
  size: number;
  readonly closures: Set<number>;
}

export interface EnvGraphInput {
  readonly module: HbcModule;
  decode(i: number): DecodedFunction;
  cfg(i: number): FunctionCfg;
  /** Function indices that decode successfully. */
  readonly functionIndices: readonly number[];
}

const MAX_ROUNDS = 12;

/** Blocks reachable from the entry over normal *and* exception edges. */
export function reachableBlocks(cfg: FunctionCfg): Set<BlockId> {
  const seen = new Set<BlockId>([cfg.entry]);
  const stack: BlockId[] = [cfg.entry];
  while (stack.length > 0) {
    const b = stack.pop()!;
    for (const e of cfg.blocks[b]!.succs) if (!seen.has(e.to)) (seen.add(e.to), stack.push(e.to));
    for (const h of cfg.exceptionSuccs.get(b) ?? []) if (!seen.has(h)) (seen.add(h), stack.push(h));
  }
  return seen;
}

export function buildEnvGraph(input: EnvGraphInput): EnvGraph {
  const mod = input.module;
  const diagnostics: Diagnostic[] = [];

  // ---- Pass A: enumerate env nodes ------------------------------------------
  const drafts: NodeDraft[] = [];
  const nodeAt = new Map<string, EnvNodeId>(); // "fn:offset" -> id
  for (const f of input.functionIndices) {
    const fn = input.decode(f);
    for (const insn of fn.instructions) {
      if (!isEnvCreate(insn.name)) continue;
      const id = drafts.length;
      let size: number;
      if (insn.name === "CreateEnvironment" && insn.operands.length === 1) {
        // v<=96: the size lives in the *function header*, not the instruction.
        size = fn.header.environmentSize ?? 0;
      } else {
        size = insn.operands[insn.operands.length - 1]!.value;
      }
      drafts.push({ id, ownerFunction: f, createOffset: insn.offset, createOpcode: insn.name, parent: undefined, size, closures: new Set() });
      nodeAt.set(siteKey(f, insn.offset), id);
    }
  }

  // ---- Fixed point ----------------------------------------------------------
  const closureEnvOf = new Map<number, EnvNodeId | null>();
  /** Functions every one of whose creation sites passed an *undefined*
   *  environment operand: they capture nothing. Kept apart from `closureEnvOf`
   *  so the fixed point stays monotone — a later site that supplies a real
   *  environment simply wins, and a site that supplies a different real
   *  environment still conflicts through `closureEnvOf`. */
  const noEnvClosures = new Set<number>();
  const closureEnvConflict = new Set<number>();
  closureEnvOf.set(mod.header.globalCodeIndex, null);

  // (env,slot) -> the environment it holds, or "conflict".
  const slotEnv = new Map<string, EnvNodeId | "conflict">();

  const walkUp = (start: EnvNodeId | null | undefined, levels: number): EnvValue => {
    let cur: EnvNodeId | null | undefined = start;
    for (let i = 0; i < levels; i++) {
      if (cur === null || cur === undefined) return UNKNOWN;
      const next: EnvNodeId | null | undefined = drafts[cur]!.parent;
      cur = next;
    }
    return cur === null || cur === undefined ? UNKNOWN : { t: "env", node: cur };
  };

  interface RoundOut {
    readonly accesses: EnvAccess[];
    readonly resolvedAt: Map<string, EnvNodeId>;
  }

  const runFunction = (f: number, collect: RoundOut | null): boolean => {
    const cfg = input.cfg(f);
    const selfEnv = closureEnvOf.has(f) ? closureEnvOf.get(f)! : noEnvClosures.has(f) ? null : undefined;
    let learned = false;
    let state: State = new Map();

    const get = (reg: number): EnvValue => state.get(reg) ?? UNKNOWN;
    const set = (reg: number, v: EnvValue): void => {
      state.set(reg, v);
    };
    const clobber = (insn: Instruction): void => {
      for (const r of writtenRegisters(insn)) set(r, UNKNOWN);
    };

    const noteClosure = (fnId: number, env: EnvNodeId): void => {
      drafts[env]!.closures.add(fnId);
      const known = closureEnvOf.get(fnId);
      if (!closureEnvOf.has(fnId)) {
        closureEnvOf.set(fnId, env);
        learned = true;
      } else if (known !== env && !closureEnvConflict.has(fnId)) {
        closureEnvConflict.add(fnId);
        learned = true;
      }
    };

    const noteNoEnvClosure = (fnId: number): void => {
      if (noEnvClosures.has(fnId)) return;
      noEnvClosures.add(fnId);
      learned = true;
    };

    const applyTransfer = (insn: Instruction, collect: RoundOut | null): void => {
      const name = insn.name;
      if (isEnvCreate(name)) {
        const nodeId = nodeAt.get(siteKey(f, insn.offset))!;
        const draft = drafts[nodeId]!;
        let parent: EnvNodeId | null | undefined;
        if (name === "CreateTopLevelEnvironment") parent = null;
        else if (name === "CreateFunctionEnvironment") parent = selfEnv;
        else if (name === "CreateEnvironment" && insn.operands.length === 1) parent = selfEnv;
        else {
          const pv = get(insn.operands[1]!.value);
          parent = pv.t === "env" ? pv.node : pv.t === "none" ? null : undefined;
        }
        if (parent !== undefined && draft.parent === undefined) {
          draft.parent = parent;
          learned = true;
        }
        set(insn.operands[0]!.value, { t: "env", node: nodeId });
        return;
      }
      if (name === "GetEnvironment") {
        if (insn.operands.length === 2) {
          // v<=96: (dst, levels), counted from the closure's own environment.
          set(insn.operands[0]!.value, walkUp(selfEnv, insn.operands[1]!.value));
        } else {
          const start = get(insn.operands[1]!.value);
          set(insn.operands[0]!.value, start.t === "env" ? walkUp(start.node, insn.operands[2]!.value) : UNKNOWN);
        }
        return;
      }
      if (name === "GetParentEnvironment") {
        set(insn.operands[0]!.value, walkUp(selfEnv, insn.operands[1]!.value));
        return;
      }
      if (name === "GetClosureEnvironment") {
        const c = get(insn.operands[1]!.value);
        set(insn.operands[0]!.value, c.t === "closure" && c.env !== null ? { t: "env", node: c.env } : UNKNOWN);
        return;
      }
      if (name === "LoadConstUndefined") {
        set(insn.operands[0]!.value, NO_ENV);
        return;
      }
      if (name === "Mov" || name === "MovLong") {
        set(insn.operands[0]!.value, get(insn.operands[1]!.value));
        return;
      }
      if (CLOSURE_CREATE_OPS.has(name)) {
        const ev = get(insn.operands[1]!.value);
        const env = ev.t === "env" ? ev.node : null;
        const fnId = insn.operands.find((o) => o.role === "function")!.value;
        if (env !== null) noteClosure(fnId, env);
        else if (ev.t === "none") noteNoEnvClosure(fnId);
        set(insn.operands[0]!.value, { t: "closure", fn: fnId, env });
        return;
      }
      if (CLASS_CREATE_OPS.has(name)) {
        // (closureOut, homeObjectOut, env, [superClass], functionId)
        const ev = get(insn.operands[2]!.value);
        const env = ev.t === "env" ? ev.node : null;
        const fnId = insn.operands[insn.operands.length - 1]!.value;
        if (env !== null) noteClosure(fnId, env);
        else if (ev.t === "none") noteNoEnvClosure(fnId);
        clobber(insn);
        set(insn.operands[0]!.value, { t: "closure", fn: fnId, env });
        return;
      }
      if (LOAD_ENV_OPS.has(name)) {
        const ev = get(insn.operands[1]!.value);
        const slot = insn.operands[2]!.value;
        const env = ev.t === "env" ? ev.node : null;
        if (collect !== null) {
          collect.accesses.push({
            functionIndex: f,
            offset: insn.offset,
            kind: "load",
            slot,
            env,
            ...(env === null ? { unresolvedReason: "reg-not-tracked" as const } : {}),
          });
          if (env !== null) collect.resolvedAt.set(siteKey(f, insn.offset), env);
        }
        if (env !== null) {
          const held = slotEnv.get(`${env}:${slot}`);
          set(insn.operands[0]!.value, held !== undefined && held !== "conflict" ? { t: "env", node: held } : UNKNOWN);
        } else {
          set(insn.operands[0]!.value, UNKNOWN);
        }
        return;
      }
      if (STORE_ENV_OPS.has(name)) {
        const ev = get(insn.operands[0]!.value);
        const slot = insn.operands[1]!.value;
        const env = ev.t === "env" ? ev.node : null;
        if (collect !== null) {
          collect.accesses.push({
            functionIndex: f,
            offset: insn.offset,
            kind: "store",
            slot,
            env,
            ...(env === null ? { unresolvedReason: "reg-not-tracked" as const } : {}),
          });
          if (env !== null) collect.resolvedAt.set(siteKey(f, insn.offset), env);
        }
        if (env !== null) {
          const val = get(insn.operands[2]!.value);
          const key = `${env}:${slot}`;
          const cur = slotEnv.get(key);
          if (val.t === "env") {
            if (cur === undefined) {
              slotEnv.set(key, val.node);
              learned = true;
            } else if (cur !== val.node && cur !== "conflict") {
              slotEnv.set(key, "conflict");
              learned = true;
            }
          } else if (cur !== undefined && cur !== "conflict") {
            slotEnv.set(key, "conflict");
            learned = true;
          }
          const d = drafts[env]!;
          if (slot + 1 > d.size) d.size = slot + 1;
        }
        return;
      }
      clobber(insn);
    };

    // Virtual predecessors: a v<=96 generator resumes with the register frame the
    // matching SaveGenerator saved, so a resume block's entry state is the save
    // site's exit state. Without this every access in a resume block is unknown.
    const virtualPreds = new Map<BlockId, BlockId[]>();
    for (const sp of cfg.generator.suspendPoints) {
      const saveBlock = cfg.blocks.find((b) => b.start >= 0 && sp.saveOffset >= b.start && sp.saveOffset < b.end);
      if (saveBlock === undefined) continue;
      const list = virtualPreds.get(sp.resumeBlock);
      if (list === undefined) virtualPreds.set(sp.resumeBlock, [saveBlock.id]);
      else list.push(saveBlock.id);
    }

    // An exception can be raised at any instruction boundary inside a protected
    // range, so a handler block's entry state is the meet of the states at every
    // such boundary. Handler blocks have no *normal* predecessor (CFG-03), so
    // without this their entry state is empty and every environment access in a
    // catch block reports unresolved.
    const throwSuccs = cfg.exceptionSuccs;

    const entryState: State[] = cfg.blocks.map(() => new Map());
    const exitState: State[] = cfg.blocks.map(() => new Map());
    const inWorklist = new Uint8Array(cfg.blocks.length);
    const worklist: BlockId[] = [];
    const push = (b: BlockId): void => {
      if (inWorklist[b] === 1) return;
      inWorklist[b] = 1;
      worklist.push(b);
    };
    for (const b of cfg.rpo) push(b);

    let guard = 0;
    const budget = cfg.blocks.length * 8 + 64;
    while (worklist.length > 0) {
      if (++guard > budget) break; // §6.2: cap and bail rather than spin
      const id = worklist.shift()!;
      inWorklist[id] = 0;
      const block = cfg.blocks[id]!;
      state = new Map(entryState[id]!);
      const handlers = throwSuccs.get(id) ?? [];
      for (const h of handlers) if (mergeState(entryState[h]!, state)) push(h);
      for (const insn of block.instructions) {
        applyTransfer(insn, null);
        for (const h of handlers) if (mergeState(entryState[h]!, state)) push(h);
      }

      const before = exitState[id]!;
      let changed = before.size !== state.size;
      if (!changed) {
        for (const [k, v] of state) {
          const old = before.get(k);
          if (old === undefined || !sameValue(old, v)) {
            changed = true;
            break;
          }
        }
      }
      if (!changed && guard > cfg.blocks.length) continue;
      exitState[id] = state;
      for (const e of block.succs) {
        if (mergeState(entryState[e.to]!, state)) push(e.to);
      }
      for (const [target, sources] of virtualPreds) {
        if (!sources.includes(id)) continue;
        if (mergeState(entryState[target]!, state)) push(target);
      }
    }

    // Collection happens only after the dataflow has converged. Recording an
    // access on every visit would freeze the *first*, least-informed answer —
    // and for a v<=96 generator's resume block the first visit happens before
    // the SaveGenerator site has propagated anything, so every access there
    // would be reported unresolved.
    if (collect !== null) {
      const reachable = reachableBlocks(cfg);
      for (const block of cfg.blocks) {
        // Unreachable blocks (dead tails after a Ret) have no meaningful entry
        // state; recording their accesses would report spurious unresolved sites
        // for code that never runs. The emitter does not emit them either.
        if (!reachable.has(block.id)) continue;
        state = new Map(entryState[block.id]!);
        for (const insn of block.instructions) applyTransfer(insn, collect);
      }
    }
    return learned;
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let learned = false;
    for (const f of input.functionIndices) {
      if (runFunction(f, null)) learned = true;
    }
    if (!learned) break;
  }

  // ---- Final round: collect accesses ---------------------------------------
  const collected: RoundOut = { accesses: [], resolvedAt: new Map() };
  for (const f of input.functionIndices) runFunction(f, collected);

  // A function whose every creation site passed an *undefined* environment is
  // not an orphan: its environment is known to be none. A function created both
  // with a real environment and with none is genuinely ambiguous — binding it to
  // the real one would be a silent mis-binding on the other path — so it joins
  // the W_AMBIGUOUS_CLOSURE_ENV set and stays unhosted.
  for (const f of noEnvClosures) {
    if (!closureEnvOf.has(f)) closureEnvOf.set(f, null);
    else if (closureEnvOf.get(f) !== null) closureEnvConflict.add(f);
  }

  for (const f of closureEnvConflict) {
    diagnostics.push({
      severity: "warn",
      code: "W_AMBIGUOUS_CLOSURE_ENV",
      message: `function ${f} is created with more than one environment; treating it as an orphan`,
      context: { functionIndex: f },
    });
    closureEnvOf.set(f, null);
  }

  // ---- Nodes, slots, classification ----------------------------------------
  const nodes: EnvNode[] = drafts.map((d) => ({
    id: d.id,
    ownerFunction: d.ownerFunction,
    createOffset: d.createOffset,
    createOpcode: d.createOpcode,
    parent: d.parent ?? null,
    size: d.size,
    closures: [...d.closures].sort((a, b) => a - b),
  }));

  const envsCreatedIn = new Map<number, EnvNodeId[]>();
  for (const n of nodes) {
    const list = envsCreatedIn.get(n.ownerFunction);
    if (list === undefined) envsCreatedIn.set(n.ownerFunction, [n.id]);
    else list.push(n.id);
  }

  /** Environments visible where function `f`'s body is emitted (§6.3). */
  const visibleCache = new Map<number, Set<EnvNodeId>>();
  const visibleIn = (f: number): Set<EnvNodeId> => {
    const cached = visibleCache.get(f);
    if (cached !== undefined) return cached;
    const out = new Set<EnvNodeId>(envsCreatedIn.get(f) ?? []);
    visibleCache.set(f, out); // set before walking: guards against a cyclic chain
    let e: EnvNodeId | null = closureEnvOf.get(f) ?? null;
    const seen = new Set<EnvNodeId>();
    while (e !== null && !seen.has(e)) {
      seen.add(e);
      out.add(e);
      e = nodes[e]!.parent;
    }
    return out;
  };

  const slotMap = new Map<string, { accesses: EnvAccess[]; readers: Set<number>; writers: Set<number> }>();
  for (const a of collected.accesses) {
    if (a.env === null) continue;
    const key = `${a.env}:${a.slot}`;
    let rec = slotMap.get(key);
    if (rec === undefined) {
      rec = { accesses: [], readers: new Set(), writers: new Set() };
      slotMap.set(key, rec);
    }
    rec.accesses.push(a);
    (a.kind === "load" ? rec.readers : rec.writers).add(a.functionIndex);
  }

  const slots: EnvSlot[] = [];
  const slotIndex = new Map<string, number>();
  for (const [key, rec] of [...slotMap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const [envText, slotText] = key.split(":");
    const env = Number(envText);
    const slot = Number(slotText);
    let lexical = true;
    for (const f of [...rec.readers, ...rec.writers]) {
      if (!visibleIn(f).has(env)) {
        lexical = false;
        break;
      }
    }
    slotIndex.set(key, slots.length);
    slots.push({ env, slot, accesses: rec.accesses, readers: rec.readers, writers: rec.writers, strategy: lexical ? "lexical" : "materialised" });
    const d = nodes[env];
    if (d !== undefined && slot + 1 > d.size) {
      diagnostics.push({
        severity: "warn",
        code: "W_ENV_SLOT_OOB",
        message: `env ${env} slot ${slot} is beyond its declared size ${d.size}`,
        context: { functionIndex: d.ownerFunction, offset: d.createOffset },
      });
    }
  }

  const unresolved = collected.accesses.filter((a) => a.env === null);

  return {
    nodes,
    slots,
    slot(env: EnvNodeId, slot: number): EnvSlot | undefined {
      const i = slotIndex.get(`${env}:${slot}`);
      return i === undefined ? undefined : slots[i];
    },
    closureEnvOf,
    envsCreatedIn,
    resolvedAt: collected.resolvedAt,
    envInSlot: new Map([...slotEnv].filter((e): e is [string, EnvNodeId] => e[1] !== "conflict")),
    unresolved,
    diagnostics,
  };
}

/** §6.4 — the R3 rule, applied by the caller when `strictEnv`. */
export function assertResolved(graph: EnvGraph): void {
  if (graph.unresolved.length === 0) return;
  const a = graph.unresolved[0]!;
  throw new Hbc2jsError(
    ErrorCode.E_ENV_UNRESOLVED,
    `${graph.unresolved.length} environment access(es) could not be resolved statically; first: function ${a.functionIndex} offset ${a.offset} (${a.kind} slot ${a.slot}, ${a.unresolvedReason ?? "unknown"})`,
    { functionIndex: a.functionIndex, offset: a.offset, section: "cfg/env-graph" },
  );
}
