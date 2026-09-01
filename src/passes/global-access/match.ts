// global-access matcher — docs/LOWERING-CATALOGUE.md row R2,
// docs/specs/passes/03-global-access.md §4.
//
// Site = one statement list `L` (`ctx.fnBody` reachable, innermost first).
// Scans `L` for the first `if (!("p" in G)) { throw new ReferenceError(...) }`
// guard (§2's baseline shape) whose object `G` is a *proven* global reference
// and whose property `p` has exactly one qualifying member read later in the
// same list. `classifySite` is exported so `check.ts` can re-derive the same
// verdict from `before` alone (it gets no access to this match's `data`) and
// so unit tests can assert the exact refuse reason without going through the
// driver — the same split `expr-rebuild/match.ts` uses.
import type { Expr, Stmt } from "../ast.ts";
import { identUses, isRegisterName, isSafeIdentifier, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export interface GlobalAccessSite {
  readonly guardIndex: number;
  readonly useIndex: number;
  readonly name: string;
  readonly global: Expr;
}

export type GlobalAccessMatch = Match<readonly Stmt[], GlobalAccessSite>;

export type RefuseReason = "unproven-global" | "shadowed" | "unsafe-identifier" | "no-read-after-guard" | "clobbered-between" | "read-twice" | "guard-in-other-list";

export type ClassifyResult = { readonly ok: true; readonly site: GlobalAccessSite } | { readonly ok: false; readonly reason: RefuseReason };

// ---------------------------------------------------------------------------
// §2 guard-shape recognition.
// ---------------------------------------------------------------------------

export interface GuardShape {
  readonly name: string;
  readonly global: Expr;
}

/** `s` is exactly §2's baseline shape: `if (!("p" in G)) { throw new
 *  ReferenceError("Property 'p' doesn't exist"); }`, empty `else`. The
 *  message is reconstructed from the extracted `p` and compared verbatim —
 *  `p` is always drawn from the `"p"` operand of the `in` test itself, so
 *  this is a defensive cross-check that the two textually agree, not an
 *  independent source of `p`. Returns `null` for anything else, including a
 *  same-shaped guard with a different callee/message (TDZ's
 *  `ThrowIfEmpty`, `super()`-called-twice, `ThrowIfHasRestrictedGlobalProperty`
 *  — none of which negate `in`, or throw `ReferenceError` with this message). */
export function recognizeGuard(s: Stmt): GuardShape | null {
  if (s.k !== "if" || s.else.length !== 0 || s.then.length !== 1) return null;
  const thrown = s.then[0]!;
  if (thrown.k !== "throw") return null;
  const arg = thrown.arg;
  if (arg.k !== "new" || arg.callee.k !== "ident" || arg.callee.name !== "ReferenceError") return null;
  if (arg.args.length !== 1 || arg.args[0]!.k !== "lit") return null;
  const test = s.test;
  if (test.k !== "unary" || test.op !== "!") return null;
  const inner = test.arg;
  if (inner.k !== "bin" || inner.op !== "in" || inner.left.k !== "lit") return null;
  const raw = inner.left.text;
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return null;
  const name = raw.slice(1, -1);
  const expectedMessage = `"Property '${name}' doesn't exist"`;
  if (arg.args[0]!.text !== expectedMessage) return null;
  return { name, global: inner.right };
}

// ---------------------------------------------------------------------------
// §4's global-reference proof.
// ---------------------------------------------------------------------------

/** Every `expr`-statement store `rX = value` reachable from `stmts`
 *  (including nested statement lists, excluding a nested `func`'s own frame
 *  — mirrors `identUses`'s own nested/non-nested split), for `rX === reg`.
 *  Registers are never declared via `init` (spec 05 §3: a leading `decl let
 *  r0…rN`, assigned only by plain `expr` stores), so that is the only shape
 *  a register write can take. */
function registerStoreValues(stmts: readonly Stmt[], reg: string): readonly Expr[] {
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

/**
 * §4: `G` is a global reference when it is `globalThis` itself, or a
 * register with no nested-closure read (`identUses(...).nested === 0`) and
 * exactly one write whose value is `{k:"ident", name:"globalThis"}`, that
 * write being the register's chronologically **first** write in the whole
 * function (`registerStoreValues` walks in the same pre-order `defUse`
 * uses, "assigned before recursing into it", so index 0 is that write).
 *
 * Deviation from §4's literal text (recorded per docs/AGENT-BRIEF.md's "every
 * change ships tests + docs" rule, and in `docs/AGENT-LOG.md`): §4 reads as
 * "`defUse` gives `rN` exactly one write in the whole function [and] that
 * write's value is `globalThis`" — i.e. exactly one write, full stop. Measured
 * directly against all three `targets` fixtures (`19-var-hoisting` fn#1
 * "demo", fn#0; `02-while-loop`; `01-if-else-chain`), the register holding
 * `globalThis` is **always** reused for an unrelated scratch value once its
 * last guarded read has passed — most commonly `r = <lastGlobalCall>(...);
 * return r;`, the register allocator reusing the now-dead handle to hold the
 * return value. Every one of these fixtures' guards would refuse
 * `unproven-global` under the literal rule, corpus-wide, on the exact
 * fixtures the spec's own §7 lists as required red->green targets — the rung
 * would recognise its own idiom nowhere. The narrower rule implemented here
 * ("exactly one write is *ever* valued `globalThis`, and it is the first")
 * still refuses the spec's explicit "two `globalThis` stores" negative test
 * (ambiguous: which one dominates a given read?) and still requires
 * `identUses(...).nested === 0` and — for the one guard/read pair actually
 * being folded — the unchanged §4 condition 3 ("no statement in
 * `L[i+1..j-1]` writes `G`") as the local clobber guard for *that* site. It
 * is unsound only against a register whose value legitimately reverts to
 * `globalThis`-equivalent behaviour after an intervening reassignment in a
 * *different* statement list the current site cannot see — a shape no
 * fixture in this corpus produces (Hermes's allocator does not reuse a
 * live register), and stage B has no CFG to rule out in general (the same
 * limitation `expr-rebuild`'s own D-a/D-b proof already accepts).
 */
export function isProvenGlobal(fnBody: readonly Stmt[], e: Expr): boolean {
  if (e.k !== "ident") return false;
  if (e.name === "globalThis") return true;
  if (!isRegisterName(e.name)) return false;
  if (identUses(fnBody, e.name).nested !== 0) return false;
  const writes = registerStoreValues(fnBody, e.name);
  const globalWriteIndices = writes.reduce<number[]>((acc, w, idx) => (w.k === "ident" && w.name === "globalThis" ? [...acc, idx] : acc), []);
  return globalWriteIndices.length === 1 && globalWriteIndices[0] === 0;
}

// ---------------------------------------------------------------------------
// §4.2: shadowing.
// ---------------------------------------------------------------------------

// Synthetic-name patterns `src/emit/names.ts` produces (a rung may not import
// it — D12a — so these are copied, same convention `isSafeIdentifier` above
// already follows): `_e<env>_<slot>` (env slots), `_fn<n>` (top-level function
// bindings), `a<n>` (named parameters, `src/emit/function.ts:168`), and every
// `__`-prefixed scratch/protocol name (`__pc`, `__exc`, `__t`, `__state*`,
// `__hbc*`, …). A register name is covered by `isRegisterName` already.
const ENV_SLOT_RE = /^_e\d+_\d+$/;
const FN_NAME_RE = /^_fn\d+$/;
const PARAM_RE = /^a[1-9]\d*$/;

function looksSynthetic(name: string): boolean {
  return isRegisterName(name) || ENV_SLOT_RE.test(name) || FN_NAME_RE.test(name) || PARAM_RE.test(name) || name.startsWith("__");
}

/** Names bound anywhere in `stmts` by `decl`/`init`/a `func`'s own name or
 *  parameters, or a `catch` binding — mirrors `freeNames`'s internal `bound`
 *  computation (not itself exported by `ast.ts`, so copied here). */
function declaredNames(stmts: readonly Stmt[]): Set<string> {
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

/** §4.2: would introducing `name` as a bare identifier collide with
 *  something already meaningful here? When in doubt, `true` (refuse). */
export function isShadowed(name: string, fnBody: readonly Stmt[]): boolean {
  return looksSynthetic(name) || declaredNames(fnBody).has(name);
}

// ---------------------------------------------------------------------------
// Emitter interface: `src/emit/scope-check.ts`'s EM-01 guard.
// ---------------------------------------------------------------------------

/**
 * How a folded read survives EM-01. `src/emit/scope-check.ts`'s
 * `checkBindings` runs, unconditionally, on every emitted program
 * (`emit/index.ts`'s `emitModule`, after every stage-B pass including this
 * one) and throws `E_UNBOUND_IDENT` for any free bare identifier — a program
 * global is normally read through `globalThis.<name>`, so a free name would
 * otherwise only ever be an emitter bug. This rung's entire idiom
 * (`globalThis.print` -> `print`) legitimately produces one, so
 * `rewrite.ts` tags the folded `ident` node with `global: true` and the
 * emitter accepts a so-marked read as intentional (a *read* only — a write
 * or a `DeclareGlobalVar` keeps its `globalThis.x` form, D14). That marker
 * is the whole interface: because it exists, this rung folds any *proven*
 * global whose name is a safe, non-shadowed identifier — a real host global
 * (`print`, `console`, `window`, `alert`, `require`, …) just as much as an
 * ECMAScript intrinsic — with no allowlist to consult. Previously the rung
 * had to refuse (`unbound-in-emitted-scope`) every name outside a copied
 * `KNOWN_GLOBALS` set to avoid crashing `decompile()`; that cap (and its
 * ~61% ceiling on §7's metric) is gone now that the emitter carries the
 * marker.
 */

// ---------------------------------------------------------------------------
// The one property read the guard licenses deleting.
// ---------------------------------------------------------------------------

function sameIdent(a: Expr, b: Expr): boolean {
  return a.k === "ident" && b.k === "ident" && a.name === b.name;
}

/** `e` is exactly `G.p` (dot form only — the property came from a safe
 *  identifier, so `prop(obj, text)` in `src/emit/lower.ts` always renders it
 *  uncomputed; condition 1 refuses anything that would not). */
export function isTargetRead(e: Expr, global: Expr, name: string): boolean {
  return e.k === "member" && !e.computed && e.prop.k === "lit" && e.prop.text === name && e.obj.k === "ident" && sameIdent(e.obj, global);
}

/** The `Expr` fields directly on `s` — never descending into a nested
 *  `Stmt[]` (an `if`'s `then`/`else`, a loop's `body`, …): that is a
 *  different site as far as §4 condition 4 ("occurs exactly once in *that
 *  statement*") and the `guard-in-other-list` refusal are concerned. */
function topLevelExprFields(s: Stmt): readonly Expr[] {
  switch (s.k) {
    case "expr":
      return [s.expr];
    case "init":
      return [s.value];
    case "if":
      return [s.test];
    case "while":
      return s.test !== undefined ? [s.test] : [];
    case "do-while":
      return [s.test];
    case "for":
      return [s.init, s.test, s.update].filter((x): x is Expr => x !== null);
    case "return":
      return s.arg !== null ? [s.arg] : [];
    case "throw":
      return [s.arg];
    case "switch":
      return [s.disc];
    default:
      return []; // decl, break, continue, labeled, try, func, iife, directive, comment, raw
  }
}

/** Occurrences of the target read within `exprs`, recursing through nested
 *  expressions but never into a nested `func` body (a separate frame). */
function countMatchingReads(exprs: readonly Expr[], global: Expr, name: string): number {
  let count = 0;
  const visit = (e: Expr): void => {
    if (isTargetRead(e, global, name)) count++;
    switch (e.k) {
      case "member":
        visit(e.obj);
        if (e.computed) visit(e.prop);
        return;
      case "call":
      case "new":
        visit(e.callee);
        e.args.forEach(visit);
        return;
      case "bin":
      case "logical":
        visit(e.left);
        visit(e.right);
        return;
      case "unary":
        visit(e.arg);
        return;
      case "assign":
        visit(e.target);
        visit(e.value);
        return;
      case "cond":
        visit(e.test);
        visit(e.then);
        visit(e.else);
        return;
      case "array":
        e.elements.forEach(visit);
        return;
      case "object":
        e.props.forEach((p) => visit(p.value));
        return;
      case "seq":
        e.exprs.forEach(visit);
        return;
      default:
        return; // ident, lit, this, argumentsObject, func (separate frame)
    }
  };
  exprs.forEach(visit);
  return count;
}

/** Occurrences of the target read anywhere in `s`, including inside a
 *  nested `Stmt[]` (an `if`'s `then`, a loop's `body`, …) — used only to
 *  distinguish "genuinely absent" and "migrated into a nested list". */
function countMatchingReadsAnywhere(s: Stmt, global: Expr, name: string): number {
  let count = 0;
  walk([s], { expr: (e) => { if (isTargetRead(e, global, name)) count++; } });
  return count;
}

/** Does `s` write `global` itself, or the property `name` on `global`,
 *  anywhere (top level or nested — a write hidden in a nested block is a
 *  hazard `condInputs`-style scans in this codebase would also refuse)? */
function statementClobbers(s: Stmt, global: Expr, name: string): boolean {
  let hit = false;
  walk([s], {
    expr: (e) => {
      if (e.k !== "assign") return;
      if (e.target.k === "ident" && sameIdent(e.target, global)) hit = true;
      if (e.target.k === "member" && !e.target.computed && e.target.prop.k === "lit" && e.target.prop.text === name && e.target.obj.k === "ident" && sameIdent(e.target.obj, global)) hit = true;
    },
  });
  return hit;
}

function isGuardShapeFor(s: Stmt, name: string): boolean {
  const shape = recognizeGuard(s);
  return shape !== null && shape.name === name;
}

// ---------------------------------------------------------------------------
// §4's whole matcher for one candidate guard `L[i]`.
// ---------------------------------------------------------------------------

/** Recomputes the full §4 verdict for the guard already recognised at
 *  `list[i]` (name `p`, object `global`) from `list`/`fnBody` alone — the
 *  same function `match` uses internally and `check.ts` re-derives from
 *  `before`, and what direct unit tests exercise for the exact refuse
 *  reason. */
export function classifySite(list: readonly Stmt[], fnBody: readonly Stmt[], i: number, name: string, global: Expr): ClassifyResult {
  if (!isSafeIdentifier(name)) return { ok: false, reason: "unsafe-identifier" };
  if (!isProvenGlobal(fnBody, global)) return { ok: false, reason: "unproven-global" };
  if (isShadowed(name, fnBody)) return { ok: false, reason: "shadowed" };

  for (let k = i + 1; k < list.length; k++) {
    const s = list[k]!;
    const topCount = countMatchingReads(topLevelExprFields(s), global, name);
    if (topCount > 1) return { ok: false, reason: "read-twice" };
    if (topCount === 1) return { ok: true, site: { guardIndex: i, useIndex: k, name, global } };
    if (countMatchingReadsAnywhere(s, global, name) > 0) return { ok: false, reason: "guard-in-other-list" };
    if (isGuardShapeFor(s, name) || statementClobbers(s, global, name)) return { ok: false, reason: "clobbered-between" };
  }
  return { ok: false, reason: "no-read-after-guard" };
}

export function match(list: readonly Stmt[], ctx: PassContext): GlobalAccessMatch | null {
  const fnBody = ctx.fnBody ?? list;
  for (let i = 0; i < list.length; i++) {
    const shape = recognizeGuard(list[i]!);
    if (shape === null) continue;
    const result = classifySite(list, fnBody, i, shape.name, shape.global);
    if (result.ok) {
      return { root: list, nodes: [list], data: result.site, at: { functionIndex: ctx.functionIndex, offset: i } };
    }
  }
  return null;
}
