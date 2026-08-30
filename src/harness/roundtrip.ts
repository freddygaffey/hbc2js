// docs/specs/06-harness.md §6 — round-trip oracle and the per-function
// ratchet. Port of tools/equiv/src/normalise-disasm.mjs's algorithm, adapted
// to operate structurally on `src/disasm`'s own decode output (spec's "import
// it, don't reimplement") instead of regex-parsing printed text, and extended
// with the per-function ratchet report §6 asks for.
//
// Decompile -> `hermesc -emit-binary` at the fixture's version -> disassemble
// both -> normalised diff. Both sides go through *our own* parser/decoder
// (spec 02), so there is no need to regex-parse `hermesc -dump-bytecode`
// output here at all (that comparison already exists, and is spec 02's own
// acceptance criterion, at tests/gate/oracle/disasm/hermesc.test.ts).
//
// What has to be normalised, and why (docs/EQUIVALENCE.md §4.2):
//   Register numbers   — regalloc output. Renamed by order of first
//                         appearance within each function. Sound as a
//                         *canonical form only if* the instruction sequence
//                         is otherwise identical; a different sequence can
//                         rename to the same thing, so this is a strong
//                         equality test but not a proof of equivalence.
//   Labels             — already canonical (src/disasm/labels.ts numbers
//                         jump targets by ascending offset, which tracks
//                         control-flow structure, not byte position) — no
//                         further renaming needed.
//   Property-cache /
//   literal-buffer
//   offsets            — allocation-order artifacts. Masked.
//   Function names     — decompiled output uses generated names. Masked
//                         (kept verbatim only for the module's own `global`).
//   Header offset/size/
//   frame/env counts   — allocator/emission output. Dropped. Parameter count
//                         is kept (semantic).
import { parseHbc } from "../index.ts";
import { decodeFunction } from "../disasm/decode.ts";
import type { DecodedFunction, Instruction, Operand } from "../disasm/decode.ts";
import type { HbcModule } from "../parse/types.ts";
import { getBuiltinTable } from "../tables/registry.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fs from "node:fs";
import { repoRoot } from "../util/paths.ts";

// ---------------------------------------------------------------------------
// hermesc discovery + recompilation
// ---------------------------------------------------------------------------

export interface HermescBinary {
  readonly version: number;
  readonly path: string;
}

/** Mirrors the discovery order of tests/support/hermesc.ts (§7's fixture
 *  compiler), reimplemented here because production code (`src/**`) must not
 *  import from `tests/**`. */
export function findHermesc(version: number): HermescBinary | null {
  const envVar = process.env[`HERMESC_V${version}`];
  if (envVar !== undefined && fs.existsSync(envVar)) return { version, path: envVar };
  const guess = join(repoRoot(), "tools", "hermesc", `v${version}`, "hermesc");
  if (fs.existsSync(guess)) return { version, path: guess };
  return null;
}

export type CompileResult = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly error: string };

/**
 * Compile `source` with `hermesc -emit-binary`, under `embeddedFilename` (the
 * name embedded in the bytecode even without `-g` — spec 06 §6's second
 * prerequisite), into a scratch directory that is cleaned up before return.
 */
