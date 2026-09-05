// class-recover matcher -- docs/specs/passes/24-class-recover.md sections 3.1
// and 4, catalogue row 20. Stage B, provenance-driven: a site exists only
// where `classSiteAt` reports a real `CreateBaseClass`/`CreateDerivedClass`
// behind the statement (F24-2). Shape alone cannot separate a class from an
// ES5-transpiled one (spec 24 sections 1.5 and 1.8), so shape is never asked
// first.
import type { ClassMember, Expr, Stmt } from "../ast.ts";
import { classSiteAt, freeNames, isPure, originOf } from "../ast.ts";
import type { ClassSite } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

/** What the writer needs, and what the checker re-derives (section 3.1). */
export interface ClassGroup {
  readonly site: ClassSite;
  /** The class name, from the constructor's function-table entry (F24-4). */
  readonly className: string | null;
  /** The register the class value is bound to (the head statement's target). */
  readonly ctorName: string;
  readonly superClass: Expr | null;
  /** Members in install order -- the order the instructions ran in. */
  readonly members: readonly ClassMember[];
  /** Index of the head statement, whose value the writer replaces. */
  readonly headIndex: number;
  /** Indices of the statements the writer deletes (never the head). */
  readonly deleted: readonly number[];
  /** Names of the `func` declarations moved into the class body. */
  readonly movedNames: readonly string[];
}

/** Section 4's refusal families, one counted reason each. */
export type Refusal =
  | "no-class-site"
  | "no-function-meta"
  | "group-interrupted"
  | "unresolved-key"
  | "method-escapes"
  | "private-members"
  | "enumerable-member"
  | "ctor-not-in-body"
  | "method-not-in-body"
  | "no-members";

const REFUSED_ONCE = new WeakMap<object, Set<string>>();

/** Report a refusal exactly once per (function, offset, reason): `match` runs
 *  again after every accepted site, and a site it refuses is re-examined each
 *  time. `PassContext.diagnostic` is the only histogram a rung that refuses in
 *  `match` (rather than in `check`) can reach. */
function refuse(ctx: PassContext, offset: number, reason: Refusal): null {
  const key = (ctx.cfg ?? ctx) as object;
  let seen = REFUSED_ONCE.get(key);
  if (seen === undefined) {
    seen = new Set<string>();
    REFUSED_ONCE.set(key, seen);
  }
  const id = `${ctx.functionIndex}@${offset}:${reason}`;
  if (seen.has(id)) return null;
  seen.add(id);
  ctx.diagnostic?.({ severity: "info", code: "W_PASS_ABANDONED", message: `pass class-recover left fn#${ctx.functionIndex} @${offset} as is: ${reason}`, context: { functionIndex: ctx.functionIndex, offset } });
  return null;
}

const identName = (e: Expr): string | null => (e.k === "ident" ? e.name : null);

/** `Object.<name>(...)` with the emitter's own spelling (`prop()` in
 *  `src/emit/lower.ts` builds a non-computed member with a `lit` property). */
function objectCall(e: Expr, name: string): readonly Expr[] | null {
  if (e.k !== "call" || e.callee.k !== "member" || e.callee.computed) return null;
  if (identName(e.callee.obj) !== "Object") return null;
  const p = e.callee.prop;
  if (p.k !== "lit" || p.text !== name) return null;
  return e.args;
}

/** `<expr>.prototype`, non-computed. */
function prototypeOf(e: Expr): Expr | null {
  if (e.k !== "member" || e.computed) return null;
  return e.prop.k === "lit" && e.prop.text === "prototype" ? e.obj : null;
}

/** A statement of the form `<ident> = <expr>`. */
function simpleStore(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const name = identName(s.expr.target);
  return name === null ? null : { name, value: s.expr.value };
}

interface Descriptor {
  readonly kind: "method" | "get" | "set";
  readonly fn: Expr;
  readonly enumerable: boolean;
}

