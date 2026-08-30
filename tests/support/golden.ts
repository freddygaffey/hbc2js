// docs/specs/01-parser.md §8 T5 — deterministic JSON snapshot read/write/compare.
// `UPDATE_GOLDEN=1` rewrites the committed file.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), null, 2) + "\n";
}

export interface GoldenResult {
  readonly matched: boolean;
  readonly updated: boolean;
  readonly expected: string | null;
  readonly actual: string;
}

/** Compare `value` against the committed snapshot at `path`. With `UPDATE_GOLDEN=1`,
 *  writes `value` instead of comparing. */
export function checkGolden(path: string, value: unknown): GoldenResult {
  const actual = canonicalJson(value);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual, "utf8");
    return { matched: true, updated: true, expected: actual, actual };
  }
  if (!existsSync(path)) {
    return { matched: false, updated: false, expected: null, actual };
  }
  const expected = readFileSync(path, "utf8");
  return { matched: expected === actual, updated: false, expected, actual };
}
