// tests/ui-core/url-state.test.ts — spec 26 L10 (i)'s acceptance tests for
// `ui/src/state/url-codec.ts`'s pure encode/decode. That file imports only
// TYPES from `ui/src/state/selection.ts` / `ui/src/actions/store.ts`
// (verbatimModuleSyntax erases them), so — like `ui/src/graph/model.ts` in
// tests/ui-core/graph-model.test.ts — it runs under plain `node:test` with
// no `ui/node_modules` present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeUrlState, encodeUrlState, type RightPanel } from "../../ui/src/state/url-codec.ts";
import type { Selection } from "../../ui/src/state/selection.ts";

test("selection round-trips through the URL", () => {
  const cases: readonly { readonly selection: Selection; readonly panel: RightPanel }[] = [
    { selection: { kind: "fn", fn: 42 }, panel: "xrefs" },
    { selection: { kind: "module", moduleId: "7" }, panel: "context" },
    { selection: { kind: "identifier", name: "foo", fn: 3 }, panel: "graph" },
    { selection: { kind: "string", sid: 9, name: "bar" }, panel: "strings" },
    { selection: { kind: "finding", rid: 5 }, panel: "findings" },
    { selection: { kind: "fn", fn: 1, line: 12 }, panel: "context" },
  ];
  for (const { selection, panel } of cases) {
    const encoded = encodeUrlState(selection, panel);
    const decoded = decodeUrlState(encoded);
    assert.deepEqual(decoded, { selection, panel }, `round-trip failed for ${encoded}`);
  }
});

test("an unknown query param is ignored, not fatal", () => {
  assert.doesNotThrow(() => decodeUrlState("fn=3&sel=fn&bogus=xyz&panel=not-a-real-panel"));
  const { selection, panel } = decodeUrlState("fn=3&sel=fn&bogus=xyz");
  assert.deepEqual(selection, { kind: "fn", fn: 3 });
  assert.equal(panel, "context"); // an unrecognised panel value falls back to the default
});

test('"nothing selected" is representable (it is not fn 0)', () => {
  const encoded = encodeUrlState({ kind: "none" }, "context");
  assert.equal(encoded, "", "no selection + default panel must encode to an EMPTY query string");
  const { selection } = decodeUrlState(encoded);
  assert.equal(selection.kind, "none");
  assert.notEqual(selection.fn, 0, '"none" must never decode to fn 0');

  // fn 0 IS representable, distinctly, when actually selected.
  const fnZero = decodeUrlState(encodeUrlState({ kind: "fn", fn: 0 }, "context"));
  assert.deepEqual(fnZero.selection, { kind: "fn", fn: 0 });
});
