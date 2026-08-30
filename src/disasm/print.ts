// docs/specs/02-disassembler.md §6 — canonical textual disassembly, two modes.
import { hex } from "../util/fmt.ts";
import { getBuiltinTable } from "../tables/registry.ts";
import type { FunctionFlags, HbcModule } from "../parse/types.ts";
import type { DecodedFunction, Instruction, Operand } from "./decode.ts";
import { decodeFunction } from "./decode.ts";
import { assignHandlerLabels } from "./labels.ts";

export type DisasmMode = "raw" | "canonical";

export interface PrintOptions {
  /** default "canonical". */
  readonly mode?: DisasmMode;
  /** default true. */
  readonly showCacheIndices?: boolean;
  /** default 32 chars. */
  readonly maxStringPreview?: number;
  /** subset of functions. */
  readonly indices?: readonly number[];
  /**
   * Basename shown in the `canonical`-mode module preamble (`; hbc2js
   * disassembly of <name>`). Deviation from spec 02 §2's literal `PrintOptions`
   * shape: `HbcModule` carries no filename (it is built from bytes alone, spec
   * 01), so there is nothing for `printModule` to derive a name from on its
   * own. The CLI passes the real input path's basename; library callers without
   * one may omit it. See this milestone's report.
   */
  readonly moduleName?: string;
}

interface ResolvedOptions {
  readonly mode: DisasmMode;
  readonly showCacheIndices: boolean;
  readonly maxStringPreview: number;
  readonly moduleName: string;
}

function resolveOptions(opts: PrintOptions | undefined): ResolvedOptions {
  return {
    mode: opts?.mode ?? "canonical",
    showCacheIndices: opts?.showCacheIndices ?? true,
    maxStringPreview: opts?.maxStringPreview ?? 32,
    moduleName: opts?.moduleName ?? "module",
  };
}

// ---------------------------------------------------------------------------
// Streaming writer (docs/specs/02-disassembler.md §8 rule 1): chunk-buffer,
// flush every ~64KB, never `+=` into one giant string or `join("")` the whole
// module.
// ---------------------------------------------------------------------------
const FLUSH_THRESHOLD = 65536;

interface ChunkWriter {
  push(s: string): void;
  flush(): void;
}

function makeChunkWriter(out: NodeJS.WritableStream): ChunkWriter {
  let buf = "";
  return {
    push(s: string): void {
      buf += s;
      if (buf.length >= FLUSH_THRESHOLD) {
        out.write(buf);
        buf = "";
      }
    },
    flush(): void {
      if (buf.length > 0) {
        out.write(buf);
        buf = "";
      }
    },
  };
}

// ---------------------------------------------------------------------------
// String escaping (docs/specs/02-disassembler.md §6.2). Pure ASCII output,
// byte-stable across platforms. Built as an array of "atoms" (one escaped unit
// per input UTF-16 code unit) so truncation can never split an escape sequence.
// ---------------------------------------------------------------------------
function escapeAtoms(s: string): string[] {
  const atoms: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) atoms.push("\\\\");
    else if (c === 0x22) atoms.push('\\"');
    else if (c === 0x0a) atoms.push("\\n");
    else if (c === 0x0d) atoms.push("\\r");
    else if (c === 0x09) atoms.push("\\t");
    else if (c < 0x20 || c === 0x7f) atoms.push(`\\x${c.toString(16).padStart(2, "0")}`);
    else if (c >= 0x80) atoms.push(`\\u${c.toString(16).padStart(4, "0")}`);
    else atoms.push(s[i]!);
  }
  return atoms;
}

/** Escape the whole string first, then take the first `maxChars` characters of
 *  the *escaped* output, never splitting an escape sequence, appending U+2026
 *  iff anything was dropped (spec 02 §6.2, review N3). */
export function truncatePreview(s: string, maxChars: number): string {
  const atoms = escapeAtoms(s);
  let total = 0;
  let count = 0;
  for (; count < atoms.length; count++) {
    const len = atoms[count]!.length;
    if (total + len > maxChars) break;
    total += len;
  }
  const truncated = count < atoms.length;
  return atoms.slice(0, count).join("") + (truncated ? "…" : "");
}

// ---------------------------------------------------------------------------
// raw mode (docs/specs/02-disassembler.md §6.1) — line-for-line target for
// `hermesc -dump-bytecode -pretty-disassemble=false`.
// ---------------------------------------------------------------------------

