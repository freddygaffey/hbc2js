// tests/artifact/semantic-index.test.ts — P2.1 §8 steps 3–5: calls.jsonl,
// strings.json/string-uses.jsonl, globals.jsonl, native.jsonl. Row-count and
// spot-check assertions (no exact-output/whole-decompile comparisons —
// docs/CONSOLIDATION.md §B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { splitProject } from "../../src/split/index.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { HOST_GLOBALS } from "../../src/artifact/host-globals.ts";

function buildArtifact(bytes: Buffer, moduleName: string) {
  const splitResult = splitProject(bytes, { moduleName });
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-artifact-semantic-"));
  const written = writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
  const jsonl = (f: string) =>
    readFileSync(join(outDir, "index", f), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
  return { outDir, written, jsonl };
}

test("A2-adjacent: 21-iife-closures — a direct closure call resolves to its exact fnIndex", () => {
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", "21-iife-closures", "v96.hbc"));
  const { outDir, jsonl } = buildArtifact(bytes, "21.hbc");
  try {
    const calls = jsonl("calls.jsonl");
    const closureRows = calls.filter((r) => r.kind === "closure");
    assert.ok(closureRows.length > 0, "expected at least one resolved closure call");
    for (const row of closureRows) assert.equal(typeof row.callee, "number");
    // Every `?` row carries a `why` (A1b's rule, re-checked on real output).
    for (const row of calls) if (row.callee === "?") assert.equal(typeof row.why, "string");
    // sorted by (caller, site) — A1d re-checked on real output.
    const keys = calls.map((r: { caller: number; site: number }) => [r.caller, r.site]);
    assert.deepEqual(
      keys,
      [...keys].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("22-nested-closures-counters — a global-scope function call resolves as g:<name>", () => {
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", "22-nested-closures-counters", "v96.hbc"));
  const { outDir, jsonl } = buildArtifact(bytes, "22.hbc");
  try {
    const calls = jsonl("calls.jsonl");
    assert.ok(calls.some((r) => r.callee === "g:makeCounter" && r.kind === "global"));
    assert.ok(calls.some((r) => r.callee === "g:print" && r.kind === "global"));
    const globals = jsonl("globals.jsonl");
    assert.ok(globals.some((r) => r.g === "print" && r.access === "call"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("strings.json / string-uses.jsonl: every string-uses sid exists in strings.json, string-table count matches", () => {
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", "22-nested-closures-counters", "v96.hbc"));
  const splitResult = splitProject(bytes, { moduleName: "22.hbc" });
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-artifact-semantic-"));
  try {
    writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
    const stringsIndex = JSON.parse(readFileSync(join(outDir, "index", "strings.json"), "utf8"));
    assert.equal(stringsIndex.schema, "hbc2js-index/1");
    assert.equal(stringsIndex.kind, "strings");
    assert.ok(Array.isArray(stringsIndex.entries) && stringsIndex.entries.length > 0);
    const sids = new Set(stringsIndex.entries.map((e: { sid: number }) => e.sid));
    const uses = readFileSync(join(outDir, "index", "string-uses.jsonl"), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    assert.ok(uses.length > 0);
    for (const row of uses) assert.ok(sids.has(row.sid), `sid ${row.sid} used but not in strings.json`);
    // "makeCounter" (a literal identifier used as a global call target's
    // name) must appear as a global-name-role use, per the source fixture.
    const names = uses.filter((r) => r.role === "global-name").map((r) => stringsIndex.entries.find((e: { sid: number }) => e.sid === r.sid)?.v);
    assert.ok(names.includes("makeCounter"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("native.jsonl: host-global governance — curated list only ever yields surface:\"host-global\", never a silent promotion", () => {
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", "22-nested-closures-counters", "v96.hbc"));
  const { outDir, jsonl } = buildArtifact(bytes, "22.hbc");
  try {
    const native = jsonl("native.jsonl");
    for (const row of native) {
      if (row.surface === "host-global") assert.ok(HOST_GLOBALS.includes(row.name.replace(/^g:/, "")), `${row.name} promoted to host-global without being in the curated list`);
      if (row.surface === "host-global?") assert.ok(!HOST_GLOBALS.includes(row.name.replace(/^g:/, "")), `${row.name} is curated but marked as a mere candidate`);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("rn-template: require(dependencyMap[i]) edges resolve to m:<depId> and agree with the module graph's own deps", () => {
  const bytes = readFileSync(join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc"));
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-artifact-semantic-"));
  try {
    const written = writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
    const calls = readFileSync(join(outDir, "index", "calls.jsonl"), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    const requireRows = calls.filter((r: { kind: string }) => r.kind === "require");
    assert.ok(requireRows.length > 500, `expected many require edges on rn-template, got ${requireRows.length}`);
    // Spot-check: every m:<id> is a real module id, and the caller factory
    // actually lists that id among its own `deps` (agreement with §2.6).
    const factoryToModule = new Map(splitResult.modules.map((m) => [m.factoryFunctionIndex, m]));
    let checked = 0;
    for (const row of requireRows.slice(0, 50)) {
      const depId = Number(String(row.callee).slice(2));
      const owningModule = factoryToModule.get(row.caller);
      assert.ok(owningModule !== undefined, `require caller fn#${row.caller} is not a module factory`);
      assert.ok(owningModule!.deps.includes(depId), `fn#${row.caller}'s require of module ${depId} is not in its own deps ${JSON.stringify(owningModule!.deps)}`);
      checked++;
    }
    assert.equal(checked, 50);
    // Total row counts, printed for the landing report (not asserted beyond
    // sanity bounds — real-bundle counts are reported, not pinned).
    assert.ok(written.callCount > 10000);
    assert.ok(written.stringCount > 1000);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
