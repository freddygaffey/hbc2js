// docs/specs/01-parser.md §8 T6 — oracle cross-check against hermes-dec's
// `hbc-file-parser`. Reading its STDOUT is allowed; reading its source is forbidden
// (D4/R6) — this file does neither; see tests/support/oracles.ts.
// Known-divergence allowlist: tests/gate/oracle/known-divergences.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { listFixtures } from "../../support/fixtures.ts";
import { requireOracle, runOracle } from "../../support/oracles.ts";

interface OracleDump {
  readonly header: ReadonlyMap<string, string>;
  readonly strings: readonly { kind: "String" | "Identifier"; raw: string }[];
  readonly functions: readonly { index: number; name: string; size: number; paramCount: number; offset: number }[];
}

const HEADER_ROW_RE = /^\|\s*([A-Za-z]+)\s*\|\s*(.*?)\s*\|$/;
const STRING_ROW_RE = /^=> <StringKind\.(String|Identifier): \d+>: '(.*)'$/;
const FUNCTION_ROW_RE = /^=> \[Function #(\d+) (.*) of (\d+) bytes]: (\d+) params(?: @ offset 0x([0-9a-fA-F]+))?/;

function parseOracleDump(stdout: string): OracleDump {
  const header = new Map<string, string>();
  const strings: { kind: "String" | "Identifier"; raw: string }[] = [];
  const functions: { index: number; name: string; size: number; paramCount: number; offset: number }[] = [];
  for (const line of stdout.split("\n")) {
    const h = HEADER_ROW_RE.exec(line);
    if (h !== null && h[1] !== "" && !/^-+$/.test(h[2] ?? "")) {
      header.set(h[1]!, h[2]!);
      continue;
    }
    const s = STRING_ROW_RE.exec(line);
    if (s !== null) {
      strings.push({ kind: s[1] as "String" | "Identifier", raw: s[2]! });
      continue;
    }
    const f = FUNCTION_ROW_RE.exec(line);
    if (f !== null) {
      functions.push({ index: Number(f[1]), name: f[2]!, size: Number(f[3]), paramCount: Number(f[4]), offset: f[5] !== undefined ? parseInt(f[5], 16) : -1 });
    }
  }
  return { header, strings, functions };
}

/** Best-effort Python str-repr unescape, for the common escapes observed in this
 *  oracle's output. Returns null when it hits something not confidently reversible
 *  (content comparison for that entry is then skipped, not failed — the count/kind
 *  cross-check still runs for every entry regardless). */
function unescapePythonRepr(raw: string): string | null {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    if (next === "\\") {
      out += "\\";
      i++;
    } else if (next === "'") {
      out += "'";
      i++;
    } else if (next === "n") {
      out += "\n";
      i++;
    } else if (next === "r") {
      out += "\r";
      i++;
    } else if (next === "t") {
      out += "\t";
      i++;
    } else if (next === "x" && i + 3 < raw.length) {
      out += String.fromCharCode(parseInt(raw.slice(i + 2, i + 4), 16));
      i += 3;
    } else {
      return null;
    }
  }
  return out;
}

test("hbc-file-parser cross-check: header fields, string kinds/count, function table", (t) => {
  const bin = requireOracle(t, "hbc-file-parser");
  if (bin === null) return;

  const fixtures = listFixtures({ group: "hermes-dec-sample" });
  for (const f of fixtures) {
    for (const b of f.binaries) {
      const { status, stdout } = runOracle(bin, [b.path]);
      assert.equal(status, 0, `hbc-file-parser exited ${status} on ${b.path}`);
      const oracle = parseOracleDump(stdout);
      const m = parseHbc(b.bytes());

      const checkHeader = (field: string, ours: number): void => {
        const theirs = oracle.header.get(field);
        if (theirs === undefined) return; // field doesn't exist at this layout class
        assert.equal(Number(theirs), ours, `${b.path}: ${field}`);
      };
      checkHeader("Version", m.header.version);
      checkHeader("FileLength", m.header.fileLength);
      checkHeader("FunctionCount", m.header.functionCount);
      checkHeader("StringCount", m.strings.count);
      checkHeader("IdentifierCount", m.strings.identifierCount);
      checkHeader("OverflowStringCount", m.header.overflowStringCount);
      checkHeader("StringStorageSize", m.header.stringStorageSize);
      checkHeader("BigIntCount", m.header.bigIntCount);
      checkHeader("RegExpCount", m.header.regExpCount);
      checkHeader("RegExpStorageSize", m.header.regExpStorageSize);
      checkHeader("SegmentID", m.header.segmentID);
      checkHeader("CjsModuleCount", m.header.cjsModuleCount);
      checkHeader("FunctionSourceCount", m.header.functionSourceCount);

      // Known-divergence allowlist: see tests/gate/oracle/known-divergences.md
      // (M1 review Finding 3 — this used to be an inline comment, not the spec-named
      // file). Item 1 there (v99's DebugOffsets) is not header-level so there is
      // nothing to skip in this specific check.
      checkHeader("DebugInfoOffset", m.header.debugInfoOffset);

      assert.equal(oracle.strings.length, m.strings.count, `${b.path}: string count`);
      for (let i = 0; i < oracle.strings.length; i++) {
        const expectedKind = m.strings.kind(i);
        assert.equal(oracle.strings[i]!.kind, expectedKind, `${b.path} string ${i} kind`);
        const unescaped = unescapePythonRepr(oracle.strings[i]!.raw);
        if (unescaped !== null && !unescaped.includes("\\") && m.strings.entry(i).isUTF16 === false) {
          assert.equal(unescaped, m.strings.get(i), `${b.path} string ${i} content`);
        }
      }

      assert.equal(oracle.functions.length, m.functions.length, `${b.path}: function count`);
      for (const of_ of oracle.functions) {
        const ours = m.functions[of_.index]!;
        assert.equal(ours.name, of_.name, `${b.path} function ${of_.index} name`);
        assert.equal(ours.header.bytecodeSizeInBytes, of_.size, `${b.path} function ${of_.index} size`);
        assert.equal(ours.header.paramCount, of_.paramCount, `${b.path} function ${of_.index} paramCount`);
        if (of_.offset >= 0) assert.equal(ours.header.offset, of_.offset, `${b.path} function ${of_.index} offset`);
      }
    }
  }
});
