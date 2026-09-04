// tools/fuzz/diff-signatures.mjs — morning-after tooling for a fuzz
// campaign (docs/fuzz/CONSTRUCT-FUZZER.md "Morning after a campaign").
//
// Two modes:
//
//   node tools/fuzz/diff-signatures.mjs <campaign-dir>... [--known FILE] [--out FILE]
//     Reads every `reports/*.json` (schema `fuzz-matrix/1`, produced by
//     `construct-fuzz.mjs` / `campaign-runner.sh`) under each given
//     directory, aggregates per-version pass/divergent/error counts, unions
//     the divergence signature keys across all reports, classifies each as
//     KNOWN (present in the known-signatures file) or NEW, and writes a
//     markdown report. Exit code is always 0 — this is a report, not a gate.
//
//   node tools/fuzz/diff-signatures.mjs --extract <report.md> [--out FILE] [--date YYYY-MM-DD]
//     Parses a retriage-style report's "## Surviving signatures" bullet list
//     (e.g. docs/reports/2026-09-04-finds-retriage-postfix.md) and writes a
//     known-signatures.json file, so tools/fuzz/known-signatures.json can be
//     regenerated from the source-of-truth markdown rather than hand-edited.
//
// Report-shape notes (read from a real campaign-1 JSON, not guessed):
//   - `cells[]` is `{ name: "construct-fuzz@v<version>", n, pass, divergent,
//     inconclusive, error, mode, referenceEngine }` — one cell per version
//     *in that one report/chunk*. `mode` is "full-ladder" (traced version,
//     real Hermes VM reference), "full-ladder-no-vm" (traced version, but no
//     Hermes VM was found for it — the trace/fuzz oracles ran against
//     expected.txt/Node instead, so pass/divergent counts are NOT a
//     VM-cross-check; see docs/reports/2026-09-05-campaign2-v96-vm-rediff.md)
//     or "roundtrip-only" (v98). This diff tool treats `mode` as an opaque
//     label (aggregated into a Set, displayed verbatim) so a new label needs
//     no change here.
//   - `signatures[]` is a flat array of signature-key strings for the WHOLE
//     report (all versions combined) — the schema does NOT link a signature
//     to the cell/version/seed that produced it. So "versions" for a NEW
//     signature below is the union of every report's cell versions in which
//     that signature string appeared — an attribution, not a guarantee.
//   - Finds on disk (`finds/*.js`, named `v<version>-seed<seed>.js`) are
//     likewise NOT linked to a signature by the schema. The "example find"
//     column is therefore a heuristic: the lexicographically-first find
//     file, among the campaign dirs that contain this signature, whose
//     version matches one of the signature's attributed versions. It is
//     labelled `(heuristic)` in the output and MUST NOT be treated as a
//     verified repro for that exact signature — re-minimise to confirm.
//
// Memory: only `reports/*.json` files (small; counts + signature strings)
// are read into memory. `finds/*.js` files are only `readdir`'d for their
// names, never opened — this must scale to thousands of finds and hundreds
// of chunk reports.
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const DEFAULT_KNOWN = join(REPO_ROOT, "tools", "fuzz", "known-signatures.json");

// reclassify-finds.mjs caps signature keys at 300 chars when it writes a
// retriage report (large trace-dump contexts can otherwise run to many KB);
// known-signatures.json is generated from that report, so its keys are
// already <=300 chars. construct-fuzz.mjs's own driver report does NOT cap
// signatures. To compare the two consistently we truncate BOTH sides to the
// same length before matching — two genuinely different long signatures
// that share a >300-char prefix would be misclassified as the same one,
// which is the same approximation the retriage report itself accepts.
const SIG_CAP = 300;
function capSig(s) {
  return s.length > SIG_CAP ? s.slice(0, SIG_CAP) : s;
}

function parseArgs(argv) {
  const opts = { dirs: [], known: DEFAULT_KNOWN, out: null, extract: null, date: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--known") opts.known = argv[++i];
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--extract") opts.extract = argv[++i];
    else if (a === "--date") opts.date = argv[++i];
    else opts.dirs.push(a);
  }
  return opts;
}

