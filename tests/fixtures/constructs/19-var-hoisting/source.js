// var hoisting across nested blocks/functions, including redeclaration.
function demo() {
  print('x before declaration:', x);
  var x = 1;
  print('x after assignment:', x);
  if (true) {
    var x = 2;
    print('x reassigned in block:', x);
  }
  print('x after block:', x);

  var x;
  print('redeclaration keeps value:', x);
  return x;
}
print('returned:', demo());

print('typeof hoistedFn before def:', typeof hoistedFn);
function hoistedFn() { return 'hoisted'; }
print('call after def:', hoistedFn());
