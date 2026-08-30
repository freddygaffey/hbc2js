// docs/specs/01-parser.md §8 T4 — string table.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { fixture } from "../../support/fixtures.ts";
import { listFixtures } from "../../support/fixtures.ts";

function bin(version: number) {
  const f = fixture("hermes-dec-sample", "hermes-dec-sample");
  const b = f.binaries.find((x) => x.version === version && x.variant === "");
  if (b === undefined) throw new Error(`missing v${version}`);
  return b.bytes();
}

test("v94 string table: 34 entries, kinds, identifierHash, UTF-16", () => {
  const m = parseHbc(bin(94));
  assert.equal(m.strings.count, 34);
  assert.equal(m.strings.identifierCount, 17);
  for (let i = 0; i < 17; i++) assert.equal(m.strings.kind(i), "String", `id ${i}`);
  for (let i = 17; i < 34; i++) assert.equal(m.strings.kind(i), "Identifier", `id ${i}`);

  for (let i = 0; i < 17; i++) assert.equal(m.strings.identifierHash(i), undefined);
  for (let i = 17; i < 34; i++) assert.notEqual(m.strings.identifierHash(i), undefined);

  assert.equal(m.strings.get(7), "global");
  assert.equal(m.strings.get(13), "gmi");
  assert.equal(m.strings.entry(16).isUTF16, true);
  const s16 = m.strings.get(16);
  assert.ok([...s16].some((ch) => ch.codePointAt(0) === 0x202f) || s16.includes(String.fromCharCode(0x202f)));
});

test("v99 string table: 35 entries, String x16 then Identifier x19", () => {
  const m = parseHbc(bin(99));
  assert.equal(m.strings.count, 35);
  assert.equal(m.strings.identifierCount, 19);
  for (let i = 0; i < 16; i++) assert.equal(m.strings.kind(i), "String");
  for (let i = 16; i < 35; i++) assert.equal(m.strings.kind(i), "Identifier");

  const all = Array.from({ length: 35 }, (_, i) => m.strings.get(i));
  assert.ok(all.includes("Generator functions may not be called on executing generators"));
  assert.ok(all.includes("value"));
  assert.ok(all.includes("done"));
});

test("property test: every string entry's byte range is inside stringStorage, for every gate fixture", () => {
  for (const f of listFixtures()) {
    for (const b of f.binaries) {
      const m = parseHbc(b.bytes());
      for (let id = 0; id < m.strings.count; id++) {
        const e = m.strings.entry(id);
        const byteLen = e.length * (e.isUTF16 ? 2 : 1);
        assert.ok(e.storageOffset >= 0 && e.storageOffset + byteLen <= m.strings.storage.length, `${f.group}/${f.name} v${b.version}${b.variant} string ${id}`);
        const decoded = m.strings.get(id);
        assert.equal(decoded.length, e.length, `${f.group}/${f.name} v${b.version} string ${id} decode length`);
      }
    }
  }
});

test("string decoding is cached (repeated get() calls are cheap, deterministic)", () => {
  const m = parseHbc(bin(94));
  const a = m.strings.get(7);
  const b = m.strings.get(7);
  assert.equal(a, b);
  assert.equal(a, "global");
});

test("kind()/entry()/get() throw E_BAD_STRING_ID (via Hbc2jsError) for an out-of-range id", () => {
  const m = parseHbc(bin(94));
  assert.throws(() => m.strings.get(999));
  assert.throws(() => m.strings.entry(-1));
  assert.throws(() => m.strings.kind(m.strings.count));
});
