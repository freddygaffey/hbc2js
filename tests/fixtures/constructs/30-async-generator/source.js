// async function* consumed with for await...of.
// NOTE: as of the hermesc versions this project fetches (v84, v94, v99),
// none support this construct at compile time -- see versions.txt.
async function* asyncRange(start, end) {
  for (let i = start; i <= end; i++) {
    await Promise.resolve();
    yield i * i;
  }
}
async function main() {
  const out = [];
  for await (const v of asyncRange(1, 5)) {
    out.push(v);
  }
  print('squares via for-await-of:', out.join(','));

  const gen = asyncRange(10, 12);
  let result = await gen.next();
  while (!result.done) {
    print('manual next:', result.value);
    result = await gen.next();
  }
}
main().then(function () { print('done'); });
