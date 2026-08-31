// var-naming checker — docs/specs/passes/07-var-naming.md §7.
//
// `check(before, after, ctx)` gets no access to `match`'s captured data, so
// the `(from, to)` pairs are recovered by diffing `before`/`after` directly:
// `rewrite` only ever changes the leading `decl.names` entries (plus every
// matching `ident`/assign-target/`init`-name, none of which changes a
// statement's `k` or the list's length), so every position where the `decl`
// statement's `names` differ between `before` and `after` is one rename the
// rung made — the whole batch (spec 05 §4's convention) is recovered that
// way, and every obligation below is asserted for every pair at once, with
// each whole-body walk done exactly once.
import type { Stmt } from "../ast.ts";
import { freeNames, identUsesMany, isRegisterName, isSafeIdentifier, printProgram } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { frameOccurrences } from "./frame.ts";
import { declaredNames, EMITTER_NAME_CLASS_RE, IDENT_RE } from "./match.ts";
import { renameRegistersInFrame } from "./rewrite.ts";

/** Every `(from, to)` pair `rewrite` could have produced, recovered from a
 *  structural diff of `before`/`after`'s leading `decl` statement alone.
 *  `null` when none is found or the shapes disagree. */
function findRenames(before: readonly Stmt[], after: readonly Stmt[]): readonly { readonly from: string; readonly to: string }[] | null {
  if (before.length !== after.length) return null;
  for (let i = 0; i < before.length; i++) if (before[i]!.k !== after[i]!.k) return null;
  const beforeDecl = before.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  const afterDecl = after.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  if (beforeDecl === undefined || afterDecl === undefined) return null;
  if (beforeDecl.names.length !== afterDecl.names.length) return null;
  const out: { from: string; to: string }[] = [];
  for (let i = 0; i < beforeDecl.names.length; i++) {
    const b = beforeDecl.names[i]!;
    const a = afterDecl.names[i]!;
    if (b !== a) out.push({ from: b, to: a });
  }
  return out.length === 0 ? null : out;
}

export function check(before: readonly Stmt[], after: readonly Stmt[], ctx: PassContext): CheckResult {
  const renames = findRenames(before, after);
  if (renames === null) {
    return { ok: false, reason: "unexpected shape: var-naming only ever renames registers' occurrences in place, never adds/removes/reorders a statement" };
  }
  const froms = new Set<string>();
  const tos = new Set<string>();
  for (const { from, to } of renames) {
    if (!isRegisterName(from)) return { ok: false, reason: "unexpected shape: a renamed decl entry was not a register name" };
    if (froms.has(from) || tos.has(to)) return { ok: false, reason: "unexpected shape: two renames share a name" };
    froms.add(from);
    tos.add(to);
  }

  const fnBody = ctx.fnBody ?? before;

  // Item 2: no `to` is declared/free anywhere the rung can see (re-run the
  // §4.3 taken-set test rather than trusting the match), and every `to` is
  // a safe, non-emitter-shaped identifier. The two body-wide sets are
  // computed once for every `to`.
  for (const to of tos) {
    if (!IDENT_RE.test(to) || !isSafeIdentifier(to)) return { ok: false, reason: "reserved-word" };
    if (EMITTER_NAME_CLASS_RE.test(to)) return { ok: false, reason: "emitter-name-class" };
  }
  const freeBefore = freeNames(before);
  const freeBody = fnBody === before ? freeBefore : freeNames(fnBody);
  const declaredBody = declaredNames(fnBody);
  for (const to of tos) {
    if (freeBody.has(to)) return { ok: false, reason: "captures-free-name" };
    if (declaredBody.has(to)) return { ok: false, reason: "already-declared" };
  }

  // Item 1: `freeNames(after)` equals `freeNames(before)` with each `from`
  // replaced by its `to` (registers are never free names themselves, so in
  // practice this confirms the rewrite introduced no new free name).
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

  // Item 4: reference counts match, and no `from` survives anywhere —
  // including inside a nested `func` (a surviving `nested > 0` here would
  // mean the rename wrongly reached into, or a stray occurrence remains
  // outside, this frame; see rewrite.ts's frame boundary). One walk of
  // `before` for every `from`, one walk of `after` for every `from`/`to`.
  const beforeCounts = identUsesMany(before, froms);
  const afterCounts = identUsesMany(after, [...froms, ...tos]);
  for (const { from, to } of renames) {
    const b = beforeCounts.get(from)!;
    const a = afterCounts.get(to)!;
    if (b.reads + b.writes !== a.reads + a.writes) {
      return { ok: false, reason: "the rewrite changed the number of references to the renamed register" };
    }
    const survivingFrom = afterCounts.get(from)!;
    if (survivingFrom.reads + survivingFrom.writes + survivingFrom.nested > 0) {
      return { ok: false, reason: "the old register name still appears after the rewrite" };
    }
    // A `to` reached only through a nested closure would be a capture the
    // frame-local rewrite cannot have produced honestly (the nested body's
    // own occurrence of `to` pre-dated the rename and is a different
    // binding): item 2 already refused it via `declaredNames`/`freeNames`,
    // so `nested` can only be zero here — assert it anyway.
    if (a.nested > 0) return { ok: false, reason: "the target name is referenced from a nested function" };
  }

  // Item 5 (frame-locality, register-specific): the exact def/read
  // positions, by pre-order statement index, carry over one-for-one from
  // each `from` to its `to` — the rename touched exactly this frame's
  // occurrences of the register and no others. One walk each side.
  const occBefore = frameOccurrences(before, froms);
  const occAfter = frameOccurrences(after, tos);
  for (const { from, to } of renames) {
    const b = occBefore.get(from)!;
    const a = occAfter.get(to)!;
    if (b.defs.length !== a.defs.length || b.defs.some((v, i) => v !== a.defs[i])) {
      return { ok: false, reason: "the rewrite changed which statements define the renamed register" };
    }
    if (b.reads.length !== a.reads.length || b.reads.some((v, i) => v !== a.reads[i])) {
      return { ok: false, reason: "the rewrite changed which statements read the renamed register" };
    }
  }

  // Item 3: printing `before`, and printing `after` with every rename
  // undone, is byte-identical.
  const undo = new Map(renames.map((r) => [r.to, r.from]));
  if (printProgram(before) !== printProgram(renameRegistersInFrame(after, undo))) {
    return { ok: false, reason: "the rewrite is not a pure rename: undoing it does not reproduce the original source" };
  }

  return { ok: true };
}
