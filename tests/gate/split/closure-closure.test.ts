// docs/BUGS.md "e2e split unmatched-closure" / QUEUE 7 — a module file must
// never reference a `_fnN` identifier that is declared in no file of the
// split tree: at runtime that is a `ReferenceError`, not merely
// un-round-trippable (react-navigation's `module_8.js` calling an undeclared
// `_fn1953` was the reported case). This gate test uses only the committed
// rn-template fixture (fast); the fixture that actually exhibited the bug
// (react-navigation-example-0.85.3, 2188 dangling references pre-fix) lives
// in the sweep tier: `tests/sweep/split/closure-integrity.test.ts`. On
// rn-template itself this invariant already held before the fix (its BUGS.md
// "38" is a *different*, still-open cause — closures hermesc's optimizer
// drops because nothing reads the register — not a missing declaration; see
// that row), so this test is a standing regression guard rather than a
// before/after demonstration; the demonstration is the sweep test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { splitProject } from "../../../src/split/index.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

/** Every `_fnN` referenced in a module file's text must be declared
 *  (`function _fnN(`, whether a hoisted sibling statement or an inline named
 *  function expression — both print with that same prefix, see
 *  `src/emit/print.ts`'s "func" case) somewhere in that same file's text. */
function danglingReferences(files: ReadonlyMap<string, string>): { file: string; name: string }[] {
  const missing: { file: string; name: string }[] = [];
  for (const [file, code] of files) {
    if (!file.startsWith("module_")) continue;
    const declared = new Set<string>();
    for (const m of code.matchAll(/function (_fn\d+)\(/g)) declared.add(m[1]!);
    const referenced = new Set<string>();
    for (const m of code.matchAll(/\b(_fn\d+)\b/g)) referenced.add(m[1]!);
    for (const name of referenced) if (!declared.has(name)) missing.push({ file, name });
  }
  return missing;
}

for (const passes of [undefined, {}] as const) {
  test(`--split: every _fnN referenced in a module file is declared in that file (passes ${passes === undefined ? "off" : "on"})`, () => {
    const bytes = readFileSync(RN_TEMPLATE);
    const result = splitProject(bytes, { moduleName: "index.android.hbc", ...(passes !== undefined ? { passes } : {}) });
    const missing = danglingReferences(result.files);
    assert.deepEqual(missing.slice(0, 5), [], `${missing.length} dangling _fnN reference(s), e.g. ${JSON.stringify(missing.slice(0, 5))}`);
  });
}
