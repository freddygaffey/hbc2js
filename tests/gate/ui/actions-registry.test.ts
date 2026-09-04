// tests/gate/ui/actions-registry.test.ts — spec 22 §3.1's invariant, held
// mechanically: the context menu, the command palette and the keymap are
// three VIEWS over src/ui-core/actions.ts, so no file under ui/src/ may keep
// its own list of commands or its own chord table. (The wave-1 shell shipped
// a hard-coded palette list on purpose, as a placeholder; this test is what
// stops one growing back.)
//
// Pure file scanning plus Node-side use of src/ui-core, like tokens.test.ts:
// it never imports from ui/ and needs no ui/node_modules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { createStandardRegistry } from "../../../src/ui-core/actions.ts";
import { loadPreset, PRESET_NAMES } from "../../../src/ui-core/keymap-config.ts";
import { resolveKeymapConfigWith, type KeymapConfig } from "../../../src/ui-core/keymap-resolve.ts";
import { createKeymap } from "../../../src/ui-core/keymap.ts";

const ui = (...p: string[]): string => join(repoRoot(), "ui", ...p);
const read = (...p: string[]): string => readFileSync(ui(...p), "utf8");

test("the palette and the context menu build their items from the registry", () => {
  const palette = read("src", "components", "CommandPalette.tsx");
  assert.match(palette, /paletteItems\(/, "CommandPalette must call paletteItems(ctx, registry)");
  assert.doesNotMatch(
    palette,
    /const ITEMS\b/,
    "CommandPalette must not keep a hard-coded command list — spec 22 §3.1 makes it a view over the registry",
  );
  const menu = read("src", "components", "ContextMenu.tsx");
  assert.match(menu, /contextMenuFor\(/, "ContextMenu must call contextMenuFor(ctx, registry, keymap)");
});

test("the keydown adapter decodes chords with ui-core's keymap, not its own table", () => {
  const keys = read("src", "actions", "keys.ts");
  assert.match(keys, /keymap\.feed\(/, "keys.ts must feed events to createKeymap's dispatcher");
  assert.doesNotMatch(keys, /"gd"|"gr"|"F2"|Ctrl-Shift-N/, "keys.ts must not hard-code chords; presets own them");
});

test("ui/ imports src/ui-core through the @ui-core alias in BOTH vite and tsconfig", () => {
  assert.match(read("vite.config.ts"), /"@ui-core":/, "ui/vite.config.ts needs the @ui-core alias");
  assert.match(read("tsconfig.json"), /"@ui-core\/\*"/, "ui/tsconfig.json needs the matching paths entry");
});

test("ui/keymap.json is a valid { preset, overrides } config for the standard registry", () => {
  const config = JSON.parse(read("keymap.json")) as KeymapConfig;
  assert.ok(
    (PRESET_NAMES as readonly string[]).includes(config.preset),
    `ui/keymap.json names preset "${config.preset}", not one of ${PRESET_NAMES.join(", ")}`,
  );
  const registry = createStandardRegistry();
  const presets = Object.fromEntries(PRESET_NAMES.map((n) => [n, loadPreset(n)]));
  // Throws on an unknown preset or an override naming an unregistered action.
  const keymap = createKeymap(resolveKeymapConfigWith(config, registry, presets));
  // Spec 22 §3.6: "Add finding" must be reachable by chord out of the box.
  assert.equal(typeof keymap.chordFor("annotate.finding"), "string");
});

test("navigate.back/navigate.forward are registered and bound to a chord", () => {
  const registry = createStandardRegistry();
  const presets = Object.fromEntries(PRESET_NAMES.map((n) => [n, loadPreset(n)]));
  const keymap = createKeymap(resolveKeymapConfigWith(JSON.parse(read("keymap.json")) as KeymapConfig, registry, presets));
  for (const id of ["navigate.back", "navigate.forward"]) {
    assert.notEqual(registry.get(id), undefined, `${id} must be a registered action`);
    // The TopBar arrows show the binding in their tooltip; an unbound action
    // would silently show a bare "Back".
    assert.equal(typeof keymap.chordFor(id), "string", `${id} must have a chord in the shipped keymap`);
  }
});

test("the back/forward arrows dispatch through the registry, not back()/forward()", () => {
  const bar = read("src", "panes", "TopBar.tsx");
  assert.match(bar, /runAction\("navigate\.back"\)/, "the Back arrow must go through runAction");
  assert.match(bar, /runAction\("navigate\.forward"\)/, "the Forward arrow must go through runAction");
  const imported = /import \{([^}]*)\} from "\.\.\/state\/selection\.ts";/.exec(bar);
  assert.notEqual(imported, null, "TopBar must import the selection store");
  const names = imported![1]!.split(",").map((x) => x.trim());
  assert.ok(
    !names.includes("back") && !names.includes("forward"),
    `TopBar imports ${names.join(", ")} — the arrows must not call the store's back()/forward() directly; one path for buttons and keys`,
  );
  assert.match(bar, /keymap\.chordFor\("navigate\.back"\)|chordFor\(id\)/, "the tooltip must read the chord from the keymap, never hard-code it");
  assert.match(bar, /useJumpState\(\)/, "the disabled state comes from the jump list, not from local state");
});
