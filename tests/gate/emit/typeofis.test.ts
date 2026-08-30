// review-M4-H2 — `TypeOfIs` / `JmpTypeOfIs`'s `TypeOfIsTypes` mask.
//
// Before this, only bit 7 (`Function`, mask 128) was confirmed against real
// bytecode and every other mask was `E_EMIT_UNSUPPORTED`, which is what stopped
// the 51 MB Discord and 34 MB Shopify bundles. `Typeof.h` is now vendored per
// pin and the bit order generated from it, so the mask decodes exactly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseM4 } from "../../support/m4.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { getTypeOfIsTable, listOpcodeTableIds } from "../../../src/tables/registry.ts";
import { typeOfIsExpr } from "../../../src/emit/typeofis.ts";
import { expr as printExpr } from "../../../src/emit/print.ts";
import { id } from "../../../src/emit/ast.ts";
import { Hbc2jsError } from "../../../src/errors.ts";
import { decompile } from "../../../src/decompile.ts";

const WHERE = { opcode: "JmpTypeOfIs", functionIndex: 0, offset: 0, section: "test" };

function render(mask: number, tableId: "hbc98-late" | "hbc99-mar2026" = "hbc99-mar2026"): string {
  return printExpr(typeOfIsExpr(id("x"), mask, getTypeOfIsTable(tableId), WHERE), 0);
}

test("review-M4-H2: the TypeOfIsTypes bit order is Typeof.h's declaration order", () => {
  const t = getTypeOfIsTable("hbc99-mar2026");
  assert.ok(t !== null);
  assert.deepEqual(t.types, ["Undefined", "Object", "String", "Symbol", "Boolean", "Number", "Bigint", "Function", "Null"]);
  // Bit 7 = Function = 128 is the one value confirmed against real bytecode
  // before the header was vendored; it must still be what the table says.
  assert.equal(t.types.indexOf("Function"), 7);
  // Every pin that has the opcode must agree — the header is byte-identical
  // across them (VENDOR.yml sha256s), so a divergence means a bad regeneration.
  const withTable = listOpcodeTableIds().filter((tid) => getTypeOfIsTable(tid) !== null);
  assert.deepEqual([...withTable].sort(), ["hbc98-late", "hbc99-feb2026", "hbc99-mar2026"]);
  for (const tid of withTable) assert.deepEqual(getTypeOfIsTable(tid)!.types, t.types);
});

test("review-M4-H2: single-bit masks lower to their typeof test", () => {
  assert.equal(render(1), 'typeof x === "undefined"');
  assert.equal(render(1 << 2), 'typeof x === "string"');
  assert.equal(render(1 << 3), 'typeof x === "symbol"');
  assert.equal(render(1 << 4), 'typeof x === "boolean"');
  assert.equal(render(1 << 5), 'typeof x === "number"');
  assert.equal(render(1 << 6), 'typeof x === "bigint"');
  assert.equal(render(128), 'typeof x === "function"');
  // Header note: "Object" does not match null or functions; Null is its own bit.
  assert.equal(render(1 << 1), 'typeof x === "object" && x !== null');
  assert.equal(render(1 << 8), "x === null");
  // …and the pair is what the source-level `typeof x === "object"` means.
  assert.equal(render((1 << 1) | (1 << 8)), 'typeof x === "object" && x !== null || x === null');
});

test("review-M4-H2: a majority mask is emitted as the negation of its complement", () => {
  // 507 = 0b111111011: everything but String. This is the exact mask that made
  // `hbc2js discord.hbc` refuse.
  assert.equal(render(507), '!(typeof x === "string")');
  assert.equal(render(383), '!(typeof x === "function")'); // everything but Function
  assert.equal(render(503), '!(typeof x === "symbol")');
  // Degenerate but legal bitsets.
  assert.equal(render(0), "false");
  assert.equal(render(511), "true");
});

test("review-M4-H2: an out-of-range mask, or a pin with no Typeof.h, is refused not guessed", () => {
  assert.throws(() => render(512), (e: unknown) => e instanceof Hbc2jsError && /out of range/.test(e.message));
  for (const tid of ["hbc84", "hbc94", "hbc96", "hbc98-2024"] as const) {
    assert.equal(getTypeOfIsTable(tid), null, `${tid} must have no TypeOfIsTypes table`);
  }
  assert.throws(
    () => typeOfIsExpr(id("x"), 507, getTypeOfIsTable("hbc94"), WHERE),
    (e: unknown) => e instanceof Hbc2jsError && /no Typeof\.h/.test(e.message),
  );
});

test("review-M4-H2: 55-typeof-is-masks decompiles at v98/v99 and covers non-128 masks", () => {
  for (const version of [98, 99]) {
    const path = join(repoRoot(), "tests", "fixtures", "constructs", "55-typeof-is-masks", `v${version}.hbc`);
    const bytes = new Uint8Array(readFileSync(path));
    const { module } = parseM4(bytes);
    const analysis = analyseModule(module, { strictEnv: true });
    const masks = new Set<number>();
    for (let i = 0; i < module.functions.length; i++) {
      for (const insn of analysis.decoded(i).instructions) {
        if (insn.name === "JmpTypeOfIs" || insn.name === "TypeOfIs") masks.add(insn.operands[2]!.value);
      }
    }
    assert.ok(masks.has(507), `v${version}: mask 507 (typeof x !== "string") is gone — the fixture no longer covers the bundle blocker`);
    assert.ok([...masks].filter((m) => m !== 128).length >= 8, `v${version}: only ${masks.size} distinct masks: ${[...masks].join(",")}`);
    // And the whole module decompiles, which it did not before.
    const code = decompile(bytes, { resolveV98Ambiguity: true, moduleName: "55-typeof-is-masks" }).code;
    // `\w+` rather than `r\d+`: expr-rebuild (M5) may fold the tested value
    // all the way down to a parameter name (e.g. `!(typeof a1 === "string")`)
    // rather than leaving it in a register; either way proves mask 507
    // lowered to the negated string test, which is this test's actual point.
    assert.match(code, /!\(typeof \w+ === "string"\)/, `v${version}: mask 507 did not lower to the negated string test`);
  }
});
