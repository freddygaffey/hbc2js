// tests/ui-server/screens.test.ts — acceptance for docs/specs/26-ui-full-ide.md
// L4 ("listing-2: hierarchical screens tree + navigation arrows"), server half.
//
// Two kinds of check, deliberately:
//  * INVARIANTS on the real rn-template-0.72 fixture (the same recipe
//    tests/ui-server/routes.test.ts uses) — what the route answers about a
//    real artifact must always be consistent with what /api/segregation says
//    about the same project, whatever that project happens to contain.
//  * The edge/tree RULES on synthetic input through the pure core
//    (`buildScreens`, `byNameEdgesOf`), because "resolved only when the
//    points-to index proved it" must hold for inputs no committed fixture
//    has (docs/CONSOLIDATION.md §B: no exact-output assertions on shared
//    fixtures either way).
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
import { segregation } from "../../src/ui-server/segregation.ts";
import { SCREENS_ROUTES, buildScreens, byNameEdgesOf, screenLabelOf, screensOf, type RawNavEdge, type ScreenCandidate, type ScreensCtx } from "../../src/ui-server/screens.ts";
import type { UiServerCtx } from "../../src/ui-server/routes.ts";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

function buildFixture(): string {
  const bytes = readFileSync(RN_TEMPLATE);
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-ui-screens-"));
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
const ctx: ScreensCtx = { resources: mcp.resources, artifactDir: outDir };

/** `segregation()` answers a `computing: true` placeholder until its
 *  off-main-thread compute lands (src/ui-server/segregation.ts); the screens
 *  route mirrors that, so a content assertion must wait exactly as the UI's
 *  own poll loop does. */
async function settled() {
  for (let i = 0; i < 200; i++) {
    const seg = segregation(ctx);
    if (seg !== null && seg.computing !== true) {
      const s = screensOf(ctx);
      if (s !== null && s.computing !== true) return { seg, screens: s };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("segregation/screens did not settle in time");
}

test("every screen row names a module that exists in the segregation result", async () => {
  const { seg, screens } = await settled();
  const known = new Set(seg.modules.map((m) => m.id));
  const rowMods = new Set(screens.screens.map((s) => s.mod));
  assert.equal(screens.total, screens.screens.length);
  for (const row of screens.screens) {
    assert.ok(known.has(row.mod), `screen row mod ${row.mod} is not a segregated module`);
    assert.notEqual(row.label, "");
    assert.ok(row.kind === "screen" || row.kind === "navigator");
    for (const child of row.children) {
      assert.ok(rowMods.has(child), `child ${child} of screen ${row.mod} is not itself a screen row`);
      assert.notEqual(child, row.mod);
    }
    for (const edge of row.navigatesTo) assert.ok(rowMods.has(edge.mod), `edge target ${edge.mod} is not a screen row`);
  }
  // The tree projection is a forest on the real artifact too: no module is
  // claimed by two parents.
  const claims = screens.screens.flatMap((s) => s.children);
  assert.equal(new Set(claims).size, claims.length);
});

test('a navigation edge is only "resolved" when the points-to index proved it', () => {
  const candidates: readonly ScreenCandidate[] = [
    { mod: 1, label: "HomeScreen", kind: "screen", fn: 10, deps: [] },
    { mod: 2, label: "DetailsScreen", kind: "screen", fn: 20, deps: [] },
  ];
  const edges: readonly RawNavEdge[] = [
    { from: 1, to: 2, via: "Details", confidence: "by-name" },
    { from: 2, to: 1, via: "goHome", confidence: "points-to" },
  ];
  const built = buildScreens(candidates, edges);
  const home = built.screens.find((s) => s.mod === 1)!;
  const details = built.screens.find((s) => s.mod === 2)!;
  // A by-name candidate never becomes "points-to" by passing through the
  // model, and a points-to edge keeps its provenance.
  assert.deepEqual(home.navigatesTo, [{ mod: 2, via: "Details", confidence: "by-name" }]);
  assert.deepEqual(details.navigatesTo, [{ mod: 1, via: "goHome", confidence: "points-to" }]);
  // And nothing the by-name scanner produces can ever carry "points-to".
  const scanned = byNameEdgesOf(1, 'x.navigate("Details"); y.push("Home");', new Map([["DetailsScreen", 2], ["HomeScreen", 1]]));
  assert.ok(scanned.every((e) => e.confidence === "by-name"));
});

test('by-name candidates are returned with confidence "by-name"', () => {
  const labels = new Map([["HomeScreen", 1], ["DetailsScreen", 2], ["SettingsScreen", 3]]);
  const text = 'function f(n){ n.navigate("Details"); n.push("SettingsScreen"); n.navigate("NoSuchRoute"); const s = "Details"; }';
  const found = byNameEdgesOf(7, text, labels);
  assert.deepEqual(
    found.map((e) => ({ to: e.to, via: e.via, confidence: e.confidence })),
    [
      { to: 2, via: "Details", confidence: "by-name" },
      { to: 3, via: "SettingsScreen", confidence: "by-name" },
    ],
  );
  // A bare string that is not the argument of a navigation-shaped call is
  // not a candidate, and a literal naming no screen is dropped rather than
  // returned as a stub target.
  assert.equal(found.length, 2);
  assert.equal(screenLabelOf("src/screens/HomeScreen.js"), "HomeScreen");
});

test("404 when the project has no split module tree", async () => {
  const empty = mkdtempSync(join(tmpdir(), "hbc2js-ui-screens-empty-"));
  try {
    const bare = { resources: mcp.resources, artifactDir: empty } as unknown as ScreensCtx;
    assert.equal(screensOf(bare), null);
    const route = SCREENS_ROUTES[0]!;
    assert.ok(route.re.test("/api/screens"));
    const res = await route.handler([], { method: "GET", path: "/api/screens", query: {}, body: undefined }, bare as unknown as UiServerCtx);
    assert.equal(res.status, 404);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
