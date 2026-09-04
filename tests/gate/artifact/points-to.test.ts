// tests/gate/artifact/points-to.test.ts — acceptance for the `require(N)`
// dynamic-dispatch points-to pass (docs/specs/17-mcp-harness.md §14.4,
// docs/specs/10-artifact-format.md §2.2a, docs/QUEUE.md #3): the RESIDUE
// `who-calls-by-name` (§14.1) leaves — the receiver's identity in the
// `const m = require(depMap[N]); … m.export(…)` convention.
//
// Three layers (CLAUDE.md testing rules — no literal-string compare against a
// shared fixture's decompiled output):
//  - the `62-require-slot-dispatch` construct fixture, read through
//    `resolvePointsToCalls` at every committed bytecode version: EXACT
//    resolved edges, plus the two negatives (an unprovable receiver, and the
//    second module that exports the same name `run`);
//  - the rn-template bundle for the soundness invariants + the merge into
//    `who-calls`/`calls-from`;
//  - CLI / route / MCP pass-through of the `confidence: "points-to"` marker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { splitProject as splitProjectFresh } from "../../../src/split/index.ts";
import { writeArtifact } from "../../../src/artifact/write.ts";
import { ArtifactService } from "../../../src/artifact/service.ts";
import { McpResources } from "../../../src/mcp/resources.ts";
import { resolvePointsToCalls, type PointsToScan } from "../../../src/artifact/points-to.ts";
import { handle, type UiServerCtx } from "../../../src/ui-server/routes.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const VERSIONS = [84, 94, 96, 98, 99] as const;
const FIXTURE = "62-require-slot-dispatch";

function scanFixture(version: number): PointsToScan | null {
  const p = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${version}.hbc`);
  if (!existsSync(p)) return null;
  const sr = splitProjectFresh(readFileSync(p), {});
  return resolvePointsToCalls(sr.module, sr.analysis, sr.modules);
}

/** The fixture's four modules, by the export each one carries. */
function fixtureModules(version: number): { readonly runA: number; readonly runB: number; readonly slotCaller: number; readonly unprovable: number } | null {
  const p = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${version}.hbc`);
  if (!existsSync(p)) return null;
  const sr = splitProjectFresh(readFileSync(p), {});
  const byId = new Map(sr.modules.map((m) => [m.id, m.factoryFunctionIndex]));
  const a = byId.get(0);
  const b = byId.get(1);
  const c = byId.get(2);
  const d = byId.get(3);
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return { runA: a, runB: b, slotCaller: c, unprovable: d };
}

/** Every function index a `Create*Closure` in `hostFn` creates. */
function closuresCreatedIn(version: number, hostFn: number): ReadonlySet<number> {
  const p = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${version}.hbc`);
  const sr = splitProjectFresh(readFileSync(p), {});
  const out = new Set<number>();
  for (const insn of sr.analysis.decoded(hostFn).instructions) {
    if (/^Create(Generator|Async)?Closure(LongIndex)?$/.test(insn.name)) out.add(insn.operands[2]!.value);
  }
  return out;
}

// -- construct fixture: exact edges at every committed version -------------

test("the env-slot `require` receiver resolves to exactly one edge, at every version", () => {
  let versionsChecked = 0;
  for (const v of VERSIONS) {
    const scan = scanFixture(v);
    if (scan === null) continue;
    versionsChecked++;
    assert.equal(scan.rows.length, 1, `v${v}: exactly one call site is provable in this fixture`);
    const row = scan.rows[0]!;
    assert.equal(row.module, 0, `v${v}: the receiver is module 0 (required through dependencyMap[0])`);
    assert.equal(row.name, "run");
    assert.equal(row.confidence, "points-to");
    assert.ok(row.site >= 0, `v${v}: the site is a function-relative pc`);
    assert.ok(scan.resolvedSlots >= 1, `v${v}: the environment slot holding the required module must be proven`);
  }
  assert.ok(versionsChecked >= 2, "at least two committed bytecode versions should be scanned");
});

test("the resolved callee is module 0's `run`, never module 1's same-named `run`", () => {
  let versionsChecked = 0;
  for (const v of VERSIONS) {
    const scan = scanFixture(v);
    const mods = fixtureModules(v);
    if (scan === null || mods === null) continue;
    versionsChecked++;
    const row = scan.rows[0]!;
    // Exact, and independent of how a given hermesc numbers functions: the
    // callee must be a closure module 0's factory CREATES, and must not be
    // one module 1's factory creates (both export the name `run`).
    assert.ok(closuresCreatedIn(v, mods.runA).has(row.callee), `v${v}: callee fn#${row.callee} must be a closure of module 0's factory`);
    assert.ok(!closuresCreatedIn(v, mods.runB).has(row.callee), `v${v}: callee fn#${row.callee} must not be module 1's same-named export`);
  }
  assert.ok(versionsChecked >= 2);
});

