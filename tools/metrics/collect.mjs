// tools/metrics/collect.mjs — the standing METRICS SCOREBOARD collector
// (docs/QUEUE.md "## Now"). Runs in well under 2 minutes: git log/plumbing,
// a handful of doc/registry reads, and one `.mjs` corpus-metric import that
// is already part of the ~1 s gate test (`measureVarNaming` over the
// construct corpus at v94+v99) — NO corpus-wide sweep, NO whole-bundle
// decompile (that is tools/app-metrics.mjs's job, a different, heavier
// per-bundle report; salvage note in the landing commit explains why this
// file is fresh instead).
//
//   node tools/metrics/collect.mjs [--dry-run]
//
// Appends one row per day to docs/reports/metrics/scoreboard.md, keyed by
// date (UTC `YYYY-MM-DD`); re-running on the same day replaces that day's
// row instead of duplicating it, so a landing-time re-run is idempotent.
// `--dry-run` prints the row without writing the file (used by the gate
// test's `node --check`, and useful for manually inspecting a row before it
// lands). See docs/METRICS.md for column definitions and when this runs.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// velocity — commits total + commits landed today (git log, cheap plumbing)
// ---------------------------------------------------------------------------
function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function collectCommits(date) {
  const total = Number(git(["rev-list", "--count", "HEAD"]));
  const dates = git(["log", "--format=%ad", "--date=short"]).split("\n").filter(Boolean);
  const today = dates.filter((d) => d === date).length;
  return { total, today };
}

// ---------------------------------------------------------------------------
// goal proxy — rungs live X/30 (src/passes/registry.ts REGISTRY is the one
// machine-readable pass list; docs/specs/passes/00-LADDER.md's table mixes
// rung-inventory rows with unrelated "recognises -> refuses" rows and is not
// reliably regex-parseable). 30 is the ladder's documented target
// (docs/STATUS.md "X/30 rungs"), not derived — recorded here as a constant.
// ---------------------------------------------------------------------------
const LADDER_TARGET = 30;

async function collectRungs() {
  const { REGISTRY } = await import("../../src/passes/registry.ts");
  const live = REGISTRY.length;
  const optIn = REGISTRY.filter((p) => p.optIn === true).length;
  return { live, target: LADDER_TARGET, optIn };
}

// ---------------------------------------------------------------------------
// truth guard — gate test count (the recorded baseline, not a live run: the
// brief and CLAUDE.md both forbid running the gate inside the collector),
// open/resolved docs/BUGS.md row counts (the file's own "## Open — N rows" /
// "## Resolved — N rows" section headings are the machine-readable source —
// the table body itself has two different historical column shapes and is
// not reliably position-parseable).
// ---------------------------------------------------------------------------
function collectGateBaseline() {
  const raw = JSON.parse(readFileSync(join(ROOT, "docs", "test-count-baseline.json"), "utf8"));
  return raw.gate;
}

function collectBugs() {
  const text = readFileSync(join(ROOT, "docs", "BUGS.md"), "utf8");
  const open = text.match(/^## Open — (\d+) rows/m);
  const resolved = text.match(/^## Resolved — (\d+) rows/m);
  return {
    open: open ? Number(open[1]) : null,
    resolved: resolved ? Number(resolved[1]) : null,
  };
}

// ---------------------------------------------------------------------------
// volume — LOC by category, comment %, cheap line counting (a line is
// "comment" if, trimmed, it starts with `//`, `/*` or `*` — covers line
// comments and the block-comment/JSDoc continuation style this repo uses
// throughout; a rare trailing-code-after-`*/` line miscounts as comment,
// which is the same trade every other cheap counter in this repo makes).
// Excludes generated/vendored: src/tables/generated (generated opcode/
// builtin tables) and tools/hermes-vm (vendored Hermes checkouts).
// ---------------------------------------------------------------------------
const COMMENT_RE = /^\s*(\/\/|\/\*|\*)/;

function walkTsFiles(dir, exclude) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (exclude.some((x) => p.startsWith(x))) continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkTsFiles(p, exclude));
    else if (extname(entry) === ".ts") out.push(p);
  }
  return out;
}

function countLoc(files) {
  let code = 0;
  let comment = 0;
  let blank = 0;
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (const line of lines) {
      if (line.trim() === "") blank++;
      else if (COMMENT_RE.test(line)) comment++;
      else code++;
    }
  }
  return { code, comment, blank, total: code + comment + blank };
}

function collectLoc() {
  const srcFiles = walkTsFiles(join(ROOT, "src"), [join(ROOT, "src", "tables", "generated")]);
  const testFiles = walkTsFiles(join(ROOT, "tests"), []);
  const src = countLoc(srcFiles);
  const tests = countLoc(testFiles);
  const srcCommentPct = src.code + src.comment === 0 ? 0 : (src.comment / (src.code + src.comment)) * 100;
  return { src, tests, srcCommentPct };
}

