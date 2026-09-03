// tests/gate/deps/sigdb-writepath.test.ts — docs/specs/15-sigdb-schema.md §10
// step 4 (write-path dispatch): `writeSignature` (src/deps/db.ts) writes a
// fingerprint through either the legacy JSON layer or a sigdb v3 `.sqlite`
// file depending on whether its `dir` argument ends in `.sqlite`, and
// `loadSignatures` reads either kind of layer back transparently. Asserts
// round-trip equivalence: the same `SigDbFile` written via each path and
// read back via `loadSignatures` produces the same signature data. Gate-fast
// (in-process sqlite via node:sqlite, tmp dirs), no `deb`, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSignatures, writeSignature } from "../../../src/deps/db.ts";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

function hash(byte: string): string {
  // 24 lowercase hex chars (12-byte hash), per docs/specs/15-sigdb-schema.md §1.3.
  return byte.repeat(24);
}

function fixture(): SigDbFile {
  return {
    schema: 2,
    package: "left-pad",
    version: "1.3.0",
    hbcVersion: 94,
    totalFunctions: 2,
    rawFunctionCount: 2,
    subtractedBaselines: ["react-native@0.74.0__hbc94.json"],
    functions: [
      {
        index: 0,
        name: "leftPad",
        paramCount: 2,
        instrCount: 14,
        exactHash: hash("1"),
        fuzzyHash: hash("2"),
        stringSetHash: hash("3"),
        stringCount: 3,
      },
      {
        index: 1,
        name: "main",
        paramCount: 0,
        instrCount: 6,
        exactHash: hash("4"),
        fuzzyHash: hash("5"),
        stringSetHash: hash("6"),
        stringCount: 1,
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
  };
}

test("writeSignature: JSON path (dir without .sqlite suffix) is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "sigdb-writepath-json-"));
  try {
    const db = fixture();
    const written = writeSignature(dir, db);
    assert.ok(written.endsWith(".json"), `expected a .json path, got ${written}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSignature/loadSignatures: DB path round-trips the same fingerprint as the JSON path", () => {
  const jsonDir = mkdtempSync(join(tmpdir(), "sigdb-writepath-json-"));
  const sqliteDir = mkdtempSync(join(tmpdir(), "sigdb-writepath-sqlite-"));
  try {
    const db = fixture();

    writeSignature(jsonDir, db);
    const sqlitePath = join(sqliteDir, "sigdb.sqlite");
    const writtenSqlite = writeSignature(sqlitePath, db);
    assert.equal(writtenSqlite, sqlitePath, "sqlite dispatch returns the .sqlite path itself");

    const [fromJson] = loadSignatures([{ name: "project", dir: jsonDir }]);
    const [fromSqlite] = loadSignatures([{ name: "project", dir: sqliteDir }]);

    assert.ok(fromJson !== undefined, "JSON layer produced no signature");
    assert.ok(fromSqlite !== undefined, "sqlite layer produced no signature");

    // Round-trip equivalence: same package identity, same function/module
    // data, modulo the `path`/`layer` bookkeeping fields loadSignatures adds
    // per-layer (those legitimately differ — a JSON file path vs the DB path).
    assert.deepEqual(fromSqlite!.file, fromJson!.file);
  } finally {
    rmSync(jsonDir, { recursive: true, force: true });
    rmSync(sqliteDir, { recursive: true, force: true });
  }
});

test("loadSignatures: a layer directory with no sigdb.sqlite and no JSON falls back to empty, not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "sigdb-writepath-empty-"));
  try {
    const loaded = loadSignatures([{ name: "project", dir }]);
    assert.deepEqual(loaded, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
