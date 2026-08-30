// Classic var-in-loop closure bug: all closures observe the final loop value.
const closures = [];
for (var i = 0; i < 3; i++) {
  closures.push(function () { return i; });
}
print('var closures all see final i:', closures.map(function (f) { return f(); }).join(','));

const closures2 = [];
for (var j = 0; j < 3; j++) {
  (function (captured) {
    closures2.push(function () { return captured; });
  })(j);
}
print('IIFE-captured var closures:', closures2.map(function (f) { return f(); }).join(','));
