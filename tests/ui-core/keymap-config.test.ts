// tests/ui-core/keymap-config.test.ts — docs/specs/22-ui-mvp.md §3.2:
// `ui/keymap.json` validation (unknown preset / unknown override action id).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPreset, resolveKeymapConfig, PRESET_NAMES } from "../../src/ui-core/keymap-config.ts";
import { createStandardRegistry } from "../../src/ui-core/actions.ts";
import { createKeymap } from "../../src/ui-core/keymap.ts";

test("loadPreset rejects an unknown preset name, listing valid presets", () => {
  assert.throws(() => loadPreset("emacs"), (err: unknown) => {
    assert.ok(err instanceof Error);
    for (const name of PRESET_NAMES) assert.ok(err.message.includes(name));
    return true;
  });
});

test("resolveKeymapConfig rejects an override naming an unknown action id, listing valid ids", () => {
  const registry = createStandardRegistry();
  assert.throws(
    () => resolveKeymapConfig({ preset: "default", overrides: { "Ctrl-Z": "annotate.doesNotExist" } }, registry),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes("annotate.doesNotExist"));
      assert.ok(err.message.includes("navigate.definition"));
      return true;
    },
  );
});

test("resolveKeymapConfig accepts a valid config and feeds createKeymap", () => {
  const registry = createStandardRegistry();
  const options = resolveKeymapConfig({ preset: "vim", overrides: { "gr": null } }, registry);
  const km = createKeymap(options);
  assert.equal(km.feed({ key: "g" }), "pending");
  assert.equal(km.feed({ key: "r" }), "none");
});