/**
 * `hermesc`'s own `%e`-style float formatting (glibc/macOS libc `printf("%e",
 * x)`: 6 fraction digits, a signed exponent padded to at least 2 digits).
 * Verified against real `hermesc -dump-bytecode` output (`LoadConstDouble …,
 * 7.300000e+00<Double>`), which contradicts spec 02 §6.1's prose ("Double via
 * `String(value)`") — that rule is followed for `canonical` mode below, but
 * `raw` mode must match the compiler's literal bytes to be useful as an oracle
 * diff target, so this milestone treats the verified bytes as authoritative
 * over the spec text (project norm — see docs/DECISIONS.md D8). Reported in
 * this milestone's summary.
 */
function formatRawDouble(v: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  const s = v.toExponential(6);
  const m = /^(-?\d(?:\.\d+)?)e([+-])(\d+)$/.exec(s);
  if (m === null) return s;
  const [, mantissa, sign, exp] = m;
  return `${mantissa}e${sign}${exp!.padStart(2, "0")}`;
}

function rawOperandText(op: Operand): string {
  const value = op.type === "Double" ? formatRawDouble(op.value) : String(op.value);
  return `${value}<${op.type}>`;
}

function rawInstructionLine(insn: Instruction): string {
  const ops = insn.operands.length > 0 ? ` ${insn.operands.map(rawOperandText).join(", ")}` : "";
  return `[@ ${insn.offset}] ${insn.name}${ops}`;
}

/**
 * Real hermesc output has a *third* header shape beyond spec 02 §6.1's
 * "`Function` or `NCFunction`, nothing else observed": a class constructor
 * prints as `Constructor<Name>(...)`, not `Function<Name>`/`NCFunction<Name>`.
 * Verified against `tools/hermesc/v98/hermesc -dump-bytecode` on
 * `tests/fixtures/constructs/32-class-basic/source.js` (v98): `Point`'s
 * constructor dumps as `Constructor<Point>(3 params, 2 registers, 0 numbers, 0
 * non-pointers):`, while every other function in the same file (including
 * `global`) uses `Function<...>`/`NCFunction<...>`. This lines up with
 * `ProhibitInvoke`'s existing `"call"` value (construct-only — the plain-call
 * path is what's prohibited) versus `"construct"` (not constructable, `NC`):
 * spec 02 §6.1 speculated a "C-prefixed" form for exactly this case and
 * guessed wrong about the spelling — it is not a prefix on `Function`, it
 * replaces the word entirely. See this milestone's report for a separate,
 * already-flagged parse-layer bug where this fixture's own decoded
 * `prohibitInvoke` values don't match what hermesc's dump implies for `global`
 * — the *rendering rule* here is verified independent of that bug (it holds on
 * every other fixture's correctly-decoded flags too).
 */
function rawHeaderLine(mod: HbcModule, fn: DecodedFunction): string {
  const h = fn.header;
  const layoutClass = mod.layout.layoutClass;
  const tail = layoutClass === "A" || layoutClass === "B" || layoutClass === "C" ? `${h.environmentSize ?? 0} symbols` : `${h.numberRegCount ?? 0} numbers, ${h.nonPtrRegCount ?? 0} non-pointers`;
  if (h.flags.prohibitInvoke === "call") {
    return `Constructor<${fn.name}>(${h.paramCount} params, ${h.frameSize} registers, ${tail}):`;
  }
  const nc = h.flags.prohibitInvoke === "construct" ? "NC" : "";
  return `${nc}Function<${fn.name}>(${h.paramCount} params, ${h.frameSize} registers, ${tail}):`;
}

function rawHandlersBlock(fn: DecodedFunction): string[] {
  if (fn.handlers.length === 0) return [];
  const lines = ["Exception Handlers:"];
  fn.handlers.forEach((h, i) => lines.push(`${i}: start = ${h.start}, end = ${h.end}, target = ${h.target}`));
  return lines;
}

/** The raw, pre-resolution `ip`-relative displacement — inverse of the
 *  resolution `decode.ts`/`switchtable.ts` perform (`target = insnOffset + raw`)
 *  — because `raw` mode must print what hermesc prints: the on-disk displacement,
 *  not our resolved function-relative target (spec 02 §6.1). */
