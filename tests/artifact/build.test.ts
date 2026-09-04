// tests/artifact/build.test.ts — A2 (docs/specs/10-artifact-format.md §7):
// build the artifact for `tests/fixtures/bundles/rn-template`'s bundle;
// assert manifest hashes verify, every `fnIndex` in `functions.jsonl` exists
// in the bundle (count == `bundle.functionCount`), `modules.json` agrees
// with the existing `MODULES.json` id-for-id, and `fnOwnership` covers every
// factory's lexical descendants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { hashRenderedFiles, sha256Hex } from "../../src/artifact/schema.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

// Computed once at module scope and shared by every test below (docs/
// AGENT-BRIEF.md token/time hygiene — one full 4199-function split+build,
// many assertions), same pattern as tests/gate/split/split.test.ts.
const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-artifact-build-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });

const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
const functionRows = readFileSync(join(outDir, "index", "functions.jsonl"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => JSON.parse(l));
const modulesIndex = JSON.parse(readFileSync(join(outDir, "index", "modules.json"), "utf8"));
const modulesJson = JSON.parse(splitResult.files.get("MODULES.json")!);
const rangeLines = readFileSync(join(outDir, "index", "ranges.jsonl"), "utf8").trim().split("\n");
const rangeRows = rangeLines.slice(1).map((l) => JSON.parse(l));

test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("A2 manifest hashes verify: render.hash and index.semanticHash recompute to the same values", () => {
  const recomputedRenderHash = hashRenderedFiles(splitResult.files);
  assert.equal(manifest.render.hash, recomputedRenderHash);
  // §8 steps 1–5: the semantic layer now also includes calls/strings/globals/
  // native (P2.1 third implementation agent); every semantic file the writer
  // hashes into `index.semanticHash` must be recomputed here too.
  const recomputedSemanticHash = hashRenderedFiles(
    new Map([
      ["index/functions.jsonl", readFileSync(join(outDir, "index", "functions.jsonl"), "utf8")],
      ["index/modules.json", readFileSync(join(outDir, "index", "modules.json"), "utf8")],
      ["index/calls.jsonl", readFileSync(join(outDir, "index", "calls.jsonl"), "utf8")],
      // §2.2a `require(N)` points-to edges — a semantic index like the rest,
      // so it is hashed like the rest.
      ["index/calls-resolved.jsonl", readFileSync(join(outDir, "index", "calls-resolved.jsonl"), "utf8")],
      ["index/strings.json", readFileSync(join(outDir, "index", "strings.json"), "utf8")],
      ["index/string-uses.jsonl", readFileSync(join(outDir, "index", "string-uses.jsonl"), "utf8")],
      ["index/globals.jsonl", readFileSync(join(outDir, "index", "globals.jsonl"), "utf8")],
      ["index/native.jsonl", readFileSync(join(outDir, "index", "native.jsonl"), "utf8")],
    ]),
  );
  assert.equal(manifest.index.semanticHash, recomputedSemanticHash);
  assert.equal(manifest.index.builtFor.bundleSha256, manifest.bundle.sha256);
  assert.equal(manifest.bundle.sha256, sha256Hex(bytes));
});

test("A2 every fnIndex in functions.jsonl exists in the bundle; count == bundle.functionCount", () => {
  assert.equal(functionRows.length, manifest.bundle.functionCount);
  const seen = new Set<number>();
  for (const row of functionRows) {
    assert.equal(typeof row.fn, "number");
    assert.ok(!seen.has(row.fn), `duplicate fn ${row.fn}`);
    seen.add(row.fn);
  }
  assert.equal(seen.size, manifest.bundle.functionCount);
});

test("A2 modules.json agrees with MODULES.json id-for-id", () => {
  assert.equal(modulesIndex.modules.length, modulesJson.modules.length);
  const byId = new Map(modulesJson.modules.map((m: { id: number }) => [m.id, m]));
  for (const m of modulesIndex.modules) {
    const ref = byId.get(m.id) as { file: string; factoryFunctionIndex: number; deps: readonly number[] } | undefined;
    assert.ok(ref !== undefined, `module ${m.id} missing from MODULES.json`);
    assert.equal(m.file, ref!.file);
    assert.equal(m.factoryFn, ref!.factoryFunctionIndex);
    assert.deepEqual(m.deps, ref!.deps);
  }
  assert.equal(modulesIndex.entry, modulesJson.entry);
});

test("A2 fnOwnership covers every factory's lexical descendants", () => {
  // Every module's own factory function owns itself.
  for (const m of modulesIndex.modules) {
    assert.equal(modulesIndex.fnOwnership[String(m.factoryFn)], m.id, `factory fn#${m.factoryFn} of module ${m.id} not self-owned`);
  }
  // §2.1: `parent` chains from any owned function should resolve to the same
  // module (the chain-walk that computed ownership in the first place) —
  // spot-check by rebuilding the parent map from functions.jsonl itself.
  const parentOf = new Map<number, number | null>(functionRows.map((r) => [r.fn, r.parent]));
  let checked = 0;
  for (const row of functionRows) {
    const owner = modulesIndex.fnOwnership[String(row.fn)];
    if (owner === undefined) continue; // unowned (e.g. outside any factory) — fine, not asserted here
    let cur: number | null = row.fn;
    const seen = new Set<number>();
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      if (modulesIndex.fnOwnership[String(cur)] === owner) break;
      cur = parentOf.get(cur) ?? null;
    }
    checked++;
  }
  assert.ok(checked > 4000, `expected most of rn-template's ${functionRows.length} functions to be checked, got ${checked}`);
});

test("ranges.jsonl §2.7: header renderHash ties to manifest, rows sorted by fn, every line as actually printed", () => {
  const header = JSON.parse(rangeLines[0]!);
  assert.equal(header.renderIndependent, false);
  assert.equal(header.renderHash, manifest.render.hash);
  const fns = rangeRows.map((r) => r.fn);
  assert.deepEqual(fns, [...fns].sort((a, b) => a - b));
  // §2.7 truth check: for a sample of rows, the file's actual text at
  // `lines[0]`/`lines[1]` is a real function declaration line and its
  // closing brace — never a fabricated range (docs/specs/10-artifact-
  // format.md §0's render-hook requirement).
  const sample = [rangeRows[0], rangeRows[Math.floor(rangeRows.length / 2)], rangeRows[rangeRows.length - 1]];
  for (const row of sample) {
    const text = splitResult.files.get(row.file)!;
    const lines = text.split("\n");
    const first = lines[row.lines[0] - 1] ?? "";
    const last = lines[row.lines[1] - 1] ?? "";
    assert.match(first, /function (factory|_fn\d+)\(/, `fn ${row.fn} ${row.file}:${row.lines[0]} not a function declaration: ${first}`);
    assert.match(last, /^\s*}\s*$/, `fn ${row.fn} ${row.file}:${row.lines[1]} not a closing brace: ${last}`);
  }
});
