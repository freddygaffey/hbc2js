// tests/gate/ui/screens-model.test.ts — acceptance for
// docs/specs/26-ui-full-ide.md L4, client half: the pure tree/edge model
// (`ui/src/listing/screens.ts`) that the left pane renders.
//
// The server owns what a screen IS; this model owns the projection, and the
// two rules below are the ones that must hold whatever the wire says —
// including a malformed or hostile answer, since a cyclic `children` list
// would otherwise hang the renderer and an unknown edge target would render
// a row the analyst cannot open.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  orderScreenGroups, screenDepths, screenEdges, screenOrder, screensTree,
  type ScreenRow, type ScreensPage,
} from "../../../ui/src/listing/screens.ts";
import { NAVIGATION_KEY, SCREENS_KEY, type ModuleGroup } from "../../../ui/src/listing/modules.ts";

function row(mod: number, label: string, extra: Partial<ScreenRow> = {}): ScreenRow {
  return { mod, fn: mod * 10, label, kind: "screen", children: [], navigatesTo: [], ...extra };
}

test("screensTree: children never duplicate a parent (no cycles in the tree projection)", () => {
  // 1 -> 2 -> 3 -> 1 is a cycle on the wire; 4 is claimed by two parents.
  const page: ScreensPage = {
    total: 4,
    screens: [
      row(1, "RootNav", { kind: "navigator", children: [2, 4] }),
      row(2, "HomeScreen", { children: [3] }),
      row(3, "DetailsScreen", { children: [1] }),
      row(4, "SharedScreen", {}),
      row(5, "SelfScreen", { children: [5] }),
    ],
  };
  const nodes = screensTree(page);
  const flat = screenOrder(nodes);
  const mods = flat.map((n) => n.row.mod);
  // Every screen appears exactly once, and none is its own ancestor.
  assert.deepEqual([...mods].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.equal(new Set(mods).size, mods.length);
  for (const n of flat) assert.ok(!n.children.some((c) => c.row.mod === n.row.mod));
  // The cycle-closing claim (3 -> 1) is refused, so 1 stays a root.
  assert.ok(nodes.some((n) => n.row.mod === 1));
  const depths = screenDepths(nodes);
  assert.equal(depths.get(1), 1);
  assert.equal(depths.get(2), 2);
  assert.equal(depths.get(3), 3);
  // A parent always precedes its children in the rendered order.
  for (const n of flat) {
    for (const c of n.children) assert.ok(mods.indexOf(c.row.mod) > mods.indexOf(n.row.mod));
  }
  // The same order drives the left pane's Screens/Navigation groups.
  const groups: readonly ModuleGroup[] = [
    { key: SCREENS_KEY, label: "Screens", kind: "screens", modules: [3, 2, 4, 9].map((id) => ({ id, file: `module_${id}.js`, factoryFn: id, deps: [], segment: 0 })) },
    { key: NAVIGATION_KEY, label: "Navigation", kind: "navigation", modules: [] },
    { key: "app", label: "App", kind: "app", modules: [{ id: 7, file: "module_7.js", factoryFn: 7, deps: [], segment: 0 }] },
  ];
  const ordered = orderScreenGroups(groups, nodes);
  assert.deepEqual(ordered[0]!.modules.map((m) => m.id), [2, 3, 4, 9]);
  assert.deepEqual(ordered[2]!.modules.map((m) => m.id), [7]);
});

test("screensTree: an edge to an unknown module is dropped, not rendered as a stub", () => {
  const page: ScreensPage = {
    total: 2,
    screens: [
      row(1, "HomeScreen", {
        navigatesTo: [
          { mod: 2, via: "Details", confidence: "by-name" },
          { mod: 99, via: "Ghost", confidence: "points-to" },
          { mod: 1, via: "Self", confidence: "points-to" },
        ],
      }),
      row(2, "DetailsScreen", { children: [99] }),
    ],
  };
  const nodes = screensTree(page);
  const edges = screenEdges(nodes);
  assert.deepEqual(edges.get(1), [{ mod: 2, via: "Details", confidence: "by-name" }]);
  // The unknown module is not a node, not a child, and not an edge target.
  const mods = screenOrder(nodes).map((n) => n.row.mod);
  assert.ok(!mods.includes(99));
  const details = screenOrder(nodes).find((n) => n.row.mod === 2)!;
  assert.deepEqual(details.children, []);
  // Provenance survives the projection untouched: a by-name candidate is
  // never promoted to a resolved edge by being rendered.
  assert.equal(edges.get(1)![0]!.confidence, "by-name");
  assert.equal(screensTree(null).length, 0);
});
