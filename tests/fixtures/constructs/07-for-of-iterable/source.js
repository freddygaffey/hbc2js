// for...of over Map, Set, and a hand-rolled [Symbol.iterator] object.
const m = new Map([['a', 1], ['b', 2], ['c', 3]]);
const mapPairs = [];
for (const [k, v] of m) {
  mapPairs.push(k + ':' + v);
}
print('map:', mapPairs.join(','));

const s = new Set([5, 5, 6, 7, 7, 7]);
const setVals = [];
for (const v of s) {
  setVals.push(v);
}
print('set (dedup):', setVals.join(','));

const custom = {
  from: 1,
  to: 5,
  [Symbol.iterator]() {
    let current = this.from;
    const last = this.to;
    return {
      next() {
        if (current <= last) {
          return { value: current++, done: false };
        }
        return { value: undefined, done: true };
      }
    };
  }
};
const customVals = [];
for (const v of custom) {
  customVals.push(v);
}
print('custom range:', customVals.join(','));
