// A linked list implementing the Symbol.iterator protocol by hand (with
// return() for early exit), consumed by for-of, spread, destructuring,
// Array.from and a generator-based reverse iterator.
function createList() {
  let head = null;
  let size = 0;
  let closed = 0;
  return {
    push(value) {
      const node = { value, next: null };
      if (head === null) head = node;
      else {
        let cur = head;
        while (cur.next !== null) cur = cur.next;
        cur.next = node;
      }
      size++;
      return this;
    },
    get size() { return size; },
    get closedCount() { return closed; },
    [Symbol.iterator]() {
      let cur = head;
      return {
        next() {
          if (cur === null) return { value: undefined, done: true };
          const value = cur.value;
          cur = cur.next;
          return { value, done: false };
        },
        return() {
          closed++;
          cur = null;
          return { value: undefined, done: true };
        },
      };
    },
    *reversed() {
      const items = [...this];
      for (let i = items.length - 1; i >= 0; i--) yield items[i];
    },
  };
}

const list = createList().push('alpha').push('beta').push('gamma').push('delta');
print('size=' + list.size);

const seen = [];
for (const v of list) {
  seen.push(v);
  if (v === 'beta') break;
}
print('for-of with break: ' + seen.join(',') + ' closed=' + list.closedCount);

for (const v of list) seen.push(v.toUpperCase());
print('full for-of: ' + seen.join(',') + ' closed=' + list.closedCount);

const [a, b] = list;
print('destructured: ' + a + '/' + b + ' closed=' + list.closedCount);

print('spread: ' + [...list].join('-') + ' closed=' + list.closedCount);
print('Array.from: ' + Array.from(list, (s) => s.length).join(','));
print('reversed: ' + [...list.reversed()].join(','));

const m = new Map(Array.from(list, (s, i) => [s[0], i]));
print('map keys: ' + [...m.keys()].join('') + ' entries: ' + [...m].map(([k, v]) => k + v).join(' '));
const set = new Set([...list, 'alpha', 'beta']);
print('set size=' + set.size + ' has(gamma)=' + set.has('gamma'));

// Manual protocol use, and a throwing consumer that still triggers return().
const it = list[Symbol.iterator]();
print(JSON.stringify(it.next()) + ' ' + JSON.stringify(it.next()));
try {
  for (const v of list) {
    if (v === 'gamma') throw new Error('stop at ' + v);
  }
} catch (e) {
  print(e.message + ' closed=' + list.closedCount);
}
const empty = createList();
print('empty: [' + [...empty].join(',') + '] size=' + empty.size);
