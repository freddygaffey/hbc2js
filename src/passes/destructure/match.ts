// destructure matcher — docs/LOWERING-CATALOGUE.md row 22,
// docs/specs/passes/16-destructure.md §4. Site = one statement list `L`.
// Recognises the array-iterator-protocol idiom (§2.1-2.4) and the
// object-property idiom (§2.5), each as a run of *consecutive sibling*
// statements. Both scans are pure and tolerant of the register-copy
// cosmetics §2.6 documents between v94 and v99, but strict on load-bearing
// shape: any statement that does not fit the grammar stops the scan, and
// (per §4 precondition 1) an array run that started threading iterator
// state must complete or be refused whole — a partial array rewrite would
// leave the leftover elements referring to registers the rewrite deleted.
//
// v1 scope (see docs/BUGS.md, docs/PUSHBACK.md): this rung recognises
// *flat* labeled blocks, PLUS one nested shape — a per-element **default**
// (§2.2): a 2-level `Lo`/`Ld` pair fused with the prologue for element 0, or
// a 3-level `Lo`/`Ld`/`Ls` chain for later elements (`parseDefaultedPrologueBlock`
// / `parseDefaultedElementBlock` below). Only the *direct-commit* variant is
// recognised (the defaulted element's own value register is the check/commit
// register with no separate staging register) — the staged-commit-plus-default
// combination §2.2 mentions (e.g. `37`'s `b = 99`) is still refused
// (`broken-threading`, since the staged head shape does not parse as a plain
// reset). Holes-by-shape (§2.3, BUGS.md 2026-09-02) are recognised at
// v84/v94/v96 via `resolvePending`'s three-way dataflow split (a commit
// header found -> real target; no header but the stage register is read
// again before redefinition -> direct-commit target; no header and the
// stage is provably dead (`isDeadFrom`) -> hole) — v98/v99 lower the same
// hole through an unhandled shape and stay refused. Array rest (§2.4)
// remains out of scope at *every* version — measured to be structurally
// unreachable (the append loop's own `try`/`catch` is inherent to the
// lowering, not a top-level-only artifact), see §8 Q1 and
// `docs/lowering/destructuring.md`. Object patterns support plain reads,
// defaulted properties (including nested-pattern defaults one level via
// `target` recursion is NOT implemented — a nested object/array target is
// refused, `non-register-target`) and the 3-argument rest form.
import type { Expr, Pattern, PatternElement, Stmt } from "../ast.ts";
import { defUse, identUses, isRegisterName } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export type RefuseReason = "broken-threading" | "not-undefined-guard" | "non-register-target" | "default-reads-body-state" | "label-escape" | "pc-tracked-region" | "state-escapes" | "close-shape" | "source-clobbered" | "rest-exclusion-shape" | "plain-reads-only";

// ---------------------------------------------------------------------------
// Shared statement-shape recognisers.
// ---------------------------------------------------------------------------

function isIdent(e: Expr): e is Extract<Expr, { k: "ident" }> {
  return e.k === "ident";
}
function isUndefLit(e: Expr): boolean {
  return e.k === "lit" && e.text === "undefined";
}
/** `target = value` where `target` is a bare identifier. */
function asIdentAssign(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "ident") return null;
  return { name: s.expr.target.name, value: s.expr.value };
}
/** `ident = undefined` — a reset. */
function isResetStmt(s: Stmt): boolean {
  const a = asIdentAssign(s);
  return a !== null && isUndefLit(a.value);
}
/** `ident = otherIdent` — a register copy. */
function asCopy(s: Stmt): { readonly to: string; readonly from: string } | null {
  const a = asIdentAssign(s);
  if (a === null || !isIdent(a.value)) return null;
  return { to: a.name, from: a.value.name };
}
/** `ident = call(...)`, `call.callee` an `ident`. */
function asCallAssign(s: Stmt): { readonly to: string; readonly callee: string; readonly args: readonly Expr[] } | null {
  const a = asIdentAssign(s);
  if (a === null || a.value.k !== "call" || a.value.callee.k !== "ident") return null;
  return { to: a.name, callee: a.value.callee.name, args: a.value.args };
}
/** `ident = tmp[N]` (a destructured tuple-return read). */
function asTupleRead(s: Stmt, tmp: string, index: 0 | 1): string | null {
  const a = asIdentAssign(s);
  if (a === null || a.value.k !== "member" || !a.value.computed || a.value.obj.k !== "ident" || a.value.obj.name !== tmp) return null;
  if (a.value.prop.k !== "lit" || a.value.prop.text !== String(index)) return null;
  return a.name;
}
/** `if (test) { break label } ` with an empty else and single-statement then. */
function asTailBreakGuard(s: Stmt, label: string): Expr | null {
  if (s.k !== "if" || s.else.length !== 0 || s.then.length !== 1) return null;
  const br = s.then[0]!;
  if (br.k !== "break" || br.label !== label) return null;
  return s.test;
}

// ---------------------------------------------------------------------------
// A — array pattern.
// ---------------------------------------------------------------------------

interface ArrayElement {
  /** Present iff this is a hole (§2.3, BUGS.md 2026-09-02) — an elided
   *  position (`[a, , c]`'s middle slot): the iterator was still advanced
   *  (an observable step happened) but nothing was ever bound to it, and
   *  `target`/`init` are absent. */
  readonly hole?: true;
  readonly target?: string; // absent iff `hole`
  readonly init?: Expr; // §2.2: a per-element default, direct-commit only
}

