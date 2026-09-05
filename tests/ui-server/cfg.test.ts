// tests/ui-server/cfg.test.ts — acceptance for docs/specs/26-ui-full-ide.md
// L9 (`GET /api/fn/{fn}/cfg`), the server half of spec 25 §3 mode 3.
//
// Same two-kinds-of-check shape as `tests/ui-server/screens.test.ts`:
//  * INVARIANTS over the real rn-template-0.72 fixture — whatever that
//    bundle happens to contain, the answer must be internally consistent
//    with itself and with `src/cfg`'s own block graph (no literal-output
//    assertions on a shared fixture, docs/CONSOLIDATION.md §B).
//  * The cap and dangling-edge RULES on synthetic input through the pure
//    core (`buildCfgResult`), because "capped with an honest truncation
//    field" must hold for a graph no committed fixture has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "../../src/projdb/db.ts";
import { initProjectDb } from "../../src/projdb/ix-write.ts";
import { buildIndexRows } from "../../src/artifact/index-rows.ts";
import { writeSplitResult } from "../../src/split/write.ts";
import { McpContext } from "../../src/mcp/context.ts";
import { handle, type UiServerCtx } from "../../src/ui-server/routes.ts";
import { buildCfgResult, CFG_BLOCK_CAP, type CfgInput, type CfgResult } from "../../src/ui-server/cfg.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);

function buildFixture(): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-cfg-"));
  const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
  writeSplitResult(splitResult, outDir);
  const rows = buildIndexRows({ bytes, splitResult, passes: {}, strictEnv: false, form: "flat" });
  const db = openProjectDb(join(outDir, "project.hbcproj"));
  try {
    initProjectDb(db, rows, { actorWho: "test" });
  } finally {
    db.close();
  }
  return outDir;
}

const outDir = buildFixture();
test.after(() => rmSync(outDir, { recursive: true, force: true }));

const mcp = new McpContext(outDir, { hbc: RN_TEMPLATE });
const ctx: UiServerCtx = { resources: mcp.resources, tools: mcp.tools, artifactDir: outDir };

async function getCfg(fn: number): Promise<{ readonly status: number; readonly json: unknown }> {
  return await handle({ method: "GET", path: `/api/fn/${fn}/cfg`, query: {}, body: null }, ctx);
}

/** A handful of real functions with more than one block, so the invariants
 *  below are exercised on branches and not only on straight-line code.
 *  Chosen BY SHAPE from the fixture itself, never by a hard-coded index. */
async function interestingFns(want: number): Promise<readonly CfgResult[]> {
  const out: CfgResult[] = [];
  for (let fn = 0; fn < 400 && out.length < want; fn++) {
    if (!ctx.resources.artifact.hasFn(fn)) continue;
    const res = await getCfg(fn);
    if (res.status !== 200) continue;
    const r = res.json as CfgResult;
    if (r.blocks.length > 1) out.push(r);
  }
  return out;
}

/** A synthetic diamond with `n` blocks in a chain off the entry, used for
 *  the cap rules. Block `i` falls through to `i + 1`; the last one returns. */
function chain(n: number): CfgInput {
  return {
    fn: 7,
    entry: 0,
    exits: [n - 1],
    rpo: Array.from({ length: n }, (_, i) => i),
    blocks: Array.from({ length: n }, (_, i) => ({
      id: i,
      start: i * 10,
      end: i * 10 + 10,
      instructions: 2,
      terminator: i === n - 1 ? "return" : "fallthrough",
      isHandlerEntry: false,
      succs: i === n - 1 ? [] : [{ to: i + 1, kind: "fallthrough" as const }],
    })),
    exceptionSuccs: [],
    regions: [],
  };
}

test("every edge names a block the response also contains", async () => {
  const results = await interestingFns(6);
  assert.ok(results.length > 0, "the fixture must have at least one multi-block function");
  for (const r of results) {
    const ids = new Set(r.blocks.map((b) => b.id));
    for (const e of r.edges) {
      assert.ok(ids.has(e.from), `fn ${r.fn}: edge from unknown block ${e.from}`);
      assert.ok(ids.has(e.to), `fn ${r.fn}: edge to unknown block ${e.to}`);
    }
    assert.ok(ids.has(r.entry), `fn ${r.fn}: the entry block must be drawn`);
  }
});

test("a dangling edge is dropped with its block, never left pointing at nothing", () => {
  const r = buildCfgResult(chain(10), { cap: 4 });
  const ids = new Set(r.blocks.map((b) => b.id));
  assert.equal(r.blocks.length, 4);
  for (const e of r.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to), `edge ${e.from}->${e.to} names a dropped block`);
  }
});

test("the block ranges partition the function's instructions with no gap or overlap", async () => {
  const results = await interestingFns(6);
  for (const r of results) {
    if (r.truncated) continue; // a capped answer is a subset by construction
    const real = r.blocks.filter((b) => !b.synthetic).map((b) => [b.start, b.end] as const).sort((a, z) => a[0] - z[0]);
    assert.ok(real.length > 0, `fn ${r.fn}: no real blocks`);
    for (const [start, end] of real) assert.ok(end > start, `fn ${r.fn}: empty range [${start}, ${end})`);
    for (let i = 1; i < real.length; i++) {
      assert.equal(real[i]![0], real[i - 1]![1], `fn ${r.fn}: gap or overlap between blocks at offset ${real[i - 1]![1]}`);
    }
    const cfg = ctx.resources.artifact.functionCfg(r.fn);
    assert.notEqual(cfg, null);
    const total = cfg!.blocks.filter((b) => b.start >= 0).reduce((s, b) => s + (b.end - b.start), 0);
    assert.equal(real.reduce((s, [a, z]) => s + (z - a), 0), total, `fn ${r.fn}: the ranges must cover exactly the function's instructions`);
  }
});

