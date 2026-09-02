#!/usr/bin/env node
// tools/fuzz/construct-fuzz.mjs — docs/specs/09-fuzzing.md §1.1/§7 step 2.
//
// One iteration: seed -> generate JS program -> hermesc compile (per
// version) -> decompile -> runOracleLadder -> verdict. Traced versions
// (84/94/96/99) get the full ladder; v98 gets syntax+roundtrip only (§1.3 —
// "roundtrip-only", never blended into traced pass rates). Writes one JSON
// report per run to reports/fuzz/construct-<date>-<runid>.json in the
// fuzz-matrix/1 schema (§4.2). A DIVERGENT/ERROR triggers the minimisation
// hook (§1.4) and is written under gitignored reports/fuzz/finds/ (capped).
//
// Usage:
//   node tools/fuzz/construct-fuzz.mjs --versions 84,94,96,99 --count 20
//        --seed-base 1000 [--eval] [--out reports/fuzz/construct-smoke.json]
//
// --eval switches from the work range [S, S+80000) to the disjoint
// evaluation range [S+900000, S+902000) (§1.5.iv) — an explicit flag, not a
// default, so the held-out range is never touched by accident during tuning.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../../src/fuzzgen/generate.ts";
import { GRAMMAR_VERSION } from "../../src/fuzzgen/grammar.ts";
import { workRange, evalRange, inRange } from "../../src/fuzzgen/seedRange.ts";
import { signatureOf, signatureKey } from "../../src/fuzzgen/signature.ts";
import { findHermesc, compileWithHermesc } from "../../src/harness/roundtrip.ts";
import { runOracleLadder, VERDICT } from "../../src/harness/ladder.ts";
import { chooseReference } from "../../src/harness/reference-policy.ts";
import { decompile } from "../../src/decompile.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const TRACED_VERSIONS = [84, 94, 96, 99];

function parseArgs(argv) {
  const opts = { versions: [84, 94, 96, 99], count: 20, seedBase: 1000, eval: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--versions") opts.versions = argv[++i].split(",").map(Number);
    else if (a === "--count") opts.count = Number(argv[++i]);
    else if (a === "--seed-base") opts.seedBase = Number(argv[++i]);
    else if (a === "--eval") opts.eval = true;
    else if (a === "--out") opts.out = argv[++i];
  }
  return opts;
}

function newCell() {
  return { n: 0, pass: 0, divergent: 0, inconclusive: 0, error: 0, mode: "full-ladder" };
}

