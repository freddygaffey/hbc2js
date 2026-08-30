// The deterministic sandbox: a `node:vm` context with every observable host
// API stubbed onto a trace, every nondeterministic source pinned, and a virtual
// event loop so that timer-driven programs finish in microseconds and in a
// fixed order.
//
// Everything in here must be a pure function of (source, seed). If you add a
// global, ask: can two runs of the same source disagree about it? If yes it
// must be pinned here, not left to Node.

import vm from 'node:vm';

// xorshift128+ — small, fast, and identical across engines, so the same seed
// gives the same stream under Node and (if ported) under Hermes.
export function makePrng(seed) {
  let s0 = (seed ^ 0x9e3779b9) >>> 0 || 1;
  let s1 = (seed + 0x85ebca6b) >>> 0 || 2;
  let s2 = (seed ^ 0xc2b2ae35) >>> 0 || 3;
  let s3 = (seed + 0x27d4eb2f) >>> 0 || 4;
  return function random() {
    let t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11) | (s3 >>> 21);
    // 53 bits from two 32-bit words, mapped into [0,1).
    const hi = (s0 >>> 5) * 67108864; // 2^26
    const lo = s1 >>> 6; // 2^26 bits
    return (hi + lo) / 9007199254740992; // 2^53
  };
}

export const FROZEN_EPOCH = 1700000000000; // 2023-11-14T22:13:20Z, arbitrary but fixed

