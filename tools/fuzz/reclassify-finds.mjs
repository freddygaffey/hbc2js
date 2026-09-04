// Re-runs every saved fuzz find (`reports/fuzz/finds/*.js`) through
// compile -> decompile -> oracle with the CURRENT harness (post D14
// evidence-based override, docs/BUGS.md 2026-09-02/2026-09-03 rows) and
// reports how many of the 201 campaign finds are false alarms (now PASS)
// vs still-open signatures (still DIVERGENT/ERROR).
//
// Each find file is the fuzz-generated *source* program verbatim (the same
// text `construct-fuzz.mjs`'s `runOne` compiled originally), named
// `v<version>-seed<seed>.js`. Since the program text is saved (not just the
// seed), recompiling it directly reproduces the original run without
// depending on the generator being byte-identical across grammar versions.
//
// Usage: node tools/fuzz/reclassify-finds.mjs [--out path]
import { readdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findHermesc, compileWithHermesc } from "../../src/harness/roundtrip.ts";
import { runOracleLadder, VERDICT } from "../../src/harness/ladder.ts";
import { chooseReference } from "../../src/harness/reference-policy.ts";
import { signatureOf, signatureKey } from "../../src/fuzzgen/signature.ts";
import { decompile } from "../../src/decompile.ts";
import { referenceEngineBanner } from "./reference-mode.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const FINDS_DIR = join(REPO_ROOT, "reports", "fuzz", "finds");
const TRACED_VERSIONS = [84, 94, 96, 99];

function parseArgs(argv) {
  const opts = { out: join(REPO_ROOT, "docs", "reports", "2026-09-03-finds-reclassified.md"), limit: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") opts.out = argv[++i];
    if (argv[i] === "--limit") opts.limit = Number(argv[++i]);
  }
  return opts;
}

