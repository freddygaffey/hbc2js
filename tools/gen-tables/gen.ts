#!/usr/bin/env node
// docs/specs/01-parser.md §5.4 — generates src/tables/generated/{opcodes,builtins}-<id>.ts
// and PROVENANCE.md from the vendored MIT sources in third_party/hermes/<tableId>/.
//
// Usage:
//   node tools/gen-tables/gen.ts          regenerate the committed files
//   node tools/gen-tables/gen.ts --check  regenerate into a temp dir and diff
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBuiltinsDef, parseBytecodeListDef } from "./parse-def.ts";
import type { BuiltinDef, BuiltinTable, OpcodeDef, OpcodeTable, OpcodeTableId, OperandTypeName } from "../../src/tables/types.ts";
import { repoRoot } from "../../src/util/paths.ts";

const ROOT = repoRoot();

interface TablePin {
  readonly id: OpcodeTableId;
  readonly bytecodeVersion: number;
}

const PINS: readonly TablePin[] = [
  { id: "hbc84", bytecodeVersion: 84 },
  { id: "hbc94", bytecodeVersion: 94 },
  { id: "hbc96", bytecodeVersion: 96 },
  { id: "hbc98-2024", bytecodeVersion: 98 },
  { id: "hbc98-late", bytecodeVersion: 98 },
  { id: "hbc99-feb2026", bytecodeVersion: 99 },
  { id: "hbc99-mar2026", bytecodeVersion: 99 },
];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readVendored(tableId: OpcodeTableId, filename: string): { text: string; sha256: string } {
  const path = join(ROOT, "third_party", "hermes", tableId, filename);
  const bytes = readFileSync(path);
  return { text: bytes.toString("utf8"), sha256: sha256(bytes) };
}

function readCommit(tableId: OpcodeTableId): string {
  const path = join(ROOT, "third_party", "hermes", tableId, "VENDOR.yml");
  const text = readFileSync(path, "utf8");
  const m = /^hermesCommit:\s*(\S+)/m.exec(text);
  if (m === null) throw new Error(`gen: could not find hermesCommit in ${path}`);
  return m[1]!;
}

