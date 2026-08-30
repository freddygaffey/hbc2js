// docs/specs/02-disassembler.md §7 — normalisers for the two disassembly oracles.
// Not a test file itself (excluded from the `tests/gate/**/*.test.ts` glob);
// shared by hermesc.test.ts and hermes-dec.test.ts.
import type { DecodedFunction, Instruction } from "../../../../src/disasm/decode.ts";
import type { ExceptionHandler, FunctionFlags } from "../../../../src/parse/types.ts";

// ---------------------------------------------------------------------------
// 7.A — N-hermesc. Real function-header lines have three shapes (spec 02 §6.1,
// review B1): `Function<name>(...)`, `NCFunction<name>(...)`, and — discovered
// while implementing this milestone, not in the spec's own list —
// `Constructor<name>(...)` for a `prohibitInvoke: "call"` function (verified
// against `tools/hermesc/v98/hermesc -dump-bytecode` on
// `tests/fixtures/constructs/32-class-basic/source.js`; see src/disasm/print.ts's
// `rawHeaderLine` doc comment). The regex below accepts all three so an
// unrecognised fourth shape still fails loudly (spec's own instruction: "fail
// loudly on any other prefix rather than silently dropping the line").
// ---------------------------------------------------------------------------
const HEADER_RE = /^(?<prefix>N?C?Function|Constructor)<(?<name>[^>]*)>\((?<p>\d+) params, (?<r>\d+) registers, (?:(?<s>\d+) symbols|(?<nr>\d+) numbers, (?<npr>\d+) non-pointers)\):$/;
const INSN_RE = /^\[@ (?<off>\d+)\] (?<op>\w+)(?: (?<ops>.*))?$/;
const EH_HDR_RE = /^Exception Handlers:$/;
const EH_RE = /^(?<n>\d+): start = (?<start>\d+), end = (?<end>\d+), target = (?<target>\d+)$/;
const JT_HDR_RE = /^ Jump Tables: $/;
const JT_OFFSET_RE = /^ {2}offset (?<offset>\d+)$/;
const JT_ENTRY_RE = /^ {3}(?<case>\d+) : (?<disp>-?\d+)$/;

export interface HermescHeaderInfo {
  readonly prefix: "" | "NC" | "Constructor";
  readonly params: number;
  readonly registers: number;
}

/** Normalised N-hermesc lines, plus the parsed header prefixes in order (for the
 *  free `NC`/`Constructor` <-> `FunctionFlags` cross-check). */
export function normaliseHermesc(stdout: string): { lines: string[]; headers: HermescHeaderInfo[] } {
  const lines: string[] = [];
  const headers: HermescHeaderInfo[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m = HEADER_RE.exec(line);
    if (m !== null) {
      const g = m.groups!;
      const prefix: HermescHeaderInfo["prefix"] = g.prefix === "Constructor" ? "Constructor" : g.prefix === "NCFunction" ? "NC" : "";
      headers.push({ prefix, params: Number(g.p), registers: Number(g.r) });
      lines.push(`FUNC ${g.p} ${g.r} ${g.s ?? `${g.nr},${g.npr}`}`);
      continue;
    }
    m = INSN_RE.exec(line);
    if (m !== null) {
      const g = m.groups!;
      lines.push(`${g.off} ${g.op} ${(g.ops ?? "").replace(/\s+/g, " ").trim()}`);
      continue;
    }
    if (EH_HDR_RE.test(line)) {
      lines.push("EHDR");
      continue;
    }
    m = EH_RE.exec(line);
    if (m !== null) {
      const g = m.groups!;
      lines.push(`EH ${g.n} ${g.start} ${g.end} ${g.target}`);
      continue;
    }
    if (JT_HDR_RE.test(line)) {
      lines.push("JTHDR");
      continue;
    }
    m = JT_OFFSET_RE.exec(line);
    if (m !== null) {
      lines.push(`JT ${m.groups!.offset}`);
      continue;
    }
    m = JT_ENTRY_RE.exec(line);
    if (m !== null) {
      lines.push(`JTE ${m.groups!.case} ${m.groups!.disp}`);
      continue;
    }
    // Everything else (Bytecode File Information, Global String Table, Function
    // Source Table, debug tables, blank lines, ...) is dropped, per spec 02 §7.A.
  }
  return { lines, headers };
}

/** `ours` side of the 7.A diff: our own `raw`-mode text run through the exact
 *  same normaliser (the shapes are designed to match — spec 02 §6.1). */
export function normaliseOursRaw(rawText: string): { lines: string[]; headers: HermescHeaderInfo[] } {
  return normaliseHermesc(rawText);
}