function readDescriptor(e: Expr): Descriptor | null {
  if (e.k !== "object") return null;
  let kind: Descriptor["kind"] | null = null;
  let fn: Expr | null = null;
  let enumerable = true;
  let seen = 0;
  for (const p of e.props) {
    if ("k" in p) return null; // a spread in the descriptor: not the emitter's shape
    if (p.computed) return null;
    if (p.key === "value" || p.key === "get" || p.key === "set") {
      if (kind !== null) return null; // a `{get, set}` pair in ONE descriptor is the object-literal shape (section 1.5)
      kind = p.key === "value" ? "method" : p.key;
      fn = p.value;
      seen++;
      continue;
    }
    if (p.key === "enumerable") {
      enumerable = p.value.k === "lit" && p.value.text === "true";
      seen++;
      continue;
    }
    if (p.key === "configurable") {
      if (!(p.value.k === "lit" && p.value.text === "true")) return null;
      seen++;
      continue;
    }
    return null; // `writable`/anything else: an instance install, not a class-body member (R-C6)
  }
  return kind === null || fn === null || seen !== e.props.length ? null : { kind, fn, enumerable };
}

export function match(list: readonly Stmt[], ctx: PassContext): Match<readonly Stmt[], ClassGroup> | null {
  if (ctx.fnBody === undefined || list !== ctx.fnBody) return null; // F1: one site per function body
  if (ctx.cfg === undefined) return null;
  for (let i = 0; i < list.length; i++) {
    const head = simpleStore(list[i]!);
    if (head === null || head.value.k === "class") continue; // PL-08 fixed point: already recovered
    const origin = originOf(list[i]!);
    if (origin === undefined || origin.fn !== ctx.functionIndex) continue;
    const site = classSiteAt(ctx.cfg, origin.start);
    if (site === null) continue;
    const m = buildGroup(list, i, head.name, site, ctx);
    if (m !== null) return { root: list, nodes: [list], data: m, at: { functionIndex: ctx.functionIndex, offset: site.offset } };
  }
  return null; // R-C0 no-class-site: nothing read, nothing reported
}

/** Section 3.1's group walk. Returns `null` (after counting a refusal) for
 *  every family of section 4. */
