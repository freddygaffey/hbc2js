// tests/gate/deps/sigdb-import.test.ts — docs/specs/15-sigdb-schema.md §3 one-shot
// import step. Hand-written fixture JSON (schema 2, matching src/deps/sigdb-types.ts)
// imported into a fresh sqlite; gate-fast, no `deb`, no network. Covers: import +
// completeness check green, round-trip deep-equal via the INDEPENDENT reconstruction
// path (§12 review item 6), and re-running the importer is a no-op (idempotent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  importDirectory,
  verifyCompleteness,
  reconstructFingerprint,
} from "../../../tools/pkgsig/sigdb/import-json.mjs";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

function hash(byte: string): string {
  // 24 lowercase hex chars (12-byte hash), per §1 principle 3.
  return byte.repeat(24);
}

function fixture(overrides: Partial<SigDbFile> & { package: string; version: string }): SigDbFile {
  return {
    schema: 2,
    hbcVersion: 94,
    totalFunctions: 1,
    rawFunctionCount: 1,
    subtractedBaselines: [],
    functions: [
      {
        index: 0,
        name: "f0",
        paramCount: 1,
        instrCount: 5,
        exactHash: hash("a"),
        fuzzyHash: hash("b"),
        stringSetHash: hash("c"),
        stringCount: 2,
      },
    ],
    modules: [],
    toolchainBaseline: false,
    provenance: {
      packageSha256: null,
      metroVersion: "0.80.0",
      reactNativeVersion: "0.74.0",
      hermescVersion: 94,
      hermescRnEra: "0.74",
      repoCommit: null,
      builtAt: "2026-09-03T00:00:00.000Z",
    },
    ...overrides,
  } as SigDbFile;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sigdb-import-test-"));
  const files: Record<string, SigDbFile> = {
    "abbrev@2.0.0__hbc94.json": fixture({
      package: "abbrev",
      version: "2.0.0",
      functions: [
        {
          index: 0,
          name: "abbrev",
          paramCount: 1,
          instrCount: 12,
          exactHash: hash("1"),
          fuzzyHash: hash("2"),
          stringSetHash: hash("3"),
          stringCount: 4,
        },
        {
          index: 1,
          name: "main",
          paramCount: 0,
          instrCount: 30,
          exactHash: hash("4"),
          fuzzyHash: hash("5"),
          stringSetHash: hash("6"),
          stringCount: 7,
        },
      ],
      modules: [
        {
          factoryFunctionIndex: 0,
          localModuleId: 0,
          depCount: 0,
          depIds: [],
          factoryExactHash: hash("1"),
          factoryFuzzyHash: hash("2"),
          nestedFunctionCount: 1,
          functionSetHash: hash("7"),
          factoryIsBaseline: false,
        },
      ],
      totalFunctions: 2,
      rawFunctionCount: 2,
    }),
    // shares function #0's exact/fuzzy/string-set tuple with abbrev@2.0.0's
    // function #0 above (same name/paramCount/instrCount/stringCount too) —
    // exercises function_shapes interning across fingerprints.
    "abbrev@2.0.1__hbc94.json": fixture({
      package: "abbrev",
      version: "2.0.1",
      functions: [
        {
          index: 0,
          name: "abbrev",
          paramCount: 1,
          instrCount: 12,
          exactHash: hash("1"),
          fuzzyHash: hash("2"),
          stringSetHash: hash("3"),
          stringCount: 4,
        },
      ],
    }),
    "lodash@4.17.21__hbc96.json": fixture({
      package: "lodash",
      version: "4.17.21",
      hbcVersion: 96,
      subtractedBaselines: ["_baselines/react-foundation@18.2.0__hbc96.json"],
    }),
    "@amplitude__analytics-react-native@1.4.10__hbc94.json": fixture({
      package: "@amplitude/analytics-react-native",
      version: "1.4.10",
    }),
  };
  for (const [name, sig] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(sig, null, 2));
  }
  mkdirSync(join(dir, "_baselines"));
  const baseline = fixture({
    package: "react-foundation",
    version: "18.2.0",
    hbcVersion: 96,
    toolchainBaseline: true,
  });
  writeFileSync(
    join(dir, "_baselines", "react-foundation@18.2.0__hbc96.json"),
    JSON.stringify(baseline, null, 2),
  );
  return { dir, files, baseline, dbPath: join(dir, "sigdb.sqlite") };
}

