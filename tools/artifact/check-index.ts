#!/usr/bin/env node
// tools/artifact/check-index.ts — the independent index checker (docs/specs/
// 10-artifact-format.md §4.1, decision-8 metric 1).
//
// INDEPENDENCE (reviewer binding note, §10 finding 3): this file's call/
// global/string-use resolution is its OWN def-use walk over the disassembly,
// written from scratch against the opcode semantics — it does NOT import
// `src/artifact/semantic-walk.ts` (the index builder's walker). Sharing
// `analyseModule`/`decoded`/`cfg`/`getBuiltinTable`/the string table is fine
// (those are the parse-level facts under test, not the resolution logic);
// the AST/bytecode production is unavoidably shared (it is the object under
// test), only the EXTRACTION differs. A mismatch here is either a real index
// bug or a genuine algorithmic disagreement to adjudicate — never a checker
// that imports the thing it is checking (that would just check the builder
// against itself).
//
// Usage:
//   node tools/artifact/check-index.ts <artifactDir> --hbc <bundle.hbc> [--sample 200] [--seed 1] [--all] [--fn N]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyseModule } from "../../src/cfg/index.ts";
import type { ModuleAnalysis } from "../../src/cfg/types.ts";
import { parseHbc } from "../../src/parse/module.ts";
import type { HbcModule } from "../../src/parse/types.ts";
import type { Instruction } from "../../src/disasm/decode.ts";
import { getBuiltinTable } from "../../src/tables/registry.ts";
import type { BuiltinDef } from "../../src/tables/types.ts";
import { sha256Hex } from "../../src/artifact/schema.ts";
import type { CallRow, GlobalRow, Manifest, StringUseRow } from "../../src/artifact/schema.ts";

