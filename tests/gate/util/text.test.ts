import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeAscii, decodeUtf16 } from "../../../src/util/text.ts";

test("decodeAscii is byte-per-char, including bytes >= 0x80", () => {
  const bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff, 0x80]);
  const s = decodeAscii(bytes, 0, bytes.length);
  assert.equal(s.length, 7);
  assert.equal(s.charCodeAt(5), 0xff);
  assert.equal(s.charCodeAt(6), 0x80);
});

test("decodeAscii respects offset/length", () => {
  const bytes = new Uint8Array([0x61, 0x62, 0x63, 0x64]);
  assert.equal(decodeAscii(bytes, 1, 2), "bc");
});

test("decodeUtf16 decodes little-endian code units, including U+202F", () => {
  // U+202F NARROW NO-BREAK SPACE, LE bytes 2F 20
  const bytes = new Uint8Array([0x2f, 0x20]);
  assert.equal(decodeUtf16(bytes, 0, 1).charCodeAt(0), 0x202f);
});

test("decodeUtf16 preserves an unpaired high surrogate (no U+FFFD substitution)", () => {
  // 0xD800 is a lone high surrogate -- TextDecoder would replace it; we must not.
  const bytes = new Uint8Array([0x00, 0xd8]);
  const s = decodeUtf16(bytes, 0, 1);
  assert.equal(s.charCodeAt(0), 0xd800);
});

test("decodeAscii and decodeUtf16 handle long strings across the 4096-code-unit chunk boundary", () => {
  const n = 5000;
  const ascii = new Uint8Array(n).fill(0x41);
  assert.equal(decodeAscii(ascii, 0, n).length, n);
  assert.equal(decodeAscii(ascii, 0, n)[4095], "A");

  const utf16 = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) {
    utf16[i * 2] = 0x42;
    utf16[i * 2 + 1] = 0x00;
  }
  const decoded = decodeUtf16(utf16, 0, n);
  assert.equal(decoded.length, n);
  assert.equal(decoded[4097], "B");
});
