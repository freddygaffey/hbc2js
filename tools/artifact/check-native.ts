#!/usr/bin/env node
// tools/artifact/check-native.ts — the native artifact re-walker.
// docs/specs/27-native-side.md §L1.5 + §4.1, following the spec 10 §4.1
// discipline: a SECOND, deliberately simple reader — not the builder called
// twice. It re-derives every row count straight from the container bytes with
// its own minimal zip/DEX/ARSC walk (it imports none of `src/native/`'s
// parsers) and diffs against what the builder wrote. A mismatch is a FAIL.
//
// Usage: node tools/artifact/check-native.ts <artifactDir> <apk>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

interface Counts {
  classes: number;
  methods: number;
  strings: number;
  resources: number;
  assets: number;
}

export interface CheckNativeReport {
  readonly ok: boolean;
  readonly expected: Counts;
  readonly actual: Counts;
  readonly problems: readonly string[];
}

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** A minimal, independent central-directory walk. */
function zipEntries(bytes: Uint8Array): { name: string; data: () => Uint8Array }[] {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (u32(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("check-native: not a zip (no end-of-central-directory record)");
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const out: { name: string; data: () => Uint8Array }[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = u16(bytes, p + 28);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const method = u16(bytes, p + 10);
    const compressed = u32(bytes, p + 20);
    const local = u32(bytes, p + 42);
    out.push({
      name,
      data: () => {
        const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
        const raw = bytes.subarray(start, start + compressed);
        return method === 0 ? raw : new Uint8Array(inflateRawSync(raw));
      },
    });
    p += 46 + nameLen + u16(bytes, p + 30) + u16(bytes, p + 32);
  }
  return out;
}

function uleb(b: Uint8Array, state: { p: number }): number {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = b[state.p++]!;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
    shift += 7;
  }
}

/** string / class / method counts straight out of one dex's header + class_data. */
function dexCounts(b: Uint8Array): { strings: number; classes: number; methods: number } {
  const strings = u32(b, 56);
  const classDefsSize = u32(b, 96);
  const classDefsOff = u32(b, 100);
  let methods = 0;
  for (let i = 0; i < classDefsSize; i++) {
    const classDataOff = u32(b, classDefsOff + 32 * i + 24);
    if (classDataOff === 0) continue;
    const st = { p: classDataOff };
    const staticFields = uleb(b, st);
    const instanceFields = uleb(b, st);
    methods += uleb(b, st) + uleb(b, st);
    void staticFields;
    void instanceFields;
  }
  return { strings, classes: classDefsSize, methods };
}

/** Non-empty entry count across every ResTable_type chunk. */
function arscEntryCount(b: Uint8Array): number {
  let total = 0;
  const walk = (start: number, end: number): void => {
    let p = start;
    while (p + 8 <= end) {
      const type = u16(b, p);
      const headerSize = u16(b, p + 2);
      const size = u32(b, p + 4);
      if (size < 8 || p + size > end) return;
      if (type === 0x0200) walk(p + headerSize, p + size);
      else if (type === 0x0201) {
        const flags = b[p + 9]!;
        const entryCount = u32(b, p + 12);
        const wide = (flags & 0x02) === 0;
        if ((flags & 0x01) === 0) {
          for (let i = 0; i < entryCount; i++) {
            const off = wide ? u32(b, p + headerSize + 4 * i) : u16(b, p + headerSize + 2 * i);
            if (wide ? off !== 0xffffffff : off !== 0xffff) total++;
          }
        }
      }
      p += size;
    }
  };
  walk(12, b.length);
  return total;
}

function rowCount(artifactDir: string, file: string): number {
  const text = readFileSync(join(artifactDir, "native", file), "utf8");
  return text.split("\n").filter((l) => l.length > 0).length - 1; // minus the schema header
}

/** Re-derive every count from `apkPath` and diff against `artifactDir`. */
export function checkNative(artifactDir: string, apkPath: string): CheckNativeReport {
  const bytes = new Uint8Array(readFileSync(apkPath));
  const entries = zipEntries(bytes);
  const expected: Counts = { classes: 0, methods: 0, strings: 0, resources: 0, assets: 0 };
  for (const e of entries) {
    if (/^classes\d*\.dex$/.test(e.name)) {
      const c = dexCounts(e.data());
      expected.strings += c.strings;
      expected.classes += c.classes;
      expected.methods += c.methods;
    } else if (e.name === "resources.arsc") {
      expected.resources += arscEntryCount(e.data());
    } else if (e.name.startsWith("assets/") && !e.name.endsWith("/")) {
      expected.assets++;
    }
  }
  const actual: Counts = {
    classes: rowCount(artifactDir, "classes.jsonl"),
    methods: rowCount(artifactDir, "methods.jsonl"),
    strings: rowCount(artifactDir, "strings.jsonl"),
    resources: rowCount(artifactDir, "resources.jsonl"),
    assets: rowCount(artifactDir, "assets.jsonl"),
  };
  const problems: string[] = [];
  for (const k of Object.keys(expected) as (keyof Counts)[]) {
    if (expected[k] !== actual[k]) problems.push(`${k}: re-walk counted ${expected[k]}, artifact holds ${actual[k]}`);
  }
  return { ok: problems.length === 0, expected, actual, problems };
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("check-native.ts")) {
  const [artifactDir, apkPath] = process.argv.slice(2);
  if (artifactDir === undefined || apkPath === undefined) {
    process.stderr.write("usage: check-native.ts <artifactDir> <apk>\n");
    process.exit(2);
  }
  const report = checkNative(artifactDir, apkPath);
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.ok ? 0 : 1);
}
