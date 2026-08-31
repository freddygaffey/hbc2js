// template-literal matcher — docs/LOWERING-CATALOGUE.md row 21,
// docs/specs/passes/14-template-literal.md §4.
//
// Site = one statement list `L`. Two rules:
//
//   T1  `Reflect.apply(__hbc_HermesInternal.concat, C0, [S0, C1, S1, …])`
//       (the `-O` *and* `-O0` lowering of a template literal with >= 1
//       substitution — measured at v94 and v99, see
//       docs/lowering/template-literals.md) -> `` `C0${S0}C1${S1}…` ``
//   T2  `rT = __hbc_b_getTemplateObject(id, dup, …strings)` followed, in the
//       same list, by `call(TAG, [rT, …SUBS])` -> `` TAG`raw0${SUBS0}raw1…` ``
//
// One match carries **every** rewritable site in the list (spec 05 §4's
// batched convention, P-1): the sites are independent (each replaces one
// `call` node by identity, reusing its substitution nodes by reference, and
// T2 additionally deletes its own `rT = …` statement), so rewriting them one
// per driver iteration would only repeat the whole-body walks below K times.
// `deriveSites` is total and pure over `(list, fnBody)`, and `check.ts` calls
// it again on `before` alone — the "recompute, do not trust `match`" item §6
// asks for, satisfied structurally exactly as `call-shape/check.ts` does.
//
// Two documented deviations from §4's letter, both forced by the same
// Hermes register-reuse pathology `call-shape` and `var-naming` already
// record (a register number is scratch, re-used for unrelated values many
// times per frame — `identUses(fnBody, rN).writes === 1` is the exception,
// not the rule):
//
//   * `stringLiteralValue` (and the `DUP`/`ID`/`F` resolutions built on it)
//     resolves a register from the **nearest preceding top-level definition
//     in the same list**, with no intervening write to that register at any
//     depth in between — in straight-line list order that definition
//     dominates the use, which is what §4's "dominates this list … no other
//     write" is asking for. §4's literal "exactly one write in `ctx.fnBody`"
//     rule is kept as the fallback when the defining statement is not in the
//     list at all. On `44-tagged-templates` every `id`/`dup`/string argument
//     of the second and third sites lives in a register written twice in the
//     frame (`r16 = 1 … r16 = 2`, `r15 = true` twice), and `43`'s
//     `computeExpr` spills the callee into a register the frame also reuses:
//     the letter of §4 refuses every one of them.
//   * T2 guard 4 (`shared-template-object`) is proven on the same list-local
//     dataflow instead of whole-frame `identUses` counts: `rT` is mentioned
//     nowhere strictly between `A` and `B`, `B` reads it exactly once (as the
//     tag call's first argument), and after `B` either `B` itself redefines
//     `rT` or the next mention of `rT` in the list is a pure redefinition —
//     plus every read and write of `rT` in the whole frame is inside this
//     list (so nothing outside it can observe the deleted definition), and
//     `nested === 0`. `44`'s three sites reuse `r6` twice and `r1` for the
//     third; the whole-frame count refuses all three.
//   * T2 guard 6 (`interleaved-effect`) admits, between `A` and `B`, a
//     statement that is `isPureStmt` **or** a plain register assignment of a
//     `member` chain over identifiers/literals (`r5 = r0.inspect`). Nothing
//     moves in this rewrite — `B` stays where it is and evaluates `TAG` and
//     `SUBS` exactly as before; only `A`'s effect-free construction of a
//     cached frozen array (its arguments are proven literals) disappears — so
//     a property read in between can neither observe nor be observed by the
//     change. §4's "does not write any register `SUBS` or `TAG` reads" is
//     likewise dropped: those writes precede `B` in both `before` and
//     `after`. Every one of `44`'s three sites has such a load in between.
import type { Expr, Stmt } from "../ast.ts";
import { defUse, identUses, isPure, isPureStmt, isRegisterName, stmtLists, walk } from "../ast.ts";
import type { Match, PassContext } from "../types.ts";

