// object-literal matcher — docs/specs/passes/20-object-literal.md §4.
//
// Recognises `rN = {}` / `rN = {k: <literal>, …}` (a fresh `NewObject` /
// `NewObjectWithBuffer`) followed by a contiguous run of own-property
// defines into `rN`, and folds the run back into one object literal at the
// definition.
import { identUses, isRegisterName, opcodeAt, originOf } from "../ast.ts";
import type { Expr, ObjectProp, Stmt } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

/**
 * §2: the opcodes that create a **fresh, ordinary** object — one whose
 * prototype is `%ObjectPrototype%` and which has no own properties beyond
 * the literal key/value buffer the emitter already rendered.
 * `NewObjectWithParent`/`NewObjectWithBufferAndParent` are deliberately
 * absent: their prototype is a runtime value, so the rebuilt literal would
 * silently drop the `Object.create`/`__proto__` the source had.
 */
const FRESH_OBJECT: ReadonlySet<string> = new Set(["NewObject", "NewObjectWithBuffer", "NewObjectWithBufferLong"]);

/**
 * §2/§4 precondition 4: the store opcodes whose semantics are **exactly**
 * `CreateDataPropertyOrThrow` — an own, enumerable, writable, configurable
 * data property, defined without consulting the prototype chain. These are
 * the only ones a literal's `key: value` is equivalent to.
 *
 * Deliberately absent (see §7's refusal table):
 *  * `PutById`/`PutByIdLoose`/`PutByIdStrict`/`TryPutById`/`PutByVal…` —
 *    a full `[[Set]]`: it walks the prototype chain, so an accessor or a
 *    non-writable data property on `Object.prototype` observes the store
 *    (and, in strict mode, makes it throw) where a literal's own define
 *    never would. `o = {}; o.a = v` is therefore NOT `o = {a: v}`.
 *  * `PutNewOwnNEById` (non-enumerable) and `PutOwnByVal` with the
 *    non-enumerable flag — the emitter renders both as
 *    `Object.defineProperty`, which is not an `assign` and so never
 *    reaches this matcher anyway.
 *  * `PutOwnGetterSetterByVal`/`DefineOwnGetterSetterByVal` — accessors;
 *    same, they render as `Object.defineProperty` and end the run.
 *  * `PutOwnByVal`/`DefineOwnByVal` (enumerable) — a computed key whose
 *    key *expression* would have to move along with the value; deferred.
 *  * `DefineOwnInDenseArray…` — array literals, a different rung's job.
 */
const OWN_DEFINE: ReadonlySet<string> = new Set([
  "PutNewOwnById",
  "PutNewOwnByIdLong",
  "PutNewOwnByIdShort",
  "DefineOwnById",
  "DefineOwnByIdLong",
  "PutOwnByIndex",
  "PutOwnByIndexL",
  "DefineOwnByIndex",
  "DefineOwnByIndexL",
  "PutOwnBySlotIdx",
  "PutOwnBySlotIdxLong",
]);

/** `{ a: 1 }`'s `a` — the exact set `src/emit`'s `isSafePropertyName` lets
 *  through as a bare (non-computed) member name. Kept as a regex here rather
 *  than imported, because a *narrower* test than the emitter's is always
 *  safe: it only ever refuses a site. */
const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** A canonical array index, as `PutOwnByIndex` renders it (`num()`). */
const INDEX_KEY = /^(?:0|[1-9][0-9]*)$/;

export interface ObjectLiteralSite {
  /** The register the object is built in. */
  readonly reg: string;
  /** Index, in the matched statement list, of the `rN = {…}` definition. */
  readonly defIndex: number;
  /** How many statements after `defIndex` were folded in (always >= 1). */
  readonly storeCount: number;
  /** The rebuilt property list, in source order. */
  readonly props: readonly ObjectProp[];
}

export type ObjectLiteralMatch = Match<readonly Stmt[], ObjectLiteralSite>;

function opcodeOf(s: Stmt, ctx: PassContext): string | null {
  const o = originOf(s);
  if (o === undefined || o.fn !== ctx.functionIndex) return null;
  return opcodeAt(ctx.cfg, o.start);
}

