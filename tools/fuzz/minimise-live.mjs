#!/usr/bin/env node
// tools/fuzz/minimise-live.mjs — wires src/fuzzgen/minimise.ts's `minimise()`
// to a LIVE `reproduces` callback (hermesc -> decompile -> runOracleLadder
// for one fixed HBC version), per docs/fuzz/CONSTRUCT-FUZZER.md's
// "Deferred: live auto-minimiser" follow-up. This is the offline/manual
// tool the doc describes ("a human or the follow-up can minimise it
// offline") — not wired into the driver's hot loop (still deferred there,
// per the doc, to avoid multiplying every finding's cost by ddmin's
// iteration count on the campaign's critical path).
//
// Usage:
//   node tools/fuzz/minimise-live.mjs <version> <programFile> [outFile]
//
// Reproduction is signature equality against the ORIGINAL program's
// signature at the given version (not a fixed string), so it tracks
// whichever DIVERGENT/ERROR shape the seed program triggers.
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHermesc, compileWithHermesc } from "../../src/harness/roundtrip.ts";
import { runOracleLadder, VERDICT } from "../../src/harness/ladder.ts";
import { chooseReference } from "../../src/harness/reference-policy.ts";
import { decompile } from "../../src/decompile.ts";
import { signatureOf, signatureKey } from "../../src/fuzzgen/signature.ts";
import { minimise } from "../../src/fuzzgen/minimise.ts";

const TRACED_VERSIONS = [84, 94, 96, 99];

async function runOnce(version, program) {
  const hermesc = findHermesc(version);
  if (hermesc === null) return { verdict: "ERROR", signature: null };
  const compiled = compileWithHermesc(hermesc, program, "fuzz.js");
  if (!compiled.ok) return { verdict: "ERROR", signature: null };
  let candidateJs;
  try {
    candidateJs = decompile(compiled.bytes, { resolveV98Ambiguity: true, moduleName: "fuzz-min" }).code;
  } catch (e) {
    return { verdict: "ERROR", signature: signatureKey({ verdict: "ERROR", detail: String(e) }) };
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-minimise-"));
  try {
    const candidatePath = join(dir, "candidate.js");
    const sourcePath = join(dir, "source.js");
    writeFileSync(candidatePath, candidateJs);
    writeFileSync(sourcePath, program);
    const fixture = { name: "construct-fuzz-minimise" };
    const reference = chooseReference(fixture, version);
    const isTraced = TRACED_VERSIONS.includes(version);
    const result = await runOracleLadder({
      fixture, candidateJsPath: candidatePath, sourceJsPath: sourcePath, reference,
      hbcBytes: compiled.bytes, hbcVersion: version, embeddedFilename: "fuzz.js",
      oracles: isTraced ? ["syntax", "trace", "fuzz"] : ["syntax", "roundtrip"],
      seed: 0, fuzz: 20, timeoutMs: 5000, maxRecords: 5000,
    });
    const sig = signatureOf(result);
    return { verdict: result.verdict, signature: sig !== null ? signatureKey(sig) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const [, , versionArg, programFile, outFile] = process.argv;
  const version = Number(versionArg);
  const program = readFileSync(programFile, "utf8");
  const original = await runOnce(version, program);
  if (original.verdict === "PASS" || original.signature === null) {
    console.error(`input does not reproduce a DIVERGENT/ERROR signature at v${version} (verdict=${original.verdict})`);
    process.exit(1);
  }
  console.error(`target signature: ${original.signature.slice(0, 24)}... (${original.verdict})`);

  // Synchronous wrapper: minimise()'s `reproduces` contract is sync, but our
  // check is async (spawns hermesc/node). Small campaigns only (ddmin's own
  // iteration count is already log-linear in line count) — run a Node
  // event-loop-draining sync bridge via a queue is overkill here; instead
  // pre-resolve each candidate with a synchronous child process wrapper is
  // avoided by making `main` itself async and using a manually-unrolled
  // ddmin loop would duplicate minimise.ts. Simplest correct approach:
  // busy-poll isn't available without worker threads, so we shell out to
  // ourselves per candidate via a blocking child process instead.
  const { execFileSync } = await import("node:child_process");
  const selfCheckScript = join(new URL(".", import.meta.url).pathname, "minimise-check-one.mjs");
  const reproduces = (candidateProgram) => {
    const tmp = join(mkdtempSync(join(tmpdir(), "hbc2js-ddmin-")), "candidate.js");
    writeFileSync(tmp, candidateProgram);
    try {
      const out = execFileSync(process.execPath, ["--experimental-strip-types", selfCheckScript, String(version), tmp, original.signature], { encoding: "utf8" });
      return out.trim() === "MATCH";
    } catch {
      return false;
    } finally {
      rmSync(tmp, { force: true });
    }
  };

  const minimised = minimise(program, reproduces);
  const finalCheck = await runOnce(version, minimised);
  console.error(`minimised: ${program.split("\n").length} -> ${minimised.split("\n").length} lines; final verdict=${finalCheck.verdict} sigMatch=${finalCheck.signature === original.signature}`);
  if (outFile) {
    writeFileSync(outFile, minimised);
    console.error(`wrote ${outFile}`);
  } else {
    console.log(minimised);
  }
}

main();
