// tests/artifact/cli-help.test.ts — A9 (docs/specs/10-artifact-format.md §7,
// P2.1a(d)): `hbc2js --help` mentions `query`, `name`, and `render`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";

const CLI = join(repoRoot(), "src", "cli.ts");

test("A9 hbc2js --help mentions query, name and render", () => {
  const out = execFileSync("node", [CLI, "--help"], { encoding: "utf8" });
  assert.match(out, /\bhbc2js query\b/);
  assert.match(out, /\bhbc2js name\b/);
  assert.match(out, /\bhbc2js render\b/);
});
