// docs/specs/05-emitter.md §4–§7 — per-instruction lowering.
//
// EM-05: every opcode encountered has a lowering; an unknown one is
// E_EMIT_UNSUPPORTED naming it. An instruction is never silently skipped.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Instruction, Operand } from "../disasm/decode.ts";
import type { BasicBlock } from "../cfg/types.ts";
import { isEnvCreate } from "../cfg/env-graph.ts";
import { writtenRegisters } from "../cfg/reg-effects.ts";
import type { Expr, Stmt } from "./ast.ts";
import { assign, bin, call, id, lit, member, num, un, UNDEF } from "./ast.ts";
import { resolveBuiltin } from "./builtins.ts";
import { arrayFromBuffer, bigIntLiteral, objectFromBuffers, objectKeys, regExpExpr, stringLiteral } from "./literals.ts";
import { EXC_VALUE, envSlot, fnName, GEN_DONE, GEN_IS_RETURN, GEN_SENT, GEN_STATE, isSafePropertyName, quote, reg, SCRATCH } from "./names.ts";
import type { FunctionEmitter } from "./function.ts";
import { typeOfIsExpr, typeOfIsTableFor } from "./typeofis.ts";

const R = (n: number): Expr => id(reg(n));

function opnd(insn: Instruction, i: number): Operand {
  const o = insn.operands[i];
  if (o === undefined) throw new Hbc2jsError(ErrorCode.E_INTERNAL, `${insn.name}: missing operand ${i}`, { offset: insn.offset, section: "emit/lower" });
  return o;
}
const V = (insn: Instruction, i: number): number => opnd(insn, i).value;
const RG = (insn: Instruction, i: number): Expr => R(V(insn, i));

/** Property access: `o.name` when the text is a safe identifier, else `o["…"]`. */
export function prop(obj: Expr, name: string): Expr {
  return isSafePropertyName(name) ? member(obj, lit(name), false) : member(obj, lit(quote(name)), true);
}

const BINARY: Readonly<Record<string, Parameters<typeof bin>[0]>> = {
  Add: "+",
  AddN: "+",
  AddS: "+",
  Sub: "-",
  SubN: "-",
  Mul: "*",
  MulN: "*",
  Div: "/",
  DivN: "/",
  Mod: "%",
  BitAnd: "&",
  BitOr: "|",
  BitXor: "^",
  LShift: "<<",
  RShift: ">>",
  URshift: ">>>",
  Eq: "==",
  Neq: "!=",
  StrictEq: "===",
  StrictNeq: "!==",
  Less: "<",
  LessEq: "<=",
  Greater: ">",
  GreaterEq: ">=",
  InstanceOf: "instanceof",
  IsIn: "in",
};

const UNARY: Readonly<Record<string, Parameters<typeof un>[0]>> = {
  Not: "!",
  Negate: "-",
  BitNot: "~",
  TypeOf: "typeof ",
};

/** Opcodes with no observable effect: caches, profiling, debugger hooks. */
const NO_OP: ReadonlySet<string> = new Set(["CacheNewObject", "ProfilePoint", "Debugger", "AsyncBreakCheck", "StartGenerator", "Unreachable"]);

/**
 * Handled by the structurer's tree, never by the per-instruction path: the
 * condition of a conditional jump becomes the `if` node's test, a switch's
 * scrutinee becomes the `switch` node's discriminant, and `Ret`/`Throw` become
 * the `return`/`throw` leaves. `SaveGenerator` decodes as a conditional jump
 * (one Addr operand) but is a real instruction with a real lowering, so it is
 * excluded here.
 */
function isTreeTerminator(insn: Instruction): boolean {
  if (insn.name === "SaveGenerator" || insn.name === "SaveGeneratorLong") return false;
  switch (insn.kind) {
    case "jump":
    case "condJump":
    case "switch":
    case "return":
    case "throw":
    case "unreachable":
      return true;
    default:
      return false;
  }
}

const GETBYID = /^(Try)?GetById(Short|Long)?$/;
const PUTBYID = /^(Try)?PutById(Loose|Strict)?(Long)?$/;
const DELBYID = /^DelById(Loose|Strict)?(Long)?$/;

export interface NewSite {
  /** Index in the block of the `SelectObject` that completes the triple. */
  readonly at: number;
  readonly dst: number;
  readonly calleeReg: number;
  readonly argCount: number;
  /** `CallWithNewTarget`'s new.target register — the `super(…)` shape (v>=98). */
  readonly newTargetReg: number | null;
}

export interface BlockPlan {
  /** Instruction indices consumed by a multi-instruction pattern (§7.5, §7.4). */
  readonly consumed: ReadonlySet<number>;
  /** Index of the `Construct` -> the `new` it stands for. */
  readonly newSites: ReadonlyMap<number, NewSite>;
  /** Index of a recognised `SelectObject` -> the register holding the result. */
  readonly selectObjects: ReadonlyMap<number, number>;
  /** Index of a `Call*` -> the method-call fast path it should use. */
  readonly methodCalls: ReadonlyMap<number, { readonly objReg: number; readonly name: string }>;
  /** The block's own instructions, so a lowering can look back within the
   *  block (`isLiteralUndefinedReg`). */
  readonly instructions: readonly Instruction[];
}

const CREATE_THIS = new Set(["CreateThis", "CreateThisForNew", "CreateThisForSuper"]);
const CONSTRUCT = new Set(["Construct", "ConstructLong"]);
// `super(…)` in a derived constructor is the same triple with
// `CreateThisForSuper` + `CallWithNewTarget` in place of `CreateThis` +
// `Construct` (measured on 33-class-inheritance-super v99, functions #0 and #4).
const CONSTRUCT_WITH_NEW_TARGET = new Set(["CallWithNewTarget", "CallWithNewTargetLong"]);
const CALL_N = new Set(["Call1", "Call2", "Call3", "Call4"]);

