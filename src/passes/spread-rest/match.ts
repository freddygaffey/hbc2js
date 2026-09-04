// spread-rest matcher — docs/specs/passes/17-spread-rest.md §4. Site = one
// statement list `L`. Rules in priority order (S1 array literal, S2 spread
// call, S3 rest parameter, S4 object spread); first match wins, scanning
// forward from `ctx`'s resume offset (there is none here — the driver
// re-invokes `match` on the whole list every iteration, so this always
// starts at 0 and returns the *first* site it finds, per `README`'s
// "innermost, post-order" contract applied at the statement-list grain).
//
// A single forward pass builds an incremental register->value substitution
// map (`subst`) as it walks a candidate run: every "pure setup" statement
// (`rX = rY` or `rX = <lit>`) updates the map instead of producing an
// element, so a register-shuffle Hermes inserts to stage a call's arguments
// (H1b's `r13 = r1; r12 = r3; r11 = 0; … apply(r13, r12, r11)`) is
// transparent — `resolve(expr)` chases the map until it hits a name the run
// never wrote (which necessarily survives outside the deleted range) or a
// non-ident value. This is what §4's "provable" index chain and target
// identity checks are built on: **every** run compares by resolved identity,
// never by raw register name.
import type { Expr, Param, Stmt } from "../ast.ts";
import { identUses, identUsesMany, isRegisterName, isSafeIdentifier, registerUses } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export type Element = { readonly kind: "lit"; readonly expr: Expr } | { readonly kind: "spread"; readonly source: Expr };
export type PropEl = { readonly kind: "spread"; readonly source: Expr } | { readonly kind: "prop"; readonly key: string; readonly computed: boolean; readonly value: Expr };

export type SpreadRestSite =
  | { readonly rule: "array"; readonly startIndex: number; readonly endIndex: number; readonly targetName: string; readonly elements: readonly Element[]; readonly seedCount: number; readonly hadTrim: boolean; readonly seedIsNewArray: boolean }
  | { readonly rule: "call"; readonly startIndex: number; readonly endIndex: number; readonly resultName: string; readonly callee: Expr; readonly args: readonly Element[] }
  | { readonly rule: "object"; readonly startIndex: number; readonly endIndex: number; readonly targetName: string; readonly seedProps: readonly { readonly key: string; readonly computed: boolean; readonly value: Expr }[]; readonly props: readonly PropEl[] }
  | { readonly rule: "rest"; readonly funcIndex: number; readonly freshName: string; readonly callNode: Expr };

export type SpreadRestMatch = Match<readonly Stmt[], SpreadRestSite>;

// ---------------------------------------------------------------------------
// Small expression helpers.
// ---------------------------------------------------------------------------

function isIdent(e: Expr): e is Extract<Expr, { readonly k: "ident" }> {
  return e.k === "ident";
}

function isNumberLit(e: Expr, n: number): boolean {
  return e.k === "lit" && e.text === String(n);
}

function isUndefinedLit(e: Expr): boolean {
  return e.k === "lit" && e.text === "undefined";
}

/** `assign` target as a plain register write, or `null`. Registers here are
 *  always emitted as bare `expr` statements (spec §2's own examples): the
 *  `let r0, r1, …;` declaration is one `decl` up front, so every subsequent
 *  write is `{k:"expr", expr:{k:"assign", target:{k:"ident"}, …}}`, never
 *  `k:"init"` — `init` would introduce a *new* binding, which a register
 *  never is (D14). */
function assignTarget(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "ident") return null;
  return { name: s.expr.target.name, value: s.expr.value };
}

/** A member store `T[k] = v` / `T.k = v`, or `null`. */
function memberStore(s: Stmt): { readonly obj: Expr; readonly prop: Expr; readonly computed: boolean; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "member") return null;
  const t = s.expr.target;
  return { obj: t.obj, prop: t.prop, computed: t.computed, value: s.expr.value };
}

