// tests/fuzz/fixtures/minimise-sample.js — fuzz-private fixture for T3
// (tests/fuzz/minimise.test.ts). Not a construct fixture: this never runs
// through the real decompiler or oracle ladder, it's only text the T3 test
// feeds to src/fuzzgen/minimise.ts against a fake `reproduces` stub that
// returns true iff the MARKER line is present.
let a = 1;
let b = 2;
let c = 3;
function noise1() {
  return a + b;
}
function noise2() {
  return b * c;
}
print('filler', a, b, c);
print('MARKER');
print('more filler', noise1(), noise2());
let d = 4;
let e = 5;
print(d + e);
