// tools/e2e/roundtrip-corpus.ts's pure pieces (docs/TESTING.md "E2E tier
// 1"): bucket naming, width-variant folding, hermesc error classing and stub
// detection. The corpus run itself is the sweep-tier
// tests/sweep/e2e/roundtrip-ratchet.test.ts; these keep the classifier
// honest at gate cost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstDiffBucket, foldWidthVariants, hermescErrorClass, knownBundles, stubbedFunctionsIn } from "../../../tools/e2e/roundtrip-corpus.ts";

test("firstDiffBucket names the first differing opcode pair, or the operand class when the opcode agrees", () => {
  const a = ["fn(2) ~", "LoadParam %0, 1", "GetById %1, %0, s#\"x\"", "Ret %1"].join("\n");
  assert.equal(firstDiffBucket(a, ["fn(2) ~", "LoadParam %0, 1", "GetByVal %1, %0, %2", "Ret %1"].join("\n")), "diff:GetById/GetByVal");
  assert.equal(firstDiffBucket(a, ["fn(2) ~", "LoadParam %0, 1", "GetById %1, %0, s#\"y\"", "Ret %1"].join("\n")), "diff:GetById(string)");
  assert.equal(firstDiffBucket(a, ["fn(2) ~", "LoadParam %0, 1", "GetById %1, %1, s#\"x\"", "Ret %1"].join("\n")), "diff:GetById(reg)");
  assert.equal(firstDiffBucket(a, ["fn(2) ~", "LoadParam %0, 2", "GetById %1, %0, s#\"x\"", "Ret %1"].join("\n")), "diff:LoadParam(imm)");
  assert.equal(firstDiffBucket(a, ["fn(3) ~", "LoadParam %0, 1"].join("\n")), "diff:param-count");
  assert.equal(firstDiffBucket(a, ["fn(2) ~", "LoadParam %0, 1", "GetById %1, %0, s#\"x\""].join("\n")), "diff:Ret/<end>");
  assert.equal(firstDiffBucket(a, a + "\nL1: Jmp L1"), "diff:<end>/Jmp");
});

test("foldWidthVariants collapses Short/Long/LongIndex opcode forms but leaves value-driven widths alone", () => {
  const text = ["fn(1) ~", "L1: GetByIdShort %0, %1, s#\"a\"", "GetByIdLong %0, %1, s#\"b\"", "LoadConstStringLongIndex %2, s#\"c\"", "JmpLong L1", "LoadConstUInt8 %3, 4", "Call2 %0, %1, %2, %3"].join("\n");
  assert.equal(foldWidthVariants(text), ["fn(1) ~", "L1: GetById %0, %1, s#\"a\"", "GetById %0, %1, s#\"b\"", "LoadConstString %2, s#\"c\"", "Jmp L1", "LoadConstUInt8 %3, 4", "Call2 %0, %1, %2, %3"].join("\n"));
  // Two functions that differ only in the width forms fold to the same text.
  const a = "fn(0) ~\nGetById %0, %0, s#\"x\"\nRet %0";
  const b = "fn(0) ~\nGetByIdShort %0, %0, s#\"x\"\nRet %0";
  assert.equal(foldWidthVariants(a), foldWidthVariants(b));
});

test("hermescErrorClass strips positions, names and numbers so one bug is one bucket", () => {
  const cls = hermescErrorClass("/tmp/x/module_12.js:34:7: error: invalid assignment left-hand side 'r0'\n    r0 = 1;\n         ^");
  assert.equal(cls, "hermesc:invalid assignment left-hand side '_'");
  assert.equal(hermescErrorClass("module_1.js:2:3: error: identifier 'foo' redeclared at line 12"), hermescErrorClass("module_9.js:8:1: error: identifier 'bar' redeclared at line 3"));
  assert.equal(hermescErrorClass(""), "hermesc:exit");
  assert.ok(hermescErrorClass(`error: ${"x".repeat(200)}`).length <= "hermesc:".length + 70);
});

test("stubbedFunctionsIn finds emitModule's throwing stubs by function index and error code", () => {
  const src = [
    "function factory() {",
    "  function _fn12() {",
    "    // fn#12 \"x\" -- ISOLATED FAILURE",
    "    throw new Error(\"hbc2js: could not decompile fn#12 — E_EMIT_UNSUPPORTED at offset 40\");",
    "  }",
    "  function _fn13() { return 1; }",
    "  function _fn14() { throw new Error(\"hbc2js: could not decompile fn#14 — E_INTERNAL\"); }",
    "}",
  ].join("\n");
  const stubs = stubbedFunctionsIn(src);
  assert.deepEqual([...stubs.entries()], [
    [12, "E_EMIT_UNSUPPORTED"],
    [14, "E_INTERNAL"],
  ]);
  assert.equal(stubbedFunctionsIn("function factory() {}").size, 0);
});

test("knownBundles lists the three committed bundles first, local-corpus entries by manifest, no duplicate names", () => {
  const all = knownBundles();
  assert.deepEqual(
    all.filter((b) => b.committed).map((b) => b.name),
    ["rn-template-0.72", "react-navigation-example-0.85.3", "expensify-app-0.86.0"],
  );
  for (const b of all.filter((x) => !x.committed)) assert.match(b.name, /^local-/);
  assert.equal(new Set(all.map((b) => b.name)).size, all.length);
});