function isHelperCallExpr(e: Expr, name: string): e is Extract<Expr, { readonly k: "call" }> {
  return e.k === "call" && e.callee.k === "ident" && e.callee.name === name;
}

/** `new Array(0)` — H1b/S2's seed. */
function isNewArrayZero(e: Expr): boolean {
  return e.k === "new" && e.callee.k === "ident" && e.callee.name === "Array" && e.args.length === 1 && isNumberLit(e.args[0]!, 0);
}

/** A "pure setup" statement worth folding into `subst` rather than treating
 *  as an element of the run: a register write whose value is itself a bare
 *  ident or a literal — no call, no member read, nothing observable. */
function pureSetup(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  const a = assignTarget(s);
  if (a === null) return null;
  if (a.value.k === "ident" || a.value.k === "lit") return a;
  return null;
}

class Subst {
  private readonly map = new Map<string, Expr>();
  resolve(e: Expr): Expr {
    if (e.k === "ident" && this.map.has(e.name)) return this.resolve(this.map.get(e.name)!);
    if (e.k === "bin") {
      const left = this.resolve(e.left);
      const right = this.resolve(e.right);
      return left === e.left && right === e.right ? e : { ...e, left, right };
    }
    return e;
  }
  absorb(s: Stmt): boolean {
    const setup = pureSetup(s);
    if (setup === null) return false;
    this.map.set(setup.name, this.resolve(setup.value));
    return true;
  }
  sameIdent(a: Expr, b: Expr): boolean {
    const ra = this.resolve(a);
    const rb = this.resolve(b);
    return isIdent(ra) && isIdent(rb) && ra.name === rb.name;
  }
}

// ---------------------------------------------------------------------------
// S1 — array literal with spread (H1a).
// ---------------------------------------------------------------------------

