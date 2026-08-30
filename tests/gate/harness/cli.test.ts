// docs/specs/06-harness.md §8 — CLI surface tests. Per this milestone's task
// boundary, `equiv`/`gate`/`sweep` are additive subcommands of the single
// `hbc2js` CLI (src/cli.ts), not a separate `hbc2js-equiv` binary — see this
// milestone's report for that deviation from spec 06 §8's literal wrapper
// name (which the promotion table itself says "disappears into npm bin
// linking" — the subcommand form achieves the same "no separate wrapper"
// outcome by a different, equally spec-compatible route).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../../support/paths.ts";

const CLI = path.join(repoRoot(), "src", "cli.ts");

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "hbc2js-cli-equiv-test-"));
const write = (name: string, src: string): string => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, src);
  return f;
};

test("hbc2js equiv <a> <b>: EQUIVALENT exits 0", () => {
  const a = write("a1.js", 'print("x");');
  const b = write("b1.js", 'print("x");');
  const r = run(["equiv", a, b]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^EQUIVALENT/);
});

test("hbc2js equiv <a> <b>: DIVERGENT exits 1 and shows context", () => {
  const a = write("a2.js", 'print("x");');
  const b = write("b2.js", 'print("y");');
  const r = run(["equiv", a, b]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^DIVERGENT/);
  assert.match(r.stdout, /- out print "x"/);
  assert.match(r.stdout, /\+ out print "y"/);
});

test("hbc2js equiv --json produces machine-readable output", () => {
  const a = write("a3.js", 'print("x");');
  const b = write("b3.js", 'print("x");');
  const r = run(["equiv", "--json", a, b]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout) as { verdict: string };
  assert.equal(parsed.verdict, "EQUIVALENT");
});

test("hbc2js equiv --hbc with a version this host has no VM for: INCONCLUSIVE (exit 2), never falls back to Node (HA-05)", () => {
  // A file with an HBC-shaped header but a version number nobody builds a VM
  // for. hbcVersion() only reads bytes 8..12, so this is enough to exercise
  // the "no VM" path without needing a real fixture.
  const header = Buffer.alloc(16);
  header.write("\x92\x05\x00\x00\xc3\x9c\r\n", 0, "latin1");
  header.writeUInt32LE(999999, 8);
  const fakeHbc = path.join(TMP, "fake999999.hbc");
  fs.writeFileSync(fakeHbc, header);
  const b = write("b4.js", 'print("x");');
  const r = run(["equiv", "--hbc", fakeHbc, b]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /INCONCLUSIVE/);
  assert.match(r.stdout, /999999/);
});

test("hbc2js equiv normalise: identical .hbc inputs report EQUIVALENT", (t) => {
  const anyHbc = findAnyHbc();
  if (anyHbc === null) {
    t.skip("no fixture .hbc found to normalise");
    return;
  }
  const r = run(["equiv", "normalise", anyHbc, anyHbc]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^EQUIVALENT/);
});

test("hbc2js gate --only restricts the run and prints a summary line", () => {
  const r = run(["gate", "--only", "01-if-else-chain", "--versions", "94"]);
  assert.match(r.stdout, /^gate: \d+ PASS/);
  assert.ok(r.status === 0 || r.status === 1 || r.status === 2);
});

test("hbc2js gate --json --only produces a parseable TierReport", () => {
  const r = run(["gate", "--json", "--only", "01-if-else-chain", "--versions", "94"]);
  const report = JSON.parse(r.stdout) as { tier: string; results: unknown[] };
  assert.equal(report.tier, "gate");
  assert.equal(report.results.length, 1);
});

function findAnyHbc(): string | null {
  const dir = path.join(repoRoot(), "tests", "fixtures", "constructs");
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name, "v94.hbc");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
