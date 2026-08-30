// fn-naming checker — docs/specs/passes/05-fn-naming.md §6.
//
// `check(before, after, ctx)` gets no access to `match`'s captured data, so
// `from`/`to` are recovered by diffing `before`/`after` directly: `rewrite`
// only ever changes one `func` statement's `name` field (plus every matching
// `ident`, which does not change a statement's `k`), so the position where a
// `k:"func"` statement's `name` differs between `before` and `after` is the
// one site the rung touched.
import type { Stmt } from "../ast.ts";
import { declaredNames, EMITTER_NAME_CLASS_RE, FN_RE, IDENT_RE } from "./match.ts";
import { freeNames, identUses, isSafeIdentifier, printProgram } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { renameIdent } from "./rewrite.ts";

/** The one `(from, to)` pair `rewrite` could have produced, recovered from a
 *  structural diff of `before`/`after` alone. `null` when no such pair is
 *  found (the "unexpected shape" refusals below fire from here). */
function findRename(before: readonly Stmt[], after: readonly Stmt[]): { readonly from: string; readonly to: string } | null {
  if (before.length !== after.length) return null;
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!;
    const a = after[i]!;
    if (b.k === "func" && a.k === "func" && b.name !== a.name) return { from: b.name, to: a.name };
  }
  return null;
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const renamed = findRename(before, after);
  if (renamed === null) {
    return { ok: false, reason: "unexpected shape: fn-naming only ever renames one func statement in place, never adds/removes/reorders a statement" };
  }
  const { from, to } = renamed;
  if (!FN_RE.test(from)) return { ok: false, reason: "unexpected shape: the renamed statement's original name was not an _fnN binding" };

  const fnBody = ctx.fnBody ?? before;

  // Item 2: `to` is not a declared name in `before`, in any enclosing scope
  // the rung can see, or in any nested `func` — re-run §4 conditions 2-5
  // rather than trusting the match.
  if (!IDENT_RE.test(to)) return { ok: false, reason: "unsafe-identifier" };
  if (!isSafeIdentifier(to)) return { ok: false, reason: "reserved-word" };
  if (EMITTER_NAME_CLASS_RE.test(to)) return { ok: false, reason: "emitter-name-class" };
  if (freeNames(fnBody).has(to)) return { ok: false, reason: "captures-free-name" };
  if (declaredNames(fnBody).has(to)) return { ok: false, reason: "already-declared" };

  // Item 1: `freeNames(after)` equals `freeNames(before)` with `from`
  // replaced by `to`, and `to` was not already in `freeNames(before)`.
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

  // Item 4: the counts match, and no `from` survives.
  const beforeCount = identUses(before, from);
  const afterCount = identUses(after, to);
  if (beforeCount.reads + beforeCount.writes !== afterCount.reads + afterCount.writes) {
    return { ok: false, reason: "the rewrite changed the number of references to the renamed function" };
  }
  // "identUses(after, from) is zero" (§6 item 4) means the whole triple —
  // `reads`/`writes` *and* `nested` — is zero: a rewrite that renamed the
  // `func` statement itself but missed a recursive self-reference deep inside
  // its own (nested) body would otherwise slip past both this check and
  // obligation 3 (undoing the rename on an untouched `from` occurrence
  // reproduces `before` exactly, since it was never touched in the first
  // place) — only counting `nested` here catches it.
  const survivingFrom = identUses(after, from);
  if (survivingFrom.reads + survivingFrom.writes + survivingFrom.nested > 0) {
    return { ok: false, reason: "the old _fnN name still appears after the rewrite" };
  }

  // Item 3: printing `before`, and printing `after` with the rename undone,
  // is byte-identical.
  if (printProgram(before) !== printProgram(renameIdent(after, to, from))) {
    return { ok: false, reason: "the rewrite is not a pure rename: undoing it does not reproduce the original source" };
  }

  return { ok: true };
}
