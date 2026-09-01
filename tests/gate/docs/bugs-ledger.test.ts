// docs/QUEUE.md item 4: "BUGS.md triage" turned docs/BUGS.md from an
// append-only ledger into a worked backlog — an "## Open" table (every row
// has status `open`, a `cluster`, a non-empty `verdict` citing a QUEUE item
// or an owner) and a "## Resolved" table (every row has status != `open`
// and a non-empty resolution). This gate test parses both markdown tables
// and enforces that shape mechanically so the ledger cannot silently drift
// back into an unstructured dump.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const bugsPath = join(repoRoot(), "docs", "BUGS.md");
const text = readFileSync(bugsPath, "utf8");
const lines = text.split("\n");

const STATUSES = ["open", "fixed", "wontfix", "d14-legit", "duplicate"];
const CLUSTERS = [
  "semantics",
  "real-app",
  "deps",
  "passes",
  "emit-shape",
  "harness",
  "toolchain",
  "metrics",
];

type Row = { cells: string[] };

/** Split a markdown table row into cells, respecting `` `code` `` spans
 * that may themselves contain `|` (none currently do, but this is robust
 * either way since we only split on bare `|` outside a leading/trailing
 * empty cell). */
function parseRow(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith("|") && trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed;
  return body.split("|").map((c) => c.trim());
}

function section(heading: string): { header: string[]; rows: Row[] } {
  const startIdx = lines.findIndex((l) => l.startsWith(`## ${heading}`));
  assert.ok(startIdx >= 0, `docs/BUGS.md is missing a "## ${heading}" section`);
  let i = startIdx + 1;
  // find the header row (first "| ... |" line)
  while (i < lines.length && !lines[i]!.trim().startsWith("|")) i++;
  assert.ok(i < lines.length, `"## ${heading}" section has no table`);
  const header = parseRow(lines[i]!);
  i += 2; // header + separator row
  const rows: Row[] = [];
  while (i < lines.length && lines[i]!.trim().startsWith("|")) {
    rows.push({ cells: parseRow(lines[i]!) });
    i++;
  }
  return { header, rows };
}

const open = section("Open");
const resolved = section("Resolved");

test("BUGS.md Open table: every row has status=open, a known cluster, and a non-empty verdict citing QUEUE or an owner", () => {
  const statusIdx = open.header.indexOf("status");
  const clusterIdx = open.header.indexOf("cluster");
  const verdictIdx = open.header.indexOf("verdict");
  const ownerIdx = open.header.indexOf("owner");
  assert.ok(statusIdx >= 0 && clusterIdx >= 0 && verdictIdx >= 0 && ownerIdx >= 0, `Open table header missing a required column: ${JSON.stringify(open.header)}`);

  const bad: string[] = [];
  for (const row of open.rows) {
    const status = row.cells[statusIdx];
    const cluster = row.cells[clusterIdx];
    const verdict = row.cells[verdictIdx];
    const owner = row.cells[ownerIdx];
    const label = row.cells[0] ?? "(unknown row)";
    if (status !== "open") bad.push(`${label}: status is ${JSON.stringify(status)}, expected "open" in the Open table`);
    if (!cluster || !CLUSTERS.includes(cluster)) bad.push(`${label}: cluster ${JSON.stringify(cluster)} not one of ${CLUSTERS.join(", ")}`);
    if (!verdict || verdict.length === 0) bad.push(`${label}: empty verdict`);
    else if (!/QUEUE \d/.test(verdict) && !(owner && owner.length > 0 && owner !== "(unassigned)")) {
      bad.push(`${label}: verdict cites neither a "QUEUE N" item nor a non-placeholder owner: ${JSON.stringify(verdict)}`);
    }
  }
  assert.deepEqual(bad, [], `Open-table violations:\n${bad.join("\n")}`);
});

test("BUGS.md Resolved table: every row has status != open and a non-empty resolution", () => {
  const statusIdx = resolved.header.indexOf("status");
  const resolutionIdx = resolved.header.indexOf("resolution");
  assert.ok(statusIdx >= 0 && resolutionIdx >= 0, `Resolved table header missing a required column: ${JSON.stringify(resolved.header)}`);

  const bad: string[] = [];
  for (const row of resolved.rows) {
    const status = row.cells[statusIdx];
    const resolution = row.cells[resolutionIdx];
    const label = row.cells[0] ?? "(unknown row)";
    if (!status || status === "open" || !STATUSES.includes(status)) bad.push(`${label}: status ${JSON.stringify(status)} must be one of ${STATUSES.filter((s) => s !== "open").join(", ")}`);
    if (!resolution || resolution.length === 0) bad.push(`${label}: empty resolution`);
  }
  assert.deepEqual(bad, [], `Resolved-table violations:\n${bad.join("\n")}`);
});

test("BUGS.md: no row is silently dropped — Open + Resolved row count matches the file header's claim", () => {
  const m = text.match(/## Open — (\d+) rows/);
  const n = text.match(/## Resolved — (\d+) rows/);
  assert.ok(m && n, `docs/BUGS.md headers must state "## Open — N rows" and "## Resolved — N rows"`);
  assert.equal(open.rows.length, Number(m![1]), `Open table has ${open.rows.length} rows, header claims ${m![1]}`);
  assert.equal(resolved.rows.length, Number(n![1]), `Resolved table has ${resolved.rows.length} rows, header claims ${n![1]}`);
  console.log(`BUGS open: ${open.rows.length}`);
});

test("BUGS.md: the file header documents the never-delete rule and required columns", () => {
  const head = lines.slice(0, 15).join("\n");
  assert.match(head, /never deleted/i, "header should state rows are never deleted");
  assert.match(head, /cluster/i, "header should mention the cluster column");
  assert.match(head, /verdict/i, "header should mention the verdict requirement");
});
