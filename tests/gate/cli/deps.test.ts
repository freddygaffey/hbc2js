// docs/DECISIONS.md D17a/D17b — `hbc2js deps` CLI, exercised via child
// process (matches tests/gate/cli/cli.test.ts's own convention).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("deps --help prints usage and exits 0", () => {
  const r = runCli(["deps", "--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test("deps with no input exits 2", () => {
  const r = runCli(["deps"]);
  assert.equal(r.status, 2);
});

test("deps --offline on rn-template-0.72: text report finds react + react-native, not lodash", () => {
  const r = runCli(["deps", RN_TEMPLATE, "--offline"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /confirmed dependencies/);
  assert.match(r.stdout, /react-native@0\.72\.17/);
  assert.match(r.stdout, /react@18\.2\.0/);
  // lodash may appear only under "guessed / unconfirmed", never as a
  // confirmed dependency line.
  const confirmedSection = r.stdout.split("== guessed")[0]!;
  assert.doesNotMatch(confirmedSection, /lodash/);
});

test("deps --offline --json on rn-template-0.72: machine-readable report shape", () => {
  const r = runCli(["deps", RN_TEMPLATE, "--offline", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout) as {
    hbcVersion: number;
    confirmedDeps: { package: string; version: string }[];
    reactNativeVersion: string | null;
    attribution: { percentAttributed: number };
  };
  assert.equal(report.hbcVersion, 94);
  assert.equal(report.reactNativeVersion, "0.72.17");
  const names = report.confirmedDeps.map((d) => d.package);
  assert.ok(names.includes("react-native"));
  assert.ok(names.includes("react"));
  assert.ok(!names.includes("lodash"));
  assert.ok(report.attribution.percentAttributed > 90);
});

test("deps --offline --out <dir> writes package.json with confirmed dependencies", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-deps-cli-out-"));
  try {
    const r = runCli(["deps", RN_TEMPLATE, "--offline", "--out", outDir]);
    assert.equal(r.status, 0, r.stderr);
    const pkgJson = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    assert.equal(pkgJson.dependencies["react-native"], "0.72.17");
    assert.equal(pkgJson.dependencies["react"], "18.2.0");
    assert.ok(!("lodash" in pkgJson.dependencies));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("deps on a nonexistent file exits non-zero with a JSON error under --json", () => {
  const r = runCli(["deps", "/nonexistent/does-not-exist.hbc", "--offline", "--json"]);
  assert.notEqual(r.status, 0);
  const parsed = JSON.parse(r.stdout) as { error: string };
  assert.ok(parsed.error.length > 0);
});
