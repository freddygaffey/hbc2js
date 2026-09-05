// reg-split matcher — docs/specs/passes/19-reg-split.md §4.
//
// Site = the function-body root list only (`match` returns `null` unless
// `list === ctx.fnBody`): a register is function-scoped (AGENT-BRIEF), so a
// per-sublist site cannot see every def/use. One `match` call returns every
// register's split in the frame (spec 05 §4's batched convention), computed
// by a forward reaching-defs abstract interpretation over the structured
// statement tree (§4.2).
//
// `transformFrame` below is shared with `rewrite.ts` (D12a: siblings may
// import each other) — it is the ONE traversal that visits every register
// occurrence of a frame in a fixed, deterministic order, skipping nested
// `func` bodies. `match` calls it read-only (its `onOcc` never returns a
// replacement name) to enumerate occurrences and to build the fixpoint
// analysis's per-statement occurrence table; `rewrite` calls the identical
// function with an `onOcc` that *does* return a name, so occurrence #k in
// the enumeration pass and occurrence #k in the rewrite pass are — by
// construction, not by parallel bookkeeping — the same tree position.
import type { Expr, Pattern, PatternElement, Stmt } from "../ast.ts";
import { isRegisterName, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

/** Names declared anywhere in `stmts` (own copy, D12a convention — mirrors
 *  `var-naming`/`fn-naming`'s `declaredNames`): `decl`/`init`/a `func`'s own
 *  name and parameters, or a `catch` binding. Used by the writer's
 *  collision check (§5) and the checker's name-hygiene obligation (§6.4). */
export function declaredNames(stmts: readonly Stmt[]): Set<string> {
  const bound = new Set<string>();
  walk(stmts, {
    expr: (e) => {
      if (e.k === "func") {
        if (e.name !== null) bound.add(e.name);
        for (const param of e.params) bound.add(param.name);
      }
    },
    stmt: (s) => {
      if (s.k === "decl") for (const n of s.names) bound.add(n);
      else if (s.k === "init") bound.add(s.name);
      else if (s.k === "try") bound.add(s.param);
      else if (s.k === "func") {
        bound.add(s.name);
        for (const param of s.params) bound.add(param.name);
      }
    },
  });
  return bound;
}

export type OccKind = "def" | "use";

/** One real occurrence of a register in this frame — everything but the
 *  leading `decl` entry (the virtual def `d0`, §4.1). `strong` is only
 *  meaningful for `kind === "def"`: a statement-level assign/init, or a
 *  `for` header's own top-level init/update term (§4.2's strong kill) vs.
 *  every other def, which is nested inside an expression and therefore a
 *  weak update (§4.2's last bullet — "correctness over precision"). */
export interface Occurrence {
  readonly id: number;
  readonly reg: string;
  readonly kind: OccKind;
  readonly strong: boolean;
  readonly stmtIdx: number;
  readonly part: ForPart;
}

export interface RegSplit {
  readonly reg: string;
  /** Webs in first-occurrence order; web 1 is `webs[0]`. Each web is the
   *  list of occurrence ids in that web, ascending (= first-occurrence
   *  order within the web too, since ids are assigned in tree pre-order). */
  readonly webs: readonly (readonly number[])[];
}

export interface RegSplitSite {
  readonly splits: readonly RegSplit[];
}

export type RegSplitMatch = Match<readonly Stmt[], RegSplitSite>;

// ---------------------------------------------------------------------------
// §4.2 last bullet / §3: registers this rung refuses to touch at all because
// an occurrence of them sits somewhere this analysis does not model — a
// `destructure` pattern's `pid` target. `identUses`/`defUse`/`countUses`
// (framework, `../ast.ts`) do not walk `destructure` either (no case for
// it), so treating a pattern-bound register as split-eligible would let the
// pattern's own reference to it silently go stale under a rename this rung
// cannot see to apply. Conservative fallback (§4.2 last bullet): a register
// with any occurrence under an unmodelled shape gets exactly one web, i.e.
// this rung never touches it, anywhere in the frame.
export function isRegisterId(e: Expr): e is Extract<Expr, { k: "ident" }> {
  return e.k === "ident" && isRegisterName(e.name);
}

// ---------------------------------------------------------------------------
// Statement pre-order indexing — the same scheme `../ast.ts`'s `defUse` uses
// (every statement gets one index, in tree pre-order, `func` bodies never
// entered), computed once as a `Map` keyed by node identity so a loop body
// visited more than once during the §4.2 fixpoint always resolves to the
// same index.
// ---------------------------------------------------------------------------

export function indexStatements(fnBody: readonly Stmt[]): Map<Stmt, number> {
  const out = new Map<Stmt, number>();
  let idx = 0;
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      out.set(s, idx++);
      switch (s.k) {
        case "if":
          visit(s.then);
          visit(s.else);
          break;
        case "while":
        case "do-while":
        case "for":
        case "for-in":
        case "for-of":
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
          break; // func: separate frame; everything else has no child list
      }
    }
  };
  visit(fnBody);
  return out;
}

