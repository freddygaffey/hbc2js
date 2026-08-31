// expr-rebuild matcher — docs/LOWERING-CATALOGUE.md row R1,
// docs/specs/passes/02-expr-rebuild.md §4.
//
// Site = one statement list `L` (`ctx.fnBody` reachable, innermost first).
// Scans `L` for the first register store `rX = E` that satisfies one of
// R1a (forward inline) / R1b (dead store) / R1c (self-move), in that order.
// `classifySite` is exported so `check.ts` can re-derive the same verdict
// from `before` alone (it gets no access to this match's `data`) and so unit
// tests can assert the exact refuse reason without going through the driver.
import type { Expr, Stmt } from "../ast.ts";
import { identUses, isPure, isPureStmt, isRegisterName, registerUses } from "../ast.ts";

const NO_USES = { reads: 0, writes: 0, nested: 0 } as const;
import type { Match, PassContext } from "../types.ts";

export type ExprRebuildRule = "R1a" | "R1b" | "R1c";

export interface ExprRebuildSite {
  readonly rule: ExprRebuildRule;
  /** Index of the store `rX = E` in `L`. */
  readonly i: number;
  /** R1a: index of the read site (`j > i`). R1b/R1c: equal to `i`. */
  readonly j: number;
  readonly reg: string;
  readonly value: Expr;
}

export type ExprRebuildMatch = Match<readonly Stmt[], ExprRebuildSite>;

export type RefuseReason = "not-dead" | "impure-move" | "input-clobbered" | "use-under-control-flow" | "two-reads" | "protocol-name" | "generator-frame" | "loop-variant-input";

export type ClassifyResult = { readonly ok: true; readonly rule: ExprRebuildRule; readonly j: number } | { readonly ok: false; readonly reason: RefuseReason };

// ---------------------------------------------------------------------------
// Small Expr/Stmt helpers local to this rung (D12a: no import beyond ../ast.ts).
// ---------------------------------------------------------------------------

/** "Simple" per §4: cannot transfer control. */
export function isSimple(s: Stmt): boolean {
  return s.k === "expr" || s.k === "init" || s.k === "decl" || s.k === "comment";
}

/** `rX = …` with the target exactly `ident rX` — a "plain store". */
export function isPlainStoreTo(s: Stmt, reg: string): boolean {
  return s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg;
}

/** "Any `ident rX` anywhere in `s`, including nested lists and nested func
 *  bodies" (§4's `mentions`). */
export function mentions(s: Stmt, reg: string): boolean {
  const u = identUses([s], reg);
  return u.reads + u.writes + u.nested > 0;
}

/** The one field R1a may read `rX` from, per statement kind (§4). `null` for
 *  a kind with no such field (its only mentions, if any, are in a body/case
 *  list, which is `use-under-control-flow`, never a valid `j`). */
export function topLevelExprOf(s: Stmt): Expr | null {
  switch (s.k) {
    case "expr":
      return s.expr;
    case "init":
      return s.value;
    case "return":
      return s.arg;
    case "throw":
      return s.arg;
    case "if":
      return s.test;
    case "while":
      return s.test ?? null;
    case "do-while":
      return s.test;
    case "for":
      return s.test;
    case "switch":
      return s.disc;
    default:
      return null;
  }
}

interface ExprCounts {
  readonly reads: number;
  readonly writes: number;
  readonly nested: number;
}

// `exprCounts(topLevelExprOf(s), name).reads` for every `name` at once,
// memoised on the statement's identity. The forward scan in `classifySite`
// and `stmtVerdict` ask this of the same statements for candidate after
// candidate, iteration after iteration (a statement keeps its identity
// across every rewrite that does not touch it — `rewrite.ts` slices, never
// copies), so one visit per statement replaces one per (statement,
// candidate, iteration) — the last big term of the M5 pipeline's cost on a
// real bundle (docs/PUSHBACK.md P-1). The read half of `exprCounts`'s visit,
// kept in lock-step with it: a read is an `ident` reached without crossing
// an `assign` target or a nested `func` body (`exprCounts` never credits
// `reads` for anything inside a `func`, for any name — a nested occurrence
// lands in `nested`), so the counts here equal `.reads` for every name.
const topLevelReadsMemo = new WeakMap<Stmt, ReadonlyMap<string, number>>();

