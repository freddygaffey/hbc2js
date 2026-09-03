// tests/project/cli-help.test.ts — P2.2 step 5 (docs/specs/11-project-store.md
// §7 step 5, mirroring P2.1a(d)/A9): `hbc2js --help` mentions `hbc2js project`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";

const CLI = join(repoRoot(), "src", "cli.ts");

test("hbc2js --help mentions hbc2js project", () => {
  const out = execFileSync("node", [CLI, "--help"], { encoding: "utf8" });
  assert.match(out, /\bhbc2js project\b/);
});