export interface ArrayPatternSite {
  readonly kind: "array";
  readonly startIndex: number;
  /** Index one past the last consumed statement (the close block, if any). */
  readonly endIndex: number;
  readonly source: Expr;
  readonly elements: readonly ArrayElement[];
  readonly rIter: string;
  readonly rNextFn: string;
}

/** Consumes the shared "iterNext -> value, new-iterator -> done" tail that
 *  both the prologue block and every later element block end with, starting
 *  at `body[i]`. Returns the raw value register, the final done register
 *  (after any copy-chain re-threading), and the next index — or `null` if
 *  the shape does not match. `rIter`/`rNextFn` are the tracked state
 *  registers; `u` is the tracked undefined-sentinel expression (a register
 *  name or `undefined` literal) once known, or `null` before the first
 *  `=== u` comparison establishes it. */
interface TailResult {
  readonly value: string;
  /** Every register name so far observed to hold the same done-flag value
   *  as the comparison that established it (§2.6: v99 often re-threads the
   *  flag through one or more plain copies before *and* after the guard
   *  that actually tests it) — a *set*, not one name, because a later
   *  consumer (this block's own second guard, or the next block's early
   *  guard) may legally test any name in it, not only the latest. */
  readonly doneSet: ReadonlySet<string>;
  readonly rIterNew: string;
  readonly u: Expr;
  readonly next: number;
}
function skipResets(body: readonly Stmt[], i: number): number {
  let j = i;
  while (j < body.length && isResetStmt(body[j]!)) j++;
  return j;
}
/** Consumes a run of `to = from` register copies starting at `i`, growing
 *  `set` with `to` whenever `from` is already a member — so the set becomes
 *  the full equivalence class of names holding the same value, in whatever
 *  order they were introduced. Copies whose `from` is not (yet) a member are
 *  left unconsumed (`j` stops there): they belong to a *different* value
 *  (e.g. the un-related prologue constant `default-params`' own scan calls
 *  out), not this one. */
function growEquivSet(body: readonly Stmt[], i: number, set: Set<string>): number {
  let j = i;
  for (;;) {
    const c = asCopy(body[j]!);
    if (c === null || !set.has(c.from)) break;
    set.add(c.to);
    j++;
  }
  return j;
}
/** Shallow structural equality for the two shapes `u` ever takes (a
 *  register name, or the literal `undefined`) — used to require a defaulted
 *  element's own `!== U` guard to test the *same* sentinel the iterator
 *  loop's done-check established, not a coincidentally-named lookalike. */
function exprEq(a: Expr, b: Expr): boolean {
  if (a.k !== b.k) return false;
  if (a.k === "ident" && b.k === "ident") return a.name === b.name;
  if (a.k === "lit" && b.k === "lit") return a.text === b.text;
  return false;
}

/** Removes every `to = from` copy in `stmts` whose `from` is already a
 *  member of `set` (adding `to` to `set`, whether or not it was already a
 *  member — a copy that re-affirms an existing equivalence, like `37`'s
 *  `r4 = r3; r3 = r4;` double-copy, is exactly as much plumbing as one that
 *  grows the set), wherever in `stmts` it occurs and in any order — the
 *  register-copy cosmetics §2.6 documents are not always adjacent to the
 *  comparison that produced them once a default's own tail is involved
 *  (`sumPair`'s v96 build emits the default assignment *before* its trailing
 *  flag copy; v94/v84/v96(other block) emit it after). Iterates to a fixed
 *  point since a copy's `from` may itself only become known via an earlier
 *  copy removed in a prior pass. Returns the remaining statements in their
 *  original relative order; mutates `set` in place. */
function stripFlagCopies(stmts: readonly Stmt[], set: Set<string>): readonly Stmt[] {
  let remaining = stmts.slice();
  for (;;) {
    const idx = remaining.findIndex((s) => {
      const c = asCopy(s);
      return c !== null && set.has(c.from);
    });
    if (idx === -1) break;
    const c = asCopy(remaining[idx]!)!;
    set.add(c.to);
    remaining = [...remaining.slice(0, idx), ...remaining.slice(idx + 1)];
  }
  return remaining;
}

function resolveViaSet(name: string, set: ReadonlySet<string>, body: readonly Stmt[], from: number, to: number): boolean {
  if (set.has(name)) return true;
  // `name` might be defined by a copy *inside* [from,to) that the caller
  // hasn't consumed yet (order independence isn't needed here — the shapes
  // observed always compare the freshly-read value directly).
  void body;
  void from;
  void to;
  return false;
}

function parseTail(body: readonly Stmt[], i0: number, rIter: string, rNextFn: string): TailResult | null {
  let i = skipResets(body, i0);
  const step = asCallAssign(body[i]!);
  if (step === null || step.callee !== "__hbc_iterNext") return null;
  if (step.args.length !== 2 || !isIdent(step.args[0]!) || !isIdent(step.args[1]!)) return null;
  if (step.args[0]!.name !== rIter || step.args[1]!.name !== rNextFn) return null; // broken-threading
  const tmp = step.to;
  i++;
  const value = asTupleRead(body[i]!, tmp, 0);
  if (value === null) return null;
  i++;
  const rIterNew = asTupleRead(body[i]!, tmp, 1);
  if (rIterNew === null) return null;
  i++;
  i = skipResets(body, i);
  const iterEquiv = new Set<string>([rIterNew]);
  i = growEquivSet(body, i, iterEquiv);
  // The comparison: `doneRaw = <lhs> === <u>` where `<lhs>` is (an
  // equivalent copy of) the freshly-read `rIterNew`.
  const cmpAssign = asIdentAssign(body[i]!);
  if (cmpAssign === null || cmpAssign.value.k !== "bin" || cmpAssign.value.op !== "===") return null;
  const lhs = cmpAssign.value.left;
  if (!isIdent(lhs) || !resolveViaSet(lhs.name, iterEquiv, body, i0, i)) return null;
  const u = cmpAssign.value.right;
  i++;
  const doneSet = new Set<string>([cmpAssign.name]);
  i = skipResets(body, i);
  i = growEquivSet(body, i, doneSet);
  return { value, doneSet, rIterNew, u, next: i };
}

