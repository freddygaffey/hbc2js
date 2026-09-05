// docs/specs/05-emitter.md §6 / EM-01 — every emitted identifier must be
// declared in an enclosing emitted scope, OR be a bare identifier the
// decompiler deliberately emitted for a proven global read (an `ident` node
// carrying `global: true`; see `Expr`'s `ident` doc and `src/passes/
// global-access`). The marker is the emitter's licence for the one idiom that
// legitimately produces a free bare name — a host-global read (`print`,
// `console`, `window`, …) folded out of a `"x" in globalThis` guard. An
// unmarked free identifier remains an error, which is what still catches real
// emitter bugs (R1).
//
// This is the R3 guard. hermes-dec ships `_closure1_slot1` identifiers that are
// never declared, and its output throws ReferenceError before semantics are even
// in question; the point of this check is to make that unrepresentable.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Expr, Pattern, Stmt } from "./ast.ts";
import { jsxToCall } from "./ast.ts";

/**
 * Globals the emitter itself names. Everything the *program* touches goes
 * through `globalThis.<name>` (that is what `GetGlobalObject` + `GetById`
 * lowers to), so this list only has to cover the intrinsics our own lowerings
 * mention.
 */
const KNOWN_GLOBALS: ReadonlySet<string> = new Set([
  "globalThis",
  "undefined",
  "Infinity",
  "NaN",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Symbol",
  "BigInt",
  "Math",
  "JSON",
  "Reflect",
  "Promise",
  "RegExp",
  "Function",
  "Error",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "Date",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Proxy",
  "eval",
]);

function declaredBy(stmt: Stmt, into: Set<string>): void {
  switch (stmt.k) {
    case "decl":
      for (const n of stmt.names) into.add(n);
      return;
    case "init":
      into.add(stmt.name);
      return;
    case "func":
      into.add(stmt.name);
      return;
    default:
      return;
  }
}

/** Names a `raw` helper block introduces (`function f(` / `var f =`). */
function declaredByRaw(text: string, into: Set<string>): void {
  for (const m of text.matchAll(/^(?:function\s+([A-Za-z_$][\w$]*)|var\s+([A-Za-z_$][\w$]*))/gm)) {
    const name = m[1] ?? m[2];
    if (name !== undefined) into.add(name);
  }
}

/** One unbound identifier and the chain of emitted function *statements*
 *  (`["module", "_fn321", "_fn4521"]`) it was found under. */
export interface UnboundIdent {
  readonly name: string;
  readonly path: readonly string[];
}

export function unboundMessage(u: UnboundIdent): string {
  return `emitted identifier "${u.name}" is not declared in any enclosing scope (${u.path.join(" > ")})`;
}

