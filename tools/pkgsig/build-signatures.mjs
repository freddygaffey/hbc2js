#!/usr/bin/env node
// tools/pkgsig/build-signatures.mjs — T8 prototype (docs/PACKAGE-SIGNATURES.md).
//
// Fingerprints every function in a compiled Hermes bytecode (.hbc) file into
// a signature database entry: three tiers per function —
//   1. exactHash  — sha256 of the D3/D17 canonical-normalised disassembly
//      text (src/harness/roundtrip.ts's `normaliseFunction`: registers
//      renamed by first appearance, cache-slot indices dropped, function
//      names masked except `global`, string/bigint/builtin literal *content*
//      kept verbatim). Two functions compiled from the same source under the
//      same Hermes version/opt level produce byte-identical text here.
//   2. fuzzyHash  — sha256 of the bare mnemonic sequence (operands fully
//      stripped, not just cache slots/registers). Tolerant of literal-content
//      drift (e.g. a different embedded error message string) and of the
//      exact register-allocation-sensitive operand shape, but still requires
//      the same instruction *sequence* — a much coarser tier than exactHash.
//   3. stringSet  — the sorted, de-duplicated set of string-literal operand
//      values referenced by the function. Used as a similarity signal
//      (Jaccard) on top of a fuzzy-hash match, not as its own hash tier.
//
// No src/** code is written or modified here — this only *imports* the
// existing parser/disassembler/normaliser (docs/DECISIONS.md ownership split
// in the task brief). Node's native TS type-stripping (Node >=22.6, stable
// enough here on v25) runs these imports directly with no build step.
//
// Usage:
//   node build-signatures.mjs <in.hbc> <package-name> <package-version> <out.json> [--hbc-version N]
//
// Zero deps beyond Node's stdlib + this repo's own src/**.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");

const { parseHbc } = await import(join(repoRoot, "src", "index.ts"));
const { decodeFunction } = await import(join(repoRoot, "src", "disasm", "decode.ts"));
const { normaliseFunction } = await import(join(repoRoot, "src", "harness", "roundtrip.ts"));

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Bare mnemonic sequence — coarser than normaliseFunction: every operand
 *  (including string/bigint/builtin literal content, which normaliseFunction
 *  keeps) is dropped, only the instruction-name sequence and jump/switch
 *  *shape* (label vs. no label, case count) survive. */
function fuzzyText(fn) {
  const lines = [];
  for (const insn of fn.instructions) {
    const label = fn.labels.get(insn.offset);
    const prefix = label !== undefined ? "L:" : "";
    if (insn.kind === "switch") {
      const st = insn.switchTable;
      lines.push(`${prefix}SWITCH(${st ? st.cases.length : 0})`);
      continue;
    }
    lines.push(prefix + insn.name);
  }
  return lines.join("\n");
}

function stringSet(mod, fn) {
  const set = new Set();
  for (const insn of fn.instructions) {
    for (const op of insn.operands) {
      if (op.role === "string") set.add(mod.strings.get(op.value));
    }
  }
  return [...set].sort();
}

function main() {
  const args = process.argv.slice(2);
  const posArgs = args.filter((a) => !a.startsWith("--"));
  const [inPath, pkgName, pkgVersion, outPath] = posArgs;
  if (!inPath || !pkgName || !pkgVersion || !outPath) {
    console.error("usage: build-signatures.mjs <in.hbc> <package-name> <package-version> <out.json>");
    process.exit(2);
  }

  const bytes = new Uint8Array(readFileSync(inPath));
  const mod = parseHbc(bytes);

  const functions = [];
  for (let i = 0; i < mod.functions.length; i++) {
    const fn = decodeFunction(mod, i);
    const exactHash = sha256(normaliseFunction(mod, fn));
    const fuzzyHash = sha256(fuzzyText(fn));
    functions.push({
      index: i,
      name: fn.name,
      paramCount: fn.header.paramCount,
      frameSize: fn.header.frameSize,
      instrCount: fn.instructions.length,
      exactHash,
      fuzzyHash,
      stringSet: stringSet(mod, fn),
    });
  }

  const db = {
    package: pkgName,
    version: pkgVersion,
    hbcVersion: mod.header.version,
    sourceFile: inPath,
    totalFunctions: functions.length,
    functions,
  };
  writeFileSync(outPath, JSON.stringify(db, null, 1));
  console.log(`${pkgName}@${pkgVersion}: ${functions.length} functions -> ${outPath}`);
}

main();