/**
 * §7.5 — recognise the `new` triple, and §7.4's method-call fast path, before
 * lowering anything. Both are multi-instruction patterns: `CreateThis` and
 * `SelectObject` have no JS expression form on their own, so §4's
 * one-instruction-one-statement model does not apply to them.
 */
export function planBlock(block: BasicBlock, functionInstructions: readonly Instruction[]): BlockPlan {
  const consumed = new Set<number>();
  const newSites = new Map<number, NewSite>();
  const selectObjects = new Map<number, number>();
  const methodCalls = new Map<number, { objReg: number; name: string }>();
  const ins = block.instructions;

  // The `new` triple is matched over the *whole function*, not one block: in
  // real bundles the `CreateThis` and its `Construct` are routinely separated by
  // a branch (measured on rn-template-0.72/index.android.hbc, where a per-block
  // matcher leaves a bare `CreateThis` at offset 66). Indices below are into the
  // function's instruction list and mapped back to block-local ones at the end.
  const fnIndexOf = new Map<number, number>();
  for (const [i, insn] of functionInstructions.entries()) fnIndexOf.set(insn.offset, i);
  const localIndexOf = new Map<number, number>();
  for (const [i, insn] of ins.entries()) localIndexOf.set(insn.offset, i);
  const all = functionInstructions;

  for (let i = 0; i < all.length; i++) {
    const sel = all[i]!;
    if (sel.name !== "SelectObject") continue;
    const dst = V(sel, 0);
    const thisReg = V(sel, 1);
    const resultReg = V(sel, 2);
    let constructIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      const c = all[j]!;
      if ((CONSTRUCT.has(c.name) || CONSTRUCT_WITH_NEW_TARGET.has(c.name)) && V(c, 0) === resultReg) {
        constructIdx = j;
        break;
      }
    }
    if (constructIdx < 0) continue;
    const construct = all[constructIdx]!;
    const calleeReg = V(construct, 1);
    const newTargetReg = CONSTRUCT_WITH_NEW_TARGET.has(construct.name) ? V(construct, 2) : null;
    let createIdx = -1;
    for (let j = constructIdx - 1; j >= 0; j--) {
      const c = all[j]!;
      if (!CREATE_THIS.has(c.name)) continue;
      if (V(c, 0) !== thisReg) continue;
      const closureOperand = c.name === "CreateThis" ? V(c, 2) : V(c, 1);
      if (closureOperand !== calleeReg) continue;
      createIdx = j;
      break;
    }
    if (createIdx < 0) continue;
    const localCreate = localIndexOf.get(all[createIdx]!.offset);
    const localConstruct = localIndexOf.get(construct.offset);
    const localSelect = localIndexOf.get(sel.offset);
    if (localCreate !== undefined) consumed.add(localCreate);
    // The `new` is emitted at the *Construct*, not at the SelectObject: the two
    // are not always adjacent, and an instruction between them can overwrite the
    // callee register (07-for-of-iterable v99 emits `NewArray r2, 0` between
    // `Construct …, r2, 2` and its `SelectObject`). `SelectObject` then reduces
    // to a move, because `new` always yields an object.
    if (localConstruct !== undefined) newSites.set(localConstruct, { at: localConstruct, dst, calleeReg, argCount: V(construct, construct.operands.length - 1), newTargetReg });
    if (localSelect !== undefined) selectObjects.set(localSelect, V(construct, 0));
  }

  // §7.4 — `GetById rF, rO, …, "m"` followed by `CallN rD, rF, rO, …` is
  // `rO.m(…)`. The property read is elided, so the match is only taken when
  // nothing between the two touches `rF` or `rO` and nothing after the call
  // reads `rF` before overwriting it — then the elision provably drops no value.
  // Everything else goes through `Reflect.apply`, never `.bind` (PRIOR-ART §1.2
  // defect 4, EM-04).
  //
  // Worth the care: V8 derives a TypeError's text from the *call shape*, so
  // `rO.m(…)` reports "log.push is not a function" exactly as the original source
  // does, where `Reflect.apply(rF, rO, […])` reports "Function.prototype.apply
  // was called on undefined". The equivalence checker compares error messages.
  for (let i = 1; i < ins.length; i++) {
    const callInsn = ins[i]!;
    if (!CALL_N.has(callInsn.name)) continue;
    const calleeReg = V(callInsn, 1);
    const thisReg = V(callInsn, 2);
    let getIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      const c = ins[j]!;
      if (GETBYID.test(c.name) && !c.name.startsWith("Try") && V(c, 0) === calleeReg && V(c, 1) === thisReg) {
        getIdx = j;
        break;
      }
      // Anything that writes either register, or reads the callee register,
      // between the two ends the search.
      const written = writtenRegisters(c);
      if (written.includes(calleeReg) || written.includes(thisReg)) break;
      if (c.operands.some((o, k) => o.role === "reg" && o.value === calleeReg && k > 0)) break;
    }
    if (getIdx < 0 || consumed.has(getIdx)) continue;
    let readLater = false;
    for (let j = i + 1; j < ins.length; j++) {
      const later = ins[j]!;
      if (writtenRegisters(later).includes(calleeReg)) break;
      if (later.operands.some((o, k) => o.role === "reg" && o.value === calleeReg && k > 0)) {
        readLater = true;
        break;
      }
    }
    if (readLater) continue;
    consumed.add(getIdx);
    // The property *name* is a string id; the string table is only available at
    // lowering time, so the id travels through and is resolved there.
    methodCalls.set(i, { objReg: thisReg, name: String(V(ins[getIdx]!, 3)) });
  }

  void fnIndexOf;
  return { consumed, newSites, methodCalls, selectObjects, instructions: ins };
}

/** Registers holding the arguments of a frame-based call, `arg[0]` = `this`. */
export function frameArgs(f: FunctionEmitter, argCount: number): Expr[] {
  const out: Expr[] = [];
  for (let i = 0; i < argCount; i++) out.push(R(f.argBase - i));
  return out;
}

// ---------------------------------------------------------------------------