function scan(program: readonly Stmt[], helperNames: readonly string[], globalIndex: number, onFail: (u: UnboundIdent) => void): void {
  const root = new Set<string>(KNOWN_GLOBALS);
  for (const n of helperNames) root.add(n);
  root.add(`_fn${globalIndex}`);

  const fail = (name: string, where: readonly string[]): void => {
    onFail({ name, path: [...where] });
  };

  const walkExpr = (e: Expr, scopes: readonly Set<string>[], where: readonly string[]): void => {
    switch (e.k) {
      case "ident":
        // A bare identifier the decompiler deliberately emitted as a proven
        // global read (`e.global`, set only by the `global-access` rung — see
        // `Expr`'s `ident` doc) is intentional, not an unbound-variable bug:
        // accept it even though no module binding declares it. Any *unmarked*
        // free identifier is still an emitter bug (R1) and still throws — that
        // is what keeps `_closure1_slot1`-style leaks unrepresentable.
        if (e.global !== true && !scopes.some((s) => s.has(e.name))) fail(e.name, where);
        return;
      case "lit":
      case "this":
      case "argumentsObject":
        return;
      case "member":
        walkExpr(e.obj, scopes, where);
        if (e.computed) walkExpr(e.prop, scopes, where);
        return;
      case "call":
      case "new":
        walkExpr(e.callee, scopes, where);
        for (const a of e.args) walkExpr(a, scopes, where);
        return;
      case "bin":
      case "logical":
        walkExpr(e.left, scopes, where);
        walkExpr(e.right, scopes, where);
        return;
      case "unary":
        walkExpr(e.arg, scopes, where);
        return;
      case "assign":
        walkExpr(e.target, scopes, where);
        walkExpr(e.value, scopes, where);
        return;
      case "cond":
        walkExpr(e.test, scopes, where);
        walkExpr(e.then, scopes, where);
        walkExpr(e.else, scopes, where);
        return;
      case "array":
        for (const x of e.elements) walkExpr(x, scopes, where);
        return;
      case "object":
        for (const p of e.props) walkExpr("k" in p ? p.arg : p.value, scopes, where);
        return;
      case "spread": // F17
        walkExpr(e.arg, scopes, where);
        return;
      case "seq":
        for (const x of e.exprs) walkExpr(x, scopes, where);
        return;
      case "jsx":
        // D20: a JSX element binds nothing; check exactly the call it stands for.
        walkExpr(jsxToCall(e), scopes, where);
        return;
      case "destructure": {
        // F16: a `pid` leaf is an assignment target to an already-declared
        // register (D14 — this node never introduces a binding), so it must
        // be in scope exactly like a plain `ident` read/write; checked via
        // the same synthetic-`ident` trick `src/passes/ast.ts`'s
        // `walkPattern`/`mapPattern` use for the same reason.
        walkExpr(e.source, scopes, where);
        const walkPatternScope = (p: Pattern): void => {
          if (p.k === "pid") {
            walkExpr({ k: "ident", name: p.name }, scopes, where);
            return;
          }
          const els = p.k === "parr" ? p.elements : p.props.map((prop) => prop.value);
          for (const el of els) {
            if (el.k === "hole") continue;
            walkPatternScope(el.target);
            if (el.k === "pel" && el.init !== undefined) walkExpr(el.init, scopes, where);
          }
        };
        walkPatternScope(e.pattern);
        return;
      }
      case "func": {
        const inner = new Set<string>(e.params.map((x) => x.name));
        collect(e.body, inner);
        // F15: a default's `init` is evaluated in the function's own
        // parameter scope (it may reference an earlier parameter), not the
        // enclosing scope the `func` node itself sits in.
        for (const param of e.params) if (param.init !== undefined) walkExpr(param.init, [...scopes, inner], where);
        walkBody(e.body, [...scopes, inner], where);
        return;
      }
    }
  };

  const collect = (body: readonly Stmt[], into: Set<string>): void => {
    for (const s of body) {
      declaredBy(s, into);
      if (s.k === "raw") declaredByRaw(s.text, into);
    }
  };

  const walkBody = (body: readonly Stmt[], scopes: readonly Set<string>[], where: readonly string[]): void => {
    for (const s of body) walkStmt(s, scopes, where);
  };

  const walkStmt = (s: Stmt, scopes: readonly Set<string>[], where: readonly string[]): void => {
    switch (s.k) {
      case "expr":
        walkExpr(s.expr, scopes, where);
        return;
      case "init":
        walkExpr(s.value, scopes, where);
        return;
      case "if":
        walkExpr(s.test, scopes, where);
        walkNested(s.then, scopes, where);
        walkNested(s.else, scopes, where);
        return;
      case "while":
        if (s.test !== undefined) walkExpr(s.test, scopes, where);
        walkNested(s.body, scopes, where);
        return;
      case "do-while":
        walkExpr(s.test, scopes, where);
        walkNested(s.body, scopes, where);
        return;
      case "for":
        if (s.init !== null) walkExpr(s.init, scopes, where);
        walkExpr(s.test, scopes, where);
        if (s.update !== null) walkExpr(s.update, scopes, where);
        walkNested(s.body, scopes, where);
        return;
      case "labeled":
        walkNested(s.body, scopes, where);
        return;
      case "iife": {
        const inner = new Set<string>();
        collect(s.body, inner);
        walkBody(s.body, [...scopes, inner], where);
        return;
      }
      case "return":
        if (s.arg !== null) walkExpr(s.arg, scopes, where);
        return;
      case "throw":
        walkExpr(s.arg, scopes, where);
        return;
      case "try": {
        walkNested(s.block, scopes, where);
        const handlerScope = new Set<string>(s.param === null ? [] : [s.param]);
        const nested = new Set<string>();
        collect(s.handler, nested);
        walkBody(s.handler, [...scopes, handlerScope, nested], where);
        return;
      }
      case "switch":
        walkExpr(s.disc, scopes, where);
        for (const c of s.cases) {
          if (c.test !== null) walkExpr(c.test, scopes, where);
          walkNested(c.body, scopes, where);
        }
        return;
      case "func": {
        const inner = new Set<string>(s.params.map((x) => x.name));
        collect(s.body, inner);
        for (const param of s.params) if (param.init !== undefined) walkExpr(param.init, [...scopes, inner], where);
        walkBody(s.body, [...scopes, inner], [...where, s.name]);
        return;
      }
      default:
        return;
    }
  };

  /** A nested statement list shares the function scope but may add block-scoped names. */
  const walkNested = (body: readonly Stmt[], scopes: readonly Set<string>[], where: readonly string[]): void => {
    const inner = new Set<string>();
    collect(body, inner);
    walkBody(body, inner.size === 0 ? scopes : [...scopes, inner], where);
  };

  collect(program, root);
  walkBody(program, [root], ["module"]);
}

/** EM-01, throwing form: the first unbound identifier is `E_UNBOUND_IDENT`. */
export function checkBindings(program: readonly Stmt[], helperNames: readonly string[], globalIndex: number): void {
  scan(program, helperNames, globalIndex, (u) => {
    throw new Hbc2jsError(ErrorCode.E_UNBOUND_IDENT, unboundMessage(u), { section: "emit/scope-check" });
  });
}

/**
 * EM-01, collecting form: every unbound identifier in the program, each with
 * the chain of function statements it sits under, so `emitModule` can isolate
 * the offending functions instead of losing the whole module's output
 * (docs/BUGS.md 2026-09-01 Service NSW; 2026-09-04 react-navigation).
 * The same (path, name) pair is reported once.
 */
export function collectUnbound(program: readonly Stmt[], helperNames: readonly string[], globalIndex: number): readonly UnboundIdent[] {
  const out: UnboundIdent[] = [];
  const seen = new Set<string>();
  scan(program, helperNames, globalIndex, (u) => {
    const key = `${u.path.join(">")}|${u.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(u);
  });
  return out;
}
