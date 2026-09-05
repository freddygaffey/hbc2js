// optional-chain matcher — docs/LOWERING-CATALOGUE.md row 25,
// docs/specs/passes/18-optional-chain.md §4. Recognises the labeled-block
// suffix run Hermes lowers `?.`/`?.()`/`?.[]`/`??` to: one loose `Eq`
// against a null sentinel per `?.` link, the compare/reset order differing
// only by version (§2.4) — never a version test in this file.
import type { Expr, Stmt } from "../ast.ts";
import { identUses, isRegisterName, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export type RefuseReason =
  | "not-null-guard"
  | "label-shared"
  | "result-read-early"
  | "state-escapes"
  | "chain-broken"
  | "optcall-this-mismatch"
  | "mixed-guards"
  | "interleaved-effect"
  | "not-suffix"
  | "unlowerable-fallback"
  | "fallback-reads-body-state"
  | "pc-tracked-region";

export interface ChainLink {
  readonly kind: "member" | "call";
  readonly computed: boolean;
  /** member/computed member's key; `null` for a call link. */
  readonly prop: Expr | null;
  /** call link's arguments; `null` for a member link. */
  readonly args: readonly Expr[] | null;
  /** Whether this link's own base was null-checked immediately before this
   *  read (`?.`) or not (plain `.`) — §4's closing note: the matcher keys
   *  each link strictly on the presence of *its own* guard, never on
   *  whether the run's opening link happened to carry one. A run may open
   *  with one or more unguarded reads (the compiler elides a link's guard
   *  once it has separately proven that base non-nullish — observed on
   *  v99's own object-literal bases and on a sibling chain's already-
   *  proven register, docs/lowering/optional-chaining.md §7) — those links
   *  are plain `member`/`call` in the output, not `optmember`/`optcall`. */
  readonly guarded: boolean;
}

export interface ChainSite {
  readonly kind: "chain";
  readonly rRes: string;
  readonly base: Expr; // ident of B0
  readonly links: readonly ChainLink[];
  readonly startIndex: number;
  readonly endIndex: number; // exclusive; list[endIndex-1] is the tail `break`
  readonly label: string;
  /** Every register this run's own bookkeeping (link temps, spilled
   *  compares) must be dead outside it — reused by `check.ts`. */
  readonly tempRegs: readonly string[];
}

export interface NullishSite {
  readonly kind: "nullish";
  readonly rX: string;
  readonly left: Expr;
  readonly fallback: Expr;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly label: string;
  /** Index (in the *enclosing* list) of a folded pure literal write, or
   *  `null` when `left` is a bare `ident rX`. */
  readonly foldedFrom: number | null;
}

export type OptionalChainSite = ChainSite | NullishSite;
export type OptionalChainMatch = Match<readonly Stmt[], OptionalChainSite>;

// ---------------------------------------------------------------------------
// Small shape recognisers shared by both rules.
// ---------------------------------------------------------------------------

function isUndefinedLit(e: Expr): boolean {
  return e.k === "lit" && e.text === "undefined";
}

/** Every statement in `stmts` (recursively, including nested `func` bodies —
 *  a sentinel register is function-scoped, same frame boundary as
 *  `identUses`) that assigns literal `null` to `name`, vs. every other
 *  assignment to it — precondition 1 (`not-null-guard`). */
function nullWriteCount(stmts: readonly Stmt[], name: string): { readonly nullWrites: number; readonly otherWrites: number } {
  let nullWrites = 0;
  let otherWrites = 0;
  walk(stmts, {
    stmt: (s) => {
      if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === name) {
        if (s.expr.value.k === "lit" && s.expr.value.text === "null") nullWrites++;
        else otherWrites++;
      } else if (s.k === "init" && s.name === name) {
        if (s.value.k === "lit" && s.value.text === "null") nullWrites++;
        else otherWrites++;
      }
    },
  });
  return { nullWrites, otherWrites };
}

/** Precondition 1: `e` is literal `null`, or a register whose only write in
 *  `fnBody` is literal `null`. */
