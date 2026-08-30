// docs/specs/00-project-skeleton.md §6.3 — CLI exit codes, exercised via child process
// (spawnSync with an argv array, never a shell string — §10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { fixture } from "../../support/fixtures.ts";

const CLI = join(repoRoot(), "src", "cli.ts");

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("--help prints usage and exits 0", () => {
  const r = runCli(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("--version prints a version string and exits 0", () => {
  const r = runCli(["--version"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("no arguments exits 2 (E_USAGE)", () => {
  const r = runCli([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_USAGE/);
});

test("--info on a real fixture prints header/layout/section info and exits 0", () => {
  const bin = fixture("hermes-dec-sample", "hermes-dec-sample").binaries.find((b) => b.version === 98 && b.variant === "")!;
  const r = runCli(["--info", bin.path]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /version:\s+98/);
  assert.match(r.stdout, /layout class:\s+E/);
  assert.match(r.stdout, /opcode table:\s+hbc98-late/);
  assert.match(r.stdout, /functions:\s+8/);
});

test("--info --json emits parseable JSON with the same facts", () => {
  const bin = fixture("hermes-dec-sample", "hermes-dec-sample").binaries.find((b) => b.version === 94 && b.variant === "")!;
  const r = runCli(["--info", bin.path, "--json"]);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.version, 94);
  assert.equal(parsed.layoutClass, "C");
  assert.equal(parsed.opcodeTable, "hbc94");
  assert.equal(parsed.functionCount, 8);
});

test("--info on a well-formed-looking but corrupt file exits 3", () => {
  // A real, layout-plausible v94 file (passes P1/P2) with one string-table entry
  // corrupted to an out-of-range overflow index: layout probing succeeds, but
  // building the string table then fails with E_BAD_STRING_ID (exit 3, not 4 --
  // the failure is a decode error on a well-formed-looking file, not a layout one).
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-cli-test-"));
  try {
    const bin = fixture("hermes-dec-sample", "hermes-dec-sample").binaries.find((b) => b.version === 94 && b.variant === "")!;
    const bytes = bin.bytes().slice();
    const smallStringTableOffset = 0x14c; // docs/specs/01-parser.md §8 T1
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // isUTF16=0, offset=0x7fffff (overflow index way out of range), length=0xFF (overflowed)
    view.setUint32(smallStringTableOffset, (0xff << 24) | (0x7fffff << 1), true);
    const bad = join(dir, "bad.hbc");
    writeFileSync(bad, bytes);
    const r = runCli(["--info", bad]);
    assert.equal(r.status, 3, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /hbc2js: E_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--info on a nonexistent file exits 2 (E_IO)", () => {
  const r = runCli(["--info", "/nonexistent/path/does-not-exist.hbc"]);
  assert.equal(r.status, 2);
});

test("--info --layout=E on a v84 (class B) file fails loudly rather than producing a plausible module", () => {
  const bin = fixture("hermes-dec-sample", "hermes-dec-sample").binaries.find((b) => b.version === 84 && b.variant === "")!;
  const r = runCli(["--info", bin.path, "--layout=E"]);
  assert.notEqual(r.status, 0);
});
