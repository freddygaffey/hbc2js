// tests/secrets/cli.test.ts — spec 12 §5 CLI: `hbc2js secrets <verb>`.
// `--help` precedent is P2.1a(d) (tests/artifact/cli-help.test.ts): every
// registered command gets one `--help` line. Verb output is asserted for
// SHAPE and the §5 caps (line counts), never an exact-string comparison
// against a shared fixture's decompile (project CLAUDE.md's testing rule) —
// this fixture is private to tests/secrets/**.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { materializeArtifact } from "./support/materialize.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "v94.hbc");

function buildArtifactWithSeededSecrets(): string {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-secrets-cli-"));
  const bytes = readFileSync(FIXTURE_HBC);
  const splitResult = splitProject(bytes, { moduleName: "index.hbc" });
  writeArtifact({ bytes, splitResult, outDir: dir, passes: {}, strictEnv: false, form: "flat" });
  materializeArtifact(undefined, dir);
  return dir;
}

test("hbc2js --help mentions secrets", () => {
  const out = execFileSync("node", [CLI, "--help"], { encoding: "utf8" });
  assert.match(out, /\bhbc2js secrets\b/);
});

test("secrets scan/report/list/show/hosts/paths run end to end on a real (materialized) artifact, within §5's caps", () => {
  const dir = buildArtifactWithSeededSecrets();
  try {
    const scanOut = execFileSync("node", [CLI, "secrets", "scan", "--force", "--artifact", dir], { encoding: "utf8" });
    const scanLines = scanOut.trim().split("\n");
    assert.ok(scanLines.length <= 25, "secrets scan must stay within the §5 <=25 line cap");
    assert.match(scanOut, /\bnew\b.*\bcached\b/);

    const reportOut = execFileSync("node", [CLI, "secrets", "report", "--artifact", dir], { encoding: "utf8" });
    const reportLines = reportOut.trim().split("\n");
    assert.ok(reportLines.length <= 60, "secrets report must stay within the §5 <=60 line cap");
    assert.match(reportOut, /^secrets report/);

    const listOut = execFileSync("node", [CLI, "secrets", "list", "--artifact", dir], { encoding: "utf8" });
    const listLines = listOut.trim().split("\n");
    assert.ok(listLines.length <= 51, "secrets list must stay within the §5 <=50-rows-plus-total cap");
    assert.match(listOut, /^total:\d+$/m);
    const firstIdMatch = /^#(\S+)/m.exec(listOut);
    assert.ok(firstIdMatch, "secrets list must produce at least one finding on the seeded fixture");

    const id = firstIdMatch![1]!;
    const showOut = execFileSync("node", [CLI, "secrets", "show", id, "--artifact", dir], { encoding: "utf8" });
    assert.match(showOut, new RegExp(`finding#${id}`));

    const hostsOut = execFileSync("node", [CLI, "secrets", "hosts", "--artifact", dir], { encoding: "utf8" });
    assert.match(hostsOut, /^total:\d+$/m);

    const pathsOut = execFileSync("node", [CLI, "secrets", "paths", "api.example.com", "--artifact", dir], { encoding: "utf8" });
    assert.match(pathsOut, /^total:\d+$/m);

    // --json round-trips for the machine-readable loop.
    const jsonOut = execFileSync("node", [CLI, "secrets", "list", "--json", "--artifact", dir], { encoding: "utf8" });
    const parsed = JSON.parse(jsonOut) as { rows: unknown[]; total: number };
    assert.ok(Array.isArray(parsed.rows));
    assert.equal(parsed.total, parsed.rows.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets <verb> without --artifact fails usage (E_USAGE), not a crash", () => {
  assert.throws(() => execFileSync("node", [CLI, "secrets", "list"], { encoding: "utf8", stdio: "pipe" }));
});