/**
 * hbc98-late is the one table with no known real Hermes commit (docs/specs/01-parser.md
 * §5.2.1 / §5.3): every publicly reachable static_h commit between the v98 and v99
 * BYTECODE_VERSION bumps was checked (facebook/hermes, full non-shallow clone, see
 * docs/AGENT-LOG.md) and none reproduces what `hermes-compiler@250829098.0.x`
 * (the real npm package producing every v98 fixture in this repo) actually emits —
 * that package embeds no commit hash (same situation TOOLCHAIN.md already documents
 * for hbc99-mar2026's own npm package). The vendored `third_party/hermes/hbc98-late/`
 * source (commit 639e5d6afb16, the last static_h commit before the v99 bump) is the
 * closest known upstream point, and is empirically *not quite* what real v98-late
 * binaries produce.
 *
 * The corrections below were derived by decoding all 223 function bodies shared
 * (same bytecodeSizeInBytes) between every `constructs/*<!-- -->/v98.hbc`/`v99.hbc` pair and
 * `hermes-dec-sample/v98.hbc`/`v99.hbc` in this project's own MIT-licensed fixture
 * corpus (`tests/fixtures/**`), using this project's own hbc99-mar2026 table as the
 * (fully verified, §5.5-passing) decoder — no hermes-dec involved (D4). 117 distinct
 * opcode names were observed, agreeing unanimously (or with a single-instance outlier
 * clearly attributable to unrelated decode noise) with the patched table below; zero
 * disagreements. See docs/AGENT-LOG.md for the full derivation.
 *
 * 1. `ToUint32` (present in the vendored file) does not exist in real v98-late; it was
 *    added to static_h after the real build's fork point. Confirmed: `ToUint32` is
 *    absent from `hbc98-2024` (c00cc5759) but present from the vendored hbc98-late
 *    commit onward — i.e. it is exactly the kind of late addition a frozen internal
 *    fork would miss. Removing it is what makes CreateRegExp/UIntSwitchImm/
 *    StringSwitchImm land at the measured 165/166/167 (docs/specs/01-parser.md §5.2.1).
 * 2. Real v98-late has one opcode, immediately before `Mov` (measured: `Mov` sits at
 *    16, one past the vendored file's 15), that does not appear in the vendored
 *    `639e5d6a` file at all. M1 review Finding 2 flagged the first version of this
 *    patch for guessing a plausible-but-unverified `(Reg8, Reg8)` signature here
 *    ("do not guess a plausible-looking operand signature"). Investigating that
 *    finding (by fixing decoders to fail loudly on the guess, which then broke
 *    `tests/fixtures/constructs/50-this-binding/v98.hbc` — a real, previously-passing
 *    fixture that turns out to actually USE this opcode) led to the real answer:
 *    the missing opcode is **`CacheNewObject(Reg8, Reg8, UInt32, UInt8)`**, confirmed
 *    two independent ways —
 *      (a) `git log -S'CacheNewObject' -- include/hermes/BCGen/HBC/BytecodeList.def`
 *          on a full non-shallow facebook/hermes clone shows it added
 *          (`89bc5f08e`, 2024-12-04, 2-operand form) then removed (`7193d4485`,
 *          2026-01-21, "superseded by the AddPropertyCache optimization"); its
 *          direct parent commit `f74f6bbe37ec85a52175c723b366b37717b64605`
 *          (2026-01-21, `BYTECODE_VERSION = 98`, an ancestor of the vendored
 *          `639e5d6a`) has the exact 4-operand form
 *          `DEFINE_OPCODE_4(CacheNewObject, Reg8, Reg8, UInt32, UInt8)` sitting
 *          IMMEDIATELY before `Mov` — i.e. at this exact position;
 *      (b) decoding `50-this-binding/v98.hbc`'s function 3 ("Counter") bytes
 *          directly against that signature consumes exactly 8 bytes (opcode + Reg8 +
 *          Reg8 + UInt32 + UInt8) and realigns perfectly with the next instruction
 *          (`LoadConstZero`) — and hermes-dec's own (D4-compliant, output-only)
 *          disassembly of that exact byte range independently names it
 *          `CacheNewObject` with the same four operand values.
 *    `f74f6bbe37e`'s own table still has `ToUint32` (added 2025-11-06, `31afd17b5`,
 *    well before this commit) — so no single real commit has BOTH "CacheNewObject
 *    present" and "ToUint32 absent" simultaneously; the real v98-late build remains
 *    an unreachable-from-here internal fork, but every other field of that commit's
 *    table (CreateFunctionEnvironment=64, DeclareGlobalVar=67, GetGlobalObject=61,
 *    PutByIdLoose=74, CreateClosure=132, and CacheNewObject's position) matches this
 *    project's independent measurements exactly, which is why this two-correction
 *    patch (not a single-commit pin) is the honest representation of the evidence.
 */
function patchHbc98Late(opcodes: readonly OpcodeDef[]): readonly OpcodeDef[] {
  const movIdx = opcodes.findIndex((o) => o.name === "Mov");
  const toUint32Idx = opcodes.findIndex((o) => o.name === "ToUint32");
  if (movIdx === -1 || toUint32Idx === -1) {
    throw new Error("gen: hbc98-late patch anchors (Mov / ToUint32) not found — vendored file changed, re-derive the patch");
  }
  const patched: OpcodeDef[] = [];
  for (let i = 0; i < opcodes.length; i++) {
    if (i === toUint32Idx) continue;
    patched.push(opcodes[i]!);
    if (i === movIdx - 1) {
      // Real Hermes opcode CacheNewObject, confirmed per the doc comment above —
      // commit f74f6bbe37ec85a52175c723b366b37717b64605, 2026-01-21.
      patched.push({ n: -1, name: "CacheNewObject", operands: ["Reg8", "Reg8", "UInt32", "UInt8"] as readonly OperandTypeName[] });
    }
  }
  return patched.map((o, i) => ({ ...o, n: i }));
}