// ---------------------------------------------------------------------
// --extract mode: parse a retriage-report markdown's "Surviving
// signatures" bullet list into a known-signatures.json array.
//
// Bullet shape (see docs/reports/2026-09-04-finds-retriage-postfix.md):
//   - `<signature key, possibly multi-line>` — VERDICT, N find(s),
//     version(s) v1,v2,..., example `FILE.js` — <free-text detail>
// ---------------------------------------------------------------------
const BULLET_RE = /^- `([\s\S]*?)`\s*—\s*(\w+),\s*(\d+)\s*find\(s\),\s*version\(s\)\s*([\d,]+),\s*example\s*`([^`]+)`/gm;

export function extractSignatures(markdown, defaultDate) {
  const out = [];
  let m;
  BULLET_RE.lastIndex = 0;
  while ((m = BULLET_RE.exec(markdown)) !== null) {
    const [, key, verdict, count, versions, example] = m;
    out.push({
      key: capSig(key),
      firstSeen: defaultDate,
      verdict,
      count: Number(count),
      versions: versions.split(",").map(Number),
      example,
      status: "open",
    });
  }
  return out;
}

function dateFromFilename(path) {
  const m = /^(\d{4}-\d{2}-\d{2})-/.exec(basename(path));
  return m !== null ? m[1] : new Date().toISOString().slice(0, 10);
}

function runExtract(opts) {
  const md = readFileSync(opts.extract, "utf8");
  const date = opts.date ?? dateFromFilename(opts.extract);
  const entries = extractSignatures(md, date);
  const outPath = opts.out ?? DEFAULT_KNOWN;
  writeFileSync(outPath, JSON.stringify(entries, null, 2) + "\n");
  console.log(`extracted ${entries.length} signature(s) from ${opts.extract} -> ${outPath}`);
  return entries;
}

// ---------------------------------------------------------------------
// diff mode
// ---------------------------------------------------------------------
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Minimal glob expansion for a single `*` segment, in case the shell did
 *  not expand a quoted pattern before we saw it. Real usage relies on shell
 *  globbing (`campaign2-*`); this is a fallback, not the primary path. */
function expandDirArg(arg) {
  if (isDir(arg)) return [arg];
  if (!arg.includes("*")) return [];
  const parent = dirname(arg);
  const pattern = basename(arg);
  if (!isDir(parent)) return [];
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return readdirSync(parent)
    .filter((name) => re.test(name))
    .map((name) => join(parent, name))
    .filter(isDir);
}

function listReportFiles(campaignDir) {
  const reportsDir = join(campaignDir, "reports");
  if (!isDir(reportsDir)) return [];
  return readdirSync(reportsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(reportsDir, f));
}

function listFindNames(campaignDir) {
  const findsDir = join(campaignDir, "finds");
  if (!isDir(findsDir)) return [];
  return readdirSync(findsDir).filter((f) => f.endsWith(".js"));
}

function parseVersionFromCellName(name) {
  const m = /^construct-fuzz@v(\d+)$/.exec(name);
  return m !== null ? Number(m[1]) : null;
}

function parseFindName(name) {
  const m = /^v(\d+)-seed(\d+)\.js$/.exec(name);
  return m !== null ? { version: Number(m[1]), seed: Number(m[2]), name } : null;
}

function loadKnown(path) {
  if (!existsSync(path)) return new Map();
  const arr = JSON.parse(readFileSync(path, "utf8"));
  const map = new Map();
  for (const e of arr) map.set(capSig(e.key), e);
  return map;
}

function newVersionAgg() {
  return { programs: 0, pass: 0, divergent: 0, error: 0, inconclusive: 0, modes: new Set() };
}

function aggregate(campaignDirs) {
  const perVersion = new Map(); // version -> agg
  const sigVersions = new Map(); // sigKey -> Set(version)
  const sigCampaigns = new Map(); // sigKey -> Set(campaignDir)
  let reportCount = 0;
  let programTotal = 0;

  for (const dir of campaignDirs) {
    const findNames = listFindNames(dir);
    const findsByVersion = new Map();
    for (const f of findNames) {
      const parsed = parseFindName(f);
      if (parsed === null) continue;
      if (!findsByVersion.has(parsed.version)) findsByVersion.set(parsed.version, []);
      findsByVersion.get(parsed.version).push(parsed.name);
    }
    for (const list of findsByVersion.values()) list.sort();

    for (const reportPath of listReportFiles(dir)) {
      let report;
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch {
        continue; // a truncated/mid-write report must not abort the whole scan
      }
      if (report.schema !== "fuzz-matrix/1") continue;
      reportCount++;

      const reportVersions = new Set();
      for (const cell of report.cells ?? []) {
        const version = parseVersionFromCellName(cell.name);
        if (version === null) continue;
        reportVersions.add(version);
        if (!perVersion.has(version)) perVersion.set(version, newVersionAgg());
        const agg = perVersion.get(version);
        agg.programs += cell.n ?? 0;
        agg.pass += cell.pass ?? 0;
        agg.divergent += cell.divergent ?? 0;
        agg.error += cell.error ?? 0;
        agg.inconclusive += cell.inconclusive ?? 0;
        if (cell.mode) agg.modes.add(cell.mode);
        programTotal += cell.n ?? 0;
      }

      for (const rawSig of report.signatures ?? []) {
        const sig = capSig(rawSig);
        if (!sigVersions.has(sig)) sigVersions.set(sig, new Set());
        for (const v of reportVersions) sigVersions.get(sig).add(v);
        if (!sigCampaigns.has(sig)) sigCampaigns.set(sig, new Set());
        sigCampaigns.get(sig).add(dir);
      }
    }
  }

  return { perVersion, sigVersions, sigCampaigns, reportCount, programTotal, campaignDirs };
}

function findExample(sigKey, versions, sigCampaigns, findsCache) {
  const campaigns = [...(sigCampaigns.get(sigKey) ?? [])].sort();
  for (const dir of campaigns) {
    if (!findsCache.has(dir)) {
      const byVersion = new Map();
      for (const f of listFindNames(dir)) {
        const parsed = parseFindName(f);
        if (parsed === null) continue;
        if (!byVersion.has(parsed.version)) byVersion.set(parsed.version, []);
        byVersion.get(parsed.version).push(parsed.name);
      }
      for (const list of byVersion.values()) list.sort();
      findsCache.set(dir, byVersion);
    }
    const byVersion = findsCache.get(dir);
    for (const v of [...versions].sort((a, b) => a - b)) {
      const list = byVersion.get(v);
      if (list !== undefined && list.length > 0) return { file: list[0], campaign: dir };
    }
  }
  return null;
}

function renderReport(agg, known, opts) {
  const lines = [];
  lines.push(`# Fuzz signature diff — ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`Campaign dir(s): ${agg.campaignDirs.join(", ") || "(none found)"}`);
  lines.push(`Reports read: ${agg.reportCount}; programs: ${agg.programTotal}.`);
  lines.push("");

  lines.push("## Per-version summary");
  lines.push("");
  lines.push("| version | mode | programs | pass | divergent | error | inconclusive | pass rate |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const version of [...agg.perVersion.keys()].sort((a, b) => a - b)) {
    const a = agg.perVersion.get(version);
    const rate = a.programs > 0 ? ((a.pass / a.programs) * 100).toFixed(1) + "%" : "n/a";
    lines.push(`| v${version} | ${[...a.modes].join(",") || "?"} | ${a.programs} | ${a.pass} | ${a.divergent} | ${a.error} | ${a.inconclusive} | ${rate} |`);
  }
  lines.push("");

  const allSigs = [...agg.sigVersions.keys()];
  const newSigs = [];
  const knownSigsSeen = [];
  for (const sig of allSigs) {
    if (known.has(sig)) knownSigsSeen.push(sig);
    else newSigs.push(sig);
  }

  lines.push(`## NEW signatures (${newSigs.length})`);
  lines.push("");
  if (newSigs.length === 0) {
    lines.push("None — every signature observed this run is already in the known-signatures file.");
  } else {
    const findsCache = new Map();
    for (const sig of newSigs) {
      const versions = [...(agg.sigVersions.get(sig) ?? [])].sort((a, b) => a - b);
      const example = findExample(sig, versions, agg.sigCampaigns, findsCache);
      const exampleStr = example !== null ? `\`${example.file}\` (heuristic, ${basename(example.campaign)})` : "no local find";
      const keyPreview = sig.split("\n")[0].slice(0, 120);
      lines.push(`- \`${keyPreview}${sig.includes("\n") || sig.length > 120 ? "…" : ""}\` — version(s) ${versions.join(",")}, example ${exampleStr}`);
    }
  }
  lines.push("");

  lines.push(`## KNOWN signatures still firing (${knownSigsSeen.length} of ${known.size})`);
  lines.push("");
  if (knownSigsSeen.length === 0) {
    lines.push("None of the known signatures fired in this run.");
  } else {
    for (const sig of knownSigsSeen) {
      const entry = known.get(sig);
      const versions = [...(agg.sigVersions.get(sig) ?? [])].sort((a, b) => a - b);
      const keyPreview = sig.split("\n")[0].slice(0, 100);
      lines.push(`- \`${keyPreview}${sig.includes("\n") || sig.length > 100 ? "…" : ""}\` — first seen ${entry?.firstSeen ?? "?"}, versions this run ${versions.join(",")}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

function runDiff(opts) {
  const dirs = opts.dirs.flatMap(expandDirArg);
  const agg = aggregate(dirs);
  const known = loadKnown(opts.known);
  const report = renderReport(agg, known, opts);
  if (opts.out) {
    writeFileSync(opts.out, report);
    console.log(`wrote ${opts.out}`);
  } else {
    console.log(report);
  }
  return report;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.extract) runExtract(opts);
  else runDiff(opts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
  process.exitCode = 0;
}