function rawJumpTablesBlock(fn: DecodedFunction): string[] {
  const switchInsns = fn.instructions.filter((i) => i.switchTable !== undefined);
  if (switchInsns.length === 0) return [];
  const lines = [" Jump Tables: "];
  for (const insn of switchInsns) {
    const st = insn.switchTable!;
    // SwitchImm/UIntSwitchImm: (Reg8, UInt32 tableOffset, ...) -> operand[1].
    // StringSwitchImm: (Reg8, UInt32 globalIndex, UInt32 tableOffset, ...) -> operand[2].
    const rawTableOffsetOperand = st.kind === "string" ? insn.operands[2]!.value : insn.operands[1]!.value;
    lines.push(`  offset ${rawTableOffsetOperand}`);
    st.cases.forEach((c, i) => lines.push(`   ${i} : ${c.target - insn.offset}`));
  }
  return lines;
}

function printFunctionRaw(mod: HbcModule, fn: DecodedFunction, w: ChunkWriter): void {
  w.push(rawHeaderLine(mod, fn) + "\n");
  for (const insn of fn.instructions) w.push(rawInstructionLine(insn) + "\n");
  // Real hermesc output always has exactly one blank line after a function's
  // instructions, whether or not an Exception Handlers / Jump Tables block
  // follows — verified against tests/fixtures/hermes-dec-sample/source.js's
  // "global" function (no handlers, no switch) at v94.
  w.push("\n");
  const handlerLines = rawHandlersBlock(fn);
  if (handlerLines.length > 0) {
    for (const l of handlerLines) w.push(l + "\n");
    w.push("\n");
  }
  const jumpLines = rawJumpTablesBlock(fn);
  if (jumpLines.length > 0) {
    for (const l of jumpLines) w.push(l + "\n");
    w.push("\n");
  }
}

// ---------------------------------------------------------------------------
// canonical mode (docs/specs/02-disassembler.md §6.2) — ours; used for humans,
// CFG debugging, and golden snapshots.
// ---------------------------------------------------------------------------

const MNEMONIC_WIDTH = 20;

function flagsList(f: FunctionFlags): string {
  const parts: string[] = [];
  if (f.strictMode) parts.push("strict");
  if (f.hasExceptionHandler) parts.push("exc");
  if (f.hasDebugInfo) parts.push("dbg");
  if (f.overflowed) parts.push("overflowed");
  if (f.prohibitInvoke === "construct") parts.push("nc");
  else if (f.prohibitInvoke === "call") parts.push("ctor");
  return parts.length > 0 ? parts.join(",") : "none";
}

function canonicalHeaderLine(fn: DecodedFunction): string {
  const h = fn.header;
  const env = h.environmentSize ?? 0;
  return `function #${fn.index} "${fn.name}"  params=${h.paramCount} frame=${h.frameSize} env=${env} flags=${flagsList(h.flags)}  @0x${hex(h.offset, 8)} size=${h.bytecodeSizeInBytes}`;
}

function canonicalTryLines(fn: DecodedFunction, handlerLabels: ReadonlyMap<number, string>, labels: ReadonlyMap<number, string>): string[] {
  return fn.handlers.map((h, i) => {
    const start = handlerLabels.get(h.start) ?? `@${h.start}`;
    const end = handlerLabels.get(h.end) ?? `@${h.end}`;
    const target = labels.get(h.target) ?? `@${h.target}`;
    return `  .try ${start}..${end} -> ${target} ; handler ${i}`;
  });
}

function builtinName(mod: HbcModule, n: number): string {
  const id = mod.layout.builtinTable;
  if (id === undefined) return "?";
  const table = getBuiltinTable(id);
  return table.builtins.find((b) => b.n === n)?.name ?? "?";
}

function renderOperandCanonical(mod: HbcModule, op: Operand, insn: Instruction, labels: ReadonlyMap<number, string>, maxStringPreview: number): string | undefined {
  switch (op.role) {
    case "reg":
      return `r${op.value}`;
    case "addr": {
      const target = insn.targets[0];
      const label = target !== undefined ? labels.get(target) : undefined;
      return label ?? `@${op.value}`;
    }
    case "string":
      return `s${op.value} "${truncatePreview(mod.strings.get(op.value), maxStringPreview)}"`;
    case "function":
      return `f${op.value} "${mod.functions[op.value]?.name ?? "?"}"`;
    case "bigint": {
      const entry = mod.bigInts[op.value];
      return `bi${op.value} ${entry !== undefined ? entry.value().toString() : "?"}n`;
    }
    case "regexp":
      return `re${op.value}`;
    case "builtin":
      return `b${op.value} "${builtinName(mod, op.value)}"`;
    case "cacheIndex":
      return `#c${op.value}`;
    case "shape": {
      const shape = mod.shapes[op.value];
      return `sh${op.value}(numProps=${shape !== undefined ? shape.numProps : "?"})`;
    }
    case "literalOffset":
      return `lit@0x${hex(op.value, 4)}`;
    case "double":
      return String(op.value);
    case "imm":
    case "envSlot":
      return String(op.value);
  }
}