function buildOpcodeTable(pin: TablePin): { table: OpcodeTable; sha256: string; commit: string } {
  const { text, sha256: hash } = readVendored(pin.id, "BytecodeList.def");
  const commit = readCommit(pin.id);
  const parsed = parseBytecodeListDef(text);
  if (parsed.opcodes.length !== parsed.independentCount) {
    throw new Error(`gen: ${pin.id} opcode count ${parsed.opcodes.length} != independent count ${parsed.independentCount}`);
  }
  if (parsed.opcodes[0]?.name !== "Unreachable") {
    throw new Error(`gen: ${pin.id} opcodes[0] must be Unreachable, got ${parsed.opcodes[0]?.name}`);
  }
  const opcodes = pin.id === "hbc98-late" ? patchHbc98Late(parsed.opcodes) : parsed.opcodes;
  return {
    table: {
      id: pin.id,
      bytecodeVersion: pin.bytecodeVersion,
      hermesCommit: commit,
      operandTypes: parsed.operandTypes,
      opcodes,
    },
    sha256: hash,
    commit,
  };
}

function buildBuiltinTable(pin: TablePin): { table: BuiltinTable; sha256: string } {
  const { text, sha256: hash } = readVendored(pin.id, "Builtins.def");
  const commit = readCommit(pin.id);
  const builtins: readonly BuiltinDef[] = parseBuiltinsDef(text);
  return { table: { id: pin.id, hermesCommit: commit, builtins }, sha256: hash };
}

function jsonOperand(name: OperandTypeName): string {
  return JSON.stringify(name);
}

function renderOpcodeTable(t: OpcodeTable, constName: string): string {
  const lines: string[] = [];
  lines.push("// GENERATED by tools/gen-tables/gen.ts — DO NOT EDIT");
  lines.push(`// Source: facebook/hermes @ ${t.hermesCommit} (MIT), include/hermes/BCGen/HBC/BytecodeList.def`);
  lines.push(`import type { OpcodeTable } from "../types.ts";`);
  lines.push(`export const ${constName}: OpcodeTable = {`);
  lines.push(`  id: ${JSON.stringify(t.id)},`);
  lines.push(`  bytecodeVersion: ${t.bytecodeVersion},`);
  lines.push(`  hermesCommit: ${JSON.stringify(t.hermesCommit)},`);
  lines.push(`  operandTypes: {`);
  const typeNames = Object.keys(t.operandTypes).sort() as OperandTypeName[];
  for (const name of typeNames) {
    const info = t.operandTypes[name];
    lines.push(`    ${name}: { bytes: ${info.bytes}, signed: ${info.signed}, kind: ${JSON.stringify(info.kind)} },`);
  }
  lines.push(`  },`);
  lines.push(`  opcodes: [`);
  for (const op of t.opcodes) {
    const operandsStr = `[${op.operands.map(jsonOperand).join(", ")}]`;
    let idsStr = "";
    if (op.ids !== undefined) {
      const keys = Object.keys(op.ids)
        .map(Number)
        .sort((a, b) => a - b);
      idsStr = `, ids: { ${keys.map((k) => `${k}: ${JSON.stringify(op.ids![k])}`).join(", ")} }`;
    }
    const unverifiedStr = op.unverified === true ? `, unverified: true` : "";
    lines.push(`    { n: ${op.n}, name: ${JSON.stringify(op.name)}, operands: ${operandsStr}${idsStr}${unverifiedStr} },`);
  }
  lines.push(`  ],`);
  lines.push(`} as const;`);
  lines.push("");
  return lines.join("\n");
}

function renderBuiltinTable(t: BuiltinTable, constName: string): string {
  const lines: string[] = [];
  lines.push("// GENERATED by tools/gen-tables/gen.ts — DO NOT EDIT");
  lines.push(`// Source: facebook/hermes @ ${t.hermesCommit} (MIT), include/hermes/FrontEndDefs/Builtins.def`);
  lines.push(`import type { BuiltinTable } from "../types.ts";`);
  lines.push(`export const ${constName}: BuiltinTable = {`);
  lines.push(`  id: ${JSON.stringify(t.id)},`);
  lines.push(`  hermesCommit: ${JSON.stringify(t.hermesCommit)},`);
  lines.push(`  builtins: [`);
  for (const b of t.builtins) {
    const obj = b.object !== undefined ? `, object: ${JSON.stringify(b.object)}` : "";
    const method = b.method !== undefined ? `, method: ${JSON.stringify(b.method)}` : "";
    lines.push(`    { n: ${b.n}, name: ${JSON.stringify(b.name)}${obj}${method} },`);
  }
  lines.push(`  ],`);
  lines.push(`} as const;`);
  lines.push("");
  return lines.join("\n");
}

