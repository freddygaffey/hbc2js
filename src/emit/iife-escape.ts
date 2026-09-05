// docs/specs/passes/27-iife-reconstruct.md section 9 -- ESCAPE ANALYSIS for the
// object an inlined IIFE fills in.
//
// The dominant blocker section 7 measured is the property store an inlined IIFE
// ends with (`out.f = <closure>`, `arr[0] = <closure>`): a member store may run
// a setter and a null base throws, so `src/emit/iife-group.ts` refuses to move
// one. This module proves the special case that unblocks the idiom -- a store
// into an object THIS function has just allocated and has not let out of its
// hands, where no setter, getter or proxy can exist to observe the order.
//
// Everything here is syntactic and conservative: any use of a base the walk
// cannot classify is an escape (section 9.4's refusal codes). The one premise
// that is not proved is A-PROTO (section 9.5): a fresh array/object literal
// still consults its intrinsic prototype for an accessor named by the key.
import type { Expr, Stmt } from "./ast.ts";

/** Section 9.4. */
export type EscapeCode = "E_NOT_FRESH" | "E_REASSIGNED" | "E_ESCAPES_CALL" | "E_ESCAPES_STORE" | "E_ESCAPES_CLOSURE" | "E_KEY_NOT_LITERAL" | "E_VALUE_NOT_PURE";

export interface EscapeInfo {
  /** Name -> index of the allocation that makes it fresh. A member access on
   *  the name at a LATER top-level index of the region is order-independent
   *  (section 9.2); one at or before it is not covered. */
  readonly fresh: ReadonlyMap<string, number>;
  /** Why a name used as a member base in the region is not fresh. */
  readonly codes: ReadonlyMap<string, EscapeCode>;
}

/** F1: an allocation no user code can observe. `new Array(<lit>)` qualifies
 *  only through `fromNewArray`, the marker `src/emit/lower.ts` puts on its
 *  rendering of the `NewArray`/`NewFastArray` opcode -- a source-level
 *  `new Array(x)` is a global read plus a construct and never carries it. */
export function isFreshAlloc(e: Expr): boolean {
  switch (e.k) {
    case "array":
      return e.elements.every((el) => isPureOperand(el));
    case "object":
      return e.props.every((p) => !("k" in p) && !p.computed && isPureOperand(p.value));
    case "new":
      return e.fromNewArray === true && e.args.every((a) => a.k === "lit");
    default:
      return false;
  }
}

function isPureOperand(e: Expr): boolean {
  return e.k === "lit" || e.k === "ident" || (e.k === "array" && e.elements.every(isPureOperand));
}

/** The statement's `n = <expr>` shape, or null. */
export function assignedName(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident") return { name: s.expr.target.name, value: s.expr.value };
  return null;
}

type UseCtx = "call" | "value";

/** Reports every occurrence of `name` that is NOT the base of a member access,
 *  with the refusal code it earns. A nested function is never entered: any
 *  mention inside one is a capture (F4). */
