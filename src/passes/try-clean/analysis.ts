// try-clean's shared analysis — spec 22 §4.2/§5/§6.2. Everything `match`,
// `rewrite` and `check` need, in one place so the three can never drift:
// `match` calls `analyze`, records its result as `Match.data`, `rewrite`
// applies it, `check` re-derives it from `before` (via `match` again, the
// same discipline `for-header/check.ts` uses) rather than trusting the
// Match it is handed.
import type { Expr, Stmt } from "../ast.ts";
import { identUses } from "../ast.ts";

export type TryStmt = Extract<Stmt, { readonly k: "try" }>;
export type ForStmt = Extract<Stmt, { readonly k: "for" }>;
export type ExprStmt = Extract<Stmt, { readonly k: "expr" }>;

export type PcSite =
  | { readonly kind: "stmt"; readonly stmt: ExprStmt }
  | { readonly kind: "for"; readonly forStmt: ForStmt; readonly slot: "init" | "update"; readonly expr: Expr; readonly sole: boolean };

export interface TryInfo {
  readonly node: TryStmt;
  readonly guard: { readonly lo: number; readonly hi: number } | null;
  /** The `__exc = <param>` statement found at (or after the guard in)
   *  `node.handler`, or `null` when `node.param` is already `null` (nothing
   *  for this rung to check or delete) or the C3 shape is missing. */
  readonly excCopyStmt: ExprStmt | null;
  /** `false` only when `node.param !== null` and no valid copy was found —
   *  the C3 refusal. A `param === null` try is vacuously fine. */
  readonly c3ok: boolean;
}

export interface Analysis {
  readonly ok: boolean;
  readonly reason?: string;
  readonly tries: readonly TryInfo[];
  readonly deadPcStmts: readonly ExprStmt[];
  readonly deadForExprs: readonly Expr[];
  readonly deadExcCopies: readonly ExprStmt[];
  readonly pcFrame: Stmt | null;
  readonly excFrame: Stmt | null;
  readonly nullifyTries: readonly TryStmt[];
}

function isIdent(e: Expr, name: string): boolean {
  return e.k === "ident" && e.name === name;
}

function litNumber(e: Expr): number | null {
  if (e.k !== "lit") return null;
  const n = Number(e.text);
  return Number.isFinite(n) ? n : null;
}

export function isPcStoreExpr(e: Expr): boolean {
  return e.k === "assign" && e.target.k === "ident" && e.target.name === "__pc" && e.value.k === "lit";
}

function isPcStoreStmt(s: Stmt): s is ExprStmt {
  return s.k === "expr" && isPcStoreExpr(s.expr);
}

function isExcCopyOf(s: Stmt, param: string): s is ExprStmt {
  return s.k === "expr" && s.expr.k === "assign" && isIdent(s.expr.target, "__exc") && isIdent(s.expr.value, param);
}

/** The emitter's range guard: `if (!(__pc >= lo && __pc <= hi)) { throw p; } `
 *  with an empty `else` — spec 22 §2 S3. */
function guardRange(s: Stmt): { readonly lo: number; readonly hi: number } | null {
  if (s.k !== "if") return null;
  if (s.test.k !== "unary" || s.test.op !== "!") return null;
  const inner = s.test.arg;
  if (inner.k !== "logical" || inner.op !== "&&") return null;
  if (inner.left.k !== "bin" || inner.left.op !== ">=" || !isIdent(inner.left.left, "__pc")) return null;
  if (inner.right.k !== "bin" || inner.right.op !== "<=" || !isIdent(inner.right.left, "__pc")) return null;
  const lo = litNumber(inner.left.right);
  const hi = litNumber(inner.right.right);
  if (lo === null || hi === null) return null;
  if (s.then.length !== 1 || s.then[0]!.k !== "throw" || s.then[0]!.arg.k !== "ident") return null;
  if (s.else.length !== 0) return null;
  return { lo, hi };
}