function constNameFor(id: OpcodeTableId): string {
  return id.toUpperCase().replace(/-/g, "_");
}

function generateAll(outDir: string): { provenance: string } {
  mkdirSync(outDir, { recursive: true });
  const provenanceLines: string[] = [
    "<!-- GENERATED by tools/gen-tables/gen.ts — DO NOT EDIT -->",
    "# Opcode/builtin table provenance",
    "",
    "Every table is generated from a specific facebook/hermes commit (MIT licence),",
    "vendored under `third_party/hermes/<tableId>/`. See docs/specs/01-parser.md §5.",
    "",
    "| tableId | bytecodeVersion | hermesCommit | opcodes | BytecodeList.def sha256 | Builtins.def sha256 |",
    "|---|---|---|---|---|---|",
  ];

  for (const pin of PINS) {
    const { table: opTable, sha256: opSha } = buildOpcodeTable(pin);
    const { table: builtinTable, sha256: builtinSha } = buildBuiltinTable(pin);
    const constName = constNameFor(pin.id);
    writeFileSync(join(outDir, `opcodes-${pin.id}.ts`), renderOpcodeTable(opTable, constName), "utf8");
    writeFileSync(join(outDir, `builtins-${pin.id}.ts`), renderBuiltinTable(builtinTable, constName), "utf8");
    provenanceLines.push(
      `| ${pin.id} | ${pin.bytecodeVersion} | ${opTable.hermesCommit} | ${opTable.opcodes.length} | ${opSha} | ${builtinSha} |`,
    );
  }

  provenanceLines.push("");
  provenanceLines.push(
    "**hbc98-late is a patched table, not a literal parse of its vendored commit** — " +
      "see the `patchHbc98Late` doc comment in `tools/gen-tables/gen.ts` and `docs/AGENT-LOG.md` " +
      "for the full empirical derivation (no known public commit reproduces the real " +
      "`hermes-compiler@250829098.0.x` opcode table).",
  );
  provenanceLines.push("");
  provenanceLines.push(
    "**hbc98-late opcode 15 is `CacheNewObject(Reg8, Reg8, UInt32, UInt8)`** — a real " +
      "Hermes opcode (added `89bc5f08e` 2024-12-04, removed `7193d4485` 2026-01-21) " +
      "absent from the vendored `639e5d6a` source but confirmed via its parent commit " +
      "`f74f6bbe37ec85a52175c723b366b37717b64605` (BYTECODE_VERSION=98, an ancestor of " +
      "`639e5d6a`) and independently via `tests/fixtures/constructs/50-this-binding/" +
      "v98.hbc` function 3, which actually uses it (M1 review Finding 2 — see " +
      "`patchHbc98Late`'s doc comment in tools/gen-tables/gen.ts for the full story).",
  );
  provenanceLines.push("");
  const provenance = provenanceLines.join("\n");
  writeFileSync(join(outDir, "PROVENANCE.md"), provenance, "utf8");
  return { provenance };
}

function main(): void {
  const check = process.argv.includes("--check");
  const finalOutDir = join(ROOT, "src", "tables", "generated");

  if (!check) {
    generateAll(finalOutDir);
    console.log(`gen-tables: wrote ${PINS.length} opcode tables + builtin tables to ${finalOutDir}`);
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), "hbc2js-gen-tables-"));
  try {
    generateAll(tmp);
    const filenames = ["PROVENANCE.md", ...PINS.flatMap((p) => [`opcodes-${p.id}.ts`, `builtins-${p.id}.ts`])];
    let drift = false;
    for (const filename of filenames) {
      const committedPath = join(finalOutDir, filename);
      const generatedPath = join(tmp, filename);
      if (!existsSync(committedPath)) {
        console.error(`gen-tables --check: MISSING committed file ${committedPath}`);
        drift = true;
        continue;
      }
      const committed = readFileSync(committedPath, "utf8");
      const generated = readFileSync(generatedPath, "utf8");
      if (committed !== generated) {
        console.error(`gen-tables --check: DRIFT in ${filename} — run 'npm run gen:tables' to update`);
        drift = true;
      }
    }
    if (drift) {
      process.exitCode = 1;
    } else {
      console.log(`gen-tables --check: all ${filenames.length} generated files match (reproducible from third_party/hermes/**)`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