/** Parses one non-prologue element block's body from its start: an optional
 *  staged-commit head, the early-done guard, the shared tail, the second
 *  guard, and the commit/stage statement. `prevDone` is the tracked
 *  done-flag register from the previous block; `prevStage` is the previous
 *  block's raw tail-target register, consumed here if this block opens with
 *  `real = prevStage; prevStage = undefined;`. Returns the resolved real
 *  target for the *previous* element (only meaningful when `prevStage` was
 *  actually staged), this block's own raw tail target, the new done
 *  register, and the sentinel `u`. */
interface ElementResult {
  readonly resolvedPrevTarget: string | null;
  readonly rawTarget: string;
  readonly doneSet: ReadonlySet<string>;
  readonly rIterNew: string;
  readonly u: Expr;
  readonly init?: Expr;
}
function parseElementBlock(body: readonly Stmt[], label: string, rIter: string, rNextFn: string, prevDone: ReadonlySet<string>, prevStage: string): ElementResult | null {
  let i = 0;
  let resolvedPrevTarget: string | null = null;
  const head = asIdentAssign(body[0]!);
  if (head !== null && isIdent(head.value) && head.value.name === prevStage && isResetStmt(body[1] ?? { k: "comment", text: "" })) {
    resolvedPrevTarget = head.name;
    i = 2;
  }
  i = skipResets(body, i);
  // A leading flag-copy before the early guard (`r7 = r2; if (r7) break …`,
  // measured on `65-destructure-hole-rest`'s `skipMiddle` at v84/94/96 — the
  // presence of a hole shifts register allocation enough to introduce this
  // copy where the previously-measured fixtures never needed one) is the
  // same §2.6 cosmetic `growEquivSet` already tolerates after a comparison;
  // tolerate it here too, against a local copy so `prevDone` itself is
  // never mutated.
  const prevDoneLocal = new Set(prevDone);
  i = growEquivSet(body, i, prevDoneLocal);
  const guard = asTailBreakGuard(body[i]!, label);
  if (guard === null || !isIdent(guard) || !prevDoneLocal.has(guard.name)) return null; // broken-threading
  i++;
  const tail = parseTail(body, i, rIter, rNextFn);
  if (tail === null) return null;
  i = tail.next;
  const doneSet = new Set(tail.doneSet);
  i = skipResets(body, i);
  const guard2 = asTailBreakGuard(body[i]!, label);
  if (guard2 === null || !isIdent(guard2) || !doneSet.has(guard2.name)) return null;
  i++;
  const commit = asIdentAssign(body[i]!);
  if (commit === null || !isIdent(commit.value) || commit.value.name !== tail.value) return null;
  const rawTarget = commit.name;
  i++;
  // Trailing flag re-threads (grow the equivalence set further so the
  // *next* block's early guard can test whichever name it used), then the
  // tail break.
  i = growEquivSet(body, i, doneSet);
  const brk = body[i];
  if (brk === undefined || brk.k !== "break" || brk.label !== label) return null;
  if (i + 1 !== body.length) return null; // nothing may follow the tail break
  return { resolvedPrevTarget, rawTarget, doneSet, rIterNew: tail.rIterNew, u: tail.u };
}

/** Parses the prologue block (element 0, fused with `__hbc_iterBegin`). */
function parsePrologueBlock(body: readonly Stmt[], label: string): (Omit<ElementResult, "resolvedPrevTarget"> & { readonly source: Expr; readonly rIter: string; readonly rNextFn: string }) | null {
  let i = skipResets(body, 0);
  const begin = asCallAssign(body[i]!);
  if (begin === null || begin.callee !== "__hbc_iterBegin" || begin.args.length !== 1) return null;
  const source = begin.args[0]!;
  const tmp = begin.to;
  i++;
  const rIter0 = asTupleRead(body[i]!, tmp, 0);
  if (rIter0 === null) return null;
  i++;
  const rNextFn = asTupleRead(body[i]!, tmp, 1);
  if (rNextFn === null) return null;
  i++;
  const tail = parseTail(body, i, rIter0, rNextFn);
  if (tail === null) return null;
  i = tail.next;
  const doneSet = new Set(tail.doneSet);
  i = skipResets(body, i);
  const guard = asTailBreakGuard(body[i]!, label);
  if (guard === null || !isIdent(guard) || !doneSet.has(guard.name)) return null;
  i++;
  const commit = asIdentAssign(body[i]!);
  if (commit === null || !isIdent(commit.value) || commit.value.name !== tail.value) return null;
  const rawTarget = commit.name;
  i++;
  i = growEquivSet(body, i, doneSet);
  const brk = body[i];
  if (brk === undefined || brk.k !== "break" || brk.label !== label) return null;
  if (i + 1 !== body.length) return null;
  return { source, rIter: rIter0, rNextFn, rawTarget, doneSet, rIterNew: tail.rIterNew, u: tail.u };
}

