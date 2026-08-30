// docs/specs/06-harness.md §5 "Golden traces" — committed NDJSON per
// `(fixture, version, engine)` under `tests/golden/traces/`, rewritten only
// under an explicit update flag (HA-11), the same discipline `expected.txt`
// and `tests/support/golden.ts`'s JSON snapshots already get.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Trace, TraceRecord } from "./trace.ts";

export interface GoldenTraceResult {
  readonly matched: boolean;
  readonly updated: boolean;
  readonly expected: string | null;
  readonly actual: string;
}

function serialise(records: readonly TraceRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** `meta` carries the format version and engine string, both of which are
 *  expected to change across a harness/engine upgrade without that being a
 *  real trace regression (spec 06 §5: "Comparison ignores meta"). Stripped
 *  before the equality check; kept in the file itself as documentation. */
function withoutMeta(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      if (line === "") return true;
      try {
        return (JSON.parse(line) as { k?: string }).k !== "meta";
      } catch {
        return true;
      }
    })
    .join("\n");
}

function updateRequested(): boolean {
  return process.env["HBC2JS_UPDATE_GOLDENS"] === "1" || process.env["UPDATE_GOLDEN"] === "1";
}

/**
 * Compare `trace` against the committed golden NDJSON at `filePath`. With
 * `HBC2JS_UPDATE_GOLDENS=1` (or `UPDATE_GOLDEN=1`, matching
 * `tests/support/golden.ts`'s existing convention), writes `trace` instead of
 * comparing — HA-11 requires that path be the *only* way this file changes.
 */
export function checkGoldenTrace(filePath: string, trace: Trace): GoldenTraceResult {
  const actual = serialise(trace.records);
  if (updateRequested()) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, actual, "utf8");
    return { matched: true, updated: true, expected: actual, actual };
  }
  if (!existsSync(filePath)) {
    return { matched: false, updated: false, expected: null, actual };
  }
  const expected = readFileSync(filePath, "utf8");
  return { matched: withoutMeta(expected) === withoutMeta(actual), updated: false, expected, actual };
}

export function readGoldenTrace(filePath: string): readonly TraceRecord[] {
  const text = readFileSync(filePath, "utf8");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as TraceRecord);
}