test("the caller is the nested closure, not the factory that did the require", () => {
  let versionsChecked = 0;
  for (const v of VERSIONS) {
    const scan = scanFixture(v);
    const mods = fixtureModules(v);
    if (scan === null || mods === null) continue;
    versionsChecked++;
    const row = scan.rows[0]!;
    assert.notEqual(row.caller, mods.slotCaller, `v${v}: the call happens in the closure module 2 exports, not in module 2's factory`);
    assert.ok(closuresCreatedIn(v, mods.slotCaller).has(row.caller), `v${v}: the caller must be the closure module 2's factory creates`);
  }
  assert.ok(versionsChecked >= 2);
});

test("an unprovable receiver (a parameter) yields NO edge at any version", () => {
  let versionsChecked = 0;
  for (const v of VERSIONS) {
    const scan = scanFixture(v);
    const mods = fixtureModules(v);
    if (scan === null || mods === null) continue;
    versionsChecked++;
    // module 3's exported closure does `obj.run(7)` on a parameter: the only
    // other `run` call site in the fixture, and it must contribute nothing.
    const unprovable = closuresCreatedIn(v, mods.unprovable);
    for (const row of scan.rows) assert.ok(!unprovable.has(row.caller), `v${v}: the closure whose receiver is a parameter must contribute no edge`);
    assert.equal(scan.rows.filter((r) => r.module === 1).length, 0, `v${v}: module 1 is never a resolved receiver`);
  }
  assert.ok(versionsChecked >= 2);
});

// -- the real bundle: soundness invariants + the who-calls merge -----------

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-points-to-"));
const written = writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const svc = new ArtifactService(outDir, { hbc: RN_TEMPLATE });
const scan = resolvePointsToCalls(splitResult.module, splitResult.analysis, splitResult.modules);
const sampleRow = scan.rows[0];

test.after(() => rmSync(outDir, { recursive: true, force: true }));

test("every resolved edge on a real bundle names real functions and a real module", () => {
  assert.ok(scan.rows.length > 0, "rn-template's `module.exports = fn` modules are called through require");
  const fnCount = splitResult.module.functions.length;
  const moduleIds = new Set(splitResult.modules.map((m) => m.id));
  for (const row of scan.rows) {
    assert.ok(row.caller >= 0 && row.caller < fnCount, `caller fn#${row.caller} out of range`);
    assert.ok(row.callee >= 0 && row.callee < fnCount, `callee fn#${row.callee} out of range`);
    assert.ok(moduleIds.has(row.module), `module ${row.module} is not a module of this bundle`);
    assert.equal(row.confidence, "points-to");
    assert.ok(row.name.length > 0);
  }
});

test("the pass decodes only factories and proven slot readers, never the whole bundle", () => {
  assert.ok(scan.walked < splitResult.module.functions.length, "a bundle-wide decode would defeat the point");
  assert.ok(scan.rounds <= 4, "the slot fixed point is bounded");
  assert.ok(scan.unresolvedExportCalls <= scan.exportCalls);
});

test("one edge per call site: (caller, site) is unique", () => {
  const seen = new Set<string>();
  for (const row of scan.rows) {
    const key = `${row.caller}:${row.site}`;
    assert.ok(!seen.has(key), `two edges for the same call site ${key}`);
    seen.add(key);
  }
});

test("writeArtifact emits index/calls-resolved.jsonl with a typed header", () => {
  const text = readFileSync(join(outDir, "index", "calls-resolved.jsonl"), "utf8");
  const lines = text.trim().split("\n");
  const header = JSON.parse(lines[0]!) as { kind: string; renderIndependent: boolean };
  assert.equal(header.kind, "calls-resolved");
  assert.equal(header.renderIndependent, true);
  assert.equal(lines.length - 1, written.resolvedCallCount);
  assert.equal(written.resolvedCallCount, scan.rows.length);
});

test("who-calls and calls-from merge the points-to edges, marked and never as direct edges", () => {
  assert.ok(sampleRow !== undefined);
  const callers = svc.whoCalls(sampleRow!.callee, { all: true });
  const marked = callers.rows.filter((e) => e.confidence === "points-to");
  assert.ok(marked.length >= 1, "the resolved caller must appear in who-calls");
  assert.ok(
    marked.some((e) => e.fn === sampleRow!.caller && e.exportName === sampleRow!.name && e.module === sampleRow!.module),
    "the merged row carries the export name and module it was resolved through",
  );
  for (const e of callers.rows) {
    if (e.confidence === undefined) assert.equal(e.exportName, undefined, "a direct calls.jsonl edge must carry no points-to fields");
  }
  const out = svc.callsFrom(sampleRow!.caller, { all: true });
  assert.ok(out.rows.some((e) => e.confidence === "points-to" && e.fn === sampleRow!.callee));
  assert.equal(out.total, out.rows.length);
});

