// tests/ui-core/context-native.test.ts — docs/specs/27-native-side.md §L5:
// the Context pane's "native impl" row, PURE half (ui/src/panes/
// context-native.ts imports only TYPES from ui/src/contracts.ts, same idiom
// as tests/ui-core/graph-cfg-model.test.ts). Runs in the root gate, no
// browser, no `ui/node_modules`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hasNativeImpl, nativeImplDetail, nativeImplLabel } from "../../ui/src/panes/context-native.ts";
import type { NativeImpl, NativeImplRow } from "../../ui/src/contracts.ts";

function row(over: Partial<NativeImplRow["seam"]> = {}, module: NativeImplRow["module"] = null): NativeImplRow {
  return {
    seam: { key: "seam:Crypto.generateKey", jsName: "Crypto", jsMethod: "generateKey", status: "linked", firstParty: null, ...over },
    module,
  };
}

test("the Context pane shows a native-impl row for a seam fn and nothing for a non-seam fn", () => {
  const seamFn: NativeImpl = { fn: 30, rows: [row()] };
  const nonSeamFn: NativeImpl = { fn: 31, rows: [] };
  assert.equal(hasNativeImpl(seamFn), true);
  assert.equal(hasNativeImpl(nonSeamFn), false);
  assert.equal(hasNativeImpl(undefined), false);
});

test("nativeImplLabel: jsName.jsMethod when both are known", () => {
  assert.equal(nativeImplLabel(row()), "Crypto.generateKey");
});

test("nativeImplLabel: bare jsName when jsMethod is null (a view-manager seam)", () => {
  assert.equal(nativeImplLabel(row({ jsMethod: null, jsName: "Y" })), "Y");
});

test("nativeImplLabel: falls back to the raw seam key when jsName is unresolved", () => {
  assert.equal(nativeImplLabel(row({ jsName: null, jsMethod: null, key: "seam:Unresolved" })), "seam:Unresolved");
});

test("nativeImplDetail: status + native module kind when linked", () => {
  const linked = row({ status: "linked" }, { key: "native:module:Crypto", jsName: "Crypto", kind: "bridge", firstParty: null });
  assert.equal(nativeImplDetail(linked), "linked -> bridge");
});

test("nativeImplDetail: js-only carries no module suffix", () => {
  const jsOnly = row({ status: "js-only" }, null);
  assert.equal(nativeImplDetail(jsOnly), "js-only");
});

test("nativeImplDetail: first/third-party label appended when known, nothing when null (never guessed)", () => {
  assert.equal(nativeImplDetail(row({ firstParty: true })), "linked · first-party");
  assert.equal(nativeImplDetail(row({ firstParty: false })), "linked · third-party");
  assert.equal(nativeImplDetail(row({ firstParty: null })), "linked");
});