/** `stmtIdx -> its enclosing-or-self loop idxs` (a `while`/`do-while`/`for`
 *  header counts itself in, per R-loop's "header expressions included") —
 *  used only to pre-coarsen webs to match the checker's R-loop clause; see
 *  the call site in `analyzeFrame`. */
function computeLoopMembership(fnBody: readonly Stmt[]): Map<number, ReadonlySet<number>> {
  const out = new Map<number, ReadonlySet<number>>();
  let idx = 0;
  const visit = (list: readonly Stmt[], loops: ReadonlySet<number>): void => {
    for (const s of list) {
      const myIdx = idx++;
      switch (s.k) {
        case "if":
          out.set(myIdx, loops);
          visit(s.then, loops);
          visit(s.else, loops);
          break;
        case "while":
        case "do-while":
        case "for":
        case "for-in":
        case "for-of": {
          const next = new Set(loops);
          next.add(myIdx);
          out.set(myIdx, next);
          visit(s.body, next);
          break;
        }
        case "labeled":
        case "iife":
          out.set(myIdx, loops);
          visit(s.body, loops);
          break;
        case "try":
          out.set(myIdx, loops);
          visit(s.block, loops);
          visit(s.handler, loops);
          break;
        case "switch":
          out.set(myIdx, loops);
          for (const c of s.cases) visit(c.body, loops);
          break;
        default:
          out.set(myIdx, loops);
          break; // func: separate frame
      }
    }
  };
  visit(fnBody, new Set());
  return out;
}

/** `stmtIdx -> the try idxs whose combined block+handler subtree contains
 *  it` — used only to pre-coarsen webs to match the checker's R-catch
 *  clause (§6 obligation 3: a def anywhere in the try's block, or before
 *  the try, reaches every handler use, kills inside the block notwithstanding),
 *  the same way `computeLoopMembership` pre-coarsens for R-loop. */
function computeTryMembership(fnBody: readonly Stmt[]): Map<number, ReadonlySet<number>> {
  const out = new Map<number, ReadonlySet<number>>();
  let idx = 0;
  const visit = (list: readonly Stmt[], tries: ReadonlySet<number>): void => {
    for (const s of list) {
      const myIdx = idx++;
      out.set(myIdx, tries);
      switch (s.k) {
        case "if":
          visit(s.then, tries);
          visit(s.else, tries);
          break;
        case "while":
        case "do-while":
        case "for":
        case "for-in":
        case "for-of":
        case "labeled":
        case "iife":
          visit(s.body, tries);
          break;
        case "try": {
          const next = new Set(tries);
          next.add(myIdx);
          visit(s.block, next);
          visit(s.handler, next);
          break;
        }
        case "switch":
          for (const c of s.cases) visit(c.body, tries);
          break;
        default:
          break; // func: separate frame
      }
    }
  };
  visit(fnBody, new Set());
  return out;
}

// ---------------------------------------------------------------------------
// The shared occurrence traversal (enumeration when `rewrite` returns
// `undefined` always, renaming otherwise).
// ---------------------------------------------------------------------------

/** `onOcc`'s `strong` argument is only informative for `kind === "def"`. A
 *  `destructure` pattern's `pid` register is reported as `kind: "use"` with
 *  `pattern: true` — folded into the analysis as a use that neither kills
 *  nor is ever renamed (see `isRegisterId` doc above): the caller is
 *  responsible for excluding any such register from its own output. */
/** Which field of a `for` header an occurrence's top-level position is in —
 *  `null` everywhere else. `init`/`test`/`update` share one statement idx
 *  (defUse's convention), so the analysis needs this to know *when within
 *  that one idx* an occurrence actually happens (§4.2: init once, then
 *  repeatedly test, body, update). */
export type ForPart = "init" | "test" | "update" | null;

export type OnOcc = (reg: string, kind: OccKind, strong: boolean, stmtIdx: number, pattern: boolean, part: ForPart) => string | undefined;

