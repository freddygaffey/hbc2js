// tests/sweep/test262/corpus.test.ts — T2: the curated test262 subset stays
// runnable. This is a regression check on the committed corpus, not the
// harvester itself (that's tools/test262-harvest.mjs, run by hand when the
// curated selection changes — see its header comment).
//
// Every kept file in manifest.json is re-run through the same vm.Script /
// vm.createContext semantics the harvester used to prune divergent tests
// (see support/run-case.mjs for why: neither a plain `node file.js` — this
// repo is "type": "module" — nor a plain `node file.cjs` reproduces test262's
// Script-goal `this`/var-hoisting semantics). A file that no longer matches
// its frontmatter's expectation here means either the corpus or the runner
// drifted since harvest time, and this test fails loudly rather than
// silently degrading the corpus's value as a fixture source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { requireSweep } from "../../support/tiers.ts";
import { repoRoot } from "../../support/paths.ts";
import { runCase, matchesExpectation } from "./support/run-case.mjs";

test("T2: the harvested test262 corpus runs and matches its recorded expectation", (t) => {
  if (!requireSweep(t)) return;
  const root = repoRoot();
  const manifestPath = join(root, "tests", "sweep", "test262", "manifest.json");
  const { manifest } = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    manifest: ReadonlyArray<{
      readonly excluded?: string;
      readonly outFile?: string;
      readonly negative: { readonly phase: string; readonly type: string } | null;
      readonly sourcePath: string;
    }>;
  };

  const runnable = manifest.filter((e) => e.excluded === undefined);
  assert.ok(runnable.length > 150, `expected >150 harvested test262 cases, found ${runnable.length}`);

  let pass = 0;
  const failures: string[] = [];
  for (const entry of runnable) {
    const source = readFileSync(join(root, entry.outFile!), "utf8");
    const result = runCase(source);
    if (matchesExpectation(entry.negative, result)) {
      pass++;
    } else {
      failures.push(`${entry.sourcePath} (${entry.outFile}): expected ${JSON.stringify(entry.negative)}, got ${result.phase}/${result.errorName ?? "-"}`);
    }
  }

  assert.equal(failures.length, 0, `${failures.length}/${runnable.length} test262 cases no longer match their expectation:\n${failures.slice(0, 10).join("\n")}`);
  assert.equal(pass, runnable.length);
});

test("T2: excluded (module/async) and divergent-dropped counts are recorded and sane", (t) => {
  if (!requireSweep(t)) return;
  const root = repoRoot();
  const manifestPath = join(root, "tests", "sweep", "test262", "manifest.json");
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    manifest: ReadonlyArray<{ readonly excluded?: string }>;
    divergentFromNode: ReadonlyArray<unknown>;
  };
  const excludedModule = parsed.manifest.filter((e) => e.excluded === "module").length;
  const excludedAsync = parsed.manifest.filter((e) => e.excluded === "async").length;
  // Both classes are excluded by design (see tools/test262-harvest.mjs's
  // header) — this just confirms the exclusion actually fired at least once
  // rather than silently matching nothing, and that the divergence-prune
  // list is small relative to the corpus (a large fraction would mean the
  // runner, not test262, is wrong).
  assert.ok(excludedModule > 0, "expected at least one module-flagged test to be excluded");
  assert.ok(excludedAsync > 0, "expected at least one async-flagged test to be excluded");
  assert.ok(parsed.divergentFromNode.length < 10, `unexpectedly many Node-vs-spec divergences dropped: ${parsed.divergentFromNode.length}`);
});
