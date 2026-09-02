// tests/fuzz/minimise.test.ts — docs/specs/09-fuzzing.md §8 T3.
// Fuzz-private fixture pair: tests/fuzz/fixtures/minimise-sample.js (a
// synthetic program) + a fake ladder stub (`reproduces`, below) returning
// DIVERGENT iff the MARKER line is present. Never touches
// tests/fixtures/constructs/** or the real oracle ladder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { minimise } from "../../src/fuzzgen/minimise.ts";

const samplePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "minimise-sample.js");
const sample = readFileSync(samplePath, "utf8");

/** Fake ladder stub: "DIVERGENT" iff the marker line survives. */
function reproduces(program: string): boolean {
  return program.includes("print('MARKER');");
}

test("T3(a): minimised program still reproduces the signature", () => {
  assert.ok(reproduces(sample), "precondition: the sample must itself reproduce");
  const min = minimise(sample, reproduces);
  assert.ok(reproduces(min), "minimised program lost the marker");
});

test("T3(b): minimised program's statement (line) count is <= the input's", () => {
  const min = minimise(sample, reproduces);
  const inputLines = sample.split("\n").filter((l) => l.trim().length > 0).length;
  const minLines = min.split("\n").filter((l) => l.trim().length > 0).length;
  assert.ok(minLines <= inputLines, `minimised (${minLines} lines) is not <= input (${inputLines} lines)`);
  assert.ok(minLines < inputLines, `minimiser made no progress at all: ${minLines} lines`);
});

test("T3(c): idempotent — minimising the minimum returns it unchanged", () => {
  const once = minimise(sample, reproduces);
  const twice = minimise(once, reproduces);
  assert.equal(twice, once);
});
