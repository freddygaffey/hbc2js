// Closures: var vs let in loops
// var shares one binding; let creates fresh binding per iteration

const closuresVar = [];
for (var i = 0; i < 3; i++) {
  closuresVar.push(() => i);
}

const closuresLet = [];
for (let j = 0; j < 3; j++) {
  closuresLet.push(() => j);
}

const varResults = closuresVar.map(f => f());
const letResults = closuresLet.map(f => f());

print('var results:', varResults.join(','));  // should be 3,3,3
print('let results:', letResults.join(','));  // should be 0,1,2