// ---------------------------------------------------------------------------
// 7.B — N-hermesdec.
// ---------------------------------------------------------------------------
// Real function-header shapes beyond spec 02 §7.B's own quoted example
// (`Function #N`): `Generator function #N` and `Async function #N` for a
// compiler-synthesized generator/async body (verified: `hbc-disassembler` on
// `tests/fixtures/constructs/23-generator-basic/v98.hbc` (index 1) and
// `tests/fixtures/constructs/27-async-await-basic/v99.hbc` (index 2) —
// neither has a companion plain "Function #N" line at all, so the original
// regex silently dropped the line, desynchronising every function after it by
// exactly one). Both kinds only ever precede a lowercase "function".
const HD_FUNC_RE =
  /^=> \[(?:(?:Generator|Async) )?[Ff]unction #(?<idx>\d+) "(?<name>.*)" of (?<size>\d+) bytes\]: (?<params>\d+) params, frame size=(?<frame>\d+), strict=(?<strict>\d), exc handler=(?<exc>\d), debug info=(?<dbg>\d)\s+@ offset 0x(?<offset>[0-9a-f]+)$/;
const HD_EH_HDR_RE = /^\s*\[Exception handlers: (?<body>.*)\]$/;
const HD_EH_ENTRY_RE = /\[start=0x(?<start>[0-9a-f]+), end=0x(?<end>[0-9a-f]+), target=0x(?<target>[0-9a-f]+)\]/g;
const HD_DEBUG_OFFSETS_RE = /^\s*\[Debug offsets: .*\]$/;
const HD_INSN_RE = /^==> (?<off>[0-9a-f]{8}): <(?<op>\w+)>(?:: (?<ops>.*?))?(?: {2}#.*)?$/;

export function normaliseHermesDec(stdout: string): string[] {
  const lines: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m = HD_FUNC_RE.exec(line);
    if (m !== null) {
      const g = m.groups!;
      lines.push(`FUNC ${g.idx} ${g.size} ${g.params} ${g.frame} ${g.strict} ${g.exc} ${g.dbg} ${parseInt(g.offset!, 16)}`);
      continue;
    }
    if (HD_DEBUG_OFFSETS_RE.test(line)) continue; // dropped: v99 misparse, spec 02 §7.B divergence 1
    m = HD_EH_HDR_RE.exec(line);
    if (m !== null) {
      let i = 0;
      for (const entry of m.groups!.body!.matchAll(HD_EH_ENTRY_RE)) {
        const eg = entry.groups!;
        lines.push(`EH ${i} ${parseInt(eg.start!, 16)} ${parseInt(eg.end!, 16)} ${parseInt(eg.target!, 16)}`);
        i++;
      }
      continue;
    }
    m = HD_INSN_RE.exec(line);
    if (m !== null) {
      const g = m.groups!;
      // The operand list is `<Type: value, Type: value>` — a single pair of
      // angle brackets around the whole list (spec 02 §7.B). Strip that outer
      // pair before splitting, or "Type"/"value" end up with a stray "<"/">"
      // welded on (e.g. "<string_id"/"17>" instead of "string_id"/"17").
      const opsInner = (g.ops ?? "").replace(/^<(.*)>$/, "$1");
      const ops = opsInner
        .split(", ")
        .filter((s) => s.length > 0)
        .map((entry) => {
          const idx = entry.indexOf(": ");
          if (idx === -1) return entry;
          const type = entry.slice(0, idx);
          const value = entry.slice(idx + 2);
          return `${value}<${type}>`;
        })
        .join(", ");
      lines.push(`${parseInt(g.off!, 16)} ${g.op} ${ops}`);
      continue;
    }
    // banners, blank lines, "Bytecode listing:" — dropped.
  }
  return lines;
}

/** `ours` side of the 7.B diff, built directly from `DecodedFunction` (not from
 *  `raw`-mode text, which never renames id-typed operands): hermes-dec renames
 *  only string/bigint/function id operands to `string_id`/`bigint_id`/
 *  `function_id`; everything else (including our `regexp`/`shape`/`literalOffset`/
 *  `builtin`/`cacheIndex` roles, which don't come from an `OPERAND_*_ID` macro)
 *  keeps its literal `OperandType` name, exactly like hermesc does. Verified
 *  against `hbc-disassembler` on `CreateRegExp`'s 4th operand (plain `UInt32`,
 *  not `regexp_id`) and `GetBuiltinClosure` (plain `UInt8`, not `builtin_id`).
 */
export function ourFuncLine(fn: DecodedFunction, flags: FunctionFlags): string {
  const strict = flags.strictMode ? 1 : 0;
  const exc = flags.hasExceptionHandler ? 1 : 0;
  const dbg = flags.hasDebugInfo ? 1 : 0;
  return `FUNC ${fn.index} ${fn.header.bytecodeSizeInBytes} ${fn.header.paramCount} ${fn.header.frameSize} ${strict} ${exc} ${dbg} ${fn.header.offset}`;
}

export function ourHandlerLines(handlers: readonly ExceptionHandler[]): string[] {
  return handlers.map((h, i) => `EH ${i} ${h.start} ${h.end} ${h.target}`);
}

function operandTypeToken(op: Instruction["operands"][number]): string {
  switch (op.role) {
    case "string":
      return "string_id";
    case "bigint":
      return "bigint_id";
    case "function":
      return "function_id";
    default:
      return op.type;
  }
}

/** hermes-dec (a Python tool) renders `Double` values with Python's `repr(float)`
 *  convention — always a decimal point, e.g. `9007199254740992.0` where JS's
 *  default `String(value)` gives `9007199254740992` with none. Verified against
 *  `hbc-disassembler` on `constructs/46-bigint-arithmetic`'s
 *  `LoadConstDouble 5<Reg8>, 9007199254740992.0<Double>`. Approximated (not a
 *  full Python-repr reimplementation): append `.0` exactly when JS's own
 *  string form is a bare integer with no `.`/`e`, which is what distinguishes
 *  the two representations for every value this corpus exercises. */
function formatHermesDecDouble(value: number): string {
  const s = String(value);
  return /[.e]/i.test(s) ? s : `${s}.0`;
}

function operandValueToken(op: Instruction["operands"][number]): string {
  return op.type === "Double" ? formatHermesDecDouble(op.value) : String(op.value);
}

export function ourInstructionLine(insn: Instruction): string {
  // hermes-dec always renders the operand list as `<...>`, even when empty
  // (`<StartGenerator>: <>`), which normalises to a lone trailing space after
  // the mnemonic rather than nothing — verified directly against its output.
  const ops = insn.operands.map((op) => `${operandValueToken(op)}<${operandTypeToken(op)}>`).join(", ");
  return `${insn.offset} ${insn.name} ${ops}`;
}
