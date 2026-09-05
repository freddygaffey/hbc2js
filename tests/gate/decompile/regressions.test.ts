// One test per bug found while bringing the M4 baseline green, each naming the
// input that exposed it. The corpus-wide tests (gate equivalence, `node --check`,
// the structurer's isomorphism check) would all catch a regression here too, but
// only as "some fixture broke"; these say which invariant was lost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseM4 } from "../../support/m4.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { augment, structure } from "../../../src/structure/index.ts";
import { emitModule } from "../../../src/emit/index.ts";
import { decompile } from "../../../src/decompile.ts";
import { runProgram } from "../../../src/harness/runner.ts";
import { findHermesVm, runHermes } from "../../../src/harness/hermes-vm.ts";
import { printLines } from "../../../src/harness/trace.ts";

function path(name: string, version: number): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}.hbc`);
}
function code(name: string, version: number): string {
  return decompile(new Uint8Array(readFileSync(path(name, version))), { resolveV98Ambiguity: true, moduleName: name }).code;
}
function analyse(name: string, version: number): ReturnType<typeof analyseModule> {
  const { module } = parseM4(new Uint8Array(readFileSync(path(name, version))));
  return analyseModule(module, { strictEnv: true });
}

// --- CFG ---------------------------------------------------------------------

test("SaveGenerator contributes no CFG edge (else the resume blocks are reachable twice)", () => {
  const a = analyse("23-generator-basic", 94);
  const cfg = a.cfg(2);
  const save = cfg.blocks.find((b) => b.instructions.some((i) => i.name === "SaveGenerator"))!;
  // The block runs `SaveGenerator; Ret`, so it terminates in `return` and has
  // no successor; the resume block is entered from §4.5's dispatcher only.
  assert.equal(save.terminator.kind, "return");
  assert.deepEqual(save.succs, []);
  for (const sp of cfg.generator.suspendPoints) {
    assert.deepEqual(cfg.blocks[sp.resumeBlock]!.preds, [cfg.entry]);
  }
});

test("a zero-byte function body is one returning block, not an error", () => {
  // 01-if-else-chain/v99.obf.hbc function #6 is `size=0` and shares another
  // function's offset.
  const p = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "v99.obf.hbc");
  const { module } = parseM4(new Uint8Array(readFileSync(p)));
  const a = analyseModule(module, { strictEnv: false });
  const empty = module.functions.findIndex((f) => f.header.bytecodeSizeInBytes === 0);
  assert.ok(empty >= 0, "the fixture no longer contains a zero-byte function");
  const cfg = a.cfg(empty);
  assert.equal(cfg.blocks.length, 1);
  assert.equal(cfg.blocks[0]!.terminator.kind, "return");
});

test("an environment stored into another environment's slot is declared where that one lives", () => {
  // 23-generator-basic v99 function #3 creates its locals' environment on the
  // first resume and stores it into the wrapper's environment. Declaring the
  // slots in the body would reset them on every .next().
  const a = analyse("23-generator-basic", 99);
  assert.ok(a.envGraph.envInSlot.size > 0, "no environment is held in a slot any more");
  const text = code("23-generator-basic", 99);
  // The wrapper (_fn1/_fn2) must declare the slots, not the body (_fn3/_fn4).
  // `_fn1` is the wrapper and `_fn3` the body; the body's own environment
  // (`_e3_*`) must be declared alongside the wrapper's, above the body's own
  // declaration. Since `fn-naming` (row R4) landed, `_fn3` itself is renamed
  // to `sequence` (both function-table entries #1 and #3 carry the same
  // Hermes-inferred name "sequence"; #3, processed first as the innermost
  // site, wins it — #1's own candidacy then refuses `already-declared`,
  // `declaredNames` walking into #1's already-renamed nested body) — the
  // wrapper `_fn1` itself stays unrenamed, so the regex below still anchors
  // on it, just looking for `function sequence` instead of `function _fn3`.
  const wrapper = /function _fn1\([^)]*\) \{([\s\S]*?)function sequence/.exec(text);
  assert.ok(wrapper !== null, "the emitted nesting changed shape");
  assert.match(wrapper[1]!, /let _e1_0[^;]*_e3_0;/);
});

// --- structurer --------------------------------------------------------------

test("a plain while loop needs no dispatch variable (the loop wrapper goes outside the merge kids)", () => {
  // With the loop wrapper in `nodeWithin`'s base case, the latch block is a
  // merge kid emitted *outside* the loop and its back edge has no label: 62 of
  // 2026 gate functions fell through to dispatch mode.
  for (const version of [84, 94, 96, 98, 99]) {
    const s = structure(analyse("02-while-loop", version).cfg(0), { verify: true });
    assert.equal(s.stats.dispatchVars, 0, `v${version}`);
    assert.equal(s.stats.duplicated, 0, `v${version}`);
  }
});

test("a merge point is measured by edge in-degree, not predecessor count", () => {
  // §4.5's resume dispatcher sends both `case 0` and `default` to the real
  // entry block. Counting deduplicated predecessors makes it a non-merge point,
  // so its subtree is inlined twice and P3 fires.
  const cfg = analyse("23-generator-basic", 94).cfg(2);
  const g = augment(cfg);
  const dispatcher = g.blocks[g.entry]!;
  const realEntry = dispatcher.succs[0]!.to;
  assert.equal(g.preds[realEntry]!.length, 1, "the dispatcher is no longer the only predecessor");
  assert.ok(g.mergePoints.has(realEntry), "the real entry is not a merge point");
  assert.equal(structure(cfg, { verify: true }).stats.duplicated, 0);
});

test("dispatch mode routes exceptions by __pc, and keeps the whole function reachable", () => {
  // 16-finally-with-break-continue is genuinely irreducible at v84/94/96. A
  // scoped dispatch loop `break`s out of the *root* loop when the target is
  // inside a region, which silently ended the function: the fixture produced no
  // output at all.
  for (const version of [84, 94, 96]) {
    const s = structure(analyse("16-finally-with-break-continue", version).cfg(0), { verify: true });
    assert.equal(s.stats.dispatchVars, 1, `v${version}`);
    const text = code("16-finally-with-break-continue", version);
    assert.match(text, /if \(!\(__pc >= \d+ && __pc <= \d+\)\) \{\n\s+throw _exc\d+;/, `v${version}: no __pc guard`);
  }
});

// --- emitter -----------------------------------------------------------------

test("`new` is emitted at the Construct, not at the SelectObject", () => {
  // 07-for-of-iterable v99 writes `NewArray r2, 0` between `Construct …, r2, 2`
  // and its `SelectObject`; emitting the `new` at the SelectObject read the
  // clobbered callee and threw "r2 is not a constructor".
  const text = code("07-for-of-iterable", 99);
  assert.match(text, /new r\d+\(/);
  assert.ok(!text.includes("SelectObject"));
});

test("the `new` triple is matched across basic blocks", () => {
  // In real bundles the CreateThis and its Construct are routinely separated by
  // a branch; a per-block matcher left a bare CreateThis.
  for (const version of [84, 94, 96, 98, 99]) {
    const text = code("12-try-catch-finally-return", version);
    assert.ok(!text.includes("CreateThis"), `v${version}`);
  }
});

test("AddOwnPrivateBySym is (object, value, symbol)", () => {
  // The vendored doc comment says "Arg1[Arg2] = Arg3"; the bytecode of
  // 35-class-private-fields v99 function #1 says otherwise, and reading it the
  // documented way made every private-field brand check fail.
  const text = code("35-class-private-fields", 99);
  assert.match(text, /Object\.defineProperty\(r\d+, r\d+, \{value: r\d+/);
  assert.ok(!text.includes("Private element not found") || text.includes("__hbc_b_throwTypeError"));
});

test("a rest parameter does not count towards Function.prototype.length", () => {
  // v<=96 counts the rest element in paramCount and v>=97 does not; both must
  // emit `length === 1` for `html(strings, ...values)`. `fn-naming` (row R4)
  // now renames the declaration from `_fnN` to `html` (its own functionName
  // evidence), so the declared-name capture group accepts either. `values`
  // itself used to survive only as a body-level `__hbc_b_copyRestArgs` call
  // (so the printed param list was just `a1`, with no `...` at all — the
  // param-count assertion this test is really after was, until now, only
  // ever true "by omission"); `spread-rest` (M5 rung 17, 2026-09-02)
  // recovers it as a real `...` rest parameter, so `html`'s declared
  // (non-rest) param count is still exactly 1 — the assertion below is
  // stated against `Param.rest` now, the same "does a rest param count
  // towards paramCount" fact this test has always been about, just checked
  // the way spec 15 §2's own table checks it instead of by the absence of
  // any `...` syntax to check.
  for (const version of [84, 94, 96, 98, 99]) {
    const text = code("44-tagged-templates", version);
    const m = /function (_fn\d+|html)\(([^)]*)\) \{\n\s+\/\/ fn#\d+ "html"/.exec(text);
    assert.ok(m !== null, `v${version}: html not found in the output`);
    const params = m[2]!.trim();
    assert.match(params, /^a1(, \.\.\.\w+)?$/, `v${version}: html has params "${params}"`);
    const declaredCount = params.split(",").filter((p) => !p.trim().startsWith("...")).length;
    assert.equal(declaredCount, 1, `v${version}: html has params "${params}"`);
  }
});

test("the module is wrapped so helpers and _fnN never become globals", () => {
  const text = code("01-if-else-chain", 94);
  assert.match(text, /^\/\/ hbc2js[\s\S]*?\n\(function \(\) \{/m);
  assert.match(text, /\}\)\(\);\n$/);
});

test("the generator shim's object has no own properties, like a real generator", () => {
  const text = code("23-generator-basic", 94);
  assert.match(text, /return Object\.create\(proto\);/);
});

test("HermesInternal is supplied by the prelude, not read off globalThis", () => {
  // hermesc lowers template literals to unconditional HermesInternal.concat
  // calls with no fallback (43-template-literals v94 offset 0x1c).
  const text = code("43-template-literals", 94);
  assert.match(text, /var __hbc_HermesInternal = \{/);
  assert.ok(!text.includes('"HermesInternal" in'), "the host object is still read off the global object");
});

test("object literal values decode per era: ByteString is a string id at v<=96 and `undefined` at v>=97", () => {
  // 24-generator-return-throw v99's "already finished" result decodes as
  // {value: undefined, done: true}; reading tag 6 with a payload byte gives
  // {value: "next", done: 1} and swallows the next entry's run header.
  const v99 = code("24-generator-return-throw", 99);
  assert.match(v99, /\{value: undefined, done: true\}/);
  // v<=96 still reads a 1-byte string id, so a legacy object literal keeps its
  // string values.
  const v94 = code("38-destructuring-object", 94);
  assert.match(v94, /\{\w+: /);
});

test("an environment created inside a loop gets one binding per iteration", () => {
  // 17-closure-loop-var v99 emits CreateFunctionEnvironment *in* the loop; a
  // function-top `let` made every IIFE-captured closure share it (2,2,2
  // instead of 0,1,2).
  const text = code("17-closure-loop-var", 99);
  // Any loop form: spec 07's loop-cond prints this one as `do { … } while (c)`.
  const inLoop = /(while \(|do \{|for \()[\s\S]*?let _e\d+_\d+;[\s\S]*?\}/.exec(text);
  assert.ok(inLoop !== null, "the loop-local environment declaration was hoisted again");
});

test("emitModule reports the helpers it used and no others", () => {
  const { module } = parseM4(new Uint8Array(readFileSync(path("01-if-else-chain", 94))));
  const r = emitModule(analyseModule(module, { strictEnv: true }), { provenanceComments: false });
  assert.deepEqual([...r.helpersUsed].sort(), ["__hbc_iterBegin", "__hbc_iterClose", "__hbc_iterNext", "__hbc_notIterable"]);
});

// docs/BUGS.md "02-proxy-trap-counting" / docs/DECISIONS.md D14: an `in`
// expression invokes a Proxy's `has` trap, an observable side effect, even
// when its boolean result is discarded (`const hasX = 'x' in proxy;` with
// `hasX` unused). `expr-rebuild`'s R1b dead-store rule used to ask
// `isPure(value)` whether it could delete the whole statement outright
// instead of keeping it as a bare expression statement for its effect, and
// `isPure` treated every `bin`/`unary` node as pure regardless of operator —
// so at v94/v96 (where the store landed on a register never read again) the
// `in` vanished entirely and the VM's has-trap invocation went unobserved.
// v99's bytecode shape happened to read the register back, so it never hit
// the same rule and was never affected. Cross-checked directly against the
// Hermes VM (D14 ground truth), not just Node, at every version a VM exists
// for.
for (const version of [94, 96, 99] as const) {
  test(`adversarial/02-proxy-trap-counting v${version}: an unused 'in' still invokes the Proxy has-trap (matches the Hermes VM)`, async (t) => {
    const vm = findHermesVm(version);
    if (vm === null) {
      t.skip(`no Hermes VM for v${version} (see docs/TOOLCHAIN.md "Hermes VM (source build)")`);
      return;
    }

    const hbcPath = join(repoRoot(), "tests", "fixtures", "adversarial", "02-proxy-trap-counting", `v${version}.hbc`);
    const hbcBytes = new Uint8Array(readFileSync(hbcPath));
    const src = decompile(hbcBytes, { resolveV98Ambiguity: true, moduleName: "02-proxy-trap-counting" }).code;

    const dir = mkdtempSync(join(tmpdir(), "hbc2js-proxy-trap-"));
    try {
      const candidatePath = join(dir, "candidate.js");
      writeFileSync(candidatePath, src);

      const reference = runHermes(vm.path, hbcPath, { timeout: 10000, bytecode: true });
      assert.ok(reference.ok, `Hermes VM run failed at v${version}: ${reference.raw}`);
      assert.deepEqual(reference.lines, ["read value: 10", "get traps: 1", "has traps: 1", "set traps: 1"], `the VM itself didn't report has-traps: 1 at v${version} — the fixture, not the decompiler, would be wrong`);

      const candidate = await runProgram(candidatePath, { timeout: 10000 });
      assert.deepEqual(printLines(candidate.records), reference.lines, `decompiled v${version} output diverges from the Hermes VM — the 'in' statement (and its has-trap side effect) was dropped as dead code:\n${src}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// docs/BUGS.md `arity/arguments-aliasing` (campaign-2, 2026-09-05). The lazy
// `arguments` opcodes take the function's lazy-arguments register as their last
// operand: `GetArgumentsPropByVal dst, idx, lazyReg` and `GetArgumentsLength
// dst, lazyReg`. That register holds `undefined` until a `ReifyArguments*`
// materialises the object into it, and the materialised object afterwards -- so
// once a function has written into `arguments`, every later lazy read must go
// through the written object, not the frame's incoming arguments. `src/emit`
// ignored the operand and always emitted the host `arguments`, which silently
// dropped every write: at v84 the VM prints `write then read: written|1` and the
// candidate printed `incoming|1`. Fixed by routing the reads of a function that
// reifies through `__hbc_argsLive`; a function that never reifies keeps the
// plain `arguments` form. Fixture `69-arguments-reify-readback` keeps every
// touched index outside the declared parameter list, so Node's mapped sloppy
// `arguments` and Hermes's unmapped one agree (D14) and the fixture measures the
// reify/read-back path only.
for (const version of [84, 94, 96, 98, 99] as const) {
  test(`69-arguments-reify-readback v${version}: a write into a reified 'arguments' is visible to the later lazy reads`, async (t) => {
    void t;
    const name = "69-arguments-reify-readback";
    const src = code(name, version);
    const expected = readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, "expected.txt"), "utf8").trimEnd().split("\n");
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-args-reify-"));
    try {
      const candidatePath = join(dir, "candidate.js");
      writeFileSync(candidatePath, src);
      const candidate = await runProgram(candidatePath, { timeout: 10000 });
      assert.deepEqual(printLines(candidate.records), expected, `decompiled v${version} output diverges from the oracle -- a write through the reified 'arguments' object was lost:\n${src}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The same fixture against the real Hermes VM (D14 ground truth) wherever one
// exists, so the oracle above is not merely Node agreeing with Node.
for (const version of [84, 94, 96, 99] as const) {
  test(`69-arguments-reify-readback v${version}: the reified read-back matches the Hermes VM`, async (t) => {
    const vm = findHermesVm(version);
    if (vm === null) {
      t.skip(`no Hermes VM for v${version} (see docs/TOOLCHAIN.md "Hermes VM (source build)")`);
      return;
    }
    const name = "69-arguments-reify-readback";
    const hbcPath = path(name, version);
    const src = code(name, version);
    const dir = mkdtempSync(join(tmpdir(), "hbc2js-args-reify-vm-"));
    try {
      const candidatePath = join(dir, "candidate.js");
      writeFileSync(candidatePath, src);
      const reference = runHermes(vm.path, hbcPath, { timeout: 10000, bytecode: true });
      assert.ok(reference.ok, `Hermes VM run failed at v${version}: ${reference.raw}`);
      assert.equal(reference.lines[0], "write then read: written|1", `the VM itself did not read back the written value at v${version} -- the fixture, not the decompiler, would be wrong`);
      const candidate = await runProgram(candidatePath, { timeout: 10000 });
      assert.deepEqual(printLines(candidate.records), reference.lines, `decompiled v${version} output diverges from the Hermes VM:\n${src}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