test("an artifact without calls-resolved.jsonl still loads, and serves no points-to edges", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-points-to-old-"));
  try {
    cpSync(outDir, dir, { recursive: true });
    rmSync(join(dir, "index", "calls-resolved.jsonl"));
    const old = new ArtifactService(dir, { hbc: RN_TEMPLATE });
    const callers = old.whoCalls(sampleRow!.callee, { all: true });
    assert.equal(callers.rows.filter((e) => e.confidence === "points-to").length, 0);
    assert.equal(callers.total, svc.whoCalls(sampleRow!.callee, { all: true }).total - scan.rows.filter((r) => r.callee === sampleRow!.callee).length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- CLI / route / MCP pass-through ---------------------------------------
//
// Deliberately over the tiny FIXTURE artifact, not rn-template: its one
// resolved edge makes the assertions exact, and the output stays small.

const fixtureVersion = VERSIONS.find((v) => existsSync(join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${v}.hbc`)))!;
const fixtureHbc = join(repoRoot(), "tests", "fixtures", "constructs", FIXTURE, `v${fixtureVersion}.hbc`);
const fixtureBytes = readFileSync(fixtureHbc);
const fixtureSplit = splitProjectFresh(fixtureBytes, {});
const fixtureDir = mkdtempSync(join(tmpdir(), "hbc2js-points-to-fixture-"));
writeArtifact({ bytes: fixtureBytes, splitResult: fixtureSplit, outDir: fixtureDir, passes: {}, strictEnv: false, form: "flat" });
const fixtureEdge = resolvePointsToCalls(fixtureSplit.module, fixtureSplit.analysis, fixtureSplit.modules).rows[0]!;

test.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

test("CLI `query who-calls --json` carries the marker; the text form prints it", () => {
  const args = [CLI, "query", "who-calls", String(fixtureEdge.callee), "--artifact", fixtureDir];
  const json = JSON.parse(execFileSync("node", [...args, "--json"], { encoding: "utf8" })) as {
    rows: { fn: number | string; confidence?: string; exportName?: string; module?: number }[];
  };
  const row = json.rows.find((r) => r.confidence === "points-to");
  assert.ok(row !== undefined, "the JSON form must expose the points-to edge");
  assert.equal(row!.fn, fixtureEdge.caller);
  assert.equal(row!.exportName, "run");
  assert.equal(row!.module, 0);
  const text = execFileSync("node", args, { encoding: "utf8" });
  assert.match(text, /confidence:points-to via:m:0\.run/);
});

test("route: GET /api/fn/{fn}/callers passes the points-to fields through", async () => {
  const resources = new McpResources(fixtureDir, { hbc: fixtureHbc });
  const ctx = { resources } as unknown as UiServerCtx;
  const res = await handle({ method: "GET", path: `/api/fn/${fixtureEdge.callee}/callers`, body: null, query: {} }, ctx);
  assert.equal(res.status, 200);
  const body = res.json as { rows: { fn: number | string; confidence?: string; exportName?: string; module?: number }[] };
  const row = body.rows.find((r) => r.confidence === "points-to");
  assert.ok(row !== undefined, "the route must not drop the marker");
  assert.equal(row!.exportName, "run");
  assert.equal(row!.module, 0);
});

test("MCP: whoCalls inlines the points-to fields alongside the neighbour metadata", () => {
  const resources = new McpResources(fixtureDir, { hbc: fixtureHbc });
  const rows = resources.whoCalls(fixtureEdge.callee).rows;
  const row = rows.find((r) => r.confidence === "points-to");
  assert.ok(row !== undefined);
  assert.equal(row!.exportName, "run");
  // `name` stays the neighbour FUNCTION's name (or null) — never the export.
  assert.ok(row!.name === null || typeof row!.name === "string");
});

test("the resolved index is render-independent: a second write is byte-identical", () => {
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-points-to-2-"));
  try {
    writeArtifact({ bytes, splitResult, outDir: dir, passes: {}, strictEnv: false, form: "flat" });
    const a = readFileSync(join(outDir, "index", "calls-resolved.jsonl"), "utf8");
    const b = readFileSync(join(dir, "index", "calls-resolved.jsonl"), "utf8");
    assert.equal(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
