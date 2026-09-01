// docs/DECISIONS.md D17i point 1 (ISOLATE) / D19 — src/split turns a Metro
// bundle into a per-module project tree. Structural checks only per this
// milestone's task boundary: file count, `node --check` on every emitted
// file, and require-graph self-consistency. Never runs the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { splitProject } from "../../../src/split/index.ts";
import { nodeCheck } from "../../../src/decompile.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

// Computed once at module scope (~1s) and shared by every test below — a
// fresh call per test would just re-decompile the same 4199-function bundle
// (docs/AGENT-BRIEF.md's token/time hygiene: one full run, many assertions).
const bytes = readFileSync(RN_TEMPLATE);
const result = splitProject(bytes, { moduleName: "index.android.hbc" });

test("--split produces one file per Metro module, plus index.js and MODULES.json", () => {
  // docs/PACKAGE-SIGNATURES.md §5.6 / tests/gate/deps/inventory.test.ts: 435
  // Metro modules in this exact fixture.
  assert.equal(result.modules.length, 435);
  assert.equal(result.files.size, result.modules.length + 2, "one file per module + index.js + MODULES.json");
  assert.ok(result.files.has("index.js"));
  assert.ok(result.files.has("MODULES.json"));
  for (const m of result.modules) {
    assert.ok(result.files.has(m.file), `missing file for module ${m.id}: ${m.file}`);
  }
});

test("--split resolves a real entry module id (the bundle's final __r() call)", () => {
  assert.notEqual(result.entryModuleId, null, result.diagnostics.join("; "));
  assert.ok(result.modules.some((m) => m.id === result.entryModuleId));
});

test("every emitted module_*.js and index.js passes 'node --check'", () => {
  const failures: string[] = [];
  for (const [name, content] of result.files) {
    if (name === "MODULES.json") continue;
    const check = nodeCheck(content);
    if (!check.ok) failures.push(`${name}: ${check.message}`);
  }
  assert.deepEqual(failures, [], `${failures.length} of ${result.files.size - 1} files failed node --check`);
});

test("the require graph is self-consistent: every require()'d module file exists", () => {
  const modulesJson = JSON.parse(result.files.get("MODULES.json")!) as {
    readonly entry: number | null;
    readonly modules: readonly { readonly id: number; readonly file: string; readonly deps: readonly number[] }[];
  };
  const fileById = new Map(modulesJson.modules.map((m) => [m.id, m.file]));
  let checkedEdges = 0;
  for (const m of modulesJson.modules) {
    for (const dep of m.deps) {
      const depFile = fileById.get(dep);
      assert.ok(depFile !== undefined, `module ${m.id} depends on unknown module id ${dep}`);
      assert.ok(result.files.has(depFile!), `module ${m.id} requires ${depFile}, which was not emitted`);
      checkedEdges++;
    }
  }
  assert.ok(checkedEdges > 0, "expected at least one dependency edge in this fixture");
  if (modulesJson.entry !== null) {
    assert.ok(result.files.has(`module_${modulesJson.entry}.js`), "index.js's entry module file must exist");
    assert.match(result.files.get("index.js")!, /require\('\.\/module_\d+\.js'\)/);
  }
});

test("at least some require(depId) call sites were rewritten to a real require('./module_N.js')", () => {
  // Best-effort, top-level-statements-only rewrite (src/split/rewrite.ts) —
  // not every site folds, but on a real app most of the top-of-file imports
  // should.
  const totalDeps = result.modules.reduce((n, m) => n + m.deps.length, 0);
  const totalRewrites = result.modules.reduce((n, m) => n + m.requireRewrites, 0);
  assert.ok(totalRewrites > 0, "expected at least one require() rewrite");
  assert.ok(totalRewrites >= totalDeps * 0.5, `expected most dependency edges to be rewritten to a literal require(): ${totalRewrites}/${totalDeps}`);
});

test("splitProject({ passes: {} }) runs the readability pipeline per module (E2E tier 1 needs both modes)", () => {
  // The default split is the M4 baseline shape (every call is
  // `Reflect.apply(...)`); with the pipeline on, call-shape rewrites most of
  // them, so the passes-on tree must be the same set of modules with fewer
  // Reflect.apply sites — and still syntactically valid.
  const withPasses = splitProject(bytes, { moduleName: "index.android.hbc", passes: {} });
  assert.equal(withPasses.modules.length, result.modules.length);
  assert.deepEqual([...withPasses.files.keys()].sort(), [...result.files.keys()].sort());
  const count = (r: typeof result): number => [...r.files.values()].reduce((n, c) => n + (c.match(/Reflect\.apply\(/g) ?? []).length, 0);
  const before = count(result);
  const after = count(withPasses);
  assert.ok(before > 0, "the default (no passes) split should still be the M4 baseline call shape");
  assert.ok(after < before / 2, `passes-on split should rewrite most Reflect.apply sites: ${after} vs ${before}`);
  for (const m of withPasses.modules.slice(0, 20)) {
    const check = nodeCheck(withPasses.files.get(m.file) ?? "");
    assert.ok(check.ok, `${m.file} (passes on): ${check.ok ? "" : check.message}`);
  }
});
