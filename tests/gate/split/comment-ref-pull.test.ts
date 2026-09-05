// tests/gate/split/comment-ref-pull.test.ts — regression for the F24-5
// fallout found by orchestrator gate 92595de (docs/BUGS.md
// `split-comment-ref-pull`).
//
// `splitProject` pulls a referenced-but-undeclared `_fnN` into the module file
// that references it, so no reference in that file resolves to nothing. The
// scan that decides "referenced" used to run over the printed text as a whole,
// comments included -- and `src/emit` prints scope-check comments that name
// functions by their emitted identifier, e.g.
//   // emitted identifier "_fn13844" is not declared in any enclosing scope
//   // (module > _fn0 > _fn525 > _fn5569 > _fn13837)
// After F24-5 (26054f9) hosted capture-nothing functions inside their creator,
// the bundle's GLOBAL function `_fn0` became the lexical parent of most of
// react-navigation-example-0.85.3, and that comment made module_523.js pull the
// global's whole body in: 46 KB -> 28 MB, the whole split 24 MB -> 52 MB, and
// module 523 then matched the segregate navigator shape (6 -> 7).
//
// The properties asserted here are structural and rung-owned: a mention in a
// comment is not a reference, the global function is never copied into a module
// file, and no single module file may hold most of a split project.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { cachedSplitProject as splitProject } from "../../support/decompiled.ts";
import { scanFnIdentifiers } from "../../../src/split/index.ts";
import { parseHbc } from "../../../src/parse/module.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const REACT_NAV_EXAMPLE = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

/** Every `_fnN` a split file DECLARES, read back out of the printed file. */
function declaredIn(text: string): Set<number> {
  return new Set(scanFnIdentifiers(text).declared);
}

void test("split: a function named only inside a comment is not a reference (no pull)", () => {
  const text = [
    "function factory(global, require, module, exports) {",
    '  // emitted identifier "_fn13844" is not declared in any enclosing scope (module > _fn0 > _fn525)',
    "  /* provenance: created by _fn9999 */",
    "  return _fn7(1);",
    "}",
  ].join("\n");
  const found = scanFnIdentifiers(text);
  assert.deepEqual([...new Set(found.referenced)].sort((a, b) => a - b), [7], "only the call in code is a reference; the comment mentions are not");
  assert.deepEqual(found.declared, [], "the factory declares no _fnN");
});

void test("split: a declaration inside a comment is not a declaration, and `//` inside a string is not a comment", () => {
  const commented = "// function _fn5(a) { return a; }\nfunction _fn6() { return _fn5(); }\n";
  const found = scanFnIdentifiers(commented);
  assert.deepEqual(found.declared, [6], "_fn5 is only declared in a comment");
  assert.ok(found.referenced.includes(5), "the live call to _fn5 is still a reference, so it can still be pulled in");

  const stringy = 'const url = "https://x/_fn11"; const f = _fn12;\n';
  const found2 = scanFnIdentifiers(stringy);
  assert.ok(found2.referenced.includes(12), "a `//` inside a string literal must not blind the scan to the code after it");
});

void test("split: no module file holds most of the project, and the global function is never copied into one (rn-template-0.72)", () => {
  const bytes = readFileSync(RN_TEMPLATE);
  const globalIndex = parseHbc(bytes).header.globalCodeIndex;
  const split = splitProject(bytes, { moduleName: "index.android.hbc" });
  const files = [...split.files.entries()].map(([path, content]) => [path, String(content)] as const);
  const total = files.reduce((n, [, c]) => n + c.length, 0);
  const largest = files.reduce((best, f) => (f[1].length > best[1].length ? f : best));
  assert.ok(largest[1].length * 2 < total, `no single split file may hold half the project: ${largest[0]} is ${largest[1].length} of ${total} bytes`);
  for (const [path, content] of files) {
    assert.ok(!declaredIn(content).has(globalIndex), `${path} declares the bundle's global function fn#${globalIndex}; the global's body is the whole program, never a module-local helper`);
  }
});

void test("split: no module file holds most of the project, and the global function is never copied into one (react-navigation-example-0.85.3)", (t) => {
  if (!existsSync(REACT_NAV_EXAMPLE)) {
    t.skip("react-navigation-example-0.85.3 not fetched (run tests/fixtures/bundles/react-navigation-example-0.85.3/fetch.sh)");
    return;
  }
  const bytes = readFileSync(REACT_NAV_EXAMPLE);
  const globalIndex = parseHbc(bytes).header.globalCodeIndex;
  const split = splitProject(bytes, { moduleName: "react-navigation-example.hbc" });
  const files = [...split.files.entries()].map(([path, content]) => [path, String(content)] as const);
  const total = files.reduce((n, [, c]) => n + c.length, 0);
  const largest = files.reduce((best, f) => (f[1].length > best[1].length ? f : best));
  // Pre-fix this was module_523.js at 28 MB of a 52 MB project (54%).
  assert.ok(largest[1].length * 2 < total, `no single split file may hold half the project: ${largest[0]} is ${largest[1].length} of ${total} bytes`);
  for (const [path, content] of files) {
    assert.ok(!declaredIn(content).has(globalIndex), `${path} declares the bundle's global function fn#${globalIndex}; the global's body is the whole program, never a module-local helper`);
  }
});
