// object-literal matcher — docs/specs/passes/20-object-literal.md §4.
//
// Recognises `rN = {}` / `rN = {k: <literal>, …}` (a fresh `NewObject` /
// `NewObjectWithBuffer`) followed by a contiguous run of own-property
// defines into `rN`, and folds the run back into one object literal at the
// definition.
import { effectSequence, identUses, isPure, isRegisterName, opcodeAt, originOf, renderComputedKey } from "../ast.ts";
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
 *  * `PutNewOwnNEById` (non-enumerable) and `PutOwnByVal`/`DefineOwnByVal`
 *    with the non-enumerable flag — the emitter renders all of these as
 *    `Object.defineProperty`, which is not an `assign` and so never
 *    reaches this matcher anyway (`src/emit/lower.ts`'s `PutOwnByVal`/
 *    `DefineOwnByVal` case only reaches `assign(member(…, true), …)` — the
 *    shape `storeOf`/`computedStoreOf` below match — when the enumerable
 *    flag operand is set).
 *  * `PutOwnGetterSetterByVal`/`DefineOwnGetterSetterByVal` — accessors;
 *    same, they render as `Object.defineProperty` and end the run.
 *  * `DefineOwnInDenseArray…` — array literals, a different rung's job.
 *
 * `PutOwnByVal`/`DefineOwnByVal` (enumerable) ARE in this set: §7 (c),
 * `computedStoreOf` below. When `expr-rebuild` has folded the key operand
 * down to a literal (a compile-time-constant key, register-inlined or a
 * canonical integer) the store looks exactly like any other own-define to
 * `storeOf` — same `CreateDataProperty` semantics, no extra reasoning
 * needed. When it has not, `computedStoreOf` handles the remaining,
 * genuinely dynamic key.
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
  "PutOwnByVal",
  "DefineOwnByVal",
]);

/**
 * docs/BUGS.md `object-literal-computed-key` (§7 (c), narrowed): the subset
 * of {@link OWN_DEFINE} whose key operand may still be a genuinely dynamic
 * expression once `storeOf` has already tried (and failed to find) a
 * literal prop. See `computedStoreOf`'s doc comment for the fold rule.
 */
const OWN_DEFINE_COMPUTED: ReadonlySet<string> = new Set(["PutOwnByVal", "DefineOwnByVal"]);

/**
 * docs/BUGS.md `object-literal-putbyid`. A `PutById`/`PutByIdLoose`/
 * `PutByIdStrict`/`TryPutById` store is a full `[[Set]]` — it is *not*
 * unconditionally an own-property define, because `[[Set]]` walks the
 * prototype chain and would run an inherited accessor (or throw on an
 * inherited non-writable data property) where a literal never would.
 *
 * But on a *fresh* object with nothing yet able to have changed
 * `Object.prototype` since that object was created, `[[Set]]` on a plain
 * data key **is** observably a define: `OrdinarySet` (ECMA-262 10.1.9.2)
 * finds no own property (the object is fresh), walks to the prototype,
 * finds neither an accessor nor a non-writable data property named `key`
 * there (nothing has run that could have put one there — see below), and
 * falls through to `CreateDataProperty` on the receiver — exactly
 * `[[DefineOwnProperty]]`'s own outcome. The one case that is never a
 * define regardless is `key === "__proto__"` (`isProtoKey`, checked as for
 * every other store) — `Object.prototype`'s own `__proto__` **is** an
 * accessor by spec, so `o.__proto__ = v` always calls it and never
 * defines an own `__proto__` data property, fresh object or not.
 *
 * "Nothing has run that could have changed `Object.prototype`" is checked
 * *locally*, over the run being folded, not over the whole program: the
 * matcher already restricts everything between the definition and a store
 * to either (a) an own-property store into this same object (`storeOf`) or
 * (b) a hoistable pure register def (`freshRegisterDef` — no calls, no
 * member reads, by construction of `isPure`), so the only way the run
 * itself could run arbitrary code is a **call inside a store's own value
 * expression** (`o.a = f()`) — `effectSequence` catches that, and any
 * other effect (`new`, a member read that could be a getter, etc.) besides.
 * `runHasEffect` in `match` below is true from the first such value onward,
 * and a `PutById`-family store folds only while it is still false — for
 * every earlier value in the run *and* for its own. A call from *before*
 * the object was even created is out of scope for this rung the same way
 * it always has been: nothing here claims a fresh `{}` proves anything
 * about code that ran before it existed.
 */
