// docs/specs/passes/25-yield-async-recovery.md §3 — the shared analysis both
// `match` and `check` run. Pure: it reads a stub `k:"func"` statement and
// either returns the recovered `function*` body or one of §4's named refusals.
//
// The anchor is `func.sameFrame` (`src/emit/ast.ts`), the emitter's own marker
// for "the generator/async resume-dispatcher closure `emit/function.ts` returns
// from an `isOpcodeGeneratorBody` function" — set by the emitter and by nothing
// else, so a hand-written `switch (__state)` state machine in the source can
// never reach this code (R-Y1). Spec §2's F25-2 (a per-opcode `Origin` variant
// carrying the suspend/resume map) is NOT implemented: `sameFrame` plus the
// exact shim shape below is the provenance this rung uses. The consequence is
// recorded in the spec's landed note and in docs/BUGS.md.
import type { Expr, Param, Stmt } from "../../emit/ast.ts";
import { identUses, mapStmts, walk } from "../ast.ts";

/** §4: every refusal is a distinct counted `abandoned` reason. */
export type Refusal =
  | "no-generator-site"
  | "no-provenance"
  | "shim-shape"
  | "state-not-injective"
  | "forced-return-body"
  | "cyclic-dispatch"
  | "delegated-yield"
  | "region-mismatch"
  | "this-args-escape"
  | "sent-value-aliased";

export interface Recovered {
  readonly ok: true;
  /** The recovered `function*` declaration, ready to replace the stub. */
  readonly fn: Stmt & { readonly k: "func" };
  /** How many suspend sites became a `yield` (the metric §5 asks for). */
  readonly yields: number;
}
export interface Refused {
  readonly ok: false;
  readonly reason: Refusal;
  readonly detail: string;
}
export type Recovery = Recovered | Refused;

const no = (reason: Refusal, detail: string): Refused => ({ ok: false, reason, detail });

type FuncStmt = Stmt & { readonly k: "func" };
type FuncExpr = Expr & { readonly k: "func" };

const PROTOCOL_PARAMS = ["__sent", "__isReturn", "__isThrow"] as const;
const RESIDUE = ["__state", "__done", "__sent", "__isReturn", "__isThrow", "__this", "__args"] as const;

const isIdent = (e: Expr, name: string): boolean => e.k === "ident" && e.name === name;
const isLit = (e: Expr, text: string): boolean => e.k === "lit" && e.text === text;

/** `<target> = <value>` as a statement. */
function asAssign(s: Stmt): { readonly target: Expr; readonly value: Expr } | null {
  return s.k === "expr" && s.expr.k === "assign" ? { target: s.expr.target, value: s.expr.value } : null;
}
/** `__pc = <n>;` — the emitted try-region program counter. Carried through
 *  every rewrite verbatim: the `catch` filters on its value (`28-async-await-error`). */
function isPcStore(s: Stmt): boolean {
  const a = asAssign(s);
  return a !== null && isIdent(a.target, "__pc") && a.value.k === "lit";
}
/** `return [<value>, __done];` — the suspend/completion tuple (§1.2). */
function tupleReturn(s: Stmt): Expr | null {
  if (s.k !== "return" || s.arg === null || s.arg.k !== "array" || s.arg.elements.length !== 2) return null;
  if (!isIdent(s.arg.elements[1]!, "__done")) return null;
  return s.arg.elements[0]!;
}

// ---------------------------------------------------------------------------
// Path keys: where in the step closure's statement tree a list sits. Two lists
// with the same key are inside exactly the same labels, loops, `try` blocks and
// branches, which is the R-Y5/R-Y7 precondition for inlining one into the other.
// ---------------------------------------------------------------------------

/** The child statement lists of `s`, each with the path segment it adds. */
function children(s: Stmt): readonly { readonly seg: string; readonly list: readonly Stmt[] }[] {
  switch (s.k) {
    case "if":
      return [
        { seg: "if-then", list: s.then },
        { seg: "if-else", list: s.else },
      ];
    case "while":
    case "do-while":
    case "for":
      return [{ seg: `loop:${s.label ?? ""}`, list: s.body }];
    case "labeled":
      return [{ seg: `labeled:${s.label}`, list: s.body }];
    case "try":
      return [
        { seg: "try-block", list: s.block },
        { seg: "try-handler", list: s.handler },
      ];
    case "switch":
      return s.cases.map((c, i) => ({ seg: `case:${i}`, list: c.body }));
    default:
      return []; // `func` is deliberately opaque: a nested closure is a different frame.
  }
}

