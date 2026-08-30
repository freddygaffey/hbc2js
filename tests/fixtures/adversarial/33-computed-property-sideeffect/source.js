// Values: computed property names with side effects

let evalTrace = [];

function propName(n) {
  evalTrace.push('name-' + n);
  return 'prop-' + n;
}

function propValue(n) {
  evalTrace.push('value-' + n);
  return 'val-' + n;
}

// Computed property names are evaluated at definition time
const obj = {
  [propName(1)]: propValue(1),
  [propName(2)]: propValue(2)
};

print('prop-1:', obj['prop-1']);
print('prop-2:', obj['prop-2']);
print('eval trace:', evalTrace.join('|'));

// Verify evaluation order: all keys first, then values
evalTrace = [];
const obj2 = {
  [propName('a')]: propValue('a'),
  [propName('b')]: propValue('b')
};

print('obj2 trace:', evalTrace.join('|'));