/** §2.2, element 0 (fused with the prologue): a defaulted array element
 *  nests one label deeper than `parsePrologueBlock`'s plain shape. Two
 *  levels only — `Lo` (outer, the "keep" target) wraps a single `Ld` block
 *  that does `__hbc_iterBegin` + the first `iterNext` step, checks done
 *  (falling through to `Lo`'s own default tail on done, `break Ld`/self)
 *  then checks the stepped value against the sentinel (`break Lo`/outer when
 *  present — "keep"). There is no separate `Ls`: element 0 has no earlier
 *  element to early-skip for, so the roles `parseDefaultedElementBlock`
 *  splits across `Ld`/`Ls` collapse into one block here. */
function parseDefaultedPrologueBlock(body: readonly Stmt[], outerLabel: string): (Omit<ElementResult, "resolvedPrevTarget"> & { readonly source: Expr; readonly rIter: string; readonly rNextFn: string; readonly init: Expr }) | null {
  if (body.length < 2) return null;
  const ldStmt = body[0];
  if (ldStmt === undefined || ldStmt.k !== "labeled") return null;
  const ldBody = ldStmt.body;
  // A leading alias copy (`r4 = r0;`, `sumPair`'s own source register handed
  // to `__hbc_iterBegin` via a copy rather than directly) is deleted along
  // with the rest of the matched run, so the copy's *target* register
  // (`r4`) must not survive into the written pattern's `source` — chase the
  // chain back to the earliest register the copies alias, exactly the
  // register the pattern is actually being assigned from.
  const aliasOf = new Map<string, string>();
  let i = 0;
  for (;;) {
    const c = asCopy(ldBody[i] ?? { k: "comment", text: "" });
    if (c === null) break;
    aliasOf.set(c.to, aliasOf.get(c.from) ?? c.from);
    i++;
  }
  i = skipResets(ldBody, i);
  const begin = asCallAssign(ldBody[i]!);
  if (begin === null || begin.callee !== "__hbc_iterBegin" || begin.args.length !== 1) return null;
  const rawSource = begin.args[0]!;
  const source: Expr = isIdent(rawSource) && aliasOf.has(rawSource.name) ? { k: "ident", name: aliasOf.get(rawSource.name)! } : rawSource;
  const tmp = begin.to;
  i++;
  const rIter0 = asTupleRead(ldBody[i]!, tmp, 0);
  if (rIter0 === null) return null;
  i++;
  const rNextFn = asTupleRead(ldBody[i]!, tmp, 1);
  if (rNextFn === null) return null;
  i++;
  const tail = parseTail(ldBody, i, rIter0, rNextFn);
  if (tail === null) return null;
  i = tail.next;
  const doneSet = new Set(tail.doneSet);
  const guard1 = asTailBreakGuard(ldBody[i]!, ldStmt.label);
  if (guard1 === null || !isIdent(guard1) || !doneSet.has(guard1.name)) return null; // broken-threading
  i++;
  const guard2Stmt = ldBody[i];
  const guard2 = guard2Stmt === undefined ? null : asTailBreakGuard(guard2Stmt, outerLabel);
  if (guard2 === null || guard2.k !== "bin" || guard2.op !== "!==" || !isIdent(guard2.left) || guard2.left.name !== tail.value || !exprEq(guard2.right, tail.u)) return null; // not-undefined-guard
  i++;
  const finalLd = ldBody[i];
  if (finalLd === undefined || finalLd.k !== "break" || finalLd.label !== ldStmt.label) return null;
  if (i + 1 !== ldBody.length) return null;
  // `Lo`'s own tail: flag-copy plumbing plus the default assignment, ending
  // in `break Lo`.
  const loTail = body.slice(1);
  const stripped = stripFlagCopies(loTail, doneSet);
  const finalLo = stripped[stripped.length - 1];
  if (finalLo === undefined || finalLo.k !== "break" || finalLo.label !== outerLabel) return null;
  const init = collapseDefault(stripped.slice(0, -1), tail.value);
  if (init === null) return null;
  return { source, rIter: rIter0, rNextFn, rawTarget: tail.value, doneSet, rIterNew: tail.rIterNew, u: tail.u, init };
}

/** §2.2, a later (non-first) defaulted element: three nested labels. `Ls`
 *  (innermost) early-skips the step entirely when the *previous* element was
 *  already done (`break Ls`/self, landing on `Ld`'s own value-check with the
 *  element's target still reset to `undefined`) or performs the step and,
 *  if now done, jumps straight past the value-check to the default
 *  (`break Ld`); otherwise falls through (`break Ls`/self, unconditional).
 *  `Ld`'s own tail is the "!== U" value-check (`break Lo`/outer to keep the
 *  stepped value) with an unconditional `break Ld`/self fallthrough to the
 *  default on `Lo`'s own tail. Direct-commit only — see the file banner. */
