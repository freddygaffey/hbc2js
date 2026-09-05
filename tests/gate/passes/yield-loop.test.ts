// ACCEPTANCE: docs/specs/passes/29-yield-loop.md, rung `yield-loop` (stage B,
// catalogue row R15) -- the CYCLIC v<=96 coroutine, i.e. the generator whose
// suspend graph has a back edge, which spec 25 refuses as R-Y5.
//
// Rung-owned properties only: counts, shapes, refusal evidence and unit
// properties of the framework helper. No whole-output comparison against a
// shared fixture (CLAUDE.md testing rules / CONSOLIDATION section B item 7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decompile } from "../../../src/decompile.ts";
import type { Stmt } from "../../../src/passes/ast.ts";
import { restructureSegments } from "../../../src/passes/tree.ts";
import { repoRoot } from "../../support/paths.ts";

const CONSTRUCTS = join(repoRoot(), "tests", "fixtures", "constructs");
const js = (fixture: string, version: string, skip: readonly string[] = []): string =>
  decompile(readFileSync(join(CONSTRUCTS, fixture, `${version}.hbc`)), { resolveV98Ambiguity: true, passes: skip.length > 0 ? { skip } : {} }).code;
const count = (s: string, re: RegExp): number => (s.match(re) ?? []).length;

/** The text of `function* <name>(` up to the next declaration at the same
 *  indent. A regex over one function, never a comparison of the whole file. */
function generatorBody(code: string, name: string): string {
  const at = code.indexOf(`function* ${name}(`);
  assert.notEqual(at, -1, `no \`function* ${name}\` in the output`);
  const rest = code.slice(at);
  const end = rest.indexOf("\n    }\n");
  return end === -1 ? rest : rest.slice(0, end);
}

const OPCODE_ERA = ["v84", "v94", "v96"] as const;
const LOWERED_ERA = ["v98", "v99"] as const;
const RESIDUE = /__state|__done|__sent|__isReturn|__isThrow|__this\b|__args\b/;

// The two cyclic groups spec 25 section 1.4 named and refused.
const CYCLIC = [
  ["23-generator-basic", "counter"],
  ["26-infinite-generator-take", "naturals"],
] as const;

// ---------------------------------------------------------------------------
// Section 5 items 1-3: the back edge is recovered, and only by this rung.
// ---------------------------------------------------------------------------