function walkExpr(e: Expr, onOcc: (reg: string, kind: OccKind, strong: boolean, pattern: boolean) => string | undefined, top: boolean): Expr {
  switch (e.k) {
    case "ident": {
      if (!isRegisterName(e.name)) return e;
      const to = onOcc(e.name, "use", false, false);
      return to === undefined ? e : { ...e, name: to };
    }
    case "assign": {
      if (e.target.k === "ident" && isRegisterName(e.target.name)) {
        const value = walkExpr(e.value, onOcc, false);
        const to = onOcc(e.target.name, "def", top, false);
        const target = to === undefined ? e.target : { ...e.target, name: to };
        return target === e.target && value === e.value ? e : { ...e, target, value };
      }
      const target = walkExpr(e.target, onOcc, false);
      const value = walkExpr(e.value, onOcc, false);
      return target === e.target && value === e.value ? e : { ...e, target, value };
    }
    case "member":
    case "optmember": {
      const obj = walkExpr(e.obj, onOcc, false);
      const prop = e.computed ? walkExpr(e.prop, onOcc, false) : e.prop;
      return obj === e.obj && prop === e.prop ? e : { ...e, obj, prop };
    }
    case "call":
    case "optcall":
    case "new": {
      const callee = walkExpr(e.callee, onOcc, false);
      const args = e.args.map((a) => walkExpr(a, onOcc, false));
      return callee === e.callee && args.every((a, i) => a === e.args[i]) ? e : { ...e, callee, args };
    }
    case "bin":
    case "logical": {
      const left = walkExpr(e.left, onOcc, false);
      const right = walkExpr(e.right, onOcc, false);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    case "unary": {
      const arg = walkExpr(e.arg, onOcc, false);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "cond": {
      const test = walkExpr(e.test, onOcc, false);
      const then = walkExpr(e.then, onOcc, false);
      const els = walkExpr(e.else, onOcc, false);
      return test === e.test && then === e.then && els === e.else ? e : { ...e, test, then, else: els };
    }
    case "array": {
      const elements = e.elements.map((x) => walkExpr(x, onOcc, false));
      return elements.every((x, i) => x === e.elements[i]) ? e : { ...e, elements };
    }
    case "object": {
      let changed = false;
      const props = e.props.map((p) => {
        if ("k" in p) {
          const arg = walkExpr(p.arg, onOcc, false);
          if (arg !== p.arg) changed = true;
          return arg === p.arg ? p : { ...p, arg };
        }
        const value = walkExpr(p.value, onOcc, false);
        if (value !== p.value) changed = true;
        return value === p.value ? p : { ...p, value };
      });
      return changed ? { ...e, props } : e;
    }
    case "spread": {
      const arg = walkExpr(e.arg, onOcc, false);
      return arg === e.arg ? e : { ...e, arg };
    }
    case "seq": {
      const exprs = e.exprs.map((x) => walkExpr(x, onOcc, false));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    case "template": {
      const exprs = e.exprs.map((x) => walkExpr(x, onOcc, false));
      return exprs.every((x, i) => x === e.exprs[i]) ? e : { ...e, exprs };
    }
    case "tagged": {
      const tag = walkExpr(e.tag, onOcc, false);
      const quasi = walkExpr(e.quasi, onOcc, false);
      return tag === e.tag && quasi === e.quasi ? e : { ...e, tag, quasi };
    }
    case "destructure": {
      const source = walkExpr(e.source, onOcc, false);
      const pattern = walkPattern(e.pattern, onOcc);
      return source === e.source && pattern === e.pattern ? e : { ...e, source, pattern };
    }
    default:
      return e; // lit, this, argumentsObject, func (separate frame — never recurse), jsx (not yet present)
  }
}

function walkPattern(pat: Pattern, onOcc: (reg: string, kind: OccKind, strong: boolean, pattern: boolean) => string | undefined): Pattern {
  switch (pat.k) {
    case "pid": {
      if (!isRegisterName(pat.name)) return pat;
      const to = onOcc(pat.name, "use", false, true);
      return to === undefined ? pat : { ...pat, name: to };
    }
    case "parr": {
      const elements = pat.elements.map((el) => walkPatternElement(el, onOcc));
      return elements.every((el, i) => el === pat.elements[i]) ? pat : { ...pat, elements };
    }
    case "pobj": {
      const props = pat.props.map((prop) => {
        const value = walkPatternElement(prop.value, onOcc);
        return value === prop.value ? prop : { ...prop, value };
      });
      return props.every((p, i) => p === pat.props[i]) ? pat : { ...pat, props };
    }
  }
}

function walkPatternElement(el: PatternElement, onOcc: (reg: string, kind: OccKind, strong: boolean, pattern: boolean) => string | undefined): PatternElement {
  if (el.k === "hole") return el;
  const target = walkPattern(el.target, onOcc);
  if (el.k === "prest") return target === el.target ? el : { ...el, target };
  const init = el.init === undefined ? undefined : walkExpr(el.init, onOcc, false);
  if (target === el.target && init === el.init) return el;
  return init === undefined ? { k: "pel", target } : { k: "pel", target, init };
}

function transformStmtExprs(s: Stmt, onOccFull: (reg: string, kind: OccKind, strong: boolean, pattern: boolean, part: ForPart) => string | undefined): Stmt {
  // Every non-`for` case reports `part: null` — only a `for` header's own
  // three fields distinguish `init`/`test`/`update` (see `ForPart`'s doc).
  const wrap = (part: ForPart) => (reg: string, kind: OccKind, strong: boolean, pattern: boolean): string | undefined => onOccFull(reg, kind, strong, pattern, part);
  const onOcc = wrap(null);
  switch (s.k) {
    case "expr": {
      const expr = walkExpr(s.expr, onOcc, true);
      return expr === s.expr ? s : { ...s, expr };
    }
    case "init": {
      const value = walkExpr(s.value, onOcc, false);
      let name = s.name;
      if (isRegisterName(s.name)) {
        const to = onOcc(s.name, "def", true, false);
        if (to !== undefined) name = to;
      }
      return name === s.name && value === s.value ? s : { ...s, name, value };
    }
    case "if": {
      const test = walkExpr(s.test, onOcc, false);
      return test === s.test ? s : { ...s, test };
    }
    case "while": {
      if (s.test === undefined) return s;
      const test = walkExpr(s.test, onOcc, false);
      return test === s.test ? s : { ...s, test };
    }
    case "do-while": {
      const test = walkExpr(s.test, onOcc, false);
      return test === s.test ? s : { ...s, test };
    }
    case "for": {
      const init = s.init === null ? null : walkExpr(s.init, wrap("init"), true);
      const test = walkExpr(s.test, wrap("test"), false);
      const update = s.update === null ? null : walkExpr(s.update, wrap("update"), true);
      return init === s.init && test === s.test && update === s.update ? s : { ...s, init, test, update };
    }
    case "for-in":
    case "for-of": {
      // `left` is the loop's own binding — a strong def, same treatment as
      // `init`'s name, not a use of whatever the register held before.
      let left = s.left;
      if (left.k === "ident" && isRegisterName(left.name)) {
        const to = onOcc(left.name, "def", true, false);
        if (to !== undefined) left = { ...left, name: to };
      } else {
        left = walkExpr(left, onOcc, false);
      }
      const right = walkExpr(s.right, onOcc, false);
      return left === s.left && right === s.right ? s : { ...s, left, right };
    }
    case "return": {
      if (s.arg === null) return s;
      const arg = walkExpr(s.arg, onOcc, false);
      return arg === s.arg ? s : { ...s, arg };
    }
    case "throw": {
      const arg = walkExpr(s.arg, onOcc, false);
      return arg === s.arg ? s : { ...s, arg };
    }
    case "switch": {
      const disc = walkExpr(s.disc, onOcc, false);
      const cases = s.cases.map((c) => {
        const test = c.test === null ? null : walkExpr(c.test, onOcc, false);
        return test === c.test ? c : { ...c, test };
      });
      const changed = disc !== s.disc || cases.some((c, i) => c !== s.cases[i]);
      return changed ? { ...s, disc, cases } : s;
    }
    default:
      return s; // decl (handled by rewrite separately), labeled/try/iife/break/continue/directive/comment/raw/func
  }
}

/** The one traversal §4 and §5 share: visits every register occurrence in
 *  `fnBody` (never a nested `func`) in a fixed pre-order, and — when
 *  `onOcc` returns a name — rebuilds that occurrence in place. Called
 *  read-only (every `onOcc` call returns `undefined`) to enumerate; called
 *  with a real rename function to rewrite. `stmtIndex` must be
 *  `indexStatements(fnBody)` (or an equivalent built the same way) so a
 *  statement's `stmtIdx` is stable across every call. */
export function transformFrame(fnBody: readonly Stmt[], stmtIndex: ReadonlyMap<Stmt, number>, onOcc: OnOcc): readonly Stmt[] {
  const visitList = (list: readonly Stmt[]): readonly Stmt[] => {
    let changed = false;
    const out = list.map((s) => {
      const r = visitStmt(s);
      if (r !== s) changed = true;
      return r;
    });
    return changed ? out : list;
  };
  const visitStmt = (s: Stmt): Stmt => {
    const idx = stmtIndex.get(s);
    if (idx === undefined) throw new Error("reg-split: statement missing from stmtIndex (transformFrame/indexStatements disagree)");
    const local = (reg: string, kind: OccKind, strong: boolean, pattern: boolean, part: ForPart): string | undefined => onOcc(reg, kind, strong, idx, pattern, part);
    let next = transformStmtExprs(s, local);
    switch (next.k) {
      case "if": {
        const then = visitList(next.then);
        const els = visitList(next.else);
        if (then !== next.then || els !== next.else) next = { ...next, then, else: els };
        break;
      }
      case "while":
      case "do-while":
      case "for":
      case "for-in":
      case "for-of":
      case "labeled":
      case "iife": {
        const body = visitList(next.body);
        if (body !== next.body) next = { ...next, body };
        break;
      }
      case "try": {
        const block = visitList(next.block);
        const handler = visitList(next.handler);
        if (block !== next.block || handler !== next.handler) next = { ...next, block, handler };
        break;
      }
      case "switch": {
        let anyChanged = false;
        const cases = next.cases.map((c) => {
          const body = visitList(c.body);
          if (body !== c.body) anyChanged = true;
          return body === c.body ? c : { ...c, body };
        });
        if (anyChanged) next = { ...next, cases };
        break;
      }
      default:
        break; // decl, break, continue, return, throw, directive, comment, raw, func
    }
    return next;
  };
  return visitList(fnBody);
}

// ---------------------------------------------------------------------------
// §4.2 — forward reaching-defs abstract interpretation.
// ---------------------------------------------------------------------------

/** Per register, the set of def-occurrence ids (real ids >= 0, or a
 *  register's synthetic `d0` id < 0) that may currently be "the last
 *  write". Absent/empty for a register means "only `d0` reaches here". */
type FlowState = Map<string, Set<number>>;

const FIXPOINT_CAP = 24;

class UnionFind {
  private readonly parent = new Map<number, number>();
  find(x: number): number {
    let r = this.parent.get(x);
    if (r === undefined) {
      this.parent.set(x, x);
      return x;
    }
    if (r !== x) {
      r = this.find(r);
      this.parent.set(x, r);
    }
    return r;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

interface LoopCtx {
  readonly label: string | null;
  readonly continueContribs: FlowState[];
  readonly breakContribs: FlowState[];
}

function cloneState(s: FlowState): FlowState {
  const out: FlowState = new Map();
  for (const [k, v] of s) out.set(k, new Set(v));
  return out;
}

function unionInto(target: FlowState, from: FlowState): void {
  for (const [reg, defs] of from) {
    let cur = target.get(reg);
    if (cur === undefined) {
      cur = new Set<number>();
      target.set(reg, cur);
    }
    for (const d of defs) cur.add(d);
  }
}

function unionMany(states: readonly FlowState[]): FlowState {
  const out: FlowState = new Map();
  for (const s of states) unionInto(out, s);
  return out;
}

function stateEqual(a: FlowState, b: FlowState): boolean {
  const regs = new Set([...a.keys(), ...b.keys()]);
  for (const r of regs) {
    const sa = a.get(r) ?? new Set<number>();
    const sb = b.get(r) ?? new Set<number>();
    if (sa.size !== sb.size) return false;
    for (const x of sa) if (!sb.has(x)) return false;
  }
  return true;
}

/** Every register with >= 2 webs, computed over `fnBody`. `null` when no
 *  register qualifies (the common case, per §4). */
export function analyzeFrame(fnBody: readonly Stmt[]): RegSplitSite | null {
  const stmtIndex = indexStatements(fnBody);

  // Pass 1: enumerate occurrences (read-only — `onOcc` never renames), one
  // global id per occurrence in tree pre-order, grouped by statement so the
  // fixpoint walk below (pass 2) never re-derives an id, only re-consumes
  // the ones already assigned — a loop body visited more than once during
  // the fixpoint sees the same occurrence objects every time.
  let nextId = 0;
  const occurrences: Occurrence[] = [];
  const byStmt = new Map<number, Occurrence[]>();
  const patternRegs = new Set<string>();
  transformFrame(fnBody, stmtIndex, (reg, kind, strong, stmtIdx, pattern, part) => {
    const occ: Occurrence = { id: nextId++, reg, kind, strong: kind === "def" && strong, stmtIdx, part };
    occurrences.push(occ);
    let arr = byStmt.get(stmtIdx);
    if (arr === undefined) byStmt.set(stmtIdx, (arr = []));
    arr.push(occ);
    if (pattern) patternRegs.add(reg);
    return undefined;
  });
  if (occurrences.length === 0) return null;

  const allRegs = new Set(occurrences.map((o) => o.reg));
  const uf = new UnionFind();
  for (const o of occurrences) uf.find(o.id); // register every real id
  const d0Ids = new Map<string, number>();
  let nextSynthetic = -1;
  const d0For = (reg: string): number => {
    let id = d0Ids.get(reg);
    if (id === undefined) {
      id = nextSynthetic--;
      d0Ids.set(reg, id);
      uf.find(id);
    }
    return id;
  };

  const useOf = (state: FlowState, reg: string, occId: number): void => {
    const set = state.get(reg);
    const from = set === undefined || set.size === 0 ? [d0For(reg)] : [...set];
    for (const d of from) uf.union(d, occId);
  };
  const strongDefOf = (state: FlowState, reg: string, occId: number): void => {
    state.set(reg, new Set([occId]));
  };
  const weakDefOf = (state: FlowState, reg: string, occId: number): void => {
    const set = state.get(reg);
    const next = set === undefined ? new Set([d0For(reg)]) : new Set(set);
    next.add(occId);
    state.set(reg, next);
  };

  const loopStack: LoopCtx[] = [];
  const tryAccums: FlowState[][] = [];

  // `part` restricts processing to one field of a `for` header sharing this
  // `stmtIdx` (§4.2: `init` once, then `test`/body/`update` repeatedly —
  // three different moments in time, one statement index). `"any"` (every
  // non-`for` statement kind) processes every occurrence recorded here.
  const processOccs = (state: FlowState, stmtIdx: number, part: ForPart | "any" = "any"): void => {
    const occs = byStmt.get(stmtIdx);
    if (occs === undefined) return;
    for (const o of occs) {
      if (part !== "any" && o.part !== part) continue;
      if (o.kind === "use") useOf(state, o.reg, o.id);
      else if (o.strong) strongDefOf(state, o.reg, o.id);
      else weakDefOf(state, o.reg, o.id);
    }
  };
  const observe = (state: FlowState): void => {
    if (tryAccums.length === 0) return;
    const snap = cloneState(state);
    for (const acc of tryAccums) acc.push(snap);
  };

  const walkList = (state: FlowState, list: readonly Stmt[]): FlowState => {
    let s = state;
    for (const stmt of list) {
      const idx = stmtIndex.get(stmt)!;
      switch (stmt.k) {
        case "if": {
          processOccs(s, idx);
          observe(s);
          const thenExit = walkList(cloneState(s), stmt.then);
          const elseExit = walkList(cloneState(s), stmt.else);
          s = unionMany([thenExit, elseExit]);
          break;
        }
        case "while": {
          // `while` has no `init`/`update` fields — its `test` shares no
          // idx with anything else, so "any" occurrence at this idx is its
          // test (`observe`d here only for the pre-loop entry snapshot;
          // the test itself is (re)processed inside `loopFixpoint`).
          observe(s);
          s = loopFixpoint(s, false, stmt.test !== undefined, idx, stmt.body, undefined, "any", "any", stmt.label);
          break;
        }
        case "do-while": {
          s = loopFixpoint(s, true, true, idx, stmt.body, undefined, "any", "any", stmt.label);
          break;
        }
        case "for": {
          // `init` runs once, here, strictly before the loop is ever
          // entered; `test`/`update` are separate moments in time sharing
          // this same idx (defUse's convention) and are (re)processed once
          // per fixpoint iteration inside `loopFixpoint`, never here.
          processOccs(s, idx, "init");
          observe(s);
          s = loopFixpoint(s, false, true, idx, stmt.body, idx, "test", "update", stmt.label);
          break;
        }
        case "for-in":
        case "for-of": {
          // The binding (`left`) is written fresh every iteration — same
          // per-iteration re-evaluation as a `while`'s test, so it belongs
          // inside `loopFixpoint`, not processed once here.
          observe(s);
          s = loopFixpoint(s, false, true, idx, stmt.body, undefined, "any", "any", stmt.label);
          break;
        }
        case "labeled": {
          const ctx: LoopCtx = { label: stmt.label, continueContribs: [], breakContribs: [] };
          loopStack.push(ctx);
          const bodyExit = walkList(cloneState(s), stmt.body);
          loopStack.pop();
          s = unionMany([bodyExit, ...ctx.breakContribs, ...ctx.continueContribs]);
          break;
        }
        case "break": {
          const ctx = findLoopCtx(loopStack, stmt.label);
          if (ctx !== undefined) ctx.breakContribs.push(cloneState(s));
          observe(s);
          s = new Map(); // unreachable fall-through
          break;
        }
        case "continue": {
          const ctx = findLoopCtx(loopStack, stmt.label);
          if (ctx !== undefined) ctx.continueContribs.push(cloneState(s));
          observe(s);
          s = new Map();
          break;
        }
        case "return":
          processOccs(s, idx);
          observe(s);
          s = new Map();
          break;
        case "throw":
          processOccs(s, idx);
          observe(s);
          s = new Map();
          break;
        case "try": {
          const accum: FlowState[] = [cloneState(s)];
          tryAccums.push(accum);
          const blockExit = walkList(cloneState(s), stmt.block);
          tryAccums.pop();
          const anyB = unionMany(accum);
          const handlerExit = walkList(anyB, stmt.handler);
          s = unionMany([blockExit, handlerExit]);
          break;
        }
        case "switch": {
          processOccs(s, idx);
          observe(s);
          const ctx: LoopCtx = { label: null, continueContribs: [], breakContribs: [] };
          loopStack.push(ctx);
          let armState = cloneState(s);
          const exits: FlowState[] = [];
          for (const c of stmt.cases) {
            armState = walkList(armState, c.body);
          }
          exits.push(armState); // fall off the last arm
          loopStack.pop();
          s = unionMany([...exits, ...ctx.breakContribs]);
          break;
        }
        case "iife": {
          s = walkList(cloneState(s), stmt.body);
          break;
        }
        default:
          processOccs(s, idx);
          observe(s);
          break; // decl, directive, comment, raw, func (occs none for these)
      }
    }
    return s;
  };

  function loopFixpoint(preState: FlowState, bodyFirst: boolean, hasTest: boolean, headerIdx: number, body: readonly Stmt[], updateIdx: number | undefined, testPart: ForPart | "any", updatePart: ForPart | "any", label: string | null): FlowState {
    const ctx: LoopCtx = { label, continueContribs: [], breakContribs: [] };
    loopStack.push(ctx);
    let entry = preState;
    let prevIter: FlowState | null = null;
    for (let i = 0; i < FIXPOINT_CAP; i++) {
      let cur = cloneState(entry);
      if (!bodyFirst && hasTest) processOccs(cur, headerIdx, testPart); // test-first (while/for)
      const bodyExit = walkList(cur, body);
      let afterBody = unionMany([bodyExit, ...ctx.continueContribs]);
      if (updateIdx !== undefined) processOccs(afterBody, updateIdx, updatePart); // for's update
      let iterExit = afterBody;
      if (bodyFirst && hasTest) {
        iterExit = cloneState(afterBody);
        processOccs(iterExit, headerIdx, testPart); // do-while: test after body
      }
      if (prevIter !== null && stateEqual(iterExit, prevIter)) {
        prevIter = iterExit;
        break;
      }
      prevIter = iterExit;
      entry = unionMany([preState, iterExit]);
    }
    loopStack.pop();
    const exit = unionMany([preState, prevIter ?? preState, ...ctx.breakContribs]);
    return exit;
  }

  walkList(new Map(), fnBody);

  // Coarsen to match the checker's independent R-loop clause (§6 obligation
  // 3): "no kill reasoning inside a loop at all — the back edge makes
  // everything in the loop mutually reachable, coarsely". The precise
  // fixpoint above can (correctly, precisely) find two occurrences of one
  // register inside the same loop to be genuinely disjoint webs — R-loop
  // does not accept that distinction. Pre-merging here means this rung
  // never proposes, and never wastes a whole-frame match+abandon cycle on,
  // a split the checker would refuse for this reason.
  // One grouping pass over `occurrences` (not one per register — P-1,
  // docs/PUSHBACK.md: a per-register scan of the whole occurrence list is
  // O(registers x occurrences) and was measured to blow the pipeline-speed
  // ceiling on a real bundle).
  const occByReg = new Map<string, Occurrence[]>();
  for (const o of occurrences) {
    let arr = occByReg.get(o.reg);
    if (arr === undefined) occByReg.set(o.reg, (arr = []));
    arr.push(o);
  }

  const loopMembership = computeLoopMembership(fnBody);
  for (const reg of allRegs) {
    const byLoop = new Map<number, number[]>();
    for (const o of occByReg.get(reg) ?? []) {
      for (const l of loopMembership.get(o.stmtIdx) ?? []) {
        let arr = byLoop.get(l);
        if (arr === undefined) byLoop.set(l, (arr = []));
        arr.push(o.id);
      }
    }
    for (const ids of byLoop.values()) for (let i = 1; i < ids.length; i++) uf.union(ids[0]!, ids[i]!);
  }

  // Same pre-coarsening for R-catch (see `computeTryMembership`'s doc): for
  // every try, at *every* register, merge every occurrence inside its
  // block+handler subtree together AND with every occurrence anywhere
  // *before* the try (any idx < the try's own idx, matching the checker's
  // R-catch, which is exactly as coarse — "before the try at any depth").
  //
  // P-11a: this used to be one `tryIdxs` walk *per register* (an outer
  // `for (const reg of allRegs)`), so a function with many registers and
  // many `try`s paid `O(regs x tries)` even when almost every (register,
  // try) pair had nothing to do with each other — the measured pipeline-
  // speed bottleneck (docs/PUSHBACK.md P-11: 13.6x, over the 12x ceiling).
  // Replaced with one global merge-scan: `occurrences` is already in tree
  // pre-order == ascending `stmtIdx` order (`Occurrence.id`'s doc), so a
  // single pointer sweep interleaved with the sorted `tryIdxs` list visits
  // every (occurrence, enclosing/preceding try) relationship exactly once,
  // in `O(occurrences + tries + occurrence-try-membership pairs)` total —
  // no per-register multiplier. `beforeRep` plays the role the old `before`
  // accumulator played per register (the running "everything of this
  // register seen so far" union-find anchor), just shared across all
  // registers in one pass instead of rebuilt per register.
  const tryMembership = computeTryMembership(fnBody);
  const tryIdxs = [...new Set([...tryMembership.values()].flatMap((s) => [...s]))].sort((a, b) => a - b);
  if (tryIdxs.length > 0) {
    const withinByTry = new Map<number, Map<string, number[]>>();
    for (const o of occurrences) {
      for (const t of tryMembership.get(o.stmtIdx) ?? []) {
        let byReg = withinByTry.get(t);
        if (byReg === undefined) withinByTry.set(t, (byReg = new Map()));
        let arr = byReg.get(o.reg);
        if (arr === undefined) byReg.set(o.reg, (arr = []));
        arr.push(o.id);
      }
    }
    const beforeRep = new Map<string, number>();
    let occPtr = 0;
    for (const tIdx of tryIdxs) {
      while (occPtr < occurrences.length && occurrences[occPtr]!.stmtIdx < tIdx) {
        const o = occurrences[occPtr++]!;
        const rep = beforeRep.get(o.reg);
        if (rep === undefined) beforeRep.set(o.reg, o.id);
        else uf.union(rep, o.id);
      }
      const byReg = withinByTry.get(tIdx);
      if (byReg !== undefined) {
        for (const [reg, ids] of byReg) {
          for (let i = 1; i < ids.length; i++) uf.union(ids[0]!, ids[i]!);
          const rep = beforeRep.get(reg);
          if (rep !== undefined) uf.union(rep, ids[0]!);
          else beforeRep.set(reg, ids[0]!);
        }
      }
    }
  }

  // Collect webs per register from the union-find, ordered by first
  // occurrence. `patternRegs` registers are dropped entirely (conservative
  // fallback, see `isRegisterId`'s doc): every occurrence keeps its plain
  // name, everywhere, not just at the pattern site.
  const groups = new Map<string, Map<number, number[]>>(); // reg -> root -> occIds
  for (const o of occurrences) {
    if (patternRegs.has(o.reg)) continue;
    const root = uf.find(o.id);
    let byReg = groups.get(o.reg);
    if (byReg === undefined) groups.set(o.reg, (byReg = new Map()));
    let arr = byReg.get(root);
    if (arr === undefined) byReg.set(root, (arr = []));
    arr.push(o.id);
  }

  const splits: RegSplit[] = [];
  for (const reg of allRegs) {
    if (patternRegs.has(reg)) continue;
    const byReg = groups.get(reg);
    if (byReg === undefined) continue;
    const webs = [...byReg.values()].map((ids) => ids.slice().sort((a, b) => a - b));
    webs.sort((a, b) => a[0]! - b[0]!);
    if (webs.length >= 2) splits.push({ reg, webs });
  }
  splits.sort((a, b) => a.webs[0]![0]! - b.webs[0]![0]!);
  return splits.length === 0 ? null : { splits };
}

function findLoopCtx(stack: readonly LoopCtx[], label: string | null): LoopCtx | undefined {
  if (label === null) return stack.length === 0 ? undefined : stack[stack.length - 1];
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.label === label) return stack[i];
  return stack.length === 0 ? undefined : stack[stack.length - 1];
}

export function match(list: readonly Stmt[], ctx: PassContext): RegSplitMatch | null {
  if (list !== ctx.fnBody) return null;
  const site = analyzeFrame(list);
  if (site === null) return null;
  const decl = list.findIndex((s) => s.k === "decl");
  return { root: list, nodes: [list], data: site, at: { functionIndex: ctx.functionIndex, offset: decl < 0 ? 0 : decl } };
}