export type RefuseReason =
  | "unresolved-concat"
  | "dynamic-args"
  | "non-literal-chunk"
  | "no-substitutions"
  | "seq-argument"
  | "unresolved-template-object"
  | "raw-cooked-mismatch"
  | "arity-mismatch"
  | "shared-template-object"
  | "duplicated-site-id"
  | "interleaved-effect"
  | "raw-does-not-cook"
  | "nested-template-object";

export interface T1Site {
  readonly kind: "t1";
  readonly stmtIndex: number;
  /** The exact `Reflect.apply(...)` node being replaced — identity, not shape. */
  readonly target: Expr;
  /** Cooked chunk values, `chunks.length === subs.length + 1`. */
  readonly chunks: readonly string[];
  /** The substitution nodes, by reference — never rebuilt. */
  readonly subs: readonly Expr[];
}

export interface T2Site {
  readonly kind: "t2";
  /** Index of statement `A` (`rT = __hbc_b_getTemplateObject(...)`) — deleted. */
  readonly aIndex: number;
  /** Index of statement `B`, the one holding the tag call. */
  readonly stmtIndex: number;
  /** The exact tag `call` node inside `B` — identity. */
  readonly target: Expr;
  readonly rT: string;
  readonly id: number;
  readonly tag: Expr;
  readonly raw: readonly string[];
  readonly cooked: readonly string[];
  readonly subs: readonly Expr[];
}

export type TemplateSite = T1Site | T2Site;

/** The match's data: every site in the list, in pre-order (outer before
 *  inner — `rewrite` relies on that order, see `rewrite.ts`). */
export interface TemplateLiteralSites {
  readonly sites: readonly TemplateSite[];
}

export type TemplateLiteralMatch = Match<readonly Stmt[], TemplateLiteralSites>;

export interface Refusal {
  readonly stmtIndex: number;
  readonly reason: RefuseReason;
}

export interface DeriveResult {
  readonly sites: readonly TemplateSite[];
  readonly refusals: readonly Refusal[];
}

const HERMES_INTERNAL = "__hbc_HermesInternal";
const TEMPLATE_OBJECT_HELPER = "__hbc_b_getTemplateObject";

// ---------------------------------------------------------------------------
// Literal decoding / template cooking / escaping — the string half of §4–§6.
// ---------------------------------------------------------------------------

/** Decode a `lit` whose text is the emitter's double-quoted form
 *  (`src/emit/names.ts`'s `quote`: `\\`, `\"`, `\n`, `\r`, `\t`, `\xNN`,
 *  `\uNNNN`, otherwise plain ASCII). `null` for anything else — including
 *  an escape this decoder does not know, which is refused rather than
 *  guessed at. */
export function decodeStringLiteral(text: string): string | null {
  if (text.length < 2 || text[0] !== '"' || text[text.length - 1] !== '"') return null;
  let out = "";
  for (let i = 1; i < text.length - 1; i++) {
    const c = text[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = text[++i];
    switch (n) {
      case "\\":
        out += "\\";
        break;
      case '"':
        out += '"';
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "x": {
        const hex = text.slice(i + 1, i + 3);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        break;
      }
      case "u": {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        return null;
    }
  }
  return out;
}

const SINGLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", "\\": "\\", "`": "`", $: "$", '"': '"', "'": "'" };

/**
 * The JS template-cooking of raw template text (ECMA-262 TV of a
 * TemplateCharacters run): escapes processed, line continuations removed,
 * a bare CR / CRLF normalised to LF. `undefined` when `raw` is not valid
 * raw template text at all — an invalid escape (`\1`…`\9`, `\08`, a short
 * `\x`/`\u`), a bare backtick, or an unescaped `${` — since printing such a
 * `raw` verbatim between backticks would not read back as the same chunk.
 */
export function cook(raw: string): string | undefined {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "`") return undefined;
    if (c === "$" && raw[i + 1] === "{") return undefined;
    if (c === "\r") {
      out += "\n";
      if (raw[i + 1] === "\n") i++;
      continue;
    }
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = raw[++i];
    if (n === undefined) return undefined; // trailing lone backslash
    if (n === "\n" || n === "\u2028" || n === "\u2029") continue; // line continuation
    if (n === "\r") {
      if (raw[i + 1] === "\n") i++;
      continue;
    }
    if (n === "0" && !/[0-9]/.test(raw[i + 1] ?? "")) {
      out += "\0";
      continue;
    }
    if (/[0-9]/.test(n)) return undefined;
    if (n === "x") {
      const hex = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) return undefined;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2;
      continue;
    }
    if (n === "u") {
      if (raw[i + 1] === "{") {
        const close = raw.indexOf("}", i + 2);
        if (close === -1) return undefined;
        const hex = raw.slice(i + 2, close);
        if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) return undefined;
        out += String.fromCodePoint(cp);
        i = close;
        continue;
      }
      const hex = raw.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
      continue;
    }
    out += SINGLE_ESCAPES[n] ?? n; // NonEscapeCharacter: `\d` is `d`
  }
  return out;
}