test("sigdb import: 4 top-level + 1 baseline fixture imports clean, 0 errors", () => {
  const { dir, dbPath } = setup();
  try {
    const result = importDirectory(dir, dbPath);
    assert.equal(result.totalEnumerated, 5);
    assert.equal(result.topLevelCount, 4);
    assert.equal(result.baselineCount, 1);
    assert.equal(result.imported, 5);
    assert.equal(result.skipped, 0);
    assert.equal(result.errors, 0);
    assert.deepEqual(result.errorFiles, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sigdb import: completeness check (4-part) passes on the fixture set", () => {
  const { dir, dbPath } = setup();
  try {
    importDirectory(dir, dbPath);
    const report = verifyCompleteness(dir, dbPath);
    assert.equal(report.problems.join("\n"), "");
    assert.equal(report.ok, true);
    assert.equal(report.enumeratedTotal, 5);
    assert.equal(report.dbTotal, 5);
    assert.equal(report.errorCount, 0);
    assert.ok(report.roundtripChecked >= 1, "round-trip must check at least the seeded sample + all baselines");
    assert.equal(report.roundtripMismatches, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sigdb import: round-trip reconstruction deep-equals every fixture (independent read path)", () => {
  const { dir, dbPath, files, baseline } = setup();
  try {
    const result = importDirectory(dir, dbPath);
    const db = result.db;
    const all: Record<string, SigDbFile> = { ...files, "_baselines/react-foundation@18.2.0__hbc96.json": baseline };
    for (const [relPath, original] of Object.entries(all)) {
      const row = db.prepare("SELECT fp_id FROM import_log WHERE source_file = ?").get(relPath) as
        | { fp_id: number }
        | undefined;
      assert.ok(row !== undefined && row.fp_id !== null, `${relPath} missing from import_log`);
      const reconstructed = reconstructFingerprint(db, row!.fp_id);
      assert.deepEqual(reconstructed, original, `round-trip mismatch for ${relPath}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sigdb import: interning — shared function tuple lands in one function_shapes row", () => {
  const { dir, dbPath } = setup();
  try {
    const result = importDirectory(dir, dbPath);
    const db = result.db;
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM function_shapes WHERE name = 'abbrev' AND param_count = 1 AND instr_count = 12",
      )
      .get() as { n: number };
    assert.equal(row.n, 1, "the two abbrev@2.0.0/2.0.1 fixtures share one function_shapes row");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sigdb import: re-running the importer on an unchanged store is a no-op (idempotent)", () => {
  const { dir, dbPath } = setup();
  try {
    const first = importDirectory(dir, dbPath);
    assert.equal(first.imported, 5);
    const second = importDirectory(dir, dbPath);
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 5);
    assert.equal(second.errors, 0);
    const report = verifyCompleteness(dir, dbPath);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sigdb import: a changed file under an existing name errors, never silently replaces (A3)", () => {
  const { dir, dbPath } = setup();
  try {
    importDirectory(dir, dbPath);
    const changed = fixture({ package: "abbrev", version: "2.0.0", totalFunctions: 99 });
    writeFileSync(join(dir, "abbrev@2.0.0__hbc94.json"), JSON.stringify(changed, null, 2));
    const result = importDirectory(dir, dbPath);
    assert.equal(result.errors, 1);
    assert.deepEqual(result.errorFiles, ["abbrev@2.0.0__hbc94.json"]);
    const db = result.db;
    const row = db
      .prepare("SELECT total_functions FROM fingerprints f JOIN import_log l ON l.fp_id = f.fp_id WHERE l.source_file = ?")
      .get("abbrev@2.0.0__hbc94.json") as { total_functions: number } | undefined;
    assert.ok(row === undefined || row.total_functions !== 99, "the original row must not be silently replaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