// ---------------------------------------------------------------------------
// Deterministic seeded sampling (own tiny LCG — no shared RNG utility).
// ---------------------------------------------------------------------------
function seededSample<T>(items: readonly T[], n: number, seed: number): T[] {
  if (n >= items.length) return [...items];
  let state = seed >>> 0 || 1;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const pool = [...items];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rand() * pool.length);
    out.push(pool[idx]!);
    pool.splice(idx, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Independent per-function walker.
// ---------------------------------------------------------------------------
type Val =
  | { readonly t: "globalObj" }
  | { readonly t: "globalName"; readonly name: string }
  | { readonly t: "globalDeep" }
  | { readonly t: "fn"; readonly index: number }
  | { readonly t: "argSlot"; readonly slot: number }
  | { readonly t: "depIdx"; readonly n: number }
  | { readonly t: "literalInt"; readonly n: number }
  | { readonly t: "unknown" };

interface FactoryShape {
  readonly requireArg: number;
  readonly depMapArg: number;
  readonly depIds: readonly number[];
}

interface Recount {
  readonly calls: CallRow[];
  readonly globals: Map<string, number>; // "g access" -> n
  readonly strings: Map<string, number>; // "sid role" -> n
}

const OP = (i: Instruction, k: number): number => i.operands[k]!.value;

function builtinLabel(def: BuiltinDef | undefined, num: number): string {
  if (def === undefined) return `#${num}`;
  if (def.object !== undefined && def.method !== undefined) return def.object === "globalThis" ? def.method : `${def.object}.${def.method}`;
  return def.name;
}

/** Whole-instruction-stream, own-coded, per-block-reset def-use recount of
 *  one function's calls/global-accesses/string-uses. Deliberately a fresh
 *  implementation (own opcode name sets, own value-lattice shape) — see file
 *  header for why this must not import `src/artifact/semantic-walk.ts`. */
function recountFunction(module: HbcModule, analysis: ModuleAnalysis, fnIndex: number, factory: FactoryShape | undefined): Recount {
  const decoded = analysis.decoded(fnIndex);
  const cfg = analysis.cfg(fnIndex);
  const builtinTableId = module.layout.builtinTable;
  const builtins = builtinTableId === undefined ? undefined : getBuiltinTable(builtinTableId);
  const strings = module.strings;

  const calls: CallRow[] = [];
  const globals = new Map<string, number>();
  const stringsUsed = new Map<string, number>();
  let siteOrdinal = 0;
  const addGlobal = (g: string, access: string): void => {
    const k = `${g} ${access}`;
    globals.set(k, (globals.get(k) ?? 0) + 1);
  };
  const addString = (sid: number, role: string): void => {
    const k = `${sid} ${role}`;
    stringsUsed.set(k, (stringsUsed.get(k) ?? 0) + 1);
  };

  // Function-wide param-argument tracking (own version of the same
  // observation semantic-walk.ts documents: a param load is trustworthy
  // function-wide only if it is the sole writer of its destination register).
  const solelyParam = new Map<number, number>();
  {
    const writers = new Map<number, Set<number>>();
    const otherWriter = new Set<number>();
    for (const insn of decoded.instructions) {
      const dst = insn.operands[0];
      if (dst === undefined || (dst.type !== "Reg8" && dst.type !== "Reg32")) continue;
      if (insn.name === "LoadParam" || insn.name === "LoadParamLong") {
        const s = writers.get(dst.value) ?? new Set<number>();
        s.add(OP(insn, 1));
        writers.set(dst.value, s);
      } else otherWriter.add(dst.value);
    }
    for (const [reg, slots] of writers) if (slots.size === 1 && !otherWriter.has(reg)) solelyParam.set(reg, [...slots][0]!);
  }

  for (const block of [...cfg.blocks].sort((a, b) => a.start - b.start)) {
    const env = new Map<number, Val>();
    const of = (r: number): Val => env.get(r) ?? (solelyParam.has(r) ? { t: "argSlot", slot: solelyParam.get(r)! } : { t: "unknown" });

    for (let off = block.start; off < block.end; ) {
      const idx = decoded.byOffset.get(off);
      if (idx === undefined) break;
      const insn = decoded.instructions[idx]!;
      off = insn.offset + insn.length;
      const op = insn.name;
      const dst = insn.operands[0]?.value;

      if (op === "LoadParam" || op === "LoadParamLong") {
        if (dst !== undefined) env.set(dst, { t: "argSlot", slot: OP(insn, 1) });
        continue;
      }
      if (op === "GetGlobalObject") {
        if (dst !== undefined) env.set(dst, { t: "globalObj" });
        continue;
      }
      if (op === "CreateClosure" || op === "CreateClosureLongIndex" || op === "CreateGeneratorClosure" || op === "CreateGeneratorClosureLongIndex" || op === "CreateAsyncClosure" || op === "CreateAsyncClosureLongIndex") {
        if (dst !== undefined) env.set(dst, { t: "fn", index: OP(insn, 2) });
        continue;
      }
      if (/^(Try)?GetById(Short|Long)?$/.test(op)) {
        const base = of(OP(insn, 1));
        const sid = OP(insn, 3);
        const text = strings.get(sid);
        addString(sid, base.t === "globalObj" ? "global-name" : "property-get");
        if (base.t === "globalObj") {
          addGlobal(text, "read");
          if (dst !== undefined) env.set(dst, { t: "globalName", name: text });
        } else if (base.t === "globalName") {
          if (dst !== undefined) env.set(dst, { t: "globalDeep" });
        } else if (dst !== undefined) env.set(dst, { t: "unknown" });
        continue;
      }
      if (/^(Try)?PutById(Loose|Strict)?(Long)?$/.test(op)) {
        const base = of(OP(insn, 0));
        const sid = OP(insn, 3);
        const text = strings.get(sid);
        addString(sid, base.t === "globalObj" ? "global-name" : "property-put");
        if (base.t === "globalObj") addGlobal(text, "write");
        continue;
      }
      if (/^(PutNewOwnById|DefineOwnById)(Long|Short)?$/.test(op)) {
        addString(OP(insn, insn.operands.length - 1), "property-key");
        continue;
      }
      if (op === "DeclareGlobalVar") {
        addGlobal(strings.get(OP(insn, 0)), "write");
        continue;
      }
      if (op === "GetByVal" || op === "GetByIndex") {
        const base = of(OP(insn, 1));
        const idxVal = op === "GetByIndex" ? OP(insn, 2) : of(OP(insn, 2)).t === "literalInt" ? (of(OP(insn, 2)) as Extract<Val, { t: "literalInt" }>).n : undefined;
        if (dst !== undefined && base.t === "argSlot" && factory !== undefined && base.slot === factory.depMapArg && idxVal !== undefined) env.set(dst, { t: "depIdx", n: idxVal });
        else if (dst !== undefined) env.set(dst, { t: "unknown" });
        continue;
      }
      if (op === "LoadConstZero" || op === "LoadConstUInt8" || op === "LoadConstInt") {
        if (dst !== undefined) env.set(dst, { t: "literalInt", n: op === "LoadConstZero" ? 0 : OP(insn, 1) });
        continue;
      }
      if (op === "LoadConstString" || op === "LoadConstStringLongIndex") {
        addString(OP(insn, 1), "literal");
        if (dst !== undefined) env.set(dst, { t: "unknown" });
        continue;
      }
      if (op === "CreateRegExp") {
        addString(OP(insn, 1), "regexp");
        addString(OP(insn, 2), "regexp");
        continue;
      }
      if (op === "CallBuiltin" || op === "CallBuiltinLong") {
        const num = OP(insn, 1);
        calls.push({ caller: fnIndex, site: siteOrdinal++, callee: `b:${builtinLabel(builtins?.builtins[num], num)}`, kind: "builtin" });
        if (dst !== undefined) env.set(dst, { t: "unknown" });
        continue;
      }
      if (op === "CallDirect" || op === "CallDirectLongIndex") {
        calls.push({ caller: fnIndex, site: siteOrdinal++, callee: OP(insn, 2), kind: "closure", via: "direct" });
        continue;
      }
      if (
        op === "Call1" ||
        op === "Call2" ||
        op === "Call3" ||
        op === "Call4" ||
        op === "Call" ||
        op === "CallLong" ||
        op === "Construct" ||
        op === "ConstructLong" ||
        op === "CallWithNewTarget" ||
        op === "CallWithNewTargetLong"
      ) {
        const isNew = op === "Construct" || op === "ConstructLong" || op === "CallWithNewTarget" || op === "CallWithNewTargetLong";
        const callee = of(OP(insn, 1));
        if (!isNew && factory !== undefined && callee.t === "argSlot" && callee.slot === factory.requireArg) {
          const argReg = insn.operands[3]?.value;
          const argVal = argReg === undefined ? undefined : of(argReg);
          if (insn.operands.length === 4 && argVal?.t === "depIdx" && argVal.n >= 0 && argVal.n < factory.depIds.length) {
            calls.push({ caller: fnIndex, site: siteOrdinal++, callee: `m:${factory.depIds[argVal.n]}`, kind: "require" });
            if (dst !== undefined) env.set(dst, { t: "unknown" });
            continue;
          }
        }
        // Resolve the callee value the same way for every call SHAPE
        // (`Call*`/`Construct*`/`CallWithNewTarget*` alike — §2.2 the
        // callee resolution is shape-independent; only `kind` differs);
        // `isNew` only ever overrides `kind`, never the resolved callee/why.
        const site = siteOrdinal++;
        let row: CallRow;
        if (callee.t === "fn") row = { caller: fnIndex, site, callee: callee.index, kind: isNew ? "construct" : "closure" };
        else if (callee.t === "globalName") row = { caller: fnIndex, site, callee: `g:${callee.name}`, kind: isNew ? "construct" : "global" };
        else if (callee.t === "globalDeep") row = { caller: fnIndex, site, callee: "?", kind: isNew ? "construct" : "unknown", why: "deep-global-member" };
        else row = { caller: fnIndex, site, callee: "?", kind: isNew ? "construct" : "unknown", why: "computed-callee" };
        calls.push(row);
        if (dst !== undefined) env.set(dst, { t: "unknown" });
        continue;
      }
      if (op === "DirectEval") {
        calls.push({ caller: fnIndex, site: siteOrdinal++, callee: "?", kind: "unknown", why: "reflect" });
        if (dst !== undefined) env.set(dst, { t: "unknown" });
        continue;
      }
      const op0 = insn.operands[0];
      if (dst !== undefined && op0 !== undefined && (op0.type === "Reg8" || op0.type === "Reg32") && !/^(Put|Store|Define)/.test(op)) env.set(dst, { t: "unknown" });
    }
  }
  calls.sort((a, b) => a.site - b.site);
  return { calls, globals, strings: stringsUsed };
}

function factoryShapeOf(module: HbcModule, splitModules: readonly { readonly factoryFn: number | null; readonly deps: readonly number[] }[]): Map<number, FactoryShape> {
  const paramCountByFn = new Map<number, number>();
  for (const fn of module.functions) paramCountByFn.set(fn.header.index, fn.header.paramCount);
  const out = new Map<number, FactoryShape>();
  for (const m of splitModules) {
    if (m.factoryFn === null) continue;
    const pc = paramCountByFn.get(m.factoryFn);
    if (pc === undefined) continue;
    out.set(m.factoryFn, { requireArg: 2, depMapArg: Math.max(0, pc - 1), depIds: m.deps });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison: index rows vs recount, multiset per §9 ruling 1.
// ---------------------------------------------------------------------------
function callKey(c: CallRow): string {
  return `${c.callee === "?" ? "?" : c.callee}|${c.kind}${c.why !== undefined ? `|${c.why}` : ""}`;
}

interface Mismatch {
  readonly fn: number;
  readonly kind: "calls" | "globals" | "strings";
  readonly detail: string;
}

function multisetDiff(a: readonly string[], b: readonly string[]): { readonly onlyIndex: string[]; readonly onlyRecount: string[] } {
  const ca = new Map<string, number>();
  for (const x of a) ca.set(x, (ca.get(x) ?? 0) + 1);
  const cb = new Map<string, number>();
  for (const x of b) cb.set(x, (cb.get(x) ?? 0) + 1);
  const onlyIndex: string[] = [];
  const onlyRecount: string[] = [];
  const keys = new Set([...ca.keys(), ...cb.keys()]);
  for (const k of keys) {
    const na = ca.get(k) ?? 0;
    const nb = cb.get(k) ?? 0;
    for (let i = 0; i < na - nb; i++) onlyIndex.push(k);
    for (let i = 0; i < nb - na; i++) onlyRecount.push(k);
  }
  return { onlyIndex, onlyRecount };
}

function main(): void {
  const argv = process.argv.slice(2);
  const artifactDir = argv.find((a) => !a.startsWith("--"));
  const hbcPath = argv[argv.indexOf("--hbc") + 1];
  if (artifactDir === undefined || hbcPath === undefined || argv.indexOf("--hbc") < 0) {
    process.stderr.write("usage: check-index.ts <artifactDir> --hbc <bundle.hbc> [--sample 200] [--seed 1] [--all] [--fn N]\n");
    process.exit(2);
  }
  const all = argv.includes("--all");
  const sampleN = Number(argv[argv.indexOf("--sample") + 1] ?? 200);
  const seed = Number(argv[argv.indexOf("--seed") + 1] ?? 1);
  const singleFn = argv.includes("--fn") ? Number(argv[argv.indexOf("--fn") + 1]) : undefined;

  const manifest = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8")) as Manifest;
  const bytes = readFileSync(hbcPath);
  const actualSha = sha256Hex(bytes);
  if (actualSha !== manifest.bundle.sha256) {
    process.stderr.write(`check-index: ${hbcPath} sha256 (${actualSha}) != manifest.bundle.sha256 (${manifest.bundle.sha256}) — wrong bundle for this artifact\n`);
    process.exit(2);
  }

  const module = parseHbc(bytes);
  const analysis = analyseModule(module, { strictEnv: false });
  const modulesIndex = JSON.parse(readFileSync(join(artifactDir, "index", "modules.json"), "utf8")) as { modules: readonly { readonly factoryFn: number | null; readonly deps: readonly number[] }[] };
  const factories = factoryShapeOf(module, modulesIndex.modules);

  const callRows = readJsonl<CallRow>(join(artifactDir, "index", "calls.jsonl"));
  const globalRows = readJsonl<GlobalRow>(join(artifactDir, "index", "globals.jsonl"));
  const stringUseRows = readJsonl<StringUseRow>(join(artifactDir, "index", "string-uses.jsonl"));

  const targets = singleFn !== undefined ? [singleFn] : all ? module.functions.map((f) => f.header.index) : seededSample(module.functions.map((f) => f.header.index), sampleN, seed);

  const mismatches: Mismatch[] = [];
  let whyMissing = 0;
  let whyTotal = 0;
  let callsChecked = 0;
  let globalsChecked = 0;
  let stringsChecked = 0;

  for (const fn of targets) {
    const recount = recountFunction(module, analysis, fn, factories.get(fn));

    const indexCalls = callRows.filter((c) => c.caller === fn);
    for (const c of indexCalls) {
      if (c.callee === "?") {
        whyTotal++;
        if (c.why === undefined) whyMissing++;
      }
    }
    const { onlyIndex: iCalls, onlyRecount: rCalls } = multisetDiff(indexCalls.map(callKey), recount.calls.map(callKey));
    callsChecked += indexCalls.length;
    if (iCalls.length > 0 || rCalls.length > 0) {
      // Per decision-8's own definition: only "neither is ?" mismatches are
      // unmarked-wrong. Filter both sides down to that before reporting.
      const iResolved = iCalls.filter((k) => !k.startsWith("?|"));
      const rResolved = rCalls.filter((k) => !k.startsWith("?|"));
      if (iResolved.length > 0 || rResolved.length > 0) {
        mismatches.push({ fn, kind: "calls", detail: `index-only:[${iResolved.join(", ")}] recount-only:[${rResolved.join(", ")}]` });
      }
    }

    const indexGlobals: string[] = [];
    for (const g of globalRows) if (g.fn === fn && g.access !== "call") for (let i = 0; i < g.n; i++) indexGlobals.push(`${g.g} ${g.access}`);
    const recountGlobals: string[] = [];
    for (const [k, n] of recount.globals) for (let i = 0; i < n; i++) recountGlobals.push(k);
    globalsChecked += indexGlobals.length;
    const { onlyIndex: iG, onlyRecount: rG } = multisetDiff(indexGlobals, recountGlobals);
    if (iG.length > 0 || rG.length > 0) mismatches.push({ fn, kind: "globals", detail: `index-only:[${iG.join(", ")}] recount-only:[${rG.join(", ")}]` });

    const indexStrings: string[] = [];
    for (const s of stringUseRows) if (s.fn === fn) for (let i = 0; i < s.n; i++) indexStrings.push(`${s.sid} ${s.role}`);
    const recountStrings: string[] = [];
    for (const [k, n] of recount.strings) for (let i = 0; i < n; i++) recountStrings.push(k);
    stringsChecked += indexStrings.length;
    const { onlyIndex: iS, onlyRecount: rS } = multisetDiff(indexStrings, recountStrings);
    if (iS.length > 0 || rS.length > 0) mismatches.push({ fn, kind: "strings", detail: `index-only:[${iS.join(", ")}] recount-only:[${rS.join(", ")}]` });
  }

  const whyCoverage = whyTotal === 0 ? 100 : Math.round(((whyTotal - whyMissing) / whyTotal) * 1000) / 10;

  if (mismatches.length === 0 && whyMissing === 0) {
    process.stdout.write(
      `check-index PASS: ${targets.length} function(s) checked (${singleFn !== undefined ? "single" : all ? "--all" : `--sample ${sampleN} --seed ${seed}`}), ` +
        `calls=${callsChecked} globals=${globalsChecked} strings=${stringsChecked}, ?-why coverage=${whyCoverage}%\n`,
    );
    process.exit(0);
  }
  process.stdout.write(`check-index FAIL: ${mismatches.length} row-level mismatch(es), ${whyMissing} "?" row(s) missing a why\n`);
  for (const m of mismatches) process.stdout.write(`  fn:${m.fn} ${m.kind}: ${m.detail}\n`);
  process.exit(1);
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

main();
