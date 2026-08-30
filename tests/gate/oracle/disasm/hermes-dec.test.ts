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

          const mismatches: string[] = [];
          const n = Math.max(ours.length, theirs.length);
          for (let i = 0; i < n && mismatches.length < 20; i++) {
            if (ours[i] !== theirs[i]) {
              mismatches.push(`${f.group}/${f.name} v${b.version} @line ${i}: ours=${JSON.stringify(ours[i])} theirs=${JSON.stringify(theirs[i])}`);
            }
          }
          assert.equal(mismatches.length, 0, `\n${mismatches.join("\n")}`);
          assert.equal(ours.length, theirs.length, `${f.group}/${f.name} v${b.version}: line count ours=${ours.length} theirs=${theirs.length}`);
        });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
