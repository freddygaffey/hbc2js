// docs/specs/01-parser.md §8 T5 (golden snapshots) and §9 acceptance ("parses all
// gate-tier binaries with zero thrown errors and zero warn-severity diagnostics
// other than those listed in T10").
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parseHbc } from "../../../src/index.ts";
import type { HbcModule } from "../../../src/index.ts";
import { listFixtures } from "../../support/fixtures.ts";
import { checkGolden } from "../../support/golden.ts";
import { repoRoot } from "../../support/paths.ts";

// Diagnostics we know are legitimate for at least one gate fixture (T10 / §6.4 step 4).
const ALLOWED_DIAGNOSTIC_CODES = new Set(["W_OPCODE_TABLE_TIEBREAK"]);

function snapshot(m: HbcModule): unknown {
  return {
    header: {
      ...m.header,
      sourceHash: Buffer.from(m.header.sourceHash).toString("hex"),
      magic: m.header.magic.toString(),
    },
    layout: {
      layoutClass: m.layout.layoutClass,
      version: m.layout.version,
      opcodeTable: m.layout.opcodeTable ?? null,
      probe: {
        chosen: m.layout.probe.chosen,
        forced: m.layout.probe.forced,
        decidedBy: m.layout.probe.decidedBy,
        exhaustive: m.layout.probe.exhaustive,
      },
    },
    sections: m.sections.all,
    strings: Array.from({ length: m.strings.count }, (_, id) => {
      const e = m.strings.entry(id);
      return { id, kind: e.kind, isUTF16: e.isUTF16, length: e.length, text: m.strings.get(id) };
    }),
    shapes: m.shapes,
    bigInts: m.bigInts.map((b) => ({ index: b.index, offset: b.offset, length: b.length, value: b.value().toString() })),
    counts: {
      regExps: m.regExps.length,
      cjsModules: m.cjsModules.length,
      functionSources: m.functionSources.length,
    },
    functions: m.functions.map((f) => ({
      header: f.header,
      name: f.name,
      exceptionHandlers: f.exceptionHandlers,
      debugOffsets: f.debugOffsets,
      bodyShared: f.bodyShared,
    })),
    diagnostics: m.diagnostics,
  };
}

test("every gate-tier binary parses without throwing, with only allowed diagnostics", () => {
  const fixtures = listFixtures();
  let total = 0;
  for (const f of fixtures) {
    for (const b of f.binaries) {
      total++;
      let m: HbcModule;
      try {
        m = parseHbc(b.bytes());
      } catch (e) {
        assert.fail(`${f.group}/${f.name} v${b.version}${b.variant} threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const d of m.diagnostics) {
        assert.ok(ALLOWED_DIAGNOSTIC_CODES.has(d.code), `${f.group}/${f.name} v${b.version}${b.variant}: unexpected diagnostic ${d.code}: ${d.message}`);
      }
    }
  }
  assert.ok(total > 0, "fixture discovery found nothing");
});

test("golden snapshots: stable and match the committed baseline for every gate (fixture, version)", () => {
  const fixtures = listFixtures();
  const mismatches: string[] = [];
  for (const f of fixtures) {
    for (const b of f.binaries) {
      const m = parseHbc(b.bytes());
      const key = f.group === "hermes-dec-sample" ? f.group : join(f.group, f.name);
      const variantSuffix = b.variant === "public" ? "-public" : "";
      const goldenPath = join(repoRoot(), "tests", "golden", key, `v${b.version}${variantSuffix}.json`);
      const result = checkGolden(goldenPath, snapshot(m));
      if (!result.matched) mismatches.push(`${key}/v${b.version}${variantSuffix}`);
    }
  }
  assert.deepEqual(mismatches, [], `golden mismatches (run UPDATE_GOLDEN=1 npm test to refresh if intentional): ${mismatches.join(", ")}`);
});

test("layout.probe.chosen matches D8 expectations for the canonical fixtures", () => {
  const sample = listFixtures({ group: "hermes-dec-sample" })[0]!;
  const chosenByVersion = new Map(sample.binaries.map((b) => [`${b.version}${b.variant}`, parseHbc(b.bytes()).layout.probe]));
  assert.equal(chosenByVersion.get("84")?.chosen, "B/hbc84");
  assert.equal(chosenByVersion.get("94")?.chosen, "C/hbc94");
  assert.equal(chosenByVersion.get("96")?.chosen, "C/hbc96");
  assert.equal(chosenByVersion.get("98")?.chosen, "E/hbc98-late");
  assert.ok(chosenByVersion.get("98")?.decidedBy.includes("D1"));
  assert.equal(chosenByVersion.get("99")?.chosen, "E/hbc99-mar2026");
  assert.equal(chosenByVersion.get("99public")?.chosen, "E/hbc99-mar2026");
});

test("probe.exhaustive is true for every gate fixture (all well under 2MB)", () => {
  for (const f of listFixtures()) {
    for (const b of f.binaries) {
      const m = parseHbc(b.bytes());
      assert.equal(m.layout.probe.exhaustive, true, `${f.group}/${f.name} v${b.version}`);
    }
  }
});
