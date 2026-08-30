// loop-cond writer. Emits only the captured shape: the loop gets its `form`
// annotation, the exit branch becomes `break L`, and the hoisted exit code (if
// any) follows the loop — inside the labeled block when the guard lived there.
import { seq } from "../../structure/ir.ts";
import type { Stmt } from "../../structure/ir.ts";
import { items } from "../tree.ts";
import type { LoopMatch } from "./match.ts";

export function rewrite(m: LoopMatch): Stmt {
  const { loop, shape, cond, negate, guard, exit, labeled, kind } = m.data;
  const L = loop.label;
  if (shape === "head") return { ...loop, form: { kind, cond, at: "head", negate } };

  const brk: Stmt = { k: "break", label: L };
  const guardOut: Stmt = negate ? { ...guard, then: brk } : { ...guard, else: brk };
  const hoist = exit.k === "break" && exit.label === L ? null : exit;

  if (shape === "tail") {
    const body = items(loop.body);
    const inner: Stmt = { k: "seq", body: [...body.slice(0, -1), guardOut] };
    const out: Stmt = { ...loop, body: inner, form: { kind, cond, at: "tail", negate } };
    return hoist === null ? out : seq([out, hoist]);
  }

  // tail-labeled: M: { A2…; guard } ; T…   ->   M: { loop { A…; A2…; guard' }; E } ; T…
  const M = labeled!;
  const body = items(loop.body);
  const mi = body.indexOf(M);
  const before = body.slice(0, mi);
  const trailing = body.slice(mi + 1);
  const mBody = items(M.body);
  const inner: Stmt = { k: "seq", body: [...before, ...mBody.slice(0, -1), guardOut] };
  const out: Stmt = { ...loop, body: inner, form: { kind, cond, at: "tail", negate } };
  const inM: Stmt[] = [out];
  if (hoist !== null) {
    // `E` ending in `break M` is now the last thing in M: the jump is a no-op.
    const parts = hoist.k === "seq" ? hoist.body : [hoist];
    const tail = parts[parts.length - 1];
    inM.push(...(tail !== undefined && tail.k === "break" && tail.label === M.label ? parts.slice(0, -1) : parts));
  }
  const wrapped: Stmt = { ...M, body: seq(inM) };
  return seq([wrapped, ...trailing]);
}
