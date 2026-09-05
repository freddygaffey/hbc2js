// tests/gate/ui/fn-rename-name-surfaces.test.ts — every pane that names a
// function must go through ONE precedence (`acceptedName > overlayName >
// name`), or a rename looks like it did nothing (Fred, 2026-09-05: "Rename
// doesn't work in the UI" — the breadcrumb read `overlayName ?? name` and
// `contracts.ts` did not even declare `acceptedName`, so no pane using the
// shared helper could see it either).
//
// Pure file scanning, like actions-registry.test.ts / rename-dialog.test.ts:
// no ui/node_modules needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const uiSrc = join(repoRoot(), "ui", "src");
const read = (...parts: readonly string[]): string => readFileSync(join(uiSrc, ...parts), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(p);
  }
  return out;
}

test("contracts.ts declares acceptedName on FnSummary, so displayName can see it", () => {
  const contracts = read("contracts.ts");
  assert.match(contracts, /readonly acceptedName\?: string;/, "FnSummary must carry the accepted rename the server sends");
});

test("the TopBar breadcrumb names a function through displayName, not its own precedence", () => {
  const bar = read("panes", "TopBar.tsx");
  assert.match(bar, /displayName\(fn, meta\.data\)/, "the breadcrumb must use the shared name helper");
  assert.doesNotMatch(bar, /overlayName \?\? /, "reading overlayName directly skips the accepted rename — that was the bug");
});

test("no pane re-implements the name precedence with `overlayName ?? name`", () => {
  const offenders = walk(uiSrc)
    .filter((p) => /overlayName \?\? [\w.?]*name/.test(readFileSync(p, "utf8")))
    // The two name helpers ARE the precedence; contracts/mock only declare it.
    .filter((p) => !p.endsWith(join("actions", "names.ts")) && !p.endsWith(join("listing", "names.ts")));
  assert.deepEqual(offenders, [], "these files must call displayName instead of merging names themselves");
});