test("exception regions are reported, not silently dropped", async () => {
  // Find a function that HAS regions; the invariant is only meaningful there.
  let withRegions: CfgResult | null = null;
  for (let fn = 0; fn < 400 && withRegions === null; fn++) {
    if (!ctx.resources.artifact.hasFn(fn)) continue;
    const cfg = ctx.resources.artifact.functionCfg(fn);
    if (cfg === null || cfg.regions.length === 0) continue;
    const res = await getCfg(fn);
    if (res.status === 200) withRegions = res.json as CfgResult;
  }
  if (withRegions !== null) {
    const cfg = ctx.resources.artifact.functionCfg(withRegions.fn)!;
    assert.equal(withRegions.regions.length, cfg.regions.length, "every region src/cfg carved must be reported");
    for (const r of withRegions.regions) {
      assert.ok(r.endPc > r.startPc, "a region's pc range must be non-empty and end-exclusive");
      assert.ok(Number.isInteger(r.handlerBlock));
    }
    const handlerEntries = new Set(withRegions.blocks.filter((b) => b.isHandlerEntry).map((b) => b.id));
    for (const r of withRegions.regions) {
      if (withRegions.blocks.some((b) => b.id === r.handlerBlock)) {
        assert.ok(handlerEntries.has(r.handlerBlock), `region ${r.index}'s handler block must be flagged as a handler entry`);
      }
    }
  }
  // ...and on synthetic input, where a region is guaranteed to exist.
  const input: CfgInput = {
    ...chain(3),
    exceptionSuccs: [[0, [2]]],
    regions: [{ index: 0, startPc: 0, endPc: 20, handlerBlock: 2, catchRegister: 1, parent: null, bodyBlocks: [0, 1] }],
  };
  const synth = buildCfgResult(input);
  assert.equal(synth.regions.length, 1);
  assert.deepEqual(synth.regions[0]!.blocks, [0, 1]);
  assert.ok(synth.edges.some((e) => e.kind === "exception" && e.from === 0 && e.to === 2), "an exception edge is an edge, not a dropped one");
});

test("capped at the published cap with an honest truncation field", async () => {
  const big = buildCfgResult(chain(CFG_BLOCK_CAP + 51));
  assert.equal(big.cap, CFG_BLOCK_CAP);
  assert.equal(big.blocks.length, CFG_BLOCK_CAP);
  assert.equal(big.shown, CFG_BLOCK_CAP);
  assert.equal(big.total, CFG_BLOCK_CAP + 51);
  assert.equal(big.hidden, 51);
  assert.equal(big.truncated, true);
  // The entry always survives the cap: a graph rooted nowhere is undrawable.
  assert.ok(big.blocks.some((b) => b.entry));

  const small = buildCfgResult(chain(3));
  assert.equal(small.hidden, 0);
  assert.equal(small.truncated, false);
  assert.equal(small.shown, small.total);

  // Real functions are never truncated silently either.
  for (const r of await interestingFns(4)) assert.equal(r.truncated, r.hidden > 0);
});

test("a block's line span comes from the same linemap the listing aligns with", async () => {
  const results = await interestingFns(8);
  let checked = 0;
  for (const r of results) {
    const lm = ctx.resources.lineMap(r.fn);
    assert.equal(r.fnStartLine, lm.fnStartLine);
    for (const b of r.blocks) {
      if (b.lines === null) continue;
      checked++;
      assert.ok(b.lines[0] <= b.lines[1], `fn ${r.fn} block ${b.id}: inverted span`);
      const inRange = lm.lines.filter(([, fn, off]) => fn === r.fn && off >= b.start && off < b.end).map(([line]) => line);
      assert.equal(b.lines[0], Math.min(...inRange));
      assert.equal(b.lines[1], Math.max(...inRange));
      if (r.fnStartLine !== null) {
        assert.deepEqual(b.fileLines, [b.lines[0] + r.fnStartLine - 1, b.lines[1] + r.fnStartLine - 1]);
      } else {
        assert.equal(b.fileLines, null);
      }
    }
  }
  assert.ok(checked > 0, "at least one block must map to source lines");
});

test("a bad or unknown fn is a 400/404, never a 500", async () => {
  const bad = await getCfg(Number.NaN);
  assert.equal((await handle({ method: "GET", path: "/api/fn/nope/cfg", query: {}, body: null }, ctx)).status, 400);
  assert.equal(bad.status, 400);
  const missing = await getCfg(9_999_999);
  assert.equal(missing.status, 404);
  assert.match(String((missing.json as { reason: string }).reason), /no such function/);
});

test("a project with no --hbc declines the route rather than inventing a graph", async () => {
  const noHbc = new McpContext(outDir, {});
  const bare: UiServerCtx = { resources: noHbc.resources, tools: noHbc.tools, artifactDir: outDir };
  const fn = [...Array(400).keys()].find((n) => bare.resources.artifact.hasFn(n));
  assert.notEqual(fn, undefined);
  const res = await handle({ method: "GET", path: `/api/fn/${fn}/cfg`, query: {}, body: null }, bare);
  assert.equal(res.status, 404);
  assert.match(String((res.json as { reason: string }).reason), /no block graph available/);
});
