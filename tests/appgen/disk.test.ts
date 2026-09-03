// docs/specs/09-fuzzing.md §2.4: "Preflight: refuse to start if free disk <
// 15 GB." tools/appgen/build.mjs calls preflightDiskCheck() before touching
// any workspace or npm cache; this test exercises the check directly
// (no real build) against both a threshold the current machine's real free
// space cannot meet (forces refusal) and one it trivially can (forces pass),
// so the assertion holds regardless of how much disk the test machine
// actually has free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freeBytes, preflightDiskCheck, MIN_FREE_BYTES } from "../../tools/appgen/lib/disk.mjs";

test("preflightDiskCheck: refuses when the required minimum exceeds real free space", () => {
  const impossiblyHigh = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => preflightDiskCheck(process.cwd(), { minFreeBytes: impossiblyHigh }),
    /appgen preflight/,
  );
});

test("preflightDiskCheck: passes when the required minimum is trivially small", () => {
  assert.doesNotThrow(() => preflightDiskCheck(process.cwd(), { minFreeBytes: 1 }));
});

test("preflightDiskCheck: default bound is the spec's 15 GB (docs/specs/09-fuzzing.md §2.4)", () => {
  assert.equal(MIN_FREE_BYTES, 15 * 1024 * 1024 * 1024);
});

test("freeBytes: returns a positive number for the repo root", () => {
  const free = freeBytes(process.cwd());
  assert.ok(free > 0);
});
