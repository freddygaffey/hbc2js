// D13a stress fixture: genuinely irreducible CFG, loop-driven family (no
// exception handlers).
//
// Modeled on tests/fixtures/bundles/rn-template-0.72's fn#3251 (React Native's
// VirtualizedList windowing math -- a two-pointer expanding-window loop), read
// via `hbc2js disasm` -- see docs/lowering/irreducible-cfg.md section 2/4.
// That function is the largest irreducible region in the whole bundle (37
// duplicated blocks) with zero exception handlers, so its irreducibility comes
// from control flow alone: a `while` loop whose condition is a short-circuited
// OR of two independently side-effecting checks, each advancing its own
// pointer and each compiled to its own back-edge into the loop header. Ramsey
// cannot express "two different reasons to keep looping, each updating state
// differently" as a single structured loop without duplicating the
// loop-continue test, which is exactly what shows up as `duplicated>0`.
//
// Note what did NOT work (see irreducible-cfg.md section 3): a for(;;) switch
// state machine, twin loops beside an if, and a data-driven pc interpreter all
// compiled fully reducibly. The ingredient that actually matters here is the
// OR of two side-effecting predicates, not "looks like a loop with branches."
function expandWindow(lo0, hi0, n, weight) {
  var lo = lo0;
  var hi = hi0;
  while (checkLo(lo, weight) || checkHi(hi, n, weight)) {
    if (checkLo(lo, weight)) {
      lo = lo - 1;
    }
    if (checkHi(hi, n, weight)) {
      hi = hi + 1;
    }
  }
  return { lo: lo, hi: hi };
}

function checkLo(lo, weight) {
  return lo > 0 && weight > 0.2;
}
function checkHi(hi, n, weight) {
  return hi < n - 1 && weight < 0.8;
}

var r1 = expandWindow(3, 5, 10, 0.5);
print('both directions active:', r1.lo, r1.hi);

var r2 = expandWindow(3, 0, 10, 0.9);
print('lo-only branch:', r2.lo, r2.hi);

var r3 = expandWindow(0, 5, 10, 0.1);
print('hi-only branch:', r3.lo, r3.hi);

var r4 = expandWindow(0, 9, 10, 0.5);
print('already settled, loop body never runs:', r4.lo, r4.hi);
