// PL-06: every registered pass's catalogue rows are ✅ in docs/LOWERING-CATALOGUE.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { checkCatalogue, parseCatalogueIndex } from "../../../src/passes/catalogue.ts";
import { REGISTRY } from "../../../src/passes/registry.ts";
import type { Pass } from "../../../src/passes/types.ts";

const catalogue = readFileSync(join(repoRoot(), "docs", "LOWERING-CATALOGUE.md"), "utf8");

test("PL-06: registered passes only implement ✅ catalogue rows", () => {
  const rows = parseCatalogueIndex(catalogue);
  assert.ok(rows.size >= 20, `parsed only ${rows.size} index rows`);
  assert.deepEqual(checkCatalogue(REGISTRY, catalogue), []);
});

test("PL-06: the check fails on a pass whose row is ⛔, single-version, or missing", () => {
  const fake = "## Index\n\n| # | Idiom | Construct(s) | Versions read | Evidence file | Confidence | Notes |\n|---|---|---|---|---|---|---|\n| 1 | ok | a | 94 | x.md | ✅ verified | |\n| 2 | not yet | b | 94 | y.md | ⛔ unmeasured | |\n| 3 | one version | c | 94 | z.md | ✅ single-version | |\n";
  const pass = (name: string, catalogue: number[]): Pass => ({ name, stage: "A", targets: [], catalogue, match: () => null, rewrite: (m) => m.root, check: () => ({ ok: true }) });
  assert.deepEqual(checkCatalogue([pass("good", [1])], fake), []);
  assert.equal(checkCatalogue([pass("bad", [2])], fake).length, 1);
  assert.equal(checkCatalogue([pass("single", [3])], fake).length, 1, "single-version is ⚠️, not ✅ (the catalogue's own key)");
  assert.equal(checkCatalogue([pass("missing", [9])], fake).length, 1);
  assert.equal(checkCatalogue([pass("none", [])], fake).length, 1);
});