/** Rebuild `s` with each child list replaced by `f(list, key)`. */
function mapChildren(s: Stmt, key: string, f: (list: readonly Stmt[], key: string) => readonly Stmt[]): Stmt {
  const k = (seg: string): string => (key === "" ? seg : `${key}/${seg}`);
  switch (s.k) {
    case "if":
      return { ...s, then: f(s.then, k("if-then")), else: f(s.else, k("if-else")) };
    case "while":
    case "do-while":
    case "for":
      return { ...s, body: f(s.body, k(`loop:${s.label ?? ""}`)) };
    case "labeled":
      return { ...s, body: f(s.body, k(`labeled:${s.label}`)) };
    case "try":
      return { ...s, block: f(s.block, k("try-block")), handler: f(s.handler, k("try-handler")) };
    case "switch":
      return { ...s, cases: s.cases.map((c, i) => ({ ...c, body: f(c.body, k(`case:${i}`)) })) };
    default:
      return s;
  }
}

// ---------------------------------------------------------------------------
// The dispatcher (spec 03 §4.5's synthetic `B_dispatch` block, printed).
// ---------------------------------------------------------------------------

interface Dispatcher {
  readonly stmt: Stmt & { readonly k: "labeled" };
  readonly key: string;
  /** `__pc` stores the emitter put inside the dispatcher's own labelled block,
   *  ahead of the `switch` (`28-async-await-error`). They run on every resume,
   *  including the entry, so they stay exactly where the block was. */
  readonly lead: readonly Stmt[];
  readonly arms: ReadonlyMap<number, readonly Stmt[]>;
}

function findDispatcher(list: readonly Stmt[], key: string, out: Dispatcher[]): void {
  for (const s of list) {
    if (s.k === "labeled" && s.body.length >= 1 && s.body.slice(0, -1).every((x) => isPcStore(x) || x.k === "comment") && s.body[s.body.length - 1]!.k === "switch") {
      const sw = s.body[s.body.length - 1]! as Stmt & { readonly k: "switch" };
      const lead = s.body.slice(0, -1);
      if (isIdent(sw.disc, "__state")) {
        const arms = new Map<number, readonly Stmt[]>();
        let shaped = true;
        for (const c of sw.cases) {
          const isFallOut = c.body.length >= 1 && c.body[0]!.k === "break" && c.body[0]!.label === s.label;
          if (c.test === null || (c.test.k === "lit" && c.test.text === "0")) {
            if (!isFallOut) shaped = false;
            continue;
          }
          if (c.test.k !== "lit" || !/^[0-9]+$/.test(c.test.text)) {
            shaped = false;
            continue;
          }
          if (arms.has(Number(c.test.text))) shaped = false;
          arms.set(Number(c.test.text), c.body);
        }
        if (shaped) out.push({ stmt: s, key, lead, arms });
      }
    }
    for (const c of children(s)) findDispatcher(c.list, key === "" ? c.seg : `${key}/${c.seg}`, out);
  }
}

// ---------------------------------------------------------------------------
// The resume prologue (§1.2), shared by the entry segment and every arm.
// ---------------------------------------------------------------------------

interface Prologue {
  readonly sentReg: string;
  readonly retReg: string;
  /** `__pc` stores that preceded the prologue; carried through verbatim. */
  readonly lead: readonly Stmt[];
  /** The `else` arm: the code that actually continues from this resume. */
  readonly cont: readonly Stmt[];
}