function isNullSentinel(e: Expr, fnBody: readonly Stmt[]): boolean {
  if (e.k === "lit" && e.text === "null") return true;
  if (e.k !== "ident" || !isRegisterName(e.name)) return false;
  const { nullWrites, otherWrites } = nullWriteCount(fnBody, e.name);
  return nullWrites === 1 && otherWrites === 0;
}

// ---------------------------------------------------------------------------
// Precondition 1, position-aware (2026-09-05, docs/BUGS.md follow-up to the
// base-guard-elision fix): a reaching-definitions check over the AST the
// pass already has, replacing `isNullSentinel`'s whole-function "only write
// is literal null" rule with "the *reaching* write at this specific read is
// literal null". Same "prefix writes in flow order, from the read's own
// list outward to fnBody" pattern `global-access/match.ts`'s §4 condition 6
// (`hasPreGuardClobber`, docs/BUGS.md T14 follow-up) established for a
// structurally identical whole-function-proof bug — reimplemented locally
// (not imported: a rung may not reach into a sibling rung's matcher
// internals, D12a), same two-function split (`prefixWrites`/`prefixWritesIn`
// there, `prefixSentinelWrites`/`prefixSentinelWritesIn` here) and the same
// documented limits: no pre-read write found at all is NOT a refusal (falls
// back to the old whole-function rule — ambiguous, refuse-as-before, never
// a new acceptance), and a write on a branch that cannot actually reach the
// read still counts as a possible clobber (flow-order, not path-sensitive —
// the safe direction, since it can only make this refuse more, never accept
// something unsound).

/** Every `expr`-statement store `rX = value` reachable from `stmts`
 *  (recursively, including nested statement lists, excluding a nested
 *  `func`'s own frame — same frame boundary `nullWriteCount`/`identUses`
 *  already use), for `rX === reg`. */
function registerWriteValues(stmts: readonly Stmt[], reg: string): readonly Expr[] {
  const out: Expr[] = [];
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg) out.push(s.expr.value);
      switch (s.k) {
        case "if":
          visit(s.then);
          visit(s.else);
          break;
        case "while":
        case "do-while":
        case "for":
        case "labeled":
        case "iife":
          visit(s.body);
          break;
        case "try":
          visit(s.block);
          visit(s.handler);
          break;
        case "switch":
          for (const c of s.cases) visit(c.body);
          break;
        default:
          break; // decl, break, continue, return, throw (no sub-list), func (separate frame)
      }
    }
  };
  visit(stmts);
  return out;
}

/** Writes to `reg` in every statement list that *precedes* `target` in flow
 *  order, from `list` outward-in — `list`'s own statements before the one
 *  containing `target`, then (recursively) the same inside that statement,
 *  down to `target`'s immediately enclosing list. `null` when `target` is
 *  not reachable from `list` at all (compared by identity). Writes are
 *  returned in flow order, at any nesting depth. */
function prefixSentinelWrites(list: readonly Stmt[], target: readonly Stmt[], reg: string): readonly Expr[] | null {
  if (list === target) return [];
  const prefix: Expr[] = [];
  for (const s of list) {
    const inner = prefixSentinelWritesIn(s, target, reg);
    if (inner !== null) return [...prefix, ...inner];
    prefix.push(...registerWriteValues([s], reg));
  }
  return null;
}

/** `prefixSentinelWrites` for the sub-lists of one statement — an `if`'s
 *  `then`/`else` are alternatives (entering one never inherits the other's
 *  writes); a `try`'s `block` runs before its `handler`. */
function prefixSentinelWritesIn(s: Stmt, target: readonly Stmt[], reg: string): readonly Expr[] | null {
  switch (s.k) {
    case "if":
      return prefixSentinelWrites(s.then, target, reg) ?? prefixSentinelWrites(s.else, target, reg);
    case "while":
    case "do-while":
    case "for":
    case "labeled":
    case "iife":
      return prefixSentinelWrites(s.body, target, reg);
    case "try": {
      const inBlock = prefixSentinelWrites(s.block, target, reg);
      if (inBlock !== null) return inBlock;
      const inHandler = prefixSentinelWrites(s.handler, target, reg);
      return inHandler === null ? null : [...registerWriteValues(s.block, reg), ...inHandler];
    }
    case "switch": {
      for (const c of s.cases) {
        const hit = prefixSentinelWrites(c.body, target, reg);
        if (hit !== null) return hit;
      }
      return null;
    }
    default:
      return null; // decl, break, continue, return, throw, expr, func, directive, comment, raw
  }
}