function buildGroup(list: readonly Stmt[], headIndex: number, ctorName: string, site: ClassSite, ctx: PassContext): ClassGroup | null {
  const off = site.offset;
  const meta = ctx.functionMeta?.(site.ctorFnIdx) ?? null;
  if (meta === null || meta.role !== "ctor") return refuse(ctx, off, "no-function-meta"); // R-C2

  const ctorAliases = new Set<string>([ctorName]);
  const protoAliases = new Set<string>();
  const regValues = new Map<string, Expr>();
  const members: ClassMember[] = [];
  const deleted: number[] = [];
  const movedNames: string[] = [];
  let superClass: Expr | null = null;
  let sawCtorLink = false;
  let sawProtoLink = false;

  /** The single reaching definition of a register inside the group, if it is
   *  one (R-C4: more than one, or none, is a refusal at the use site). */
  const resolve = (e: Expr): Expr | null => {
    const name = identName(e);
    if (name === null) return e;
    return regValues.get(name) ?? e;
  };

  const declarationIndex = new Map<string, number>();
  for (let j = 0; j < list.length; j++) {
    const s = list[j]!;
    if (s.k === "func") declarationIndex.set(s.name, j);
  }

  // R-C4's "single reaching definition": v99 hoists a repeated method-name
  // string into a register *before* the class-creation site and reuses it
  // across several classes (spec 24 section 1.2's `r9`/`r8`), so the reaching
  // definitions of the statements ahead of the head are part of the picture.
  // Any statement that is not a plain top-level store can have written a
  // register out of sight (a loop body, a branch, a handler), so it clears the
  // map rather than being reasoned about.
  for (let j = 0; j < headIndex; j++) {
    const s = list[j]!;
    if (s.k === "comment" || s.k === "directive" || s.k === "decl" || s.k === "func") continue;
    const store = s.k === "expr" ? simpleStore(s) : null;
    if (store === null) {
      if (s.k !== "expr") regValues.clear();
      continue;
    }
    if (isPure(store.value)) regValues.set(store.name, store.value);
    else regValues.delete(store.name);
  }

  for (let j = headIndex + 1; j < list.length; j++) {
    const s = list[j]!;
    const store = simpleStore(s);
    if (store !== null) {
      const base = prototypeOf(store.value);
      const baseName = base === null ? null : identName(base);
      if (baseName !== null && ctorAliases.has(baseName)) {
        // `rN = <ctor>.prototype`: kept, not deleted -- a later statement may
        // still read it (fixture 33 stores it into an environment slot).
        protoAliases.add(store.name);
        ctorAliases.delete(store.name);
        continue;
      }
      const valueName = identName(store.value);
      if (valueName !== null && protoAliases.has(valueName)) {
        protoAliases.add(store.name);
        ctorAliases.delete(store.name);
        continue;
      }
      if (valueName !== null && ctorAliases.has(valueName)) break; // a copy of the class value escapes the group (section 3.1 item 4)
      if (!isPure(store.value)) break;
      if (mentions(store.value, ctorAliases) || mentions(store.value, protoAliases)) return refuse(ctx, off, "group-interrupted"); // R-C3
      ctorAliases.delete(store.name);
      protoAliases.delete(store.name);
      regValues.set(store.name, store.value);
      continue;
    }
    if (s.k !== "expr") break;

    const setProto = objectCall(s.expr, "setPrototypeOf");
    if (setProto !== null && setProto.length === 2) {
      const targetName = identName(setProto[0]!);
      if (!sawCtorLink && targetName !== null && ctorAliases.has(targetName)) {
        if (!site.derived) return refuse(ctx, off, "group-interrupted");
        superClass = setProto[1]!;
        sawCtorLink = true;
        deleted.push(j);
        continue;
      }
      const protoTarget = targetName !== null && protoAliases.has(targetName) ? true : isAliasedPrototype(setProto[0]!, ctorAliases);
      if (sawCtorLink && !sawProtoLink && protoTarget) {
        sawProtoLink = true;
        deleted.push(j);
        continue;
      }
      break;
    }

    const args = objectCall(s.expr, "defineProperty");
    if (args === null || args.length !== 3) break;
    const targetName = identName(args[0]!);
    const isStatic = targetName !== null && ctorAliases.has(targetName);
    const onProto = targetName !== null && protoAliases.has(targetName);
    if (!isStatic && !onProto) break; // R-C1 no-provenance: not our object at all
    const descriptor = readDescriptor(args[2]!);
    if (descriptor === null) return refuse(ctx, off, "private-members"); // R-C6: an instance/`writable` install
    if (descriptor.enumerable) return refuse(ctx, off, "enumerable-member"); // R-C7
    const key = resolve(args[1]!);
    if (key === null || key.k !== "lit") return refuse(ctx, off, "unresolved-key"); // R-C4
    const fnRef = resolve(descriptor.fn);
    if (fnRef === null) return refuse(ctx, off, "unresolved-key");
    const fnName = identName(fnRef);
    if (fnName === null) return refuse(ctx, off, "unresolved-key");
    const declAt = declarationIndex.get(fnName);
    if (declAt === undefined) return refuse(ctx, off, "method-not-in-body"); // R-C11 (F24-5)
    const decl = list[declAt] as Extract<Stmt, { k: "func" }>;
    members.push({ kind: descriptor.kind, static: isStatic, computed: false, key, value: { k: "func", name: null, params: decl.params, body: decl.body } });
    movedNames.push(fnName);
    deleted.push(j, declAt);
    // The register store that fed the descriptor exists only to feed it.
    const feedIndex = storeFeeding(list, headIndex, j, descriptor.fn, fnName);
    if (feedIndex !== null) deleted.push(feedIndex);
    continue;
  }

  if (site.derived && !(sawCtorLink && sawProtoLink)) return refuse(ctx, off, "group-interrupted");
  if (members.length === 0) return refuse(ctx, off, "no-members");

  // The constructor's own body must be reachable in this statement list, or
  // the class would silently lose it (F24-5 / PUSHBACK P-38).
  const ctorRef = identName(headValue(list[headIndex]!));
  if (ctorRef === null) return refuse(ctx, off, "group-interrupted");
  const ctorDeclAt = declarationIndex.get(ctorRef);
  if (ctorDeclAt === undefined) return refuse(ctx, off, "ctor-not-in-body"); // R-C12 (F24-5)
  const ctorDecl = list[ctorDeclAt] as Extract<Stmt, { k: "func" }>;
  const all: ClassMember[] = [{ kind: "method", static: false, computed: false, key: { k: "ident", name: "constructor" }, value: { k: "func", name: null, params: ctorDecl.params, body: ctorDecl.body } }, ...members];
  deleted.push(ctorDeclAt);
  movedNames.push(ctorRef);

  const group: ClassGroup = {
    site,
    className: meta.name.length > 0 && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(meta.name) ? meta.name : null,
    ctorName,
    superClass,
    members: all,
    headIndex,
    deleted: [...new Set(deleted)].sort((a, b) => a - b),
    movedNames,
  };

  // R-C5: a moved declaration referenced anywhere else stays a declaration,
  // which this rung cannot express -- so the whole group is refused.
  const after = buildAfter(list, group);
  const free = freeNames(after);
  for (const name of movedNames) if (free.has(name)) return refuse(ctx, off, "method-escapes");
  return group;
}

