// review-M4-M8 / docs/HBC-FORMAT.md §6.3 — serialized-literal tag 6 changed
// meaning at v≥97: `ByteString` (one payload byte, a uint8 string id) became
// `UndefinedTag` (no payload). Reading it with a payload at v≥97 does not just
// return a wrong value, it desynchronises everything after it in the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readLiteralRun, readLiterals } from "../../../src/parse/buffers.ts";

/** `[tag 6 x1] 0x61 | [tag 7 (Integer) x1] 10` — the v≤96 reading. */
const BUF = new Uint8Array([
  0x61, // short form, tag 6, count 1
  0x61, // ByteString payload: string id 97
  0x71, // short form, tag 7 (Integer), count 1
  10,
  0,
  0,
  0,
]);

test("review-M4-M8: tag 6 is a 1-byte ByteString with no version and at v<=96", () => {
  for (const version of [undefined, 84, 94, 96]) {
    const run = readLiteralRun(BUF, 0, version);
    assert.equal(run.tag, 6);
    assert.equal(run.count, 1);
    assert.equal(run.byteLength, 2, `v${String(version)}: header + one payload byte`);
    const { values, nextOffset } = readLiterals(BUF, 0, 2, version);
    assert.deepEqual(values, [{ kind: "string", stringId: 97 }, { kind: "integer", value: 10 }]);
    assert.equal(nextOffset, BUF.length);
  }
});

test("review-M4-M8: tag 6 is payload-less Undefined at v>=97", () => {
  // The same bytes mean something else: the run is one byte long, and 0x61 is
  // the *next* run's header, not a payload.
  const run = readLiteralRun(BUF, 0, 99);
  assert.equal(run.tag, 6);
  assert.equal(run.byteLength, 1, "UndefinedTag carries no payload");
  const { values } = readLiterals(BUF, 0, 2, 99);
  assert.deepEqual(values, [{ kind: "undefined" }, { kind: "undefined" }], "0x61 at offset 1 is another tag-6 run at this version");

  // A v≥97 buffer that really is {undefined, 10}: tag 6 run, then the integer.
  const v97 = new Uint8Array([0x61, 0x71, 10, 0, 0, 0]);
  assert.deepEqual(readLiterals(v97, 0, 2, 99).values, [{ kind: "undefined" }, { kind: "integer", value: 10 }]);
  // …and read with the legacy table it desynchronises, which is the bug this
  // pins: the integer run's header is eaten as a string id.
  assert.notDeepEqual(readLiterals(v97, 0, 2, 96).values, [{ kind: "undefined" }, { kind: "integer", value: 10 }]);
});