function topLevelReads(s: Stmt): ReadonlyMap<string, number> {
  let m = topLevelReadsMemo.get(s);
  if (m !== undefined) return m;
  const counts = new Map<string, number>();
  const visit = (x: Expr): void => {
    switch (x.k) {
      case "ident":
        counts.set(x.name, (counts.get(x.name) ?? 0) + 1);
        return;
      case "assign":
        if (x.target.k !== "ident") visit(x.target);
        visit(x.value);
        return;
      case "member":
        visit(x.obj);
        if (x.computed) visit(x.prop);
        return;
      case "call":
      case "new":
        visit(x.callee);
        x.args.forEach(visit);
        return;
      case "bin":
      case "logical":
        visit(x.left);
        visit(x.right);
        return;
      case "unary":
        visit(x.arg);
        return;
      case "cond":
        visit(x.test);
        visit(x.then);
        visit(x.else);
        return;
      case "array":
        x.elements.forEach(visit);
        return;
      case "object":
        x.props.forEach((p) => visit(p.value));
        return;
      case "seq":
        x.exprs.forEach(visit);
        return;
      default:
        return; // func (a nested body is never a top-level read), lit, this, argumentsObject
    }
  };
  const tl = topLevelExprOf(s);
  if (tl !== null) visit(tl);
  m = counts;
  topLevelReadsMemo.set(s, m);
  return m;
}

/** `identUses`'s expr-visiting logic, applied to one `Expr` directly rather
 *  than a statement list — needed to isolate "reads within just this
 *  top-level field", which `identUses` (statement-list granularity) cannot
 *  distinguish from a read inside a body a few fields over. Mirrors
 *  `identUses`'s own read/write/nested split exactly, including the `func`
 *  case (delegates to `identUses` for the nested body). `topLevelReads`
 *  above is its memoised, all-names `.reads` half. */
export function exprCounts(e: Expr, reg: string): ExprCounts {
  let reads = 0;
  let writes = 0;
  let nested = 0;
  const visit = (x: Expr): void => {
    switch (x.k) {
      case "ident":
        if (x.name === reg) reads++;
        return;
      case "assign":
        if (x.target.k === "ident" && x.target.name === reg) writes++;
        else visit(x.target);
        visit(x.value);
        return;
      case "member":
        visit(x.obj);
        if (x.computed) visit(x.prop);
        return;
      case "call":
      case "new":
        visit(x.callee);
        x.args.forEach(visit);
        return;
      case "bin":
      case "logical":
        visit(x.left);
        visit(x.right);
        return;
      case "unary":
        visit(x.arg);
        return;
      case "cond":
        visit(x.test);
        visit(x.then);
        visit(x.else);
        return;
      case "array":
        x.elements.forEach(visit);
        return;
      case "object":
        x.props.forEach((p) => visit(p.value));
        return;
      case "seq":
        x.exprs.forEach(visit);
        return;
      case "func": {
        // Mirror `identUses`'s own function-scope boundary exactly: `x.body`
        // is a genuinely separate register frame (Hermes restarts `r0` per
        // function), so a register name can never be the same binding in
        // there — only a non-register name (an env slot, collision-free by
        // construction) can be a real cross-scope reference. See
        // `IdentUses.nested`'s doc in `../ast.ts`.
        if (isRegisterName(reg)) return;
        const inner = identUses(x.body, reg);
        nested += inner.reads + inner.writes + inner.nested;
        return;
      }
      default:
        return; // lit, this, argumentsObject
    }
  };
  visit(e);
  return { reads, writes, nested };
}

/** Register names a *pure* `Expr` reads (the only node kinds `isPure`
 *  allows are exactly the ones below, so this is always answerable for a
 *  value `classifySite` has already proven `isPure`). */
export function namesReadBy(e: Expr): readonly string[] {
  switch (e.k) {
    case "ident":
      return [e.name];
    case "unary":
      return namesReadBy(e.arg);
    case "bin":
    case "logical":
      return [...namesReadBy(e.left), ...namesReadBy(e.right)];
    case "cond":
      return [...namesReadBy(e.test), ...namesReadBy(e.then), ...namesReadBy(e.else)];
    default:
      return []; // lit, this: no register reads
  }
}

/** H1 (docs/reviews/M5-pass-2-3.md): `list[j]` being a `while`/`do-while`/
 *  `for` means the read R1a found in its `test` field is *multiply
 *  executed* — the test re-runs once per iteration, while the store at `i`
 *  ran exactly once. Folding `E` there is only sound if `E`'s value cannot
 *  change across iterations, i.e. it is loop-invariant. Conservative in
 *  both directions per the review's instruction: an impure `E` is refused
 *  outright (repeating its side effect every iteration is unsound
 *  regardless of what it reads — and `namesReadBy` is only meaningful for a
 *  pure `Expr`, so it must not be asked about one), and a pure `E` is
 *  refused unless every register it reads is written *nowhere* reachable
 *  from the loop's body or (for `for`) its `update` — including inside a
 *  nested `func` (`identUses`'s `nested` bucket), since a closure created
 *  in the body could still mutate a captured register between iterations
 *  and this rung has no way to rule that out from here. */
