#!/usr/bin/env node
// tools/fuzz/minimise-live.mjs — wires `src/fuzzgen/minimise.ts`'s
// `minimiseAsync()` to a LIVE `reproduces` callback (hermesc -> decompile ->
// runOracleLadder for one fixed HBC version), per
// docs/fuzz/CONSTRUCT-FUZZER.md's "Deferred: live auto-minimiser" follow-up.
// This is the offline/manual tool the doc describes — not wired into the
// driver's hot loop (still deferred there, to avoid multiplying every
// finding's cost by ddmin's iteration count on the campaign's critical path).
//
// Usage:
//   node tools/fuzz/minimise-live.mjs reports/fuzz/finds/v84-seed783042.js [out.js]
//   node tools/fuzz/minimise-live.mjs <version> <programFile> [out.js]   (legacy)
//
// The first form is the one to use on a campaign find: the version *and the
// fuzz seed* are read out of the find's own filename (`v<version>-seed<seed>.js`,
// the same names `construct-fuzz.mjs` writes and `reclassify-finds.mjs`
// parses). The seed matters — `runOracleLadder`'s differential function
// fuzzing is seeded, so re-running a find under seed 0 (as this tool used to)
// asks a different question than the campaign asked and can lose the very
// signature being minimised.
//
// Reproduction is signature equality against the ORIGINAL program's signature
// at that version and seed (not a fixed string), so it tracks whichever
// DIVERGENT/ERROR shape the find triggers, and the reduced program is
// guaranteed to still carry it.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findHermesc, compileWithHermesc } from "../../src/harness/roundtrip.ts";
import { runOracleLadder } from "../../src/harness/ladder.ts";
import { chooseReference } from "../../src/harness/reference-policy.ts";
import { decompile } from "../../src/decompile.ts";
import { signatureOf, signatureKey } from "../../src/fuzzgen/signature.ts";
import { minimiseAsync } from "../../src/fuzzgen/minimise.ts";

const TRACED_VERSIONS = [84, 94, 96, 99];

/** Parses a campaign find's filename (`v<version>-seed<seed>.js`). Same
 *  grammar as `tools/fuzz/reclassify-finds.mjs`'s discovery loop; returns
 *  null for any other name so the caller can fall back to explicit args. */
export function parseFindName(fileName) {
  const m = /^v(\d+)-seed(\d+)\.js$/.exec(basename(fileName));
  if (m === null) return null;
  return { version: Number(m[1]), seed: Number(m[2]) };
}

/** Compile -> decompile -> oracle ladder for one program at one version and
 *  seed. Returns the ladder verdict and the signature key (null when there is
 *  no signature, i.e. PASS/INCONCLUSIVE). */
export async function runOnce(version, seed, program) {
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
      hbcBytes: compiled.bytes, hbcVersion: version, embeddedFilename: "fuzz.js", matchedCompilerReference: true,
      oracles: isTraced ? ["syntax", "trace", "fuzz"] : ["syntax", "roundtrip"],
      seed, fuzz: 20, timeoutMs: 5000, maxRecords: 5000,
    });
    const sig = signatureOf(result);
    // Capped exactly as `reclassify-finds.mjs` caps it: a signature `context`
    // embeds the raw divergence strings, which for a print-heavy or
    // long-running program can be many MB (docs/BUGS.md 2026-09-03, the
    // campaign driver's `Invalid string length`).
    return { verdict: result.verdict, signature: sig !== null ? signatureKey(sig).slice(0, 300) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(argv) {
  let version, seed, programFile, outFile;
  if (/^\d+$/.test(argv[0] ?? "")) {
    // Legacy form: explicit version, seed defaults to the campaign's own 0.
    version = Number(argv[0]);
    programFile = argv[1];
    outFile = argv[2];
    seed = parseFindName(programFile ?? "")?.seed ?? 0;
  } else {
    programFile = argv[0];
    outFile = argv[1];
    const parsed = parseFindName(programFile ?? "");
    if (parsed === null) {
      console.error("usage: minimise-live.mjs <finds/v<version>-seed<seed>.js> [out.js]   |   minimise-live.mjs <version> <programFile> [out.js]");
      process.exit(2);
    }
    version = parsed.version;
    seed = parsed.seed;
  }

  const program = readFileSync(programFile, "utf8");
  const original = await runOnce(version, seed, program);
  if (original.verdict === "PASS" || original.signature === null) {
    console.error(`input does not reproduce a DIVERGENT/ERROR signature at v${version} seed ${seed} (verdict=${original.verdict})`);
    process.exit(1);
  }
  console.error(`target signature: ${original.signature.slice(0, 48)}... (${original.verdict}, v${version}, seed ${seed})`);

  // In-process, async: `minimiseAsync` awaits the live check directly. The
  // old sync bridge forked a whole `node --experimental-strip-types` process
  // per ddmin candidate, which dominated the runtime and re-imported the
  // decompiler every time.
  let checks = 0;
  const reproduces = async (candidateProgram) => {
    checks++;
    const r = await runOnce(version, seed, candidateProgram);
    return r.signature === original.signature;
  };

  const minimised = await minimiseAsync(program, reproduces);
  const finalCheck = await runOnce(version, seed, minimised);
  console.error(
    `minimised: ${program.split("\n").length} -> ${minimised.split("\n").length} lines in ${checks} live check(s); ` +
      `final verdict=${finalCheck.verdict} sigMatch=${finalCheck.signature === original.signature}`,
  );
  if (outFile) {
    writeFileSync(outFile, minimised);
    console.error(`wrote ${outFile}`);
  } else {
    console.log(minimised);
  }
}

// Importable (the gate tests `parseFindName`) — `main` runs only when this
// file is the entry point.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
