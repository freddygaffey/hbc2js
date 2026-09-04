// tests/gate/ui/line-map-align.test.ts — the source<->disasm alignment the
// centre pane performs (docs/specs/05-emitter.md §16, docs/UI.md).
//
// `ui/src/listing/line-map.ts` is pure (no React, no CodeMirror, a type-only
// import of the contracts), so it is imported directly here and runs under the
// root `npm test` with no `ui/node_modules` present — same trick as
// tests/gate/ui/listing.test.ts.
//
// The rule under test is the honest one: the pane may point at NOTHING, but it
// must never point at a line that is not the instruction the map named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../support/paths.ts";

const root = repoRoot();
const helper = join(root, "ui", "src", "listing", "line-map.ts");

type Row = readonly [number, number, number, number];
interface RowAcrossFns {
  readonly row: Row;
  readonly fn: number;
  readonly nested: boolean;
}
interface Helper {
  fnLocalLine(editorLine: number | null, fileView: boolean, fnStartLine: number | null): number | null;
  rowForLine(rows: readonly Row[], fn: number, localLine: number | null): Row | null;
  rowForLineAcrossFns(rows: readonly Row[], fn: number, localLine: number | null): RowAcrossFns | null;
  disasmLineForOffset(text: string, offset: number): number | null;
  alignedDisasmLine(args: { rows: readonly Row[]; fn: number; editorLine: number | null; fileView: boolean; fnStartLine: number | null; disasmText: string }): number | null;
}
const load = async (): Promise<Helper> => (await import(pathToFileURL(helper).href)) as unknown as Helper;

// The real `src/disasm/print.ts` shape: `[@ <offset>] Opcode operands…`.
const DISASM = ["L0:", "  [@ 0] LoadParam r2<Reg8>, 1<UInt8>", "  [@ 4] GetByIdShort r3<Reg8>, r2<Reg8>", "  [@ 10] JmpFalse L1<Addr8>, r1<Reg8>", "L1:", "  [@ 16] Ret r4<Reg8>"].join("\n");
const ROWS: readonly Row[] = [
  [2, 7, 0, 4],
  [3, 7, 4, 10],
  [5, 9, 0, 4], // a NESTED closure's row: same offsets, different function
  [6, 7, 16, 18],
];

test("§16: the fn-view line is used as-is; the file view rebases on fnStartLine", async () => {
  const h = await load();
  assert.equal(h.fnLocalLine(4, false, null), 4);
  assert.equal(h.fnLocalLine(104, true, 100), 5);
  assert.equal(h.fnLocalLine(100, true, 100), 1);
  // Above the function's first line, or with no range recorded: no answer,
  // never a negative/guessed line.
  assert.equal(h.fnLocalLine(99, true, 100), null);
  assert.equal(h.fnLocalLine(104, true, null), null);
  assert.equal(h.fnLocalLine(null, false, null), null);
});

test("§16: an exact row wins; otherwise the nearest mapped line ABOVE the cursor", async () => {
  const h = await load();
  assert.deepEqual(h.rowForLine(ROWS, 7, 3), [3, 7, 4, 10]);
  // Line 4 is unmapped (a `}` say) — fall back to line 3's instruction, the
  // last one known to precede it.
  assert.deepEqual(h.rowForLine(ROWS, 7, 4), [3, 7, 4, 10]);
  // Nothing at or above line 1: no answer at all.
  assert.equal(h.rowForLine(ROWS, 7, 1), null);
  assert.equal(h.rowForLine(ROWS, 7, null), null);
});

test("§16: rows belonging to a nested closure never steer the parent's disassembly", async () => {
  const h = await load();
  // Line 5 is mapped, but to fn 9's @0 — fn 7's listing must not jump there.
  // The honest answer for fn 7 at line 5 is fn 7's own line-3 instruction.
  assert.deepEqual(h.rowForLine(ROWS, 7, 5), [3, 7, 4, 10]);
  assert.deepEqual(h.rowForLine(ROWS, 9, 5), [5, 9, 0, 4]);
});

test("§16.2: rowForLineAcrossFns resolves a nested row and leaves parent-owned lines unaffected", async () => {
  const h = await load();
  // Line 5 is fn 9's own row (a nested closure inline in fn 7's listing) —
  // the honest answer for the CURSOR, regardless which fn's text is being
  // read, is that closure's own instruction.
  assert.deepEqual(h.rowForLineAcrossFns(ROWS, 7, 5), { row: [5, 9, 0, 4], fn: 9, nested: true });
  // A parent-owned line resolves exactly as `rowForLine` would, with
  // `nested: false` and the identical row.
  assert.deepEqual(h.rowForLineAcrossFns(ROWS, 7, 3), { row: [3, 7, 4, 10], fn: 7, nested: false });
  assert.deepEqual(h.rowForLineAcrossFns(ROWS, 7, 4), { row: [3, 7, 4, 10], fn: 7, nested: false });
  // Nothing at or above line 1: no answer, same as `rowForLine`.
  assert.equal(h.rowForLineAcrossFns(ROWS, 7, 1), null);
  assert.equal(h.rowForLineAcrossFns(ROWS, 7, null), null);
  // Asked from the CHILD's own point of view, its own row is not "nested".
  assert.deepEqual(h.rowForLineAcrossFns(ROWS, 9, 5), { row: [5, 9, 0, 4], fn: 9, nested: false });
});