function loopTestGuard(loop: Stmt, value: Expr): RefuseReason | null {
  if (loop.k !== "while" && loop.k !== "do-while" && loop.k !== "for") return null;
  if (!isPure(value)) return "loop-variant-input";
  const update = loop.k === "for" ? loop.update : null;
  for (const name of namesReadBy(value)) {
    const u = identUses(loop.body, name);
    if (u.writes + u.nested > 0) return "loop-variant-input";
    if (update !== null && exprCounts(update, name).writes > 0) return "loop-variant-input";
  }
  return null;
}

/** Does `s` (assumed `isPureStmt`) write one of `regs`? */
function writesAnyOf(s: Stmt, regs: readonly string[]): boolean {
  return s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && regs.includes(s.expr.target.name);
}

type Verdict = "dead" | "read" | "clear";
/** A single statement's contribution to a scan (`stmtVerdict`): a terminal
 *  `Verdict`, or `next` — "this statement neither settles nor escapes
 *  anything for `reg`; the scan carries on with the statement after it".
 *  The distinction matters: a statement whose sub-lists were handed the
 *  list's own continuation (`if`/`switch`/`labeled`/`iife`, a `try`
 *  handler) has *already* scanned the rest of the list on every
 *  falling-through path, so a `clear` from it means some path escaped to a
 *  place this site cannot see (a `break` to a label outside the scan, a
 *  `continue`) — and that is terminal: carrying on would re-scan the rest
 *  and credit a later redefinition to a path that never reaches it. That
 *  was the `01-if-else-chain.min` v84/v94 wrong output (docs/BUGS.md,
 *  consolidation item 3): once label-clean flattened the inner label, the
 *  site `r0 = "negative"; … if (…) { break L0; } … r0 = r1;` sat in one
 *  list, the `if` came back `clear` (its `break L0` leaves the site, whose
 *  own `L0` is not in `labels`), the scan stepped on to `r0 = r1` and
 *  deleted the store — while `break L0` runs straight into `return r0`. */
type StepVerdict = Verdict | "next";
/** The label key for a label-less `break`: the innermost enclosing loop or
 *  `switch` maps it to its own continuation (the rest of the list that
 *  statement sits in). */
const UNLABELLED_BREAK = "";
/** "What verdict follows if control reaches this point" — a label's own
 *  continuation (`break L` resumes there), or "the rest of the enclosing
 *  list" (`rest`), or "unknown, beyond this site" (`CLEAR`, the top-level
 *  default: a stage-B site never sees past its own statement list). */
type Cont = () => Verdict;

const NO_LABELS: ReadonlyMap<string, Cont> = new Map();
const CLEAR: Cont = () => "clear";

/**
 * Memoises `scanFrom(list, from)` for one search episode (one `classifySite`
 * call, hence one fixed `reg`). Sound because `(list, from)` — list identity
 * plus index — names a fixed lexical position in the (unchanging, for the
 * duration of one search) tree: every root call this rung makes anchors
 * `labels`/`after` the same way (`NO_LABELS`/`CLEAR`), so whatever `labels`
 * map and `after` continuation eventually reach a given `(list, from)` are
 * themselves always the same lexically-determined value, however many
 * different `break` sites or candidate scans lead there. Without this, a
 * cascade of `if (cond) { … } else { …; break L }` sites all naming the same
 * outer label — exactly what hermesc emits for a chain of guarded
 * destructuring defaults — revisits the same `(list, from)` an amount that
 * multiplies with every level of nesting (each level's `rest` thunk gets
 * invoked once per `break` beneath it, and *its* computation redoes the same
 * multiplication one level further in), which is exponential in the chain's
 * length and was the M5 label-clean-enablement hang (see BUGS.md): label-
 * clean's own unwrapping of unrelated labels elsewhere in the function
 * merges previously-separate statement lists into the single larger one
 * this cascade sits in, which is what exposes it. Scoped to one `Memo`
 * instance per `classifySite` call (never reused across a rewrite, since the
 * tree changes and a stale cache would be unsound), this turns the
 * recursion from a tree (one node per path) into a DAG evaluated once per
 * distinct `(list, from)` — linear in tree size, not exponential in nesting
 * depth.
 */
type Memo = Map<readonly Stmt[], Map<number, Verdict>>;

