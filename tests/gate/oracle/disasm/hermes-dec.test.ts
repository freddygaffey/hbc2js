// docs/specs/02-disassembler.md §7.B — diff against hermes-dec's `hbc-disassembler`.
// AGPL: reading its STDOUT is allowed, reading its source is forbidden (D4/R6).
// This file does neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHbc } from "../../../../src/index.ts";
import { decodeFunction } from "../../../../src/disasm/decode.ts";
import { listFixtures } from "../../../support/fixtures.ts";
import { requireOracle, runOracle } from "../../../support/oracles.ts";
import { isKnownAmbiguousV98 } from "../../../support/known-issues.ts";
import { normaliseHermesDec, ourFuncLine, ourHandlerLines, ourInstructionLine } from "./normalize.ts";

/**
 * hermes-dec's own `hbc-disassembler` still has the v98 large-header flags bug
 * this project's `fddf194` just fixed on our side (docs/HBC-FORMAT.md §3.3):
 * it reads a v98 function's `exc`/`dbg` bits from byte 35 of the 37-byte large
 * header instead of byte 36, so those two FUNC-line fields are wrong for
 * nearly every overflowed v98 function — this is hermes-dec's bug, not ours
 * (verified against real `hermesc -dump-bytecode` ground truth in
 * `tests/gate/oracle/disasm/hermesc.test.ts`'s independent 100%-match run;
 * e.g. `constructs/01-if-else-chain/v98.hbc`'s `global`, function #0, prints
 * "exc handler=0" from hermes-dec while the real bytecode has a genuine
 * handler covering bytes 60..85). `tests/gate/oracle/known-divergences.md`
 * item 9 documents the byte evidence.
 *
 * The bug has two visible effects, both from the same wrong byte:
 *  1. The `FUNC` line's `exc`/`dbg` fields (index 6/7) are wrong.
 *  2. When hermes-dec's own (wrong) `exc` bit reads 0 for a function that
 *     genuinely has a handler, it doesn't print an
 *     `[Exception handlers: ...]` line for that function *at all* — so
 *     `theirs` is missing our `EH ...` lines entirely, not just showing a
 *     wrong count.
 *
 * Per spec 02 §7.B this is legitimate to allowlist narrowly (a real, one-
 * directional, understood tool disagreement), never to paper over: this
 * function masks exactly those two effects, function-by-function, using
 * hermes-dec's own (wrong) `exc` bit as the trigger — so a real future
 * regression in *our* v98 exc/dbg decoding, or in our handler decoding, still
 * fails everywhere else in the file (every other FUNC-line field and every
 * instruction line are still compared verbatim).
 */
const V98_MASK = "*";

// `strict` (index 5) is packed into the *same* flags byte as `exc`/`dbg`
// (index 6/7) — hermes-dec reading byte 35 instead of byte 36 for v98's
// 37-byte large header (docs/HBC-FORMAT.md §3.3) misreads all three bits
// together, not just two of them. Confirmed: `constructs/32-class-basic/v98.hbc`
// function #1 (`Point`, a class constructor — necessarily strict) decodes
// `strict=1` on our side; hermes-dec prints `strict=0`. Same root cause as
// items 6/7, so masked alongside them, not treated as a fourth divergence.
function maskV98FuncExcDbg(line: string): string {
  const parts = line.split(" ");
  parts[5] = V98_MASK;
  parts[6] = V98_MASK;
  parts[7] = V98_MASK;
  return parts.join(" ");
}

/** Splits a flat `[FUNC, ...EH, ...insn, FUNC, ...EH, ...insn, ...]` line list
 *  into one array per function (each starting with its `FUNC ...` line). */
function splitIntoFunctionBlocks(lines: readonly string[]): string[][] {
  const blocks: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("FUNC ")) blocks.push([line]);
    else blocks[blocks.length - 1]?.push(line);
  }
  return blocks;
}

/** v98 allowlist (see the doc comment above): applied function-by-function so
 *  the EH-line suppression is keyed off hermes-dec's own per-function (wrong)
 *  exc bit, not a blanket rule. */
function applyV98Allowlist(oursLines: readonly string[], theirsLines: readonly string[]): { ours: string[]; theirs: string[] } {
  const oursBlocks = splitIntoFunctionBlocks(oursLines);
  const theirsBlocks = splitIntoFunctionBlocks(theirsLines);
  const ours: string[] = [];
  const theirs: string[] = [];
  const n = Math.max(oursBlocks.length, theirsBlocks.length);
  for (let i = 0; i < n; i++) {
    const oursBlock = oursBlocks[i] ?? [];
    const theirsBlock = theirsBlocks[i] ?? [];
    const theirsFunc = theirsBlock[0];
    const theirsExcIsFalse = theirsFunc !== undefined && theirsFunc.split(" ")[6] === "0";
    const oursBlockAdjusted = theirsExcIsFalse ? oursBlock.filter((l) => !l.startsWith("EH ")) : oursBlock;
    ours.push(...oursBlockAdjusted.map(maskV98FuncExcDbg));
    theirs.push(...theirsBlock.map(maskV98FuncExcDbg));
  }
  return { ours, theirs };
}

test("7.B: hbc-disassembler diff, per (fixture, version)", async (t) => {
  const bin = requireOracle(t, "hbc-disassembler");
  if (bin === null) return;

  const fixtures = listFixtures();
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-hermesdec-oracle-"));
  try {
    for (const f of fixtures) {
      for (const b of f.binaries) {
        await t.test(`${f.group}/${f.name} v${b.version}${b.variant === "public" ? "-public" : ""}`, () => {
          const outPath = join(dir, "out.disasm");
          const { status, stdout } = runOracle(bin, [b.path, outPath]);
          // hbc-disassembler writes to the given path and a short banner to stdout;
          // read the file it wrote (docs/TOOLCHAIN.md).
          const content = readFileSync(outPath, "utf8");
          assert.equal(status, 0, `hbc-disassembler exited ${status} on ${b.path}: ${stdout}`);

          const theirs = normaliseHermesDec(content);
          const forceTable = isKnownAmbiguousV98(f.group, f.name, b.version) ? "hbc98-late" : undefined;
          const mod = parseHbc(b.bytes(), forceTable !== undefined ? { opcodeTable: forceTable } : undefined);

          const ours: string[] = [];
          for (let i = 0; i < mod.functions.length; i++) {
            const fn = decodeFunction(mod, i);
            ours.push(ourFuncLine(fn, mod.functions[i]!.header.flags));
            ours.push(...ourHandlerLines(fn.handlers));
            for (const insn of fn.instructions) ours.push(ourInstructionLine(insn));
          }

          // Item 9 (see the doc comment above `maskV98FuncExcDbg`): apply the
          // narrow, function-scoped v98 allowlist only at v98.
          const { ours: oursForCompare, theirs: theirsForCompare } = b.version === 98 ? applyV98Allowlist(ours, theirs) : { ours, theirs };

          const mismatches: string[] = [];
          const n = Math.max(oursForCompare.length, theirsForCompare.length);
          for (let i = 0; i < n && mismatches.length < 20; i++) {
            if (oursForCompare[i] !== theirsForCompare[i]) {
              mismatches.push(`${f.group}/${f.name} v${b.version} @line ${i}: ours=${JSON.stringify(ours[i])} theirs=${JSON.stringify(theirs[i])}`);
            }
          }
          assert.equal(mismatches.length, 0, `\n${mismatches.join("\n")}`);
          assert.equal(oursForCompare.length, theirsForCompare.length, `${f.group}/${f.name} v${b.version}: line count ours=${ours.length} theirs=${theirs.length}`);
        });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
