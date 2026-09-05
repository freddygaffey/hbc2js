// docs/specs/passes/25-yield-async-recovery.md §3.1/§3.3 — the async spawn
// wrapper. Pure; returns the recovered `async function` or one of §4's named
// R-A refusals.
import type { Expr, Stmt } from "../../emit/ast.ts";
import { identUses, mapStmts } from "../ast.ts";

export type Refusal = "no-async-site" | "driver-name" | "this-coercion" | "factory-escapes" | "inner-not-recovered" | "yield-not-await" | "driver-result-used";

export interface Recovered {
  readonly ok: true;
  readonly fn: Stmt & { readonly k: "func" };
  /** How many `yield` nodes became an `await` (§5's metric). */
  readonly awaits: number;
}
export interface Refused {
  readonly ok: false;
  readonly reason: Refusal;
  readonly detail: string;
}
export type Recovery = Recovered | Refused;

const no = (reason: Refusal, detail: string): Refused => ({ ok: false, reason, detail });

type FuncStmt = Stmt & { readonly k: "func" };

/** §1.6: resolved *by name*, never by builtin number. `__hbc_b_makeAsyncIterator`
 *  is `src/runtime/helpers.ts`'s alias of the same driver and a different
 *  compiler build can still emit it (P-25). */
const DRIVERS = ["__hbc_b_spawnAsync", "__hbc_b_makeAsyncIterator"];

const isIdent = (e: Expr, name: string): boolean => e.k === "ident" && e.name === name;

function asAssign(s: Stmt): { readonly name: string; readonly value: Expr } | null {
  if (s.k === "init") return { name: s.name, value: s.value };
  if (s.k !== "expr" || s.expr.k !== "assign" || s.expr.target.k !== "ident") return null;
  return { name: s.expr.target.name, value: s.expr.value };
}

/**
 * §3.1: the stub's own `this`, as the emitter hands it to the driver. Either
 * the coercion `this === null || this === undefined ? globalThis : Object(this)`
 * (a strict-env or v<=97 `LoadThisNS`) or the bare `this` the non-strict
 * lowering now prints (PUSHBACK P-31's landing). Anything else is R-A2: an
 * async function's `this` must be the stub's own and no one else's.
 */
function isOwnThis(e: Expr): boolean {
  if (e.k === "this") return true;
  if (e.k !== "cond" || e.else.k !== "call" || e.else.args.length !== 1 || e.else.args[0]!.k !== "this") return false;
  if (!isIdent(e.else.callee, "Object") || !isIdent(e.then, "globalThis")) return false;
  const t = e.test;
  if (t.k !== "logical" || t.op !== "||") return false;
  const nullish = (x: Expr): boolean => x.k === "bin" && x.op === "===" && x.left.k === "this" && x.right.k === "lit" && (x.right.text === "null" || x.right.text === "undefined");
  return nullish(t.left) && nullish(t.right);
}

/** §3.1: `__hbc_arguments(arguments)` — the stub's own reified arguments. */
function isOwnArguments(e: Expr): boolean {
  return e.k === "call" && isIdent(e.callee, "__hbc_arguments") && e.args.length === 1 && e.args[0]!.k === "argumentsObject";
}

/** §3.3: every `yield` the previous rung produced becomes an `await`. Nested
 *  closures are opaque -- a `yield` inside one belongs to that function. */
function yieldsToAwaits(body: readonly Stmt[]): { readonly body: readonly Stmt[]; readonly awaits: number } | Refused {
  let awaits = 0;
  let bad: Refused | null = null;
  const out = mapStmts(body, (s) => s, (e) => {
    if (e.k !== "yield") return e;
    // R-A5: never invent an `await` from a `yield` this rung cannot account
    // for. A source-level `async function*` (fixture 30) delegates, and a
    // delegating suspension is not an `await`.
    if (e.delegate || e.arg === null) {
      bad ??= no("yield-not-await", "the recovered body holds a `yield*` or an argument-less `yield`, which is not an await (R-A5)");
      return e;
    }
    awaits++;
    return { k: "await", arg: e.arg };
  });
  return bad ?? { body: out, awaits };
}