export function compileWithHermesc(hermesc: HermescBinary, source: string, embeddedFilename: string): CompileResult {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-roundtrip-"));
  try {
    const srcPath = join(dir, embeddedFilename);
    writeFileSync(srcPath, source);
    const outPath = join(dir, "out.hbc");
    try {
      execFileSync(hermesc.path, ["-emit-binary", `-out=${outPath}`, embeddedFilename], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { stderr?: Buffer | string };
      const stderr = err.stderr !== undefined ? err.stderr.toString() : String(e);
      return { ok: false, error: stderr };
    }
    return { ok: true, bytes: new Uint8Array(readFileSync(outPath)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// structural normalisation
// ---------------------------------------------------------------------------

function builtinName(mod: HbcModule, n: number): string {
  const id = mod.layout.builtinTable;
  if (id === undefined) return "?";
  const table = getBuiltinTable(id);
  return table.builtins.find((b) => b.n === n)?.name ?? "?";
}

function maskedFunctionName(name: string): string {
  return name === "global" ? "global" : "~";
}

function operandToken(mod: HbcModule, op: Operand, insn: Instruction, fn: DecodedFunction, regName: (n: number) => string): string {
  switch (op.role) {
    case "reg":
      return regName(op.value);
    case "addr": {
      const target = insn.targets[0];
      const label = target !== undefined ? fn.labels.get(target) : undefined;
      return label ?? "@?";
    }
    case "string":
      return `s#"${mod.strings.get(op.value)}"`;
    case "function":
      return `f#"${maskedFunctionName(mod.functions[op.value]?.name ?? "?")}"`;
    case "bigint": {
      const entry = mod.bigInts[op.value];
      return `bi#${entry !== undefined ? entry.value().toString() : "?"}n`;
    }
    case "regexp":
      return "re#";
    case "builtin":
      return `b#"${builtinName(mod, op.value)}"`;
    case "cacheIndex":
      return "#";
    case "shape": {
      const shape = mod.shapes[op.value];
      return `sh#(numProps=${shape !== undefined ? shape.numProps : "?"})`;
    }
    case "literalOffset":
      return "lit#";
    case "double":
    case "imm":
    case "envSlot":
      return String(op.value);
  }
}

function normaliseSwitch(mod: HbcModule, insn: Instruction, fn: DecodedFunction): string {
  const st = insn.switchTable;
  if (st === undefined) return "";
  const defaultLabel = fn.labels.get(st.defaultTarget) ?? "@?";
  const cases = st.cases
    .map((c) => {
      const label = fn.labels.get(c.target) ?? "@?";
      const value = st.kind === "string" ? `s#"${mod.strings.get(c.value)}"` : String(c.value);
      return `${value}->${label}`;
    })
    .join(" ");
  return `.switch ${insn.name} default=${defaultLabel} ${cases}`;
}

/** Normalised text for one function: a canonical form that is identical for
 *  two functions compiled from source that differs only in incidental ways
 *  (register allocator numbering, cache-slot allocation, generated names) —
 *  see the module doc comment for exactly what is dropped and why. */
export function normaliseFunction(mod: HbcModule, fn: DecodedFunction): string {
  const regs = new Map<number, string>();
  const regName = (n: number): string => {
    let r = regs.get(n);
    if (r === undefined) {
      r = `%${regs.size}`;
      regs.set(n, r);
    }
    return r;
  };

  const lines: string[] = [`fn(${fn.header.paramCount}) ${maskedFunctionName(fn.name)}`];

  for (const insn of fn.instructions) {
    const label = fn.labels.get(insn.offset);
    const prefix = label !== undefined ? `${label}: ` : "";
    if (insn.kind === "switch") {
      lines.push(prefix + normaliseSwitch(mod, insn, fn));
      continue;
    }
    const ops = insn.operands
      .filter((o) => o.role !== "cacheIndex") // allocation-order artifact; dropped entirely, not just masked
      .map((op) => operandToken(mod, op, insn, fn, regName));
    lines.push(`${prefix}${insn.name} ${ops.join(", ")}`.trimEnd());
  }

  for (const h of fn.handlers) {
    const start = fn.labels.get(h.start) ?? "@?";
    const end = fn.labels.get(h.end) ?? "@?";
    const target = fn.labels.get(h.target) ?? "@?";
    lines.push(`.try ${start}..${end} -> ${target}`);
  }

  return lines.join("\n");
}

export function normaliseModule(mod: HbcModule): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    out.push(normaliseFunction(mod, decodeFunction(mod, i)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// the per-function ratchet report (§6)
// ---------------------------------------------------------------------------

export interface RoundTripRegression {
  readonly fn: number;
  readonly wasExact: boolean;
}

export interface RoundTripReport {
  readonly totalFunctions: number;
  readonly exactFunctions: number;
  readonly ratchet: number;
  readonly regressions: readonly RoundTripRegression[];
  /** Present when the two modules don't even have the same function count —
   *  a stronger signal than any per-function ratchet number. */
  readonly functionCountMismatch: { readonly original: number; readonly recompiled: number } | null;
}

/**
 * Compare two already-normalised function lists (typically the original
 * fixture and the recompiled-decompiled candidate). `baseline`, if given, is
 * a previous ratchet's per-function exactness (by index) — `regressions`
 * lists every function that was exact in the baseline but is not now,
 * because that is a real regression; the ratchet number itself is measured,
 * not gated (spec 06 §6: "fail CI on regression, never on absolute score").
 */
export function compareNormalisedModules(a: readonly string[], b: readonly string[], baseline?: readonly boolean[]): RoundTripReport {
  if (a.length !== b.length) {
    return { totalFunctions: Math.max(a.length, b.length), exactFunctions: 0, ratchet: 0, regressions: [], functionCountMismatch: { original: a.length, recompiled: b.length } };
  }
  const total = a.length;
  let exact = 0;
  const regressions: RoundTripRegression[] = [];
  for (let i = 0; i < total; i++) {
    const isExact = a[i] === b[i];
    if (isExact) exact++;
    const wasExact = baseline?.[i];
    if (wasExact === true && !isExact) regressions.push({ fn: i, wasExact: true });
  }
  return { totalFunctions: total, exactFunctions: exact, ratchet: total === 0 ? 1 : exact / total, regressions, functionCountMismatch: null };
}

/** End-to-end: parse both `.hbc` byte buffers and produce the ratchet report
 *  plus per-function exactness (for a committed baseline / CLI diff). */
export function roundTripFromBytes(originalBytes: Uint8Array, recompiledBytes: Uint8Array, baseline?: readonly boolean[]): RoundTripReport & { readonly exactness: readonly boolean[] } {
  const a = normaliseModule(parseHbc(originalBytes));
  const b = normaliseModule(parseHbc(recompiledBytes));
  const report = compareNormalisedModules(a, b, baseline);
  const n = Math.min(a.length, b.length);
  const exactness: boolean[] = [];
  for (let i = 0; i < n; i++) exactness.push(a[i] === b[i]);
  return { ...report, exactness };
}

/** First-divergence + similarity, for CLI reporting (`hbc2js equiv
 *  normalise`) — line-oriented, over the joined per-function texts. */
export function diffNormalised(a: readonly string[], b: readonly string[]): { readonly equal: boolean; readonly firstDivergence: { readonly fn: number; readonly a: string; readonly b: string } | null; readonly similarity: number } {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const setB = new Set(b);
  let common = 0;
  for (const l of a) if (setB.has(l)) common++;
  const similarity = a.length + b.length === 0 ? 1 : (2 * common) / (a.length + b.length);
  return {
    equal: a.length === b.length && i === a.length,
    firstDivergence: i < Math.max(a.length, b.length) ? { fn: i, a: a[i] ?? "<eof>", b: b[i] ?? "<eof>" } : null,
    similarity,
  };
}
