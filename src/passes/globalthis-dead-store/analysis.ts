// globalthis-dead-store analysis — docs/LOWERING-CATALOGUE.md R11,
// docs/BUGS.md 2026-09-01 "`r0 = globalThis` dead store survives the
// global-access rewrite".
//
// `global-access`'s writer (spec 03 section 5) deletes the guard `if` and
// folds the guarded read to a bare identifier, but deliberately leaves the
// `rN = globalThis` store that fed it: `expr-rebuild` has already reached
// its fixed point by the time `global-access` runs (stage B passes run once
// each, in registry order), so the store still had a read after it when
// `expr-rebuild`'s R1b dead-store rule looked at it. `var-naming` (spec 07
// section 4.2 item 2) then refuses on purpose to touch a `globalThis` alias
// ("a rename-only pass cannot delete the binding"), so without this rung the
// dead store rides all the way to emit and round-trips as a live
// `GetGlobalObject`+`TryGetById` that `hermesc -O` cannot prove dead.
import type { Stmt } from "../ast.ts";
import { identUses, isRegisterName, spliceList, stmtLists } from "../ast.ts";

export interface Analysis {
  /** Every statement this rung deletes, by identity. Empty means "no site". */
  readonly deadStores: ReadonlySet<Stmt>;
  /** `deadStores`, plus the register name each one wrote — for `check`. */
  readonly deadRegisters: ReadonlyMap<Stmt, string>;
}

/** Is `s` exactly the statement shape `src/emit/lower.ts`'s `GetGlobalObject`
 *  case emits (`set(dst, id("globalThis"))`, i.e. `assign(R(dst),
 *  id("globalThis"))`) — the only shape this rung may ever delete. */
function isGlobalThisStore(s: Stmt): { readonly reg: string } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "ident" || !isRegisterName(target.name)) return null;
  if (value.k !== "ident" || value.name !== "globalThis") return null;
  return { reg: target.name };
}

/**
 * "Is `reg`'s value, as stored by the candidate at `list[fromIndex - 1]`,
 * ever read before something redefines it?" — a purely local, position-
 * sensitive scan of `list[fromIndex..]`, the same shape of question
 * `expr-rebuild`'s own R1b deadness rule asks (`isDeadAfter`/D-a there),
 * needed here for exactly the reason expr-rebuild's own check cannot
 * answer it for us: this rung looks at the function *after*
 * `global-access` has already folded the guarded read away, so a
 * whole-function "is `reg` read anywhere at all" count (D-b's shortcut)
 * can be fooled by a read that belongs to a *later*, unrelated write of
 * the same register (Hermes reuses a dead register for the next unrelated
 * value — the same reuse `global-access`'s own `isProvenGlobal` and
 * `reg-split`'s webs both already model) rather than to this one.
 *
 * - A read of `reg` anywhere in a scanned statement (`identUses([s], reg)
 *   .reads > 0`, which already recurses into that statement's own nested
 *   lists): "not-dead" — the store's value really does reach a read.
 * - A write with no accompanying read: "dead" when it is exactly the plain
 *   top-level shape `reg = …` / `let reg = …` (an unconditional
 *   redefinition — nothing between the candidate and here read the old
 *   value, so it never will), else "unknown" — a write buried in a
 *   branch/loop does not *prove* every path redefines `reg`, and this
 *   scan has no reachability analysis to settle it (§4 condition 6 of
 *   `global-access` names the same limit for the same reason).
 * - No mention of `reg` at all in a scanned statement: transparent, keep
 *   scanning.
 * - Reaching the end of `list`: "dead" when `list` is the function's own
 *   top-level body (`isFnBody`) — there is nothing left to reach.
 *   Otherwise "unknown": whatever follows the enclosing block might still
 *   read the old value, and this scan does not look past `list`'s own end.
 */
type LocalVerdict = "dead" | "not-dead" | "unknown";

function isDeadLocally(list: readonly Stmt[], fromIndex: number, reg: string, isFnBody: boolean): LocalVerdict {
  for (let m = fromIndex; m < list.length; m++) {
    const s = list[m]!;
    const u = identUses([s], reg);
    if (u.reads > 0) return "not-dead";
    if (u.writes > 0) {
      const isPlainWrite = (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg) || (s.k === "init" && s.name === reg);
      return isPlainWrite ? "dead" : "unknown";
    }
  }
  return isFnBody ? "dead" : "unknown";
}

/**
 * Every `globalThis`-store statement, anywhere in `fnBody` (at any nesting
 * depth, never inside a nested `func`'s own frame — `stmtLists` already
 * excludes those), that `isDeadLocally` proves dead, or that has zero
 * remaining reads in the whole function when the local scan is
 * inconclusive (the "unknown" verdict, above — sound because "no read
 * anywhere" trivially implies "no read reachable from here" too). Sound:
 * reading the identifier `globalThis` can never throw or observe
 * anything, a plain `=` never reads its own target first, and `identUses`
 * never follows a register name across a `func` boundary, so a nested
 * closure's own same-numbered register can never hide behind either check
 * (see `IdentUses.nested`'s doc in `src/passes/ast.ts`).
 */
export function analyze(fnBody: readonly Stmt[]): Analysis {
  const deadStores = new Set<Stmt>();
  const deadRegisters = new Map<Stmt, string>();
  for (const list of stmtLists(fnBody)) {
    const isFnBody = list === fnBody;
    for (let k = 0; k < list.length; k++) {
      const s = list[k]!;
      const store = isGlobalThisStore(s);
      if (store === null) continue;
      const local = isDeadLocally(list, k + 1, store.reg, isFnBody);
      const dead = local === "dead" || (local === "unknown" && identUses(fnBody, store.reg).reads === 0);
      if (!dead) continue;
      deadStores.add(s);
      deadRegisters.set(s, store.reg);
    }
  }
  return { deadStores, deadRegisters };
}

/** Delete every statement `analyze` named, leaving everything else (order,
 *  identity, every other field) untouched. */
export function applyAnalysis(fnBody: readonly Stmt[], a: Analysis): readonly Stmt[] {
  let current = fnBody;
  for (const list of stmtLists(fnBody)) {
    const keep = list.filter((s) => !a.deadStores.has(s));
    if (keep.length !== list.length) current = spliceList(current, list, keep);
  }
  return current;
}
