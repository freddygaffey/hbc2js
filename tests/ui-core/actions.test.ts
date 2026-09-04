// tests/ui-core/actions.test.ts — docs/specs/22-ui-mvp.md §3.1/§3.3: the
// registry/menu/palette invariant (one registry feeds all three views).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStandardRegistry, contextMenuFor, paletteItems, type ActionContext, type ActionApi } from "../../src/ui-core/actions.ts";
import { createKeymap } from "../../src/ui-core/keymap.ts";
import { loadPreset } from "../../src/ui-core/keymap-config.ts";

function stubApi(): ActionApi {
  const noop = () => {};
  return {
    setName: noop,
    addComment: noop,
    recordFinding: noop,
    gotoFn: noop,
    showXrefs: noop,
    search: noop,
    openPalette: noop,
    markReviewed: noop,
    markSuspicious: noop,
    copyDisasmOffset: noop,
    showRawHermes: noop,
    explain: noop,
    suggestName: noop,
    openGraph: noop,
    nextFn: noop,
    prevFn: noop,
    nextModule: noop,
    prevModule: noop,
    back: noop,
    forward: noop,
    fold: noop,
    unfold: noop,
  };
}

function identifierCtx(): ActionContext {
  return { selection: { kind: "identifier", name: "foo" }, focusPane: "editor", api: stubApi() };
}

test("context menu for identifier selection has rename/comment/definition/xrefs with chord labels, excludes ai.*", () => {
  const registry = createStandardRegistry();
  for (const preset of ["default", "vim", "ghidra"] as const) {
    const keymap = createKeymap({ preset: loadPreset(preset) });
    const menu = contextMenuFor(identifierCtx(), registry, keymap);
    const ids = menu.map((m) => m.id);
    for (const id of ["annotate.rename", "annotate.comment", "navigate.definition", "navigate.xrefs"]) {
      assert.ok(ids.includes(id), `${preset}: expected ${id} in menu`);
    }
    assert.ok(!ids.some((id) => id.startsWith("ai.")), `${preset}: ai.* must not appear (when: () => false)`);
    // annotate.rename and annotate.comment are bound in every preset; each
    // menu item's chord label must match what the keymap actually resolves.
    for (const id of ["annotate.rename", "annotate.comment"]) {
      const expected = keymap.chordFor(id);
      assert.ok(expected !== undefined, `${preset}: ${id} should have a bound chord`);
      const item = menu.find((m) => m.id === id);
      assert.equal(item?.chord, expected, `${preset}: ${id} chord label mismatch`);
    }
    for (const item of menu) {
      assert.equal(item.chord, keymap.chordFor(item.id), `${preset}: ${item.id} chord label mismatch`);
    }
    // separators: at most one separator boundary per group transition, first item never separated
    assert.equal(menu[0]?.separatorBefore, false);
  }
});

test("palette items equal enabled registry actions", () => {
  const registry = createStandardRegistry();
  const ctx = identifierCtx();
  const palette = paletteItems(ctx, registry);
  const enabledIds = registry.enabledFor(ctx).map((a) => a.id).sort();
  assert.deepEqual(
    palette.map((p) => p.id).sort(),
    enabledIds,
  );
  assert.ok(!palette.some((p) => p.id.startsWith("ai.")));
});

test("view.graph and ai.* are registered but disabled everywhere", () => {
  const registry = createStandardRegistry();
  assert.ok(registry.get("view.graph"));
  assert.ok(registry.get("ai.explain"));
  assert.ok(registry.get("ai.suggestName"));
  const ctx: ActionContext = { selection: { kind: "fn", fn: 1 }, focusPane: "editor", api: stubApi() };
  const enabled = registry.enabledFor(ctx).map((a) => a.id);
  assert.ok(!enabled.includes("view.graph"));
  assert.ok(!enabled.includes("ai.explain"));
  assert.ok(!enabled.includes("ai.suggestName"));
});

test("run() rejects a disabled action and an unknown id", () => {
  const registry = createStandardRegistry();
  const ctx: ActionContext = { selection: { kind: "none" }, focusPane: "editor", api: stubApi() };
  assert.throws(() => registry.run("ai.explain", ctx));
  assert.throws(() => registry.run("nope.nope", ctx));
});
