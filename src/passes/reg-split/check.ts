// reg-split checker — docs/specs/passes/19-reg-split.md §6. Sound, and
// deliberately does not share fate with `match.ts`'s §4.2 interpreter for
// the soundness core (obligation 3): the coarse relation `R` below is its
// own, independent implementation — no import of anything from `match.ts`
// except the two plain utilities (`declaredNames`, `transformFrame`/
// `indexStatements` for occurrence enumeration) that are not part of the
// §4.2 analysis itself, exactly the precedent `var-naming/check.ts` sets by
// importing its own match's `declaredNames`.
import type { Stmt } from "../ast.ts";
import { defUse, freeNames, identUses, isRegisterName, isSafeIdentifier, printProgram } from "../ast.ts";
import type { CheckResult, PassContext } from "../types.ts";
import { declaredNames, indexStatements, transformFrame } from "./match.ts";
import type { OccKind } from "./match.ts";

const SUFFIXED_RE = /^(r\d+)_(\d+)$/;
const REG_RE = /^r\d+$/;

function stripName(name: string): string {
  const m = SUFFIXED_RE.exec(name);
  return m === null ? name : m[1]!;
}

// ---------------------------------------------------------------------------
// Obligation 1 — undo is byte-identical.
// ---------------------------------------------------------------------------

