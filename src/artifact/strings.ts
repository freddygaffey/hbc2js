// src/artifact/strings.ts — §2.3a `strings.json`: every string-table entry,
// sid -> value (or, past 4 KB, a head + hash + full length — never a silent
// truncation, §2.3a's own rule).
import type { HbcModule } from "../parse/types.ts";
import { sha256Hex, type StringRow, type StringsIndex } from "./schema.ts";

const TRUNCATE_AT = 4096;
const HEAD_CHARS = 256;

export function buildStringsIndex(module: HbcModule): StringsIndex {
  const entries: StringRow[] = [];
  const { strings } = module;
  for (let sid = 0; sid < strings.count; sid++) {
    const v = strings.get(sid);
    if (Buffer.byteLength(v, "utf8") <= TRUNCATE_AT) {
      entries.push({ sid, v });
    } else {
      entries.push({ sid, len: v.length, sha256: sha256Hex(v), head: v.slice(0, HEAD_CHARS) });
    }
  }
  return { schema: "hbc2js-index/1", kind: "strings", renderIndependent: true, entries };
}