function matchArray(list: readonly Stmt[], seedIndex: number): SpreadRestSite | null {
  const seed = list[seedIndex]!;
  const a = assignTarget(seed);
  if (a === null || a.value.k !== "array") return null;
  const targetName = a.name;
  if (a.value.elements.some((expr) => expr.k === "spread")) return null; // seed already spread-free by construction, pre-pass; refuse defensively
  const elements: Element[] = a.value.elements.map((expr) => ({ kind: "lit" as const, expr }));
  const subst = new Subst();
  const seedCount = elements.length;
  let j = seedIndex + 1;
  // Optional `.length = n` trim — dropped, it only pre-sizes (§2 H1a, §8 Q3).
  let hadTrim = false;
  if (j < list.length) {
    const trim = memberStore(list[j]!);
    if (trim !== null && !trim.computed && trim.obj.k === "ident" && trim.obj.name === targetName && trim.prop.k === "lit" && trim.prop.text === "length") {
      j++;
      hadTrim = true;
    }
  }
  // `expectedIndex`: the symbolic next append position. `lit` for the first
  // spread (must equal the seed's element count); `reg` for a chain
  // continuing off the previous call's own result register; `regPlus1` once
  // a plain element has consumed that slot (§4 precondition 1).
  type Expected = { readonly kind: "lit"; readonly n: number } | { readonly kind: "reg"; readonly name: string } | { readonly kind: "regPlus1"; readonly name: string };
  let expected: Expected = { kind: "lit", n: elements.length };
  let sawSpread = false;
  // Only a statement that is genuinely *consumed by a recognised call/store*
  // advances `consumedUpTo` -- a `subst`-absorbed "pure setup" statement
  // (`rX = rY` / `rX = <lit>`) does not, until something real reads it. This
  // is what stops the run from silently swallowing a later, unrelated
  // statement that merely *looks* like scratch setup (e.g. `r1 = "-"`
  // immediately preceding an unrelated `r1 = r8.join(r1)` -- absorbing it
  // would delete the separator's own value along with the run).
  let consumedUpTo = j;
  const indexMatches = (idx: Expr): boolean => {
    const r = subst.resolve(idx);
    if (expected.kind === "lit") return r.k === "lit" && r.text === String(expected.n);
    if (expected.kind === "reg") return isIdent(r) && r.name === expected.name;
    return r.k === "bin" && r.op === "+" && isIdent(r.left) && r.left.name === expected.name && subst.resolve(r.right).k === "lit" && (subst.resolve(r.right) as Extract<Expr, { readonly k: "lit" }>).text === "1";
  };
  runLoop: while (j < list.length) {
    const s = list[j]!;
    if (subst.absorb(s)) {
      j++;
      continue;
    }
    // Case A: `rI = arraySpread(T, S, idx)` on its own — the next statement
    // (if any) is examined independently, on the next loop turn: it is
    // either another spread continuing the chain off `rI`, a plain element
    // stored at `rI` (Case C), or the run simply ends here (an all-spread
    // tail, e.g. `[...str]`/`variadicSum(...a, ...b)` has no trailing store
    // at all).
    const call = assignTarget(s);
    if (call !== null && isHelperCallExpr(call.value, "__hbc_b_arraySpread")) {
      const [t, src, idx] = call.value.args as readonly [Expr, Expr, Expr];
      if (!subst.sameIdent(t, { k: "ident", name: targetName }) || !indexMatches(idx)) break runLoop;
      elements.push({ kind: "spread", source: subst.resolve(src) });
      expected = { kind: "reg", name: call.name };
      j += 1;
      consumedUpTo = j;
      sawSpread = true;
      continue;
    }
    // Case B: fused `T[arraySpread(T, S, idx)] = v` — the call's own return
    // becomes the index a plain element is stored at, in one statement.
    const store = memberStore(s);
    if (store !== null && store.computed && isHelperCallExpr(store.prop, "__hbc_b_arraySpread") && subst.sameIdent(store.obj, { k: "ident", name: targetName })) {
      const [t, src, idx] = store.prop.args as readonly [Expr, Expr, Expr];
      if (!subst.sameIdent(t, { k: "ident", name: targetName }) || !indexMatches(idx)) break runLoop;
      elements.push({ kind: "spread", source: subst.resolve(src) }, { kind: "lit", expr: subst.resolve(store.value) });
      sawSpread = true;
      j++;
      consumedUpTo = j;
      break runLoop; // the call's own result register is never named — no chain past a fused store (§2's only observed use)
    }
    // Case C: a plain store consuming the slot the previous spread returned.
    if (store !== null && store.computed && expected.kind === "reg" && subst.sameIdent(store.prop, { k: "ident", name: expected.name }) && subst.sameIdent(store.obj, { k: "ident", name: targetName })) {
      elements.push({ kind: "lit", expr: subst.resolve(store.value) });
      expected = { kind: "regPlus1", name: expected.name };
      j++;
      consumedUpTo = j;
      continue;
    }
    break runLoop;
  }
  if (!sawSpread) return null;
  return { rule: "array", startIndex: seedIndex, endIndex: consumedUpTo, targetName, elements, seedCount, hadTrim, seedIsNewArray: false };
}

// ---------------------------------------------------------------------------
// S2 — spread call (H1b + H2).
// ---------------------------------------------------------------------------