/**
 * The operand index that holds a nested function id, per closure-creating
 * opcode — the same operands the `CreateClosure`/`CreateGenerator`/class cases
 * below read. Exported so `emit/index.ts` can find, without duplicating the
 * table, *where* in a function a nested closure is created: a closure that
 * captures a loop-local environment is emitted inline at exactly that site, so
 * the site is an access to that environment's slot declarations.
 */
const CLOSURE_FN_OPERAND: ReadonlyMap<string, number> = new Map([
  ["CreateClosure", 2],
  ["CreateClosureLongIndex", 2],
  ["CreateGeneratorClosure", 2],
  ["CreateGeneratorClosureLongIndex", 2],
  ["CreateAsyncClosure", 2],
  ["CreateAsyncClosureLongIndex", 2],
  ["CreateGenerator", 2],
  ["CreateGeneratorLongIndex", 2],
  ["CreateBaseClass", 3],
  ["CreateBaseClassLongIndex", 3],
  ["CreateDerivedClass", 4],
  ["CreateDerivedClassLongIndex", 4],
]);

/** The nested function this instruction creates a closure/class for, if any. */
export function closureFunctionId(insn: Instruction): number | undefined {
  const i = CLOSURE_FN_OPERAND.get(insn.name);
  if (i === undefined) return undefined;
  return insn.operands[i]?.value;
}