function parseDefaultedElementBlock(body: readonly Stmt[], outerLabel: string, rIter: string, rNextFn: string, prevDone: ReadonlySet<string>): (Omit<ElementResult, "resolvedPrevTarget"> & { readonly init: Expr }) | null {
  if (body.length < 2) return null;
  const ldStmt = body[0];
  if (ldStmt === undefined || ldStmt.k !== "labeled") return null;
  const ldBody = ldStmt.body;
  if (ldBody.length < 1) return null;
  const lsStmt = ldBody[0];
  if (lsStmt === undefined || lsStmt.k !== "labeled") return null;
  const lsBody = lsStmt.body;
  let i = skipResets(lsBody, 0);
  const guard1 = asTailBreakGuard(lsBody[i]!, lsStmt.label);
  if (guard1 === null || !isIdent(guard1) || !prevDone.has(guard1.name)) return null; // broken-threading
  i++;
  const tail = parseTail(lsBody, i, rIter, rNextFn);
  if (tail === null) return null;
  i = tail.next;
  const doneSet = new Set(tail.doneSet);
  const guard2 = asTailBreakGuard(lsBody[i]!, ldStmt.label);
  if (guard2 === null || !isIdent(guard2) || !doneSet.has(guard2.name)) return null;
  i++;
  const finalLs = lsBody[i];
  if (finalLs === undefined || finalLs.k !== "break" || finalLs.label !== lsStmt.label) return null;
  if (i + 1 !== lsBody.length) return null;

  const ldTail = ldBody.slice(1);
  const strippedLd = stripFlagCopies(ldTail, doneSet);
  if (strippedLd.length !== 2) return null;
  const valueGuard = asTailBreakGuard(strippedLd[0]!, outerLabel);
  if (valueGuard === null || valueGuard.k !== "bin" || valueGuard.op !== "!==" || !isIdent(valueGuard.left) || valueGuard.left.name !== tail.value || !exprEq(valueGuard.right, tail.u)) return null; // not-undefined-guard
  const finalLd = strippedLd[1]!;
  if (finalLd.k !== "break" || finalLd.label !== ldStmt.label) return null;

  const loTail = body.slice(1);
  const strippedLo = stripFlagCopies(loTail, doneSet);
  const finalLo = strippedLo[strippedLo.length - 1];
  if (finalLo === undefined || finalLo.k !== "break" || finalLo.label !== outerLabel) return null;
  const init = collapseDefault(strippedLo.slice(0, -1), tail.value);
  if (init === null) return null;

  return { rawTarget: tail.value, doneSet, rIterNew: tail.rIterNew, u: tail.u, init };
}

/** `Lc: { [target = prevStage;] if (doneFinal) { break Lc } __hbc_iterClose(rIter,
 *  false); break Lc }`. The optional leading commit (measured on
 *  `65-destructure-hole-rest`'s `skipMiddle`/`skipFirst`, BUGS.md
 *  2026-09-02): when the pattern's last position uses the staged-commit
 *  style §2.1(b) describes for an *inner* element, the close block is
 *  "block N" and carries that position's commit at its own head, exactly
 *  like any other element block would — this was previously unhandled
 *  (`firstTwo`'s last element always committed directly, so no fixture
 *  needed it until this rung's hole/rest measurement). Returns the resolved
 *  name if a commit header was found, `null` otherwise (meaning `prevStage`
 *  itself is either already the real target, or a hole — the caller
 *  disambiguates via `resolvePending`). */
function parseCloseBlock(body: readonly Stmt[], label: string, doneFinal: ReadonlySet<string>, prevStage: string): { readonly resolvedPrevTarget: string | null } | null {
  let i = 0;
  let resolvedPrevTarget: string | null = null;
  const head = asIdentAssign(body[0] ?? { k: "comment", text: "" });
  if (head !== null && isIdent(head.value) && head.value.name === prevStage) {
    resolvedPrevTarget = head.name;
    i = 1;
  }
  i = skipResets(body, i);
  const doneLocal = new Set(doneFinal);
  i = growEquivSet(body, i, doneLocal);
  const guard = asTailBreakGuard(body[i] ?? { k: "comment", text: "" }, label);
  if (guard === null || !isIdent(guard) || !doneLocal.has(guard.name)) return null;
  i++;
  const st = body[i];
  if (st === undefined) return null;
  const close = asCallAssign(st /* also matches a bare `expr` call stmt below */);
  // `__hbc_iterClose` is called for effect only; it may be a bare call
  // statement, not an assignment — handle both.
  const isCloseCall = (close !== null && close.callee === "__hbc_iterClose") || (st.k === "expr" && st.expr.k === "call" && st.expr.callee.k === "ident" && st.expr.callee.name === "__hbc_iterClose");
  if (!isCloseCall) return null;
  i++;
  const brk = body[i];
  if (brk === undefined || brk.k !== "break" || brk.label !== label) return null;
  if (i + 1 !== body.length) return null;
  return { resolvedPrevTarget };
}

/** True if `reg` is not read anywhere in `list` from index `fromIdx` onward
 *  before it is next redefined (or is never redefined again at all) — i.e.
 *  the value most recently written to `reg` (just before `fromIdx`) is
 *  provably dead. Same defUse-based reasoning as the §4 precondition 7
 *  state-escapes check below, scoped to one register instead of the whole
 *  state-registers set: the load-bearing distinction (BUGS.md 2026-09-02)
 *  between a hole (§2.3, dead) and a direct-commit element whose own raw
 *  register *is* the real, later-read target (`firstTwo`'s `p`/`q`). */
function isDeadFrom(list: readonly Stmt[], fromIdx: number, reg: string): boolean {
  const du = defUse(list.slice(fromIdx));
  const info = du.get(reg);
  if (info === undefined) return true;
  const firstDef = info.defs.length === 0 ? Infinity : Math.min(...info.defs);
  // `<=`, not `<`: `defUse` assigns one position per *statement*, so a
  // self-referential update (`sumPair`'s own tail, `r0 = r1 + r0;`, reusing
  // `b`'s own register as the sum's target) records the RHS read and the
  // target def at the *same* position — a real, load-bearing use (the
  // read happens first, per JS evaluation order) that a strict `<` would
  // wrongly call dead.
  return !info.reads.some((r) => r <= firstDef);
}