function matchCall(list: readonly Stmt[], seedIndex: number): SpreadRestSite | null {
  const seed = list[seedIndex]!;
  const a = assignTarget(seed);
  if (a === null || !isNewArrayZero(a.value)) return null;
  const targetName = a.name;
  const subst = new Subst();
  const args: Element[] = [];
  let j = seedIndex + 1;
  // Same "only real progress advances the endpoint" rule as matchArray's
  // `consumedUpTo` — H1c (no `apply` found) must not swallow a trailing
  // absorbed-but-unused setup statement into the deleted range.
  let consumedUpTo = j;
  while (j < list.length) {
    const s = list[j]!;
    if (subst.absorb(s)) {
      j++;
      continue;
    }
    const call = assignTarget(s);
    if (call !== null && isHelperCallExpr(call.value, "__hbc_b_apply")) {
      const [fn, arr, thisV] = call.value.args as readonly [Expr, Expr, Expr];
      if (!subst.sameIdent(arr, { k: "ident", name: targetName })) return null;
      const resolvedThis = subst.resolve(thisV);
      if (!isUndefinedLit(resolvedThis)) return null; // this-not-undefined
      if (args.length === 0) return null;
      const callee = subst.resolve(fn);
      return { rule: "call", startIndex: seedIndex, endIndex: j + 1, resultName: call.name, callee, args };
    }
    // `arraySpread`'s return is often discarded here (only the array's
    // *contents* matter, not the next-index bookkeeping S1 needs) — a bare
    // expression-statement call, not an assignment.
    const bareCall = s.k === "expr" && s.expr.k === "call" ? s.expr : null;
    const spreadCall = call !== null && isHelperCallExpr(call.value, "__hbc_b_arraySpread") ? call.value : bareCall !== null && isHelperCallExpr(bareCall, "__hbc_b_arraySpread") ? bareCall : null;
    if (spreadCall !== null) {
      const [t, src] = spreadCall.args as readonly [Expr, Expr, Expr];
      if (!subst.sameIdent(t, { k: "ident", name: targetName })) return null;
      args.push({ kind: "spread", source: subst.resolve(src) });
      j++;
      consumedUpTo = j;
      continue;
    }
    const store = memberStore(s);
    if (store !== null && store.computed && subst.sameIdent(store.obj, { k: "ident", name: targetName }) && store.prop.k === "lit") {
      args.push({ kind: "lit", expr: subst.resolve(store.value) });
      j++;
      consumedUpTo = j;
      continue;
    }
    break; // an unrecognised statement ends the run — H1c falls through below
  }
  // H1c — no `apply` followed: `rA` is simply used as an ordinary array
  // afterwards (`[...str]`, `const copy = [...a]`). Same rewrite target as
  // S1 (an array literal, `seedCount: 0` since `new Array(0)` starts empty),
  // just reached from a `new Array(0)` seed instead of an array literal.
  if (args.length === 0) return null;
  return { rule: "array", startIndex: seedIndex, endIndex: consumedUpTo, targetName, elements: args, seedCount: 0, hadTrim: false, seedIsNewArray: true };
}

// ---------------------------------------------------------------------------
// S4 — object spread (H4).
// ---------------------------------------------------------------------------

function matchObject(list: readonly Stmt[], seedIndex: number): SpreadRestSite | null {
  const seed = list[seedIndex]!;
  const a = assignTarget(seed);
  if (a === null || a.value.k !== "object") return null;
  const targetName = a.name;
  const seedProps: { key: string; computed: boolean; value: Expr }[] = [];
  for (const p of a.value.props) {
    if ("k" in p) return null; // seed already carries a spread — not a fresh seed for this rung
    seedProps.push({ key: p.key, computed: p.computed, value: p.value });
  }
  const subst = new Subst();
  const props: PropEl[] = [];
  let j = seedIndex + 1;
  let sawSpread = false;
  // Same "only real progress advances the endpoint" rule as matchArray's
  // `consumedUpTo` (a trailing absorbed-but-unused setup statement must not
  // be swallowed into the deleted range).
  let consumedUpTo = j;
  while (j < list.length) {
    const s = list[j]!;
    if (subst.absorb(s)) {
      j++;
      continue;
    }
    const call = assignTarget(s) ?? (s.k === "expr" && s.expr.k === "call" ? { name: null, value: s.expr } : null);
    if (call !== null && isHelperCallExpr(call.value, "__hbc_b_copyDataProperties")) {
      if (call.value.args.length !== 2) return null; // destructure-rest-form — spec 16's 3-arg shape
      const [t, src] = call.value.args as readonly [Expr, Expr];
      if (!subst.sameIdent(t, { k: "ident", name: targetName })) return null;
      props.push({ kind: "spread", source: subst.resolve(src) });
      sawSpread = true;
      j++;
      consumedUpTo = j;
      continue;
    }
    const store = memberStore(s);
    if (store !== null && subst.sameIdent(store.obj, { k: "ident", name: targetName })) {
      const keyExpr = subst.resolve(store.prop);
      if (keyExpr.k !== "lit") break; // unprovable key ends the unit; a valid prefix stays matched
      // Once the key is *provably* a constant, the store is folded into the
      // literal as a plain (non-computed) property, never `[key]` — a
      // computed member store's own `prop` was an expression (e.g. `r1`
      // holding `"size"`); after resolving it, there is no expression left
      // to keep computed for (§4 precondition 13).
      let raw: string;
      try {
        raw = String(JSON.parse(keyExpr.text));
      } catch {
        raw = keyExpr.text;
      }
      const key = isSafeIdentifier(raw) ? raw : JSON.stringify(raw);
      props.push({ kind: "prop", key, computed: !isSafeIdentifier(raw), value: subst.resolve(store.value) });
      j++;
      consumedUpTo = j;
      continue;
    }
    break;
  }
  if (!sawSpread) return null;
  return { rule: "object", startIndex: seedIndex, endIndex: consumedUpTo, targetName, seedProps, props };
}

