// A write into `arguments` materialises the object (ReifyArguments); every later
// "lazy" read (GetArgumentsPropByVal / GetArgumentsLength) must then go through
// that materialised object rather than the frame's incoming arguments, because
// the lazy opcodes take the lazy-arguments register as their last operand.
// docs/BUGS.md `arity/arguments-aliasing`.
//
// Every index touched here is outside the function's declared parameter list, so
// Node's mapped sloppy `arguments` and Hermes's unmapped one agree (D14) and this
// fixture measures the reify/read-back path only, not aliasing.

function writeThenRead() {
  arguments[0] = 'written';
  return arguments[0] + '|' + arguments.length;
}
print('write then read:', writeThenRead('incoming'));
print('write then read, no args:', writeThenRead());

function writeBeyondArity(a) {
  arguments[1] = 'beyond';
  return a + '|' + arguments[1] + '|' + arguments.length;
}
print('beyond arity:', writeBeyondArity('a0', 'b0'));

function growThenRead() {
  arguments[3] = 'grown';
  return arguments.length + '|' + String(arguments[2]) + '|' + arguments[3];
}
print('grown:', growThenRead('x'));

function lengthWrite() {
  var a = arguments;
  a.length = 1;
  return a.length + '|' + arguments.length;
}
print('length write:', lengthWrite(1, 2, 3));

function deleteThenRead() {
  delete arguments[0];
  return String(arguments[0]) + '|' + arguments.length;
}
print('delete then read:', deleteThenRead('gone'));

function copyThenRead() {
  var a = arguments;
  a[0] = 'copy';
  return a[0] + '|' + arguments[0];
}
print('copy then read:', copyThenRead('orig'));

function conditionalReify(flag) {
  if (flag) {
    arguments[1] = 'cond';
  }
  return String(arguments[1]);
}
print('conditional reify, taken:', conditionalReify(true, 'given'));
print('conditional reify, not taken:', conditionalReify(false, 'given'));

function neverReified() {
  var total = 0;
  for (var i = 0; i < arguments.length; i++) total += arguments[i];
  return total + ':' + arguments.length;
}
print('read only:', neverReified(1, 2, 3));