const PUT_BY_ID: ReadonlySet<string> = new Set(["PutById", "PutByIdLoose", "PutByIdStrict", "TryPutById"]);

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
  /** How many statements after `defIndex` were folded into a property
   *  (always >= 1) — **not** counting `hoisted` (below). This is the count
   *  the writer/checker use to size the run: `hoisted.length` statements
   *  are moved, not deleted, so they do not change `after.length`. */
  readonly storeCount: number;
  /** The rebuilt property list, in source order. */
  readonly props: readonly ObjectProp[];
  /**
   * docs/BUGS.md `object-literal-interleaved`. Statements found *inside*
   * the run (between `defIndex` and its last fold) that are not stores into
   * `reg` at all, but were proven safe to hoist above the definition — see
   * `canHoist`'s doc comment for the exact commutation rule. In source
   * order; the writer places them, unmodified and in this order, directly
   * before the rebuilt literal.
   */
  readonly hoisted: readonly Stmt[];
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
 * docs/BUGS.md `object-literal-computed-key` (§7 (c)). `s` is
 * `rN[<key-expr>] = v` where `<key-expr>` is NOT a literal — `storeOf`
 * already refused it for exactly that reason, so this is only ever called
 * once `storeOf` has returned `null` for the same statement. Never called
 * for anything but `PutOwnByVal`/`DefineOwnByVal` (`OWN_DEFINE_COMPUTED`),
 * both exactly `CreateDataPropertyOrThrow` when enumerable (`OWN_DEFINE`'s
 * doc comment) — there is no `__proto__`/prototype-chain concern here the
 * way there is for `PUT_BY_ID`, because a computed key is never the
 * seven-character *identifier* `__proto__` at the syntax level (it would
 * have to evaluate to the *string* `"__proto__"` at runtime, which
 * `Object.defineProperty`-equivalent `[[DefineOwnProperty]]` semantics
 * never special-case the way `[[Set]]` does for the literal spelling).
 *
 * `keyExpr` is whatever `expr-rebuild` left in the target's `prop` field —
 * a bare register or free-variable `ident`, a `member` chain
 * (`Foo.bar`, "member-of-const"), or a richer expression (a `call`, …)
 * that `expr-rebuild` already proved safe to inline at exactly this
 * position (`docs/specs/passes/02-expr-rebuild.md`'s R1a/R1b: an impure
 * value only ever moves when the read it fills is the *very next*
 * statement — there is no gap for anything to have run in between). This
 * rung does not need to re-derive that: the caller's own `identUses`
 * check below (against `reg`, same as `storeOf`'s precondition 6 for the
 * value) is the only thing that still has to hold once the key is folded
 * one step earlier still, to the object's definition.
 */
function computedStoreOf(s: Stmt, reg: string): { readonly keyExpr: Expr; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "member" || !target.computed) return null;
  if (target.obj.k !== "ident" || target.obj.name !== reg) return null;
  if (target.prop.k === "lit") return null; // `storeOf`'s territory, not this one's.
  return { keyExpr: target.prop, value };
}

/**
 * §4 precondition 5: `__proto__` in a *non-computed* literal key position is
 * not a property definition at all — it sets the object's prototype. Refused
 * in both spellings so the rule is one line to review, not two.
 */
function isProtoKey(key: string, computed: boolean): boolean {
  return (!computed && key === "__proto__") || (computed && key === '"__proto__"');
}

/**
 * The identity a property's `(key, computed)` pair means, for matching a
 * store against an already-declared `NewObjectWithBuffer` placeholder. The
 * two never spell a canonical integer key the same way: `src/emit/literals`
 * renders it as a *computed*, quoted placeholder (`["1"]`, because `"1"` is
 * not `isSafePropertyName`), while `storeOf`'s `INDEX_KEY` branch always
 * returns it *non-computed* (`1`, per §5 — integer keys are written bare).
 * Without this, the dedup lookup in `match` below would never find the
 * placeholder for an integer key and would wrongly duplicate it instead of
 * replacing it in place (`63-object-literal`'s `table`, v98/v99). Any other
 * key never collides across the two spellings: a non-computed key is always
 * a bare identifier, never equal to a computed key's *quoted* text.
 */
const CANONICAL_INT_KEY = /^"(0|[1-9][0-9]*)"$/;
function keyIdentity(key: string, computed: boolean): string {
  if (computed) {
    const m = CANONICAL_INT_KEY.exec(key);
    if (m !== null) return m[1]!;
  }
  return key;
}

/**
 * docs/BUGS.md `object-literal-interleaved`. `s` is `rX = <pure expr>` —
 * `isPure` (no calls, no member access, no `in`/`instanceof`) means the
 * only things `s` can possibly do are (a) write `rX` and (b) read whatever
 * registers/names appear in the expression; it cannot call anything, throw,
 * or touch a property. That is exactly the shape `canHoist` needs: a
 * candidate whose entire observable behaviour is a register-to-register
 * dataflow edge.
 */