// ---------------------------------------------------------------------------
// S3 — rest parameter (H3).
// ---------------------------------------------------------------------------

export type FuncLike = { readonly name: string | null; readonly params: readonly Param[]; readonly body: readonly Stmt[] };

export function extractFunc(s: Stmt): FuncLike | null {
  if (s.k === "func") return s;
  if (s.k === "init" && s.value.k === "func") return s.value;
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.value.k === "func") return s.expr.value;
  return null;
}

function findCopyRestArgsCalls(body: readonly Stmt[]): (Expr & { readonly k: "call" })[] {
  const out: (Expr & { readonly k: "call" })[] = [];
  const visitExpr = (e: Expr): void => {
    switch (e.k) {
      case "call":
      case "new":
        visitExpr(e.callee);
        e.args.forEach(visitExpr);
        if (isHelperCallExpr(e, "__hbc_b_copyRestArgs")) out.push(e);
        return;
      case "member":
        visitExpr(e.obj);
        if (e.computed) visitExpr(e.prop);
        return;
      case "bin":
      case "logical":
        visitExpr(e.left);
        visitExpr(e.right);
        return;
      case "unary":
        visitExpr(e.arg);
        return;
      case "assign":
        visitExpr(e.target);
        visitExpr(e.value);
        return;
      case "cond":
        visitExpr(e.test);
        visitExpr(e.then);
        visitExpr(e.else);
        return;
      case "array":
        e.elements.forEach(visitExpr);
        return;
      case "object":
        e.props.forEach((p) => visitExpr("k" in p ? p.arg : p.value));
        return;
      case "seq":
      case "template":
        e.exprs.forEach(visitExpr);
        return;
      case "spread":
        visitExpr(e.arg);
        return;
      case "tagged":
        visitExpr(e.tag);
        visitExpr(e.quasi);
        return;
      default:
        return; // ident, lit, this, argumentsObject, func (own frame — a nested
      // closure's own `copyRestArgs` belongs to *that* function's own body list.
    }
  };
  const visitStmts = (list: readonly Stmt[]): void => {
    for (const st of list) {
      switch (st.k) {
        case "expr":
          visitExpr(st.expr);
          break;
        case "init":
          visitExpr(st.value);
          break;
        case "if":
          visitExpr(st.test);
          visitStmts(st.then);
          visitStmts(st.else);
          break;
        case "while":
          if (st.test !== undefined) visitExpr(st.test);
          visitStmts(st.body);
          break;
        case "do-while":
          visitExpr(st.test);
          visitStmts(st.body);
          break;
        case "for":
          if (st.init !== null) visitExpr(st.init);
          visitExpr(st.test);
          if (st.update !== null) visitExpr(st.update);
          visitStmts(st.body);
          break;
        case "labeled":
          visitStmts(st.body);
          break;
        case "return":
          if (st.arg !== null) visitExpr(st.arg);
          break;
        case "throw":
          visitExpr(st.arg);
          break;
        case "try":
          visitStmts(st.block);
          visitStmts(st.handler);
          break;
        case "switch":
          visitExpr(st.disc);
          for (const c of st.cases) {
            if (c.test !== null) visitExpr(c.test);
            visitStmts(c.body);
          }
          break;
        case "iife":
          visitStmts(st.body);
          break;
        default:
          break;
      }
    }
  };
  visitStmts(body);
  return out;
}

