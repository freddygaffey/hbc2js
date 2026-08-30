// docs/specs/03-cfg.md §5 — exception-region carving, done BEFORE anything
// structural. Handler ranges are properly nested in hermesc output; a crossing
// pair is E_BAD_HANDLER rather than an invented semantics (§3.3).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";
import type { ExceptionHandler } from "../parse/types.ts";
import type { BasicBlock, BlockId, ExceptionRegion } from "./types.ts";

export interface CarveResult {
  readonly regions: readonly ExceptionRegion[];
  readonly exceptionSuccs: ReadonlyMap<BlockId, readonly BlockId[]>;
  readonly diagnostics: readonly Diagnostic[];
}

interface Sorted {
  readonly handler: ExceptionHandler;
  readonly fileOrder: number;
}

export function carveRegions(handlers: readonly ExceptionHandler[], blocks: readonly BasicBlock[], byOffset: ReadonlyMap<number, BlockId>, bytecodeSize: number, functionIndex: number): CarveResult {
  const diagnostics: Diagnostic[] = [];
  if (handlers.length === 0) return { regions: [], exceptionSuccs: new Map(), diagnostics };

  const fail = (msg: string, offset?: number): never => {
    throw new Hbc2jsError(ErrorCode.E_BAD_HANDLER, msg, { functionIndex, ...(offset !== undefined ? { offset } : {}), section: "cfg/exceptions" });
  };

  // Step 2 — validate.
  for (const [i, h] of handlers.entries()) {
    if (!(h.start < h.end && h.end <= bytecodeSize)) fail(`handler ${i}: range [${h.start}, ${h.end}) is empty or overruns bytecodeSizeInBytes=${bytecodeSize}`, h.start);
    if (h.target >= bytecodeSize) fail(`handler ${i}: target ${h.target} >= bytecodeSizeInBytes=${bytecodeSize}`, h.target);
    if (byOffset.get(h.start) === undefined) fail(`handler ${i}: start ${h.start} is not a block boundary`, h.start);
    if (byOffset.get(h.target) === undefined) fail(`handler ${i}: target ${h.target} is not a block boundary`, h.target);
    // An `end` equal to bytecodeSizeInBytes is legal and common (spec 02 §3.3).
    if (h.end !== bytecodeSize && byOffset.get(h.end) === undefined) {
      diagnostics.push({ severity: "warn", code: "W_HANDLER_MISALIGNED", message: `handler ${i}: end ${h.end} is not a block boundary`, context: { functionIndex, offset: h.end } });
    }
  }

  // Step 3 — sort a copy by (start asc, end desc) => outermost first. Two entries
  // with the *identical* range (a `try` with both a `catch` and a `finally`
  // compiles to exactly that) are ordered by file order DESCENDING, because the
  // VM's `BCProviderBase::findCatchTargetOffset` returns the FIRST matching
  // table entry: for equal ranges the earlier entry is the *inner* handler, so
  // the later entry must sort first (outermost first). Sorting them the other
  // way round makes the `catch` the outer `try` and the exception is swallowed
  // by the `finally`'s rethrow instead (review M4-C1).
  const sorted: Sorted[] = handlers.map((handler, fileOrder) => ({ handler, fileOrder }));
  sorted.sort((a, b) => a.handler.start - b.handler.start || b.handler.end - a.handler.end || b.fileOrder - a.fileOrder);

  // Step 4 — reject crossing (partially overlapping, non-nested) pairs.
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!.handler;
      const b = sorted[j]!.handler;
      // sorted: a.start <= b.start. Crossing iff b starts inside a and ends outside.
      if (b.start < a.end && b.end > a.end) {
        fail(`handlers ${sorted[i]!.fileOrder} [${a.start},${a.end}) and ${sorted[j]!.fileOrder} [${b.start},${b.end}) partially overlap without nesting`, b.start);
      }
    }
  }

  // Step 6 — bodyBlocks (block-aligned by construction, §4.1 rules 5–6).
  type MutableRegion = { -readonly [K in keyof ExceptionRegion]: K extends "children" | "sharesHandlerWith" ? number[] : ExceptionRegion[K] };
  const regionsMut = sorted.map((s, index): MutableRegion => {
    const h = s.handler;
    const handlerBlock = byOffset.get(h.target)!;
    const body = new Set<BlockId>();
    for (const b of blocks) {
      if (b.start < 0) continue; // synthetic dispatcher owns no bytes
      if (b.start >= h.start && b.end <= h.end) body.add(b.id);
    }
    // Step 9 — a handler target that does not begin with `Catch` means the
    // handler table or the decode is wrong. Fatal, not a formality.
    const hb = blocks[handlerBlock]!;
    const first = hb.instructions[0];
    if (first === undefined || first.name !== "Catch") {
      fail(`handler ${s.fileOrder}: target block at ${h.target} begins with ${first?.name ?? "<empty>"}, not Catch`, h.target);
    }
    return {
      index,
      startPc: h.start,
      endPc: h.end,
      handlerBlock,
      catchRegister: first!.operands[0]!.value,
      bodyBlocks: body,
      parent: null,
      children: [],
      sharesHandlerWith: [],
    };
  });

  // Step 7 — parent = nearest preceding region containing this one. "Containing"
  // includes an *equal* range: by step 3's ordering the preceding equal-range
  // region is the one with the higher file order, which the VM's first-match
  // rule makes the outer handler. Without this, equal-range regions become
  // siblings and the structurer nests them in table order — inverted (M4-C1).
  for (let i = 0; i < regionsMut.length; i++) {
    const r = regionsMut[i]!;
    for (let j = i - 1; j >= 0; j--) {
      const c = regionsMut[j]!;
      const contains = c.startPc <= r.startPc && r.endPc <= c.endPc;
      if (contains) {
        r.parent = j;
        c.children.push(i);
        break;
      }
    }
  }

  // Step 8 — group by target to fill sharesHandlerWith.
  const byTarget = new Map<BlockId, number[]>();
  for (const r of regionsMut) {
    const g = byTarget.get(r.handlerBlock);
    if (g === undefined) byTarget.set(r.handlerBlock, [r.index]);
    else g.push(r.index);
  }
  for (const group of byTarget.values()) {
    if (group.length < 2) continue;
    for (const i of group) regionsMut[i]!.sharesHandlerWith = group.filter((x) => x !== i);
  }

  // §4.3 — exception edges, innermost region first.
  const succs = new Map<BlockId, BlockId[]>();
  // Innermost-first ordering: sort region indices for a block by decreasing
  // nesting depth (equivalently increasing range size).
  const depth = regionsMut.map((r) => {
    let d = 0;
    let p = r.parent;
    while (p !== null) {
      d++;
      p = regionsMut[p]!.parent;
    }
    return d;
  });
  for (const b of blocks) {
    const covering = regionsMut.filter((r) => r.bodyBlocks.has(b.id));
    if (covering.length === 0) continue;
    covering.sort((x, y) => depth[y.index]! - depth[x.index]! || x.index - y.index);
    succs.set(
      b.id,
      covering.map((r) => r.handlerBlock),
    );
  }

  return { regions: regionsMut as readonly ExceptionRegion[], exceptionSuccs: succs, diagnostics };
}