function analyzeTry(node: TryStmt): TryInfo {
  const h = node.handler;
  let idx = 0;
  let guard: { lo: number; hi: number } | null = null;
  const g = h[0];
  if (g !== undefined) {
    const r = guardRange(g);
    if (r !== null) {
      guard = r;
      idx = 1;
    }
  }
  if (node.param === null) return { node, guard, excCopyStmt: null, c3ok: true };
  const copy = h[idx];
  const ok = copy !== undefined && isExcCopyOf(copy, node.param);
  return { node, guard, excCopyStmt: ok ? (copy as ExprStmt) : null, c3ok: ok };
}

/** Every `try` node reachable from `stmts`, at any depth, never crossing a
 *  `func` boundary (a nested function is a separate frame — C1 already
 *  refuses if it captures `__pc`/`__exc`). */
export function collectAllTries(stmts: readonly Stmt[]): TryStmt[] {
  const out: TryStmt[] = [];
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if (s.k === "try") {
        out.push(s);
        visit(s.block);
        visit(s.handler);
        continue;
      }
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
        case "switch":
          for (const c of s.cases) visit(c.body);
          break;
        default:
          break; // func: separate frame; decl/init/expr/etc: leaves
      }
    }
  };
  visit(stmts);
  return out;
}

/** Every `__pc` store site reachable from `stmts`, at any depth (never
 *  crossing a `func` boundary): a plain `__pc = n;` statement, or one
 *  element of a `for` init/update slot (bare, or inside a comma `seq`). */
export function collectPcSites(stmts: readonly Stmt[]): PcSite[] {
  const out: PcSite[] = [];
  const visit = (list: readonly Stmt[]): void => {
    for (const s of list) {
      if (isPcStoreStmt(s)) out.push({ kind: "stmt", stmt: s });
      switch (s.k) {
        case "if":
          visit(s.then);
          visit(s.else);
          break;
        case "while":
        case "do-while":
        case "labeled":
        case "iife":
          visit(s.body);
          break;
        case "for": {
          for (const slot of ["init", "update"] as const) {
            const e = s[slot];
            if (e === null) continue;
            if (e.k === "seq") {
              if (e.exprs.length <= 1) {
                if (e.exprs.length === 1 && isPcStoreExpr(e.exprs[0]!)) out.push({ kind: "for", forStmt: s, slot, expr: e.exprs[0]!, sole: true });
              } else {
                for (const el of e.exprs) if (isPcStoreExpr(el)) out.push({ kind: "for", forStmt: s, slot, expr: el, sole: false });
              }
            } else if (isPcStoreExpr(e)) {
              out.push({ kind: "for", forStmt: s, slot, expr: e, sole: true });
            }
          }
          visit(s.body);
          break;
        }
        case "try":
          visit(s.block);
          visit(s.handler);
          break;
        case "switch":
          for (const c of s.cases) visit(c.body);
          break;
        default:
          break;
      }
    }
  };
  visit(stmts);
  return out;
}

/** C4: the first statement of `block` is a `__pc` store, or a nested `try`
 *  whose own `block` recursively satisfies C4. Exported so `check.ts` can
 *  re-derive C4 independently from `before` (obligation 3, spec 22 §6.2). */
export function hasEntryStore(block: readonly Stmt[]): boolean {
  const first = block[0];
  if (first === undefined) return false;
  if (isPcStoreStmt(first)) return true;
  if (first.k === "try") return hasEntryStore(first.block);
  return false;
}

/** §4.2's `__exc` read attribution: for every read of `__exc` in the whole
 *  function, the innermost enclosing `try`'s handler it sits in (or "open"
 *  when no handler encloses it). Computed by attributing `identUses`'s
 *  whole-subtree read count to each handler and subtracting every nested
 *  handler's own total — the reads left over at `T` are exactly the ones
 *  that are not also inside some handler nested inside `T.handler`. */