/** Merges the verdicts of a statement's alternative branches (an `if`'s two
 *  arms, a `switch`'s cases): `read` wins if any branch reads the stale
 *  value; `dead` only if *every* branch is guaranteed to redefine it first
 *  (so every reachable path clears it); otherwise `clear` (inconclusive —
 *  at least one path neither reads nor redefines it). */
function mergeBranches(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.some((v) => v === "read")) return "read";
  if (verdicts.length > 0 && verdicts.every((v) => v === "dead")) return "dead";
  return "clear";
}

/**
 * What happens to `reg`'s *current* (stale, about-to-be-orphaned) value
 * across `s`'s own sub-lists, given `s` itself is already known not to read
 * or plainly overwrite `reg` at its own top level (`stmtVerdict` checks that
 * first). `labels` maps every label in scope to *its* continuation (so
 * `break L` resumes scanning exactly where `L`'s own statement would have
 * continued — this is what lets a hermesc-style cascade of
 * `if (r0===k) { break L } else { r0 = k'; … }` prove `r0`'s earlier value
 * dead: the `break` follows `L`'s continuation straight to the next
 * redefinition, rather than stopping the proof at the list boundary).
 * `rest` is "the rest of the list `s` itself sits in", handed to a branch
 * that falls through normally (an `if` with no `break`/`return`/`throw`,
 * `try`'s block, a `labeled`/`iife` wrapper).
 *
 * A loop's body might run zero times, so a loop can never be credited
 * `dead` from its body alone — only `read` (a body that reads it might run)
 * or `clear`; a `try` block is treated the same way, conservatively, since
 * an exception can leave it before reaching a redefinition (the handler, if
 * reached at all, still falls through to `rest` normally). `if`/`switch`
 * are the only shapes with exhaustive, unconditionally-taken branches, so
 * they are the only ones `mergeBranches` can promote to `dead`.
 */
function branchVerdict(s: Stmt, reg: string, labels: ReadonlyMap<string, Cont>, rest: Cont, memo: Memo): StepVerdict {
  switch (s.k) {
    case "break":
      // A label outside the scan (the site's own enclosing block, say) is an
      // escape to a point this site cannot see: terminal `clear`, never
      // "carry on" (see `StepVerdict`).
      return labels.get(s.label ?? UNLABELLED_BREAK)?.() ?? "clear";
    case "continue":
      return "clear"; // next iteration/update, not modelled: never claim `dead` through it
    case "if":
      return mergeBranches([scanFrom(s.then, reg, 0, labels, rest, memo), scanFrom(s.else, reg, 0, labels, rest, memo)]);
    case "switch": {
      if (s.cases.length === 0) return "next";
      const withBreak = new Map(labels);
      withBreak.set(UNLABELLED_BREAK, rest);
      return mergeBranches(s.cases.map((c) => scanFrom(c.body, reg, 0, withBreak, rest, memo)));
    }
    case "while":
    case "do-while":
    case "for": {
      const withBreak = new Map(labels);
      withBreak.set(UNLABELLED_BREAK, rest);
      const body = scanFrom(s.body, reg, 0, withBreak, CLEAR, memo);
      return body === "read" ? "read" : "next";
    }
    case "try": {
      const block = scanFrom(s.block, reg, 0, labels, CLEAR, memo);
      const handler = scanFrom(s.handler, reg, 0, labels, rest, memo);
      if (block === "read" || handler === "read") return "read";
      // The handler already scanned `rest`; its `clear` is an escape.
      return handler === "clear" ? "clear" : "next";
    }
    case "labeled": {
      const withLabel = new Map(labels);
      withLabel.set(s.label, rest);
      return scanFrom(s.body, reg, 0, withLabel, rest, memo);
    }
    case "iife":
      return scanFrom(s.body, reg, 0, labels, rest, memo);
    default:
      return "next";
  }
}

/** One statement's verdict: `read` (`reg`'s stale value is read — at top
 *  level, including a self-referential store's own value like
 *  `reg = reg + 1` or `reg = reg.prop`, since `topLevelExprOf` for an
 *  `expr`-kind store is the *whole* assign expression, target and value
 *  both, and `exprCounts` counts the value's read regardless of whether the
 *  same statement also happens to be a store; or inside a sub-list,
 *  following any `break` to its target); `dead` (a plain store to `reg`
 *  whose own value does *not* read `reg` — redefined, full stop); or
 *  `clear` (inconclusive: some path escapes — see `branchVerdict`); or
 *  `next` (irrelevant here — see `StepVerdict`). The read
 *  check must run *before* the plain-store check: a self-referential store
 *  is simultaneously "reads the stale value" and "is a store", and it is
 *  the read that must win — treating it as an unconditional `dead` (module
 *  review found this exact bug) discards the read, then a later, unrelated
 *  statement that also reads `reg` observes a dangling name once some
 *  earlier store folds into this one and deletes itself. */