function stripPrologue(list: readonly Stmt[]): Prologue | Refused {
  const lead: Stmt[] = [];
  let i = 0;
  while (i < list.length && (isPcStore(list[i]!) || list[i]!.k === "comment")) lead.push(list[i++]!);
  const a0 = i < list.length ? asAssign(list[i]!) : null;
  if (a0 === null || a0.target.k !== "ident" || !isIdent(a0.value, "__sent")) return no("shim-shape", "resume prologue does not open with `<reg> = __sent`");
  const sentReg = a0.target.name;
  i++;
  const a1 = i < list.length ? asAssign(list[i]!) : null;
  if (a1 === null || a1.target.k !== "ident" || !isIdent(a1.value, "__isReturn")) return no("shim-shape", "resume prologue has no `<reg> = __isReturn`");
  const retReg = a1.target.name;
  i++;
  const thr = list[i];
  if (thr === undefined || thr.k !== "if" || !isIdent(thr.test, "__isThrow") || thr.else.length !== 0 || thr.then.length !== 1 || thr.then[0]!.k !== "throw" || !isIdent((thr.then[0]! as Stmt & { readonly k: "throw" }).arg, "__sent")) {
    return no("shim-shape", "resume prologue has no `if (__isThrow) throw __sent;`");
  }
  i++;
  const guard = list[i];
  if (guard === undefined || guard.k !== "if" || !isIdent(guard.test, retReg)) return no("shim-shape", "resume prologue has no forced-return test");
  // A trailing unlabelled `break` is the `case` arm's own terminator.
  let end = i + 1;
  while (end < list.length && list[end]!.k === "break" && (list[end]! as Stmt & { readonly k: "break" }).label === null) end++;
  if (end !== list.length) return no("shim-shape", "the forced-return test is not the last statement of its segment");
  // R-Y4: the forced-return arm must be exactly the empty completion, modulo
  // `__pc` stores. `24-generator-return-throw`'s g1 duplicates its `finally`
  // body in here (§1.3) and a native `.return(v)` would not run it.
  const forced = guard.then.filter((s) => !isPcStore(s) && s.k !== "comment");
  const ok = forced.length === 2 && (() => {
    const a = asAssign(forced[0]!);
    return a !== null && isIdent(a.target, "__done") && isLit(a.value, "true") && isIdent(tupleReturn(forced[1]!) ?? { k: "lit", text: "" }, sentReg);
  })();
  if (!ok) return no("forced-return-body", "a forced-return arm is not the empty `__done = true; return [<sent>, __done];` form (R-Y4)");
  // R-Y9: the two protocol registers must be private to the prologue. Hermes
  // *reuses* `<retReg>` as an ordinary scratch register straight after the
  // test (`r2 = "b"` in §1.1's arm 1), so the obligation that is actually
  // checkable — and the one deleting the test needs — is that the
  // continuation never *reads* `<retReg>` before redefining it.
  if (sentReg === retReg) return no("sent-value-aliased", "the sent and forced-return registers are the same register (R-Y9)");
  for (const s of guard.else) {
    const u = identUses([s], retReg);
    if (u.reads > 0 || u.nested > 0) return no("sent-value-aliased", "the forced-return register is read before it is redefined (R-Y9)");
    if (u.writes > 0) break;
  }
  return { sentReg, retReg, lead, cont: guard.else };
}

// ---------------------------------------------------------------------------
// Threading (§3.3): the entry segment, with every suspend site replaced by
// `<sentReg> = yield <value>;` followed by the arm it resumes into.
// ---------------------------------------------------------------------------

interface Threader {
  readonly dispatchKey: string;
  readonly arms: ReadonlyMap<number, readonly Stmt[]>;
  readonly used: Set<number>;
  yields: number;
  failure: Refused | null;
}

function threadList(list: readonly Stmt[], key: string, t: Threader): readonly Stmt[] {
  const out: Stmt[] = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    const a = asAssign(s);
    const next = i + 1 < list.length ? tupleReturn(list[i + 1]!) : null;
    // Completion (§1.2): `__done = true; return [<value>, __done];`
    if (a !== null && isIdent(a.target, "__done") && isLit(a.value, "true") && next !== null) {
      out.push({ k: "return", arg: isLit(next, "undefined") ? null : next });
      i++;
      continue;
    }
    // Suspend (§1.2): `__state = k; return [<value>, __done];`
    if (a !== null && isIdent(a.target, "__state") && a.value.k === "lit" && next !== null) {
      const state = Number(a.value.text);
      const arm = t.arms.get(state);
      if (arm === undefined) {
        t.failure ??= no("state-not-injective", `suspend site writes __state = ${state}, which no dispatcher arm reads (R-Y3)`);
        return list;
      }
      if (t.used.has(state)) {
        t.failure ??= no("state-not-injective", `__state = ${state} is written at more than one suspend site (R-Y3)`);
        return list;
      }
      // R-Y5/R-Y7: the arm may only be inlined where it sits inside exactly
      // the same labels, loops, branches and `try` regions it already did.
      if (key !== t.dispatchKey) {
        const region = key.includes("try-") !== t.dispatchKey.includes("try-");
        t.failure ??= no(region ? "region-mismatch" : "cyclic-dispatch", `a suspend site at "${key}" resumes into an arm at "${t.dispatchKey}": inlining it would move code across a label or region boundary`);
        return list;
      }
      if (i + 2 !== list.length) {
        t.failure ??= no("shim-shape", "a suspend site is not the tail of its statement list");
        return list;
      }
      t.used.add(state);
      const pro = stripPrologue(arm);
      if ("ok" in pro) {
        t.failure ??= pro;
        return list;
      }
      t.yields++;
      const sent: Expr = { k: "yield", arg: next, delegate: false };
      out.push({ k: "expr", expr: { k: "assign", target: { k: "ident", name: pro.sentReg }, value: sent } });
      out.push(...pro.lead, ...threadList(pro.cont, key, t));
      return out;
    }
    out.push(mapChildren(s, key, (child, childKey) => threadList(child, childKey, t)));
  }
  return out;
}