/** The outermost loop body (`while`/`do-while`/`for`, labelled or not) that
 *  transitively contains the statement list `target`, or `null` when
 *  `target` is not inside a loop — same helper `global-access/match.ts`'s
 *  §4 condition 5 (`hasLoopReentryClobber`) established, reimplemented
 *  locally. `labeled`/`iife` bodies are transparent (run once, not loops
 *  themselves); a `func` body is a separate frame and never entered. */
function outermostLoopBodyContaining(fnBody: readonly Stmt[], target: readonly Stmt[]): readonly Stmt[] | null {
  const visit = (list: readonly Stmt[], loop: readonly Stmt[] | null): { readonly loop: readonly Stmt[] | null } | null => {
    if (list === target) return { loop };
    for (const s of list) {
      let hit: { readonly loop: readonly Stmt[] | null } | null = null;
      switch (s.k) {
        case "if":
          hit = visit(s.then, loop) ?? visit(s.else, loop);
          break;
        case "while":
        case "do-while":
        case "for":
          hit = visit(s.body, loop ?? s.body);
          break;
        case "labeled":
        case "iife":
          hit = visit(s.body, loop);
          break;
        case "try":
          hit = visit(s.block, loop) ?? visit(s.handler, loop);
          break;
        case "switch":
          for (const c of s.cases) {
            hit = visit(c.body, loop);
            if (hit !== null) break;
          }
          break;
        default:
          break;
      }
      if (hit !== null) return hit;
    }
    return null;
  };
  return visit(fnBody, null)?.loop ?? null;
}

/** Repeat-visit soundness (mirrors `global-access`'s §4 condition 5): when
 *  a guard testing `reg` sits inside a loop, a write positioned *after* the
 *  read in program text still runs *before* it on every repeat visit, so
 *  the forward-only reaching-write proof below is not enough on its own —
 *  take the outermost enclosing loop body and refuse if it contains *any*
 *  write to `reg` whose value is not literally `null`, wherever it sits
 *  relative to the read. Not exercised by any known fixture (the idiom's
 *  guards are not observed inside loops), included for the same soundness
 *  reason `global-access`'s T14 fix was — a whole-function or forward-only
 *  proof about a register's value is unsound inside a loop without it. */
function sentinelLoopReentryClobber(fnBody: readonly Stmt[], list: readonly Stmt[], reg: string): boolean {
  const loopBody = outermostLoopBodyContaining(fnBody, list);
  if (loopBody === null) return false;
  return registerWriteValues(loopBody, reg).some((w) => !(w.k === "lit" && w.text === "null"));
}

/** Precondition 1 (`not-null-guard`), position-aware: `e` is literal `null`,
 *  or a register whose *reaching* write at `list[idx]`'s read is literal
 *  `null` — the last write found walking `list[0..idx-1]` plus every
 *  enclosing list's statements before the one containing `list` (outward to
 *  `fnBody`). No reaching write found at all (list unreachable from
 *  `fnBody`, or nothing precedes this read in the scanned prefix) falls
 *  back to `isNullSentinel`'s old whole-function rule — see the block
 *  comment above. This is what lets `48-optional-chaining-nullish`'s v99
 *  binary recover: a later chain's own spilled-compare destination and an
 *  unrelated literal both reuse the null-sentinel register *after* every
 *  guard that actually reads it as a sentinel, so neither ever appears as
 *  the reaching write for any real guard — only the original `null` write
 *  does (docs/lowering/optional-chaining.md §7). */
function isNullSentinelAt(e: Expr, fnBody: readonly Stmt[], list: readonly Stmt[], idx: number): boolean {
  if (e.k === "lit" && e.text === "null") return true;
  if (e.k !== "ident" || !isRegisterName(e.name)) return false;
  const reg = e.name;

  const outer = prefixSentinelWrites(fnBody, list, reg);
  if (outer !== null) {
    const local = registerWriteValues(list.slice(0, idx), reg);
    const writes = [...outer, ...local];
    const last = writes[writes.length - 1];
    if (last !== undefined) {
      if (!(last.k === "lit" && last.text === "null")) return false; // reaching write is not null: unsound to accept
      return !sentinelLoopReentryClobber(fnBody, list, reg);
    }
  }
  return isNullSentinel(e, fnBody); // no positional evidence: fall back to the old whole-function rule
}

