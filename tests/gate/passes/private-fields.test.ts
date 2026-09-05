// ACCEPTANCE: docs/BUGS.md 2026-09-01 row "class private fields" (bucket
// `diff:GetOwnPrivateBySym/GetByVal`) -- rung `private-fields` (stage B),
// docs/specs/passes/24-class-recover.md's private-name follow-up.
//
// Rung-owned properties only (CLAUDE.md testing rules / CONSOLIDATION section
// B item 7): the fixture's decompiled output contains real `#name` syntax and
// no `Symbol("#` call, the recompiled bytecode's private-name opcode counts
// match the original with zero extra `GetByVal`, a refusal negative for a
// private name that escapes its class, and PL-05 (`--passes=none` untouched).
// No whole-output string comparison against the shared fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import { parseHbc } from "../../../src/parse/module.ts";
import { decodeModule } from "../../../src/disasm/decode.ts";
import { repoRoot } from "../../support/paths.ts";
import { findHermesc, runHermesc } from "../../support/hermesc.ts";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "35-class-private-fields");
const js = (version: "v98" | "v99", mode: "on" | "none" = "on"): string =>
  decompile(new Uint8Array(readFileSync(join(FIXTURE, `${version}.hbc`))), {
    resolveV98Ambiguity: true,
    passes: mode === "none" ? { none: true } : {},
  }).code;

function opcodeCounts(bytes: Uint8Array): Map<string, number> {
  const mod = parseHbc(bytes);
  const counts = new Map<string, number>();
  for (const fn of decodeModule(mod)) for (const insn of fn.instructions) counts.set(insn.name, (counts.get(insn.name) ?? 0) + 1);
  return counts;
}

for (const version of ["v98", "v99"] as const) {
  test(`private-fields: ${version} decompiles to real #name syntax, no Symbol("#`, () => {
    const code = js(version);
    // Field declarations, a `this.#x`/`obj.#x` access, and the `#x in obj`
    // brand check -- all outside any string/comment.
    assert.match(code, /#balance\s*=\s*undefined;/);
    assert.match(code, /#history\s*=\s*new Array\(0\);/);
    assert.match(code, /\.#balance\b/);
    assert.match(code, /\.#history\b/);
    assert.match(code, /#balance in \w+/);
    assert.doesNotMatch(code, /Symbol\("#/);
  });
}

test("private-fields: --passes=none reproduces the M4 baseline (PL-05) -- no #name syntax at all", () => {
  for (const version of ["v98", "v99"] as const) {
    const code = js(version, "none");
    assert.doesNotMatch(code, /\.#balance\b/);
    assert.doesNotMatch(code, /#balance\s*=\s*undefined;/);
    assert.match(code, /Symbol\("#balance"\)/);
  }
});

test("private-fields: recompile round-trip preserves GetOwnPrivateBySym/PutOwnPrivateBySym/PrivateIsIn counts, zero extra GetByVal", (t) => {
  const hermesc = findHermesc(99);
  if (hermesc === null) {
    t.skip("hermesc v99 not found (run tools/get-hermesc.sh 99)");
    return;
  }
  const original = new Uint8Array(readFileSync(join(FIXTURE, "v99.hbc")));
  const originalCounts = opcodeCounts(original);

  const code = js("v99");
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-private-fields-"));
  writeFileSync(join(dir, "out.js"), code);
  const r = runHermesc(hermesc, ["-emit-binary", "-out=out.hbc", "out.js"], dir);
  assert.equal(r.status, 0, `hermesc failed to recompile the decompiled output: ${r.stderr}`);
  const recompiledCounts = opcodeCounts(new Uint8Array(readFileSync(join(dir, "out.hbc"))));

  for (const name of ["GetOwnPrivateBySym", "PutOwnPrivateBySym"]) {
    assert.equal(recompiledCounts.get(name) ?? 0, originalCounts.get(name) ?? 0, `${name} count changed on recompile`);
  }
  // The source also compiles `#balance in a1` back to a real `PrivateIsIn`
  // (0 without this rung, at any hermesc version -- there is no source-level
  // way to ask for it once the name is a `Symbol`), but not the original's
  // full count of 4: three of those four are the compiler's own synthetic
  // per-class brand check for the private *method* `#record` (inlined away
  // at -O, `CreatePrivateName "BankAccount"` -- no leading `#`, so this rung
  // never touches it, spec 24's "one recognised name at a time" scope). Only
  // the explicit `#balance in obj` brand check is this rung's to recover.
  assert.equal(recompiledCounts.get("PrivateIsIn") ?? 0, 2, "PrivateIsIn count regressed");
  // The whole point of the fix (docs/BUGS.md 2026-09-01): zero GetByVal/
  // PutByVal, where the pre-fix recompile has 9/3 (this fixture's every
  // #balance/#history access, computed-member on a `Symbol`).
  assert.equal(recompiledCounts.get("GetByVal") ?? 0, 0, "recompile introduced GetByVal");
  assert.equal(recompiledCounts.get("PutByVal") ?? 0, 0, "recompile introduced PutByVal");
  assert.equal(recompiledCounts.get("PutByValStrict") ?? 0, 0, "recompile introduced PutByValStrict");
});

test("private-fields: refuses a private name that escapes its class (stored outside the recognised shapes)", async () => {
  const { foldAll } = (await import("../../../src/passes/private-fields/match.ts")) as Any;
  // A minimal hand-built tree in the same shape `class-recover` produces:
  // one candidate name declared, one class with a constructor that installs
  // it (recognised), and one member that leaks the raw symbol out through a
  // call argument instead of using it as a member/hasOwn/defineProperty key.
  const sym = (n: string) => ({ k: "call", callee: { k: "ident", name: "Symbol" }, args: [{ k: "lit", text: `"${n}"` }] });
  const install = (obj: string, key: string, value: Any) => ({
    k: "expr",
    expr: { k: "call", callee: { k: "member", obj: { k: "ident", name: "Object" }, prop: { k: "lit", text: "defineProperty" }, computed: false }, args: [{ k: "ident", name: obj }, { k: "ident", name: key }, { k: "object", props: [{ key: "value", computed: false, value }, { key: "writable", computed: false, value: { k: "lit", text: "true" } }, { key: "enumerable", computed: false, value: { k: "lit", text: "false" } }, { key: "configurable", computed: false, value: { k: "lit", text: "false" } }] }] },
  });
  const ctor = {
    k: "func",
    name: null,
    params: [],
    body: [install("r1", "_e0_0", { k: "ident", name: "undefined" }), { k: "return", arg: { k: "ident", name: "r1" } }],
  };
  const leaky = {
    k: "func",
    name: null,
    params: [],
    body: [{ k: "expr", expr: { k: "call", callee: { k: "ident", name: "leak" }, args: [{ k: "ident", name: "_e0_0" }] } }],
  };
  const cls = {
    k: "class",
    name: "C",
    superClass: null,
    members: [
      { kind: "method", static: false, computed: false, key: { k: "ident", name: "constructor" }, value: ctor },
      { kind: "method", static: false, computed: false, key: { k: "lit", text: "leaky" }, value: leaky },
    ],
  };
  const before = [{ k: "expr", expr: { k: "assign", target: { k: "ident", name: "_e0_0" }, value: sym("#x") } }, { k: "init", kind: "let", name: "r7", value: cls }];
  const { folded, after } = foldAll(before);
  assert.deepEqual(folded, []);
  assert.equal(after, before); // untouched: the escaping name is the only candidate
});