function freshRegisterName(F: FuncLike): string {
  let max = -1;
  const consider = (name: string): void => {
    const m = /^r(\d+)$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  };
  for (const p of F.params) consider(p.name);
  // Whole-body scan for the highest `rN` — cheap enough at this grain (one
  // function, once per candidate) and avoids importing `registerUses`'s
  // memoised whole-module machinery for a one-off rename.
  const visit = (e: Expr): void => {
    if (e.k === "ident") consider(e.name);
  };
  const scan = (list: readonly Stmt[]): void => {
    for (const s of list) {
      const keys = ["expr", "test", "value", "update", "arg", "disc"] as const;
      for (const k of keys) {
        const v = (s as unknown as Record<string, unknown>)[k];
        if (v !== undefined && v !== null && typeof v === "object" && "k" in (v as object)) walkE(v as Expr);
      }
      for (const k of ["then", "else", "body", "block", "handler"] as const) {
        const v = (s as unknown as Record<string, unknown>)[k];
        if (Array.isArray(v)) scan(v as readonly Stmt[]);
      }
      if (s.k === "switch") for (const c of s.cases) scan(c.body);
    }
  };
  const walkE = (e: Expr): void => {
    visit(e);
    for (const k of ["obj", "prop", "callee", "left", "right", "arg", "target", "value", "test", "then", "else", "source", "tag", "quasi"] as const) {
      const v = (e as unknown as Record<string, unknown>)[k];
      if (v !== undefined && v !== null && typeof v === "object" && "k" in (v as object)) walkE(v as Expr);
    }
    for (const k of ["args", "elements", "exprs"] as const) {
      const v = (e as unknown as Record<string, unknown>)[k];
      if (Array.isArray(v)) (v as Expr[]).forEach(walkE);
    }
    if (e.k === "object") e.props.forEach((p) => walkE("k" in p ? p.arg : p.value));
  };
  scan(F.body);
  return `r${max + 1}`;
}

// ---------------------------------------------------------------------------
// Liveness guard (fuzz family F1, docs/reports/2026-09-04-fuzz-families.md).
// ---------------------------------------------------------------------------

/** How far past a site `deadAfter` will look for the register's next
 *  mention. Bounds the guard's cost on a bundle's multi-thousand-statement
 *  global function (docs/PUSHBACK.md P-1: a rung that asks a whole-function
 *  question per candidate is what made the M5 pipeline 250x slower); a site
 *  whose staging register is not resolved within the window is refused, so
 *  the limit can only cost readability, never correctness. */
const LIVENESS_SCAN_LIMIT = 500;

/** True when every mention of `name` from `from` onward proves the value
 *  written inside the run is dead: the first statement that mentions it at
 *  all overwrites it without reading it. A read first (or an unresolved
 *  scan) means the run's write is still live. */
function deadAfter(list: readonly Stmt[], from: number, name: string): boolean {
  const limit = Math.min(list.length, from + LIVENESS_SCAN_LIMIT);
  for (let i = from; i < limit; i++) {
    const u = identUses([list[i]!], name);
    if (u.reads > 0 || u.nested > 0) return false;
    if (u.writes > 0) return true;
  }
  return limit === list.length;
}