async function reclassifyOne(version, seed, program) {
  const hermesc = findHermesc(version);
  if (hermesc === null) return { verdict: "NO-TOOLCHAIN", detail: `no hermesc for v${version}` };

  const compiled = compileWithHermesc(hermesc, program, "fuzz.js");
  if (!compiled.ok) return { verdict: "ERROR", detail: `hermesc rejected saved program: ${compiled.error.slice(0, 200)}` };

  let candidateJs;
  try {
    candidateJs = decompile(compiled.bytes, { resolveV98Ambiguity: true, moduleName: `fuzz-${seed}` }).code;
  } catch (e) {
    return { verdict: "ERROR", detail: `decompiler threw: ${e instanceof Error ? e.message : String(e)}` };
  }

  const dir = mkdtempSync(join(tmpdir(), "hbc2js-reclassify-"));
  const candidatePath = join(dir, "candidate.js");
  const sourcePath = join(dir, "source.js");
  writeFileSync(candidatePath, candidateJs);
  writeFileSync(sourcePath, program);
  try {
    const fixture = { name: `construct-fuzz-v${version}-${seed}` };
    const reference = chooseReference(fixture, version);
    const isTraced = TRACED_VERSIONS.includes(version);
    const result = await runOracleLadder({
      fixture,
      candidateJsPath: candidatePath,
      sourceJsPath: sourcePath,
      reference,
      hbcBytes: compiled.bytes,
      hbcVersion: version,
      embeddedFilename: "fuzz.js",
      // P-14: sourcePath above is always `program`, the exact text
      // compiled into hbcBytes, so the D14 reference run may safely
      // recompile it with a matched sibling hermesc when the VM oracle
      // is source-built (v94/v99).
      matchedCompilerReference: true,
      oracles: isTraced ? ["syntax", "trace", "fuzz"] : ["syntax", "roundtrip"],
      seed,
      fuzz: 20,
      timeoutMs: 5000,
      maxRecords: 5000,
    });
    if (result.verdict === VERDICT.DIVERGENT || result.verdict === VERDICT.ERROR) {
      const sig = signatureOf(result);
      // Cap EACH oracle's detail before joining, not just the joined
      // result: a single trace-comparison "why" string can itself be huge
      // (dumps of long record arrays), and joining several such strings
      // before truncating is exactly the unbounded-string-growth bug
      // BUGS.md's 2026-09-03 campaign-driver row already hit at scale.
      const detail = result.oracles
        .map((o) => (o.detail ?? "").slice(0, 200))
        .filter(Boolean)
        .join(" | ")
        .slice(0, 300);
      // Cap the signature key too: `signatureOf`'s `context` embeds the raw
      // divergence `a`/`b` strings (e.g. full VM-vs-candidate print dumps
      // for a long-running/print-heavy fuzz program), which can be many MB
      // for a single find — the same unbounded-string-growth shape
      // BUGS.md's 2026-09-03 campaign-driver row already named for the
      // driver's own JSON report. Truncating here only affects this
      // report's dedup granularity (two genuinely different huge contexts
      // that share a >300-char prefix would merge), never the underlying
      // verdict.
      const sigKey = (sig !== null ? signatureKey(sig) : `${result.verdict}:no-signature`).slice(0, 300);
      return { verdict: result.verdict, signature: sigKey, detail };
    }
    return { verdict: result.verdict };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = readdirSync(FINDS_DIR).filter((f) => f.endsWith(".js")).sort();

  const byVersion = new Map();
  for (const f of files) {
    const m = /^v(\d+)-seed(\d+)\.js$/.exec(f);
    if (m === null) continue;
    const version = Number(m[1]);
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push({ file: f, seed: Number(m[2]) });
  }
  for (const [, entries] of byVersion) entries.length = Math.min(entries.length, opts.limit);

  const versionRows = [];
  const survivingSignatures = new Map(); // sigKey -> { count, versions:Set, example, verdict }

  for (const [version, entries] of [...byVersion.entries()].sort((a, b) => a[0] - b[0])) {
    // Loud, one-line-per-version banner (docs/reports/2026-09-05-campaign2-v96-vm-rediff.md):
    // a "full-ladder" number is only a VM-cross-check when the engine below
    // is `hermes-vm`; otherwise pass/divergent counts are Node-vs-decompiler,
    // not Hermes-VM-vs-decompiler, and must not be read as the latter.
    const probeReference = chooseReference({ name: "reclassify-probe" }, version);
    console.log(referenceEngineBanner(version, probeReference));
    const hermesc = findHermesc(version);
    if (hermesc === null) {
      versionRows.push({ version, total: entries.length, pass: 0, divergent: 0, error: 0, noToolchain: entries.length, referenceEngine: probeReference.engine });
      continue;
    }
    let pass = 0, divergent = 0, error = 0;
    for (const { file, seed } of entries) {
      const program = readFileSync(join(FINDS_DIR, file), "utf8");
      const r = await reclassifyOne(version, seed, program);
      if (r.verdict === "PASS") pass++;
      else if (r.verdict === "DIVERGENT") {
        divergent++;
        const key = r.signature ?? `DIVERGENT:${file}`;
        if (!survivingSignatures.has(key)) survivingSignatures.set(key, { count: 0, versions: new Set(), example: file, verdict: "DIVERGENT", detail: r.detail });
        const s = survivingSignatures.get(key);
        s.count++;
        s.versions.add(version);
      } else if (r.verdict === "ERROR") {
        error++;
        const key = r.signature ?? `ERROR:${file}`;
        if (!survivingSignatures.has(key)) survivingSignatures.set(key, { count: 0, versions: new Set(), example: file, verdict: "ERROR", detail: r.detail });
        const s = survivingSignatures.get(key);
        s.count++;
        s.versions.add(version);
      } else {
        // INCONCLUSIVE or NO-TOOLCHAIN mid-loop: count as neither pass nor
        // surviving-signature; noted in the row's "other" bucket.
      }
    }
    versionRows.push({ version, total: entries.length, pass, divergent, error, noToolchain: 0, referenceEngine: probeReference.engine });
  }

  const lines = [];
  lines.push("# 2026-09-03 — fuzz campaign finds reclassified (post D14 evidence-based override)");
  lines.push("");
  lines.push(`Re-ran all ${files.length} saved finds (\`reports/fuzz/finds/*.js\`) through compile -> decompile -> \`runOracleLadder\` with the current harness.`);
  lines.push("");
  lines.push("| version | reference engine | total | now PASS (false alarm) | still DIVERGENT | still ERROR | no local toolchain |");
  lines.push("|---|---|---|---|---|---|---|");
  let totalAll = 0, totalPass = 0, totalDiv = 0, totalErr = 0, totalNoTc = 0;
  for (const row of versionRows) {
    lines.push(`| v${row.version} | ${row.referenceEngine} | ${row.total} | ${row.pass} | ${row.divergent} | ${row.error} | ${row.noToolchain} |`);
    totalAll += row.total;
    totalPass += row.pass;
    totalDiv += row.divergent;
    totalErr += row.error;
    totalNoTc += row.noToolchain;
  }
  lines.push(`| **total** |  | **${totalAll}** | **${totalPass}** | **${totalDiv}** | **${totalErr}** | **${totalNoTc}** |`);
  lines.push("");
  lines.push(`Distinct surviving signatures: ${survivingSignatures.size}.`);
  lines.push("");
  lines.push("## Surviving signatures");
  lines.push("");
  if (survivingSignatures.size === 0) {
    lines.push("(none)");
  } else {
    for (const [key, s] of survivingSignatures) {
      lines.push(`- \`${key}\` — ${s.verdict}, ${s.count} find(s), version(s) ${[...s.versions].sort((a, b) => a - b).join(",")}, example \`${s.example}\`${s.detail ? ` — ${s.detail}` : ""}`);
    }
  }
  lines.push("");

  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, lines.join("\n") + "\n");
  console.log(`wrote ${opts.out}`);
  console.log(lines.slice(2, 2 + versionRows.length + 5).join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
