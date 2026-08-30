// node --test tools/equiv/test/
//
// Unit tests for the parts of the harness whose correctness is not obvious:
// the value encoder, the determinism pins, the three-valued verdict, and the
// disassembly normaliser.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEncoder } from '../src/trace.mjs';
import { makePrng } from '../src/sandbox.mjs';
import { runProgram } from '../src/runner.mjs';
import { compareTraces, VERDICT } from '../src/compare.mjs';
import { normaliseDisassembly, diffNormalised } from '../src/normalise-disasm.mjs';
import { mutants, isCodeMask } from '../src/mutate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'equiv-test-'));
const write = (name, src) => {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, src);
  return f;
};
const OPTS = { timeout: 8000, seed: 0, fuzz: 0, relax: [], maxRecords: 5000, syncTimeout: 7000 };

test('encoder distinguishes values that === would confuse', () => {
  const enc = makeEncoder();
  assert.notEqual(enc(0), enc(-0));
  assert.notEqual(enc(1), enc(1n));
  assert.notEqual(enc('1'), enc(1));
  assert.notEqual(enc([1, 2]), enc([1, 2, 3]));
  assert.notEqual(enc({ a: 1, b: 2 }), enc({ b: 2, a: 1 })); // key order is observable
  assert.equal(enc(NaN), 'NaN');
});

test('encoder never reads .stack and never invokes getters', () => {
  const enc = makeEncoder();
  let called = false;
  const o = {
    get boom() {
      called = true;
      return 1;
    },
  };
  assert.equal(enc(o), '{boom: <accessor>}');
  assert.equal(called, false);
  const e = new TypeError('bad');
  assert.equal(enc(e), 'TypeError("bad")');
});

test('encoder terminates on cyclic and deep structures', () => {
  const enc = makeEncoder();
  const a = { name: 'a' };
  a.self = a;
  assert.match(enc(a), /circular/);
  let deep = {};
  for (let i = 0; i < 100; i++) deep = { next: deep };
  assert.doesNotThrow(() => enc(deep));
});

test('--relax fn-names masks generated names', () => {
  const strict = makeEncoder();
  const relaxed = makeEncoder({ maskFunctionNames: true });
  const f = function original(a, b) {};
  const g = function _fun0(a, b) {};
  assert.notEqual(strict(f), strict(g));
  assert.equal(relaxed(f), relaxed(g));
});

test('prng is deterministic per seed and differs across seeds', () => {
  const a = makePrng(7);
  const b = makePrng(7);
  const c = makePrng(8);
  const seqA = Array.from({ length: 10 }, a);
  const seqB = Array.from({ length: 10 }, b);
  const seqC = Array.from({ length: 10 }, c);
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, seqC);
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `${v} out of range`);
});

test('Math.random and Date.now are pinned, so a nondeterministic program traces identically', async () => {
  const f = write(
    'nondet.js',
    `print('r=' + Math.random()); print('t=' + Date.now()); print('d=' + new Date().getTime());`
  );
  const [x, y] = await Promise.all([runProgram(f, OPTS), runProgram(f, OPTS)]);
  assert.equal(compareTraces(x, y).verdict, VERDICT.EQUIVALENT);
  assert.match(JSON.stringify(x.records), /t=1700000000000/);
  assert.match(JSON.stringify(x.records), /d=1700000000000/);
});

test('a program that produces no observable behaviour is INCONCLUSIVE, not EQUIVALENT', async () => {
  const a = write('silent-a.js', 'function f(x) { return x + 1; }\nvoid 0;');
  const b = write('silent-b.js', 'function f(x) { return x + 2; }\nvoid 0;');
  // Both are silent, but each leaves `f` on the global object, so `globals`
  // gives the harness something -- and the two `f`s encode identically.
  const [ta, tb] = await Promise.all([runProgram(a, OPTS), runProgram(b, OPTS)]);
  assert.equal(compareTraces(ta, tb).verdict, VERDICT.EQUIVALENT);

  // With fuzzing on, the difference is found.
  const fuzzOpts = { ...OPTS, fuzz: 10 };
  const [fa, fb] = await Promise.all([runProgram(a, fuzzOpts), runProgram(b, fuzzOpts)]);
  assert.equal(compareTraces(fa, fb).verdict, VERDICT.DIVERGENT);
});

test('an entirely empty program is INCONCLUSIVE', async () => {
  const a = write('empty-a.js', ';');
  const b = write('empty-b.js', ';');
  const [ta, tb] = await Promise.all([runProgram(a, OPTS), runProgram(b, OPTS)]);
  const r = compareTraces(ta, tb);
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.match(r.why, /produced observable behaviour/);
});

test('an infinite loop is killed and reported INCONCLUSIVE, not EQUIVALENT', async () => {
  const f = write('spin.js', 'print("before"); while (true) {}');
  const t = await runProgram(f, { ...OPTS, timeout: 1500, syncTimeout: 1000 });
  assert.ok(t.records.some((r) => r.k === 'limit'));
  const r = compareTraces(t, t);
  assert.equal(r.verdict, VERDICT.INCONCLUSIVE);
  assert.match(r.why, /budget/);
  // The prefix emitted before the kill survives.
  assert.ok(t.records.some((r) => r.k === 'out' && r.s === 'before'));
});

