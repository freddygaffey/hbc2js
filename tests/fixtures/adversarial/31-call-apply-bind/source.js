// this/hoisting: call, apply, bind manipulations

function greet(greeting, punct) {
  return greeting + ' ' + this.name + punct;
}

const person = { name: 'Alice' };

// call immediately invokes with this binding
const r1 = greet.call(person, 'Hello', '!');

// apply is like call but with array of args
const r2 = greet.apply(person, ['Hi', '?']);

// bind returns a new function with bound this
const boundGreet = greet.bind(person);
const r3 = boundGreet('Hey', '~');

// bind with partial application
const boundWithGreeting = greet.bind(person, 'Bye');
const r4 = boundWithGreeting('.');

print('call:', r1);
print('apply:', r2);
print('bind:', r3);
print('bind+partial:', r4);