export function lowerInstruction(f: FunctionEmitter, insn: Instruction, index: number, plan: BlockPlan, out: Stmt[]): void {
  const name = insn.name;
  if (plan.consumed.has(index)) return;
  if (NO_OP.has(name)) return;
  if (isTreeTerminator(insn)) return;
  if (isEnvCreate(name)) {
    // §6: a lexical environment has no runtime object. The one thing that *is*
    // emitted is the slot declaration for an environment created inside a loop:
    // there each execution needs its own binding (Hermes allocates a fresh
    // record per iteration), and a `let` in the loop body's own block scope is
    // exactly that. A declaration at the top of the function would make every
    // iteration's closures share one variable — measured on
    // 17-closure-loop-var v99, where the IIFE-captured `var i` prints 2,2,2
    // instead of 0,1,2.
    const slots = f.loopLocalSlotsAt(insn.offset);
    if (slots !== undefined && slots.length > 0) out.push({ k: "decl", kind: "let", names: [...slots] });
    return;
  }

  const newSite = plan.newSites.get(index);
  if (newSite !== undefined) {
    const args = frameArgs(f, newSite.argCount).slice(1);
    if (newSite.newTargetReg !== null) {
      out.push(assign(R(V(insn, 0)), call(prop(id("Reflect"), "construct"), [R(newSite.calleeReg), { k: "array", elements: args }, R(newSite.newTargetReg)])));
      return;
    }
    out.push(assign(R(V(insn, 0)), { k: "new", callee: R(newSite.calleeReg), args }));
    return;
  }

  const fail = (msg: string): never => {
    throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, msg, { functionIndex: f.fn.index, offset: insn.offset, section: "emit/lower" });
  };
  const set = (dst: number, value: Expr): void => {
    out.push(assign(R(dst), value));
  };

  // --- constants -----------------------------------------------------------
  switch (name) {
    case "LoadConstUndefined":
      return set(V(insn, 0), UNDEF);
    case "LoadConstNull":
      return set(V(insn, 0), lit("null"));
    case "LoadConstTrue":
      return set(V(insn, 0), lit("true"));
    case "LoadConstFalse":
      return set(V(insn, 0), lit("false"));
    case "LoadConstZero":
      return set(V(insn, 0), num(0));
    case "LoadConstUInt8":
    case "LoadConstInt":
      return set(V(insn, 0), num(V(insn, 1)));
    case "LoadConstDouble":
      return set(V(insn, 0), num(V(insn, 1)));
    case "LoadConstString":
    case "LoadConstStringLongIndex":
      return set(V(insn, 0), stringLiteral(f.mod, V(insn, 1)));
    case "LoadConstBigInt":
    case "LoadConstBigIntLongIndex":
      return set(V(insn, 0), bigIntLiteral(f.mod, V(insn, 1), f.fn.index, insn.offset));
    case "LoadConstEmpty":
      // The VM's "empty" sentinel, the value a TDZ binding holds before its
      // initialiser runs. It is only ever compared by `ThrowIfEmpty`; giving it
      // a distinguishable value is what lets that check keep its meaning
      // instead of collapsing into `undefined` (§8: emit no TDZ that the
      // bytecode does not have, but do not erase one it does).
      f.useHelper("__hbc_empty");
      return set(V(insn, 0), id("__hbc_empty"));
    case "Mov":
    case "MovLong":
      return set(V(insn, 0), RG(insn, 1));
  }

  // --- arithmetic, comparison, logic ---------------------------------------
  const binOp = BINARY[name];
  if (binOp !== undefined) return set(V(insn, 0), bin(binOp, RG(insn, 1), RG(insn, 2)));
  const unOp = UNARY[name];
  if (unOp !== undefined) return set(V(insn, 0), un(unOp, RG(insn, 1)));

  switch (name) {
    case "Inc":
    case "Dec": {
      // "JS increment, skips number check": ToNumeric then ±1, so a BigInt
      // operand must stay a BigInt rather than being coerced by unary `+`.
      const s = RG(insn, 1);
      const op = name === "Inc" ? "+" : "-";
      const isBig = bin("===", un("typeof ", s), lit('"bigint"'));
      return set(V(insn, 0), { k: "cond", test: isBig, then: bin(op, s, lit("1n")), else: bin(op, un("+", s), num(1)) });
    }
    case "ToNumber":
      return set(V(insn, 0), un("+", RG(insn, 1)));
    case "ToNumeric": {
      const s = RG(insn, 1);
      return set(V(insn, 0), { k: "cond", test: bin("===", un("typeof ", s), lit('"bigint"')), then: s, else: un("+", s) });
    }
    case "ToInt32":
      return set(V(insn, 0), bin("|", RG(insn, 1), num(0)));
    case "ToUint32":
      return set(V(insn, 0), bin(">>>", RG(insn, 1), num(0)));
    case "AddEmptyString":
      return set(V(insn, 0), bin("+", lit('""'), RG(insn, 1)));
    case "ToPropertyKey": {
      const s = RG(insn, 1);
      return set(V(insn, 0), { k: "cond", test: bin("===", un("typeof ", s), lit('"symbol"')), then: s, else: call(id("String"), [s]) });
    }
    case "TypeOfIs":
      // The mask is a `TypeOfIsTypes` bitset; `Typeof.h` is vendored per pin, so
      // every bit decodes (review M4-H2). A pin without the header still
      // refuses.
      return set(V(insn, 0), typeOfIsExpr(RG(insn, 1), V(insn, 2), typeOfIsTableFor(f.mod), { opcode: insn.name, functionIndex: f.fn.index, offset: insn.offset, section: "emit/lower" }));
  }

  // --- properties ----------------------------------------------------------
  if (GETBYID.test(name)) {
    const dst = V(insn, 0);
    const obj = RG(insn, 1);
    const text = f.mod.strings.get(V(insn, 3));
    if (text === "HermesInternal") {
      // A Hermes *host* object, not a program value: `hermesc` lowers template
      // literals to unconditional `HermesInternal.concat(...)` calls with no
      // fallback (43-template-literals v94 offset 0x1c), so decompiled output
      // that reads `globalThis.HermesInternal` cannot run anywhere but Hermes.
      // The prelude supplies the shim instead of touching the global object,
      // which would show up in the equivalence checker's `globals` record.
      f.useHelper("__hbc_HermesInternal");
      return set(dst, id("__hbc_HermesInternal"));
    }
    if (name.startsWith("Try")) {
      // "Get an object property by string table index, **or throw if not
      // found**" — the global-variable read. Reproduced faithfully, with
      // Hermes's own message rather than Node's.
      out.push({
        k: "if",
        test: un("!", bin("in", lit(quote(text)), obj)),
        then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [lit(quote(`Property '${text}' doesn't exist`))] } }],
        else: [],
      });
    }
    return set(dst, prop(obj, text));
  }
  if (PUTBYID.test(name)) {
    out.push(assign(prop(RG(insn, 0), f.mod.strings.get(V(insn, 3))), RG(insn, 1)));
    return;
  }
  if (DELBYID.test(name)) {
    return set(V(insn, 0), un("delete ", prop(RG(insn, 1), f.mod.strings.get(V(insn, 2)))));
  }

  switch (name) {
    case "GetByVal":
      return set(V(insn, 0), member(RG(insn, 1), RG(insn, 2), true));
    case "GetByIndex":
      return set(V(insn, 0), member(RG(insn, 1), num(V(insn, 2)), true));
    case "PutByVal":
    case "PutByValLoose":
    case "PutByValStrict":
      out.push(assign(member(RG(insn, 0), RG(insn, 1), true), RG(insn, 2)));
      return;
    case "DelByVal":
    case "DelByValLoose":
    case "DelByValStrict":
      return set(V(insn, 0), un("delete ", member(RG(insn, 1), RG(insn, 2), true)));
    case "GetByIdWithReceiverLong":
      return set(V(insn, 0), call(prop(id("Reflect"), "get"), [RG(insn, 1), lit(quote(f.mod.strings.get(V(insn, 4)))), RG(insn, 3)]));
    case "GetByValWithReceiver":
      return set(V(insn, 0), call(prop(id("Reflect"), "get"), [RG(insn, 1), RG(insn, 2), RG(insn, 3)]));
    case "PutByValWithReceiver":
      out.push({ k: "expr", expr: call(prop(id("Reflect"), "set"), [RG(insn, 0), RG(insn, 1), RG(insn, 2), RG(insn, 3)]) });
      return;
    case "PutNewOwnById":
    case "PutNewOwnByIdLong":
    case "PutNewOwnByIdShort":
    case "DefineOwnById":
    case "DefineOwnByIdLong":
      out.push(assign(prop(RG(insn, 0), f.mod.strings.get(V(insn, insn.operands.length - 1))), RG(insn, 1)));
      return;
    case "PutNewOwnNEById":
    case "PutNewOwnNEByIdLong":
      out.push(defineProperty(RG(insn, 0), lit(quote(f.mod.strings.get(V(insn, 2)))), [{ key: "value", value: RG(insn, 1) }], false));
      return;
    case "PutOwnByIndex":
    case "PutOwnByIndexL":
    case "DefineOwnByIndex":
    case "DefineOwnByIndexL":
    case "DefineOwnInDenseArray":
    case "DefineOwnInDenseArrayL":
      out.push(assign(member(RG(insn, 0), num(V(insn, 2)), true), RG(insn, 1)));
      return;
    case "PutOwnByVal":
    case "DefineOwnByVal": {
      const enumerable = V(insn, 3) !== 0;
      if (enumerable) {
        out.push(assign(member(RG(insn, 0), RG(insn, 2), true), RG(insn, 1)));
        return;
      }
      out.push(defineProperty(RG(insn, 0), RG(insn, 2), [{ key: "value", value: RG(insn, 1) }], false));
      return;
    }
    case "PutOwnGetterSetterByVal":
    case "DefineOwnGetterSetterByVal": {
      const enumerable = V(insn, 4) !== 0;
      // The VM (`caseDefineOwnGetterSetterByVal`) sets only the half whose
      // operand is not `undefined` and leaves the other half of an existing
      // accessor alone. Static Hermes (v98/v99) relies on that: a class
      // `get v(){}` / `set v(x){}` pair is two instructions, each with the
      // other half a literal-`undefined` register (58-class-accessor-pair-split
      // fn#0: `LoadConstUndefined r1; … r5, r4, r3, r1; … r5, r4, r1, r3`).
      // A full `{get, set}` descriptor each time would make the second clobber
      // the first, so a half that is statically a literal `undefined` is left
      // out of the descriptor — `Object.defineProperty` without that key keeps
      // the existing half, exactly the VM's semantics (docs/BUGS.md,
      // CONSOLIDATION 26). Object-literal pairs merge into one instruction at
      // every version, so both halves stay defined there.
      const entries: { key: string; value: Expr }[] = [];
      if (!isLiteralUndefinedReg(f, plan, index, V(insn, 2))) entries.push({ key: "get", value: RG(insn, 2) });
      if (!isLiteralUndefinedReg(f, plan, index, V(insn, 3))) entries.push({ key: "set", value: RG(insn, 3) });
      out.push(defineProperty(RG(insn, 0), RG(insn, 1), entries, enumerable));
      return;
    }
    case "PutOwnBySlotIdx":
    case "PutOwnBySlotIdxLong": {
      const key = f.shapeKeyFor(V(insn, 0), V(insn, 2), insn.offset);
      out.push(assign(prop(RG(insn, 0), key), RG(insn, 1)));
      return;
    }
    case "GetOwnBySlotIdx":
    case "GetOwnBySlotIdxLong":
      return set(V(insn, 0), prop(RG(insn, 1), f.shapeKeyFor(V(insn, 1), V(insn, 2), insn.offset)));
    case "LoadParentNoTraps":
    case "TypedLoadParent":
      return set(V(insn, 0), call(prop(id("Object"), "getPrototypeOf"), [RG(insn, 1)]));
    case "TypedStoreParent":
      out.push({ k: "expr", expr: call(prop(id("Object"), "setPrototypeOf"), [RG(insn, 1), RG(insn, 0)]) });
      return;
  }

  // --- private names (class private fields) --------------------------------
  switch (name) {
    case "CreatePrivateName":
      return set(V(insn, 0), call(id("Symbol"), [stringLiteral(f.mod, V(insn, 1))]));
    case "AddOwnPrivateBySym":
      // The vendored doc comment reads "Arg1[Arg2] = Arg3", but the bytecode
      // says otherwise: 35-class-private-fields v99 function #1 emits
      // `LoadConstUndefined r0; AddOwnPrivateBySym r1, r0, r3` with r3 holding
      // the private name loaded from the environment and r0 the initial value.
      // The order is (object, value, symbol), matching its Put/Get siblings.
      out.push(defineProperty(RG(insn, 0), RG(insn, 2), [{ key: "value", value: RG(insn, 1) }, { key: "writable", value: lit("true") }], false, false));
      return;
    case "PutOwnPrivateBySym":
      // "Arg1[Arg4] = Arg2" (Arg3 is a cache index).
      out.push(assign(member(RG(insn, 0), RG(insn, 3), true), RG(insn, 1)));
      return;
    case "GetOwnPrivateBySym":
      // "Arg1 = Arg2[Arg4]" (Arg3 is a cache index).
      return set(V(insn, 0), member(RG(insn, 1), RG(insn, 3), true));
    case "PrivateIsIn":
      // Own-property check only: no prototype chain, no proxy traps.
      return set(V(insn, 0), hasOwn(RG(insn, 2), RG(insn, 1)));
  }

  // --- objects and arrays ---------------------------------------------------
  switch (name) {
    case "NewObject":
      return set(V(insn, 0), { k: "object", props: [] });
    case "NewObjectWithParent": {
      const p = RG(insn, 1);
      const parent: Expr = { k: "cond", test: bin("===", p, lit("null")), then: lit("null"), else: { k: "cond", test: bin("===", un("typeof ", p), lit('"object"')), then: p, else: prop(id("Object"), "prototype") } };
      return set(V(insn, 0), call(prop(id("Object"), "create"), [parent]));
    }
    case "NewArray":
    case "NewFastArray":
      return set(V(insn, 0), { k: "new", callee: id("Array"), args: [num(V(insn, 1))] });
    case "NewArrayWithBuffer":
    case "NewArrayWithBufferLong": {
      const sizeHint = V(insn, 1);
      const count = V(insn, 2);
      const array = arrayFromBuffer(f.mod, V(insn, 3), count);
      set(V(insn, 0), array);
      if (sizeHint > count) out.push(assign(prop(R(V(insn, 0)), "length"), num(sizeHint)));
      return;
    }
    case "NewObjectWithBuffer":
    case "NewObjectWithBufferLong": {
      if (insn.operands.length === 5) {
        // v<=96: (dest, sizeHint, numProps, keyBufferIdx, valueBufferIdx)
        const keys = objectKeys(f.mod, V(insn, 3), V(insn, 2), f.fn.index, insn.offset);
        return set(V(insn, 0), objectFromBuffers(f.mod, keys, V(insn, 4), f.fn.index, insn.offset));
      }
      // v>=97: (dest, shapeTableIdx, valueBufferOffset)
      const shape = f.mod.shapes[V(insn, 1)];
      if (shape === undefined) return fail(`shape index ${V(insn, 1)} out of range`);
      const keys = objectKeys(f.mod, shape.keyBufferOffset, shape.numProps, f.fn.index, insn.offset);
      return set(V(insn, 0), objectFromBuffers(f.mod, keys, V(insn, 2), f.fn.index, insn.offset));
    }
    case "NewObjectWithBufferAndParent": {
      const shape = f.mod.shapes[V(insn, 2)];
      if (shape === undefined) return fail(`shape index ${V(insn, 2)} out of range`);
      const keys = objectKeys(f.mod, shape.keyBufferOffset, shape.numProps, f.fn.index, insn.offset);
      const literalObj = objectFromBuffers(f.mod, keys, V(insn, 3), f.fn.index, insn.offset);
      return set(V(insn, 0), call(prop(id("Object"), "assign"), [call(prop(id("Object"), "create"), [RG(insn, 1)]), literalObj]));
    }
    case "CreateRegExp":
      return set(V(insn, 0), regExpExpr(f.mod, V(insn, 1), V(insn, 2)));
  }

  // --- environment ----------------------------------------------------------
  // `resolveEnv` returns null only under `--lenient-env` (review M4-H2); the
  // default is still spec 03 §6.4's R3 refusal. The marker throws when reached,
  // so an unknown environment can never be read as `undefined`.
  const unresolvedEnvMarker = (kind: "load" | "store", slot: number): Expr => {
    f.useHelper("__hbc_unresolved_env");
    return call(id("__hbc_unresolved_env"), [lit(JSON.stringify(kind)), num(f.fn.index), num(insn.offset), num(slot)]);
  };
  switch (name) {
    case "LoadFromEnvironment":
    case "LoadFromEnvironmentL": {
      const env = f.resolveEnv(insn);
      return set(V(insn, 0), env === null ? unresolvedEnvMarker("load", V(insn, 2)) : id(envSlot(env, V(insn, 2))));
    }
    case "StoreToEnvironment":
    case "StoreToEnvironmentL":
    case "StoreNPToEnvironment":
    case "StoreNPToEnvironmentL": {
      // `StoreNPToEnvironment` is `StoreToEnvironment`: the NP is a GC
      // write-barrier hint, and emitting anything different is a bug.
      const env = f.resolveEnv(insn);
      if (env === null) out.push({ k: "expr", expr: unresolvedEnvMarker("store", V(insn, 1)) });
      else out.push(assign(id(envSlot(env, V(insn, 1))), RG(insn, 2)));
      return;
    }
    case "GetEnvironment":
    case "GetParentEnvironment":
    case "GetClosureEnvironment":
      // An environment handle has no runtime representation: every access
      // through it was resolved statically by spec 03 §6. The register is still
      // written so nothing reads an undeclared name.
      return set(V(insn, 0), UNDEF);
  }