test("§16.2: rowForLineAcrossFns assumes rows arrive sorted by line (breaks at the first row past localLine)", async () => {
  const h = await load();
  // An out-of-order row would never be reached once a later line has broken
  // the scan — documenting the sortedness assumption `rowForLine` already
  // relies on (`// rows arrive sorted by line`).
  const unsorted: readonly Row[] = [[2, 7, 0, 4], [6, 7, 16, 18], [3, 7, 4, 10]];
  assert.deepEqual(h.rowForLineAcrossFns(unsorted, 7, 5), { row: [2, 7, 0, 4], fn: 7, nested: false });
});

test("§16.2: the closing-brace imprecision — a nested closure's last printed lines can resolve to the child, accepted", async () => {
  const h = await load();
  // fn 9's inline closure is spliced into fn 7's listing: line 2 is fn 7's
  // own statement before it, line 4 is the closure's only mapped statement,
  // and lines 5-6 are its closing `}` / the enclosing `});` — neither carries
  // an origin (§16.2), so the nearest-preceding-row rule attributes both to
  // the CHILD until a real fn-7 row (line 7) follows.
  const rows2: readonly Row[] = [[2, 7, 0, 4], [4, 9, 0, 4], [7, 7, 4, 10]];
  assert.deepEqual(h.rowForLineAcrossFns(rows2, 7, 5), { row: [4, 9, 0, 4], fn: 9, nested: true });
  assert.deepEqual(h.rowForLineAcrossFns(rows2, 7, 6), { row: [4, 9, 0, 4], fn: 9, nested: true });
  // Once fn 7's own next statement is reached, the pane returns to fn 7.
  assert.deepEqual(h.rowForLineAcrossFns(rows2, 7, 7), { row: [7, 7, 4, 10], fn: 7, nested: false });
});

test("§16: an offset is found by its `[@ N]` prefix, and only exactly", async () => {
  const h = await load();
  assert.equal(h.disasmLineForOffset(DISASM, 0), 2);
  assert.equal(h.disasmLineForOffset(DISASM, 16), 6);
  // `1` must not match the `[@ 10]` line, and an absent offset is null, not 0.
  assert.equal(h.disasmLineForOffset(DISASM, 1), null);
  assert.equal(h.disasmLineForOffset(DISASM, 99), null);
});

test("§16: the whole chain, in both views", async () => {
  const h = await load();
  const args = { rows: ROWS, fn: 7, fileView: false, fnStartLine: 1, disasmText: DISASM };
  assert.equal(h.alignedDisasmLine({ ...args, editorLine: 2 }), 2);
  assert.equal(h.alignedDisasmLine({ ...args, editorLine: 3 }), 3);
  assert.equal(h.alignedDisasmLine({ ...args, editorLine: 6 }), 6);
  assert.equal(h.alignedDisasmLine({ ...args, editorLine: 1 }), null);
  // File view: the same function's text starting at line 100 of the module.
  const file = { ...args, fileView: true, fnStartLine: 100 };
  assert.equal(h.alignedDisasmLine({ ...file, editorLine: 101 }), 2);
  assert.equal(h.alignedDisasmLine({ ...file, editorLine: 102 }), 3);
  assert.equal(h.alignedDisasmLine({ ...file, editorLine: 105 }), 6);
  // An empty map (the server could not render the function) points nowhere.
  assert.equal(h.alignedDisasmLine({ ...args, rows: [], editorLine: 3 }), null);
});

test("§16: the mock adapter's disassembly keeps the real `[@ N]` shape", () => {
  // The alignment finds its line by that prefix; a mock in another format
  // would make the feature silently untestable in mock mode (docs/UI.md).
  const mock = readFileSync(join(root, "ui", "src", "mock.ts"), "utf8");
  const disasm = /const DISASM = `([\s\S]*?)`;/.exec(mock)?.[1];
  assert.ok(disasm !== undefined, "ui/src/mock.ts no longer defines a DISASM template");
  const instructions = disasm.split("\n").filter((l) => l.trim().length > 0 && !l.trim().endsWith(":"));
  assert.ok(instructions.length >= 4, "expected several mock instructions");
  for (const l of instructions) assert.match(l.trim(), /^\[@ \d+\] \w+/);
});

test("§16: the pure helper stays importable with no ui/node_modules", () => {
  // It may import types from ../contracts.ts (erased) and nothing else.
  const text = readFileSync(helper, "utf8");
  const imports = [...text.matchAll(/^import\s+(type\s+)?.*from\s+"([^"]+)";$/gm)];
  for (const [, isType, spec] of imports) {
    assert.ok(isType !== undefined, `ui/src/listing/line-map.ts must stay dependency-free; value import of ${spec}`);
  }
});
