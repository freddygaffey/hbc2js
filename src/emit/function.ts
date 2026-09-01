// docs/specs/05-emitter.md §3, §4, §6, §9 — one function's shell and body.
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";
import type { DecodedFunction, Instruction } from "../disasm/decode.ts";
import type { BlockId, EnvGraph, FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import { siteKey } from "../cfg/types.ts";
import { writtenRegisters } from "../cfg/reg-effects.ts";
import type { HbcModule } from "../parse/types.ts";
import type { BuiltinTable, TypeOfIsTable } from "../tables/types.ts";
import { typeOfIsTableFor } from "./typeofis.ts";
import type { LabelId, Stmt as IrStmt, StructuredFunction, SwitchArm } from "../structure/ir.ts";
import type { Expr, Stmt } from "./ast.ts";
import { assign, bin, call, id, lit, num, un, UNDEF } from "./ast.ts";
import { conditionFor } from "./conds.ts";
import { resolveBuiltin } from "./builtins.ts";
import { lowerInstruction, planBlock, prop } from "./lower.ts";
import { EXC_VALUE, envSlot, excName, fnName, GEN_DONE, GEN_STATE, labelName, PC_VAR, quote, reg, SCRATCH, stateVar } from "./names.ts";
import { argSlotBase } from "./semantics.ts";

export interface FunctionEmitter {
  readonly analysis: ModuleAnalysis;
  readonly mod: HbcModule;
  readonly fn: DecodedFunction;
  readonly cfg: FunctionCfg;
  readonly version: number;
  readonly argBase: number;
  readonly builtins: BuiltinTable;
  readonly thisExpr: Expr;
  readonly argsExpr: Expr;
  readonly newTargetExpr: Expr;
  useHelper(name: string): void;
  needScratch(): void;
  /** The env node an environment access resolves to, or `null` under
   *  `--lenient-env` when spec 03 §6 could not resolve it (strict aborts). */
  resolveEnv(insn: Instruction): number | null;
  recordShape(register: number, keys: readonly string[]): void;
  /** The env node created at `offset`, when its slots are declared inline. */
  loopLocalSlotsAt(offset: number): readonly string[] | undefined;
  /** The function body to inline at a `CreateClosure` of `functionIndex`. */
  inlineClosure(functionIndex: number): Stmt | undefined;
  shapeKeyFor(register: number, slot: number, offset: number): string;
  suspendStateFor(offset: number): number;
  diagnostic(d: Diagnostic): void;
  paramExpr(index: number): Expr;
}

export interface EmitFunctionInput {
  readonly analysis: ModuleAnalysis;
  readonly envGraph: EnvGraph;
  readonly structured: StructuredFunction;
  readonly cfg: FunctionCfg;
  readonly fn: DecodedFunction;
  readonly builtins: BuiltinTable;
  readonly children: readonly Stmt[];
  /** Children emitted *at their creation site* rather than hoisted (§6 note). */
  readonly inlineChildren: ReadonlyMap<number, Stmt>;
  readonly ownedEnvSlots: readonly string[];
  /** Env nodes whose slots are declared at the `Create*Environment` instruction. */
  readonly loopLocalEnvSlots: ReadonlyMap<number, readonly string[]>;
  readonly useHelper: (name: string) => void;
  readonly diagnostic: (d: Diagnostic) => void;
  readonly provenanceComments: boolean;
  /** Spec 03 §6.4's R3 rule. False = `--lenient-env`: an unresolvable access
   *  becomes a loud `__hbc_unresolved_env(...)` marker instead of aborting. */
  readonly strictEnv: boolean;
}

/** Blocks whose bytes lie outside `region.bodyBlocks` but inside its try body. */
interface TryPlan {
  readonly needsPc: boolean;
  /** region index -> the region's inclusive block-id range. */
  readonly guard: ReadonlyMap<number, readonly [number, number]>;
}

function planTries(structured: StructuredFunction): TryPlan {
  const guard = new Map<BlockId, [number, number]>();
  let needsPc = false;
  const stack: IrStmt[] = [structured.root];
  const bodyBlocksOf = (node: IrStmt): Set<BlockId> => {
    const out = new Set<BlockId>();
    const s: IrStmt[] = [node];
    while (s.length > 0) {
      const n = s.pop()!;
      if (n.k === "block" || n.k === "return" || n.k === "throw") out.add(n.cfgBlock);
      if (n.k === "if" || n.k === "switch" || n.k === "try") out.add(n.cfgBlock);
      s.push(...childrenOf(n));
    }
    return out;
  };
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.k === "try") {
      const region = structured.graph.cfg.regions[n.region]!;
      const inBody = bodyBlocksOf(n.body);
      // A `cfgBlock: -1` try is §4.4's dispatch nest, whose extent is the whole
      // function by construction — there the guard is not an optimisation, it is
      // what selects the right handler.
      let over = n.cfgBlock < 0;
      for (const b of inBody) {
        if (structured.graph.blocks[b]?.block === null) continue; // synthetic try-head
        if (!region.bodyBlocks.has(b)) {
          over = true;
          break;
        }
      }
      const ids = [...region.bodyBlocks];
      if (over && ids.length > 0) {
        needsPc = true;
        guard.set(n.region, [Math.min(...ids), Math.max(...ids)]);
      }
    }
    stack.push(...childrenOf(n));
  }
  return { needsPc, guard };
}