function stmtVerdict(s: Stmt, reg: string, labels: ReadonlyMap<string, Cont>, rest: Cont, memo: Memo): StepVerdict {
  if ((topLevelReads(s).get(reg) ?? 0) > 0) return "read";
  if (isPlainStoreTo(s, reg)) return "dead";
  return branchVerdict(s, reg, labels, rest, memo);
}

// ---------------------------------------------------------------------------
// P-1: which statements can change a scan's verdict at all.
//
// A statement that mentions `reg` nowhere in its own frame *and* contains no
// `break`/`continue` is always `clear`-and-keep-going for `reg`: `stmtVerdict`
// finds no top-level read and no plain store, and `branchVerdict` on its
// sub-lists finds nothing either and falls through to the continuation of
// the enclosing list — i.e. exactly the verdict scanning would reach by
// stepping to the next statement (a loop/`try` block hands `CLEAR` to its
// body, which is `clear` too). Only a jump can send the scan somewhere else
// (a `break L` follows `L`'s own continuation, possibly past the end of this
// list), so any statement containing one is kept as "relevant" and evaluated
// exactly as before. Both scanning loops therefore hop between relevant
// positions instead of touching every statement in between: on hermesc's
// unoptimised output (hundreds of stores per list, each read far from its
// store) the per-list cost went from cubic to ~linear in the list, and
// rn-template's `noopt` bundle from 32 s to a few seconds (docs/PUSHBACK.md
// P-1). Per-statement facts are memoised on the statement's identity (an
// untouched statement survives every rewrite by identity — `rewrite.ts`
// slices, never copies), the per-list index on the list's.
// ---------------------------------------------------------------------------

interface StmtInterest {
  /** Register names occurring anywhere in the statement's own frame. */
  readonly regs: ReadonlySet<string>;
  /** A `break`/`continue` occurs anywhere in the statement's own frame. */
  readonly jump: boolean;
  /** `branchVerdict` on this statement hands its enclosing list's
   *  continuation to a sub-list that can fall through into it — so, with no
   *  mention of `reg` and no jump, its verdict *is* the rest of the list's.
   *  `if`/`labeled`/`iife`/`try` (its handler) always; `switch` with at
   *  least one case. Loops hand `CLEAR` to their body, never `rest`. */
  readonly passThrough: boolean;
}

const stmtInterestMemo = new WeakMap<Stmt, StmtInterest>();

function containsJump(list: readonly Stmt[]): boolean {
  for (const s of list) {
    switch (s.k) {
      case "break":
      case "continue":
        return true;
      case "if":
        if (containsJump(s.then) || containsJump(s.else)) return true;
        break;
      case "while":
      case "do-while":
      case "for":
      case "labeled":
      case "iife":
        if (containsJump(s.body)) return true;
        break;
      case "try":
        if (containsJump(s.block) || containsJump(s.handler)) return true;
        break;
      case "switch":
        for (const c of s.cases) if (containsJump(c.body)) return true;
        break;
      default:
        break; // expr, init, decl, return, throw, func (a separate frame), directive, comment, raw
    }
  }
  return false;
}

function stmtInterest(s: Stmt): StmtInterest {
  let it = stmtInterestMemo.get(s);
  if (it !== undefined) return it;
  const regs = new Set(registerUses([s]).keys());
  const jump = containsJump([s]);
  const passThrough = s.k === "if" || s.k === "labeled" || s.k === "iife" || s.k === "try" || (s.k === "switch" && s.cases.length > 0);
  it = { regs, jump, passThrough };
  stmtInterestMemo.set(s, it);
  return it;
}

interface ListIndex {
  /** Positions, ascending, of statements mentioning each register. */
  readonly byReg: ReadonlyMap<string, readonly number[]>;
  /** Positions, ascending, of statements containing a jump. */
  readonly jumps: readonly number[];
  /** `byReg[reg] ∪ jumps`, built lazily per register. */
  readonly relevant: Map<string, readonly number[]>;
  /** `passThroughPrefix[m]` = number of pass-through statements in `list[0, m)`. */
  readonly passThroughPrefix: readonly number[];
}

const listIndexMemo = new WeakMap<readonly Stmt[], ListIndex>();

