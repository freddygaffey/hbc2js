// docs/CONSOLIDATION.md §B item 8 (modified): "CI fails if test count or
// coverage drops." This enforces the count half. Coverage is not measured by
// this repo's gate; if that changes, extend this file rather than adding a
// second one.
//
// To bump the baseline: only upward, and only in the same commit as the
// tests that justify the increase (new pass, new fixture coverage, etc.).
// Recompute with:
//   find tests/gate -name "*.test.ts" | xargs grep -o "test(" | wc -l
// and write that number into docs/test-count-baseline.json's "gate" field.
// Never lower it to make a failing gate pass — a drop means tests were
// deleted or a file was excluded from the glob, and that is exactly what
// this check exists to catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const gateDir = join(repoRoot(), "tests", "gate");
const baselinePath = join(repoRoot(), "docs", "test-count-baseline.json");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (entry.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Counts `test(` call sites (node:test's `test`, not a `.test(` regex
 *  method — the negative lookbehind excludes any preceding `.` or word
 *  character, so `HEADING_RE.test(` and `contest(` are not counted). */
function testCallCount(text: string): number {
  return (text.match(/(?<![.\w])test\(/g) ?? []).length;
}

test("gate test count never drops below the recorded baseline", () => {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { gate: number };
  const actual = walk(gateDir).reduce((sum, f) => sum + testCallCount(readFileSync(f, "utf8")), 0);
  assert.ok(
    actual >= baseline.gate,
    `gate test count dropped: ${actual} test( call sites under tests/gate, baseline is ${baseline.gate} ` +
      `(docs/test-count-baseline.json) — a drop means tests were deleted or excluded from the run; if this is a ` +
      `deliberate net-new increase, raise the baseline in the same commit as the tests that justify it`,
  );
});
