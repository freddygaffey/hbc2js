// fn-naming checker — docs/specs/passes/05-fn-naming.md §6.
//
// `check(before, after, ctx)` gets no access to `match`'s captured data, so
// the `(from, to)` pairs are recovered by diffing `before`/`after` directly:
// `rewrite` only ever changes `func` statements' `name` fields (plus every
// matching `ident`, which does not change a statement's `k`), so every
// position where a `k:"func"` statement's `name` differs between `before`
// and `after` is one rename the rung made — the whole batch (§4) is
// recovered that way, and every obligation below is asserted for every pair
// at once, with each whole-body walk done exactly once (P-1: this used to be
// several walks *per rename*, on the whole function body, per driver
// iteration).
import type { Stmt } from "../ast.ts";
import { declaredNames, EMITTER_NAME_CLASS_RE, FN_RE, IDENT_RE } from "./match.ts";
import { freeNames, identUsesMany, isSafeIdentifier, printProgram } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { renameIdents } from "./rewrite.ts";

/** Every `(from, to)` pair `rewrite` could have produced, recovered from a
 *  structural diff of `before`/`after` alone, in statement order. `null` when
 *  none is found or the shapes disagree (the "unexpected shape" refusals
 *  below fire from here). */
function findRenames(before: readonly Stmt[], after: readonly Stmt[]): readonly { readonly from: string; readonly to: string }[] | null {
  if (before.length !== after.length) return null;
  const out: { from: string; to: string }[] = [];
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!;
    const a = after[i]!;
    if (b.k !== a.k) return null;
    if (b.k === "func" && a.k === "func" && b.name !== a.name) out.push({ from: b.name, to: a.name });
  }
  return out.length === 0 ? null : out;
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const renames = findRenames(before, after);
  if (renames === null) {
    return { ok: false, reason: "unexpected shape: fn-naming only ever renames func statements in place, never adds/removes/reorders a statement" };
  }
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const { from, to } of renames) {
    if (!FN_RE.test(from)) return { ok: false, reason: "unexpected shape: a renamed statement's original name was not an _fnN binding" };
    if (froms.has(from) || tos.has(to)) return { ok: false, reason: "unexpected shape: two renames share a name" };
    froms.add(from);
    tos.add(to);
  }

  const fnBody = ctx.fnBody ?? before;

  // Item 2: no `to` is a declared name in `before`, in any enclosing scope
  // the rung can see, or in any nested `func` — re-run §4 conditions 2-5
  // rather than trusting the match. The two body-wide sets are computed
  // once for every `to`.
  for (const to of tos) {
    if (!IDENT_RE.test(to)) return { ok: false, reason: "unsafe-identifier" };
    if (!isSafeIdentifier(to)) return { ok: false, reason: "reserved-word" };
    if (EMITTER_NAME_CLASS_RE.test(to)) return { ok: false, reason: "emitter-name-class" };
  }
  // In the driver the site *is* the whole body (`list === ctx.fnBody`), so
  // `freeNames(fnBody)` and item 1's `freeNames(before)` are one walk.
  const freeBefore = freeNames(before);
  const freeBody = fnBody === before ? freeBefore : freeNames(fnBody);
  const declaredBody = declaredNames(fnBody);
  for (const to of tos) {
    if (freeBody.has(to)) return { ok: false, reason: "captures-free-name" };
    if (declaredBody.has(to)) return { ok: false, reason: "already-declared" };
  }

  // Item 1: `freeNames(after)` equals `freeNames(before)` with each `from`
  // replaced by its `to`, and no `to` was already in `freeNames(before)`.
  for (const to of tos) {
    if (freeBefore.has(to)) return { ok: false, reason: "the target name is already free in the function before the rename" };
  }
  const expectedFree = new Set(freeBefore);
  for (const { from, to } of renames) {
    if (expectedFree.has(from)) {
      expectedFree.delete(from);
      expectedFree.add(to);
    }
  }
  const freeAfter = freeNames(after);
  if (freeAfter.size !== expectedFree.size || [...expectedFree].some((n) => !freeAfter.has(n))) {
    return { ok: false, reason: "the rewrite changed the function's free-name set beyond replacing from with to" };
  }

  // Item 4: the counts match, and no `from` survives — one walk of `before`
  // for every `from`, one walk of `after` for every `from` and `to`.
  const beforeCounts = identUsesMany(before, froms);
  const afterCounts = identUsesMany(after, [...froms, ...tos]);
  for (const { from, to } of renames) {
    const b = beforeCounts.get(from)!;
    const a = afterCounts.get(to)!;
    if (b.reads + b.writes !== a.reads + a.writes) {
      return { ok: false, reason: "the rewrite changed the number of references to the renamed function" };
    }
    // "identUses(after, from) is zero" (§6 item 4) means the whole triple —
    // `reads`/`writes` *and* `nested` — is zero: a rewrite that renamed the
    // `func` statement itself but missed a recursive self-reference deep
    // inside its own (nested) body would otherwise slip past both this check
    // and obligation 3 (undoing the rename on an untouched `from` occurrence
    // reproduces `before` exactly, since it was never touched in the first
    // place) — only counting `nested` here catches it.
    const survivingFrom = afterCounts.get(from)!;
    if (survivingFrom.reads + survivingFrom.writes + survivingFrom.nested > 0) {
      return { ok: false, reason: "the old _fnN name still appears after the rewrite" };
    }
  }

  // Item 3: printing `before`, and printing `after` with every rename
  // undone, is byte-identical.
  const undo = new Map(renames.map((r) => [r.to, r.from]));
  if (printProgram(before) !== printProgram(renameIdents(after, undo))) {
    return { ok: false, reason: "the rewrite is not a pure rename: undoing it does not reproduce the original source" };
  }

  return { ok: true };
}