function listIndex(list: readonly Stmt[]): ListIndex {
  let idx = listIndexMemo.get(list);
  if (idx !== undefined) return idx;
  const byReg = new Map<string, number[]>();
  const jumps: number[] = [];
  const passThroughPrefix: number[] = [0];
  list.forEach((s, m) => {
    const it = stmtInterest(s);
    for (const reg of it.regs) {
      const bucket = byReg.get(reg);
      if (bucket === undefined) byReg.set(reg, [m]);
      else bucket.push(m);
    }
    if (it.jump) jumps.push(m);
    passThroughPrefix.push(passThroughPrefix[m]! + (it.passThrough ? 1 : 0));
  });
  idx = { byReg, jumps, relevant: new Map(), passThroughPrefix };
  listIndexMemo.set(list, idx);
  return idx;
}

function mergeSorted(a: readonly number[], b: readonly number[]): readonly number[] {
  if (b.length === 0) return a;
  if (a.length === 0) return b;
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = i < a.length ? a[i]! : Infinity;
    const y = j < b.length ? b[j]! : Infinity;
    if (x < y) {
      out.push(x);
      i++;
    } else if (y < x) {
      out.push(y);
      j++;
    } else {
      out.push(x);
      i++;
      j++;
    }
  }
  return out;
}

/** The smallest index `>= from` whose statement can change a scan's verdict
 *  for `reg` (mentions it in its own frame, or contains a jump) —
 *  `list.length` when there is none. Every statement skipped over is
 *  `clear`-and-keep-going for `reg` (see the section comment above). */
function nextRelevant(list: readonly Stmt[], reg: string, from: number): number {
  const idx = listIndex(list);
  let positions = idx.relevant.get(reg);
  if (positions === undefined) {
    positions = mergeSorted(idx.byReg.get(reg) ?? [], idx.jumps);
    idx.relevant.set(reg, positions);
  }
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid]! < from) lo = mid + 1;
    else hi = mid;
  }
  return lo < positions.length ? positions[lo]! : list.length;
}

/** Scans `list` from `from`, statement by statement, stopping at the first
 *  `dead` (redefined — nothing further in `list` matters) or `read`
 *  (unsafe); once the list is exhausted, hands off to `after` (`clear` if
 *  the caller has nothing further to say). Memoised per `(list, from)` — see
 *  `Memo`'s doc — so a `(list, from)` reached through more than one `break`
 *  or candidate scan is computed once. Steps between relevant statements
 *  only (`nextRelevant`): the ones in between are `next` by construction. */
function scanFrom(list: readonly Stmt[], reg: string, from: number, labels: ReadonlyMap<string, Cont>, after: Cont, memo: Memo): Verdict {
  let cache = memo.get(list);
  if (cache === undefined) {
    cache = new Map();
    memo.set(list, cache);
  }
  const cached = cache.get(from);
  if (cached !== undefined) return cached;
  let result: Verdict = "clear";
  for (let x = nextRelevant(list, reg, from); x < list.length; x = nextRelevant(list, reg, x + 1)) {
    const rest: Cont = () => scanFrom(list, reg, x + 1, labels, after, memo);
    const v = stmtVerdict(list[x]!, reg, labels, rest, memo);
    if (v !== "next") {
      result = v;
      cache.set(from, result);
      return result;
    }
  }
  result = after();
  cache.set(from, result);
  return result;
}

/** D-a, generalised: is `reg`'s value (as of just after `j`) guaranteed to
 *  be redefined somewhere reachable from `list[j+1..]` before it is ever
 *  read again? A single `L[k] = reg <- …` is the simplest such
 *  redefinition, but an `if`/`switch` that redefines `reg` on *every* arm
 *  is just as good, and so is a `break L` that leads straight to one —
 *  `scanFrom` (via `stmtVerdict`/`branchVerdict`) proves any of these.
 *  `[i+1, j-1]` (`i` the original store) is not re-checked here: R1a's own
 *  travel-legality clause already proved it pure/simple/mention-free (or it
 *  is empty, for an impure move) — that is a *different* question (may `E`
 *  legally move there), answered before this is ever called. */
function tryDA(list: readonly Stmt[], j: number, reg: string, memo: Memo): boolean {
  return scanFrom(list, reg, j + 1, NO_LABELS, CLEAR, memo) === "dead";
}

