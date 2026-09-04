// tests/ui-core/disasm-offset.test.ts — docs/UI.md "view.copyDisasmOffset"
// copies a real byte offset now (`fn:<n>@0x<hex>`), not the old `fn:<n>`
// placeholder. `src/ui-core/disasm-offset.ts` is the whole formatting rule;
// the action just calls it with `FnSummary.offset`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDisasmOffset } from "../../src/ui-core/disasm-offset.ts";

test("a known offset formats as fn:<n>@0x<hex>", () => {
  assert.equal(formatDisasmOffset(188, 0), "fn:188@0x0");
  assert.equal(formatDisasmOffset(188, 4096), "fn:188@0x1000");
  assert.equal(formatDisasmOffset(0, 255), "fn:0@0xff");
});

test("a fractional offset truncates rather than throwing", () => {
  assert.equal(formatDisasmOffset(5, 16.7), "fn:5@0x10");
});

test("no offset (undefined/null/negative/non-finite) falls back to the old fn:<n> shape", () => {
  assert.equal(formatDisasmOffset(7, undefined), "fn:7");
  assert.equal(formatDisasmOffset(7, null), "fn:7");
  assert.equal(formatDisasmOffset(7, -1), "fn:7");
  assert.equal(formatDisasmOffset(7, Number.NaN), "fn:7");
  assert.equal(formatDisasmOffset(7, Number.POSITIVE_INFINITY), "fn:7");
});