function renameExpr(e: import("../ast.ts").Expr, fn: (name: string) => string): import("../ast.ts").Expr {
  switch (e.k) {
    case "ident": {
      if (!isRegisterName(e.name)) return e;
      const to = fn(e.name);
      return to === e.name ? e : { ...e, name: to };
    }
    case "member":
    case "optmember": {
      const obj = renameExpr(e.obj, fn);
      const prop = e.computed ? renameExpr(e.prop, fn) : e.prop;
      return obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
    }
    case "call":
    case "optcall":
    case "new": {
      const callee = renameExpr(e.callee, fn);
      const args = e.args.map((a) => renameExpr(a, fn));
      return callee === e.callee && args.every((a, i) => a === e.args[i]) ? e : { ...e, callee, args };
    }
    case "bin":
    case "logical": {
      const left = renameExpr(e.left, fn);
      const right = renameExpr(e.right, fn);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "unary": {
      const arg = renameExpr(e.arg, fn);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "assign": {
      const target = renameExpr(e.target, fn);
      const value = renameExpr(e.value, fn);
      return target === e.target && value === e.value ? e : { ...e, target, value };
    }
    case "cond": {
      const test = renameExpr(e.test, fn);
      const then = renameExpr(e.then, fn);
      const els = renameExpr(e.else, fn);
      return test === e.test && then === e.then && els === e.else ? e : { ...e, test, then, else: els };
    }
    case "array": {
      const elements = e.elements.map((x) => renameExpr(x, fn));
      return elements.every((x, i) => x === e.elements[i]) ? e : { ...e, elements };
    }
    case "object": {
      let changed = false;
      const props = e.props.map((p) => {
        if ("k" in p) {
          const arg = renameExpr(p.arg, fn);
          if (arg !== p.arg) changed = true;
          return arg === p.arg ? p : { ...p, arg };
        }
        const value = renameExpr(p.value, fn);
        if (value !== p.value) changed = true;
        return value === p.value ? p : { ...p, value };
      });
      return changed ? { ...e, props } : e;
    }
    case "spread": {
      const arg = renameExpr(e.arg, fn);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "seq": {
      const exprs = e.exprs.map((x) => renameExpr(x, fn));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    case "template": {
      const exprs = e.exprs.map((x) => renameExpr(x, fn));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    case "tagged": {
      const tag = renameExpr(e.tag, fn);
      const quasi = renameExpr(e.quasi, fn);
      return tag === e.tag && quasi === e.quasi ? e : { ...e, tag, quasi };
    }
    case "destructure": {
      // §3/§4.2: a register in a destructure pattern is never split, so
      // this pass never introduces a suffixed name here — the pattern's
      // `pid`s are left exactly as `match.ts`'s `isRegisterId` doc says.
      const source = renameExpr(e.source, fn);
      return source === e.source ? e : { ...e, source };
    }
    default:
      return e; // lit, this, argumentsObject, func (separate frame)
  }
}

function stripStmts(list: readonly Stmt[]): readonly Stmt[] {
  const one = (s: Stmt): Stmt => {
    switch (s.k) {
      case "expr":
        return { ...s, expr: renameExpr(s.expr, stripName) };
      case "decl": {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const n of s.names) {
          const stripped = stripName(n);
          if (!seen.has(stripped)) {
            seen.add(stripped);
            out.push(stripped);
          }
        }
        return { ...s, names: out };
      }
      case "init":
        return { ...s, name: stripName(s.name), value: renameExpr(s.value, stripName) };
      case "if":
        return { ...s, test: renameExpr(s.test, stripName), then: stripStmts(s.then), else: stripStmts(s.else) };
      case "while":
        return s.test === undefined ? { ...s, body: stripStmts(s.body) } : { ...s, test: renameExpr(s.test, stripName), body: stripStmts(s.body) };
      case "do-while":
        return { ...s, test: renameExpr(s.test, stripName), body: stripStmts(s.body) };
      case "for":
        return {
          ...s,
          init: s.init === null ? null : renameExpr(s.init, stripName),
          test: renameExpr(s.test, stripName),
          update: s.update === null ? null : renameExpr(s.update, stripName),
          body: stripStmts(s.body),
        };
      case "labeled":
        return { ...s, body: stripStmts(s.body) };
      case "return":
        return { ...s, arg: s.arg === null ? null : renameExpr(s.arg, stripName) };
      case "throw":
        return { ...s, arg: renameExpr(s.arg, stripName) };
      case "try":
        return { ...s, block: stripStmts(s.block), handler: stripStmts(s.handler) };
      case "switch":
        return { ...s, disc: renameExpr(s.disc, stripName), cases: s.cases.map((c) => ({ ...c, test: c.test === null ? null : renameExpr(c.test, stripName), body: stripStmts(c.body) })) };
      case "iife":
        return { ...s, body: stripStmts(s.body) };
      case "func":
        return s; // separate frame — never recurse
      default:
        return s; // break, continue, directive, comment, raw
    }
  };
  return list.map(one);
}

// ---------------------------------------------------------------------------
// Obligation 2 helper — occurrence enumeration via `match.ts`'s shared,
// order-defining traversal (plain reuse, not the §4.2 analysis).
// ---------------------------------------------------------------------------

interface Occ {
  readonly reg: string;
  readonly kind: OccKind;
  readonly stmtIdx: number;
}

function enumerate(list: readonly Stmt[]): readonly Occ[] {
  const stmtIndex = indexStatements(list);
  const out: Occ[] = [];
  transformFrame(list, stmtIndex, (reg, kind, _strong, stmtIdx) => {
    out.push({ reg, kind, stmtIdx });
    return undefined;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Obligation 3 — the independent coarse relation R, computed entirely from
// `before` (`defUse` is the only framework helper reused; the strength
// classification, containment sets and spine-prefix test below are this
// checker's own code, not `match.ts`'s §4.2 interpreter).
// ---------------------------------------------------------------------------

interface Geometry {
  readonly chain: ReadonlyMap<number, readonly number[]>; // idx -> ancestor statement idxs, root-first
  readonly isLoop: ReadonlySet<number>;
  readonly enclosingLoops: ReadonlyMap<number, ReadonlySet<number>>;
  readonly enclosingTries: ReadonlyMap<number, ReadonlySet<number>>;
  readonly tryHandlerOf: ReadonlyMap<number, number>; // idx -> the nearest try whose handler contains it
  readonly tryBlockOf: ReadonlyMap<number, ReadonlySet<number>>; // idx -> tries whose block contains it
  readonly statements: ReadonlyMap<number, Stmt>;
}

function buildGeometry(fnBody: readonly Stmt[]): Geometry {
  const chain = new Map<number, readonly number[]>();
  const isLoop = new Set<number>();
  const enclosingLoops = new Map<number, ReadonlySet<number>>();
  const enclosingTries = new Map<number, ReadonlySet<number>>();
  const tryHandlerOf = new Map<number, number>();
  const statements = new Map<number, Stmt>();
  let idx = 0;
  const visit = (list: readonly Stmt[], ancestors: readonly number[], loops: ReadonlySet<number>, tries: ReadonlySet<number>): void => {
    for (const s of list) {
      const myIdx = idx++;
      statements.set(myIdx, s);
      chain.set(myIdx, ancestors);
      enclosingLoops.set(myIdx, loops);
      enclosingTries.set(myIdx, tries);
      switch (s.k) {
        case "if":
          visit(s.then, [...ancestors, myIdx], loops, tries);
          visit(s.else, [...ancestors, myIdx], loops, tries);
          break;
        case "while":
        case "do-while":
        case "for": {
          isLoop.add(myIdx);
          const nextLoops = new Set(loops);
          nextLoops.add(myIdx);
          visit(s.body, [...ancestors, myIdx], nextLoops, tries);
          break;
        }
        case "labeled":
        case "iife":
          visit(s.body, [...ancestors, myIdx], loops, tries);
          break;
        case "try": {
          const blockTries = new Set(tries);
          blockTries.add(myIdx);
          visit(s.block, [...ancestors, myIdx], loops, blockTries);
          const handlerTries = new Set(tries);
          handlerTries.add(myIdx);
          const handlerStart = idx;
          visit(s.handler, [...ancestors, myIdx], loops, handlerTries);
          for (let h = handlerStart; h < idx; h++) tryHandlerOf.set(h, myIdx);
          break;
        }
        case "switch":
          for (const c of s.cases) visit(c.body, [...ancestors, myIdx], loops, tries);
          break;
        default:
          break; // func: separate frame
      }
    }
  };
  visit(fnBody, [], new Set(), new Set());
  return { chain, isLoop, enclosingLoops, enclosingTries, tryHandlerOf, tryBlockOf: new Map(), statements };
}

/** `tryBlockOf` (which try(s)' own `block` list contains each idx, at any
 *  depth) is easiest as its own small pass — a statement is "in T's block"
 *  for every `try` ancestor T whose `block` (not `handler`) list is on the
 *  path to it. */
function markTryBlocks(fnBody: readonly Stmt[], tryBlockOf: Map<number, Set<number>>): void {
  let idx = 0;
  const visit = (list: readonly Stmt[], activeBlocks: readonly number[]): void => {
    for (const s of list) {
      const myIdx = idx++;
      for (const t of activeBlocks) {
        let set = tryBlockOf.get(myIdx);
        if (set === undefined) tryBlockOf.set(myIdx, (set = new Set()));
        set.add(t);
      }
      switch (s.k) {
        case "if":
          visit(s.then, activeBlocks);
          visit(s.else, activeBlocks);
          break;
        case "while":
        case "do-while":
        case "for":
        case "labeled":
        case "iife":
          visit(s.body, activeBlocks);
          break;
        case "try":
          visit(s.block, [...activeBlocks, myIdx]);
          visit(s.handler, activeBlocks);
          break;
        case "switch":
          for (const c of s.cases) visit(c.body, activeBlocks);
          break;
        default:
          break;
      }
    }
  };
  visit(fnBody, []);
}

function isStrongDefOf(s: Stmt, reg: string): boolean {
  if (s.k === "init") return s.name === reg;
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg) return true;
  if (s.k === "for") {
    const isTop = (e: import("../ast.ts").Expr | null): boolean => e !== null && e.k === "assign" && e.target.k === "ident" && e.target.name === reg;
    return isTop(s.init) || isTop(s.update);
  }
  return false;
}

/** All def positions (statement idx) of `reg` in `before`, from `defUse`
 *  (framework) plus the virtual `d0` at idx `-1`. */
function defIdxs(fnBody: readonly Stmt[], reg: string): number[] {
  const du = defUse(fnBody).get(reg);
  const idxs = du === undefined ? [] : [...du.defs];
  idxs.push(-1); // d0
  return idxs;
}
function useIdxs(fnBody: readonly Stmt[], reg: string): number[] {
  const du = defUse(fnBody).get(reg);
  return du === undefined ? [] : [...du.reads];
}

function sharesLoop(geo: Geometry, dIdx: number, uIdx: number): boolean {
  const dLoops = new Set(geo.enclosingLoops.get(dIdx) ?? []);
  if (geo.isLoop.has(dIdx)) dLoops.add(dIdx);
  const uLoops = geo.enclosingLoops.get(uIdx) ?? new Set();
  const uAll = new Set(uLoops);
  if (geo.isLoop.has(uIdx)) uAll.add(uIdx);
  for (const l of dLoops) if (uAll.has(l)) return true;
  return false;
}

function reachesCatch(geo: Geometry, dIdx: number, uIdx: number): boolean {
  const T = geo.tryHandlerOf.get(uIdx);
  if (T === undefined) return false;
  if (dIdx === -1) return true; // d0 is before everything
  if (dIdx >= T) return (geo.tryBlockOf.get(dIdx) ?? new Set()).has(T) && dIdx < uIdx;
  return dIdx < T; // "before the try at any depth"
}

function isForInitTopDef(s: Stmt, reg: string): boolean {
  return s.k === "for" && s.init !== null && s.init.k === "assign" && s.init.target.k === "ident" && s.init.target.name === reg;
}

function intercepts(geo: Geometry, reg: string, kIdx: number, uIdx: number): boolean {
  const k = geo.statements.get(kIdx);
  if (k === undefined || !isStrongDefOf(k, reg)) return false;
  if (kIdx === uIdx) {
    // A `for` header's `init` and `test` share one statement idx (defUse's
    // convention). `init` always runs, exactly once, strictly before
    // `test` is ever evaluated — so an init-site def intercepts a same-idx
    // use (the test). An `update`-site def at this same idx must not: on
    // the very first `test`, `update` has not run yet.
    if (!isForInitTopDef(k, reg)) return false;
  } else {
    const chainK = geo.chain.get(kIdx) ?? [];
    const chainU = geo.chain.get(uIdx) ?? [];
    let gate: number;
    if (chainU.length === chainK.length && chainK.every((v, i) => v === chainU[i])) {
      gate = uIdx; // u directly in k's own list
    } else if (chainU.length > chainK.length && chainK.every((v, i) => v === chainU[i])) {
      gate = chainU[chainK.length]!;
    } else {
      return false; // u not under k's list at all
    }
    // `gate === kIdx` means `u` is nested *inside* the construct `k`
    // itself introduces (its body) rather than a later sibling in `Lk` —
    // only reachable when `k.k === "for"` (the one body-bearing kind
    // `isStrongDefOf` recognises). Its `init` always runs before the body
    // is ever entered, so that still intercepts; an `update`-site def does
    // not (the first body pass runs before `update` ever does).
    if (!(kIdx < gate) && !(gate === kIdx && isForInitTopDef(k, reg))) return false;
  }
  // "every try containing k also contains u" (conservative subset test).
  const triesK = geo.enclosingTries.get(kIdx) ?? new Set();
  const triesU = geo.enclosingTries.get(uIdx) ?? new Set();
  for (const t of triesK) if (!triesU.has(t)) return false;
  // Every loop containing `k` must also contain `u` — a `k` that only
  // conditionally/repeatedly runs inside some loop `L` does not *surely*
  // run before `u` unless `u` is inside `L` too (`L` might iterate zero
  // times, or `u`'s particular reach of the gate might not be the one
  // right after `k`'s last run). A `k` entirely outside every loop `u` is
  // in is not at risk from this: `k` ran once, unconditionally, strictly
  // before `u`'s loop was ever entered (the spine/gate test above already
  // established that), and no back edge of a loop `k` was never part of
  // can carry anything "around" it.
  const loopsK = new Set(geo.enclosingLoops.get(kIdx) ?? []);
  if (geo.isLoop.has(kIdx)) loopsK.add(kIdx);
  const loopsU = new Set(geo.enclosingLoops.get(uIdx) ?? []);
  if (geo.isLoop.has(uIdx)) loopsU.add(uIdx);
  for (const l of loopsK) if (!loopsU.has(l)) return false;
  return true;
}

function exprMentions(e: import("../ast.ts").Expr, reg: string): boolean {
  switch (e.k) {
    case "ident":
      return e.name === reg;
    case "member":
    case "optmember":
      return exprMentions(e.obj, reg) || (e.computed && exprMentions(e.prop, reg));
    case "call":
    case "optcall":
    case "new":
      return exprMentions(e.callee, reg) || e.args.some((a) => exprMentions(a, reg));
    case "bin":
    case "logical":
      return exprMentions(e.left, reg) || exprMentions(e.right, reg);
    case "unary":
      return exprMentions(e.arg, reg);
    case "assign":
      return exprMentions(e.target, reg) || exprMentions(e.value, reg);
    case "cond":
      return exprMentions(e.test, reg) || exprMentions(e.then, reg) || exprMentions(e.else, reg);
    case "array":
      return e.elements.some((x) => exprMentions(x, reg));
    case "seq":
    case "template":
      return e.exprs.some((x) => exprMentions(x, reg));
    default:
      return false; // lit, this, argumentsObject, object/spread/tagged/destructure/jsx/func: not for-header shapes
  }
}

/** `u` is a `for` header's `update`-field read, and a statement-level
 *  strong def of `reg` sits as a *direct* (unconditional) child of that
 *  same `for`'s own `body` list: `body` always runs, completely, before
 *  `update` ever does, on every iteration including the first — so that
 *  def shields any earlier def from reaching `update`. Only sound when
 *  `test` itself never reads `reg` (test's *first* evaluation runs before
 *  body ever has a chance to). This is the back-edge-shaped counterpart of
 *  `intercepts`'s ordinary forward dominance — R-loop does not cover it
 *  because the shielding def is *inside* the loop and `u` (the header) is
 *  outside no def-carrying construct itself. */
function forUpdateShielded(geo: Geometry, reg: string, uIdx: number): boolean {
  const u = geo.statements.get(uIdx);
  if (u === undefined || u.k !== "for") return false;
  if (exprMentions(u.test, reg)) return false;
  return u.body.some((s) => isStrongDefOf(s, reg));
}

// P-11a: this used to call `defIdxs(fnBody, reg)` itself — a fresh
// `defUse(fnBody)` whole-body walk (framework, uncached) — once per
// (def, use) pair in `check`'s double loop below, i.e. `O(defs x uses x
// body)` for every split register. The caller already has that same list
// (`defPositions`, computed once per register); passing it in makes this
// `O(defs)` per call, `O(defs^2 x uses)` total per register — no `body`
// factor — which is the pipeline-speed bottleneck P-11 named (measured
// 13.6x, over the 12x ceiling; docs/PUSHBACK.md P-11).
function reachesSeq(geo: Geometry, defPositions: readonly number[], reg: string, dIdx: number, uIdx: number): boolean {
  if (!(dIdx < uIdx)) return false;
  if (forUpdateShielded(geo, reg, uIdx)) return false;
  for (const kIdx of defPositions) {
    if (kIdx <= dIdx || kIdx > uIdx) continue;
    if (intercepts(geo, reg, kIdx, uIdx)) return false;
  }
  return true;
}

/** Every register whose split must be validated: those `after`'s `decl`
 *  introduced a suffixed name for. */
function splitRegisters(before: readonly Stmt[], after: readonly Stmt[]): Set<string> | null {
  const beforeDecl = before.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  const afterDecl = after.find((s): s is Stmt & { k: "decl" } => s.k === "decl");
  if (beforeDecl === undefined || afterDecl === undefined) return null;
  const regs = new Set<string>();
  for (const n of afterDecl.names) {
    const m = SUFFIXED_RE.exec(n);
    if (m !== null) regs.add(m[1]!);
  }
  return regs;
}

export function check(before: readonly Stmt[], after: readonly Stmt[], _ctx: PassContext): CheckResult {
  const splitRegs = splitRegisters(before, after);
  if (splitRegs === null || splitRegs.size === 0) {
    return { ok: false, reason: "unexpected shape: reg-split only ever expands the leading decl, nothing else" };
  }
  for (const r of splitRegs) if (!REG_RE.test(r)) return { ok: false, reason: "unexpected shape: a split base name was not a plain register" };

  // Obligation 1: undo is byte-identical.
  const undone = stripStmts(after);
  if (printProgram(before) !== printProgram(undone)) {
    return { ok: false, reason: "the rewrite is not a pure rename: undoing it does not reproduce the original source" };
  }

  // Obligation 2: occurrence bijection, and no split name leaked into a
  // nested frame.
  const beforeOccs = enumerate(before);
  const afterOccs = enumerate(after);
  if (beforeOccs.length !== afterOccs.length) {
    return { ok: false, reason: "the rewrite changed the number of register occurrences" };
  }
  const suffixedNames = new Set<string>();
  for (let i = 0; i < beforeOccs.length; i++) {
    const b = beforeOccs[i]!;
    const a = afterOccs[i]!;
    if (b.kind !== a.kind || b.stmtIdx !== a.stmtIdx) {
      return { ok: false, reason: "the rewrite changed which statement an occurrence belongs to" };
    }
    if (stripName(a.reg) !== b.reg) {
      return { ok: false, reason: "occurrence bijection: an occurrence's stripped name does not match the original" };
    }
    if (a.reg !== b.reg) suffixedNames.add(a.reg);
  }
  for (const name of suffixedNames) {
    if (!SUFFIXED_RE.test(name)) return { ok: false, reason: "coarse-reach-crosses-split" };
    if (identUses(after, name).nested > 0) return { ok: false, reason: "the split name is referenced from a nested function" };
  }

  // Obligation 4: name hygiene.
  const freeBefore = freeNames(before);
  const declaredBefore = declaredNames(before);
  for (const name of suffixedNames) {
    if (!isSafeIdentifier(name)) return { ok: false, reason: "reserved-word" };
    if (freeBefore.has(name) || declaredBefore.has(name)) return { ok: false, reason: "captures-free-name" };
  }
  const afterDecl = after.find((s): s is Stmt & { k: "decl" } => s.k === "decl")!;
  for (const name of suffixedNames) if (!afterDecl.names.includes(name)) return { ok: false, reason: "the split name is missing from the leading decl" };

  // Obligation 3 — the soundness core: an independent coarse relation R.
  const geo = buildGeometry(before);
  const tryBlockOf = new Map<number, Set<number>>();
  markTryBlocks(before, tryBlockOf);
  const geo2: Geometry = { ...geo, tryBlockOf };

  // Map each original occurrence (by its position in `beforeOccs`) to the
  // name it was given in `after` — the ground truth for "same name" below.
  const nameAt: string[] = afterOccs.map((o) => o.reg);

  for (const reg of splitRegs) {
    const defPositions = defIdxs(before, reg); // includes d0 at -1
    const uses = useIdxs(before, reg);
    // Occurrence-list positions of each def/use, in `before`'s occurrence
    // order, so we can read off `nameAt` for the pair.
    const occIndexOfDef = new Map<number, number[]>(); // stmtIdx -> occurrence positions
    const occIndexOfUse = new Map<number, number[]>();
    for (let i = 0; i < beforeOccs.length; i++) {
      const o = beforeOccs[i]!;
      if (o.reg !== reg) continue;
      const m = o.kind === "def" ? occIndexOfDef : occIndexOfUse;
      let arr = m.get(o.stmtIdx);
      if (arr === undefined) m.set(o.stmtIdx, (arr = []));
      arr.push(i);
    }
    // `d0`'s "name" for the R comparison: web 1 always keeps `reg` (§5), and
    // `d0` — nothing precedes function entry — can only ever be part of
    // web 1, so its ground-truth name is always the plain `reg`.
    const nameOfDef = (dIdx: number): string[] => (dIdx === -1 ? [reg] : (occIndexOfDef.get(dIdx) ?? []).map((i) => nameAt[i]!));
    for (const dIdx of defPositions) {
      const dNames = nameOfDef(dIdx);
      for (const uIdx of uses) {
        const uNames = (occIndexOfUse.get(uIdx) ?? []).map((i) => nameAt[i]!);
        const related = sharesLoop(geo2, dIdx, uIdx) || reachesCatch(geo2, dIdx, uIdx) || reachesSeq(geo2, defPositions, reg, dIdx, uIdx);
        if (!related) continue;
        for (const dn of dNames) for (const un of uNames) if (dn !== un) return { ok: false, reason: "coarse-reach-crosses-split" };
      }
    }
  }

  return { ok: true };
}
