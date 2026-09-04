// tests/ui-core/keymap.test.ts — docs/specs/22-ui-mvp.md §3.2: the sequence
// dispatcher (chords, counts, timeout, overrides) and preset/registry
// consistency (no dangling ids).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeymap, type KeyEvent } from "../../src/ui-core/keymap.ts";
import { loadPreset, PRESET_NAMES } from "../../src/ui-core/keymap-config.ts";
import { createStandardRegistry } from "../../src/ui-core/actions.ts";

function key(k: string, mods: Partial<KeyEvent> = {}): KeyEvent {
  return { key: k, ...mods };
}

test("every preset chord resolves to a registered action id", () => {
  const registry = createStandardRegistry();
  const ids = new Set(registry.list().map((a) => a.id));
  for (const name of PRESET_NAMES) {
    const preset = loadPreset(name);
    for (const [chord, actionId] of Object.entries(preset)) {
      assert.ok(ids.has(actionId), `${name} preset: chord "${chord}" -> unknown action id "${actionId}"`);
    }
    // constructing a keymap from the preset must not throw (no internal conflicts)
    assert.doesNotThrow(() => createKeymap({ preset }));
  }
});

test("multi-key chord resolves after both keys, single-key chord resolves immediately", () => {
  const km = createKeymap({ preset: loadPreset("vim") });
  assert.equal(km.feed(key("g"), 0), "pending");
  const result = km.feed(key("d"), 10);
  assert.deepEqual(result, { actionId: "navigate.definition", count: 1 });
  assert.equal(km.isPending(), false);

  const solo = km.feed(key("/"), 20);
  assert.deepEqual(solo, { actionId: "project.search", count: 1 });
});

test("dead-end sequence returns none and clears pending", () => {
  const km = createKeymap({ preset: loadPreset("vim") });
  assert.equal(km.feed(key("g"), 0), "pending");
  assert.equal(km.feed(key("q"), 10), "none"); // g z is graph.lodCycle since 245330a; g q is unbound in every preset
  assert.equal(km.isPending(), false);
  // g is usable again afterwards
  assert.equal(km.feed(key("g"), 20), "pending");
});

test("Escape clears a pending sequence", () => {
  const km = createKeymap({ preset: loadPreset("vim") });
  assert.equal(km.feed(key("g"), 0), "pending");
  assert.equal(km.feed(key("Escape"), 10), "none");
  assert.equal(km.isPending(), false);
});

test("timeout clears a pending sequence", () => {
  const km = createKeymap({ preset: loadPreset("vim"), timeoutMs: 100 });
  assert.equal(km.feed(key("g"), 0), "pending");
  // "d" arrives after the timeout window: pending is dropped first, so "d"
  // is evaluated fresh against the root (vim has no bare "d" chord).
  assert.equal(km.feed(key("d"), 500), "none");
  assert.equal(km.isPending(), false);
});

test("count prefix multiplies the resolved count", () => {
  const km = createKeymap({ preset: loadPreset("vim") });
  assert.equal(km.feed(key("3"), 0), "pending");
  assert.equal(km.feed(key("]"), 10), "pending");
  const result = km.feed(key("f"), 20);
  assert.deepEqual(result, { actionId: "navigate.nextFn", count: 3 });
});

test("a leading 0 is not a count digit", () => {
  const km = createKeymap({ preset: { "0": "navigate.back" } });
  const result = km.feed(key("0"), 0);
  assert.deepEqual(result, { actionId: "navigate.back", count: 1 });
});

test("overrides win over the preset and null unbinds", () => {
  const km = createKeymap({
    preset: loadPreset("vim"),
    overrides: { "gd": "annotate.rename", "gr": null },
  });
  const r1 = km.feed(key("g"), 0);
  assert.equal(r1, "pending");
  const r2 = km.feed(key("d"), 10);
  assert.deepEqual(r2, { actionId: "annotate.rename", count: 1 });

  assert.equal(km.feed(key("g"), 20), "pending");
  assert.equal(km.feed(key("r"), 30), "none");
});

test("construction rejects a chord that is a prefix of another, naming both", () => {
  assert.throws(
    () => createKeymap({ preset: { "g": "navigate.definition", "gd": "annotate.rename" } }),
    /"g".*"gd"|"gd".*"g"/,
  );
});

test("Ctrl-modified chord does not collide with the bare key", () => {
  const km = createKeymap({ preset: { o: "annotate.rename", "Ctrl-o": "navigate.back" } });
  assert.deepEqual(km.feed(key("o"), 0), { actionId: "annotate.rename", count: 1 });
  assert.deepEqual(km.feed(key("o", { ctrl: true }), 10), { actionId: "navigate.back", count: 1 });
});

test("named function keys with/without Shift are distinct", () => {
  const km = createKeymap({ preset: { F12: "navigate.definition", "Shift-F12": "navigate.xrefs" } });
  assert.deepEqual(km.feed(key("F12"), 0), { actionId: "navigate.definition", count: 1 });
  assert.deepEqual(km.feed(key("F12", { shift: true }), 10), { actionId: "navigate.xrefs", count: 1 });
});

test("leader chord uses the configured leader key", () => {
  const km = createKeymap({ preset: { "<leader>r": "annotate.rename" }, leader: "," });
  assert.equal(km.feed(key(",")), "pending");
  assert.deepEqual(km.feed(key("r")), { actionId: "annotate.rename", count: 1 });
});
