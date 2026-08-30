// Trace value encoding and record helpers.
//
// A *trace* is an ordered list of records. Every record is a plain object with
// a `k` (kind) field, serialised as one line of NDJSON so that a trace can be
// streamed out of a child process that may be SIGKILLed at any moment, and so
// that comparison is a cheap line-by-line scan to first divergence.
//
// See docs/EQUIVALENCE.md for the normative description of the format.

export const KINDS = [
  'meta', // {k, engine, file, seed, relax}   — first record, never compared
  'out', // {k, ch, s, a}                     — host output call
  'hostset', // {k, o, p, v}                  — assignment to a stubbed host object
  'call', // {k, fn, args, ret?, throws?}     — fuzz-driven function call
  'yield', // {k, fn, i, done, v}             — harness-driven generator step
  'settle', // {k, id, state, v}              — observed promise settlement
  'tick', // {k, t}                           — virtual timer boundary
  'err', // {k, phase, name, message}         — error that ended a phase
  'unhandled', // {k, name, message}          — unhandled rejection at end of run
  'ret', // {k, v}                            — program completion value
  'globals', // {k, v}                        — post-run global-object delta
  'limit', // {k, why}                        — budget exhausted (never == PASS)
  'end', // {k}                               — clean termination marker
];

const DEFAULTS = {
  maxDepth: 6,
  maxItems: 64,
  maxString: 512,
  maskFunctionNames: false, // --relax fn-names
  sortKeys: false, // --relax key-order
  maskErrorMessages: false, // --relax error-messages
};

// Deterministic, total, side-effect-free encoding of an arbitrary JS value to a
// string. Never invokes getters, never reads `.stack`, never calls user
// `toString`/`toJSON`. Identity is expressed by first-encounter ids so that two
// runs that build the same object graph in the same order encode identically.
export function makeEncoder(opts = {}) {
  const o = { ...DEFAULTS, ...opts };

  return function encode(root) {
    const ids = new Map(); // object -> id
    const seen = new Set(); // objects on the current path (cycle detection)
    let nextId = 0;

    function idOf(v) {
      let id = ids.get(v);
      if (id === undefined) {
        id = nextId++;
        ids.set(v, id);
      }
      return id;
    }

    function str(s) {
      const t = s.length > o.maxString ? s.slice(0, o.maxString) + '…' : s;
      return JSON.stringify(t);
    }

    function num(n) {
      if (Number.isNaN(n)) return 'NaN';
      if (n === Infinity) return 'Infinity';
      if (n === -Infinity) return '-Infinity';
      if (n === 0) return Object.is(n, -0) ? '-0' : '0';
      return String(n);
    }

    function ownEntries(v) {
      // Own property *order* is observable in JS, so it is preserved unless
      // --relax key-order asked for it to be ignored.
      const keys = Reflect.ownKeys(v);
      const out = [];
      for (const k of keys) {
        let d;
        try {
          d = Object.getOwnPropertyDescriptor(v, k);
        } catch {
          out.push([k, '<unreadable>']);
          continue;
        }
        if (!d) continue;
        if (!d.enumerable) continue;
        if (typeof k === 'symbol') {
          out.push([`@@${k.description ?? ''}`, d.get ? '<accessor>' : enc(d.value, 0)]);
        } else {
          out.push([k, d.get ? '<accessor>' : enc(d.value, 0)]);
        }
      }
      return out;
    }

    function body(v, depth) {
      const tag = Object.prototype.toString.call(v);
      const ctor = ctorName(v);

      if (Array.isArray(v)) {
        const parts = [];
        const n = Math.min(v.length, o.maxItems);
        for (let i = 0; i < n; i++) {
          parts.push(i in v ? enc(v[i], depth + 1) : '<hole>');
        }
        if (v.length > n) parts.push(`…+${v.length - n}`);
        const extra = ownEntries(v).filter(([k]) => !/^\d+$/.test(k) && k !== 'length');
        for (const [k, ev] of extra) parts.push(`${k}: ${ev}`);
        return `[${parts.join(', ')}]`;
      }

      if (v instanceof Error || /Error$/.test(ctor)) {
        const msg = o.maskErrorMessages ? '<masked>' : String(v.message ?? '');
        const extra = ownEntries(v)
          .filter(([k]) => k !== 'message' && k !== 'stack')
          .map(([k, ev]) => `${k}: ${ev}`);
        const cause =
          'cause' in v ? [`cause: ${enc(v.cause, depth + 1)}`] : [];
        const all = [...extra, ...cause];
        return `${v.name ?? ctor}(${str(msg)}${all.length ? ', ' + all.join(', ') : ''})`;
      }

      switch (tag) {
        case '[object Date]':
          return `Date(${num(Number(v.getTime ? Date.prototype.getTime.call(v) : NaN))})`;
        case '[object RegExp]':
          return `RegExp(${str(String(RegExp.prototype.source ? Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get.call(v) : ''))},${Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags').get.call(v)})`;
        case '[object Map]': {
          const parts = [];
          let i = 0;
          for (const [k, val] of v) {
            if (i++ >= o.maxItems) {
              parts.push('…');
              break;
            }
            parts.push(`${enc(k, depth + 1)} => ${enc(val, depth + 1)}`);
          }
          return `Map{${parts.join(', ')}}`;
        }
        case '[object Set]': {
          const parts = [];
          let i = 0;
          for (const val of v) {
            if (i++ >= o.maxItems) {
              parts.push('…');
              break;
            }
            parts.push(enc(val, depth + 1));
          }
          return `Set{${parts.join(', ')}}`;
        }
        case '[object Promise]':
          // Settlement is not synchronously observable; the sandbox emits a
          // separate `settle` record for promises that reach a trace boundary.
          return `Promise#${idOf(v)}`;
        case '[object ArrayBuffer]':
          return `ArrayBuffer(${v.byteLength})`;
      }
      if (ArrayBuffer.isView(v)) {
        const parts = [];
        const n = Math.min(v.length ?? 0, o.maxItems);
        for (let i = 0; i < n; i++) parts.push(num(Number(v[i])));
        return `${ctor}[${parts.join(', ')}${(v.length ?? 0) > n ? ', …' : ''}]`;
      }

      let entries = ownEntries(v);
      if (o.sortKeys) entries = entries.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const inner = entries.map(([k, ev]) => `${k}: ${ev}`).join(', ');
      const name = ctor === 'Object' ? '' : ctor;
      return `${name}{${inner}}`;
    }

    function ctorName(v) {
      try {
        const p = Object.getPrototypeOf(v);
        if (p === null) return 'null-proto';
        const c = p.constructor;
        return typeof c === 'function' && c.name ? c.name : 'Object';
      } catch {
        return 'Object';
      }
    }

    function enc(v, depth) {
      switch (typeof v) {
        case 'undefined':
          return 'undefined';
        case 'boolean':
          return String(v);
        case 'number':
          return num(v);
        case 'bigint':
          return `${v}n`;
        case 'string':
          return str(v);
        case 'symbol':
          return `Symbol(${v.description ?? ''})`;
        case 'function': {
          // Decompiled functions carry generated names, so the name is only
          // compared when --relax fn-names is off.
          const nm = o.maskFunctionNames ? '~' : v.name || '<anon>';
          const kind = /^class\b/.test(fnSource(v)) ? 'class' : 'fn';
          return `[${kind} ${nm}/${v.length}]`;
        }
      }
      if (v === null) return 'null';
      if (depth >= o.maxDepth) return `…#${idOf(v)}`;
      if (seen.has(v)) return `<circular #${idOf(v)}>`;
      seen.add(v);
      try {
        return body(v, depth);
      } finally {
        seen.delete(v);
      }
    }

    function fnSource(f) {
      try {
        return Function.prototype.toString.call(f).slice(0, 8);
      } catch {
        return '';
      }
    }

    return enc(root, 0);
  };
}