function childrenOf(node: IrStmt): readonly IrStmt[] {
  switch (node.k) {
    case "seq":
      return node.body;
    case "labeled":
    case "loop":
      return [node.body];
    case "if":
      return [node.then, node.else];
    case "switch":
      return [...node.cases.map((c) => c.body), node.default];
    case "try":
      return [node.body, node.handler];
    default:
      return [];
  }
}

export function emitFunction(input: EmitFunctionInput): Stmt {
  const { analysis, envGraph, structured, cfg, fn, builtins } = input;
  const mod = analysis.module;
  const version = mod.header.version;
  const header = fn.header;
  const frameSize = header.frameSize;
  const paramCount = header.paramCount;
  const isGlobal = fn.index === mod.header.globalCodeIndex;

  // A v<=96 generator/async *body* becomes a frame factory returning a `step`
  // closure (src/runtime/helpers.ts, §7.2.1): the VM saves and restores the whole
  // register frame across a suspend, so the frame must outlive one call.
  // Keyed on the *opcodes*, not on `suspendPoints.length`: a v<=96 generator
  // with no reachable `yield` still runs through the resume protocol and still
  // needs the frame factory (found on rn-template-0.72, where such a body
  // referenced `__sent` from an ordinary function shell).
  const isOpcodeGeneratorBody = fn.instructions.some((i) => i.name === "StartGenerator" || i.name === "ResumeGenerator" || i.name === "CompleteGenerator" || i.name === "SaveGenerator" || i.name === "SaveGeneratorLong");

  const usedHelpers = new Set<string>();
  let needScratch = false;
  const shapes = new Map<number, readonly string[]>();

  // `Function.prototype.length` is observable, and a rest parameter does not
  // count towards it: `function variadicSum(...nums)` has `paramCount = 2` in
  // the header but `length === 0` in JS. `copyRestArgs` in the body is exactly
  // the marker for "the last declared parameter is a rest element"
  // (40-spread-array, 42-rest-params, 44-tagged-templates all trip on this).
  // v<=96 counts the rest element in `paramCount`, v>=97 does not (measured on
  // 44-tagged-templates: `html(strings, ...values)` is `params=3` at v94 and
  // `params=2` at v99, and JS reports `length === 1` for both).
  const hasRestParam = version <= 96 && fn.instructions.some((i) => (i.name === "CallBuiltin" || i.name === "CallBuiltinLong") && builtins.builtins[i.operands[1]!.value]?.name === "copyRestArgs");
  const namedParams = Math.max(0, paramCount - (hasRestParam ? 2 : 1));
  const params: string[] = [];
  for (let i = 1; i <= namedParams; i++) params.push(`a${i}`);

  const thisExpr: Expr = isOpcodeGeneratorBody ? id("__this") : { k: "this" };
  const argsExpr: Expr = isOpcodeGeneratorBody ? id("__args") : { k: "argumentsObject" };

  const tryPlan = planTries(structured);

  // F9 (spec `docs/specs/passes/01-framework-fixes.md`): a loop annotated
  // `hideLabel` has had every break/continue that used to name it rewritten
  // unlabelled by `06-label-clean`, so the label itself prints as nothing.
  // Nothing sets `hideLabel` in batch 1, so `hiddenLabels` is always empty
  // today and every call below behaves exactly like the old `labelName`.
  const hiddenLabels = new Set<LabelId>();
  {
    const stack: IrStmt[] = [structured.root];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (n.k === "loop" && n.hideLabel === true) hiddenLabels.add(n.label);
      stack.push(...childrenOf(n));
    }
  }
  const labelOf = (id: LabelId): string | null => (hiddenLabels.has(id) ? null : labelName(id));

  const f: FunctionEmitter = {
    analysis,
    mod,
    fn,
    cfg,
    version,
    argBase: argSlotBase(version, frameSize),
    builtins,
    thisExpr,
    argsExpr,
    newTargetExpr: lit("new.target"),
    useHelper(name: string): void {
      usedHelpers.add(name);
      input.useHelper(name);
    },
    needScratch(): void {
      needScratch = true;
    },
    resolveEnv(insn: Instruction): number | null {
      const env = envGraph.resolvedAt.get(siteKey(fn.index, insn.offset));
      if (env === undefined) {
        if (input.strictEnv) {
          throw new Hbc2jsError(ErrorCode.E_ENV_UNRESOLVED, `${insn.name} at offset ${insn.offset} has no statically resolved environment`, { functionIndex: fn.index, offset: insn.offset, section: "emit" });
        }
        input.diagnostic({ severity: "warn", code: "W_ENV_UNRESOLVED", message: `${insn.name} at offset ${insn.offset} has no statically resolved environment; emitted as a __hbc_unresolved_env marker (--lenient-env)`, context: { functionIndex: fn.index, offset: insn.offset, section: "emit" } });
        return null;
      }
      return env;
    },
    recordShape(register: number, keys: readonly string[]): void {
      shapes.set(register, keys);
    },
    loopLocalSlotsAt(offset: number): readonly string[] | undefined {
      return input.loopLocalEnvSlots.get(offset);
    },
    inlineClosure(functionIndex: number): Stmt | undefined {
      return input.inlineChildren.get(functionIndex);
    },
    shapeKeyFor(register: number, slot: number, offset: number): string {
      const keys = shapes.get(register);
      const key = keys?.[slot];
      if (key === undefined) {
        throw new Hbc2jsError(ErrorCode.E_EMIT_UNSUPPORTED, `slot ${slot} of r${register} has no known object shape at offset ${offset}`, { functionIndex: fn.index, offset, section: "emit" });
      }
      return key;
    },
    diagnostic(d: Diagnostic): void {
      input.diagnostic(d);
    },
    suspendStateFor(offset: number): number {
      const sp = cfg.generator.suspendPoints.find((s) => s.saveOffset === offset);
      if (sp === undefined) {
        throw new Hbc2jsError(ErrorCode.E_INTERNAL, `SaveGenerator at offset ${offset} has no suspend point`, { functionIndex: fn.index, offset, section: "emit" });
      }
      return sp.state;
    },
    paramExpr(index: number): Expr {
      if (index === 0) return thisExpr;
      if (index <= namedParams) return id(`a${index}`);
      return { k: "member", obj: argsExpr, prop: num(index - 1), computed: true };
    },
  };

  // --- block lowering -------------------------------------------------------
  /**
   * `range` (spec 07 loop-cond/for-header) lowers only instructions
   * [from, to) — a loop head's init/step slices. The block prelude (pc, provenance)
   * belongs to the first slice only.
   */
  const lowerBlock = (blockId: BlockId, range?: { readonly from?: number; readonly to?: number }): Stmt[] => {
    const out: Stmt[] = [];
    // `cfgBlock: -1` is §4.4's dispatch switch, which stands for no CFG block.
    if (blockId < 0) return out;
    const aug = structured.graph.blocks[blockId]!;
    if (aug.block === null) return out; // synthetic try-head owns no bytes
    const from = range?.from ?? 0;
    const to = range?.to ?? aug.block.instructions.length;
    if (from === 0 && tryPlan.needsPc) out.push(assign(id(PC_VAR), num(blockId)));
    if (from === 0 && input.provenanceComments && aug.block.start >= 0) out.push({ k: "comment", text: `@0x${aug.block.start.toString(16)}` });
    const plan = planBlock(aug.block, fn.instructions);
    for (const [i, insn] of aug.block.instructions.entries()) {
      if (i < from || i >= to) continue;
      lowerInstruction(f, insn, i, plan, out);
      // Keep the object-shape map honest: a register written by anything other
      // than a `NewObjectWithBuffer` no longer holds that shape.
      if (!insn.name.startsWith("NewObjectWithBuffer")) for (const r of writtenRegisters(insn)) shapes.delete(r);
    }
    return out;
  };

  const conditionOf = (blockId: BlockId): Expr => {
    const block = structured.graph.blocks[blockId]!.block!;
    const last = block.instructions[block.instructions.length - 1]!;
    const regs = last.operands.filter((o) => o.role === "reg").map((o) => id(reg(o.value)) as Expr);
    const extra: { builtin?: Expr; typeOfIsMask?: number; typeOfIsTable?: TypeOfIsTable | null } = {};
    if (last.name.startsWith("JmpBuiltinIs")) {
      const number = last.operands[1]!.value;
      const target = resolveBuiltin(builtins.builtins[number], number, fn.index, last.offset);
      if (target.helper !== null) f.useHelper(target.helper);
      extra.builtin = target.callee;
    }
    if (last.name === "JmpTypeOfIs") {
      extra.typeOfIsMask = last.operands[2]!.value;
      extra.typeOfIsTable = typeOfIsTableFor(mod);
    }
    return conditionFor(last, regs, extra, fn.index);
  };

  const returnValueOf = (blockId: BlockId): Expr => {
    const block = structured.graph.blocks[blockId]!.block!;
    const last = block.instructions[block.instructions.length - 1];
    if (last === undefined || last.name !== "Ret") return UNDEF;
    return id(reg(last.operands[0]!.value));
  };

  const throwValueOf = (blockId: BlockId): Expr => {
    const block = structured.graph.blocks[blockId]!.block!;
    const last = block.instructions[block.instructions.length - 1]!;
    return id(reg(last.operands[0]!.value));
  };

  const scrutineeOf = (node: IrStmt & { k: "switch" }): Expr => {
    if (node.scrutinee.t === "dispatch") return id(stateVar(node.scrutinee.variable.id));
    if (node.scrutinee.t === "generator-state") return id(GEN_STATE);
    const block = structured.graph.blocks[node.cfgBlock]!.block!;
    const last = block.instructions[block.instructions.length - 1]!;
    return id(reg(last.operands[0]!.value));
  };

  const armTest = (arm: SwitchArm): Expr => (arm.isString ? lit(quote(mod.strings.get(arm.value))) : num(arm.value));

  // --- tree -> statements (§4) ---------------------------------------------
  // Loop-form state (spec 07): a `for` head's init comes from the block that
  // precedes the loop, its step from a block inside the body; both are printed
  // once, in the head, and trimmed where they would otherwise appear.
  const trims = new Map<BlockId, number>();
  let pendingInit: Expr | null = null;

  /** All plain expression statements, or null. */
  const asExprs = (stmts: readonly Stmt[]): Expr | null => {
    const exprs: Expr[] = [];
    for (const s of stmts) {
      if (s.k === "comment") continue;
      if (s.k !== "expr") return null;
      exprs.push(s.expr);
    }
    if (exprs.length === 0) return null;
    return exprs.length === 1 ? exprs[0]! : { k: "seq", exprs };
  };

  /**
   * spec 07 loop-cond / for-header. The annotated `if` (the loop test) is
   * dropped from the body and printed as the loop condition; the `continue`
   * / `break` it guarded are implied by the loop form. Returns false — and
   * prints nothing — when the tree is not the shape the annotation promises,
   * in which case the caller prints the plain `while (true)`.
   */
  const lowerFormedLoop = (node: IrStmt & { k: "loop" }, form: NonNullable<(IrStmt & { k: "loop" })["form"]>, init: Expr | null, out: Stmt[]): boolean => {
    const items = node.body.k === "seq" ? node.body.body : [node.body];
    const gi = items.findIndex((s) => s.k === "if" && s.cfgBlock === form.cond);
    if (gi < 1 || items[gi - 1]!.k !== "block" || (items[gi - 1] as IrStmt & { k: "block" }).cfgBlock !== form.cond) return false;
    const guard = items[gi] as IrStmt & { k: "if" };
    const isHead = form.at === "head" && gi === 1;
    const isTail = form.at === "tail" && gi === items.length - 1;
    if (!isHead && !isTail) return false;
    const test = form.negate ? un("!", conditionOf(form.cond)) : conditionOf(form.cond);
    const label = labelOf(node.label);
    const body: Stmt[] = [];
    let update: Expr | null = null;
    const step = form.step;
    const stepInsns = step === undefined ? undefined : structured.graph.blocks[step.cfgBlock]?.block?.instructions.length;
    if (step !== undefined && stepInsns !== undefined) trims.set(step.cfgBlock, step.from);
    if (isHead) {
      // Only the jump may live in the head block: anything else has nowhere to go.
      if (lowerBlock(form.cond).some((s) => s.k !== "comment")) {
        if (step !== undefined) trims.delete(step.cfgBlock);
        return false;
      }
      lowerTree(form.negate ? guard.else : guard.then, body);
      lowerItems(items.slice(2), body);
    } else {
      lowerItems(items.slice(0, gi - 1), body);
      body.push(...(step !== undefined && step.cfgBlock === form.cond ? lowerBlock(form.cond, { to: step.from }) : lowerBlock(form.cond)));
    }
    if (step !== undefined && stepInsns !== undefined) {
      trims.delete(step.cfgBlock);
      const end = step.cfgBlock === form.cond ? stepInsns - 1 : stepInsns;
      const stmts = lowerBlock(step.cfgBlock, { from: step.from, to: end });
      update = asExprs(stmts);
      if (update === null) body.push(...stmts);
    }
    if (form.kind === "do-while") out.push({ k: "do-while", label, test, body });
    else if (init !== null || update !== null) out.push({ k: "for", label, init, test, update, body });
    else out.push({ k: "while", label, test, body });
    return true;
  };

  /** A statement list; a block followed by a `for`-form loop hands its init slice to the loop. */
  const lowerItems = (list: readonly IrStmt[], out: Stmt[]): void => {
    for (const [i, c] of list.entries()) {
      const next = list[i + 1];
      const init = next?.k === "loop" ? next.form?.init : undefined;
      if (c.k === "block" && init !== undefined && init.cfgBlock === c.cfgBlock) {
        const head = asExprs(lowerBlock(c.cfgBlock, { from: init.from }));
        if (head !== null) {
          out.push(...lowerBlock(c.cfgBlock, { to: init.from }));
          pendingInit = head;
          continue;
        }
      }
      lowerTree(c, out);
    }
  };

  const lowerTree = (node: IrStmt, out: Stmt[]): void => {
    switch (node.k) {
      case "block": {
        const to = trims.get(node.cfgBlock);
        out.push(...(to === undefined ? lowerBlock(node.cfgBlock) : lowerBlock(node.cfgBlock, { to })));
        return;
      }
      case "seq":
        lowerItems(node.body, out);
        return;
      case "labeled": {
        const body: Stmt[] = [];
        lowerTree(node.body, body);
        out.push({ k: "labeled", label: labelName(node.label), body });
        return;
      }
      case "loop": {
        const init = pendingInit;
        pendingInit = null;
        if (node.form !== undefined && lowerFormedLoop(node, node.form, init, out)) return;
        // review M5-pass-1 F3: `lowerItems` already trimmed the preceding block
        // to `{ to: init.from }` on the assumption the loop would print as a
        // `for`. On this false path it did not, so the tail slice `init` was
        // captured but never emitted anywhere — print it here, in the same spot
        // it held in the original block, or it silently disappears.
        if (init !== null) out.push({ k: "expr", expr: init });
        const body: Stmt[] = [];
        lowerTree(node.body, body);
        out.push({ k: "while", label: labelOf(node.label), body });
        return;
      }
      case "if": {
        const then: Stmt[] = [];
        const els: Stmt[] = [];
        lowerTree(node.then, then);
        lowerTree(node.else, els);
        // spec 09 F11: carry if-chain's `elseIf` annotation through to the AST
        // (only when set, so the `--passes=none` AST is byte-identical).
        out.push({ k: "if", test: conditionOf(node.cfgBlock), then, else: els, ...(node.elseIf === true ? { elseIf: true } : {}) });
        return;
      }
      case "break":
        out.push({ k: "break", label: labelOf(node.label) });
        return;
      case "continue":
        out.push({ k: "continue", label: labelOf(node.label) });
        return;
      case "return":
        out.push(...lowerBlock(node.cfgBlock));
        out.push({ k: "return", arg: isOpcodeGeneratorBody ? { k: "array", elements: [returnValueOf(node.cfgBlock), id(GEN_DONE)] } : returnValueOf(node.cfgBlock) });
        return;
      case "throw":
        out.push(...lowerBlock(node.cfgBlock));
        out.push({ k: "throw", arg: throwValueOf(node.cfgBlock) });
        return;
      case "unreachable":
        // EM-08: never an empty statement. The Hermes opcode traps, and a silent
        // fallthrough would change behaviour.
        out.push({ k: "throw", arg: { k: "new", callee: id("Error"), args: [lit('"hbc2js: unreachable"')] } });
        return;
      case "setState":
        out.push(assign(id(stateVar(node.variable.id)), num(node.value)));
        return;
      case "switch": {
        out.push(...lowerBlock(node.cfgBlock));
        const cases = node.cases.map((arm) => {
          const body: Stmt[] = [];
          lowerTree(arm.body, body);
          // F12 (spec 10 §5): an arm `switch-raise` marked as falling through
          // keeps falling — no appended `break;`. Unset everywhere under
          // `--passes=none`, so the baseline stays byte-identical (PL-05).
          if (arm.fallThrough !== true) body.push({ k: "break", label: null });
          return { test: armTest(arm), body };
        });
        const dflt: Stmt[] = [];
        lowerTree(node.default, dflt);
        dflt.push({ k: "break", label: null });
        out.push({ k: "switch", disc: scrutineeOf(node), cases: [...cases, { test: null, body: dflt }] });
        return;
      }
      case "try": {
        const block: Stmt[] = [];
        lowerTree(node.body, block);
        const handler: Stmt[] = [];
        const param = excName(node.region);
        const range = tryPlan.guard.get(node.region);
        if (range !== undefined) {
          // The try's lexical extent is wider than the region's byte range
          // (src/structure/augment.ts explains why it has to be). Rethrow unless
          // the block that actually threw was inside the region, which makes the
          // over-reach unobservable.
          handler.push({
            k: "if",
            test: un("!", { k: "logical", op: "&&", left: bin(">=", id(PC_VAR), num(range[0])), right: bin("<=", id(PC_VAR), num(range[1])) }),
            then: [{ k: "throw", arg: id(param) }],
            else: [],
          });
        }
        handler.push(assign(id(EXC_VALUE), id(param)));
        lowerTree(node.handler, handler);
        out.push({ k: "try", block, param, handler });
        return;
      }
    }
  };

  const body: Stmt[] = [];
  lowerTree(structured.root, body);

  // --- shell (§9) -----------------------------------------------------------
  const prologue: Stmt[] = [];
  if (header.flags.strictMode) prologue.push({ k: "directive", text: "use strict" });
  if (isOpcodeGeneratorBody) {
    prologue.push({ k: "init", kind: "var", name: "__this", value: { k: "this" } });
    prologue.push({ k: "init", kind: "var", name: "__args", value: { k: "argumentsObject" } });
  }
  const registers: string[] = [];
  for (let i = 0; i < frameSize; i++) registers.push(reg(i));
  if (registers.length > 0) prologue.push({ k: "decl", kind: "let", names: registers });
  if (input.ownedEnvSlots.length > 0) prologue.push({ k: "decl", kind: "let", names: [...input.ownedEnvSlots] });
  if (needScratch) prologue.push({ k: "decl", kind: "let", names: [SCRATCH] });
  if (cfg.regions.length > 0) prologue.push({ k: "decl", kind: "let", names: [EXC_VALUE] });
  if (tryPlan.needsPc) prologue.push({ k: "init", kind: "let", name: PC_VAR, value: num(-1) });
  for (const v of structured.dispatchVars) prologue.push({ k: "init", kind: "let", name: stateVar(v.id), value: num(-1) });
  if (isOpcodeGeneratorBody) {
    prologue.push({ k: "init", kind: "let", name: GEN_STATE, value: num(0) });
    prologue.push({ k: "init", kind: "let", name: GEN_DONE, value: lit("false") });
  }
  prologue.push(...input.children);

  const name = fnName(fn.index);
  // EM-07: the whole file is pure ASCII, comments included — a function name
  // can legitimately contain any code unit.
  const label: Stmt = { k: "comment", text: `fn#${fn.index} ${quote(fn.name)}${isGlobal ? " (global)" : ""}` };

  if (isOpcodeGeneratorBody) {
    // `sameFrame: true` (docs/BUGS.md `E_UNBOUND_IDENT` `r3`/`r15` family):
    // this closure is not a separate Hermes function — it is `_fn${fn.index}`
    // itself, re-entered on every resume — so it shares `prologue`'s register
    // decl rather than owning its own. `src/passes/ast.ts`'s `countUses` must
    // never treat it as a register-frame boundary.
    return { k: "func", name, params, body: [label, ...prologue, { k: "return", arg: { k: "func", name: null, params: ["__sent", "__isReturn", "__isThrow"], body, sameFrame: true } }] };
  }
  return { k: "func", name, params, body: [label, ...prologue, ...body] };
}

