// Round-trip demo (matching case). Plausible decompiler output for the same
// bytecode as rt-original.js: local names erased and regenerated, the `for`
// recovered as a `while`, `let` emitted as `var`, `+=` expanded. The global
// function name IS recoverable (it survives in the bytecode as a string
// operand of DeclareGlobalVar), so a decompiler keeps it.
//
// Normalised disassembly: IDENTICAL to rt-original.js.
function total(_arg0) {
  var _r1 = 0;
  var _r2 = 0;
  while (_r2 < _arg0) {
    _r1 = _r1 + _r2 * 2;
    _r2++;
  }
  return _r1;
}
print(total(10));