/** Resolves the *previous* iteration's staged raw value (`prevStage`, from
 *  block `k`) now that we know whether the *current* position's own block —
 *  or, once the element scan is over, the close block — committed it via a
 *  leading `real = prevStage;` header (`resolvedHead`, from `parseElementBlock`
 *  / `parseCloseBlock`). Three-way, per BUGS.md 2026-09-02's measurement:
 *  a header match means a real target bound later (staged-commit, §2.1(b));
 *  no header match but `prevStage` is read again before being redefined
 *  means the direct-commit style (§2.1(a)) — the raw register itself *is*
 *  the real target (`firstTwo`'s `p`/`q`); no header match and `prevStage`
 *  is provably dead (`isDeadFrom`) means the position was elided (§2.3, a
 *  hole) — a defaulted element can never be a hole (there is nothing to
 *  default a discarded position to), so that combination is an
 *  unrecognised shape and refuses the whole unit. */
function resolvePending(list: readonly Stmt[], fromIdx: number, prevStage: string, resolvedHead: string | null, prevInit: Expr | undefined): ArrayElement | null {
  if (resolvedHead !== null) return { target: resolvedHead, ...(prevInit !== undefined ? { init: prevInit } : {}) };
  if (isDeadFrom(list, fromIdx, prevStage)) {
    if (prevInit !== undefined) return null; // broken-threading: a defaulted element is never a hole
    return { hole: true };
  }
  return { target: prevStage, ...(prevInit !== undefined ? { init: prevInit } : {}) };
}

/** §4 precondition 2: `u` is the literal `undefined`, or a register whose
 *  only write anywhere in the function is a literal `undefined` (checked at
 *  the whole-function frame, since a register name never crosses a
 *  function boundary — AGENT-BRIEF). */
function isUndefinedSentinel(u: Expr, fnBody: readonly Stmt[]): boolean {
  if (isUndefLit(u)) return true;
  if (!isIdent(u)) return false;
  return identUses(fnBody, u.name).nested === 0;
}

function noPcOrTry(body: readonly Stmt[]): boolean {
  for (const s of body) {
    if (s.k === "try") return false;
    if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && (s.expr.target.name === "__pc" || s.expr.target.name === "__exc")) return false;
    if (s.k === "labeled" && !noPcOrTry(s.body)) return false;
    if (s.k === "if" && (!noPcOrTry(s.then) || !noPcOrTry(s.else))) return false;
  }
  return true;
}

function matchArray(list: readonly Stmt[], startIndex: number, fnBody: readonly Stmt[]): ArrayPatternSite | null {
  const first = list[startIndex]!;
  if (first.k !== "labeled") return null;
  let pro = parsePrologueBlock(first.body, first.label);
  let proInit: Expr | undefined;
  if (pro === null) {
    const dpro = parseDefaultedPrologueBlock(first.body, first.label);
    if (dpro === null) return null;
    pro = dpro;
    proInit = dpro.init;
  }
  if (!noPcOrTry(first.body)) return null; // pc-tracked-region
  if (!isRegisterName(pro.rawTarget)) return null; // non-register-target
  if (!isUndefinedSentinel(pro.u, fnBody)) return null; // not-undefined-guard
  const elements: ArrayElement[] = [];
  let prevDone = pro.doneSet;
  let prevStage = pro.rawTarget;
  let prevInit = proInit;
  let idx = startIndex + 1;
  const rIter = pro.rIter;
  const rNextFn = pro.rNextFn;
  for (;;) {
    const s = list[idx];
    if (s === undefined || s.k !== "labeled") break;
    if (!noPcOrTry(s.body)) break;
    let el: ElementResult | null = parseElementBlock(s.body, s.label, rIter, rNextFn, prevDone, prevStage);
    if (el === null) {
      const del = parseDefaultedElementBlock(s.body, s.label, rIter, rNextFn, prevDone);
      if (del === null) break;
      el = { ...del, resolvedPrevTarget: null };
    }
    if (!isUndefinedSentinel(el.u, fnBody)) break; // not-undefined-guard
    // Resolve the previous position now that we know whether this block's
    // own head committed it, is a hole, or is a direct-commit target
    // (`resolvePending`, BUGS.md 2026-09-02).
    const pending = resolvePending(list, idx, prevStage, el.resolvedPrevTarget, prevInit);
    if (pending === null) return null; // broken-threading
    elements.push(pending);
    prevDone = el.doneSet;
    prevStage = el.rawTarget;
    prevInit = el.init;
    idx++;
  }
  // Close block, required in v1 (no rest support): must immediately follow.
  // It may itself carry the final position's commit at its own head — the
  // last block's own raw target is only resolved once we know whether the
  // close block staged it away, is a hole, or is direct (`resolvePending`).
  const closeStmt = list[idx];
  if (closeStmt === undefined || closeStmt.k !== "labeled") return null; // close-shape
  const closeParse = parseCloseBlock(closeStmt.body, closeStmt.label, prevDone, prevStage);
  if (closeParse === null) return null; // close-shape
  if (!noPcOrTry(closeStmt.body)) return null;
  const finalPending = resolvePending(list, idx, prevStage, closeParse.resolvedPrevTarget, prevInit);
  if (finalPending === null) return null; // broken-threading
  elements.push(finalPending);
  for (const el of elements) if (el.hole !== true && (el.target === undefined || !isRegisterName(el.target))) return null; // non-register-target
  const endIndex = idx + 1;
  // state-escapes: none of the internal state registers may be *read* after
  // the whole unit *before being freshly redefined* — registers are
  // routinely reused for something else entirely right after (`firstTwo`'s
  // own `r0 = r2 + ":" + r1; return r0;` reuses `r0`, the iterator
  // register, as a plain scratch immediately after), so only a read that
  // would observe the *matched run's* stale value is a real escape.
  const after = list.slice(endIndex);
  const afterDefUse = defUse(after);
  for (const reg of [rIter, rNextFn, ...prevDone]) {
    const du = afterDefUse.get(reg);
    if (du === undefined) continue;
    const firstDef = du.defs.length === 0 ? Infinity : Math.min(...du.defs);
    if (du.reads.some((r) => r < firstDef)) return null; // state-escapes
  }
  return { kind: "array", startIndex, endIndex, source: pro.source, elements, rIter, rNextFn };
}

