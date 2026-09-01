// CONSOLIDATION 27 — unevidenced code paths must refuse real input, never run
// silently. This gate proves two things about each unverified mechanism: (1) it
// throws a clear Hbc2jsError with no way to slip past it silently, and (2) it does
// NOT fire on any evidenced (real-fixture) path — the guard is precise, not a
// blanket refusal.
//
// The three paths CONSOLIDATION.md item 27 names:
//  - opcode-table entries marked `unverified` (src/tables/types.ts's OpcodeDef.
//    unverified) — currently set on NO generated table (see that field's own
//    comment and docs/AGENT-LOG.md's M1 review: hbc98-late's one inferred opcode
//    was identified as real `CacheNewObject` and the guess removed). The mechanism
//    is kept for any future such gap, so it is tested here directly against a
//    synthetic table rather than against real bytes (none exist that hit it).
//  - layout classes whose version maps to zero candidate opcode tables
//    (`candidatesForVersion` in src/parse/layout.ts: version <= 83 -> layout A,
//    85/86 -> layout B, and 97 -> layout D all resolve `opcodeTables: []`) — no
//    gate fixture is below version 84, so these are genuinely unevidenced.
//    `requireOpcodeTable` in src/disasm/decode.ts already refuses unconditionally
//    before any instruction is decoded; this test exercises that refusal directly.
//  - the Linux arm64 hermesc build path (tools/build-hermesc-linux-arm64.sh) — see
//    tests/gate/toolchain/arm64-build-guard.test.ts.
//
// Neither mechanism gets an --allow-unverified escape hatch: forcing the opcode
// guard would decode operands of unknown width (there is nothing to force it INTO
// — the whole point is the signature is unknown), and forcing the opcode-table
// guard already has a real escape hatch, `--opcode-table=<id>` / `{ opcodeTable }`
// (exercised in tests/gate/parse/layout.test.ts), which supplies a real table to
// try instead of just disabling the check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunction, decodeModule } from "../../../src/disasm/decode.ts";
import { decodeAndVerifyFunction } from "../../../src/parse/layout.ts";
import { getOpcodeTable } from "../../../src/tables/registry.ts";
import { parseHbc } from "../../../src/index.ts";
import { Hbc2jsError, ErrorCode } from "../../../src/errors.ts";
import type { HbcModule } from "../../../src/parse/types.ts";
import type { OpcodeTable } from "../../../src/tables/types.ts";
import { fixture } from "../../support/fixtures.ts";

function bin(version: number) {
  const f = fixture("hermes-dec-sample", "hermes-dec-sample");
  const b = f.binaries.find((x) => x.version === version && x.variant === "");
  if (b === undefined) throw new Error(`missing v${version}`);
  return b.bytes().slice();
}

test("unverified opcode-table entry refuses to decode, no flag can bypass it", () => {
  const table: OpcodeTable = {
    id: "hbc98-late",
    bytecodeVersion: 98,
    hermesCommit: "test-synthetic",
    operandTypes: getOpcodeTable("hbc98-late").operandTypes,
    opcodes: [{ n: 7, name: "SyntheticUnverifiedOpcode", operands: [], unverified: true }],
  };
  const body = new Uint8Array([7]);
  assert.throws(
    () => decodeAndVerifyFunction(body, 0, body.length, table, 0, 0, 0),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_UNKNOWN_OPCODE && /unverified placeholder/.test(e.message),
  );
});

test("a layout class with no generated opcode table (classes A/B<87/D-without-hbc98-2024) refuses before decoding any instruction", () => {
  // Simulates parseHbc() having resolved a header/layout for e.g. version 83
  // (layout A) — candidatesForVersion returns opcodeTables: [] for it, so
  // layout.opcodeTable stays undefined. decodeFunction must refuse immediately,
  // never guess a table.
  const fakeModule = {
    layout: { layoutClass: "A", opcodeTable: undefined },
    header: { version: 83 },
  } as unknown as HbcModule;
  assert.throws(
    () => decodeFunction(fakeModule, 0),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_UNSUPPORTED_VERSION && /no opcode table generated/.test(e.message),
  );
});

test("evidenced paths are unaffected: every canonical fixture version still decodes every function with no throw", () => {
  for (const version of [84, 94, 96, 98, 99] as const) {
    const mod = parseHbc(bin(version));
    let count = 0;
    for (const fn of decodeModule(mod)) {
      count += 1;
      assert.ok(fn.instructions.length >= 0);
    }
    assert.ok(count > 0, `v${version} decoded at least one function`);
  }
});