function freshRegisterDef(s: Stmt): { readonly reg: string; readonly value: Expr } | null {
  if (s.k !== "expr" || s.expr.k !== "assign") return null;
  const { target, value } = s.expr;
  if (target.k !== "ident" || !isRegisterName(target.name)) return null;
  if (!isPure(value)) return null;
  return { reg: target.name, value };
}

/** Every register name `e` reads — `e` is proven `isPure`, so this is a
 *  complete, terminating walk of a `lit`/`ident`/`unary`/`bin`/`logical`/
 *  `cond` tree (the only kinds `isPure` accepts). */
function pureExprRegisterReads(e: Expr, out: string[]): void {
  switch (e.k) {
    case "ident":
      if (isRegisterName(e.name)) out.push(e.name);
      return;
    case "unary":
      pureExprRegisterReads(e.arg, out);
      return;
    case "bin":
    case "logical":
      pureExprRegisterReads(e.left, out);
      pureExprRegisterReads(e.right, out);
      return;
    case "cond":
      pureExprRegisterReads(e.test, out);
      pureExprRegisterReads(e.then, out);
      pureExprRegisterReads(e.else, out);
      return;
    default:
      return;
  }
}

/**
 * docs/BUGS.md `object-literal-interleaved`'s commutation check, written
 * down exactly: a candidate `rX = <pure expr>` sitting at `list[j]`, inside
 * a run that starts at `list[i]` (the definition), commutes above the
 * *whole run collected so far* — `list[i..j)` — iff:
 *
 *  1. `rX` is read nowhere in `list[0..j)` — nothing before it (the
 *     definition, an earlier fold's value, an earlier hoisted statement)
 *     observes its value, so writing it earlier changes nothing anyone
 *     already looked at. (Scoped to *this* statement list only: `match` is
 *     called per list, `list[j]` only ever moves within it, so a read in a
 *     different list — necessarily reached later in control flow either
 *     way — is untouched by moving `list[j]` earlier inside this one.)
 *  2. Every register `rX`'s value expression reads has zero writes in
 *     `runNonHoisted` — the definition plus every store *already folded*
 *     (not an earlier hoisted candidate: those move together with `list[j]`
 *     and keep their relative order, so a dependency on one of *them* is
 *     exactly what hoisting is for, not a hazard). If it did, hoisting
 *     `list[j]` above them would make it read a value one of them was the
 *     one to produce, in program order, before `list[j]` ever read it.
 *  3. `rX !== reg` — a candidate may not silently redefine the object being
 *     built.
 *
 * `isPure` already rules out every other way `list[j]` could matter (no
 * call, no throw, no property read/write), so 1–3 are the whole proof:
 * nothing before `j` sees a different value (1), and `list[j]` itself sees
 * the same values it always did, because nothing it reads was written by
 * anything it is hoisted past (2), and it never usurps the object register
 * itself (3).
 */
function canHoist(list: readonly Stmt[], j: number, reg: string, runNonHoisted: readonly Stmt[], candidate: { readonly reg: string; readonly value: Expr }): boolean {
  if (candidate.reg === reg) return false;
  if (identUses(list.slice(0, j), candidate.reg).reads > 0) return false;
  const reads: string[] = [];
  pureExprRegisterReads(candidate.value, reads);
  for (const r of reads) {
    if (identUses(runNonHoisted, r).writes > 0) return false;
  }
  return true;
}

