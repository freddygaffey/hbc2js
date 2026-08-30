// Closures: nested closures capturing and mutating shared variable

function makeCounters() {
  let shared = 0;

  const inc = () => {
    shared++;
    return shared;
  };

  const dec = () => {
    shared--;
    return shared;
  };

  const get = () => shared;

  return { inc, dec, get };
}

const counters = makeCounters();
const r1 = counters.inc();  // 1
const r2 = counters.inc();  // 2
const r3 = counters.dec();  // 1
const r4 = counters.get();  // 1

print('inc:', r1, r2);
print('dec:', r3);
print('final:', r4);
