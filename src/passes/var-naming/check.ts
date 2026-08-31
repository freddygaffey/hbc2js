// var-naming checker — docs/specs/passes/07-var-naming.md §7.
//
// `check(before, after, ctx)` gets no access to `match`'s captured data, so
// `from`/`to` are recovered by diffing `before`/`after` directly: `rewrite`
// only ever changes the leading `decl.names` entry for one register (plus
// every matching `ident`/assign-target/`init`-name, none of which changes a
// statement's `k` or the list's length), so the one position where the
// `decl` statement's `names` differ between `before` and `after` is the
// rung's own site.
import type { Stmt } from "../ast.ts";
import { defUse, freeNames, identUses, isRegisterName, printProgram } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { declaredNames } from "./match.ts";
import { renameRegisterInFrame } from "./rewrite.ts";

/** The one `(from, to)` pair `rewrite` could have produced, recovered from a
 *  structural diff of `before`/`after`'s leading `decl` statement alone. */
function findRename(before: readonly Stmt[], after: readonly Stmt[]): { readonly from: string; readonly to: string } | null {
  if (before.length !== after.length) return null;
  const beforeDecl = before.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  const afterDecl = after.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  if (beforeDecl === undefined || afterDecl === undefined) return null;
  if (beforeDecl.names.length !== afterDecl.names.length) return null;
  let diff: { from: string; to: string } | null = null;
  for (let i = 0; i < beforeDecl.names.length; i++) {
    const b = beforeDecl.names[i]!;
    const a = afterDecl.names[i]!;
    if (b !== a) {
      if (diff !== null) return null; // more than one name changed — not this rung's shape
      diff = { from: b, to: a };
    }
  }
  return diff;
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const renamed = findRename(before, after);
  if (renamed === null) {
    return { ok: false, reason: "unexpected shape: var-naming only ever renames one register's occurrences in place, never adds/removes/reorders a statement" };
  }
  const { from, to } = renamed;
  if (!isRegisterName(from)) return { ok: false, reason: "unexpected shape: the renamed decl entry was not a register name" };

  const fnBody = ctx.fnBody ?? before;

  // Item 2: `to` is not declared/free anywhere the rung can see (re-run the
  // §4.3 taken-set test rather than trusting the match).
  if (freeNames(fnBody).has(to)) return { ok: false, reason: "captures-free-name" };
  if (declaredNames(fnBody).has(to)) return { ok: false, reason: "already-declared" };

  // Item 1: `freeNames(after)` equals `freeNames(before)` with `from`
  // replaced by `to` (registers are never free names themselves, so in
  // practice this just confirms the rewrite introduced no new free name).
  const freeBefore = freeNames(before);
  if (freeBefore.has(to)) return { ok: false, reason: "the target name is already free in the function before the rename" };
  const expectedFree = new Set(freeBefore);
  if (expectedFree.has(from)) {
    expectedFree.delete(from);
    expectedFree.add(to);
  }
  const freeAfter = freeNames(after);
  if (freeAfter.size !== expectedFree.size || [...expectedFree].some((n) => !freeAfter.has(n))) {
    return { ok: false, reason: "the rewrite changed the function's free-name set beyond replacing from with to" };
  }

  // Item 4: reference counts match, and no `from` survives anywhere,
  // including inside a nested `func` (a surviving `nested > 0` here would
  // mean the rename wrongly reached into — or a stray occurrence remains
  // outside — this frame; see rewrite.ts's frame boundary).
  const beforeCount = identUses(before, from);
  const afterCount = identUses(after, to);
  if (beforeCount.reads + beforeCount.writes !== afterCount.reads + afterCount.writes) {
    return { ok: false, reason: "the rewrite changed the number of references to the renamed register" };
  }
  const survivingFrom = identUses(after, from);
  if (survivingFrom.reads + survivingFrom.writes + survivingFrom.nested > 0) {
    return { ok: false, reason: "the old register name still appears after the rewrite" };
  }

  // Item 5 (frame-locality, register-specific): the exact def/read positions
  // must carry over one-for-one from `from` to `to`.
  const duBefore = defUse(before).get(from);
  const duAfter = defUse(after).get(to);
  const beforeDefs = duBefore?.defs ?? [];
  const beforeReads = duBefore?.reads ?? [];
  const afterDefs = duAfter?.defs ?? [];
  const afterReads = duAfter?.reads ?? [];
  if (beforeDefs.length !== afterDefs.length || beforeDefs.some((v, i) => v !== afterDefs[i])) {
    return { ok: false, reason: "the rewrite changed which statements define the renamed register" };
  }
  if (beforeReads.length !== afterReads.length || beforeReads.some((v, i) => v !== afterReads[i])) {
    return { ok: false, reason: "the rewrite changed which statements read the renamed register" };
  }

  // Item 3: printing `before`, and printing `after` with the rename undone,
  // is byte-identical.
  if (printProgram(before) !== printProgram(renameRegisterInFrame(after, to, from))) {
    return { ok: false, reason: "the rewrite is not a pure rename: undoing it does not reproduce the original source" };
  }

  return { ok: true };
}