function sameRegOrExpr(a: Expr, b: Expr): boolean {
  return a === b || (a.k === "ident" && b.k === "ident" && a.name === b.name) || JSON.stringify(a) === JSON.stringify(b);
}

function matchReset(s: Stmt | undefined): { readonly reg: string } | null {
  if (s === undefined || s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "ident" || !isRegisterName(s.expr.target.name)) return null;
  if (!isUndefinedLit(s.expr.value)) return null;
  return { reg: s.expr.target.name };
}

/** Skips forward over zero or more *provably dead* reset statements
 *  (`rX = undefined` where `rX` has exactly one write — this one — and no
 *  read anywhere in the whole function) starting at `list[idx]`. The
 *  compiler's declaration-hoisting batch can interleave another local's
 *  own dead reset between a chain guard's compare and its real reset
 *  (`48-optional-chaining-nullish` v96's own `user?.profile?.name`,
 *  docs/BUGS.md), which used to make `matchChainGuard` see a reset for the
 *  wrong register at a fixed offset and refuse the whole guard. A register
 *  this is dead for can never be the run's own `rRes` (which is read again
 *  later, outside the run, by construction), so this can never mask the
 *  real reset — only skip statements that could not have been it. The
 *  skipped statements are absorbed into the matched span exactly like any
 *  other bookkeeping statement (`rewrite.ts` drops `[startIndex,
 *  endIndex)` wholesale) — sound because a write with no reads anywhere
 *  has no observable effect. */
function skipDeadResets(list: readonly Stmt[], idx: number, fnBody: readonly Stmt[]): number {
  let i = idx;
  while (i < list.length) {
    const r = matchReset(list[i]);
    if (r === null) break;
    const uses = identUses(fnBody, r.reg);
    if (uses.reads !== 0 || uses.writes !== 1) break; // not provably dead: might be the real reset
    i++;
  }
  return i;
}

function matchTailBreak(s: Stmt | undefined, label: string): boolean {
  return s !== undefined && s.k === "break" && s.label === label;
}

/** `if (<test>) { break <label> }` with no `else`. */
function matchGuardIf(s: Stmt | undefined, label: string | null): { readonly test: Expr; readonly label: string } | null {
  if (s === undefined || s.k !== "if" || s.else.length !== 0 || s.then.length !== 1) return null;
  const br = s.then[0]!;
  if (br.k !== "break" || br.label === null) return null;
  if (label !== null && br.label !== label) return null;
  return { test: s.test, label: br.label };
}

function looseEqNull(test: Expr, op: "==" | "!="): { readonly left: Expr; readonly right: Expr } | null {
  if (test.k !== "bin" || test.op !== op) return null;
  return { left: test.left, right: test.right };
}

/** `rT = B.prop` / `rT = B[idx]` / `rT = Reflect.apply(callee, thisArg, args)`
 *  where `B` is the current chain register — precondition 5 (`chain-broken`,
 *  `optcall-this-mismatch`). `callBase` is the register `B` (the callee) was
 *  itself loaded from, required to equal the apply's `thisArg`. */
/** `B === null` means "unconstrained — discover the base from `value.obj`/
 *  `value.args[0]` instead of requiring it to equal a known register" —
 *  only reachable for the very first link of a run whose base guard the
 *  compiler elided (no `current` chain register has been established yet).
 *  A call link can never be the discovery case: with no known `current`
 *  there is also no known `callBase` for the `?.()` receiver check, and
 *  `Reflect.apply`'s own base is always guarded in every observed fixture
 *  (open question 2, spec 18 §8) — refuse rather than guess. Returns the
 *  base actually used (either `B` itself, confirmed, or the discovered
 *  one) so the caller can seed `current`/`base` on first use. */