function scanUses(node: unknown, name: string, ctx: UseCtx, hit: (code: EscapeCode) => void): void {
  if (Array.isArray(node)) {
    for (const el of node) scanUses(el, name, ctx, hit);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  const k = typeof n["k"] === "string" ? (n["k"] as string) : null;
  switch (k) {
    case "ident":
      if (n["name"] === name) hit(ctx === "call" ? "E_ESCAPES_CALL" : "E_ESCAPES_STORE");
      return;
    case "member":
      // The base itself is the ONE allowed use; the key is an ordinary read.
      if (!isIdent(n["obj"], name)) scanUses(n["obj"], name, ctx, hit);
      scanUses(n["prop"], name, ctx, hit);
      return;
    case "call":
    case "optcall":
    case "new":
    case "tagged":
      for (const v of Object.values(n)) scanUses(v, name, "call", hit);
      return;
    case "assign":
      if (isIdent(n["target"], name)) hit("E_REASSIGNED");
      else scanUses(n["target"], name, ctx, hit);
      scanUses(n["value"], name, ctx, hit);
      return;
    case "func":
      if (mentionsName(n["body"], name) || mentionsName(n["params"], name)) hit("E_ESCAPES_CLOSURE");
      return;
    case "class":
      if (mentionsName(n["members"], name)) hit("E_ESCAPES_CLOSURE");
      return;
    default:
      for (const v of Object.values(n)) scanUses(v, name, ctx, hit);
  }
}

function isIdent(node: unknown, name: string): boolean {
  return node !== null && typeof node === "object" && (node as Record<string, unknown>)["k"] === "ident" && (node as Record<string, unknown>)["name"] === name;
}

/** Any mention of the name at all, nested functions included. */
export function mentionsName(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((el) => mentionsName(el, name));
  if (node === null || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n["k"] === "ident" && n["name"] === name) return true;
  if ((n["k"] === "decl" && Array.isArray(n["names"]) && (n["names"] as unknown[]).includes(name)) || (n["k"] === "init" && n["name"] === name)) return true;
  if ((n["k"] === "func" || n["k"] === "classdecl") && n["name"] === name) return true;
  return Object.values(n).some((v) => mentionsName(v, name));
}

/** Names used as the base of a member access at a top-level index of the
 *  region -- the candidates worth proving fresh. */
function memberBases(s: Stmt, out: Set<string>): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const el of node) visit(el);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if ((n["k"] === "member" || n["k"] === "optmember") && isIdentNode(n["obj"])) out.add((n["obj"] as Record<string, unknown>)["name"] as string);
    for (const v of Object.values(n)) visit(v);
  };
  visit(s);
}

function isIdentNode(node: unknown): boolean {
  return node !== null && typeof node === "object" && (node as Record<string, unknown>)["k"] === "ident";
}

/**
 * Section 9.1: which names are provably fresh, non-escaping allocations over
 * the region `[lo, hi]` of `body`. `outer` is the rest of the function's
 * statements (the emitter's header) -- scanned for F4 only, since a closure
 * hosted there can be called from inside the region.
 */
export function analyseEscapes(body: readonly Stmt[], lo: number, hi: number, outer: readonly Stmt[] = []): EscapeInfo {
  const fresh = new Map<string, number>();
  const codes = new Map<string, EscapeCode>();

  hi = Math.min(hi, body.length - 1);
  const bases = new Set<string>();
  for (let i = lo; i <= hi; i++) memberBases(body[i]!, bases);
  if (bases.size === 0) return { fresh, codes };

  // F1: the last allocation of each candidate inside the region.
  const alloc = new Map<string, number>();
  for (let i = lo; i <= hi; i++) {
    const a = assignedName(body[i]!);
    if (a === null || !bases.has(a.name)) continue;
    // The LAST fresh allocation wins; a later non-fresh assignment is left for
    // the F2/F3 walk below to report as `E_REASSIGNED`.
    if (isFreshAlloc(a.value)) alloc.set(a.name, i);
  }

  for (const name of [...bases].sort()) {
    const at = alloc.get(name);
    if (at === undefined) {
      codes.set(name, "E_NOT_FRESH");
      continue;
    }
    let code: EscapeCode | null = null;
    const hit = (c: EscapeCode): void => {
      code ??= c;
    };
    // F4 first: a capture anywhere in the function is fatal whatever the
    // region does, because any call in the region might reach the closure.
    for (const s of outer) if (containsFuncMentioning(s, name)) hit("E_ESCAPES_CLOSURE");
    for (const s of body) if (containsFuncMentioning(s, name)) hit("E_ESCAPES_CLOSURE");
    // F2/F3 over (at, hi].
    for (let i = at + 1; i <= hi && code === null; i++) scanUses(body[i]!, name, "value", hit);
    if (code !== null) codes.set(name, code);
    else fresh.set(name, at);
  }
  return { fresh, codes };
}

function containsFuncMentioning(node: unknown, name: string): boolean {
  if (Array.isArray(node)) return node.some((el) => containsFuncMentioning(el, name));
  if (node === null || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n["k"] === "func" || n["k"] === "class") return mentionsName(n["body"] ?? n["members"], name) || mentionsName(n["params"], name);
  return Object.values(n).some((v) => containsFuncMentioning(v, name));
}
