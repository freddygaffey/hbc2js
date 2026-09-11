// docs/specs/28-llm-readability.md section 9.7: the `readability rewrite`
// verb, landing 2. Exercised via child process (spawnSync with an argv array,
// never a shell string). The candidate comes from a file, so nothing here
// touches the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireOracles } from "../../support/tiers.ts";
import { decompile } from "../../../src/decompile.ts";
import { findHermesVm } from "../../../src/harness/hermes-vm.ts";
import { findFunctionSpan } from "../../../src/readability/rewrite.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v84.hbc");

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-cli-rewrite-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function equivalentRewrite(): string {
  const code = decompile(new Uint8Array(readFileSync(HBC))).code;
  const span = findFunctionSpan(code, "_fn0");
  assert.notEqual(span, undefined);
  const text = code.slice(span!.start, span!.end);
  const open = text.indexOf("{");
  return `function _fn0() {\n  return (function () {${text.slice(open + 1, text.lastIndexOf("}"))}}).call(this);\n}`;
}

test("readability rewrite without --fn/--code is a usage error (exit 2)", () => {
  const r = runCli(["readability", "rewrite", HBC]);
  assert.equal(r.status, 2, r.stderr);
});

test("readability rewrite: an equivalent candidate is accepted and written out with its sidecar", (t) => {
  if (findHermesVm(84) === null) {
    const msg = "no Hermes VM for HBC v84; the equiv --hbc oracle cannot run";
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return;
  }
  withTempDir((dir) => {
    const candidate = join(dir, "candidate.js");
    writeFileSync(candidate, equivalentRewrite());
    const sidecar = join(dir, "rewrite.json");
    const outJs = join(dir, "out.js");
    const r = runCli(["readability", "rewrite", HBC, "--fn", "0", "--code", candidate, "--out", sidecar, "--out-js", outJs, "--json"]);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    const summary = JSON.parse(r.stdout) as { verdict: string; accepted: boolean; equiv: { verdict: string; scope: string } | null };
    assert.equal(summary.verdict, "ACCEPTED");
    assert.equal(summary.equiv?.verdict, "PASS");
    assert.equal(summary.equiv?.scope, "function");
    const stored = JSON.parse(readFileSync(sidecar, "utf8")) as { records: { tier: string }[] };
    assert.equal(stored.records[0]?.tier, "suggested", "a CLI-driven rewrite is still only suggested");
    assert.ok(readFileSync(outJs, "utf8").includes("_fn0"), "the accepted render was written");
  });
});

test("readability rewrite: an unparseable candidate is rejected (exit 1) and nothing is written", () => {
  withTempDir((dir) => {
    const candidate = join(dir, "candidate.js");
    writeFileSync(candidate, "function _fn0() { return (; }");
    const outJs = join(dir, "out.js");
    const r = runCli(["readability", "rewrite", HBC, "--fn", "0", "--code", candidate, "--out-js", outJs]);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /REJECTED_PARSE/);
    assert.match(r.stdout, /faithful decompile is unchanged/);
    assert.throws(() => readFileSync(outJs, "utf8"), "a rejected rewrite writes no output");
  });
});
