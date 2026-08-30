// Closures: recursive closure with mutable state

function makeRecurser() {
  let depth = 0;

  const recurse = (n) => {
    depth++;
    if (n <= 0) {
      const d = depth;
      depth = 0;
      return d;
    }
    const result = recurse(n - 1);
    depth--;
    return result;
  };

  return recurse;
}

const recurser = makeRecurser();
const maxDepth = recurser(5);
const secondCall = recurser(3);

print('max depth:', maxDepth);
print('second call max:', secondCall);