/** §4 precondition 1: `rN = <object literal of literals>`. */
function defOf(s: Stmt): { readonly reg: string; readonly props: readonly ObjectProp[] } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "ident" || !isRegisterName(target.name)) return null;
  if (value.k !== "object") return null;
  const props: ObjectProp[] = [];
  for (const p of value.props) {
    // A `spreadProp` is never in a `NewObject…` rendering, and a non-literal
    // value would mean this list has already been rewritten once (PL-08).
    if ("k" in p) return null;
    if (p.value.k !== "lit") return null;
    props.push(p);
  }
  return { reg: target.name, props };
}

/** §4 precondition 3: `rN.key = v` / `rN[0] = v` with a statically known key. */
function storeOf(s: Stmt, reg: string): { readonly key: string; readonly computed: boolean; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "member") return null;
  if (target.obj.k !== "ident" || target.obj.name !== reg) return null;
  if (target.prop.k !== "lit") return null;
  const text = target.prop.text;
  if (!target.computed) {
    // `o.k = v`: `text` is the bare name the emitter's `prop()` produced.
    if (!SAFE_KEY.test(text)) return null;
    return { key: text, computed: false, value };
  }
  // `o[0] = v` (`PutOwnByIndex`): an integer key prints bare in a literal
  // and means the very same property key string.
  if (INDEX_KEY.test(text)) return { key: text, computed: false, value };
  // `o["not an ident"] = v`: keep the quoted form, as a computed key. A
  // computed key never triggers the `__proto__` special case, but it is
  // refused below anyway so that one rule covers both spellings.
  if (text.startsWith('"') && text.endsWith('"')) return { key: text, computed: true, value };
  return null;
}

/**
 * §4 precondition 5: `__proto__` in a *non-computed* literal key position is
 * not a property definition at all — it sets the object's prototype. Refused
 * in both spellings so the rule is one line to review, not two.
 */
function isProtoKey(key: string, computed: boolean): boolean {
  return (!computed && key === "__proto__") || (computed && key === '"__proto__"');
}

export function match(list: readonly Stmt[], ctx: PassContext): ObjectLiteralMatch | null {
  for (let i = 0; i < list.length; i++) {
    const def = defOf(list[i]!);
    if (def === null) continue;
    const defOp = opcodeOf(list[i]!, ctx);
    if (defOp === null || !FRESH_OBJECT.has(defOp)) continue;

    const props: ObjectProp[] = [...def.props];
    let n = 0;
    // §4 precondition 2: the run is CONTIGUOUS. Everything a folded value
    // expression crosses on its way to the definition is the definition
    // itself, and creating an object is unobservable — so no effect can be
    // reordered. A non-store statement (or a refused store) ends the run and
    // the prefix collected so far is folded on its own.
    for (let j = i + 1; j < list.length; j++) {
      const st = storeOf(list[j]!, def.reg);
      if (st === null) break;
      const op = opcodeOf(list[j]!, ctx);
      if (op === null || !OWN_DEFINE.has(op)) break;
      if (isProtoKey(st.key, st.computed)) break;
      // §4 precondition 6: a value that reads (or writes) the half-built
      // object observes it — `r3.b = r3.a + 1` is not a literal.
      const u = identUses([{ k: "expr", expr: st.value }], def.reg);
      if (u.reads + u.writes > 0) break;
      const at = props.findIndex((p) => p.key === st.key && p.computed === st.computed);
      if (at >= 0) {
        // `NewObjectWithBuffer` (v>=97) pre-declares every key with a
        // placeholder literal and fills the non-constant ones in afterwards.
        // Re-defining an existing own data property keeps its *position* and
        // replaces its value, which is exactly what `{k: lit, …, k: v}`
        // means — and the placeholder is a literal, so nothing observable is
        // dropped by not evaluating it twice.
        props[at] = { key: st.key, computed: st.computed, value: st.value };
      } else {
        props.push({ key: st.key, computed: st.computed, value: st.value });
      }
      n++;
    }
    if (n === 0) continue;
    return { root: list, nodes: [list], data: { reg: def.reg, defIndex: i, storeCount: n, props }, at: { functionIndex: ctx.functionIndex, offset: originOf(list[i]!)?.start ?? 0 } };
  }
  return null;
}