async function runOne(version, seed, findsDir, findsCount) {
  const program = generate(seed, GRAMMAR_VERSION);
  const hermesc = findHermesc(version);
  if (hermesc === null) return { verdict: "ERROR", detail: `no hermesc for v${version} (run tools/get-hermesc.sh ${version})` };

  const compiled = compileWithHermesc(hermesc, program, "fuzz.js");
  if (!compiled.ok) return { verdict: "ERROR", detail: `hermesc rejected generated program: ${compiled.error.slice(0, 300)}` };

  let candidateJs;
  try {
    candidateJs = decompile(compiled.bytes, { resolveV98Ambiguity: true, moduleName: `fuzz-${seed}` }).code;
  } catch (e) {
    return { verdict: "ERROR", detail: `decompiler threw: ${e instanceof Error ? e.message : String(e)}`, program };
  }

  const dir = mkdtempSync(join(tmpdir(), "hbc2js-fuzz-"));
  const candidatePath = join(dir, "candidate.js");
  const sourcePath = join(dir, "source.js");
  writeFileSync(candidatePath, candidateJs);
  writeFileSync(sourcePath, program);
  try {
    const fixture = { name: `construct-fuzz-v${version}-${seed}` };
    const reference = chooseReference(fixture, version);
    const isTraced = TRACED_VERSIONS.includes(version);
    // PUSHBACK P-12 (docs/PUSHBACK.md): §1.1/§1.3 describe "the ladder" as
    // syntax+trace+fuzz+roundtrip, but `roundtrip` compares *function count*
    // between the original bytecode and a recompile of the DECOMPILED
    // candidate — and hbc2js's decompiled output always injects its own
    // runtime-helper functions (__hbc_iterBegin et al.) as extra top-level
    // closures that do not exist in the original. src/harness/tiers.ts's
    // `defaultOraclesForTier` already excludes `roundtrip` for a real
    // decompiler on the gate tier for exactly this reason (confirmed here by
    // running it against 07-for-of-iterable, an existing gate-passing
    // fixture: functionCountMismatch 3 vs 8, oracle reports DIVERGENT even
    // though trace equivalence holds). Composing the literal 4-oracle ladder
    // here would flood every traced-version cell with this one pre-existing,
    // non-novel signature and blow the campaign's volume tripwire on a
    // harness limitation, not a construct-fuzzer or decompiler bug. Traced
    // versions therefore run the same oracle set gate's real-decompiler path
    // uses (syntax+trace+fuzz); v98's roundtrip-only lane keeps roundtrip
    // because §1.3 already marks that cell `mode: "roundtrip-only"` and
    // explicitly expects it not to carry traced-rate-grade meaning.
    const result = await runOracleLadder({
      fixture,
      candidateJsPath: candidatePath,
      sourceJsPath: sourcePath,
      reference,
      hbcBytes: compiled.bytes,
      hbcVersion: version,
      embeddedFilename: "fuzz.js",
      oracles: isTraced ? ["syntax", "trace", "fuzz"] : ["syntax", "roundtrip"],
      seed,
      fuzz: 20,
      timeoutMs: 5000,
      maxRecords: 5000,
    });
    if (result.verdict === VERDICT.DIVERGENT || result.verdict === VERDICT.ERROR) {
      const sig = signatureOf(result);
      if (sig !== null && findsCount.n < 200) {
        findsCount.n++;
        try {
          mkdirSync(findsDir, { recursive: true });
          // Hook only, per §7 step 2's scope: src/fuzzgen/minimise.ts's ddmin
          // is wired and unit-tested (T3) against a live `reproduces`
          // callback, but this driver does not yet re-invoke
          // hermesc+decompile+ladder per candidate reduction (that would
          // multiply this call site's cost by the ddmin iteration count) —
          // deferred to a follow-up task (see docs/fuzz/CONSTRUCT-FUZZER.md
          // "Deferred"). The raw failing program is saved verbatim so a
          // human or the follow-up can minimise it offline.
          writeFileSync(join(findsDir, `v${version}-seed${seed}.js`), program);
        } catch {
          // Best-effort: a find write failure must never abort the campaign.
        }
      }
      return { verdict: result.verdict, signature: sig !== null ? signatureKey(sig) : null };
    }
    return { verdict: result.verdict };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const range = opts.eval ? evalRange(opts.seedBase) : workRange(opts.seedBase);
  const findsDir = join(REPO_ROOT, "reports", "fuzz", "finds");
  const findsCount = { n: existsSync(findsDir) ? readdirSync(findsDir).length : 0 };

  const cells = {};
  const signatures = new Set();
  for (const version of opts.versions) {
    const cell = newCell();
    cell.mode = TRACED_VERSIONS.includes(version) ? "full-ladder" : "roundtrip-only";
    for (let i = 0; i < opts.count; i++) {
      const seed = range.start + i;
      if (!inRange(seed, range)) break;
      const r = await runOne(version, seed, findsDir, findsCount);
      cell.n++;
      if (r.verdict === "PASS") cell.pass++;
      else if (r.verdict === "DIVERGENT") {
        cell.divergent++;
        if (r.signature) signatures.add(r.signature);
      } else if (r.verdict === "ERROR") {
        cell.error++;
        if (r.signature) signatures.add(r.signature);
      } else cell.inconclusive++;
    }
    cells[`construct-fuzz@v${version}`] = cell;
  }

  const report = {
    schema: "fuzz-matrix/1",
    component: "construct",
    date: new Date().toISOString(),
    runId: `${opts.seedBase}-${opts.eval ? "eval" : "work"}-${Date.now()}`,
    grammarVersion: GRAMMAR_VERSION,
    seedRanges: opts.versions.map((v) => ({ version: v, kind: range.kind, start: range.start, end: range.end })),
    cells: Object.entries(cells).map(([name, cell]) => ({ name, ...cell })),
    signatures: [...signatures],
  };

  const outPath = opts.out ?? join(REPO_ROOT, "reports", "fuzz", `construct-${new Date().toISOString().slice(0, 10)}-${report.runId}.json`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`wrote ${outPath}`);
  console.log(JSON.stringify(report.cells, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
