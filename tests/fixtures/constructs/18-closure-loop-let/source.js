// let-in-loop per-iteration binding: each closure captures its own value.
const closures = [];
for (let i = 0; i < 3; i++) {
  closures.push(function () { return i; });
}
print('let closures each see own i:', closures.map(function (f) { return f(); }).join(','));

const closures2 = [];
for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 2; j++) {
    closures2.push(function () { return i + ':' + j; });
  }
}
print('nested let closures:', closures2.map(function (f) { return f(); }).join(' | '));