function excAttribution(list: readonly Stmt[], tries: readonly TryInfo[]): { readonly openReads: number; readonly ownReads: ReadonlyMap<TryStmt, number> } {
  const totalFn = identUses(list, "__exc").reads;
  const ownReads = new Map<TryStmt, number>();
  let sumOwn = 0;
  for (const info of tries) {
    const total = identUses(info.node.handler, "__exc").reads;
    let nestedTotal = 0;
    for (const other of collectAllTries(info.node.handler)) nestedTotal += identUses(other.handler, "__exc").reads;
    const own = total - nestedTotal;
    ownReads.set(info.node, own);
    sumOwn += own;
  }
  return { openReads: totalFn - sumOwn, ownReads };
}

/** The whole-function analysis, spec 22 §4.2. `null` (via `.ok === false`)
 *  for every C1-C3 whole-function refusal and for "nothing-dead" (PL-08's
 *  fixed point). C4's per-function refusal ("no __pc store may be deleted
 *  in this function") is not a whole-function refusal by itself — the
 *  `__exc` deletions below still apply, per spec 22 §4.2. */
export function analyze(list: readonly Stmt[]): Analysis {
  const empty: Analysis = { ok: false, tries: [], deadPcStmts: [], deadForExprs: [], deadExcCopies: [], pcFrame: null, excFrame: null, nullifyTries: [] };

  // C1: no nested function captures `__pc`/`__exc`.
  if (identUses(list, "__pc").nested !== 0 || identUses(list, "__exc").nested !== 0) return { ...empty, reason: "nested-capture" };

  const tries = collectAllTries(list).map(analyzeTry);

  // C3: every try's handler starts (after the optional guard) with its own copy.
  if (!tries.every((t) => t.c3ok)) return { ...empty, reason: "handler-prologue-shape" };

  const guardedTries = tries.filter((t): t is TryInfo & { guard: { lo: number; hi: number } } => t.guard !== null);

  // C2: every __pc read is one of the guards' own two reads, nothing else.
  const pcReads = identUses(list, "__pc").reads;
  if (pcReads !== guardedTries.length * 2) return { ...empty, reason: "non-guard-pc-read" };

  // C4: every guarded try's block starts with an entry-dominating store.
  const canDeletePc = guardedTries.every((t) => hasEntryStore(t.node.block));
  if (!canDeletePc) {
    // "the rung deletes no __pc store in this function" — but the __exc
    // deletions below are independent and still apply (spec 22 §4.2).
  }

  const allPcSites = collectPcSites(list);
  const liveSet = new Set<unknown>();
  for (const t of guardedTries) for (const site of collectPcSites(t.node.block)) liveSet.add(site.kind === "stmt" ? site.stmt : site.expr);

  const deadPcStmts: ExprStmt[] = [];
  const deadForExprs: Expr[] = [];
  if (canDeletePc) {
    for (const site of allPcSites) {
      if (site.kind === "for" && site.sole) continue;
      const key = site.kind === "stmt" ? site.stmt : site.expr;
      if (liveSet.has(key)) continue;
      if (site.kind === "stmt") deadPcStmts.push(site.stmt);
      else deadForExprs.push(site.expr);
    }
  }
  const survivingPcSites = allPcSites.filter((site) => (site.kind === "stmt" ? !deadPcStmts.includes(site.stmt) : !deadForExprs.includes(site.expr)));

  const { openReads, ownReads } = excAttribution(list, tries);
  const deadExcCopies: ExprStmt[] = [];
  if (openReads === 0) {
    for (const t of tries) {
      if (t.excCopyStmt === null) continue;
      if ((ownReads.get(t.node) ?? 0) === 0) deadExcCopies.push(t.excCopyStmt);
    }
  }

  const nullifyTries: TryStmt[] = [];
  for (const t of tries) {
    if (t.excCopyStmt === null || t.node.param === null) continue;
    const deleted = deadExcCopies.includes(t.excCopyStmt);
    const reads = identUses(t.node.handler, t.node.param).reads - (deleted ? 1 : 0);
    if (reads === 0) nullifyTries.push(t.node);
  }

  const pcFrameStmt = list.find((s) => s.k === "init" && s.kind === "let" && s.name === "__pc") ?? null;
  const excFrameStmt = list.find((s) => s.k === "decl" && s.kind === "let" && s.names.includes("__exc")) ?? null;
  const pcFrameDeletable = pcFrameStmt !== null && survivingPcSites.length === 0 && guardedTries.length === 0;
  const excFrameDeletable = excFrameStmt !== null && openReads === 0 && tries.every((t) => t.excCopyStmt === null || deadExcCopies.includes(t.excCopyStmt));

  const changed = deadPcStmts.length > 0 || deadForExprs.length > 0 || deadExcCopies.length > 0 || pcFrameDeletable || excFrameDeletable || nullifyTries.length > 0;
  if (!changed) return { ...empty, reason: "nothing-dead" };

  return {
    ok: true,
    tries,
    deadPcStmts,
    deadForExprs,
    deadExcCopies,
    pcFrame: pcFrameDeletable ? pcFrameStmt : null,
    excFrame: excFrameDeletable ? excFrameStmt : null,
    nullifyTries,
  };
}