for (const version of OPCODE_ERA) {
  test(`yield-loop recovers the cyclic generators as function* with a loop at ${version}`, () => {
    for (const [fixture, name] of CYCLIC) {
      const on = js(fixture, version);
      const off = js(fixture, version, ["yield-loop"]);
      assert.doesNotMatch(off, new RegExp(`function\\* ${name}\\(`), `${fixture} ${version}: ${name} is yield-loop's, so yield-recovery alone must leave it a shim (R-Y5)`);
      const body = generatorBody(on, name);
      assert.match(body, /while \(true\)/, `${fixture} ${version}: the back edge must become a real loop`);
      assert.match(body, /\byield\b/, `${fixture} ${version}: the suspend site must become a yield`);
      assert.match(body, /continue [A-Za-z_$][\w$]*;/, `${fixture} ${version}: the back edge must be spelled as a labelled continue`);
      assert.equal(count(on, /__hbc_makeGenerator\(/g), count(off, /__hbc_makeGenerator\(/g) - 1, `${fixture} ${version}: exactly one further shim site is consumed`);
    }
  });

  test(`yield-loop leaves no protocol residue in a group it recovered at ${version}`, () => {
    for (const [fixture, name] of CYCLIC) {
      assert.doesNotMatch(generatorBody(js(fixture, version), name), RESIDUE, `${fixture} ${version}: ${name}`);
    }
  });
}

test("yield-loop is inert at v98/v99, where a generator is gen-lowered's idiom (catalogue row 18)", () => {
  for (const version of LOWERED_ERA) {
    for (const [fixture] of CYCLIC) {
      assert.equal(js(fixture, version), js(fixture, version, ["yield-loop"]), `${fixture} ${version}: the version guard must make the rung a no-op`);
    }
  }
});

test("yield-loop does not touch the acyclic groups yield-recovery already owns", () => {
  for (const version of OPCODE_ERA) {
    for (const fixture of ["24-generator-return-throw", "27-async-await-basic", "28-async-await-error"]) {
      assert.equal(js(fixture, version), js(fixture, version, ["yield-loop"]), `${fixture} ${version}`);
    }
    // 25-generator-delegation's `inner` is yield-recovery's; `outer` and
    // `delegatesToArray` stay refused (R-Y6), back edge or not.
    const on = js("25-generator-delegation", version);
    assert.match(on, /function\* inner\(/, version);
    for (const delegating of ["outer", "delegatesToArray"]) {
      assert.doesNotMatch(on, new RegExp(`function\\* ${delegating}\\(`), `${version}: ${delegating} delegates (R-Y6)`);
    }
  }
});

// ---------------------------------------------------------------------------
// Section 5 item 4: refusals are counted and reported, never silent.
// ---------------------------------------------------------------------------

test("spec 29 section 4: a yield-loop refusal surfaces as a W_PASS_REFUSED diagnostic", () => {
  const r = decompile(readFileSync(join(CONSTRUCTS, "26-infinite-generator-take", "v94.hbc")), { resolveV98Ambiguity: true });
  const refused = r.diagnostics.filter((d) => d.code === "W_PASS_REFUSED" && (d.context as { pass?: string }).pass === "yield-loop");
  assert.ok(refused.length > 0, "yield-loop must report its refusals for this fixture");
  assert.ok(
    refused.some((d) => (d.context as { reason?: string }).reason === "sent-value-aliased"),
    `fibonacci's destructuring body is R-Y9; got ${JSON.stringify(refused.map((d) => d.context))}`,
  );
});

// ---------------------------------------------------------------------------
// Section 5 item 5: `restructureSegments` (spec 25's F25-4) on its own.
// ---------------------------------------------------------------------------

const brk = (label: string | null): Stmt => ({ k: "break", label });
const lbl = (label: string, body: readonly Stmt[]): Stmt => ({ k: "labeled", label, body });
const nop = (name: string): Stmt => ({ k: "expr", expr: { k: "assign", target: { k: "ident", name }, value: { k: "lit", text: "0" } } });

test("restructureSegments: a body with no escaping break is returned unchanged, with no loop", () => {
  const body = [lbl("L0", [brk("L0")]), nop("r0")];
  const r = restructureSegments(body);
  assert.ok(r.ok);
  assert.equal(r.loops, 0);
  assert.deepEqual(r.body, body);
});

test("restructureSegments: one back edge becomes one labelled `while (true)` with a `continue`", () => {
  //  L0: { r0 = 0; }  r1 = 0; break L0;   <- the break has escaped L0
  const r = restructureSegments([lbl("L0", [nop("r0")]), nop("r1"), brk("L0")]);
  assert.ok(r.ok);
  assert.equal(r.loops, 1);
  assert.equal(r.body.length, 2);
  const loop = r.body[1]!;
  assert.equal(loop.k, "while");
  assert.equal(loop.k === "while" ? loop.label : null, "L0");
  const inner = loop.k === "while" ? loop.body : [];
  assert.deepEqual(
    inner.map((s) => s.k),
    ["expr", "continue", "break"],
    "the escaped break becomes `continue L0` and the loop gets its fallthrough exit",
  );
});

test("restructureSegments: R-YL2 refuses a break whose label has no block at all", () => {
  const r = restructureSegments([nop("r0"), brk("L9")]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /break L9/);
});

test("restructureSegments: R-YL3 refuses an escaped `continue`", () => {
  const r = restructureSegments([lbl("L0", [nop("r0")]), { k: "continue", label: "L0" }]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /continue L0/);
});

test("restructureSegments: a nested function is opaque -- its breaks are not this body's edges", () => {
  const inner: Stmt = { k: "func", name: "f", params: [], body: [brk("L0")] };
  const body = [lbl("L0", [nop("r0")]), inner];
  const r = restructureSegments(body);
  assert.ok(r.ok);
  assert.equal(r.loops, 0);
});
