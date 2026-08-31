// docs/DECISIONS.md D17i point 1 — `hbc2js <bundle.hbc> --split <outdir>` CLI
// wiring, exercised via child process (matches tests/gate/cli/deps.test.ts's
// own convention). The real per-module split behaviour on a full Metro
// bundle is tests/gate/split/split.test.ts's job (in-process, cheaper); this
// only proves the flag is wired end-to-end, on a small non-Metro fixture so
// it stays fast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const SMALL_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "02-while-loop", "v94.hbc");

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("--split writes index.js + MODULES.json to the given outdir and exits 0", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-split-cli-"));
  try {
    const r = runCli([SMALL_HBC, "--split", outDir]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wrote \d+ module file\(s\)/);
    assert.ok(existsSync(join(outDir, "index.js")));
    assert.ok(existsSync(join(outDir, "MODULES.json")));
    const modulesJson = JSON.parse(readFileSync(join(outDir, "MODULES.json"), "utf8")) as { readonly moduleCount: number };
    // 02-while-loop is a plain construct fixture, not a Metro bundle — zero
    // __d() registrations is the correct, structural answer, not an error.
    assert.equal(modulesJson.moduleCount, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