// ---------------------------------------------------------------------------
// O — object pattern.
// ---------------------------------------------------------------------------

export interface ObjectPropSite {
  readonly key: string;
  readonly target: string;
  readonly init?: Expr;
}
export interface ObjectRestSite {
  readonly excludedKeys: readonly string[];
  readonly target: string;
}
export interface ObjectPatternSite {
  readonly kind: "object";
  readonly startIndex: number;
  readonly endIndex: number;
  readonly source: Expr;
  readonly props: readonly ObjectPropSite[];
  readonly rest: ObjectRestSite | null;
}

/** `rT = rSrc.key` — a plain (unconditional) property read. */
function asPlainRead(s: Stmt, rSrc: string): { readonly target: string; readonly key: string } | null {
  const a = asIdentAssign(s);
  if (a === null || a.value.k !== "member" || a.value.computed || a.value.obj.k !== "ident" || a.value.obj.name !== rSrc) return null;
  if (a.value.prop.k !== "lit") return null;
  return { target: a.name, key: propKeyOf(a.value.prop.text) };
}
function propKeyOf(text: string): string {
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v === "string") return v;
  } catch {
    /* fall through */
  }
  return text;
}

/** Collapses the default body (between the guard and the tail `break`) into
 *  one `Expr` — the same shape `default-params`' `collapseToInit` accepts:
 *  a run of plain `expr` statements folded into a leading `seq`, the last
 *  one assigning the guarded register. */
function collapseDefault(stmts: readonly Stmt[], rT: string): Expr | null {
  if (stmts.length === 0) return null;
  const last = stmts[stmts.length - 1]!;
  const a = asIdentAssign(last);
  if (a === null || a.name !== rT) return null;
  const lead = stmts.slice(0, -1);
  if (!lead.every((s) => s.k === "expr")) return null;
  if (lead.length === 0) return a.value;
  return { k: "seq", exprs: [...lead.map((s) => (s as Extract<Stmt, { k: "expr" }>).expr), a.value] };
}

/** Tries to parse one labeled block as a run of leading plain reads off
 *  `rSrc` (possibly zero) followed by exactly one defaulted property (the
 *  guard governs the *last* read consumed). `rSrc === null` means the
 *  block's own first read establishes it. */
function parseDefaultedBlock(body: readonly Stmt[], label: string, rSrc: string | null): { readonly rSrc: string; readonly leading: readonly { readonly target: string; readonly key: string }[]; readonly guardedTarget: string; readonly guardedKey: string; readonly init: Expr; readonly u: Expr } | null {
  const reads: { readonly target: string; readonly key: string }[] = [];
  let resolvedSrc = rSrc;
  let i = 0;
  for (;;) {
    const st = body[i];
    if (st === undefined) return null;
    if (resolvedSrc !== null) {
      const r = asPlainRead(st, resolvedSrc);
      if (r !== null) {
        reads.push(r);
        i++;
        continue;
      }
    } else {
      const a = asIdentAssign(st);
      if (a !== null && a.value.k === "member" && !a.value.computed && a.value.obj.k === "ident" && a.value.prop.k === "lit") {
        resolvedSrc = a.value.obj.name;
        reads.push({ target: a.name, key: propKeyOf(a.value.prop.text) });
        i++;
        continue;
      }
      return null;
    }
    break;
  }
  if (reads.length === 0 || resolvedSrc === null) return null;
  const last = reads[reads.length - 1]!;
  const guard = asTailBreakGuard(body[i]!, label);
  if (guard === null || guard.k !== "bin" || guard.op !== "!==" || !isIdent(guard.left) || guard.left.name !== last.target) return null;
  i++;
  const rest = body.slice(i, -1);
  const tail = body[body.length - 1];
  if (tail === undefined || tail.k !== "break" || tail.label !== label) return null;
  const init = collapseDefault(rest, last.target);
  if (init === null) return null;
  return { rSrc: resolvedSrc, leading: reads.slice(0, -1), guardedTarget: last.target, guardedKey: last.key, init, u: guard.right };
}

/** `rEx = {}; rEx.k1 = 0; rEx.k2 = 0; …; rTarget = __hbc_b_copyDataProperties({}, rSrc, rEx);` */
function parseRestUnit(list: readonly Stmt[], i0: number, rSrc: string): { readonly site: ObjectRestSite; readonly next: number } | null {
  let i = i0;
  const initEx = asIdentAssign(list[i]!);
  if (initEx === null || initEx.value.k !== "object" || initEx.value.props.length !== 0) return null;
  const rEx = initEx.name;
  i++;
  const keys: string[] = [];
  while (true) {
    const s = list[i];
    if (s === undefined || s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "member") break;
    const t = s.expr.target;
    if (t.computed || t.obj.k !== "ident" || t.obj.name !== rEx) break;
    if (t.prop.k !== "lit" || s.expr.value.k !== "lit" || s.expr.value.text !== "0") break;
    keys.push(propKeyOf(t.prop.text));
    i++;
  }
  const call = asIdentAssign(list[i]!);
  if (call === null || call.value.k !== "call" || call.value.callee.k !== "ident" || call.value.callee.name !== "__hbc_b_copyDataProperties") return null;
  const args = call.value.args;
  if (args.length !== 3) return null; // 2-arg form is spread-rest's object spread
  if (args[0]!.k !== "object" || args[0]!.props.length !== 0) return null;
  if (!isIdent(args[1]!) || args[1]!.name !== rSrc) return null;
  if (!isIdent(args[2]!) || args[2]!.name !== rEx) return null;
  i++;
  return { site: { excludedKeys: keys, target: call.name }, next: i };
}