// ---------------------------------------------------------------------------
// The rewrite: a straight deletion filter over the statement tree.
// ---------------------------------------------------------------------------

function transformSlot(e: Expr | null, deadForExprs: ReadonlySet<Expr>): Expr | null {
  if (e === null) return null;
  if (e.k === "seq") {
    const kept = e.exprs.filter((x) => !deadForExprs.has(x));
    if (kept.length === e.exprs.length) return e;
    return kept.length === 1 ? kept[0]! : { ...e, exprs: kept };
  }
  return e; // a bare (non-seq) slot store is never in deadForExprs (sole)
}

function rebuildStmt(s: Stmt, deadStmts: ReadonlySet<Stmt>, deadForExprs: ReadonlySet<Expr>, nullify: ReadonlySet<TryStmt>): Stmt {
  switch (s.k) {
    case "if":
      return { ...s, then: rebuildList(s.then, deadStmts, deadForExprs, nullify), else: rebuildList(s.else, deadStmts, deadForExprs, nullify) };
    case "while":
    case "do-while":
    case "labeled":
    case "iife":
      return { ...s, body: rebuildList(s.body, deadStmts, deadForExprs, nullify) };
    case "for":
      return { ...s, init: transformSlot(s.init, deadForExprs), update: transformSlot(s.update, deadForExprs), body: rebuildList(s.body, deadStmts, deadForExprs, nullify) };
    case "try": {
      const block = rebuildList(s.block, deadStmts, deadForExprs, nullify);
      const handler = rebuildList(s.handler, deadStmts, deadForExprs, nullify);
      const param = nullify.has(s) ? null : s.param;
      return { ...s, block, handler, param };
    }
    case "switch":
      return { ...s, cases: s.cases.map((c) => ({ ...c, body: rebuildList(c.body, deadStmts, deadForExprs, nullify) })) };
    default:
      return s; // func: a separate frame, never rewritten here
  }
}

export function rebuildList(list: readonly Stmt[], deadStmts: ReadonlySet<Stmt>, deadForExprs: ReadonlySet<Expr>, nullify: ReadonlySet<TryStmt>): readonly Stmt[] {
  const out: Stmt[] = [];
  for (const s of list) {
    if (deadStmts.has(s)) continue;
    out.push(rebuildStmt(s, deadStmts, deadForExprs, nullify));
  }
  return out;
}

export function applyAnalysis(list: readonly Stmt[], a: Analysis): readonly Stmt[] {
  const deadStmts = new Set<Stmt>([...a.deadPcStmts, ...a.deadExcCopies]);
  if (a.pcFrame !== null) deadStmts.add(a.pcFrame);
  if (a.excFrame !== null) deadStmts.add(a.excFrame);
  const deadForExprs = new Set<Expr>(a.deadForExprs);
  const nullify = new Set<TryStmt>(a.nullifyTries);
  return rebuildList(list, deadStmts, deadForExprs, nullify);
}
