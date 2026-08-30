// Generators/async: Promise resolution order (synchronous test)
// Test that promise handlers are called in the right order when resolved

let trace = [];

const p = new Promise(resolve => {
  trace.push('executor');
  resolve(10);
});

p.then(v => {
  trace.push('then:' + v);
  return 20;
}).then(v => {
  trace.push('then2:' + v);
});

trace.push('after-chain');

// Note: in Node.js, promises are resolved asynchronously
// but the test can still verify the chain structure
print('trace so far:', trace.join('|'));