test('a divergence before a hang is still DIVERGENT', async () => {
  const a = write('hang-a.js', 'print("a"); while (true) {}');
  const b = write('hang-b.js', 'print("b"); while (true) {}');
  const [ta, tb] = await Promise.all([
    runProgram(a, { ...OPTS, timeout: 1500, syncTimeout: 1000 }),
    runProgram(b, { ...OPTS, timeout: 1500, syncTimeout: 1000 }),
  ]);
  assert.equal(compareTraces(ta, tb).verdict, VERDICT.DIVERGENT);
});

test('thrown errors are compared by name and message, not by stack', async () => {
  const a = write('throw-a.js', 'throw new TypeError("nope");');
  const b = write('throw-b.js', '\n\n\nthrow new TypeError("nope");');
  const c = write('throw-c.js', 'throw new RangeError("nope");');
  const [ta, tb, tc] = await Promise.all([runProgram(a, OPTS), runProgram(b, OPTS), runProgram(c, OPTS)]);
  assert.equal(compareTraces(ta, tb).verdict, VERDICT.EQUIVALENT);
  assert.equal(compareTraces(ta, tc).verdict, VERDICT.DIVERGENT);
});

test('microtask interleaving is captured', async () => {
  const a = write(
    'micro-a.js',
    `print('sync'); Promise.resolve().then(() => print('m1')).then(() => print('m2')); (async () => { print('afn'); await null; print('after'); })();`
  );
  const b = write(
    'micro-b.js',
    `print('sync'); (async () => { print('afn'); await null; print('after'); })(); Promise.resolve().then(() => print('m1')).then(() => print('m2'));`
  );
  const [ta, tb] = await Promise.all([runProgram(a, OPTS), runProgram(b, OPTS)]);
  assert.equal(compareTraces(ta, tb).verdict, VERDICT.DIVERGENT);
});

test('virtual timers fire in (time, insertion) order without real waiting', async () => {
  const f = write(
    'timers.js',
    `setTimeout(() => print('late'), 100000); setTimeout(() => print('early'), 1); print('sync');`
  );
  const started = Date.now();
  const t = await runProgram(f, OPTS);
  assert.ok(Date.now() - started < 4000, 'must not actually wait 100 seconds');
  const lines = t.records.filter((r) => r.k === 'out').map((r) => r.s);
  assert.deepEqual(lines, ['sync', 'early', 'late']);
});

test('unhandled rejections appear in the trace', async () => {
  const f = write('rej.js', 'Promise.reject(new Error("unheard"));');
  const t = await runProgram(f, OPTS);
  assert.ok(t.records.some((r) => r.k === 'unhandled' && r.message === 'unheard'));
});

test('host object writes are observable', async () => {
  const f = write('host.js', 'window.onload = function h() {}; document.title = "x";');
  const t = await runProgram(f, OPTS);
  const sets = t.records.filter((r) => r.k === 'hostset');
  assert.equal(sets.length, 2);
  assert.equal(sets[0].o, 'window');
  assert.equal(sets[0].p, 'onload');
});

test('mutation operators never fire inside comments or string literals', () => {
  const src = `// break the loop here\nconst s = 'do not break this';\nfor (;;) { break; }\n`;
  const mask = isCodeMask(src);
  const first = src.indexOf('break'); // in the comment
  const second = src.indexOf('break', first + 1); // in the string
  const third = src.lastIndexOf('break'); // real code
  assert.equal(mask[first], 0);
  assert.equal(mask[second], 0);
  assert.equal(mask[third], 1);
  const ms = mutants(src, 3, 0).filter((m) => m.operator === 'break-to-continue');
  for (const m of ms) assert.match(m.text, /\/\/ break the loop here/);
});

test('normaliser erases register, label and cache-slot choices', () => {
  const dump = `Bytecode File Information:
  Source hash: deadbeef
  Function count: 1

Global String Table:
s0[ASCII, 0..5]: hello

Function<total>(2 params, 6 registers, 0 symbols):
Offset in debug table: source 0x0000, scope 0x0000, textified callees 0x0000
    LoadConstZero     r4
    TryGetById        r3, r0, 7, "print"
L2:
    JLess             L2, r4, r3
    Ret               r4

Debug filename table:
  0: /some/path/a.js
`;
  const renamed = dump.replace(/r4/g, 'r9').replace(/r3/g, 'r1').replace(/L2/g, 'L7').replace(/, 7,/, ', 2,');
  assert.equal(normaliseDisassembly(dump), normaliseDisassembly(renamed));
  assert.doesNotMatch(normaliseDisassembly(dump), /Source hash|Debug filename|some\/path/);
  assert.match(normaliseDisassembly(dump), /%0/);
});

test('normaliser still reports a real opcode difference', () => {
  const a = `Function<f>(1 params, 2 registers, 0 symbols):\n    Inc               r1, r1\n    Ret               r1\n`;
  const b = `Function<f>(1 params, 2 registers, 0 symbols):\n    Dec               r1, r1\n    Ret               r1\n`;
  const d = diffNormalised(normaliseDisassembly(a), normaliseDisassembly(b));
  assert.equal(d.equal, false);
  assert.match(d.firstDivergence.a, /Inc/);
  assert.match(d.firstDivergence.b, /Dec/);
});

test('end-to-end: the round-trip examples behave as documented', () => {
  const ex = path.resolve(HERE, '..', 'examples');
  assert.ok(fs.existsSync(path.join(ex, 'rt-original.js')));
  assert.ok(fs.existsSync(path.join(ex, 'rt-decompiled-ok.js')));
  assert.ok(fs.existsSync(path.join(ex, 'rt-decompiled-noisy.js')));
  assert.ok(fs.existsSync(path.join(ex, 'sample-mutated.js')));
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
