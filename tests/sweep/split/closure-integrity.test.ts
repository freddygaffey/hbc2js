// docs/BUGS.md "e2e split unmatched-closure" / QUEUE 7 — the fixture that
// actually exhibited the bug: react-navigation-example-0.85.3's `--split`
// output referenced `_fn1953` (and 2187 other `_fnN`s) from module files
// that declared them nowhere — a runtime `ReferenceError`, not merely
// un-round-trippable. Before the src/split/index.ts fix in this commit this
// test failed with ~2188 dangling references; the fix pulls every
// transitively-referenced-but-undeclared function's already-decompiled body
// (`decompileAllBodies`'s `bodies` map, which holds every function
// `emitModule` reaches, orphans included) into the referencing module's own
// file. INCONCLUSIVE-via-skip (not a failure) when the sweep tier isn't
// requested or the fixture's `.hbc` isn't present locally (run its
// `fetch.sh` first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { requireSweep } from "../../support/tiers.ts";
import { splitProject } from "../../../src/split/index.ts";

const HBC = join(repoRoot(), "tests", "fixtures", "bundles", "react-navigation-example-0.85.3", "react-navigation-example.hbc");

test("react-navigation-example-0.85.3: --split has no _fnN referenced but declared in no module file", (t) => {
  if (!requireSweep(t)) return;
  if (!existsSync(HBC)) {
    t.skip(`${HBC} not present — run this fixture's fetch.sh first (INCONCLUSIVE, not a failure)`);
    return;
  }
  const bytes = readFileSync(HBC);
  const result = splitProject(bytes, { moduleName: "react-navigation-example.hbc" });
  const missing: { file: string; name: string }[] = [];
  for (const [file, code] of result.files) {
    if (!file.startsWith("module_")) continue;
    const declared = new Set<string>();
    for (const m of code.matchAll(/function (_fn\d+)\(/g)) declared.add(m[1]!);
    const referenced = new Set<string>();
    for (const m of code.matchAll(/\b(_fn\d+)\b/g)) referenced.add(m[1]!);
    for (const name of referenced) if (!declared.has(name)) missing.push({ file, name });
  }
  assert.deepEqual(missing.slice(0, 5), [], `${missing.length} dangling _fnN reference(s), e.g. ${JSON.stringify(missing.slice(0, 5))}`);
});
