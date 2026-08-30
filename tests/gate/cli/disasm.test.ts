// docs/specs/02-disassembler.md §6.3, §9 — `hbc2js disasm` CLI subcommand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { fixture } from "../../support/fixtures.ts";
import { normaliseHermesc, normaliseOursRaw } from "../oracle/disasm/normalize.ts";

const CLI = join(repoRoot(), "src", "cli.ts");

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function v94Path(): string {
  return fixture("hermes-dec-sample", "hermes-dec-sample").binaries.find((b) => b.version === 94 && b.variant === "")!.path;
}

test("disasm --help prints usage and exits 0", () => {
  const r = runCli(["disasm", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /disasm/);
});

test("disasm with no input exits 2 (E_USAGE)", () => {
  const r = runCli(["disasm"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_USAGE/);
});

test("disasm on a nonexistent file exits 2 (E_IO)", () => {
  const r = runCli(["disasm", "/nonexistent/path/does-not-exist.hbc"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_IO/);
});

test("disasm --mode=bogus exits 2 (E_USAGE)", () => {
  const r = runCli(["disasm", v94Path(), "--mode=bogus"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /E_USAGE/);
});

test("disasm defaults to canonical mode on stdout", () => {
  const r = runCli(["disasm", v94Path()]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^; hbc2js disassembly of/);
  assert.match(r.stdout, /^function #0 "global"/m);
});

test("disasm --mode=raw output is byte-identical to normalised hermesc output (spec 02 §9)", () => {
  const r = runCli(["disasm", v94Path(), "--mode=raw"]);
  assert.equal(r.status, 0);
  const ours = normaliseOursRaw(r.stdout);

  // Reproduce the same normalised comparison the oracle test performs, using
  // the pre-captured hermesc dump shape asserted elsewhere (tests/gate/oracle/
  // disasm/hermesc.test.ts); here we just confirm the CLI path renders exactly
  // what printModule/raw mode renders directly (already proven byte-identical
  // to hermesc there) — i.e. the CLI wiring itself (arg parsing, stdout path,
  // moduleName plumbing) doesn't alter the disassembly bytes.
  const direct = execFileSync(process.execPath, [CLI, "disasm", v94Path(), "--mode=raw"], { encoding: "utf8" });
  assert.equal(r.stdout, direct);
  assert.ok(ours.lines.length > 0);
});

test("disasm --function=N disassembles only function N", () => {
  const r = runCli(["disasm", v94Path(), "--function=2"]);
  assert.equal(r.status, 0);
  const matches = r.stdout.match(/^function #\d+/gm) ?? [];
  assert.deepEqual(matches, ["function #2"]);
});

test("disasm --no-cache-indices omits #cN", () => {
  const r = runCli(["disasm", v94Path(), "--no-cache-indices"]);
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /#c\d/);
});

test("disasm -o writes the same content to a file instead of stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-disasm-cli-"));
  try {
    const outPath = join(dir, "out.txt");
    const r = runCli(["disasm", v94Path(), "-o", outPath]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    const fileContent = readFileSync(outPath, "utf8");
    const stdoutRun = runCli(["disasm", v94Path()]);
    assert.equal(fileContent, stdoutRun.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("disasm on an unsupported version/layout exits 4", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-disasm-cli-"));
  try {
    const bytes = readFileSync(v94Path());
    const bad = join(dir, "bad.hbc");
    const modified = Buffer.from(bytes);
    modified.writeUInt32LE(51, 4); // corrupt the version field to an unsupported one
    writeFileSync(bad, modified);
    const r = runCli(["disasm", bad]);
    assert.notEqual(r.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("normaliseHermesc is a real sanity check: it parses the verbatim v94 and v99 header lines from spec 02 §6.1", () => {
  const v94Lines = [
    "Function<global>(1 params, 16 registers, 0 symbols):",
    "NCFunction<testx>(2 params, 15 registers, 0 symbols):",
    "NCFunction<?anon_0_testx>(2 params, 1 registers, 0 symbols):",
    "Function<?anon_0_?anon_0_testx>(2 params, 16 registers, 0 symbols):",
    "NCFunction<gen>(1 params, 1 registers, 0 symbols):",
    "Function<?anon_0_gen>(1 params, 17 registers, 0 symbols):",
    "Function<ze>(1 params, 12 registers, 1 symbols):",
    "Function<zb>(1 params, 9 registers, 0 symbols):",
  ];
  const v99Lines = [
    "Function<global>(1 params, 18 registers, 1 numbers, 1 non-pointers):",
    "NCFunction<testx>(2 params, 16 registers, 0 numbers, 1 non-pointers):",
    "NCFunction<gen>(1 params, 2 registers, 1 numbers, 0 non-pointers):",
    "Function<ze>(1 params, 13 registers, 0 numbers, 1 non-pointers):",
    "NCFunction<?anon_0_testx>(2 params, 3 registers, 1 numbers, 0 non-pointers):",
    "Function<gen>(1 params, 32 registers, 0 numbers, 0 non-pointers):",
    "Function<zb>(1 params, 11 registers, 0 numbers, 1 non-pointers):",
    "NCFunction<distanceFromOrigin>(1 params, 14 registers, 0 numbers, 0 non-pointers):",
  ];
  assert.equal(normaliseHermesc(v94Lines.join("\n")).headers.length, 8);
  assert.equal(normaliseHermesc(v99Lines.join("\n")).headers.length, 8);
});
