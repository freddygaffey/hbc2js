// docs/specs/06-harness.md §11 item 1 — port of tools/equiv/test/equiv.test.mjs's
// mutation-operator test (part 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mutants, isCodeMask, syntaxOk, OPERATOR_IDS } from "../../../src/harness/mutate.ts";

test("mutation operators never fire inside comments or string literals", () => {
  const src = `// break the loop here\nconst s = 'do not break this';\nfor (;;) { break; }\n`;
  const mask = isCodeMask(src);
  const first = src.indexOf("break"); // in the comment
  const second = src.indexOf("break", first + 1); // in the string
  const third = src.lastIndexOf("break"); // real code
  assert.equal(mask[first], 0);
  assert.equal(mask[second], 0);
  assert.equal(mask[third], 1);
  const ms = mutants(src, 3, 0).filter((m) => m.operator === "break-to-continue");
  for (const m of ms) assert.match(m.text, /\/\/ break the loop here/);
});

test("mutants() only ever returns syntactically valid, distinct-from-source candidates", () => {
  const src = `function f(a, b) {\n  if (a < b) {\n    return a + b;\n  }\n  return a - b;\n}\nprint(f(1, 2));\n`;
  const ms = mutants(src, 8, 0);
  assert.ok(ms.length > 0, "at least one operator should apply to this source");
  for (const m of ms) {
    assert.notEqual(m.text, src);
    assert.equal(syntaxOk(m.text), true, `mutant from ${m.operator} must be syntactically valid`);
    assert.ok(OPERATOR_IDS.includes(m.operator));
  }
});

test("syntaxOk rejects genuinely broken JS", () => {
  assert.equal(syntaxOk("function ("), false);
  assert.equal(syntaxOk("const x = 1;"), true);
});
