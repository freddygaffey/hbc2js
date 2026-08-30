// Runs one program in the deterministic sandbox and streams its trace as
// NDJSON on stdout.
//
// This runs as its own process for two reasons: a synchronous infinite loop in
// the program under test cannot be interrupted from inside the process (no
// timer will ever fire), so the parent has to SIGKILL us; and per-record
// `fs.writeSync` means the parent still receives everything we emitted before
// the kill, which is what makes "diverges then hangs" distinguishable from
// "hangs immediately".

import fs from 'node:fs';
import vm from 'node:vm';
import { makeEncoder } from './trace.mjs';
import { createSandbox, errShape } from './sandbox.mjs';
import { makeCaseGenerator, cases } from './fuzz.mjs';
import { makePrng } from './sandbox.mjs';

const [, , file, optsJson] = process.argv;
const opts = JSON.parse(optsJson || '{}');

const encode = makeEncoder({
  maskFunctionNames: !!opts.relax?.includes('fn-names'),
  sortKeys: !!opts.relax?.includes('key-order'),
  maskErrorMessages: !!opts.relax?.includes('error-messages'),
  maxDepth: opts.maxDepth ?? 6,
});

let emitted = 0;
const maxRecords = opts.maxRecords ?? 20000;
let capped = false;

function emit(rec) {
  if (capped) return;
  if (emitted++ >= maxRecords) {
    capped = true;
    fs.writeSync(1, JSON.stringify({ k: 'limit', why: 'record-cap' }) + '\n');
    return;
  }
  fs.writeSync(1, JSON.stringify(rec) + '\n');
}

const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(errShape(reason));
});

const box = createSandbox({ emit, encode, seed: opts.seed ?? 0 });

emit({ k: 'meta', engine: `node ${process.versions.node}`, seed: opts.seed ?? 0 });

const src = fs.readFileSync(file, 'utf8');

let script;
try {
  script = new vm.Script(src, { filename: 'program.js' });
} catch (e) {
  emit({ k: 'err', phase: 'parse', ...errShape(e) });
  emit({ k: 'end' });
  process.exit(0);
}

let mainThrew = false;
try {
  // `timeout` bounds only *synchronous* execution of this call. Callbacks the
  // program schedules are driven later by drain(), outside any vm timeout, so
  // the parent's wall-clock kill is the real backstop.
  const completion = script.runInContext(box.ctx, { timeout: opts.syncTimeout ?? 4000 });
  emit({ k: 'ret', v: encode(completion) });
} catch (e) {
  mainThrew = true;
  // A vm timeout is a *budget*, not a behaviour: two different non-terminating
  // programs both "throw" it, and calling that EQUIVALENT would be a false
  // pass. It gets a `limit` record so compare.mjs reports INCONCLUSIVE.
  if (e && (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || /execution timed out/i.test(String(e.message)))) {
    emit({ k: 'limit', why: 'sync-timeout' });
  } else {
    emit({ k: 'err', phase: 'main', ...errShape(e) });
  }
}

try {
  await box.drain();
} catch (e) {
  emit({ k: 'err', phase: 'drain', ...errShape(e) });
}

// Everything the program left on the global object. This is what gives a
// program with no output something to compare.
emit({ k: 'globals', v: box.globalsDelta() });

// Property-based differential pass over exported functions.
if (opts.fuzz > 0 && !mainThrew) {
  const random = makePrng((opts.seed ?? 0) ^ 0x5bf03635);
  const nextCase = makeCaseGenerator(opts.seed ?? 0, random);
  for (const [name, fn] of box.exportedFunctions()) {
    let i = 0;
    for (const args of cases(fn, opts.fuzz, nextCase)) {
      if (capped) break;
      const encArgs = args.map(encode);
      let rec;
      try {
        const r = fn.apply(undefined, args);
        rec = { k: 'call', fn: `${name}#${i}`, args: encArgs, ret: encode(r) };
        // Drive generators: an un-iterated generator object tells us nothing.
        if (r && typeof r === 'object' && typeof r.next === 'function' && typeof r[Symbol.iterator] === 'function') {
          emit(rec);
          rec = null;
          for (let step = 0; step < (opts.generatorSteps ?? 8); step++) {
            let s;
            try {
              s = r.next();
            } catch (e) {
              emit({ k: 'yield', fn: `${name}#${i}`, i: step, done: 'throw', v: JSON.stringify(errShape(e)) });
              break;
            }
            emit({ k: 'yield', fn: `${name}#${i}`, i: step, done: !!s.done, v: encode(s.value) });
            if (s.done) break;
          }
        }
      } catch (e) {
        const s = errShape(e);
        rec = { k: 'call', fn: `${name}#${i}`, args: encArgs, throws: `${s.name}: ${s.message}` };
      }
      if (rec) emit(rec);
      i++;
    }
    // Drain anything the calls scheduled so async functions settle.
    await box.drain();
  }
}

// Unhandled rejections surface at the end of a turn; give the loop one more
// pass before reporting them.
await new Promise((r) => setImmediate(r));
for (const u of unhandled) emit({ k: 'unhandled', ...u });

emit({ k: 'end' });
process.exit(0);
