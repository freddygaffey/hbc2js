// docs/specs/06-harness.md §10 — the invariants table, one test per row.
// Several are exercised more thoroughly as part of another file's own tests;
// this file is the checklist and covers the rows not already load-bearing
// elsewhere, per the table's own "where" column:
//
//   HA-01  three-valued + ERROR, never PASS       -> compare.test.ts, ladder.ts's VERDICT type
//   HA-02  timeout -> `limit`, never `err`        -> sandbox.test.ts
//   HA-03  divergence before a hang stays DIVERGENT -> compare.test.ts
//   HA-04  no-evidence trace is INCONCLUSIVE      -> compare.test.ts
//   HA-05  --hbc never falls back to Node         -> this file
//   HA-06  reference policy fails loudly          -> reference-policy.test.ts
//   HA-07  print projections compared as joined text -> this file
//   HA-08  sandbox determinism, fresh process      -> selftest.test.ts phase 1
//   HA-09  mutation kill rate >= baseline          -> selftest.test.ts phase 2
//   HA-10  round-trip ratchet >= baseline          -> tests/sweep/harness/roundtrip-ratchet.test.ts
//   HA-11  golden traces rewritten only under the update flag -> this file
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findHermesVm, hbcVersion } from "../../../src/harness/hermes-vm.ts";
import { printLines } from "../../../src/harness/trace.ts";
import { checkGoldenTrace } from "../../../src/harness/golden.ts";
import { repoRoot } from "../../support/paths.ts";

test("HA-05: a missing Hermes VM must never fall back to running the .hbc-adjacent JS under Node", () => {
  // Every version this project has no VM for at all must return null, not a
  // Node-backed stand-in.
  assert.equal(findHermesVm(999999), null);
  // Sanity: hbcVersion() reads the real header field, so a genuine version
  // mismatch (asking for a VM at a version the file isn't) is caught before
  // any execution is attempted, not discovered by the VM's own runtime error.
  const anyHbc = fs
    .readdirSync(path.join(repoRoot(), "tests", "fixtures", "constructs"))
    .map((d) => path.join(repoRoot(), "tests", "fixtures", "constructs", d, "v94.hbc"))
    .find((p) => fs.existsSync(p));
  if (anyHbc !== undefined) assert.equal(hbcVersion(anyHbc), 94);
});

test("HA-07: print projections are compared as joined text, not record-by-record (43-template-literals)", () => {
  // docs/EQUIVALENCE.md / spec 06 §3.2: a multi-line template literal is ONE
  // `out` record on the Node side but several lines of raw Hermes stdout.
  // Comparing per-record would report a phantom divergence; joining first
  // (what `printLines(...).join("\n")` + a line-split comparison does) does
  // not.
  const multiLineRecord = { k: "out" as const, ch: "print", s: "line1\nline2\nline3", a: [] as string[] };
  const projected = printLines([multiLineRecord]).join("\n");
  const hermesStyleLines = ["line1", "line2", "line3"];
  assert.equal(projected, hermesStyleLines.join("\n"));
  assert.equal(projected.split("\n").length, 3, "the record's content, once joined and re-split, must recover all three lines");
});

test("HA-11: a golden trace file is rewritten only under HBC2JS_UPDATE_GOLDENS=1 (or UPDATE_GOLDEN=1)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hbc2js-golden-trace-test-"));
  try {
    const file = path.join(dir, "trace.ndjson");
    const traceA = { kind: "full" as const, records: [{ k: "out" as const, ch: "print", s: "a", a: [] }] };
    const traceB = { kind: "full" as const, records: [{ k: "out" as const, ch: "print", s: "b", a: [] }] };

    delete process.env["HBC2JS_UPDATE_GOLDENS"];
    delete process.env["UPDATE_GOLDEN"];

    const first = checkGoldenTrace(file, traceA);
    assert.equal(first.matched, false, "no golden exists yet: must report a mismatch, not silently write one");
    assert.equal(fs.existsSync(file), false, "must not have written the file without the update flag");

    process.env["HBC2JS_UPDATE_GOLDENS"] = "1";
    const written = checkGoldenTrace(file, traceA);
    assert.equal(written.updated, true);
    assert.equal(fs.existsSync(file), true);
    delete process.env["HBC2JS_UPDATE_GOLDENS"];

    const matched = checkGoldenTrace(file, traceA);
    assert.equal(matched.matched, true);

    const mismatched = checkGoldenTrace(file, traceB);
    assert.equal(mismatched.matched, false);
    // Critically: comparing a *different* trace without the update flag must
    // not touch the committed file.
    const onDisk = fs.readFileSync(file, "utf8");
    assert.match(onDisk, /"s":"a"/);
  } finally {
    delete process.env["HBC2JS_UPDATE_GOLDENS"];
    delete process.env["UPDATE_GOLDEN"];
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