/**
 * D-a (local to `list`, `tryDA`) or D-b: "`identUses(ctx.fnBody, rX)` reports
 * exactly one write (at `i`) and one read (at `j`)". `readsAtJ` is how many
 * of `reg`'s reads the caller has *already* independently verified sit at
 * `j` — for R1a that is the one top-level read `classifySite`'s forward
 * scan already found there (always 1); for R1b (`j === i`) it is
 * `exprCounts(value, reg).reads`, i.e. whether the store's own value reads
 * `reg` (a self-referential increment such as `rX = rX + 1`; 0 for an
 * ordinary store). D-b only holds when the *whole function's* read count
 * matches exactly what is already accounted for at that one position — a
 * read living anywhere else (a different `stmtLists` site the current one
 * cannot see, as `08/09/10`'s switch-lowering cascades do) is precisely the
 * live use D-b exists to catch, and must refuse the site, not credit it as
 * "single-use". Comparing `identUses(fnBody, reg).reads` against a bare `1`
 * instead — every read in the function, wherever it lives, treated as
 * interchangeable with "the one read D-b is asked to certify" — is exactly
 * the bug review M5-pass-2 found: a register genuinely read later, in a
 * sibling site the current list cannot see, was still deleted as dead
 * because it happened to have only one read *in the whole function*, none
 * of it at `j`.
 */
function isDeadAfter(list: readonly Stmt[], fnBody: readonly Stmt[], j: number, reg: string, readsAtJ: number, memo: Memo): boolean {
  if (tryDA(list, j, reg, memo)) return true;
  const u = registerUses(fnBody).get(reg) ?? NO_USES; // one memoised walk per fnBody, not one per candidate (P-1)
  return u.reads === readsAtJ && u.writes === 1 && u.nested === 0;
}

/** §4's whole matcher for one candidate store `L[i] = reg <- value`, tried
 *  as R1a then R1b then R1c (R1c always matches, checked by the caller
 *  before this is even called). Exported for `check.ts` (re-derives the
 *  same verdict from `before`) and for direct unit tests of the refuse
 *  reasons. */