/** Remove the dispatcher block, strip the entry segment's own prologue and
 *  splice the entry back in exactly where the dispatcher stood. */
function openEntry(list: readonly Stmt[], d: Dispatcher, t: Threader): readonly Stmt[] | Refused {
  const at = list.indexOf(d.stmt);
  if (at >= 0) {
    const pro = stripPrologue(list.slice(at + 1));
    if ("ok" in pro) return pro;
    return [...list.slice(0, at), ...d.lead, ...pro.lead, ...pro.cont];
  }
  let failed: Refused | null = null;
  const mapped = list.map((s) =>
    mapChildren(s, "", (child) => {
      const r = openEntry(child, d, t);
      if (Array.isArray(r)) return r as readonly Stmt[];
      if (!Array.isArray(r) && "ok" in (r as Refused)) failed ??= r as Refused;
      return child;
    }),
  );
  return failed ?? mapped;
}

// ---------------------------------------------------------------------------
// §3.1's site: the stub, the factory it declares and the step closure.
// ---------------------------------------------------------------------------

const isComment = (s: Stmt): boolean => s.k === "comment";

/** `<reg> = __hbc_makeGenerator(<factory>, this, arguments);` (R-Y2/R-Y8). */
function shimCall(e: Expr, factory: string): boolean {
  if (e.k !== "call" || !isIdent(e.callee, "__hbc_makeGenerator") || e.args.length !== 3) return false;
  return isIdent(e.args[0]!, factory) && e.args[1]!.k === "this" && e.args[2]!.k === "argumentsObject";
}

interface Group {
  readonly factory: FuncStmt;
  readonly step: FuncExpr;
  /** The factory's own prelude, minus the shim bookkeeping (F25-5). */
  readonly prelude: readonly Stmt[];
}

/** §3.1(1)+(2): is `stub`'s body exactly a generator group? */
function group(stub: FuncStmt): Group | Refused {
  const body = stub.body.filter((s) => !isComment(s));
  const factories = body.filter((s): s is FuncStmt => s.k === "func");
  if (factories.length !== 1) return no("no-generator-site", "the stub declares no single factory");
  const factory = factories[0]!;
  const rest = body.filter((s) => s !== factory);
  // `let rN…;` (the stub's own register decl) + the shim call + its return.
  const decls = rest.filter((s) => s.k === "decl");
  const tail = rest.filter((s) => s.k !== "decl");
  if (tail.length === 2) {
    const a = asAssign(tail[0]!);
    if (a === null || a.target.k !== "ident" || !shimCall(a.value, factory.name)) return no("no-generator-site", "the stub does not call __hbc_makeGenerator(<factory>, this, arguments)");
    if (tail[1]!.k !== "return" || !isIdent(tail[1]!.arg ?? { k: "lit", text: "" }, a.target.name)) return no("shim-shape", "the stub does not return the shim's result");
  } else if (tail.length === 1) {
    if (tail[0]!.k !== "return" || tail[0]!.arg === null || !shimCall(tail[0]!.arg, factory.name)) return no("no-generator-site", "the stub does not return __hbc_makeGenerator(<factory>, this, arguments)");
  } else {
    return no("shim-shape", "the stub body holds statements that are not part of the generator group");
  }
  if (decls.length > 1) return no("shim-shape", "the stub declares more than one register list");
  // The factory: bookkeeping inits, then `return <step closure>`.
  const fb = factory.body.filter((s) => !isComment(s));
  const ret = fb[fb.length - 1];
  if (ret === undefined || ret.k !== "return" || ret.arg === null || ret.arg.k !== "func") return no("shim-shape", "the factory does not return a step closure");
  const step = ret.arg;
  if (step.sameFrame !== true) return no("no-provenance", "the returned closure is not the emitter's `sameFrame` resume dispatcher (R-Y1)");
  if (step.params.length !== 3 || !step.params.every((p, i) => p.name === PROTOCOL_PARAMS[i])) return no("no-provenance", "the step closure's parameters are not (__sent, __isReturn, __isThrow)");
  const prelude: Stmt[] = [];
  let sawState = false;
  let sawDone = false;
  for (const s of factory.body.slice(0, factory.body.length - 1)) {
    if (s.k === "init" && s.name === "__state") {
      if (!isLit(s.value, "0")) return no("shim-shape", "__state is not initialised to 0");
      sawState = true;
      continue;
    }
    if (s.k === "init" && s.name === "__done") {
      if (!isLit(s.value, "false")) return no("shim-shape", "__done is not initialised to false");
      sawDone = true;
      continue;
    }
    // F25-5: the shim's `this`/`arguments` capture disappears with the group.
    if (s.k === "init" && s.name === "__this" && s.value.k === "this") continue;
    if (s.k === "init" && s.name === "__args" && s.value.k === "argumentsObject") continue;
    if (s.k === "comment" || s.k === "decl" || (s.k === "init" && (s.name === "__pc" || s.name === "__exc"))) {
      prelude.push(s);
      continue;
    }
    return no("shim-shape", "the factory body holds a statement that is not shim bookkeeping");
  }
  if (!sawState || !sawDone) return no("shim-shape", "the factory does not declare both __state and __done");
  return { factory, step, prelude };
}

