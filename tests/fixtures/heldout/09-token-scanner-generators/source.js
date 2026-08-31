// A tokenizer built from generators: yield*, two-way communication through
// next(value), return() and throw() with try/finally cleanup.
function* chars(text) {
  for (let i = 0; i < text.length; i++) yield text[i];
}

function* tokens(text) {
  let buf = '';
  let kind = null;
  try {
    for (const ch of chars(text)) {
      const isDigit = ch >= '0' && ch <= '9';
      const isAlpha = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
      const next = isDigit ? 'num' : isAlpha ? 'id' : ch === ' ' ? null : 'punct';
      if (kind !== next || next === 'punct') {
        if (buf) yield { kind, text: buf };
        buf = '';
        kind = next;
      }
      if (next !== null) buf += ch;
    }
    if (buf) yield { kind, text: buf };
  } finally {
    yield { kind: 'eof', text: '' };
  }
}

function* numbered(gen) {
  let n = 0;
  const last = yield* gen;
  n = yield 'delegated to inner, got ' + last;
  yield 'outer resumed with ' + n;
  return 'outer done';
}

function* counter(limit) {
  let total = 0;
  try {
    for (let i = 1; i <= limit; i++) {
      const cmd = yield i;
      if (cmd === 'skip') { i++; continue; }
      if (cmd === 'stop') return 'stopped at ' + i;
      total += i;
    }
  } finally {
    print('counter cleanup total=' + total);
  }
  return 'ran out at ' + total;
}

const out = [];
for (const t of tokens('let x1 = 42+abc;')) out.push(t.kind + ':' + t.text);
print(out.join(' '));

const it = numbered(counter(5));
print(String(it.next().value));
print(String(it.next('skip').value));
print(String(it.next().value));
print(String(it.next('stop').value));
print(String(it.next(99).value));
print(JSON.stringify(it.next()));
print(JSON.stringify(it.next()));

const c = counter(10);
c.next();
c.next();
print(JSON.stringify(c.return('forced')));
print(JSON.stringify(c.next()));

const t = tokens('ab cd');
print(JSON.stringify(t.next().value));
// throw() while the finally block itself yields: the eof token comes out of
// throw(), and the exception only surfaces on the following next().
try {
  print('throw() gave ' + JSON.stringify(t.throw(new Error('abort'))));
} catch (e) {
  print('propagated from throw(): ' + e.message);
}
try {
  print(JSON.stringify(t.next()));
} catch (e) {
  print('propagated from next(): ' + e.message);
}
print(JSON.stringify(t.next()));

function* fib() {
  let [a, b] = [0, 1];
  for (;;) { yield a; [a, b] = [b, a + b]; }
}
const first = [];
for (const f of fib()) { if (f > 50) break; first.push(f); }
print(first.join(','));
