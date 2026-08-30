// Optional catch binding (catch {}, ES2019).
function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return 'unparseable';
  }
}
print(JSON.stringify(tryParse('{"a":1}')));
print(tryParse('not json'));

let attempts = 0;
function unreliable() {
  attempts++;
  if (attempts < 3) throw new Error('fail#' + attempts);
  return 'succeeded on attempt ' + attempts;
}
let result;
for (let i = 0; i < 5; i++) {
  try {
    result = unreliable();
    break;
  } catch {
    print('attempt', i, 'failed, no binding needed');
  }
}
print(result);