/** §5: cooked chunk value -> raw template source text. Escapes `` ` ``, `\`
 *  and `${`; keeps a literal newline as a newline (the readability win);
 *  renders every other control character as `\xNN` (and CR as `\r`, since
 *  a bare CR in template source cooks to LF). Inverse of `cook` on its
 *  whole range: `cook(escapeForTemplate(s)) === s` for every string `s`. */
export function escapeForTemplate(cooked: string): string {
  let out = "";
  for (let i = 0; i < cooked.length; i++) {
    const c = cooked[i]!;
    const code = cooked.charCodeAt(i);
    if (c === "\\") out += "\\\\";
    else if (c === "`") out += "\\`";
    else if (c === "$" && cooked[i + 1] === "{") out += "\\$";
    else if (c === "\n") out += "\n";
    else if (c === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Register resolution (§4 `stringLiteralValue`, generalised to any literal
// and to the `F`-is-a-register form of T1 rule 1).
// ---------------------------------------------------------------------------

function isTopLevelWrite(s: Stmt, reg: string): Expr | null {
  if (s.k === "init" && s.name === reg) return s.value;
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && s.expr.target.name === reg) return s.expr.value;
  return null;
}

// Whole-frame facts, memoised on the frame's identity: stage-B lists are
// immutable (a rewrite builds a new list), and the driver hands every
// `match`/`check` of one iteration the same `ctx.fnBody` object, so one walk
// serves every chunk of every site in that iteration (P-1).
const storeValuesMemo = new WeakMap<readonly Stmt[], Map<string, Expr[]>>();
const defUseMemo = new WeakMap<readonly Stmt[], ReturnType<typeof defUse>>();

/** Every top-level `rX = value` store reachable from `stmts` (nested lists
 *  included, nested `func` frames excluded), for every register at once. */
function registerStoreValues(stmts: readonly Stmt[], reg: string): readonly Expr[] {
  let m = storeValuesMemo.get(stmts);
  if (m === undefined) {
    m = new Map();
    for (const list of stmtLists(stmts)) {
      for (const s of list) {
        const name = s.k === "init" ? s.name : s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" ? s.expr.target.name : null;
        if (name === null || !isRegisterName(name)) continue;
        const v = isTopLevelWrite(s, name)!;
        const arr = m.get(name);
        if (arr === undefined) m.set(name, [v]);
        else arr.push(v);
      }
    }
    storeValuesMemo.set(stmts, m);
  }
  return m.get(reg) ?? [];
}

function frameDefUse(fnBody: readonly Stmt[]): ReturnType<typeof defUse> {
  let du = defUseMemo.get(fnBody);
  if (du === undefined) {
    du = defUse(fnBody);
    defUseMemo.set(fnBody, du);
  }
  return du;
}

/** A resolved value together with *where* it was defined, so a value that
 *  itself mentions a register (`r1.concat`) can be resolved further at the
 *  definition's own position rather than at the use's. `list === []` marks
 *  a value found by the whole-frame rule, where only that rule applies to
 *  anything nested in it. */
interface Resolved {
  readonly value: Expr;
  readonly list: readonly Stmt[];
  readonly at: number;
}

const MAX_ALIAS_DEPTH = 8;

/**
 * The value `e` provably holds at `list[useIndex]`: `e` itself when it is
 * not a register; otherwise the value of the nearest preceding top-level
 * write of that register in `list` provided no statement strictly in between
 * writes it (at any depth); otherwise (no write in this list) the register's
 * single write in the whole frame, provided every read of it in the frame
 * sits at or after that write. A register-to-register alias (`r56 = r32`) is
 * followed the same way from the aliasing definition's own position. `null`
 * when nothing can be proven.
 */
function resolveAt(e: Expr, list: readonly Stmt[], useIndex: number, fnBody: readonly Stmt[], depth = 0): Resolved | null {
  if (e.k !== "ident") return { value: e, list, at: useIndex };
  if (!isRegisterName(e.name) || depth > MAX_ALIAS_DEPTH) return null;
  const reg = e.name;
  const follow = (v: Expr, l: readonly Stmt[], at: number): Resolved | null => (v.k === "ident" && isRegisterName(v.name) ? resolveAt(v, l, at, fnBody, depth + 1) : { value: v, list: l, at });
  for (let k = useIndex - 1; k >= 0; k--) {
    const v = isTopLevelWrite(list[k]!, reg);
    if (v === null) continue;
    const between = list.slice(k + 1, useIndex);
    if (identUses(between, reg).writes !== 0) return null;
    return follow(v, list, k);
  }
  const writes = registerStoreValues(fnBody, reg);
  if (writes.length !== 1) return null;
  const du = frameDefUse(fnBody).get(reg);
  if (du === undefined || du.defs.length !== 1) return null;
  const def = du.defs[0]!;
  if (du.reads.some((r) => r < def)) return null;
  return follow(writes[0]!, [], 0);
}

export function resolveValue(e: Expr, list: readonly Stmt[], useIndex: number, fnBody: readonly Stmt[]): Expr | null {
  return resolveAt(e, list, useIndex, fnBody)?.value ?? null;
}

/** §4's `stringLiteralValue`: the decoded value of a string literal, or of a
 *  register proven to hold one at this point. */
export function stringLiteralValue(e: Expr, list: readonly Stmt[], useIndex: number, fnBody: readonly Stmt[]): string | null {
  const v = resolveValue(e, list, useIndex, fnBody);
  if (v === null || v.k !== "lit") return null;
  return decodeStringLiteral(v.text);
}

function booleanValue(e: Expr, list: readonly Stmt[], useIndex: number, fnBody: readonly Stmt[]): boolean | null {
  const v = resolveValue(e, list, useIndex, fnBody);
  if (v === null || v.k !== "lit") return null;
  return v.text === "true" ? true : v.text === "false" ? false : null;
}

function numberValue(e: Expr, list: readonly Stmt[], useIndex: number, fnBody: readonly Stmt[]): number | null {
  const v = resolveValue(e, list, useIndex, fnBody);
  if (v === null || v.k !== "lit" || !/^-?\d+(\.\d+)?$/.test(v.text)) return null;
  return Number(v.text);
}

// ---------------------------------------------------------------------------
// Shapes.
// ---------------------------------------------------------------------------

function isReflectApply(e: Expr): boolean {
  return e.k === "member" && !e.computed && e.obj.k === "ident" && e.obj.name === "Reflect" && e.prop.k === "lit" && e.prop.text === "apply";
}

function isConcatMember(e: Expr): boolean {
  return e.k === "member" && !e.computed && e.obj.k === "ident" && e.obj.name === HERMES_INTERNAL && e.prop.k === "lit" && e.prop.text === "concat";
}

/** `x.concat` for any `x` — "concat-flavoured", used only to decide whether
 *  an unprovable callee register is worth a recorded refusal. */
function isSomeConcatMember(e: Expr): boolean {
  return e.k === "member" && !e.computed && e.prop.k === "lit" && e.prop.text === "concat";
}

/** T1 rule 1: `F` is `__hbc_HermesInternal.concat`, or a register proven to
 *  hold it — through a spilled namespace as well (`r1 =
 *  __hbc_HermesInternal; r3 = r1.concat; … Reflect.apply(r3, …)`), where the
 *  namespace register is resolved at the *member's* definition, since the
 *  frame may reuse it before the call (`43` at every version). */
function isProvenConcat(F: Expr, list: readonly Stmt[], useIndex: number, fnBody: readonly Stmt[]): boolean {
  if (isConcatMember(F)) return true;
  const r = resolveAt(F, list, useIndex, fnBody);
  if (r === null || !isSomeConcatMember(r.value)) return false;
  const v = r.value as Expr & { readonly k: "member" };
  if (v.obj.k === "ident" && v.obj.name === HERMES_INTERNAL) return true;
  const o = resolveAt(v.obj, r.list, r.at, fnBody);
  return o !== null && o.value.k === "ident" && o.value.name === HERMES_INTERNAL;
}

function isTemplateObjectCall(e: Expr): e is Expr & { readonly k: "call" } {
  return e.k === "call" && e.callee.k === "ident" && e.callee.name === TEMPLATE_OBJECT_HELPER;
}

/** `ident`/`lit`, or a `member` chain over those — a read that cannot
 *  re-order against a deleted, effect-free statement (T2 guard 6). */
function isTransparentRead(e: Expr): boolean {
  if (e.k === "ident" || e.k === "lit") return true;
  if (e.k !== "member") return false;
  return isTransparentRead(e.obj) && (!e.computed || isTransparentRead(e.prop));
}

/** The `Expr` fields directly on `s` (mirrors `call-shape/match.ts`). */
function exprFieldsOf(s: Stmt): readonly Expr[] {
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
      return [];
  }
}

/** Every `call` node reachable from `e`, pre-order (outer before inner),
 *  never crossing into a nested `func` frame; does descend into a
 *  `template`/`tagged` node so a site left inside a substitution by an
 *  earlier iteration is still found. */
function collectCalls(e: Expr, out: Expr[]): void {
  if (e.k === "call") out.push(e);
  switch (e.k) {
    case "member":
      collectCalls(e.obj, out);
      if (e.computed) collectCalls(e.prop, out);
      return;
    case "call":
    case "new":
      collectCalls(e.callee, out);
      e.args.forEach((a) => collectCalls(a, out));
      return;
    case "bin":
    case "logical":
      collectCalls(e.left, out);
      collectCalls(e.right, out);
      return;
    case "unary":
      collectCalls(e.arg, out);
      return;
    case "assign":
      collectCalls(e.target, out);
      collectCalls(e.value, out);
      return;
    case "cond":
      collectCalls(e.test, out);
      collectCalls(e.then, out);
      collectCalls(e.else, out);
      return;
    case "array":
      e.elements.forEach((x) => collectCalls(x, out));
      return;
    case "object":
      e.props.forEach((p) => collectCalls(p.value, out));
      return;
    case "seq":
      e.exprs.forEach((x) => collectCalls(x, out));
      return;
    case "template":
      e.exprs.forEach((x) => collectCalls(x, out));
      return;
    case "tagged":
      collectCalls(e.tag, out);
      collectCalls(e.quasi, out);
      return;
    default:
      return; // ident, lit, this, argumentsObject, func
  }
}

function callsOfStmt(s: Stmt): readonly Expr[] {
  const out: Expr[] = [];
  for (const f of exprFieldsOf(s)) collectCalls(f, out);
  return out;
}

// ---------------------------------------------------------------------------
// T1 — untagged template.
// ---------------------------------------------------------------------------

type T1Verdict = { readonly ok: true; readonly chunks: readonly string[]; readonly subs: readonly Expr[] } | { readonly ok: false; readonly reason: RefuseReason } | null;

/** `null` when `node` is not a concat site at all (call-shape's business, or
 *  an ordinary call); otherwise a verdict with a §7 reason. */
function classifyT1(node: Expr, list: readonly Stmt[], stmtIndex: number, fnBody: readonly Stmt[]): T1Verdict {
  if (node.k !== "call" || !isReflectApply(node.callee)) return null;
  const [F, C0, ARR] = node.args;
  if (node.args.length !== 3 || F === undefined || C0 === undefined || ARR === undefined) return null;
  // Rule 1: `F` is the concat member, or a register proven to hold it. A
  // register that is written with the concat member *somewhere* in the frame
  // but cannot be proven to hold it here is refused (not skipped): it is
  // concat-flavoured, and the reason should be recorded.
  if (!isProvenConcat(F, list, stmtIndex, fnBody)) {
    if (F.k !== "ident" || !isRegisterName(F.name)) return null;
    // Concat-flavoured but unprovable — worth a recorded refusal: the
    // register resolves to some `x.concat` whose `x` is not provably the
    // namespace, or it does not resolve at all and one of its writes in the
    // frame is a `.concat` member. A register that resolves to something
    // else (`r3 = print` — the frame reuses the number) is not a site.
    const r = resolveAt(F, list, stmtIndex, fnBody);
    if (r !== null) return isSomeConcatMember(r.value) ? { ok: false, reason: "unresolved-concat" } : null;
    return registerStoreValues(fnBody, F.name).some(isSomeConcatMember) ? { ok: false, reason: "unresolved-concat" } : null;
  }
  if (ARR.k !== "array") return { ok: false, reason: "dynamic-args" };
  const flat: readonly Expr[] = [C0, ...ARR.elements];
  if (flat.length < 2) return { ok: false, reason: "no-substitutions" };
  if (flat.some((e) => e.k === "seq")) return { ok: false, reason: "seq-argument" };
  const chunks: string[] = [];
  const subs: Expr[] = [];
  for (let i = 0; i < flat.length; i++) {
    if (i % 2 === 0) {
      const v = stringLiteralValue(flat[i]!, list, stmtIndex, fnBody);
      if (v === null) return { ok: false, reason: "non-literal-chunk" };
      chunks.push(v);
    } else subs.push(flat[i]!);
  }
  if (flat.length % 2 === 0) chunks.push("");
  return { ok: true, chunks, subs };
}

// ---------------------------------------------------------------------------
// T2 — tagged template.
// ---------------------------------------------------------------------------

type T2Verdict = { readonly ok: true; readonly site: T2Site } | { readonly ok: false; readonly reason: RefuseReason };

/** Statement `A` as `{rT, call}` when it is exactly `rT = helper(...)` /
 *  `init rT = helper(...)`; `null` otherwise. */
function templateObjectStmt(s: Stmt): { readonly rT: string; readonly call: Expr & { readonly k: "call" } } | null {
  if (s.k === "init" && isTemplateObjectCall(s.value)) return { rT: s.name, call: s.value };
  if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && isTemplateObjectCall(s.expr.value)) return { rT: s.expr.target.name, call: s.expr.value };
  return null;
}

/** The call-site id of every `__hbc_b_getTemplateObject` call in the frame,
 *  resolved in its own list; `null` for one that cannot be resolved (or is
 *  nested inside a larger expression, where the list-local resolution does
 *  not apply). Guard 5 needs every one of them. */
function templateObjectIds(fnBody: readonly Stmt[]): readonly (number | null)[] {
  const out: (number | null)[] = [];
  for (const list of stmtLists(fnBody)) {
    list.forEach((s, i) => {
      const top = templateObjectStmt(s);
      for (const c of callsOfStmt(s)) {
        if (!isTemplateObjectCall(c)) continue;
        if (top !== null && c === top.call && c.args[0] !== undefined) out.push(numberValue(c.args[0], list, i, fnBody));
        else out.push(null);
      }
    });
  }
  return out;
}

function classifyT2(list: readonly Stmt[], aIndex: number, fnBody: readonly Stmt[]): T2Verdict | null {
  const A = list[aIndex]!;
  const top = templateObjectStmt(A);
  const helperCalls = callsOfStmt(A).filter(isTemplateObjectCall);
  if (helperCalls.length === 0) return null;
  if (top === null || helperCalls.length !== 1) return { ok: false, reason: "nested-template-object" };
  const { rT, call } = top;
  const [ID, DUP, ...S] = call.args;
  if (ID === undefined || DUP === undefined) return { ok: false, reason: "unresolved-template-object" };
  const id = numberValue(ID, list, aIndex, fnBody);
  const dup = booleanValue(DUP, list, aIndex, fnBody);
  const strings: string[] = [];
  for (const s of S) {
    const v = stringLiteralValue(s, list, aIndex, fnBody);
    if (v === null) return { ok: false, reason: "unresolved-template-object" };
    strings.push(v);
  }
  if (id === null || dup === null) return { ok: false, reason: "unresolved-template-object" };
  let raw: readonly string[];
  let cooked: readonly string[];
  if (dup) {
    raw = strings;
    cooked = strings;
  } else {
    if (strings.length % 2 !== 0) return { ok: false, reason: "raw-cooked-mismatch" };
    raw = strings.slice(0, strings.length / 2);
    cooked = strings.slice(strings.length / 2);
  }

  // Guard 4 (list-local dataflow — see the file header) and locating `B`.
  const frameUses = identUses(fnBody, rT);
  const listUses = identUses(list, rT);
  if (frameUses.nested !== 0 || frameUses.reads !== listUses.reads || frameUses.writes !== listUses.writes) return { ok: false, reason: "shared-template-object" };
  let bIndex = -1;
  for (let b = aIndex + 1; b < list.length; b++) {
    const u = identUses([list[b]!], rT);
    if (u.reads === 0 && u.writes === 0) continue;
    bIndex = b;
    break;
  }
  if (bIndex === -1) return { ok: false, reason: "shared-template-object" };
  const B = list[bIndex]!;
  const bUses = identUses([B], rT);
  // The tag call: `TAG(rT, …SUBS)`, or — when the emitter kept the call in
  // `Reflect.apply(TAG, T, [rT, …SUBS])` form because `T` is `undefined`
  // and `TAG` is a member (`call-shape` rightly refuses that: `O.P(...)`
  // would pass `O`) — the same call with its receiver severed, which is
  // exactly what `(0, TAG)`…`` evaluates to (`44` at v99: `Reflect.apply(
  // r4.inspect, r2, [r7, 42, 43])`, `r2 = undefined`).
  const isTaggedShape = (c: Expr): boolean => c.k === "call" && c.args[0] !== undefined && c.args[0].k === "ident" && c.args[0].name === rT;
  const isAppliedShape = (c: Expr): boolean => c.k === "call" && isReflectApply(c.callee) && c.args.length === 3 && c.args[2]!.k === "array" && (c.args[2] as Expr & { readonly k: "array" }).elements[0]?.k === "ident" && ((c.args[2] as Expr & { readonly k: "array" }).elements[0] as Expr & { readonly k: "ident" }).name === rT;
  const tagCalls = callsOfStmt(B).filter((c) => isTaggedShape(c) || isAppliedShape(c));
  if (bUses.reads !== 1 || tagCalls.length !== 1) return { ok: false, reason: "shared-template-object" };
  const target = tagCalls[0]! as Expr & { readonly k: "call" };
  let tag: Expr;
  let subs: readonly Expr[];
  if (isTaggedShape(target)) {
    tag = target.callee;
    subs = target.args.slice(1);
  } else {
    const [TAG, T, ARR] = target.args as [Expr, Expr, Expr & { readonly k: "array" }];
    const t = resolveValue(T, list, bIndex, fnBody);
    if (t === null || t.k !== "lit" || t.text !== "undefined") return { ok: false, reason: "shared-template-object" };
    if (ARR.elements.some((e) => e.k === "seq")) return { ok: false, reason: "seq-argument" };
    tag = TAG.k === "member" ? { k: "seq", exprs: [{ k: "lit", text: "0" }, TAG] } : TAG;
    subs = ARR.elements.slice(1);
  }
  const bRedefines = isTopLevelWrite(B, rT) !== null;
  if (!bRedefines) {
    for (let c = bIndex + 1; c < list.length; c++) {
      const u = identUses([list[c]!], rT);
      if (u.reads > 0) return { ok: false, reason: "shared-template-object" };
      if (u.writes > 0) {
        if (isTopLevelWrite(list[c]!, rT) === null) return { ok: false, reason: "shared-template-object" };
        break;
      }
    }
  }

  // Guard 5: one id, one site in the whole frame.
  const ids = templateObjectIds(fnBody);
  if (ids.some((x) => x === null) || ids.filter((x) => x === id).length !== 1) return { ok: false, reason: "duplicated-site-id" };

  // Guard 6 (relaxed as documented in the header).
  for (let k = aIndex + 1; k < bIndex; k++) {
    const s = list[k]!;
    if (isPureStmt(s)) continue;
    if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && (isPure(s.expr.value) || isTransparentRead(s.expr.value))) continue;
    return { ok: false, reason: "interleaved-effect" };
  }

  // Guards 3 and 7.
  if (raw.length !== subs.length + 1) return { ok: false, reason: "arity-mismatch" };
  for (let i = 0; i < raw.length; i++) {
    if (cook(raw[i]!) !== cooked[i]) return { ok: false, reason: "raw-does-not-cook" };
  }
  return { ok: true, site: { kind: "t2", aIndex, stmtIndex: bIndex, target, rT, id, tag, raw, cooked, subs } };
}