// Canonical single-line rendering of a record, used as the diff unit.
export function renderRecord(r) {
  switch (r.k) {
    case 'out':
      return `out ${r.ch} ${JSON.stringify(r.s)} ${JSON.stringify(r.a)}`;
    case 'hostset':
      return `hostset ${r.o}.${r.p} = ${r.v}`;
    case 'call':
      return `call ${r.fn}(${r.args.join(', ')}) ${'throws' in r ? `throws ${r.throws}` : `-> ${r.ret}`}`;
    case 'yield':
      return `yield ${r.fn}#${r.i} done=${r.done} ${r.v}`;
    case 'settle':
      return `settle #${r.id} ${r.state} ${r.v}`;
    case 'tick':
      return `tick t=${r.t}`;
    case 'err':
      return `err ${r.phase} ${r.name}: ${r.message}`;
    case 'unhandled':
      return `unhandled ${r.name}: ${r.message}`;
    case 'ret':
      return `ret ${r.v}`;
    case 'globals':
      return `globals ${r.v}`;
    case 'limit':
      return `limit ${r.why}`;
    case 'end':
      return 'end';
    case 'meta':
      return `meta ${r.engine}`;
    default:
      return JSON.stringify(r);
  }
}

// `meta` is informational (it names the file, which always differs).
export function isComparable(r) {
  return r.k !== 'meta';
}

// Records that count as *evidence*. A pair of traces that contain none of these
// proves nothing, so the harness reports INCONCLUSIVE rather than PASS.
export function isEvidence(r) {
  if (r.k === 'out' || r.k === 'err' || r.k === 'unhandled' || r.k === 'call' || r.k === 'yield')
    return true;
  if (r.k === 'hostset' || r.k === 'settle') return true;
  if (r.k === 'ret') return r.v !== 'undefined';
  if (r.k === 'globals') return r.v !== '{}';
  return false;
}
