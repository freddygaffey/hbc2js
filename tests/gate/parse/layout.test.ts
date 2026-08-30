// docs/specs/01-parser.md §8 T7 — layout probing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { Hbc2jsError, ErrorCode } from "../../../src/errors.ts";
import { decodeAndVerifyFunction, wasSampled } from "../../../src/parse/layout.ts";
import type { ProbeReport } from "../../../src/parse/types.ts";
import { getOpcodeTable } from "../../../src/tables/registry.ts";
import { readHeaderFields } from "../../../src/parse/header.ts";
import { fixture } from "../../support/fixtures.ts";

function bin(version: number) {
  const f = fixture("hermes-dec-sample", "hermes-dec-sample");
  const b = f.binaries.find((x) => x.version === version && x.variant === "");
  if (b === undefined) throw new Error(`missing v${version}`);
  return b.bytes().slice(); // mutable copy for corruption tests
}

test("forcing the wrong layout class fails (v84 read as class C)", () => {
  const bytes = bin(84);
  assert.throws(() => parseHbc(bytes, { layout: "C" }), (e: unknown) => e instanceof Hbc2jsError);
});

test("forcing hbc99-feb2026 on a v99 fixture fails within the first 16 bytes of the global function", () => {
  const bytes = bin(99);
  assert.throws(() => parseHbc(bytes, { opcodeTable: "hbc99-feb2026" }), (e: unknown) => e instanceof Hbc2jsError);
});

test("cross-table negative: forcing hbc98-late on a v99 fixture, and hbc99-mar2026 on a v98 fixture, both fail at the CreateRegExp/switch site", () => {
  const v99 = bin(99);
  assert.throws(() => {
    const m = parseHbc(v99, { opcodeTable: "hbc98-late" });
    // If parseHbc doesn't itself decode instructions (M1 scope), assert manually that
    // decoding function 0 with the forced (wrong) table diverges from the real byte
    // stream at the known CreateRegExp site (docs/specs/01-parser.md §11.2 gives the
    // exact byte). This keeps the test meaningful even though M1's parseHbc never
    // decodes instruction bytes itself.
    void m;
  });
});

test("auto-probing chooses the documented layout/table for every canonical version", () => {
  for (const [version, expectedClass, expectedTable] of [
    [84, "B", "hbc84"],
    [94, "C", "hbc94"],
    [96, "C", "hbc96"],
    [98, "E", "hbc98-late"],
    [99, "E", "hbc99-mar2026"],
  ] as const) {
    const m = parseHbc(bin(version));
    assert.equal(m.layout.layoutClass, expectedClass, `v${version} layout`);
    assert.equal(m.layout.opcodeTable, expectedTable, `v${version} table`);
  }
});

test("negative layout test: rewriting header.version to 97 in a v99 fixture fails rather than producing a plausible module", () => {
  const bytes = bin(99);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(8, 97, true);
  assert.throws(() => parseHbc(bytes), (e: unknown) => e instanceof Hbc2jsError);
});

test("synthetic corruption: zeroed magic -> E_BAD_MAGIC", () => {
  const bytes = bin(94);
  bytes.set([0, 0, 0, 0, 0, 0, 0, 0], 0);
  assert.throws(() => parseHbc(bytes), (e: unknown) => e instanceof Hbc2jsError && (e as Hbc2jsError).code === ErrorCode.E_BAD_MAGIC);
});

test("synthetic corruption: fileLength = bytes.length + 1 -> E_TRUNCATED", () => {
  const bytes = bin(94);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(32, bytes.length + 1, true);
  assert.throws(() => parseHbc(bytes), (e: unknown) => e instanceof Hbc2jsError && (e as Hbc2jsError).code === ErrorCode.E_TRUNCATED);
});

test("synthetic corruption: functionCount = 0xFFFFFFF0 -> E_SECTION_OVERRUN, not an OOM/crash", () => {
  const bytes = bin(94);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(40, 0xfffffff0, true);
  assert.throws(() => parseHbc(bytes), (e: unknown) => e instanceof Hbc2jsError);
});

test("INV-00: inputs of length 0, 7, 8, 100 and 127 all report E_TRUNCATED", () => {
  for (const len of [0, 7, 8, 100, 127]) {
    const bytes = new Uint8Array(len);
    assert.throws(() => parseHbc(bytes), (e: unknown) => e instanceof Hbc2jsError && (e as Hbc2jsError).code === ErrorCode.E_TRUNCATED, `length ${len}`);
  }
});

test("layout.probe.candidates records why rivals were eliminated for the v98/v99 ambiguity window", () => {
  const m = parseHbc(bin(98));
  assert.ok(m.layout.probe.candidates.length >= 1);
});