/**
 * §4's missing precondition: `rewrite` deletes the whole `[startIndex,
 * endIndex)` run, and `Subst` deliberately swallows every "pure setup"
 * statement in it — but Hermes stages a spread's source/index registers
 * *once* and reuses them at the next spread site, so deleting the first
 * site's staging silently destroys the second site's operands
 * (`[...r8]` with `r8` never assigned; `copy.push(r0)` with `r0` never
 * assigned; `{...null, y: r5}` with `r5` never assigned). `check.ts` cannot
 * see it: a deleted register move has no entry in `effectSequence`.
 *
 * So: refuse a site whose deleted range writes a register that is still
 * live afterwards. Refusing costs only readability — the run stays in its
 * `__hbc_b_arraySpread` helper-call form, which is what `--passes=none`
 * emits and is correct.
 */
function siteDeletesLiveRegister(list: readonly Stmt[], site: SpreadRestSite, ctx: PassContext): boolean {
  if (site.rule === "rest") return false; // rewrites a func node in place; deletes nothing
  const survivorIndex = site.rule === "call" ? site.endIndex - 1 : site.startIndex;
  const deleted: Stmt[] = [];
  const written = new Set<string>();
  for (let i = site.startIndex; i < site.endIndex; i++) {
    if (i === survivorIndex) continue;
    const s = list[i]!;
    deleted.push(s);
    const a = assignTarget(s);
    if (a !== null) written.add(a.name);
  }
  // The site's own target/result is written by the statement that survives.
  written.delete(site.rule === "call" ? site.resultName : site.targetName);
  if (written.size === 0) return false;
  const fnBody: readonly Stmt[] = ctx.fnBody ?? list;
  const inRun = identUsesMany(deleted, written);
  const inFn = registerUses(fnBody);
  for (const name of written) {
    if (!isRegisterName(name)) return true; // not a register: no frame-local liveness argument
    const outside = (inFn.get(name)?.reads ?? 0) - (inRun.get(name)?.reads ?? 0);
    if (outside <= 0) continue; // read only inside the run being deleted
    if (list !== fnBody) return true; // nested list: no ordered whole-function scan available here
    if (!deadAfter(list, site.endIndex, name)) return true;
  }
  return false;
}

function matchRest(list: readonly Stmt[], listIndex: number): SpreadRestSite | null {
  const F = extractFunc(list[listIndex]!);
  if (F === null) return null;
  const calls = findCopyRestArgsCalls(F.body);
  if (calls.length !== 1) return null; // multiple-rest-reads, or none at all
  const call = calls[0]!;
  const [argsObj, k] = call.args as readonly [Expr, Expr];
  if (argsObj.k !== "argumentsObject") return null;
  if (k.k !== "lit") return null;
  const declaredCount = F.params.filter((p) => p.rest !== true).length;
  if (k.text !== String(declaredCount)) return null; // rest-index-mismatch
  if (F.params.some((p) => p.rest === true)) return null; // already has a rest param
  const fresh = freshRegisterName(F);
  if (!isSafeIdentifier(fresh)) return null;
  return { rule: "rest", funcIndex: listIndex, freshName: fresh, callNode: call };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function match(list: readonly Stmt[], ctx: PassContext): SpreadRestMatch | null {
  for (let i = 0; i < list.length; i++) {
    // A site whose deleted run kills a still-live staging register is
    // *skipped*, not fatal: the scan carries on to the next seed, so the
    // second of two sites sharing one staged source register is still
    // recovered (its own run deletes nothing that survives it).
    // Lazily, in rule order: a later rule is only tried when the earlier one
    // matched nothing (or matched an unsafe site) — never eagerly, so the
    // per-index cost is unchanged from the pre-guard `||` chain (P-1).
    for (const rule of [matchArray, matchCall, matchObject, matchRest]) {
      const site = rule(list, i);
      if (site === null || siteDeletesLiveRegister(list, site, ctx)) continue;
      return { root: list, nodes: [list], data: site, at: { functionIndex: ctx.functionIndex, offset: i } };
    }
  }
  return null;
}