// --- closures and generators ---------------------------------------------
  switch (name) {
    case "CreateClosure":
    case "CreateClosureLongIndex":
    case "CreateGeneratorClosure":
    case "CreateGeneratorClosureLongIndex":
    case "CreateAsyncClosure":
    case "CreateAsyncClosureLongIndex": {
      // §7.2.1: a generator/async *closure* is an ordinary closure. The shim
      // goes on `CreateGenerator`, at both eras.
      const inline = f.inlineClosure(V(insn, 2));
      if (inline !== undefined && inline.k === "func") {
        // Captures a loop-local environment, so the closure has to be created
        // *here* to see this iteration's bindings rather than being hoisted to
        // the top of the enclosing function.
        return set(V(insn, 0), { k: "func", name: inline.name, params: inline.params, body: inline.body });
      }
      return set(V(insn, 0), id(f.closureName(V(insn, 2), insn.offset)));
    }
    case "CreateGenerator":
    case "CreateGeneratorLongIndex": {
      const inner = V(insn, 2);
      if (f.version >= 97) {
        f.useHelper("__hbc_makeGeneratorLowered");
        return set(V(insn, 0), call(id("__hbc_makeGeneratorLowered"), [id(f.closureName(inner, insn.offset))]));
      }
      f.useHelper("__hbc_makeGenerator");
      return set(V(insn, 0), call(id("__hbc_makeGenerator"), [id(f.closureName(inner, insn.offset)), f.thisExpr, f.argsExpr]));
    }
    case "CreateBaseClass":
    case "CreateBaseClassLongIndex": {
      const fnId = V(insn, 3);
      set(V(insn, 0), id(f.closureName(fnId, insn.offset)));
      set(V(insn, 1), prop(R(V(insn, 0)), "prototype"));
      return;
    }
    case "CreateDerivedClass":
    case "CreateDerivedClassLongIndex": {
      const fnId = V(insn, 4);
      const superReg = RG(insn, 3);
      set(V(insn, 0), id(f.closureName(fnId, insn.offset)));
      out.push({ k: "expr", expr: call(prop(id("Object"), "setPrototypeOf"), [R(V(insn, 0)), superReg]) });
      set(V(insn, 1), prop(R(V(insn, 0)), "prototype"));
      out.push({
        k: "expr",
        expr: call(prop(id("Object"), "setPrototypeOf"), [R(V(insn, 1)), { k: "cond", test: bin("===", superReg, lit("null")), then: lit("null"), else: prop(superReg, "prototype") }]),
      });
      return;
    }
  }

  // --- calls ----------------------------------------------------------------
  if (CALL_N.has(name)) {
    const dst = V(insn, 0);
    const args: Expr[] = [];
    for (let i = 2; i < insn.operands.length; i++) args.push(RG(insn, i));
    const fast = plan.methodCalls.get(index);
    if (fast !== undefined) {
      const method = f.mod.strings.get(Number(fast.name));
      return set(dst, call(prop(R(fast.objReg), method), args.slice(1)));
    }
    return set(dst, applyCall(RG(insn, 1), args));
  }
  switch (name) {
    case "Call":
    case "CallLong": {
      const args = frameArgs(f, V(insn, 2));
      return set(V(insn, 0), applyCall(RG(insn, 1), args));
    }
    case "CallDirect":
    case "CallDirectLongIndex": {
      const args = frameArgs(f, V(insn, 1));
      return set(V(insn, 0), applyCall(id(fnName(V(insn, 2))), args));
    }
    case "Construct":
    case "ConstructLong": {
      // A bare `Construct` outside a recognised triple: hermesc does not emit
      // one today, but hand-written or obfuscated bytecode might (§7.5).
      const args = frameArgs(f, V(insn, 2)).slice(1);
      return set(V(insn, 0), call(prop(id("Reflect"), "construct"), [RG(insn, 1), { k: "array", elements: args }]));
    }
    case "CallWithNewTarget":
    case "CallWithNewTargetLong": {
      const argCount = V(insn, 3);
      const args = frameArgs(f, argCount).slice(1);
      return set(V(insn, 0), call(prop(id("Reflect"), "construct"), [RG(insn, 1), { k: "array", elements: args }, RG(insn, 2)]));
    }
    case "CallBuiltin":
    case "CallBuiltinLong": {
      const number = V(insn, 1);
      const def = f.builtins.builtins[number];
      const argCount = V(insn, 2);
      // arg[0] is the `this` slot, which the VM overwrites with `undefined`
      // before entering a builtin, so the real arguments start at arg[1].
      const args = frameArgs(f, argCount).slice(1);
      if (def?.name === "exponentiationOperator") return set(V(insn, 0), bin("**", args[0]!, args[1]!));
      const target = resolveBuiltin(def, number, f.fn.index, insn.offset);
      if (target.helper !== null) f.useHelper(target.helper);
      // Two intrinsics operate on the *caller's* arguments, which a helper
      // cannot reach on its own, so the emitter passes them explicitly.
      if (def?.name === "copyRestArgs" || def?.name === "applyArguments") return set(V(insn, 0), call(target.callee, [f.argsExpr, ...args]));
      return set(V(insn, 0), call(target.callee, args));
    }
    case "GetBuiltinClosure": {
      const number = V(insn, 1);
      const def = f.builtins.builtins[number];
      const target = resolveBuiltin(def, number, f.fn.index, insn.offset);
      if (target.helper !== null) f.useHelper(target.helper);
      return set(V(insn, 0), target.callee);
    }
    case "DirectEval":
      return set(V(insn, 0), call(id("eval"), [RG(insn, 1)]));
  }

  // --- the `new` triple -----------------------------------------------------
  if (name === "SelectObject") {
    const resultReg = plan.selectObjects.get(index);
    if (resultReg !== undefined) return set(V(insn, 0), R(resultReg));
    // Unpaired (a `Construct` whose triple straddles a boundary this pass could
    // not close). §7.5 makes this loud; it is lowered rather than skipped,
    // because `SelectObject` has an exact JS form —
    // "Arg1 = Arg3 instanceof Object ? Arg3 : Arg2".
    f.diagnostic({ severity: "warn", code: "W_UNPAIRED_NEW", message: `SelectObject at offset ${insn.offset} is not part of a recognised \`new\` triple; lowering it directly`, context: { functionIndex: f.fn.index, offset: insn.offset } });
    const result = RG(insn, 2);
    return set(V(insn, 0), { k: "cond", test: bin("instanceof", result, id("Object")), then: result, else: RG(insn, 1) });
  }
  if (name === "CreateThisForSuper") {
    // "Some closures are responsible for making their own `this`, so in these
    // cases this instruction will simply return undefined." A derived
    // constructor's `this` comes from the super call, so outside a recognised
    // triple that is exactly the case — measured on 33-class-inheritance-super
    // v99 function #7 (`class Puppy extends Dog {}`'s implicit constructor,
    // which forwards through `applyArguments`).
    return set(V(insn, 0), UNDEF);
  }
  if (name === "CreateThis" || name === "CreateThisForNew") {
    f.diagnostic({ severity: "warn", code: "W_UNPAIRED_NEW", message: `${name} at offset ${insn.offset} is not part of a recognised \`new\` triple; lowering it directly`, context: { functionIndex: f.fn.index, offset: insn.offset } });
    // OrdinaryCreateFromConstructor: allocate from the constructor's prototype,
    // falling back to Object.prototype when it is not an object.
    const proto = name === "CreateThis" ? RG(insn, 1) : prop(RG(insn, 1), "prototype");
    return set(V(insn, 0), call(prop(id("Object"), "create"), [{ k: "cond", test: bin("instanceof", proto, id("Object")), then: proto, else: prop(id("Object"), "prototype") }]));
  }

  // --- iteration ------------------------------------------------------------
  switch (name) {
    case "IteratorBegin": {
      f.useHelper("__hbc_iterBegin");
      f.needScratch();
      out.push(assign(id(SCRATCH), call(id("__hbc_iterBegin"), [RG(insn, 1)])));
      set(V(insn, 0), member(id(SCRATCH), num(0), true));
      set(V(insn, 1), member(id(SCRATCH), num(1), true));
      return;
    }
    case "IteratorNext": {
      f.useHelper("__hbc_iterNext");
      f.needScratch();
      out.push(assign(id(SCRATCH), call(id("__hbc_iterNext"), [RG(insn, 1), RG(insn, 2)])));
      set(V(insn, 0), member(id(SCRATCH), num(0), true));
      set(V(insn, 1), member(id(SCRATCH), num(1), true));
      return;
    }
    case "IteratorClose":
      f.useHelper("__hbc_iterClose");
      out.push({ k: "expr", expr: call(id("__hbc_iterClose"), [RG(insn, 0), lit(V(insn, 1) !== 0 ? "true" : "false")]) });
      return;
    case "GetPNameList": {
      f.useHelper("__hbc_pnames");
      set(V(insn, 0), call(id("__hbc_pnames"), [RG(insn, 1)]));
      set(V(insn, 2), num(0));
      set(V(insn, 3), { k: "cond", test: bin("===", R(V(insn, 0)), UNDEF), then: num(0), else: prop(R(V(insn, 0)), "length") });
      return;
    }
    case "GetNextPName": {
      f.useHelper("__hbc_nextPName");
      f.needScratch();
      out.push(assign(id(SCRATCH), call(id("__hbc_nextPName"), [RG(insn, 1), RG(insn, 2), RG(insn, 3)])));
      set(V(insn, 0), member(id(SCRATCH), num(0), true));
      set(V(insn, 3), member(id(SCRATCH), num(1), true));
      return;
    }
  }

  // --- arguments ------------------------------------------------------------
  switch (name) {
    case "ReifyArguments":
    case "ReifyArgumentsLoose":
    case "ReifyArgumentsStrict":
      f.useHelper("__hbc_arguments");
      return set(V(insn, 0), call(id("__hbc_arguments"), [f.argsExpr]));
    case "GetArgumentsLength":
      return set(V(insn, 0), prop(f.argsExpr, "length"));
    case "GetArgumentsPropByVal":
    case "GetArgumentsPropByValLoose":
    case "GetArgumentsPropByValStrict":
      return set(V(insn, 0), member(f.argsExpr, RG(insn, 1), true));
  }

  // --- this, globals, misc --------------------------------------------------
  switch (name) {
    case "LoadParam":
    case "LoadParamLong":
      return set(V(insn, 0), f.paramExpr(V(insn, 1)));
    case "LoadThisNS":
      return set(V(insn, 0), coerceThis(f.thisExpr));
    case "CoerceThisNS":
      return set(V(insn, 0), coerceThis(RG(insn, 1)));
    case "GetGlobalObject":
      return set(V(insn, 0), id("globalThis"));
    case "GetNewTarget":
      return set(V(insn, 0), f.newTargetExpr);
    case "DeclareGlobalVar": {
      const text = f.mod.strings.get(V(insn, 0));
      // `var` semantics: create the binding if it is not already there, rather
      // than clobbering a value a previous declaration already stored.
      out.push({
        k: "if",
        test: un("!", hasOwn(id("globalThis"), lit(quote(text)))),
        then: [assign(prop(id("globalThis"), text), UNDEF)],
        else: [],
      });
      return;
    }
    case "ThrowIfHasRestrictedGlobalProperty": {
      const text = f.mod.strings.get(V(insn, 0));
      out.push({
        k: "if",
        test: bin("in", lit(quote(text)), id("globalThis")),
        then: [{ k: "throw", arg: { k: "new", callee: id("SyntaxError"), args: [lit(quote(`Cannot declare global property '${text}'`))] } }],
        else: [],
      });
      return;
    }
    case "Catch":
      // The exception value travels through the emitter's per-function `__exc`,
      // so a handler shared by several regions still sees the right value.
      return set(V(insn, 0), id(EXC_VALUE));
    case "ThrowIfEmpty": {
      f.useHelper("__hbc_empty");
      out.push({
        k: "if",
        test: bin("===", RG(insn, 1), id("__hbc_empty")),
        then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [lit('"accessing an uninitialized variable"')] } }],
        else: [],
      });
      return set(V(insn, 0), RG(insn, 1));
    }
    case "ThrowIfUndefined": {
      out.push({
        k: "if",
        test: bin("===", RG(insn, 1), UNDEF),
        then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [lit('"accessing an uninitialized variable"')] } }],
        else: [],
      });
      return set(V(insn, 0), RG(insn, 1));
    }
    case "ThrowIfThisInitialized": {
      f.useHelper("__hbc_empty");
      out.push({
        k: "if",
        test: bin("!==", RG(insn, 0), id("__hbc_empty")),
        then: [{ k: "throw", arg: { k: "new", callee: id("ReferenceError"), args: [lit('"super() called twice"')] } }],
        else: [],
      });
      return;
    }
  }

  // --- v<=96 generator protocol (§7.2.1) ------------------------------------
  switch (name) {
    case "SaveGenerator":
    case "SaveGeneratorLong": {
      const state = f.suspendStateFor(insn.offset);
      out.push(assign(id(GEN_STATE), num(state)));
      return;
    }
    case "ResumeGenerator": {
      set(V(insn, 0), id(GEN_SENT));
      set(V(insn, 1), id(GEN_IS_RETURN));
      // The VM implements `.throw()` by raising at the saved pc; reproducing
      // that here is what makes the exception unwind through the body's own
      // handlers (§7.2.1).
      out.push({ k: "if", test: id("__isThrow"), then: [{ k: "throw", arg: id(GEN_SENT) }], else: [] });
      return;
    }
    case "CompleteGenerator":
      out.push(assign(id(GEN_DONE), lit("true")));
      return;
  }

  return fail(`no lowering for opcode ${name}`);
}

