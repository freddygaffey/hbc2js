// docs/specs/09-fuzzing.md §8 T1 — spec self-consistency (runs pre-implementation).
// Keeps later edits from silently deleting the decision-8 reviewable targets:
// the metric/target/method/held-out quadruples for components A and B, the
// run-cost bounds, the v98 roundtrip-only rule, and the deb disk preflight.
// Run: node --test "tests/fuzz/**/*.test.ts"
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const specPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "docs", "specs", "09-fuzzing.md",
);
const spec = readFileSync(specPath, "utf8");

/** Text of the spec between two heading markers (to end of file if `to` absent). */
function section(from: string, to?: string): string {
  const start = spec.indexOf(from);
  assert.notEqual(start, -1, `spec is missing heading marker ${JSON.stringify(from)}`);
  const end = to === undefined ? spec.length : spec.indexOf(to, start);
  assert.notEqual(end, -1, `spec is missing heading marker ${JSON.stringify(to)}`);
  return spec.slice(start, end);
}

const QUAD = ["(i) Metric", "(ii) Target", "(iii) Measurement method", "(iv) Held-out check"];

test("decision-8 quadruple present for component A (§1.5)", () => {
  const s = section("### 1.5", "### 1.6");
  for (const item of QUAD) assert.ok(s.includes(item), `§1.5 missing "${item}"`);
});

test("decision-8 quadruple present for component B (§2.5)", () => {
  const s = section("### 2.5", "### 2.6");
  for (const item of QUAD) assert.ok(s.includes(item), `§2.5 missing "${item}"`);
});

test("run-cost sections carry numeric wall-clock and disk bounds (§1.6, §2.6)", () => {
  for (const [from, to] of [["### 1.6", "\n---"], ["### 2.6", "\n---"]] as const) {
    const s = section(from, to);
    assert.ok(s.includes("Wall-clock"), `${from} missing a wall-clock bound`);
    assert.ok(s.includes("Disk"), `${from} missing a disk bound`);
    // At least one numeric time cap and one numeric size cap, e.g. "30 min", "1 h", "50 MB", "6 GB".
    assert.match(s, /\d+\s*\**\s*(min|h)\b/, `${from} has no numeric time cap`);
    assert.match(s, /\d+\s*\**\s*[GM]B\b/, `${from} has no numeric size cap`);
  }
});

test("A targets are concrete numbers (§1.5.ii)", () => {
  const s = section("### 1.5", "### 1.6");
  assert.match(s, /10,000 programs/, "campaign size target missing");
  assert.match(s, /5 per 1,000/, "divergence-rate target missing");
});

test("B targets are concrete numbers (§2.5.ii)", () => {
  const s = section("### 2.5", "### 2.6");
  assert.match(s, /10 live map-bearing triples/, "triple-count target missing");
  assert.match(s, /85\s*%/, "held-out generalisation target missing");
});

test("v98 rule: roundtrip-only lane is stated (§1.3)", () => {
  const s = section("### 1.3", "### 1.4");
  assert.ok(s.includes("roundtrip-only"), "§1.3 must state the v98 roundtrip-only mode");
  assert.match(s, /none for 98/i, "§1.3 must state that no v98 trace VM exists");
});

test("deb disk preflight bound is stated (§2.4)", () => {
  const s = section("### 2.4", "### 2.5");
  assert.match(s, /free disk\s*<\s*\**15 GB/, "§2.4 must carry the 15 GB preflight refusal");
  assert.match(s, /24 triples/, "§2.4 must carry the stored-triple cap");
});

test("held-out list location and readers are pinned (§3.2)", () => {
  const s = section("### 3.2", "### 3.3");
  assert.ok(s.includes("tests/fixtures/appgen/heldout.json"), "held-out list path missing");
  assert.ok(s.includes("appgen-benchmark.mjs") && s.includes("corpus-regression.mjs"),
    "the two allowed readers must be named");
});