export function classifySite(list: readonly Stmt[], fnBody: readonly Stmt[], i: number, reg: string, value: Expr): ClassifyResult {
  if (value.k === "ident" && value.name === reg) return { ok: true, rule: "R1c", j: i };

  // One search episode, one register: every `scanFrom` this call makes
  // (the forward loop below, and `isDeadAfter`/`tryDA`) shares this cache —
  // see `Memo`'s doc for why that is sound.
  const memo: Memo = new Map();

  // No `nested-capture` refusal here (removed — see docs/AGENT-LOG.md and
  // `IdentUses.nested`'s doc in `../ast.ts`): `reg` is a register name
  // (`match` only calls this after `isRegisterName(reg)`), and a register
  // can never be the same binding a nested `func` body reads — Hermes
  // restarts register numbering per function, and a genuine capture is
  // always copied to a collision-free env-slot name first. A nested `func`
  // mentioning the literal string `reg` is provably that closure's own,
  // unrelated local; `isDeadAfter` below (via `identUses(fnBody, reg)
  // .nested`, always `0` for a register name) already reflects this.

  // Forward scan for R1a's candidate read (a top-level occurrence of `reg`),
  // or a statement that redefines `reg` before any read reaches it (R1b's
  // territory), or a disqualifying read reachable before either.
  let readAt: number | null = null;
  let readTopCount = 0;
  let blocked = false;
  // Relevant statements only (P-1, `nextRelevant`): a skipped statement
  // neither reads nor stores `reg` and has no sub-list verdict of its own.
  for (let m = nextRelevant(list, reg, i + 1); m < list.length; m = nextRelevant(list, reg, m + 1)) {
    const s = list[m]!;
    const tlReads = topLevelReads(s).get(reg) ?? 0;
    if (tlReads > 0) {
      // Stepping statement by statement, a pass-through compound statement
      // (`if`, `try`, …) sitting between the store and this read would have
      // reported `read` first — its branches fall through to the rest of the
      // list, which starts with this read — and refused the site as
      // `use-under-control-flow` before the read was ever reached. Keep that
      // verdict (and its reason) exactly.
      const prefix = listIndex(list).passThroughPrefix;
      if (prefix[m]! - prefix[i + 1]! > 0) {
        blocked = true;
        break;
      }
      readAt = m;
      readTopCount = tlReads;
      break;
    }
    if (isPlainStoreTo(s, reg)) break; // redefined, no read ever reached it
    const restAfterM: Cont = () => scanFrom(list, reg, m + 1, NO_LABELS, CLEAR, memo);
    const v = branchVerdict(s, reg, NO_LABELS, restAfterM, memo);
    if (v === "read") {
      blocked = true;
      break;
    }
    if (v === "dead") break; // redefined on every reachable path inside `s`
    // v === "clear": irrelevant to `reg`, or inconclusive; keep scanning.
  }

  if (readAt !== null) {
    if (readTopCount > 1) return { ok: false, reason: "two-reads" };
    const j = readAt;
    // Does `L[j]`'s own body (not its top-level field, already counted
    // above) also read the same stale value — e.g. `if (reg) { use(reg) }`?
    const restAfterJ: Cont = () => scanFrom(list, reg, j + 1, NO_LABELS, CLEAR, memo);
    const consumerVerdict = branchVerdict(list[j]!, reg, NO_LABELS, restAfterJ, memo);
    if (consumerVerdict === "read") return { ok: false, reason: "use-under-control-flow" };
    // if-chain regression (M5 rung 9, 2026-09-01; found by T2 on 51-default-
    // params/38/39/21/46 the moment if-chain produced the guard shape): a
    // jump *inside the consuming statement itself* escapes this site with
    // the stale value still bound — `rX = E; if (rX !== u) { break L };
    // rX = fresh` runs the `break` path straight into a read of `rX` outside
    // the list (`return rX`), which `branchVerdict` reports as the same
    // `clear` an irrelevant fall-through produces. The read-check above
    // therefore lets it through, and `isDeadAfter` then credits the *local*
    // redefinition. With any `break`/`continue` in the consumer's own frame,
    // only a proven `dead` (every internal path redefines `rX` before any
    // read) may pass; `clear` is an escape and must refuse — unless D-b's
    // whole-function count proves the escape harmless: with exactly one
    // read (the one at `j`), one write (the store at `i`) and no nested
    // mention in the entire function, there is no statement anywhere the
    // escape could reach that reads the stale value. Consumers without
    // jumps are unaffected: their every path falls through to `j + 1`,
    // which `isDeadAfter` already answers.
    if (stmtInterest(list[j]!).jump && consumerVerdict !== "dead") {
      const u = registerUses(fnBody).get(reg) ?? NO_USES;
      if (!(u.reads === 1 && u.writes === 1 && u.nested === 0)) return { ok: false, reason: "use-under-control-flow" };
    }
    const loopGuard = loopTestGuard(list[j]!, value);
    if (loopGuard !== null) return { ok: false, reason: loopGuard };
    if (isPure(value)) {
      const inputs = namesReadBy(value);
      for (let x = i + 1; x < j; x++) {
        const t = list[x]!;
        if (!isSimple(t) || !isPureStmt(t) || mentions(t, reg)) return { ok: false, reason: "impure-move" };
        if (writesAnyOf(t, inputs)) return { ok: false, reason: "input-clobbered" };
      }
    } else if (j !== i + 1) {
      return { ok: false, reason: "impure-move" };
    }
    // If `L[j]` is itself a plain store to `reg` (self-referential, e.g. a
    // second `reg = reg + x` landing right where we are folding a *first*
    // one in), the value being folded away is dead the instant `j` finishes
    // — `j` overwrites `reg`'s binding there, so nothing after `j` can ever
    // observe it, whatever `j`'s own new value happens to read. Skipping
    // this and going straight to `isDeadAfter` (which starts looking for a
    // redefinition *after* `j`, never re-examining `j` itself) used to
    // treat `j`'s own read of its fresh output as an unrelated live use of
    // the value being folded away, and refuse a genuinely safe site.
    if (!isPlainStoreTo(list[j]!, reg) && !isDeadAfter(list, fnBody, j, reg, 1, memo)) return { ok: false, reason: "not-dead" };
    return { ok: true, rule: "R1a", j };
  }

  if (blocked) return { ok: false, reason: "use-under-control-flow" };

  // R1b candidate: j = i. D-b's "one read at j" becomes "reg's own value
  // reads reg" (a self-referential store like `reg = reg + 1`) — 0 for an
  // ordinary store, which is the common case (see `isDeadAfter`'s comment).
  if (!isDeadAfter(list, fnBody, i, reg, exprCounts(value, reg).reads, memo)) return { ok: false, reason: "not-dead" };
  return { ok: true, rule: "R1b", j: i };
}

function isGeneratorFrame(ctx: PassContext): boolean {
  const info = ctx.cfg?.generator?.info;
  return info !== undefined && info.era === "opcode" && info.kind !== "normal";
}

export function match(list: readonly Stmt[], ctx: PassContext): ExprRebuildMatch | null {
  if (isGeneratorFrame(ctx)) return null; // refuse the whole function (§7 generator-frame)
  const fnBody = ctx.fnBody ?? list;
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    if (s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "ident") continue;
    const reg = s.expr.target.name;
    if (!isRegisterName(reg)) continue; // protocol-name: not our business
    const value = s.expr.value;
    const verdict = classifySite(list, fnBody, i, reg, value);
    if (verdict.ok) {
      return { root: list, nodes: [list], data: { rule: verdict.rule, i, j: verdict.j, reg, value }, at: { functionIndex: ctx.functionIndex, offset: i } };
    }
  }
  return null;
}
