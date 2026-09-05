// tests/ui-core/finding-action.test.ts — docs/specs/22-ui-mvp.md §3.6's
// owner addition: the "Add finding" command is a registry action like any
// other, so it must reach the context menu, the palette and a chord in both
// the default and the vim preset without any surface holding its own list.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextMenuFor, createStandardRegistry, paletteItems,
  type ActionApi, type ActionContext, type Selection,
} from "../../src/ui-core/actions.ts";
import { createKeymap } from "../../src/ui-core/keymap.ts";
import { loadPreset, resolveKeymapConfig } from "../../src/ui-core/keymap-config.ts";

const ACTION_ID = "annotate.finding";

function apiSpy(): { api: ActionApi; calls: Selection[] } {
  const calls: Selection[] = [];
  const noop = (): void => {};
  const api = new Proxy(
    { recordFinding: (target: Selection): void => void calls.push(target) } as Record<string, unknown>,
    { get: (t, k) => (k in t ? t[k as string] : noop) },
  ) as unknown as ActionApi;
  return { api, calls };
}

function ctxFor(selection: Selection, api: ActionApi): ActionContext {
  return { selection, focusPane: "editor", api };
}

test("annotate.finding runs recordFinding with the current selection", () => {
  const registry = createStandardRegistry();
  const { api, calls } = apiSpy();
  registry.run(ACTION_ID, ctxFor({ kind: "fn", fn: 7992 }, api));
  assert.deepEqual(calls, [{ kind: "fn", fn: 7992 }]);
});

test("annotate.finding is disabled with no selection, enabled for fn and module", () => {
  const registry = createStandardRegistry();
  const { api } = apiSpy();
  const enabled = (s: Selection): boolean =>
    registry.enabledFor(ctxFor(s, api)).some((a) => a.id === ACTION_ID);
  assert.equal(enabled({ kind: "none" }), false);
  assert.equal(enabled({ kind: "fn", fn: 1 }), true);
  assert.equal(enabled({ kind: "module", moduleId: "1086" }), true);
});

test("annotate.finding reaches menu and palette, with its chord shown", () => {
  const registry = createStandardRegistry();
  const { api } = apiSpy();
  const ctx = ctxFor({ kind: "fn", fn: 7992 }, api);
  for (const [preset, chord] of [["default", "Ctrl-Shift-N"], ["vim", "cf"]] as const) {
    const keymap = createKeymap({ preset: loadPreset(preset) });
    const item = contextMenuFor(ctx, registry, keymap).find((m) => m.id === ACTION_ID);
    assert.ok(item, `${preset}: expected ${ACTION_ID} in the context menu`);
    assert.equal(item.chord, chord);
    assert.equal(item.group, "annotate");
    assert.ok(paletteItems(ctx, registry).some((p) => p.id === ACTION_ID), `${preset}: palette`);
    assert.equal(keymap.chordFor(ACTION_ID), chord);
  }
});

// -- spec 26 L6: lead promotion / status transition gating -----------------

test("finding.fromLead is enabled only on a lead target", () => {
  const registry = createStandardRegistry();
  const { api } = apiSpy();
  const enabled = (s: Selection): boolean => registry.enabledFor(ctxFor(s, api)).some((a) => a.id === "finding.fromLead");
  assert.equal(enabled({ kind: "none" }), false);
  assert.equal(enabled({ kind: "fn", fn: 1 }), false);
  assert.equal(enabled({ kind: "finding", rid: 1 }), false);
  assert.equal(enabled({ kind: "lead", leadClass: "verify", leadEvidence: "fn:7", leadDetail: "calls crypto.verify" }), true);
});

test("finding.fromLead prefills the form from the lead (recordFinding target carries the lead)", () => {
  const registry = createStandardRegistry();
  const calls: Selection[] = [];
  const api = new Proxy({ promoteLead: (target: Selection): void => void calls.push(target) } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : (): void => {}),
  }) as unknown as ActionApi;
  const lead: Selection = { kind: "lead", fn: 7, leadClass: "verify", leadEvidence: "fn:7", leadDetail: "calls crypto.verify" };
  registry.run("finding.fromLead", ctxFor(lead, api));
  assert.deepEqual(calls, [lead]);
});

test("finding.setStatus is disabled on a finding whose evidence has not resolved", () => {
  const registry = createStandardRegistry();
  const { api } = apiSpy();
  const enabled = (s: Selection): boolean => registry.enabledFor(ctxFor(s, api)).some((a) => a.id === "finding.setStatus");
  assert.equal(enabled({ kind: "finding", rid: 1, evidenceResolved: false }), false);
  assert.equal(enabled({ kind: "finding", rid: 1 }), false);
  assert.equal(enabled({ kind: "finding", rid: 1, evidenceResolved: true }), true);
});

test("resolveKeymapConfig accepts a preloaded preset table (browser shell path)", () => {
  const registry = createStandardRegistry();
  const presets = { default: loadPreset("default"), vim: loadPreset("vim"), ghidra: loadPreset("ghidra") };
  const opts = resolveKeymapConfig({ preset: "vim", overrides: { "<leader>f": ACTION_ID } }, registry, presets);
  const keymap = createKeymap(opts);
  assert.equal(keymap.chordFor(ACTION_ID), "cf");
  assert.deepEqual(keymap.feed({ key: "\\" }), "pending");
  assert.deepEqual(keymap.feed({ key: "f" }), { actionId: ACTION_ID, count: 1 });
  assert.throws(() => resolveKeymapConfig({ preset: "nope" }, registry, presets), /unknown preset "nope"/);
});
