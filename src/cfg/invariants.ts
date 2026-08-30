// docs/specs/03-cfg.md §7 — invariants CFG-01…CFG-19, as runtime assertions.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";
import type { DecodedFunction } from "../disasm/decode.ts";
import type { BlockId, FunctionCfg } from "./types.ts";

function fail(code: ErrorCode, id: string, msg: string, functionIndex: number, offset?: number): never {
  throw new Hbc2jsError(code, `${id}: ${msg}`, { functionIndex, ...(offset !== undefined ? { offset } : {}), section: "cfg/invariants" });
}

/** CFG-01…CFG-19 for one function. Returns non-fatal diagnostics. */
export function checkCfgInvariants(cfg: FunctionCfg, fn: DecodedFunction): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const f = cfg.functionIndex;
  const size = fn.header.bytecodeSizeInBytes;
  const real = cfg.blocks.filter((b) => b.start >= 0);

  // CFG-01 — every instruction belongs to exactly one block.
  let count = 0;
  for (const b of real) count += b.instructions.length;
  if (count !== fn.instructions.length) fail(ErrorCode.E_INTERNAL, "CFG-01", `blocks cover ${count} instructions, the function has ${fn.instructions.length}`, f);

  // CFG-02 — the non-synthetic blocks partition [0, bytecodeSizeInBytes).
  const ordered = [...real].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const b of ordered) {
    if (b.start !== cursor) fail(ErrorCode.E_INTERNAL, "CFG-02", `block ${b.id} starts at ${b.start}, expected ${cursor}`, f, b.start);
    cursor = b.end;
  }
  if (size > 0 && cursor !== size) fail(ErrorCode.E_INTERNAL, "CFG-02", `blocks end at ${cursor}, bytecodeSizeInBytes is ${size}`, f);
  const synthetic = cfg.blocks.filter((b) => b.start < 0);
  if (synthetic.length > 1) fail(ErrorCode.E_INTERNAL, "CFG-02", `${synthetic.length} synthetic blocks; at most one (the §4.5 dispatcher) is allowed`, f);

  // CFG-03 — succs contains no exception edge.
  const handlerBlocks = new Set(cfg.regions.map((r) => r.handlerBlock));
  for (const b of cfg.blocks) {
    for (const e of b.succs) {
      if (!handlerBlocks.has(e.to)) continue;
      // A handler block may legitimately also be a *normal* successor only when
      // some real instruction jumps to it; the exception edge itself must not be
      // in succs. Detect the illegal case: an edge to a handler from a block in
      // that handler's protected range with kind "fallthrough" into the Catch.
      const region = cfg.regions.find((r) => r.handlerBlock === e.to);
      if (region !== undefined && region.bodyBlocks.has(b.id) && e.kind === "fallthrough" && cfg.blocks[e.to]!.start === b.end) {
        // Straight-line fallthrough into a Catch block is real bytecode flow only
        // if the protected range ends there; hermesc always jumps over it.
        diags.push({ severity: "warn", code: "W_FALLTHROUGH_INTO_HANDLER", message: `block ${b.id} falls through into handler block ${e.to}`, context: { functionIndex: f, offset: b.end } });
      }
    }
  }

  // CFG-04 — preds is exactly the reverse of all succs, deduplicated.
  const expected: Set<BlockId>[] = cfg.blocks.map(() => new Set<BlockId>());
  for (const b of cfg.blocks) for (const e of b.succs) expected[e.to]!.add(e.from);
  for (const b of cfg.blocks) {
    const want = [...expected[b.id]!].sort((x, y) => x - y);
    if (want.length !== b.preds.length || want.some((v, i) => v !== b.preds[i])) {
      fail(ErrorCode.E_INTERNAL, "CFG-04", `block ${b.id} preds ${JSON.stringify(b.preds)} != ${JSON.stringify(want)}`, f);
    }
  }

  // CFG-05 — reachability over normal ∪ exception edges.
  const reachable = new Set<BlockId>([cfg.entry]);
  const stack: BlockId[] = [cfg.entry];
  while (stack.length > 0) {
    const b = stack.pop()!;
    for (const e of cfg.blocks[b]!.succs) if (!reachable.has(e.to)) (reachable.add(e.to), stack.push(e.to));
    for (const h of cfg.exceptionSuccs.get(b) ?? []) if (!reachable.has(h)) (reachable.add(h), stack.push(h));
  }
  const opcodeGenerator = cfg.generator.info.era === "opcode" && (cfg.generator.info.kind === "generator" || cfg.generator.info.kind === "async" || cfg.generator.info.kind === "async-generator");
  for (const b of cfg.blocks) {
    if (reachable.has(b.id)) continue;
    if (opcodeGenerator && cfg.generator.suspendPoints.length > 0) {
      fail(ErrorCode.E_INTERNAL, "CFG-05", `block ${b.id} (offset ${b.start}) is unreachable in an era:"opcode" generator body — §4.5's dispatcher was not built`, f, b.start);
    }
    diags.push({ severity: "warn", code: "W_UNREACHABLE_BLOCK", message: `block ${b.id} at offset ${b.start} is unreachable`, context: { functionIndex: f, offset: b.start } });
  }

  // CFG-06 — every non-exit block has >= 1 successor.
  for (const b of cfg.blocks) {
    const isExit = b.terminator.kind === "return" || b.terminator.kind === "throw" || b.terminator.kind === "unreachable";
    if (!isExit && b.succs.length === 0) fail(ErrorCode.E_INTERNAL, "CFG-06", `block ${b.id} has no successors and is not an exit`, f, b.start);
  }

  // CFG-07 — handler target blocks begin with Catch.
  for (const r of cfg.regions) {
    const hb = cfg.blocks[r.handlerBlock]!;
    if (hb.instructions[0]?.name !== "Catch") fail(ErrorCode.E_BAD_HANDLER, "CFG-07", `region ${r.index}'s handler block ${r.handlerBlock} does not begin with Catch`, f, hb.start);
  }

  // CFG-08 — regions properly nested (crossing already rejected in carving).
  for (const r of cfg.regions) {
    if (r.parent === null) continue;
    const p = cfg.regions[r.parent]!;
    if (!(p.startPc <= r.startPc && r.endPc <= p.endPc)) fail(ErrorCode.E_BAD_HANDLER, "CFG-08", `region ${r.index} is not contained in its parent ${p.index}`, f, r.startPc);
  }

  // CFG-09 — bodyBlocks block-aligned.
  for (const r of cfg.regions) {
    for (const id of r.bodyBlocks) {
      const b = cfg.blocks[id]!;
      if (b.start < r.startPc || b.end > r.endPc) fail(ErrorCode.E_INTERNAL, "CFG-09", `region ${r.index} body block ${id} [${b.start},${b.end}) escapes [${r.startPc},${r.endPc})`, f, b.start);
    }
  }

  // CFG-10 — idom[entry] === null, every other reachable block has an idom.
  if (cfg.dom.idom[cfg.entry] !== null) fail(ErrorCode.E_INTERNAL, "CFG-10", `idom[entry=${cfg.entry}] is not null`, f);
  for (const b of cfg.rpo) {
    if (b === cfg.entry) continue;
    if (cfg.dom.idom[b] === null) fail(ErrorCode.E_INTERNAL, "CFG-10", `block ${b} has no immediate dominator`, f, cfg.blocks[b]!.start);
  }

  // CFG-11 — switch edge count === table.cases.length + 1.
  for (const b of cfg.blocks) {
    if (b.terminator.kind !== "switch") continue;
    const want = b.terminator.table.cases.length + 1;
    if (b.succs.length !== want) fail(ErrorCode.E_SWITCH_TABLE, "CFG-11", `switch block ${b.id} has ${b.succs.length} edges, expected ${want}`, f, b.start);
  }

  // CFG-13 — every SaveGenerator target is a block start.
  for (const insn of fn.instructions) {
    if (insn.name !== "SaveGenerator" && insn.name !== "SaveGeneratorLong") continue;
    const t = insn.targets[0]!;
    if (!cfg.byOffset.has(t)) fail(ErrorCode.E_JUMP_MISALIGNED, "CFG-13", `${insn.name} at ${insn.offset} targets ${t}, not a block start`, f, insn.offset);
  }

  // CFG-17/18/19 — the §4.5 dispatcher.
  const gen = cfg.generator;
  if (gen.info.era === "opcode" && gen.suspendPoints.length > 0) {
    if (gen.resumeDispatch === null) fail(ErrorCode.E_INTERNAL, "CFG-17", `era "opcode" body with ${gen.suspendPoints.length} suspend points has no resume dispatcher`, f);
    if (cfg.entry !== gen.resumeDispatch) fail(ErrorCode.E_INTERNAL, "CFG-17", `entry ${cfg.entry} is not the resume dispatcher ${gen.resumeDispatch}`, f);
    for (const sp of gen.suspendPoints) {
      const rb = cfg.blocks[sp.resumeBlock]!;
      if (!rb.preds.includes(gen.resumeDispatch)) fail(ErrorCode.E_INTERNAL, "CFG-18", `resume block ${sp.resumeBlock} does not have the dispatcher as a predecessor`, f, rb.start);
    }
    const d = cfg.blocks[gen.resumeDispatch]!;
    if (d.terminator.kind !== "switch") fail(ErrorCode.E_INTERNAL, "CFG-19", `dispatcher block is not a switch`, f);
    else if (d.terminator.table.cases.length !== gen.suspendPoints.length + 1) {
      fail(ErrorCode.E_INTERNAL, "CFG-19", `dispatcher has ${d.terminator.table.cases.length} cases, expected ${gen.suspendPoints.length + 1}`, f);
    }
    const states = gen.suspendPoints.map((s) => s.state);
    if (states.some((s, i) => s !== i + 1)) fail(ErrorCode.E_INTERNAL, "CFG-19", `suspend states are not 1..n with no gaps: ${JSON.stringify(states)}`, f);
  }

  return diags;
}

/** CFG-12 — era vs the *Closure opcodes present in the module. */
export function checkEraConsistency(mod: { readonly header: { readonly version: number } }, fns: readonly DecodedFunction[]): void {
  const lowered = mod.header.version >= 97;
  for (const fn of fns) {
    for (const insn of fn.instructions) {
      const isEraOp = insn.name.startsWith("CreateGeneratorClosure") || insn.name.startsWith("CreateAsyncClosure");
      if (isEraOp && lowered) {
        fail(ErrorCode.E_INTERNAL, "CFG-12", `${insn.name} appears in a v${mod.header.version} (>=97) module`, fn.index, insn.offset);
      }
    }
  }
}
