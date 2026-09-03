#!/usr/bin/env node
// Helper for minimise-live.mjs: runs one program through hermesc -> decompile
// -> runOracleLadder at a fixed version and prints MATCH/NOMATCH against a
// target signature. Spawned as a child process per ddmin candidate because
// minimise.ts's `reproduces` callback is synchronous.
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHermesc, compileWithHermesc } from "../../src/harness/roundtrip.ts";
import { runOracleLadder } from "../../src/harness/ladder.ts";
import { chooseReference } from "../../src/harness/reference-policy.ts";
import { decompile } from "../../src/decompile.ts";
import { signatureOf, signatureKey } from "../../src/fuzzgen/signature.ts";

const TRACED_VERSIONS = [84, 94, 96, 99];
const [, , versionArg, programFile, targetSig] = process.argv;
const version = Number(versionArg);
const program = readFileSync(programFile, "utf8");

async function main() {
  const hermesc = findHermesc(version);
  if (hermesc === null) return done(false);
  const compiled = compileWithHermesc(hermesc, program, "fuzz.js");
  if (!compiled.ok) return done(false);
  let candidateJs;
  try {
    candidateJs = decompile(compiled.bytes, { resolveV98Ambiguity: true, moduleName: "fuzz-min" }).code;
  } catch {
    return done(false);
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-minck-"));
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
      hbcBytes: compiled.bytes, hbcVersion: version, embeddedFilename: "fuzz.js", matchedCompilerReference: true,
      oracles: isTraced ? ["syntax", "trace", "fuzz"] : ["syntax", "roundtrip"],
      seed: 0, fuzz: 20, timeoutMs: 5000, maxRecords: 5000,
    });
    const sig = signatureOf(result);
    const key = sig !== null ? signatureKey(sig) : null;
    return done(key === targetSig);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function done(match) {
  console.log(match ? "MATCH" : "NOMATCH");
}

main();