// ---------------------------------------------------------------------------
// goal proxy — registers-named %. Cheap measurement path already exists:
// `tools/passes-metrics.mjs`'s `measureVarNaming` (imported by
// `tests/gate/passes/var-naming-metrics.test.ts`, ~1 s over v94+v99 base
// construct-corpus variants) is the same method that produced the "3.1%
// over the full matrix / 3.4% at v94+v99 / 4.1% on rn-template" figures
// (docs/specs/passes/07-var-naming.md §8). The rn-template-bundle figure
// needs a full bundle decompile (`measureVarNamingBundle`) — NOT run here
// (out of the "well under 2 minutes, no heavy decompiles" budget); see the
// scoreboard's own TODO note for that column.
// ---------------------------------------------------------------------------
async function collectRegistersNamed() {
  const { measureVarNaming } = await import("../passes-metrics.mjs");
  const result = measureVarNaming([94, 99], [""]);
  return { namedPct: result.namedPct, registerCount: result.registerCount, scope: "construct corpus, v94+v99 base" };
}

// ---------------------------------------------------------------------------
// process — tokens-per-landed-item. docs/AGENT-LOG.md rows that carry a
// token count spell it "<N>k / <M> calls" (e.g. "Sonnet lean, 269k / 154
// calls, green") — every such occurrence in the file, not just the tail, so
// the median is over the whole logged history to date.
// ---------------------------------------------------------------------------
function collectTokens() {
  const text = readFileSync(join(ROOT, "docs", "AGENT-LOG.md"), "utf8");
  const re = /(\d+)k\s*\/\s*\d+\s*calls/g;
  const values = [];
  let m;
  while ((m = re.exec(text)) !== null) values.push(Number(m[1]));
  if (values.length === 0) return { count: 0, medianK: null, outliers: [] };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianK = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const outliers = values.filter((v) => v > 4 * medianK);
  return { count: values.length, medianK, outliers };
}

// ---------------------------------------------------------------------------
// assembly + markdown
// ---------------------------------------------------------------------------
export async function collect(date = todayUTC()) {
  const commits = collectCommits(date);
  const rungs = await collectRungs();
  const gate = collectGateBaseline();
  const bugs = collectBugs();
  const loc = collectLoc();
  const registersNamed = await collectRegistersNamed();
  const tokens = collectTokens();
  return { date, commits, rungs, gate, bugs, loc, registersNamed, tokens };
}

const COLUMNS = [
  "date",
  "commits total",
  "commits today",
  "rungs live/target",
  "gate tests (baseline)",
  "BUGS open",
  "BUGS resolved",
  "src code LOC",
  "src comment %",
  "tests LOC",
  "registers-named %",
  "tokens/item median (k)",
  "trace-oracle DIVERGENT",
  "corpus pass matrix",
];

function rowToMarkdown(r) {
  const cells = [
    r.date,
    String(r.commits.total),
    String(r.commits.today),
    `${r.rungs.live}/${r.rungs.target} (${r.rungs.optIn} opt-in)`,
    String(r.gate),
    r.bugs.open === null ? "n/a" : String(r.bugs.open),
    r.bugs.resolved === null ? "n/a" : String(r.bugs.resolved),
    String(r.loc.src.code),
    `${r.loc.srcCommentPct.toFixed(1)}%`,
    String(r.loc.tests.total - r.loc.tests.blank),
    `${r.registersNamed.namedPct.toFixed(1)}%`,
    r.tokens.medianK === null ? "n/a" : String(r.tokens.medianK),
    "n/a",
    "n/a",
  ];
  return `| ${cells.join(" | ")} |`;
}

function outliersLine(r) {
  if (r.tokens.outliers.length === 0) return "";
  return `\n\n_${r.date} outliers (>4x median tokens/item, ${r.tokens.medianK}k): ${r.tokens.outliers.map((v) => `${v}k`).join(", ")}_`;
}

const HEADER = [
  "# Metrics scoreboard",
  "",
  "Append-only, one row per day, produced by `node tools/metrics/collect.mjs` at landing time.",
  "See `docs/METRICS.md` for column definitions and TODOs on the `n/a` columns",
  "(trace-oracle DIVERGENT count and corpus pass-matrix — reserved, wait on the fuzzing lane;",
  "registers-named % here is the construct-corpus figure, not the heavier rn-template-bundle figure).",
  "",
  `| ${COLUMNS.join(" | ")} |`,
  `| ${COLUMNS.map(() => "---").join(" | ")} |`,
].join("\n");

function upsertRow(existingText, row, date) {
  if (existingText === null) {
    return `${HEADER}\n${rowToMarkdown(row)}${outliersLine(row)}\n`;
  }
  const lines = existingText.split("\n");
  const rowPrefix = `| ${date} |`;
  const idx = lines.findIndex((l) => l.startsWith(rowPrefix));
  const newLine = rowToMarkdown(row);
  if (idx === -1) {
    // Insert after the last existing table row (a line starting with "| ").
    let lastRowIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("| ") && !lines[i].startsWith("| ---")) lastRowIdx = i;
    }
    if (lastRowIdx === -1) {
      lines.push(newLine);
    } else {
      lines.splice(lastRowIdx + 1, 0, newLine);
    }
  } else {
    lines[idx] = newLine;
  }
  let out = lines.join("\n");
  const outliers = outliersLine(row);
  if (outliers !== "" && !out.includes(outliers.trim())) out += outliers;
  return out.endsWith("\n") ? out : out + "\n";
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const row = await collect();
  const outPath = join(ROOT, "docs", "reports", "metrics", "scoreboard.md");
  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  const next = upsertRow(existing, row, row.date);
  if (dryRun) {
    console.log(rowToMarkdown(row));
  } else {
    writeFileSync(outPath, next, "utf8");
    console.log(`wrote ${outPath}`);
    console.log(rowToMarkdown(row));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`metrics collect: ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  });
}
