// src/artifact/exported-names.ts — the ONE bytecode-level half of the
// `who-calls-by-name` verb (docs/specs/17-mcp-harness.md §14). Given a
// function N, discover the property NAMES under which N's closure is stored
// (`exports.foo = function(){}` / an object-literal `{foo: function(){}}`),
// so the name-based caller scan (`ArtifactService.whoCallsByName`) knows
// which `property-get` strings mark a candidate `<slot>.foo(...)` dispatch.
//
// This is the lazy, ONE-function walk the brief calls for: the on-disk
// string-uses index records that a function DOES a property-put of name
// "foo", but not that the value put is N's closure — only the bytecode's
// `CreateClosure`→`PutById`/`PutNewOwnById` def-use chain proves that. We
// reuse `semantic-walk.ts`'s own block-local closure-register tracking idea
// (a register holds `{closure, fn}` after a `CreateClosure`), then read the
// value operand of every property-put and match it to N.
//
// Scope: the closure for N is created in N's LEXICAL PARENT (hermesc emits
// `CreateClosure fn=N` in the function that closes over it), so scanning the
// parent function is both correct and cheap. Block-local dataflow only (a
// register's closure classification is reset per CFG block) — conservative:
// a missed export name yields fewer by-name candidates, never a wrong edge.
import type { ModuleAnalysis } from "../cfg/types.ts";
import type { HbcModule } from "../parse/types.ts";
import type { Instruction } from "../disasm/decode.ts";
import type { StringUseRole } from "./schema.ts";

const CREATE_CLOSURE = new Set([
  "CreateClosure",
  "CreateClosureLongIndex",
  "CreateGeneratorClosure",
  "CreateGeneratorClosureLongIndex",
  "CreateAsyncClosure",
  "CreateAsyncClosureLongIndex",
]);
const PUTBYID = /^(Try)?PutById(Loose|Strict)?(Long)?$/;
const PROPKEY_DEF = /^(PutNewOwnById|DefineOwnById)(Long|Short)?$/;

const V = (insn: Instruction, i: number): number => insn.operands[i]!.value;

export interface ExportName {
  readonly name: string;
  readonly sid: number;
  readonly role: StringUseRole; // "property-put" | "property-key"
}

/** Walk one function's instructions and return, for every closure it CREATES,
 *  the property names its closure register is subsequently stored under. Keyed
 *  by the created function index. Block-local: a `CreateClosure`'s dest reg is
 *  only trusted within its own CFG block. */
function closureExportNamesIn(module: HbcModule, analysis: ModuleAnalysis, hostFn: number): Map<number, ExportName[]> {
  const out = new Map<number, ExportName[]>();
  let cfg: ReturnType<ModuleAnalysis["cfg"]>;
  try {
    cfg = analysis.cfg(hostFn);
  } catch {
    return out;
  }
  const strings = module.strings;

  const record = (fn: number, sid: number, role: StringUseRole): void => {
    const name = strings.get(sid);
    const list = out.get(fn) ?? [];
    // dedup by (name, role)
    if (!list.some((e) => e.sid === sid && e.role === role)) list.push({ name, sid, role });
    out.set(fn, list);
  };

  for (const block of cfg.blocks) {
    // reg -> closure fn it currently holds (block-local)
    const closureReg = new Map<number, number>();
    for (const insn of block.instructions) {
      const name = insn.name;
      const dst = insn.operands[0]?.value;

      if (CREATE_CLOSURE.has(name)) {
        if (dst !== undefined) closureReg.set(dst, V(insn, 2));
        continue;
      }
      if (PUTBYID.test(name)) {
        // operands: [obj, value, cacheIdx, string]
        const valFn = closureReg.get(V(insn, 1));
        if (valFn !== undefined) record(valFn, V(insn, 3), "property-put");
        continue; // PutById reads operand 0, never writes it
      }
      if (PROPKEY_DEF.test(name)) {
        // operands: [obj, value, string(last)]
        const valFn = closureReg.get(V(insn, 1));
        if (valFn !== undefined) record(valFn, V(insn, insn.operands.length - 1), "property-key");
        continue;
      }
      // Any other instruction that writes a register invalidates a stale
      // closure classification of that register (Put/Store/Define read
      // operand 0, so they are excluded — same rule as semantic-walk.ts).
      const op0 = insn.operands[0];
      if (dst !== undefined && op0 !== undefined && (op0.type === "Reg8" || op0.type === "Reg32") && !/^(Put|Store|Define)/.test(name)) {
        closureReg.delete(dst);
      }
    }
  }
  return out;
}

/** The export names of function `fn`, proven from bytecode. `parentFn` is
 *  `fn`'s lexical parent (the function whose bytecode creates `fn`'s closure);
 *  when it is unknown/`null` we fall back to `moduleFactory`. Both are tried
 *  and their results unioned — cheap (≤2 function walks). */
export function exportedNamesOf(
  module: HbcModule,
  analysis: ModuleAnalysis,
  fn: number,
  hosts: readonly number[],
): readonly ExportName[] {
  const seen = new Set<string>();
  const acc: ExportName[] = [];
  for (const host of hosts) {
    if (host < 0) continue;
    const names = closureExportNamesIn(module, analysis, host).get(fn) ?? [];
    for (const e of names) {
      const key = `${e.sid}\0${e.role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      acc.push(e);
    }
  }
  return acc;
}
