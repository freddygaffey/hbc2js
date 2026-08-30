// docs/specs/02-disassembler.md §7.A — diff our `raw` mode against
// `hermesc -dump-bytecode -pretty-disassemble=false`. MIT-licensed, primary oracle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHbc } from "../../../../src/index.ts";
import { printModule } from "../../../../src/disasm/print.ts";
import { listFixtures } from "../../../support/fixtures.ts";
import type { FixtureBinary, FixtureVersion } from "../../../support/fixtures.ts";
import { requireHermesc, runHermesc } from "../../../support/hermesc.ts";
import type { Hermesc, HbcVersion } from "../../../support/hermesc.ts";
import { normaliseHermesc, normaliseOursRaw } from "./normalize.ts";
import { isKnownAmbiguousV98 } from "../../../support/known-issues.ts";
import type { OpcodeTableId } from "../../../../src/index.ts";

function ourRawText(bytes: Uint8Array, forceTable?: OpcodeTableId): string {
  const mod = parseHbc(bytes, forceTable !== undefined ? { opcodeTable: forceTable } : undefined);
  const chunks: string[] = [];
  printModule(mod, { write: (s: string): boolean => (chunks.push(s), true) } as NodeJS.WritableStream, { mode: "raw" });
  return chunks.join("");
}

/** Compile `source.js` with `hermesc`, under the given embedded filename, into a
 *  fresh temp dir; returns the compiled bytes and the `-dump-bytecode` stdout. */
function compileAndDump(hermesc: Hermesc, sourceJs: string, filename: string): { bytes: Uint8Array; dumpStdout: string; status: number } {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-hermesc-oracle-"));
  try {
    const srcPath = join(dir, filename);
    writeFileSync(srcPath, sourceJs);
    const emit = runHermesc(hermesc, ["-emit-binary", "-out=probe.hbc", filename], dir);
    if (emit.status !== 0) return { bytes: new Uint8Array(0), dumpStdout: "", status: emit.status };
    const probeBytes = new Uint8Array(readFileSync(join(dir, "probe.hbc")));
    const dump = runHermesc(hermesc, ["-dump-bytecode", "-pretty-disassemble=false", filename], dir);
    return { bytes: probeBytes, dumpStdout: dump.stdout, status: dump.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const VERSIONS: readonly HbcVersion[] = [84, 94, 96, 98, 99];

test("7.A: hermesc -dump-bytecode diff, per (fixture, version)", async (t) => {
  const fixtures = listFixtures();

  for (const version of VERSIONS) {
    const hermesc = requireHermesc(t, version);
    if (hermesc === null) continue;

    for (const f of fixtures) {
      const binaries = f.binaries.filter((b: FixtureBinary) => b.version === (version as FixtureVersion));
      for (const b of binaries) {
        // hermes-dec-sample/v99.hbc: known non-reproducible (built by a non-public
        // Hermes commit — docs/TOOLCHAIN.md). v99-public.hbc (a separate,
        // reproducible FixtureBinary) covers the v99 comparison instead. See
        // tests/gate/oracle/known-divergences.md.
        if (f.group === "hermes-dec-sample" && version === 99 && b.variant === "") continue;

        await t.test(`${f.group}/${f.name} v${version}${b.variant === "public" ? "-public" : ""}`, () => {
          const sourceJs = readFileSync(f.sourcePath, "utf8");
          // hermes-dec-sample/v94.hbc is a preserved historical original compiled
          // under the embedded filename "sample.js", not "source.js" (verified: a
          // fresh compile of the same source under "source.js" differs at byte 1630;
          // under "sample.js" it is byte-identical). Every other fixture (including
          // hermes-dec-sample's own v84/v96/v98/v99-public) reproduces under
          // "source.js". Try "source.js" first; fall back to "sample.js" only for
          // this one documented case, rather than silently widening the fallback.
          let result = compileAndDump(hermesc, sourceJs, "source.js");
          let usedFallback = false;
          if (!bytesEqual(result.bytes, b.bytes()) && f.group === "hermes-dec-sample" && version === 94 && b.variant === "") {
            result = compileAndDump(hermesc, sourceJs, "sample.js");
            usedFallback = true;
          }
          if (!bytesEqual(result.bytes, b.bytes())) {
            // Applicability gate (spec 02 §7.A step 3): not byte-identical, so this
            // (fixture, version) pair is not a valid hermesc-dump comparison.
            // INCONCLUSIVE, not a failure — see known-divergences.md. Every
            // occurrence beyond the one documented case is itself a signal, so this
            // still needs eyes: report which fixture it was.
            assert.ok(
              usedFallback === false,
              `${f.group}/${f.name} v${version}: even the "sample.js" fallback didn't reproduce — new divergence, update known-divergences.md (byte length ours=${result.bytes.length} fixture=${b.bytes().length})`,
            );
            t.skip(`${f.group}/${f.name} v${version}: hermesc recompile is not byte-identical to the fixture (len ${result.bytes.length} vs ${b.bytes().length}) — see known-divergences.md`);
            return;
          }
          assert.equal(result.status, 0, `hermesc -dump-bytecode exited ${result.status} for ${f.group}/${f.name} v${version}`);

          const theirs = normaliseHermesc(result.dumpStdout);
          // D8: the auto-probe correctly refuses to guess on the 8 fixtures where
          // hbc98-late/hbc99-mar2026 genuinely disagree (tests/support/known-issues.ts);
          // force the externally-validated table so these are explicit passes, not
          // uncaught E_LAYOUT_AMBIGUOUS crashes before the diff even runs.
          const forceTable: OpcodeTableId | undefined = isKnownAmbiguousV98(f.group, f.name, version) ? "hbc98-late" : undefined;
          const ours = normaliseOursRaw(ourRawText(b.bytes(), forceTable));

          assert.equal(ours.headers.length, theirs.headers.length, `${f.group}/${f.name} v${version}: function count mismatch (ours=${ours.headers.length} theirs=${theirs.headers.length})`);

          // Free assertion (review B1's own suggestion): the NC/Constructor prefix
          // is ground truth for FunctionFlags.prohibitInvoke.
          const mod = parseHbc(b.bytes(), forceTable !== undefined ? { opcodeTable: forceTable } : undefined);
          for (let i = 0; i < theirs.headers.length; i++) {
            const want = theirs.headers[i]!.prefix;
            const flags = mod.functions[i]!.header.flags;
            const expectedPrefix = flags.prohibitInvoke === "call" ? "Constructor" : flags.prohibitInvoke === "construct" ? "NC" : "";
            assert.equal(want, expectedPrefix, `${f.group}/${f.name} v${version} fn#${i}: hermesc prefix ${JSON.stringify(want)} vs prohibitInvoke=${flags.prohibitInvoke}`);
          }

          const mismatches: string[] = [];
          const n = Math.max(ours.lines.length, theirs.lines.length);
          for (let i = 0; i < n && mismatches.length < 20; i++) {
            if (ours.lines[i] !== theirs.lines[i]) {
              mismatches.push(`${f.group}/${f.name} v${version} @line ${i}: ours=${JSON.stringify(ours.lines[i])} theirs=${JSON.stringify(theirs.lines[i])}`);
            }
          }
          assert.equal(mismatches.length, 0, `\n${mismatches.join("\n")}`);
          assert.equal(ours.lines.length, theirs.lines.length, `${f.group}/${f.name} v${version}: line count ours=${ours.lines.length} theirs=${theirs.lines.length}`);
        });
      }
    }
  }
});