export function createSandbox({ emit, encode, seed = 0, timerBudget = 10000 }) {
  // ---- virtual clock -----------------------------------------------------
  let now = 0;
  let timerSeq = 0;
  let timerCount = 0;
  const timers = []; // {at, seq, fn, args, interval|null, id}
  const cancelled = new Set();
  let nextTimerId = 1;

  function schedule(fn, delay, args, interval) {
    const id = nextTimerId++;
    const at = now + Math.max(0, Number(delay) || 0);
    timers.push({ at, seq: timerSeq++, fn, args, interval, id });
    return id;
  }

  const flushMicrotasks = () => new Promise((r) => setImmediate(r));

  async function drain() {
    // Microtasks first (setImmediate runs in the check phase, after the
    // microtask queue is fully drained), then the earliest virtual timer.
    // Ordering within a tick is (at, insertion) — never wall-clock.
    await flushMicrotasks();
    while (timers.length) {
      if (timerCount++ >= timerBudget) {
        emit({ k: 'limit', why: 'timer-budget' });
        return;
      }
      let best = -1;
      for (let i = 0; i < timers.length; i++) {
        if (cancelled.has(timers[i].id)) continue;
        if (best < 0 || timers[i].at < timers[best].at || (timers[i].at === timers[best].at && timers[i].seq < timers[best].seq))
          best = i;
      }
      if (best < 0) break;
      const t = timers.splice(best, 1)[0];
      if (now !== t.at) {
        now = t.at;
        emit({ k: 'tick', t: now });
      }
      if (t.interval !== null && t.interval !== undefined) {
        timers.push({ ...t, at: now + Math.max(1, t.interval), seq: timerSeq++ });
      }
      try {
        t.fn(...t.args);
      } catch (e) {
        emit({ k: 'err', phase: 'timer', ...errShape(e) });
      }
      await flushMicrotasks();
    }
  }

  // ---- host output stubs -------------------------------------------------
  // Hermes's `print` renders each argument with String() and joins with a
  // single space. We record BOTH the rendered line (comparable against a
  // fixture's expected.txt and against a real Hermes run) and the structural
  // encoding of each argument (strictly stronger).
  function hermesRender(args) {
    return args
      .map((a) => {
        try {
          return typeof a === 'symbol' ? String(a) : String(a);
        } catch {
          return '<unstringifiable>';
        }
      })
      .join(' ');
  }

  function out(ch) {
    return function (...args) {
      emit({ k: 'out', ch, s: hermesRender(args), a: args.map((a) => encode(a)) });
      return undefined;
    };
  }

  // A recording stand-in for host objects the program pokes at (`window`,
  // `document`, `globalThis.nativeModuleProxy`, ...). Property *writes* are
  // observable; reads return further recording stubs so that chained access
  // does not throw and does not diverge between the two sides.
  function recordingHost(path, depth = 0) {
    const backing = Object.create(null);
    return new Proxy(backing, {
      get(t, p) {
        if (p === Symbol.toPrimitive) return () => `[host ${path}]`;
        if (p === Symbol.toStringTag) return 'HostObject';
        if (p === 'toString') return () => `[host ${path}]`;
        if (p === 'then') return undefined; // never look thenable
        if (p in t) return t[p];
        if (typeof p === 'symbol') return undefined;
        if (depth >= 4) return undefined;
        const child = recordingHost(`${path}.${p}`, depth + 1);
        t[p] = child;
        return child;
      },
      set(t, p, v) {
        if (typeof p !== 'symbol') emit({ k: 'hostset', o: path, p: String(p), v: encode(v) });
        t[p] = v;
        return true;
      },
      has() {
        return true;
      },
    });
  }

  // ---- context -----------------------------------------------------------
  const ctx = vm.createContext(Object.create(null), {
    codeGeneration: { strings: true, wasm: false },
  });

  const g = vm.runInContext('this', ctx);

  const random = makePrng(seed);
  vm.runInContext('Math.random', ctx); // ensure Math exists
  g.Math.random = random;

  // Freeze the clock. `Date.now()` and `new Date()` both return FROZEN_EPOCH.
  const RealDate = g.Date;
  const FrozenDate = new Proxy(RealDate, {
    construct(target, args, nt) {
      return args.length === 0
        ? Reflect.construct(target, [FROZEN_EPOCH], nt)
        : Reflect.construct(target, args, nt);
    },
    apply() {
      return new RealDate(FROZEN_EPOCH).toString();
    },
  });
  FrozenDate.now = () => FROZEN_EPOCH;
  g.Date = FrozenDate;

  g.globalThis = g;
  g.print = out('print');
  g.alert = out('alert');
  g.console = {
    log: out('console.log'),
    info: out('console.info'),
    warn: out('console.warn'),
    error: out('console.error'),
    debug: out('console.debug'),
    trace: out('console.trace'),
  };
  g.window = recordingHost('window');
  g.self = g.window;
  g.document = recordingHost('document');
  g.navigator = recordingHost('navigator');
  g.performance = { now: () => now };

  g.setTimeout = (fn, d, ...a) => schedule(fn, d, a, null);
  g.setInterval = (fn, d, ...a) => schedule(fn, d, a, Number(d) || 1);
  g.setImmediate = (fn, ...a) => schedule(fn, 0, a, null);
  g.clearTimeout = (id) => cancelled.add(id);
  g.clearInterval = g.clearTimeout;
  g.clearImmediate = g.clearTimeout;
  g.queueMicrotask = (fn) => {
    Promise.resolve().then(() => {
      try {
        fn();
      } catch (e) {
        emit({ k: 'err', phase: 'microtask', ...errShape(e) });
      }
    });
  };

  // A trace hook the harness can inject into instrumented fixtures.
  g.__trace = (...args) => emit({ k: 'out', ch: '__trace', s: hermesRender(args), a: args.map(encode) });

  const baseline = new Set(Reflect.ownKeys(g));

  return {
    ctx,
    global: g,
    drain,
    get virtualNow() {
      return now;
    },
    // Own properties the program added to the global object, encoded in sorted
    // key order. This is what makes an "outputs nothing" program observable.
    globalsDelta() {
      const keys = Reflect.ownKeys(g)
        .filter((k) => typeof k === 'string' && !baseline.has(k))
        .sort();
      const parts = [];
      for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(g, k);
        parts.push(`${k}: ${d && d.get ? '<accessor>' : encode(d ? d.value : undefined)}`);
      }
      return `{${parts.join(', ')}}`;
    },
    exportedFunctions() {
      const keys = Reflect.ownKeys(g)
        .filter((k) => typeof k === 'string' && !baseline.has(k))
        .sort();
      const fns = [];
      for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(g, k);
        if (d && !d.get && typeof d.value === 'function') fns.push([k, d.value]);
      }
      return fns;
    },
  };
}

export function errShape(e) {
  // Never record `.stack`: it embeds file names, line numbers and — for
  // RangeError from deep recursion — an engine-specific depth.
  if (e && typeof e === 'object') {
    return { name: String(e.name ?? e.constructor?.name ?? 'Error'), message: String(e.message ?? '') };
  }
  return { name: 'Thrown', message: typeof e === 'string' ? e : String(e) };
}