export function match(list: readonly Stmt[], ctx: PassContext): ObjectLiteralMatch | null {
  for (let i = 0; i < list.length; i++) {
    const def = defOf(list[i]!);
    if (def === null) continue;
    const defOp = opcodeOf(list[i]!, ctx);
    if (defOp === null || !FRESH_OBJECT.has(defOp)) continue;

    const props: ObjectProp[] = [...def.props];
    let n = 0;
    const hoisted: Stmt[] = [];
    // Everything the run has consumed so far that is NOT a hoisted
    // candidate — the definition plus every store already folded — used by
    // `canHoist`'s precondition 2. A store's target is always a `member`
    // expression, never a plain register, so the only statement in here
    // that ever counts as *writing* a register is the definition itself.
    const consumed: Stmt[] = [list[i]!];
    // docs/BUGS.md `object-literal-putbyid`: true once any value in the run
    // (including the candidate store's own) has run something that could
    // reach `Object.prototype` — see `PUT_BY_ID`'s doc comment.
    let runHasEffect = false;
    // docs/BUGS.md `object-literal-computed-key` (§7 (c)): true once a
    // *computed*-key store has been folded into `props`. A computed key can
    // alias an earlier literal key at runtime, and this rung cannot tell —
    // `keyIdentity` only ever matches two *literal* spellings of the same
    // key (see its own doc comment), never a dynamic key against anything.
    // The one operation that could observably reorder around that unknown
    // alias is the very next branch's `props[at] = …` — it keeps an
    // existing entry's *printed position* (right, for two literal spellings
    // of the same key) but a literal store folded *after* a computed one
    // would then print, and therefore evaluate, *before* it, even though it
    // ran later — the two writes to whatever key they actually share would
    // swap winners. A fresh `props.push` for a new key never has this
    // problem (push always preserves program order relative to every prior
    // entry, computed or not — the aliasing risk is specific to jumping an
    // existing entry's *position* backwards past an unknown key). Refusing
    // every literal fold once any computed key has been folded — not just
    // the ones that would `props[at] = …` — is the simpler, sufficient rule
    // docs/specs/passes/20-object-literal.md §7 writes down: a computed
    // entry folds only when it is the run's last fold, or every fold after
    // it is also computed.
    let sawComputedKey = false;
    // §4 precondition 2 (as extended by `object-literal-interleaved`): the
    // run is CONTIGUOUS *after* hoisting — a non-store statement first tries
    // to commute above the whole run (`canHoist`) and only ends the run if
    // it cannot. Folding a value across a hoisted statement is sound by
    // `canHoist`'s proof; folding across anything else would move an effect
    // across a statement whose own effect (if any) has not been proven
    // reorderable, so the prefix collected so far is folded on its own.
    for (let j = i + 1; j < list.length; j++) {
      const op = opcodeOf(list[j]!, ctx);
      const st = storeOf(list[j]!, def.reg);
      const isOwnDefine = op !== null && OWN_DEFINE.has(op);
      const isPutById = op !== null && PUT_BY_ID.has(op);
      if (st !== null && !sawComputedKey && (isOwnDefine || isPutById) && !isProtoKey(st.key, st.computed)) {
        // §4 precondition 6: a value that reads (or writes) the half-built
        // object observes it — `r3.b = r3.a + 1` is not a literal.
        const u = identUses([{ k: "expr", expr: st.value }], def.reg);
        const valueHasEffect = effectSequence([{ k: "expr", expr: st.value }]).length > 0;
        // `object-literal-putbyid`: a `PutById`-family store folds only
        // while nothing in the run — including its own value — has had a
        // chance to reach `Object.prototype` yet.
        const putByIdOk = isOwnDefine || (!runHasEffect && !valueHasEffect);
        if (u.reads + u.writes === 0 && putByIdOk) {
          const at = props.findIndex((p) => keyIdentity(p.key, p.computed) === keyIdentity(st.key, st.computed));
          if (at >= 0) {
            // `NewObjectWithBuffer` (v>=97) pre-declares every key with a
            // placeholder literal and fills the non-constant ones in
            // afterwards. Re-defining an existing own data property keeps
            // its *position* and replaces its value, which is exactly what
            // `{k: lit, …, k: v}` means — and the placeholder is a literal,
            // so nothing observable is dropped by not evaluating it twice.
            props[at] = { key: st.key, computed: st.computed, value: st.value };
          } else {
            props.push({ key: st.key, computed: st.computed, value: st.value });
          }
          n++;
          consumed.push(list[j]!);
          runHasEffect = runHasEffect || valueHasEffect;
          continue;
        }
      }
      // §7 (c): `st` is `null` for a genuinely dynamic key (`storeOf`
      // refused it); try `computedStoreOf` before falling through to the
      // hoist attempt. `sawComputedKey` gates nothing here — a *second*
      // computed key never has the aliasing hazard above (`props.push`
      // both times, program order preserved regardless of what either
      // evaluates to at runtime).
      if (st === null && op !== null && OWN_DEFINE_COMPUTED.has(op)) {
        const cst = computedStoreOf(list[j]!, def.reg);
        if (cst !== null) {
          const keyU = identUses([{ k: "expr", expr: cst.keyExpr }], def.reg);
          const valU = identUses([{ k: "expr", expr: cst.value }], def.reg);
          if (keyU.reads + keyU.writes === 0 && valU.reads + valU.writes === 0) {
            props.push({ key: renderComputedKey(cst.keyExpr), computed: true, value: cst.value });
            n++;
            consumed.push(list[j]!);
            sawComputedKey = true;
            continue;
          }
        }
      }
      // Not a foldable store: docs/BUGS.md `object-literal-interleaved` —
      // try to hoist it above the run instead of ending the run outright.
      const fresh = freshRegisterDef(list[j]!);
      if (fresh !== null && canHoist(list, j, def.reg, consumed, fresh)) {
        hoisted.push(list[j]!);
        continue;
      }
      break;
    }
    if (n === 0) continue;
    return { root: list, nodes: [list], data: { reg: def.reg, defIndex: i, storeCount: n, props, hoisted }, at: { functionIndex: ctx.functionIndex, offset: originOf(list[i]!)?.start ?? 0 } };
  }
  return null;
}