function matchObject(list: readonly Stmt[], startIndex: number, fnBody: readonly Stmt[]): ObjectPatternSite | null {
  let rSrc: string | null = null;
  const props: ObjectPropSite[] = [];
  let rest: ObjectRestSite | null = null;
  let sawDefaultOrRest = false;
  let idx = startIndex;
  for (;;) {
    const s = list[idx];
    if (s === undefined) break;
    if (rSrc !== null) {
      const plain = asPlainRead(s, rSrc);
      if (plain !== null) {
        props.push({ key: plain.key, target: plain.target });
        idx++;
        continue;
      }
    } else {
      // Bootstrap `rSrc` from a leading plain read too, not only from a
      // defaulted block's own first read (`parseDefaultedBlock` does the
      // same bootstrap for its own case) — a run may start with one or more
      // unconditional properties before the first default/rest.
      const a = asIdentAssign(s);
      if (a !== null && a.value.k === "member" && !a.value.computed && a.value.obj.k === "ident" && a.value.prop.k === "lit") {
        rSrc = a.value.obj.name;
        props.push({ key: propKeyOf(a.value.prop.text), target: a.name });
        idx++;
        continue;
      }
    }
    if (s.k === "labeled") {
      const blk = parseDefaultedBlock(s.body, s.label, rSrc);
      if (blk !== null) {
        if (rSrc !== null && blk.rSrc !== rSrc) break;
        rSrc = blk.rSrc;
        for (const r of blk.leading) props.push({ key: r.key, target: r.target });
        if (!isRegisterName(blk.guardedTarget)) return null; // non-register-target
        if (!isUndefinedSentinel(blk.u, fnBody)) return null; // not-undefined-guard
        props.push({ key: blk.guardedKey, target: blk.guardedTarget, init: blk.init });
        sawDefaultOrRest = true;
        idx++;
        continue;
      }
    }
    if (rSrc !== null && rest === null) {
      const r = parseRestUnit(list, idx, rSrc);
      if (r !== null) {
        rest = r.site;
        sawDefaultOrRest = true;
        idx = r.next;
        continue; // rest is always last (nothing legal follows it in this grammar)
      }
    }
    break;
  }
  if (rSrc === null || !sawDefaultOrRest) return null; // plain-reads-only / nothing found
  for (const p of props) if (!isRegisterName(p.target)) return null;
  // source-clobbered (§4 precondition 9): a write to `rSrc` anywhere in the
  // run other than at the very last statement is refused — `greet`'s own
  // `r2 = r2.greeting` (the last plain read, reusing `rSrc`'s register as
  // its own target) is the one legal exception (§2.5).
  for (let k = startIndex; k < idx - 1; k++) {
    const a = asIdentAssign(list[k]!);
    if (a !== null && a.name === rSrc) return null;
  }
  const endIndex = idx;
  return { kind: "object", startIndex, endIndex, source: { k: "ident", name: rSrc }, props, rest };
}

// ---------------------------------------------------------------------------
// Driver entry point.
// ---------------------------------------------------------------------------

export type DestructureSite = ArrayPatternSite | ObjectPatternSite;
export type DestructureMatch = Match<readonly Stmt[], DestructureSite>;

/** Idempotence (PL-08): a `destructure` output statement contains none of
 *  the raw idiom's anchors, so re-scanning it never matches again. */
export function match(list: readonly Stmt[], ctx: PassContext): DestructureMatch | null {
  const fnBody = ctx.fnBody ?? list;
  for (let i = 0; i < list.length; i++) {
    const arr = matchArray(list, i, fnBody);
    if (arr !== null) return { root: list, nodes: [list], data: arr, at: { functionIndex: ctx.functionIndex, offset: i } };
    const obj = matchObject(list, i, fnBody);
    if (obj !== null) return { root: list, nodes: [list], data: obj, at: { functionIndex: ctx.functionIndex, offset: i } };
  }
  return null;
}

export function buildPattern(site: DestructureSite): Pattern {
  if (site.kind === "array") {
    const elements: PatternElement[] = site.elements.map((e) => (e.hole === true ? { k: "hole" } : { k: "pel", target: { k: "pid", name: e.target! }, ...(e.init !== undefined ? { init: e.init } : {}) }));
    return { k: "parr", elements };
  }
  const propsOut: { readonly key: string; readonly value: PatternElement }[] = site.props.map((p) => ({ key: p.key, value: { k: "pel" as const, target: { k: "pid" as const, name: p.target }, ...(p.init !== undefined ? { init: p.init } : {}) } }));
  if (site.rest !== null) propsOut.push({ key: "", value: { k: "prest", target: { k: "pid", name: site.rest.target } } });
  return { k: "pobj", props: propsOut };
}

export function rewriteList(list: readonly Stmt[], site: DestructureSite): readonly Stmt[] {
  const pattern = buildPattern(site);
  const stmt: Stmt = { k: "expr", expr: { k: "destructure", pattern, source: site.source } };
  return [...list.slice(0, site.startIndex), stmt, ...list.slice(site.endIndex)];
}