function canonicalSwitchLines(mod: HbcModule, insn: Instruction, labels: ReadonlyMap<number, string>): string[] {
  const st = insn.switchTable!;
  const defaultLabel = labels.get(st.defaultTarget) ?? `@${st.defaultTarget}`;
  const head =
    st.kind === "uint"
      ? `  .switch ${insn.name} @0x${hex(insn.offset, 4)}  min=${st.min} max=${st.max} default=${defaultLabel}`
      : `  .switch ${insn.name} @0x${hex(insn.offset, 4)}  count=${st.cases.length} default=${defaultLabel}`;
  const caseLabel = (c: (typeof st.cases)[number]): string => {
    const label = labels.get(c.target) ?? `@${c.target}`;
    const valueText = st.kind === "string" ? `s${c.value} "${truncatePreview(mod.strings.get(c.value), 16)}"` : String(c.value);
    return `${valueText} -> ${label}`;
  };
  const casesLine = `        ${st.cases.map(caseLabel).join("   ")}`;
  return [head, casesLine];
}

function canonicalInstructionLines(mod: HbcModule, fn: DecodedFunction, opts: ResolvedOptions): string[] {
  const lines: string[] = [];
  for (const insn of fn.instructions) {
    const label = fn.labels.get(insn.offset);
    if (label !== undefined) lines.push(`${label}:`);
    if (insn.kind === "switch") {
      lines.push(...canonicalSwitchLines(mod, insn, fn.labels));
      continue;
    }
    const visibleOperands = opts.showCacheIndices ? insn.operands : insn.operands.filter((o) => o.role !== "cacheIndex");
    const rendered = visibleOperands.map((op) => renderOperandCanonical(mod, op, insn, fn.labels, opts.maxStringPreview)).filter((s): s is string => s !== undefined);
    const offsetHex = insn.offset.toString(16).padStart(4, "0");
    const mnemonicField = rendered.length > 0 ? insn.name.padEnd(MNEMONIC_WIDTH) + " " + rendered.join(", ") : insn.name;
    lines.push(`  ${offsetHex}  ${mnemonicField}`);
  }
  return lines;
}

function printFunctionCanonical(mod: HbcModule, fn: DecodedFunction, opts: ResolvedOptions, w: ChunkWriter): void {
  w.push(canonicalHeaderLine(fn) + "\n");
  const handlerLabels = assignHandlerLabels(fn.handlers);
  for (const line of canonicalTryLines(fn, handlerLabels, fn.labels)) w.push(line + "\n");
  for (const line of canonicalInstructionLines(mod, fn, opts)) w.push(line + "\n");
}

// ---------------------------------------------------------------------------
// Public API (docs/specs/02-disassembler.md §2).
// ---------------------------------------------------------------------------

export function printFunction(mod: HbcModule, fn: DecodedFunction, out: NodeJS.WritableStream, opts?: PrintOptions): void {
  const resolved = resolveOptions(opts);
  const w = makeChunkWriter(out);
  if (resolved.mode === "raw") printFunctionRaw(mod, fn, w);
  else printFunctionCanonical(mod, fn, resolved, w);
  w.flush();
}

/** Never builds the whole disassembly as one string (spec 02 §8): decodes and
 *  prints one function at a time. */
export function printModule(mod: HbcModule, out: NodeJS.WritableStream, opts?: PrintOptions): void {
  const resolved = resolveOptions(opts);
  const w = makeChunkWriter(out);
  const indices = opts?.indices ?? Array.from({ length: mod.functions.length }, (_, i) => i);
  if (resolved.mode === "canonical") {
    w.push(`; hbc2js disassembly of ${resolved.moduleName}\n`);
    w.push(`; version=${mod.header.version} layout=${mod.layout.layoutClass} opcodeTable=${mod.layout.opcodeTable ?? "none"} functions=${mod.functions.length} strings=${mod.strings.count} globalCodeIndex=${mod.header.globalCodeIndex}\n`);
  }
  for (const i of indices) {
    const fn = decodeFunction(mod, i);
    if (resolved.mode === "raw") printFunctionRaw(mod, fn, w);
    else {
      if (i !== indices[0]) w.push("\n");
      printFunctionCanonical(mod, fn, resolved, w);
    }
  }
  w.flush();
}