/**
 * `stub` is the `k:"func"` statement holding the whole async group: the
 * `generator: true` factory `yield-recovery` produced, the pure register moves
 * that stage the driver call, that call, and its `return`.
 */
export function recover(stub: FuncStmt): Recovery {
  if (stub.async === true) return no("no-async-site", "already recovered");
  const body = stub.body.filter((s) => s.k !== "comment");
  const factories = body.filter((s): s is FuncStmt => s.k === "func");
  if (factories.length !== 1) return no("no-async-site", "the stub declares no single factory");
  const factory = factories[0]!;
  const rest = body.filter((s) => s !== factory && s.k !== "decl");
  const ret = rest[rest.length - 1];
  if (ret === undefined || ret.k !== "return" || ret.arg === null) return no("no-async-site", "the stub does not return the driver's result");
  // Resolve register moves: every statement before the `return` must be an
  // assignment of a pure value to a register (§3.1's "modulo pure register moves").
  const values = new Map<string, Expr>();
  const resolve = (e: Expr): Expr => (e.k === "ident" && values.has(e.name) ? values.get(e.name)! : e);
  let driverCall: Expr | null = null;
  for (const s of rest.slice(0, rest.length - 1)) {
    const a = asAssign(s);
    if (a === null) return no("no-async-site", "the stub holds a statement that is not a register move");
    values.set(a.name, resolve(a.value));
  }
  if (isIdent(ret.arg, "") || ret.arg.k !== "ident") driverCall = ret.arg;
  else driverCall = values.get(ret.arg.name) ?? ret.arg;
  if (driverCall === null || driverCall.k !== "call") return no("no-async-site", "no driver call in the stub");
  // R-A6: the result of the driver call is returned and nothing else is done
  // with it -- it is the value of the last assignment the `return` reads.
  const callee = resolve(driverCall.callee);
  if (callee.k !== "ident" || !DRIVERS.includes(callee.name)) return no("driver-name", "the called value is not __hbc_b_spawnAsync/__hbc_b_makeAsyncIterator resolved by name (R-A1)");
  if (driverCall.args.length !== 3) return no("driver-name", `the driver call has ${driverCall.args.length} arguments, not d(factory, thisArg, args) (R-A1)`);
  const [aFactory, aThis, aArgs] = driverCall.args.map(resolve) as [Expr, Expr, Expr];
  if (!isIdent(aFactory, factory.name)) return no("driver-name", "the driver's first argument is not the group's factory (R-A1)");
  if (!isOwnThis(aThis)) return no("this-coercion", "the driver's second argument is not the stub's own `this` (R-A2)");
  if (!isOwnArguments(aArgs)) return no("this-coercion", "the driver's third argument is not __hbc_arguments(arguments) (R-A2)");
  // R-A3: the factory escapes nowhere else.
  const uses = identUses(body.filter((s) => s !== factory), factory.name);
  if (uses.reads + uses.writes + uses.nested !== 1) return no("factory-escapes", `the factory is referenced ${uses.reads + uses.writes + uses.nested} times outside its own declaration, not once (R-A3)`);
  // R-A4: until `gen-lowered` (catalogue row 18) lands, a v>=97 factory is
  // still `__hbc_makeGeneratorLowered(...)` and `yield-recovery` never ran.
  // This is the refusal that makes registering this rung early safe, and it is
  // the dominant reason in the histogram at 98/99.
  if (factory.generator !== true) return no("inner-not-recovered", "the factory is not a recovered `function*` (R-A4: yield-recovery refused it, or it is still __hbc_makeGeneratorLowered at v>=97)");
  const converted = yieldsToAwaits(factory.body);
  if ("ok" in converted) return converted;
  const comments = stub.body.filter((s) => s.k === "comment");
  return { ok: true, awaits: converted.awaits, fn: { k: "func", name: stub.name, params: stub.params, async: true, body: [...comments, ...converted.body] } };
}
