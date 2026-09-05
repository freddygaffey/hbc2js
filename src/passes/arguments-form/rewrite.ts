// arguments-form writer -- spec 23 section 3.1. A single post-order
// traversal replacing every matched `__hbc_arguments(arguments)` call node
// (by identity) with a bare `{k:"argumentsObject"}` read; every other node
// is returned `===`-identical (`mapStmts`'s own identity-preserving rebuild).
//
// `inlineSingleUseTemp` is a small, deliberately narrow companion: this rung
// runs after `expr-rebuild` (spec 23 section 2), which never folds a call's
// result into its use site (`isPure` excludes `call`, `expr-rebuild/match.ts`
// section on purity) -- so a reify call assigned to a temp with exactly one
// further (safe, member-read) use is left as `r0 = __hbc_arguments(arguments);
// … slice.call(r0);` by the time this rung runs. Once the call becomes a bare
// `arguments`, that same assignment *is* pure, and `expr-rebuild` would fold
// it away if it ran again -- it does not get a second turn (each stage-B
// pass reaches its own fixed point once, `src/passes/ast.ts`'s
// `applyAstPasses`), so this rung finishes that one fold itself rather than
// leave a needless `rN = arguments;` temp in its own output. Scoped to
// exactly the safety condition R-A3(b) already proved (a single, otherwise
// unused register read as the object of a read member expression): nothing
// about *what* is deleted or introduced differs from that proof.
import type { Expr, Stmt } from "../ast.ts";
import { identUses, isRegisterName, mapStmts, spliceList, stmtLists } from "../ast.ts";
import type { ArgumentsFormMatch } from "./match.ts";

/** Exported so `check.ts` can independently re-derive the expected `after`
 *  from `before` and `m.data.calls` alone, rather than trust this file. */
export function replaceCalls(list: readonly Stmt[], calls: readonly Expr[]): readonly Stmt[] {
  const set = new Set(calls);
  const bare: Expr = { k: "argumentsObject" };
  return mapStmts(list, (s) => s, (e) => (set.has(e) ? bare : e));
}

/** Is `name` read anywhere in `stmts` before the first statement that
 *  WRITES it? A later write is a fresh, unrelated definition (Hermes freely
 *  reuses a register name for a later, temporally disjoint purpose within
 *  the same function -- 49-arguments-object's `toArray` reuses `r0` for the
 *  `,` separator a few statements after its one `arguments` read), so a
 *  read that happens strictly after such a write is a read of THAT later
 *  value, not of the reify result, and must not block the fold. Walked
 *  statement-by-statement (not `identUses(stmts, name)` in one shot) so the
 *  write can act as a cutoff. */
function readOccursBeforeAnyWrite(stmts: readonly Stmt[], name: string): boolean {
  for (const s of stmts) {
    const u = identUses([s], name);
    if (u.reads > 0 || u.nested > 0) return true;
    if (u.writes > 0) return false; // redefined here: nothing after this can be our reify's value
  }
  return false;
}

function isBareArgumentsValue(e: Expr): boolean {
  return e.k === "argumentsObject";
}

/** One statement `name = arguments;` (an `expr`-assign or an `init`) whose
 *  value is exactly the bare-arguments shape `replaceCalls` just produced. */
function assignedArgsTemp(s: Stmt): string | null {
  if (s.k === "init" && isRegisterName(s.name) && isBareArgumentsValue(s.value)) return s.name;
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && isRegisterName(s.expr.target.name) && isBareArgumentsValue(s.expr.value)) return s.expr.target.name;
  return null;
}

/** Fold `rN = arguments; use(rN);` (adjacent statements, in that order) down
 *  to `use(arguments);` for every register `expr-rebuild` left behind
 *  because, at the time it ran, the right-hand side was still an impure
 *  call (`isPure` excludes `call`, and does not itself list
 *  `argumentsObject` either, so this rung folds the one case it created
 *  rather than widen that shared framework predicate). Deliberately
 *  positional rather than whole-function-count-based: Hermes freely reuses a
 *  register name for later, unrelated, temporally disjoint purposes in the
 *  very same function (`49-arguments-object`'s `toArray`: `r0` is also the
 *  separator string a few statements later), so "exactly one read, exactly
 *  one write, anywhere in the function" is the wrong -- too strict --
 *  question. The check below is instead "exactly one *remaining* read of
 *  `name`, in the very next statement, and no read of it anywhere later in
 *  this same statement list" -- checked over `list.slice(i + 1)`, not just
 *  `[next]` (BUGS 2026-09-05, `73-arguments-identity`'s `sliceEach`, two
 *  reads of one reify-derived register: `let r0 = arguments; r2 =
 *  slice.call(r0); … r1 = r0;` -- checking only `[next]` saw the first read,
 *  folded `r0 = arguments;` away, and left the second read (`r1 = r0;`)
 *  referring to a register nothing assigns anymore, silently reading
 *  `undefined`). A later *write* to `name` (the legitimate reuse-for-a-
 *  later-purpose case) still stops the scan at that write via `writes !==
 *  0`, so that reuse remains foldable -- only a later *read* refuses the
 *  fold now. Iterates to a fixed point in case more than one reify call fed
 *  the same pattern. */
export function inlineSingleUseTemp(fnBody: readonly Stmt[]): readonly Stmt[] {
  let current = fnBody;
  for (let guard = 0; guard < 1000; guard++) {
    let progressed = false;
    for (const list of stmtLists(current)) {
      for (let i = 0; i + 1 < list.length; i++) {
        const name = assignedArgsTemp(list[i]!);
        if (name === null) continue;
        const next = list[i + 1]!;
        const uses = identUses([next], name);
        if (uses.reads !== 1 || uses.writes !== 0 || uses.nested !== 0) continue;
        // No further read of `name`'s CURRENT (reify) value anywhere later
        // in this statement list -- a read after some later statement
        // rewrites `name` for an unrelated purpose does not count (the fold
        // above already accounted for the one read in `next`).
        const rest = list.slice(i + 2);
        if (readOccursBeforeAnyWrite(rest, name)) continue;
        const bare: Expr = { k: "argumentsObject" };
        const newNext = mapStmts([next], (s) => s, (e) => (e.k === "ident" && e.name === name ? bare : e))[0]!;
        const newList = [...list.slice(0, i), newNext, ...list.slice(i + 2)];
        current = spliceList(current, list, newList);
        progressed = true;
        break;
      }
      if (progressed) break;
    }
    if (!progressed) break;
  }
  return current;
}

/** `ctx` is unused: the rewrite is a pure function of the match alone. */
export function rewrite(m: ArgumentsFormMatch): readonly Stmt[] {
  return inlineSingleUseTemp(replaceCalls(m.root, m.data.calls));
}