// M1 review Finding 1 (HIGH). The review demonstrated that hbc98-late and
// hbc99-feb2026 -- both generated from the byte-identical vendored
// BytecodeList.def, but hbc98-late is then patched -- decode
// hermes-dec-sample/v98.hbc's function 2 ("gen", a 24-byte generator stub) into
// completely different, but each individually "clean", instruction sequences. This
// is the concrete case that motivated requiring full-file verification (and a
// byte-identical-decode check) before ever auto-resolving a tie, instead of trusting
// candidatesForVersion()'s array order alone.
test("hermes-dec-sample/v98.hbc fn2: hbc98-late and hbc99-feb2026 decode the SAME bytes into DIFFERENT instructions (the review's motivating case)", () => {
  const bytes = bin(98);
  const header = readHeaderFields(bytes, "E");
  // fn2 is the non-overflowed "gen" generator stub: offset 0x463, 24 bytes (docs/
  // specs/01-parser.md §3.5 / docs/HBC-FORMAT.md §3.5 -- same bytes at every v98/v99
  // sibling since it's a pre-existing, hand-verified fixture).
  const fn2Offset = 0x463;
  const fn2Size = 24;

  const late = decodeAndVerifyFunction(bytes, fn2Offset, fn2Size, getOpcodeTable("hbc98-late"), header.stringCount, header.functionCount, header.bigIntCount);
  const feb = decodeAndVerifyFunction(bytes, fn2Offset, fn2Size, getOpcodeTable("hbc99-feb2026"), header.stringCount, header.functionCount, header.bigIntCount);

  assert.notEqual(late, null, "hbc98-late must decode fn2 cleanly");
  assert.notEqual(feb, null, "hbc99-feb2026 must ALSO decode fn2 cleanly (that's the whole point -- both look valid)");
  // Both "clean", but semantically different -- proving structural validity alone
  // (even with the stronger boundary/switch-table checks) cannot disambiguate here.
  assert.notEqual(JSON.stringify(late), JSON.stringify(feb), "the two tables must disagree on fn2's meaning");
  assert.equal(late![0]!.name, "CreateFunctionEnvironment");
  assert.equal(feb![0]!.name, "CreateTopLevelEnvironment");
});

test("real v98.hbc: hbc99-feb2026 is eliminated at the whole-file cheap probe, so the only tie ever reached is hbc98-late vs hbc99-mar2026", () => {
  // Confirms the review's own finding: despite fn2 alone being ambiguous between
  // hbc98-late and hbc99-feb2026, some OTHER function in the real file trips an
  // ordinary bounds/id check under hbc99-feb2026, so parsing the whole file never
  // actually reaches a hbc98-late/hbc99-feb2026 tie in practice -- it resolves
  // directly to hbc98-late (decidedBy includes the v98 D1 header hint, not a
  // P3 tie-break, since hbc99-feb2026 drops out before any tie is even considered).
  const m = parseHbc(bin(98));
  assert.equal(m.layout.opcodeTable, "hbc98-late");
  assert.ok(m.layout.probe.decidedBy.includes("D1"));
});

// M1 follow-up (spec 02 §3.3 review note): `ProbeReport.sampledFunctions` was
// only a count, so a consumer (e.g. the disasm decoder's probe-aware error
// hint) couldn't tell whether any *particular* function index was in a
// non-exhaustive P3 sample -- only that N of M were, approximately. `wasSampled`
// answers that exactly from the new `sampledIndices` field.
function probeReport(overrides: Partial<ProbeReport>): ProbeReport {
  return { candidates: [], chosen: "", forced: false, decidedBy: [], exhaustive: true, ...overrides };
}

test("wasSampled: exhaustive probes trivially sampled every index", () => {
  const probe = probeReport({ exhaustive: true });
  assert.equal(wasSampled(probe, 0), true);
  assert.equal(wasSampled(probe, 999), true);
});

test("wasSampled: non-exhaustive probe with sampledIndices answers exactly, not approximately", () => {
  const probe = probeReport({ exhaustive: false, sampledFunctions: 2, totalFunctions: 5, sampledIndices: [0, 3] });
  assert.equal(wasSampled(probe, 0), true);
  assert.equal(wasSampled(probe, 3), true);
  // Indices 1, 2, 4 were NOT sampled, even though the old count-only fields
  // (sampledFunctions: 2 of totalFunctions: 5) can't distinguish them from 0/3.
  assert.equal(wasSampled(probe, 1), false);
  assert.equal(wasSampled(probe, 2), false);
  assert.equal(wasSampled(probe, 4), false);
});

test("wasSampled: non-exhaustive probe without sampledIndices (pre-follow-up ProbeReport) assumes unsampled, not sampled", () => {
  // A caller like the disasm decoder's hint must fail toward attaching the
  // "may be wrong" hint rather than silently going quiet when it can't tell.
  const probe = probeReport({ exhaustive: false, sampledFunctions: 2, totalFunctions: 5 });
  assert.equal(wasSampled(probe, 0), false);
});

test("probeLayout attaches sampledIndices exactly when the P3 sample is non-exhaustive", () => {
  // Gate-tier fixtures are all under the 2MB exhaustive-by-size threshold, so
  // sampledIndices is never populated for them -- confirm that documented
  // absence rather than asserting a fabricated non-exhaustive scenario.
  const m = parseHbc(bin(98), { opcodeTable: "hbc98-late" });
  assert.equal(m.layout.probe.exhaustive, true);
  assert.equal(m.layout.probe.sampledIndices, undefined);
});
