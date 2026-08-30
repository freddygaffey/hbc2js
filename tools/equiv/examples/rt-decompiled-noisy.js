// Round-trip demo (false-positive case). Semantically identical to
// rt-decompiled-ok.js -- the ONLY change is `_r2++` written as `_r2 = _r2 + 1`.
// Hermes compiles the first to `Inc` and the second to `LoadConstUInt8 1` +
// `Add`, which costs one extra register, which shifts every later register
// number, which collapses the normalised similarity from 100% to ~72%.
//
// This is the fundamental limitation of a normalised-disassembly diff: it
// answers "did we regenerate the same bytecode", not "is this the same
// program", and small idiom differences cascade through register allocation.
function total(_arg0) {
  var _r1 = 0;
  var _r2 = 0;
  while (_r2 < _arg0) {
    _r1 = _r1 + _r2 * 2;
    _r2 = _r2 + 1;
  }
  return _r1;
}
print(total(10));
