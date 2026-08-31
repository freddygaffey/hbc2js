// async/await pagination with a rejection path, Promise.all and a
// try/catch/finally inside an async function.
const pages = {
  1: { items: ['a', 'b'], next: 2 },
  2: { items: ['c'], next: 3 },
  3: { items: ['d', 'e', 'f'], next: null },
  9: null,
};
let calls = 0;

function fetchPage(n) {
  calls++;
  return new Promise((resolve, reject) => {
    const page = pages[n];
    if (page === undefined) reject(new Error('404 page ' + n));
    else if (page === null) reject(new TypeError('malformed page ' + n));
    else resolve(page);
  });
}

async function fetchAll(start) {
  const out = [];
  let n = start;
  while (n !== null) {
    const page = await fetchPage(n);
    out.push(...page.items);
    n = page.next;
  }
  return out;
}

async function safeFetchAll(start) {
  try {
    const items = await fetchAll(start);
    return 'ok:' + items.join('');
  } catch (e) {
    if (e instanceof TypeError) return 'malformed:' + e.message;
    throw e;
  } finally {
    print('finally for start=' + start + ' calls so far=' + calls);
  }
}

async function main() {
  print(await safeFetchAll(1));
  print(await safeFetchAll(9));
  try {
    await safeFetchAll(7);
    print('not reached');
  } catch (e) {
    print('rethrown: ' + e.message);
  }
  const results = await Promise.all([fetchAll(2), fetchAll(3), Promise.resolve(['z'])]);
  print(results.map((r) => r.join('')).join('|'));
  const settled = await Promise.all([fetchPage(1).then(() => 'fulfilled', () => 'rejected'), fetchPage(42).then(() => 'fulfilled', () => 'rejected')]);
  print(settled.join(','));
  return calls;
}

print('start');
main().then((c) => print('done, calls=' + c), (e) => print('main failed ' + e.message));
Promise.resolve().then(() => print('microtask after main started'));
print('sync end');