// ---------------------------------------------------------------------------
// Whole-list derivation — the one function `match` and `check` both call.
// ---------------------------------------------------------------------------

/** Does `body` (a whole function, nested lists and nested frames included)
 *  still hold a concat / template-object *site* — rewritable or refused? A
 *  dead callee spill left behind by a rewrite (`r5 =
 *  __hbc_HermesInternal.concat;` with no remaining reader) is not a site.
 *  Used by `tools/passes-metrics.mjs`. */
export function hasTemplateSites(body: readonly Stmt[]): boolean {
  const frames: (readonly Stmt[])[] = [body];
  walk(body, { expr: (e) => { if (e.k === "func") frames.push(e.body); }, stmt: (s) => { if (s.k === "func") frames.push(s.body); } });
  for (const frame of frames) {
    for (const list of stmtLists(frame)) {
      const { sites, refusals } = deriveSites(list, frame);
      if (sites.length > 0 || refusals.length > 0) return true;
    }
  }
  return false;
}

/** Every site in `list`, in pre-order over the list's own expression trees
 *  (statement order, outer node before inner), plus every refused
 *  concat/template-object site with its §7 reason. Pure and total. */
export function deriveSites(list: readonly Stmt[], fnBody: readonly Stmt[]): DeriveResult {
  const refusals: Refusal[] = [];
  const t2ByTarget = new Map<Expr, T2Site>();
  list.forEach((_, aIndex) => {
    const v = classifyT2(list, aIndex, fnBody);
    if (v === null) return;
    if (v.ok) t2ByTarget.set(v.site.target, v.site);
    else refusals.push({ stmtIndex: aIndex, reason: v.reason });
  });
  const sites: TemplateSite[] = [];
  list.forEach((s, stmtIndex) => {
    for (const node of callsOfStmt(s)) {
      const t2 = t2ByTarget.get(node);
      if (t2 !== undefined) {
        sites.push(t2);
        continue;
      }
      const v = classifyT1(node, list, stmtIndex, fnBody);
      if (v === null) continue;
      if (v.ok) sites.push({ kind: "t1", stmtIndex, target: node, chunks: v.chunks, subs: v.subs });
      else refusals.push({ stmtIndex, reason: v.reason });
    }
  });
  return { sites, refusals };
}

export function match(list: readonly Stmt[], ctx: PassContext): TemplateLiteralMatch | null {
  const { sites } = deriveSites(list, ctx.fnBody ?? list);
  if (sites.length === 0) return null;
  return {
    root: list,
    nodes: [list],
    data: { sites },
    at: { functionIndex: ctx.functionIndex, offset: sites[0]!.stmtIndex },
  };
}
