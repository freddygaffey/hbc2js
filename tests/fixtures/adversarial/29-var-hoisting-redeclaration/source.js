// this/hoisting: var hoisting with same-name function

let trace = [];

// Function declaration is hoisted
trace.push(typeof myVar);  // should be 'function'

function myVar() {
  return 'function-value';
}

trace.push(typeof myVar);  // still 'function'

// var declaration happens but is already hoisted as undefined
var myVar = 'string-value';

trace.push(typeof myVar);  // should be 'string'
trace.push(myVar);

// Call check
if (typeof myVar === 'string') {
  trace.push('is-string');
} else {
  trace.push('not-string');
}

print('hoisting trace:', trace.join('|'));