/** `Object.prototype.hasOwnProperty.call(o, k)` — never `o.hasOwnProperty(k)`. */
/**
 * True when register `r`, read by the instruction at `index` of the block
 * `plan` describes, statically holds a literal `undefined`: either the nearest
 * preceding write to `r` in this block is a `LoadConstUndefined`, or (no write
 * in the block before `index`) every write to `r` anywhere in the function is
 * one — hermesc hoists a shared `LoadConstUndefined` into the entry block and
 * reuses that register. Anything else answers false (the pre-fix full
 * descriptor half is then emitted); never a guess.
 */
function isLiteralUndefinedReg(f: FunctionEmitter, plan: BlockPlan, index: number, r: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const prev = plan.instructions[i]!;
    if (writtenRegisters(prev).includes(r)) return prev.name === "LoadConstUndefined";
  }
  let writes = 0;
  for (const ins of f.fn.instructions) {
    if (!writtenRegisters(ins).includes(r)) continue;
    if (ins.name !== "LoadConstUndefined") return false;
    writes++;
  }
  return writes > 0;
}

function hasOwn(obj: Expr, key: Expr): Expr {
  return call(member(prop(prop(id("Object"), "prototype"), "hasOwnProperty"), lit("call"), false), [obj, key]);
}

function coerceThis(v: Expr): Expr {
  // "Primitives are boxed, null/undefined produce the global object."
  return { k: "cond", test: { k: "logical", op: "||", left: bin("===", v, lit("null")), right: bin("===", v, UNDEF) }, then: id("globalThis"), else: call(id("Object"), [v]) };
}

/** §7.4 — `Reflect.apply`, never `.bind` (PRIOR-ART §1.2 defect 4, EM-04). */
function applyCall(callee: Expr, args: readonly Expr[]): Expr {
  return call(prop(id("Reflect"), "apply"), [callee, args[0] ?? UNDEF, { k: "array", elements: args.slice(1) }]);
}

function defineProperty(obj: Expr, key: Expr, entries: readonly { key: string; value: Expr }[], enumerable: boolean, configurable = true): Stmt {
  const props = entries.map((e) => ({ key: e.key, computed: false, value: e.value }));
  props.push({ key: "enumerable", computed: false, value: lit(enumerable ? "true" : "false") });
  props.push({ key: "configurable", computed: false, value: lit(configurable ? "true" : "false") });
  return { k: "expr", expr: call(prop(id("Object"), "defineProperty"), [obj, key, { k: "object", props }]) };
}
