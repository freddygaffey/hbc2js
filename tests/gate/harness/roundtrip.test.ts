// docs/specs/06-harness.md §6, §11 items 1 and 5 — round-trip normaliser and
// per-function ratchet. Reproduces docs/EQUIVALENCE.md §4.3's measured result
// using the example files it names (tests/fixtures/harness/rt-*.js, ported
// verbatim from tools/equiv/examples/), compiled fresh with hermesc rather
// than by hand-writing fake `hermesc -dump-bytecode` text: this port's
// normaliser (src/harness/roundtrip.ts) operates structurally on our own
// decoder's output, not on regex-parsed dump text, so it needs real bytecode
// to exercise (see that module's doc comment for why).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
import { repoRoot } from "../../support/paths.ts";
import { requireOracles } from "../../support/tiers.ts";
import { roundTripFromBytes, diffNormalised, normaliseModule } from "../../../src/harness/roundtrip.ts";
import { parseHbc } from "../../../src/index.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const EXAMPLES = join(repoRoot(), "tests", "fixtures", "harness");

function compile(version: 84 | 94 | 96 | 98 | 99, sourcePath: string): Uint8Array {
  const hermesc = findHermesc(version);
  if (hermesc === null) throw new Error(`hermesc v${version} not found`);
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-roundtrip-test-"));
  try {
    const name = sourcePath.split("/").pop()!;
    const src = join(dir, name);
    writeFileSync(src, readFileSync(sourcePath, "utf8"));
    const out = join(dir, "out.hbc");
    const r = runHermesc(hermesc, ["-emit-binary", `-out=${out}`, name], dir);
    assert.equal(r.status, 0, `hermesc failed: ${r.stderr}`);
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("end-to-end: the round-trip examples exist verbatim (spec 06 §11 item 5)", () => {
  for (const f of ["rt-original.js", "rt-decompiled-ok.js", "rt-decompiled-noisy.js", "sample-mutated.js"]) {
    assert.ok(readFileSync(join(EXAMPLES, f), "utf8").length > 0, f);
  }
});

test("rt-original.js vs rt-decompiled-ok.js: register/idiom differences normalise away completely", (t) => {
  if (findHermesc(94) === null) {
    if (requireOracles()) throw new Error("hermesc v94 required (HBC2JS_REQUIRE_ORACLES=1)");
    t.skip("hermesc v94 not found (run tools/get-hermesc.sh 94)");
    return;
  }
  const a = compile(94, join(EXAMPLES, "rt-original.js"));
  const b = compile(94, join(EXAMPLES, "rt-decompiled-ok.js"));
  const report = roundTripFromBytes(a, b);
  assert.equal(report.functionCountMismatch, null);
  assert.equal(report.ratchet, 1, `expected an exact normalised match; got ${report.exactFunctions}/${report.totalFunctions}`);
});

test("rt-original.js vs rt-decompiled-noisy.js: one idiom change (`x++` vs `x = x + 1`) cascades to a real mismatch", (t) => {
  if (findHermesc(94) === null) {
    if (requireOracles()) throw new Error("hermesc v94 required (HBC2JS_REQUIRE_ORACLES=1)");
    t.skip("hermesc v94 not found (run tools/get-hermesc.sh 94)");
    return;
  }
  const a = compile(94, join(EXAMPLES, "rt-original.js"));
  const b = compile(94, join(EXAMPLES, "rt-decompiled-noisy.js"));
  const report = roundTripFromBytes(a, b);
  assert.equal(report.functionCountMismatch, null);
  assert.ok(report.ratchet < 1, "docs/EQUIVALENCE.md §4.3: this is the documented false-positive case — it must NOT normalise as exact");
  const na = normaliseModule(parseHbc(a));
  const nb = normaliseModule(parseHbc(b));
  const d = diffNormalised(na, nb);
  assert.equal(d.equal, false);
  assert.ok(d.similarity < 1 && d.similarity > 0, `similarity ${d.similarity} should be a real partial-match ratio, not 0 or 1`);
});

test("a genuine opcode difference is still detected, not normalised away", (t) => {
  if (findHermesc(94) === null) {
    if (requireOracles()) throw new Error("hermesc v94 required (HBC2JS_REQUIRE_ORACLES=1)");
    t.skip("hermesc v94 not found (run tools/get-hermesc.sh 94)");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-roundtrip-test-"));
  try {
    writeFileSync(join(dir, "a.js"), "function f(x) { return x + 1; }\nprint(f(1));\n");
    writeFileSync(join(dir, "b.js"), "function f(x) { return x - 1; }\nprint(f(1));\n");
    const hermesc = findHermesc(94)!;
    const ra = runHermesc(hermesc, ["-emit-binary", "-out=a.hbc", "a.js"], dir);
    const rb = runHermesc(hermesc, ["-emit-binary", "-out=b.hbc", "b.js"], dir);
    assert.equal(ra.status, 0);
    assert.equal(rb.status, 0);
    const bytesA = new Uint8Array(readFileSync(join(dir, "a.hbc")));
    const bytesB = new Uint8Array(readFileSync(join(dir, "b.hbc")));
    const report = roundTripFromBytes(bytesA, bytesB);
    assert.notEqual(report.ratchet, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diffNormalised on identical inputs reports equal with similarity 1", () => {
  const lines = ["fn(0) global", "LoadConstZero %0", "Ret %0"];
  const d = diffNormalised(lines, lines.slice());
  assert.equal(d.equal, true);
  assert.equal(d.similarity, 1);
  assert.equal(d.firstDivergence, null);
});