function matchLinkExpr(value: Expr, B: Expr | null, callBase: Expr | null): { readonly link: Omit<ChainLink, "guarded">; readonly base: Expr } | null {
  if (value.k === "member") {
    if (B !== null && !sameRegOrExpr(value.obj, B)) return null;
    return { link: { kind: "member", computed: value.computed, prop: value.prop, args: null }, base: value.obj };
  }
  if (value.k === "call" && value.callee.k === "member" && !value.callee.computed && value.callee.obj.k === "ident" && value.callee.obj.name === "Reflect" && value.callee.prop.k === "lit" && value.callee.prop.text === "apply" && value.args.length === 3) {
    if (B === null) return null; // no known base to discover a call link from
    const [callee, thisArg, argsArr] = value.args;
    if (!sameRegOrExpr(callee!, B)) return null;
    if (callBase === null || !sameRegOrExpr(thisArg!, callBase)) return null; // optcall-this-mismatch
    if (argsArr!.k !== "array") return null;
    return { link: { kind: "call", computed: false, prop: null, args: argsArr!.elements }, base: callee! };
  }
  return null;
}

/**
 * §2.1's computed-link case: a literal index is sometimes spilled to its
 * own register right before the read (`r13 = 10; r6 = r14[r13];`), rather
 * than inlined. This reads the link statement at `cursor`, first trying
 * one such prep statement immediately before it — a pure `rP = <lit>`
 * whose only use is as this link's computed key — and substituting the
 * literal in directly (the run stays contiguous: the prep is folded into
 * the link, not left as a separate observable statement, so nothing about
 * it survives for `interleaved-effect` to trip on). Falls back to reading
 * `list[cursor]` directly as the link statement.
 */
function readLinkStmt(list: readonly Stmt[], cursor: number, current: Expr | null, currentBase: Expr | null): { readonly link: Omit<ChainLink, "guarded">; readonly base: Expr; readonly target: string; readonly afterLink: number } | null {
  const prep = list[cursor];
  const real = list[cursor + 1];
  if (prep !== undefined && prep.k === "expr" && prep.expr.k === "assign" && prep.expr.target.k === "ident" && isRegisterName(prep.expr.target.name) && prep.expr.value.k === "lit" && real !== undefined && real.k === "expr" && real.expr.k === "assign" && real.expr.target.k === "ident") {
    const prepReg = prep.expr.target.name;
    const value = real.expr.value;
    if (value.k === "member" && value.computed && value.prop.k === "ident" && value.prop.name === prepReg) {
      const substituted = { ...value, prop: prep.expr.value };
      const read = matchLinkExpr(substituted, current, currentBase);
      if (read !== null) return { link: read.link, base: read.base, target: real.expr.target.name, afterLink: cursor + 2 };
    }
  }
  const linkStmt = list[cursor];
  if (linkStmt === undefined || linkStmt.k !== "expr" || linkStmt.expr.k !== "assign" || linkStmt.expr.target.k !== "ident") return null;
  const read = matchLinkExpr(linkStmt.expr.value, current, currentBase);
  if (read === null) return null;
  return { link: read.link, base: read.base, target: linkStmt.expr.target.name, afterLink: cursor + 1 };
}

// ---------------------------------------------------------------------------
// C-rule (the optional chain itself).
// ---------------------------------------------------------------------------

/**
 * A guard on `expectedReg` (§4 "C — optional chain" anchor / alternating
 * link/guard run), in either version's statement order (§2.4) — v94
 * `reset; if (X == N) break L;`, v99 `rC = X == N; reset; if (rC) break
 * L;`. `expectedReg === null` *discovers* `X`/`rRes`/`label` from the
 * guard itself (only true for the very first guard a run finds, whether
 * that is the base guard or, when the base guard is elided, the first
 * link's own guard); once known, every later call requires `X` to equal
 * `expectedReg` and (when `expectedRRes`/`expectedLabel` are given) the
 * reset/break to still target the run's own `rRes`/`label` (precondition
 * 3 — every reset writes the *same* register; precondition 2's label
 * exclusivity is checked separately once the whole run is known).
 */