/**
 * §3.1-§3.3. `stub` is the `k:"func"` statement the whole generator group
 * lives in; the result is the `function*` that replaces it, or the named
 * refusal that says why it cannot be replaced.
 */
export function recover(stub: FuncStmt): Recovery {
  if (stub.generator === true || stub.async === true) return no("no-generator-site", "already recovered");
  const g = group(stub);
  if ("ok" in g) return g;
  // R-Y6: `yield*` is lowered through a module-level mutable flag (§1.5).
  let delegated = false;
  walk(g.step.body, { expr: (e) => { if (isIdent(e, "__hbc_b_generatorSetDelegated")) delegated = true; } });
  if (delegated) return no("delegated-yield", "the group delegates through __hbc_b_generatorSetDelegated (R-Y6)");
  // F25-5: the recovered `function*` IS the stub, so its own `this`/`arguments`
  // are the ones the shim was handed.
  const step = substituteFrame(g.step.body);
  const found: Dispatcher[] = [];
  findDispatcher(step, "", found);
  if (found.length > 1) return no("shim-shape", "more than one __state dispatcher in one step closure");
  const t: Threader = { dispatchKey: found[0]?.key ?? "", arms: found[0]?.arms ?? new Map(), used: new Set(), yields: 0, failure: null };
  let entry: readonly Stmt[];
  if (found.length === 1) {
    const opened = openEntry(step, found[0]!, t);
    if (!Array.isArray(opened)) return opened as Refused;
    entry = opened as readonly Stmt[];
  } else {
    // A generator with no `yield` at all: the step closure is one segment.
    const pro = stripPrologue(step);
    if ("ok" in pro) return pro;
    entry = [...pro.lead, ...pro.cont];
  }
  const threaded = threadList(entry, "", t);
  if (t.failure !== null) return t.failure;
  for (const state of t.arms.keys()) if (!t.used.has(state)) return no("state-not-injective", `dispatcher arm ${state} is never resumed into (R-Y3)`);
  // §3.4 obligation 5: no protocol identifier may survive.
  let residue: string | null = null;
  walk(threaded, { expr: (e) => { if (e.k === "ident" && (RESIDUE as readonly string[]).includes(e.name)) residue ??= e.name; } });
  if (residue !== null) return no(residue === "__this" || residue === "__args" ? "this-args-escape" : "shim-shape", `\`${residue}\` survives the rewrite`);
  const params: readonly Param[] = g.factory.params.length > 0 ? g.factory.params : stub.params;
  if (g.factory.params.length > 0 && (g.factory.params.length !== stub.params.length || g.factory.params.some((p, i) => p.name !== stub.params[i]?.name))) {
    return no("shim-shape", "the factory's parameters are not the stub's own");
  }
  const comments = stub.body.filter(isComment);
  return { ok: true, yields: t.yields, fn: { k: "func", name: stub.name, params, generator: true, body: [...comments, ...g.prelude, ...threaded] } };
}

/** F25-5: `__this` -> `this`, `__args` -> `arguments`. Legal only because the
 *  recovered `function*` is the very function the stub was. */
function substituteFrame(body: readonly Stmt[]): readonly Stmt[] {
  return mapStmts(body, (s) => s, (e) => (isIdent(e, "__this") ? { k: "this" } : isIdent(e, "__args") ? { k: "argumentsObject" } : e));
}