function headValue(s: Stmt): Expr {
  const store = simpleStore(s);
  return store === null ? { k: "lit", text: "undefined" } : store.value;
}

/** The `rN = <fnName>` store between the head and the install that consumed
 *  it, when the descriptor read the closure through a register. */
function storeFeeding(list: readonly Stmt[], from: number, to: number, descriptorFn: Expr, fnName: string): number | null {
  const via = descriptorFn.k === "ident" ? descriptorFn.name : null;
  if (via === null || via === fnName) return null;
  for (let j = to - 1; j > from; j--) {
    const store = simpleStore(list[j]!);
    if (store !== null && store.name === via) return store.value.k === "ident" && store.value.name === fnName ? j : null;
  }
  return null;
}

/** The aliased-register form of section 1.4: with `dst_ctor === dst_prototype`
 *  the emitter addresses the prototype as `<ctor>.prototype`. */
function isAliasedPrototype(e: Expr, ctorAliases: ReadonlySet<string>): boolean {
  const base = prototypeOf(e);
  const name = base === null ? null : identName(base);
  return name !== null && ctorAliases.has(name);
}

function mentions(e: Expr, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  let found = false;
  const visit = (x: Expr): void => {
    if (found) return;
    if (x.k === "ident" && names.has(x.name)) found = true;
    else if (x.k === "member") {
      visit(x.obj);
      visit(x.prop);
    } else if (x.k === "call" || x.k === "new") {
      visit(x.callee);
      x.args.forEach(visit);
    } else if (x.k === "bin" || x.k === "logical") {
      visit(x.left);
      visit(x.right);
    } else if (x.k === "unary") visit(x.arg);
    else if (x.k === "cond") {
      visit(x.test);
      visit(x.then);
      visit(x.else);
    }
  };
  visit(e);
  return found;
}

/**
 * The writer, shared with the checker so "rebuild the group from `after`"
 * (section 3.4 item 1) compares two products of the same function. Every
 * surviving sub-expression is carried over `===`-identical.
 */
export function buildAfter(list: readonly Stmt[], g: ClassGroup): readonly Stmt[] {
  const drop = new Set(g.deleted);
  const cls: Expr = { k: "class", name: g.className, superClass: g.superClass, members: g.members };
  const out: Stmt[] = [];
  for (let i = 0; i < list.length; i++) {
    if (drop.has(i)) continue;
    if (i !== g.headIndex) {
      out.push(list[i]!);
      continue;
    }
    const s = list[i]! as Extract<Stmt, { k: "expr" }>;
    out.push({ ...s, expr: { k: "assign", target: { k: "ident", name: g.ctorName }, value: cls } });
  }
  return out;
}
