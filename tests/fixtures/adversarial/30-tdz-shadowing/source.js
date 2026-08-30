// this/hoisting/TDZ: Temporal Dead Zone with shadowing

let outer = 'outer-value';
let trace = [];

function test() {
  trace.push('start');

  try {
    // Accessing inner before its declaration - TDZ error
    // even though there's an outer binding of the same name
    const val = inner;
    trace.push('got-inner:' + val);
  } catch (e) {
    trace.push('error:' + e.constructor.name);
  }

  // Now declare inner in this scope
  let inner = 'inner-value';
  trace.push('declared');
  trace.push(inner);

  // Access outer is still possible
  trace.push(outer);
}

test();
print('trace:', trace.join('|'));

// Verify outer still exists
print('outer after:', outer);
