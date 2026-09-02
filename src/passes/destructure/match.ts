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
// *flat* labeled blocks only (no per-element default nesting inside the
// array scan, no holes-by-shape, no array rest — §8 Q1/Q3 and the
// PUSHBACK row explain why); object patterns support plain reads,
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
  readonly target: string;
  readonly init?: undefined; // v1: no per-element defaults (documented gap)
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
  const guard = asTailBreakGuard(body[i]!, label);
  if (guard === null || !isIdent(guard) || !prevDone.has(guard.name)) return null; // broken-threading
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

/** `Lc: { if (doneFinal) { break Lc } __hbc_iterClose(rIter, false); break Lc }`. */
function parseCloseBlock(body: readonly Stmt[], label: string, doneFinal: ReadonlySet<string>): boolean {
  let i = skipResets(body, 0);
  const guard = asTailBreakGuard(body[i]!, label);
  if (guard === null || !isIdent(guard) || !doneFinal.has(guard.name)) return false;
  i++;
  const close = asCallAssign(body[i]! /* also matches a bare `expr` call stmt below */);
  // `__hbc_iterClose` is called for effect only; it may be a bare call
  // statement, not an assignment — handle both.
  const st = body[i]!;
  const isCloseCall = (close !== null && close.callee === "__hbc_iterClose") || (st.k === "expr" && st.expr.k === "call" && st.expr.callee.k === "ident" && st.expr.callee.name === "__hbc_iterClose");
  if (!isCloseCall) return false;
  i++;
  const brk = body[i];
  if (brk === undefined || brk.k !== "break" || brk.label !== label) return false;
  return i + 1 === body.length;
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
  const pro = parsePrologueBlock(first.body, first.label);
  if (pro === null) return null;
  if (!noPcOrTry(first.body)) return null; // pc-tracked-region
  if (!isRegisterName(pro.rawTarget)) return null; // non-register-target
  if (!isUndefinedSentinel(pro.u, fnBody)) return null; // not-undefined-guard
  const elements: ArrayElement[] = [];
  let prevDone = pro.doneSet;
  let prevStage = pro.rawTarget;
  let idx = startIndex + 1;
  const rIter = pro.rIter;
  const rNextFn = pro.rNextFn;
  for (;;) {
    const s = list[idx];
    if (s === undefined || s.k !== "labeled") break;
    if (!noPcOrTry(s.body)) break;
    const el = parseElementBlock(s.body, s.label, rIter, rNextFn, prevDone, prevStage);
    if (el === null) break;
    if (!isUndefinedSentinel(el.u, fnBody)) break; // not-undefined-guard
    // Resolve the previous element's real target now that we know whether
    // this block staged it away.
    elements.push({ target: el.resolvedPrevTarget ?? prevStage });
    prevDone = el.doneSet;
    prevStage = el.rawTarget;
    idx++;
  }
  // The last block's own raw target is only "resolved" once we know no
  // following block staged it away — since we stopped, it is direct.
  elements.push({ target: prevStage });
  if (elements.length === 0) return null;
  for (const el of elements) if (!isRegisterName(el.target)) return null;
  // Close block, required in v1 (no rest support): must immediately follow.
  const closeStmt = list[idx];
  if (closeStmt === undefined || closeStmt.k !== "labeled" || !parseCloseBlock(closeStmt.body, closeStmt.label, prevDone)) return null; // close-shape
  if (!noPcOrTry(closeStmt.body)) return null;
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
    const elements: PatternElement[] = site.elements.map((e) => ({ k: "pel", target: { k: "pid", name: e.target } }));
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
