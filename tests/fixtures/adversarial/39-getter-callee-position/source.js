// Evaluation order: getter in callee position

let callTrace = [];

const obj = {
  get callback() {
    callTrace.push('getter');
    return function(x) {
      callTrace.push('function:' + x);
      return x * 2;
    };
  }
};

// The getter is evaluated before the function is called
const result = obj.callback(5);

print('result:', result);
print('trace:', callTrace.join('|'));

// Test with method that returns a function
const obj2 = {
  getFunc() {
    callTrace = [];
    callTrace.push('getFunc-called');
    return function(y) {
      callTrace.push('inner:' + y);
      return y + 10;
    };
  }
};

const result2 = obj2.getFunc()(100);
print('result2:', result2);
print('trace2:', callTrace.join('|'));
