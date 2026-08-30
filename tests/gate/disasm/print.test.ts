// docs/specs/02-disassembler.md §6 — canonical textual formats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { printFunction, printModule, truncatePreview } from "../../../src/disasm/print.ts";
import { decodeFunction } from "../../../src/disasm/decode.ts";
import { fixture } from "../../support/fixtures.ts";

function bin(group: string, name: string, version: number) {
  const f = fixture(group, name);
  const b = f.binaries.find((x) => x.version === version && x.variant === "");
  if (b === undefined) throw new Error(`no v${version} binary for ${group}/${name}`);
  return b;
}

class Collector {
  chunks: string[] = [];
  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

// ---------------------------------------------------------------------------
// §6.2 string truncation rule (review N3).
// ---------------------------------------------------------------------------

test("truncatePreview: escapes control characters, backslash and quote", () => {
  assert.equal(truncatePreview("a\\b\"c\nd\re\tf", 100), 'a\\\\b\\"c\\nd\\re\\tf');
});

test("truncatePreview: \\xNN for other code units < 0x20 or == 0x7f", () => {
  assert.equal(truncatePreview("\x01\x1f\x7f", 100), "\\x01\\x1f\\x7f");
});

test("truncatePreview: \\uNNNN for code units >= 0x80, including lone surrogates, no astral special-casing", () => {
  assert.equal(truncatePreview("\u00e9\u4e2d", 100), "\\u00e9\\u4e2d");
  const loneHighSurrogate = "\ud83d"; // no low surrogate follows
  assert.equal(truncatePreview(loneHighSurrogate, 100), "\\ud83d");
  const astral = "\ud83d\ude00"; // 😀 as a surrogate pair
  assert.equal(truncatePreview(astral, 100), "\\ud83d\\ude00");
});

test("truncatePreview: cuts at maxChars of the ESCAPED output, appends U+2026 only when something was dropped", () => {
  assert.equal(truncatePreview("hello", 5), "hello");
  assert.equal(truncatePreview("hello!", 5), "hello…");
  assert.equal(truncatePreview("", 5), "");
});

test("truncatePreview: never splits an escape sequence — backs up to the atom boundary", () => {
  // "AA\x01" escaped is "AA\x01" (5 chars: A A \ x 0 1 -> actually "\\x01" is 4
  // chars). Budget of 3 lands mid-"\x01"; must back up to keep only "AA".
  const s = "AA\x01";
  assert.equal(truncatePreview(s, 3), "AA…");
  assert.equal(truncatePreview(s, 6), "AA\\x01");
});

test("truncatePreview matches the v94 hermes-dec-sample s12 worked example (spec 02 §6.2)", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const raw = mod.strings.get(12);
  assert.equal(raw.length, 43, "s12 should be the 43-character string with a NUL and \\r\\n\\t");
  const preview = truncatePreview(raw, 32);
  assert.ok(preview.endsWith("…"), "32-char budget must truncate this string");
  // Never split an escape: the escaped prefix must be AT MOST 32 characters
  // before the ellipsis, and short only by the width of the atom that didn't
  // fit (never splitting mid-escape can legitimately land under budget).
  const withoutEllipsis = preview.slice(0, -1);
  assert.ok(withoutEllipsis.length <= 32, `expected <= 32 escaped chars, got ${withoutEllipsis.length}`);
  assert.ok(withoutEllipsis.length >= 32 - 5, `backed up further than the widest atom (6 chars, \\uNNNN) should allow: got ${withoutEllipsis.length}`);
});

// ---------------------------------------------------------------------------
// §6.2 operand rendering.
// ---------------------------------------------------------------------------

test("canonical mode: reg/string/function/cacheIndex/imm render per the §6.2 table", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const fn = decodeFunction(mod, 0);
  const out = new Collector();
  printFunction(mod, fn, out as unknown as NodeJS.WritableStream, { mode: "canonical" });
  const text = out.text();
  assert.match(text, /r0\b/);
  assert.match(text, /#c1\b/);
  assert.match(text, /s17 "testx"/);
  assert.match(text, /f1 "testx"/);
});

test("canonical mode: --no-cache-indices (showCacheIndices: false) omits #cN entirely", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const fn = decodeFunction(mod, 0);
  const out = new Collector();
  printFunction(mod, fn, out as unknown as NodeJS.WritableStream, { mode: "canonical", showCacheIndices: false });
  assert.doesNotMatch(out.text(), /#c\d/);
});

test("canonical mode: a jump/condJump addr operand renders as its resolved label, not the raw displacement", () => {
  const mod = parseHbc(bin("constructs", "01-if-else-chain", 94).bytes());
  for (const fn of [decodeFunction(mod, 0), decodeFunction(mod, 1)]) {
    const jump = fn.instructions.find((i) => i.kind === "condJump" || i.kind === "jump");
    if (jump === undefined) continue;
    const out = new Collector();
    printFunction(mod, fn, out as unknown as NodeJS.WritableStream, { mode: "canonical" });
    const label = fn.labels.get(jump.targets[0]!);
    assert.ok(label !== undefined);
    assert.match(out.text(), new RegExp(`${jump.name}\\s+${label}`));
    return;
  }
  assert.fail("no jump/condJump found in 01-if-else-chain v94 functions 0/1");
});

// ---------------------------------------------------------------------------
// Streaming and determinism.
// ---------------------------------------------------------------------------

test("printModule never builds the whole disassembly as one array element bigger than the flush threshold", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const out = new Collector();
  printModule(mod, out as unknown as NodeJS.WritableStream, { mode: "canonical" });
  for (const chunk of out.chunks) assert.ok(chunk.length <= 65536 + 4096, "a single write() call exceeded the flush threshold by an implausible margin");
});

test("printModule canonical output is byte-stable across two runs", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const a = new Collector();
  const b = new Collector();
  printModule(mod, a as unknown as NodeJS.WritableStream, { mode: "canonical", moduleName: "v94.hbc" });
  printModule(mod, b as unknown as NodeJS.WritableStream, { mode: "canonical", moduleName: "v94.hbc" });
  assert.equal(a.text(), b.text());
});

test("canonical module preamble has no absolute paths and no timestamps", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const out = new Collector();
  printModule(mod, out as unknown as NodeJS.WritableStream, { mode: "canonical", moduleName: "v94.hbc" });
  const text = out.text();
  assert.doesNotMatch(text, /\/Users\/|\/home\/|C:\\\\/);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});

test("--function=N (indices option) disassembles only that function", () => {
  const mod = parseHbc(bin("hermes-dec-sample", "hermes-dec-sample", 94).bytes());
  const out = new Collector();
  printModule(mod, out as unknown as NodeJS.WritableStream, { mode: "canonical", indices: [2] });
  const matches = out.text().match(/^function #\d+/gm) ?? [];
  assert.deepEqual(matches, ["function #2"]);
});