/**
 * Which function declares each environment's slot variables.
 *
 * Normally that is the function whose body ran the `Create*Environment` — but
 * an environment whose *reference* is stored into a slot of another environment
 * outlives the call that created it, and must be declared where that longer-lived
 * environment lives. This is not a nicety: a v>=97 lowered generator body creates
 * its locals' environment on the first resume and stores it into the wrapper's
 * environment (`23-generator-basic` v99 function #3, `CreateTopLevelEnvironment
 * r8, 1` / `StoreToEnvironment r1, 0, r8`). Declaring those slots in the body
 * would reset them on every `.next()`, which is exactly the "generator forgets
 * its state after one iteration" failure.
 */
export function envDeclaringFunction(envGraph: EnvGraph, isAncestor: (candidate: number, of: number) => boolean): Map<number, number> {
  const holderOf = new Map<number, number>(); // env -> the env whose slot holds it
  for (const [key, env] of envGraph.envInSlot) {
    const holder = Number(key.slice(0, key.indexOf(":")));
    if (!holderOf.has(env)) holderOf.set(env, holder);
  }
  const out = new Map<number, number>();
  for (const node of envGraph.nodes) {
    let target = node.ownerFunction;
    let cur = node.id;
    const seen = new Set<number>([cur]);
    for (;;) {
      const holder = holderOf.get(cur);
      if (holder === undefined || seen.has(holder)) break;
      seen.add(holder);
      cur = holder;
      const owner = envGraph.nodes[cur]!.ownerFunction;
      // Only ever hoist *outwards*. A slot in a more deeply nested environment
      // can hold a reference to an outer one (an ordinary parent pointer), and
      // following that would move the declaration somewhere the accessors
      // cannot see it — E_UNBOUND_IDENT.
      if (!isAncestor(owner, node.ownerFunction)) break;
      target = owner;
    }
    out.set(node.id, target);
  }
  return out;
}

/** Env slot variable names declared in `functionIndex`. */
export function ownedEnvSlots(envGraph: EnvGraph, functionIndex: number, declaringFunction: ReadonlyMap<number, number>): string[] {
  const out: string[] = [];
  for (const node of envGraph.nodes) {
    if ((declaringFunction.get(node.id) ?? node.ownerFunction) !== functionIndex) continue;
    let maxSlot = node.size - 1;
    for (const s of envGraph.slots) if (s.env === node.id && s.slot > maxSlot) maxSlot = s.slot;
    for (let i = 0; i <= maxSlot; i++) out.push(envSlot(node.id, i));
  }
  return out;
}

/** Unused, but kept so the module's public surface matches spec 05 §2. */
export const _unusedHelpers = { call, prop };