function matchChainGuard(list: readonly Stmt[], idx: number, fnBody: readonly Stmt[], expectedReg: Expr | null, expectedRRes: string | null, expectedLabel: string | null): { readonly rRes: string; readonly tested: Expr; readonly label: string; readonly consumed: number } | null {
  // v94: reset, then an inline `if (X == N) break L` — a hoisting batch may
  // interleave one or more unrelated dead resets before the real one.
  const j0 = skipDeadResets(list, idx, fnBody);
  const reset0 = matchReset(list[j0]);
  if (reset0 !== null && (expectedRRes === null || reset0.reg === expectedRRes)) {
    const g = matchGuardIf(list[j0 + 1], expectedLabel);
    if (g !== null) {
      const eq = looseEqNull(g.test, "==");
      if (eq !== null && isNullSentinelAt(eq.right, fnBody, list, idx) && (expectedReg === null || sameRegOrExpr(eq.left, expectedReg))) {
        return { rRes: reset0.reg, tested: eq.left, label: g.label, consumed: j0 - idx + 2 };
      }
    }
  }
  // v99: a spilled compare first, then the reset (again, possibly preceded
  // by interleaved dead resets), then `if (rC) break L`.
  const s0 = list[idx];
  if (s0 !== undefined && s0.k === "expr" && s0.expr.k === "assign" && s0.expr.target.k === "ident" && isRegisterName(s0.expr.target.name)) {
    const eq = looseEqNull(s0.expr.value, "==");
    if (eq !== null && isNullSentinelAt(eq.right, fnBody, list, idx) && (expectedReg === null || sameRegOrExpr(eq.left, expectedReg))) {
      const rC = s0.expr.target.name;
      const j1 = skipDeadResets(list, idx + 1, fnBody);
      const reset1 = matchReset(list[j1]);
      if (reset1 !== null && (expectedRRes === null || reset1.reg === expectedRRes)) {
        const g = matchGuardIf(list[j1 + 1], expectedLabel);
        if (g !== null && g.test.k === "ident" && g.test.name === rC) return { rRes: reset1.reg, tested: eq.left, label: g.label, consumed: j1 - idx + 2 };
      }
    }
  }
  return null;
}

/** Tries to parse a full run starting at `list[start]`: alternating
 *  guard/link pairs, ending at the commit + tail `break`. §4's closing
 *  note: a link is keyed strictly on the *presence* of its own guard, so
 *  the run need not open with one — when `list[start]` is not a guard at
 *  all, this reads it directly as an unguarded first link (`guarded:
 *  false`) and discovers `base`/`current` from its own operand instead of
 *  from a preceding `== null` check; every subsequent unguarded position is
 *  handled the same way, so an elided guard anywhere in the run (not only
 *  at the open) falls out of the same loop. `rRes`/`label` are themselves
 *  discovered from whichever statement is the run's *first* real guard —
 *  until one is found, `target === rRes` can never be true, so an all-
 *  unguarded run (no `?.` in it at all — precondition 6, guard count ≥ 1)
 *  can never spuriously reach a commit; it just runs out of link statements
 *  and refuses. Returns `null` on any precondition failure — the caller
 *  (`match`) simply tries the next `start`. */
function parseChainAt(list: readonly Stmt[], start: number, fnBody: readonly Stmt[]): ChainSite | null {
  const links: ChainLink[] = [];
  const tempRegs: string[] = [];
  let rRes: string | null = null;
  let label: string | null = null;
  let base: Expr | null = null;
  let current: Expr | null = null;
  let currentBase: Expr | null = null;
  let cursor = start;

  for (;;) {
    const g = matchChainGuard(list, cursor, fnBody, current, rRes, label);
    let guarded = false;
    if (g !== null) {
      guarded = true;
      if (rRes === null) { rRes = g.rRes; label = g.label; }
      if (current === null) current = g.tested;
      cursor += g.consumed;
    }

    const read = readLinkStmt(list, cursor, current, currentBase);
    if (read === null) return null; // chain-broken
    const { link, base: readBase, target, afterLink } = read;
    if (current === null) current = readBase;
    if (base === null) base = current;

    if (rRes !== null && target === rRes) {
      if (!matchTailBreak(list[afterLink], label!)) return null; // not-suffix
      links.push({ ...link, guarded });
      const endIndex = afterLink + 1;
      if (!labelExclusive(list, label!, start, endIndex)) return null; // label-shared
      if (identUses(list.slice(start, endIndex), rRes).reads > 0) return null; // result-read-early
      return { kind: "chain", rRes, base, links, startIndex: start, endIndex, label: label!, tempRegs };
    }
    if (!isRegisterName(target)) return null;
    links.push({ ...link, guarded });
    tempRegs.push(target);
    currentBase = current;
    current = { k: "ident", name: target };
    cursor = afterLink;
  }
}

