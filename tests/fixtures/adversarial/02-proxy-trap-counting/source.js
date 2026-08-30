// Evaluation order: Proxy trap invocations tracked
// Counts how many times get/set/has traps are called

let traps = { get: 0, set: 0, has: 0 };
const handler = {
  get(target, prop) {
    traps.get++;
    return target[prop];
  },
  set(target, prop, value) {
    traps.set++;
    target[prop] = value;
    return true;
  },
  has(target, prop) {
    traps.has++;
    return prop in target;
  }
};

const obj = { x: 10 };
const proxy = new Proxy(obj, handler);

// Read
const v = proxy.x;
// Check
const hasX = 'x' in proxy;
// Write
proxy.x = 20;

print('read value:', v);
print('get traps:', traps.get);
print('has traps:', traps.has);
print('set traps:', traps.set);