/** Precondition 2 (`label-shared`): no statement in `list` outside
 *  `[start, end)` breaks to `label` — the run's own tail `break` is L's
 *  *only* exit besides falling off the block, which is what guarantees a
 *  short-circuit lands exactly where `rRes` is next read as `undefined`. */
function labelExclusive(list: readonly Stmt[], label: string, start: number, end: number): boolean {
  for (let k = 0; k < list.length; k++) {
    if (k >= start && k < end) continue;
    const s = list[k]!;
    if (s.k === "break" && s.label === label) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// N-rule (nullish coalescing).
// ---------------------------------------------------------------------------

/** Collapses `stmts` (everything between the `!=` guard and the tail
 *  `break`) into one `Expr`, the same "trailing assign, pure comma-fold
 *  lead" rule `default-params` (spec 15 §5) applies to a defaulted
 *  parameter's body — reimplemented here (not imported: `default-params`
 *  is a sibling pass, off limits per D12a's import boundary). */
function collapseFallback(stmts: readonly Stmt[], rX: string): Expr | null {
  if (stmts.length === 0) return null;
  const last = stmts[stmts.length - 1]!;
  if (last.k !== "expr" || last.expr.k !== "assign" || last.expr.target.k !== "ident" || last.expr.target.name !== rX) return null;
  const lead = stmts.slice(0, -1);
  if (!lead.every((s): s is Extract<Stmt, { k: "expr" }> => s.k === "expr")) return null;
  if (lead.length === 0) return last.expr.value;
  return { k: "seq", exprs: [...lead.map((s) => s.expr), last.expr.value] };
}

function parseNullishAt(list: readonly Stmt[], start: number, fnBody: readonly Stmt[]): NullishSite | null {
  const g = matchGuardIf(list[start], null);
  if (g === null) return null;
  const eq = looseEqNull(g.test, "!=");
  if (eq === null || eq.left.k !== "ident" || !isRegisterName(eq.left.name) || !isNullSentinelAt(eq.right, fnBody, list, start)) return null;
  const label = g.label;
  const rX = eq.left.name;

  let end = start + 1;
  while (end < list.length && !(list[end]!.k === "break" && (list[end] as Extract<Stmt, { k: "break" }>).label === label)) end++;
  if (end >= list.length) return null;
  const body = list.slice(start + 1, end);
  const fallback = collapseFallback(body, rX);
  if (fallback === null) return null; // unlowerable-fallback

  let left: Expr = { k: "ident", name: rX };
  let foldedFrom: number | null = null;
  const prev = list[start - 1];
  if (prev !== undefined && prev.k === "expr" && prev.expr.k === "assign" && prev.expr.target.k === "ident" && prev.expr.target.name === rX && prev.expr.value.k === "lit" && identUses(list, rX).writes === 2) {
    left = prev.expr.value;
    foldedFrom = start - 1;
  }
  if (!labelExclusive(list, label, start, end + 1)) return null; // label-shared
  return { kind: "nullish", rX, left, fallback, startIndex: start, endIndex: end + 1, label, foldedFrom };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function match(list: readonly Stmt[], ctx: PassContext): OptionalChainMatch | null {
  const fnBody = ctx.fnBody ?? list;
  for (let i = 0; i < list.length; i++) {
    const chain = parseChainAt(list, i, fnBody);
    if (chain !== null && chain.endIndex === list.length) {
      return { root: list, nodes: [list], data: chain, at: { functionIndex: ctx.functionIndex, offset: chain.startIndex } };
    }
    const nullish = parseNullishAt(list, i, fnBody);
    if (nullish !== null) {
      return { root: list, nodes: [list], data: nullish, at: { functionIndex: ctx.functionIndex, offset: nullish.startIndex } };
    }
  }
  return null;
}
