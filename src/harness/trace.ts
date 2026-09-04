// docs/specs/06-harness.md §5, §2 — trace record kinds, deterministic value
// encoder, canonical single-line rendering. Port of tools/equiv/src/trace.mjs
// (docs/DECISIONS.md D15: the PoC is the reference implementation).
//
// A *trace* is an ordered list of records. Every record has a `k` (kind)
// field. On the wire (NDJSON, one record per line) this lets a trace survive
// a child process being SIGKILLed mid-write, and lets comparison be a cheap
// line-by-line scan to first divergence.
//
// See docs/EQUIVALENCE.md for the normative description of the format this
// ports, and docs/TESTING.md for the format as shipped here.

/** §3.2: a Hermes `-b` run has no injectable prelude and observes only what
 *  the program printed (plus its terminating error) — a strictly weaker,
 *  "print-projection" trace than the Node sandbox's `full` trace. */
export type TraceKind = "full" | "print-only";

export interface MetaRecord {
  readonly k: "meta";
  /** Trace format version (§5 item 1): committed golden traces survive
   *  harness changes because a reader can tell which shape it is reading. */
  readonly v: 1;
  readonly engine: string;
  readonly seed: number;
}
export interface OutRecord {
  readonly k: "out";
  readonly ch: string;
  readonly s: string;
  readonly a: readonly string[];
}
export interface HostSetRecord {
  readonly k: "hostset";
  readonly o: string;
  readonly p: string;
  readonly v: string;
}
export interface CallRecord {
  readonly k: "call";
  readonly fn: string;
  readonly args: readonly string[];
  readonly ret: string | undefined;
  readonly throws: string | undefined;
}
export interface YieldRecord {
  readonly k: "yield";
  readonly fn: string;
  readonly i: number;
  readonly done: boolean | "throw";
  readonly v: string;
}
export interface SettleRecord {
  readonly k: "settle";
  readonly id: number;
  readonly state: string;
  readonly v: string;
}
export interface TickRecord {
  readonly k: "tick";
  readonly t: number;
}
export interface ErrRecord {
  readonly k: "err";
  readonly phase: string;
  readonly name: string;
  readonly message: string;
}
export interface UnhandledRecord {
  readonly k: "unhandled";
  readonly name: string;
  readonly message: string;
}
export interface RetRecord {
  readonly k: "ret";
  readonly v: string;
}
export interface GlobalsRecord {
  readonly k: "globals";
  readonly v: string;
}
export interface LimitRecord {
  readonly k: "limit";
  readonly why: string;
}
export interface EndRecord {
  readonly k: "end";
}

export type TraceRecord =
  | MetaRecord
  | OutRecord
  | HostSetRecord
  | CallRecord
  | YieldRecord
  | SettleRecord
  | TickRecord
  | ErrRecord
  | UnhandledRecord
  | RetRecord
  | GlobalsRecord
  | LimitRecord
  | EndRecord;

export interface Trace {
  readonly kind: TraceKind;
  readonly records: readonly TraceRecord[];
}

export interface ErrShape {
  readonly name: string;
  readonly message: string;
}

// docs/BUGS.md 2026-09-02 (oracle message-text masking): a thrown Error's
// `.message` template (V8's or Hermes's own) frequently embeds an
// identifier or property-access chain the source program named directly
// ("items.map is not a function", "Cannot read properties of undefined
// (reading 'log')"). hbc2js's naming passes (fn-naming/var-naming/reg-split)
// are a synthesised *approximation* of the original names by design — they
// are never guaranteed, and for un-debug-info bytecode often cannot be,
// byte-identical to the source's own identifiers. Exact-text-comparing
// these messages reports a false DIVERGENT on every such throw even when
// the error's constructor, thrown-vs-not-thrown, and every other observable
// value already match. `TEMPLATE_WORDS` is the (necessarily incomplete)
// allowlist of literal English/JS-keyword tokens Hermes's and V8's own
// message templates use verbatim, so only tokens *outside* it — the
// identifier-shaped substitutions — are masked. Conservative, not exact:
// see `renderRecordMasked`'s caller (`compareTraces`) for how a masked
// match is still surfaced, never silently treated as an exact pass.
const TEMPLATE_WORDS: ReadonlySet<string> = new Set(
  [
    "is",
    "not",
    "a",
    "an",
    "the",
    "of",
    "in",
    "to",
    "for",
    "cannot",
    "read",
    "properties",
    "property",
    "reading",
    "writing",
    "set",
    "get",
    "function",
    "constructor",
    "object",
    "undefined",
    "null",
    "before",
    "initialization",
    "access",
    "defined",
    "assign",
    "const",
    "variable",
    "invalid",
    "or",
    "and",
    "this",
    "new",
    "target",
    "call",
    "apply",
    "value",
    "values",
    "index",
    "out",
    "range",
    "string",
    "number",
    "boolean",
    "symbol",
    "array",
    "iterator",
    "convert",
    "circular",
    "structure",
    "expected",
    "argument",
    "arguments",
    "type",
    "typeerror",
    "referenceerror",
    "rangeerror",
    "syntaxerror",
    "evalerror",
    "urierror",
    "error",
    "did",
    "you",
    "mean",
  ].flatMap((w) => [w, w[0]!.toUpperCase() + w.slice(1)]),
);

const IDENT_TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Masks identifier-shaped tokens (anything matching a JS identifier that
 *  isn't a known message-template word) in a thrown error's message. Used
 *  only for `err`/`unhandled` trace records — see `renderRecordMasked`. */
export function maskIdentifierTokens(message: string): string {
  return message.replace(IDENT_TOKEN, (tok) => (TEMPLATE_WORDS.has(tok) ? tok : "<id>"));
}

/** Never reads `.stack`: it embeds file names, line numbers and — for a
 *  RangeError from deep recursion — an engine-specific depth. */
export function errShape(e: unknown): ErrShape {
  if (e !== null && typeof e === "object") {
    const rec = e as { name?: unknown; message?: unknown; constructor?: { name?: unknown } };
    const name = rec.name !== undefined ? String(rec.name) : rec.constructor?.name !== undefined ? String(rec.constructor.name) : "Error";
    return { name, message: rec.message !== undefined ? String(rec.message) : "" };
  }
  return { name: "Thrown", message: typeof e === "string" ? e : String(e) };
}

export interface EncoderOptions {
  readonly maxDepth?: number;
  readonly maxItems?: number;
  readonly maxString?: number;
  /** `--relax fn-names` (default on, per §5). */
  readonly maskFunctionNames?: boolean;
  /** `--relax key-order` (unsound; default off). */
  readonly sortKeys?: boolean;
  /** `--relax error-messages` (unsound; default off). */
  readonly maskErrorMessages?: boolean;
}

interface ResolvedEncoderOptions {
  readonly maxDepth: number;
  readonly maxItems: number;
  readonly maxString: number;
  readonly maskFunctionNames: boolean;
  readonly sortKeys: boolean;
  readonly maskErrorMessages: boolean;
}

const ENCODER_DEFAULTS: ResolvedEncoderOptions = {
  maxDepth: 6,
  maxItems: 64,
  maxString: 512,
  maskFunctionNames: false,
  sortKeys: false,
  maskErrorMessages: false,
};

export type Encoder = (value: unknown) => string;

/**
 * Deterministic, total, side-effect-free encoding of an arbitrary JS value to
 * a string. Never invokes getters, never reads `.stack`, never calls user
 * `toString`/`toJSON`. Identity is expressed by first-encounter ids so two
 * runs that build the same object graph in the same order encode identically.
 *
 * The rules below are non-negotiable (docs/EQUIVALENCE.md §2.2, spec 06 §5):
 * `-0 !== 0`, `1n !== 1`, `'1' !== 1`, stable `NaN`, own-property order
 * preserved unless `--relax key-order`, getters never invoked, `.stack`
 * never read, bounded cycles with first-encounter ids, functions rendered as
 * `[kind name/arity]`.
 */
export function makeEncoder(opts: EncoderOptions = {}): Encoder {
  const o: ResolvedEncoderOptions = { ...ENCODER_DEFAULTS, ...opts };

  return function encode(root: unknown): string {
    const ids = new Map<object, number>();
    const seen = new Set<object>();
    let nextId = 0;

    function idOf(v: object): number {
      let id = ids.get(v);
      if (id === undefined) {
        id = nextId++;
        ids.set(v, id);
      }
      return id;
    }

    function str(s: string): string {
      const t = s.length > o.maxString ? s.slice(0, o.maxString) + "…" : s;
      return JSON.stringify(t);
    }

    function num(n: number): string {
      if (Number.isNaN(n)) return "NaN";
      if (n === Infinity) return "Infinity";
      if (n === -Infinity) return "-Infinity";
      if (n === 0) return Object.is(n, -0) ? "-0" : "0";
      return String(n);
    }

    function ctorName(v: object): string {
      try {
        const p = Object.getPrototypeOf(v) as { constructor?: unknown } | null;
        if (p === null) return "null-proto";
        const c = p.constructor;
        return typeof c === "function" && c.name ? c.name : "Object";
      } catch {
        return "Object";
      }
    }

    function ownEntries(v: object): Array<[string, string]> {
      const keys = Reflect.ownKeys(v);
      const out: Array<[string, string]> = [];
      for (const k of keys) {
        let d: PropertyDescriptor | undefined;
        try {
          d = Object.getOwnPropertyDescriptor(v, k);
        } catch {
          out.push([String(k), "<unreadable>"]);
          continue;
        }
        if (d === undefined || d.enumerable !== true) continue;
        if (typeof k === "symbol") {
          out.push([`@@${k.description ?? ""}`, d.get !== undefined ? "<accessor>" : enc(d.value, 0)]);
        } else {
          out.push([k, d.get !== undefined ? "<accessor>" : enc(d.value, 0)]);
        }
      }
      return out;
    }

    function fnSource(f: (...args: unknown[]) => unknown): string {
      try {
        return Function.prototype.toString.call(f).slice(0, 8);
      } catch {
        return "";
      }
    }

    function body(v: object, depth: number): string {
      const tag = Object.prototype.toString.call(v);
      const ctor = ctorName(v);

      if (Array.isArray(v)) {
        const parts: string[] = [];
        const n = Math.min(v.length, o.maxItems);
        for (let i = 0; i < n; i++) {
          parts.push(i in v ? enc((v as unknown[])[i], depth + 1) : "<hole>");
        }
        if (v.length > n) parts.push(`…+${v.length - n}`);
        const extra = ownEntries(v).filter(([k]) => !/^\d+$/.test(k) && k !== "length");
        for (const [k, ev] of extra) parts.push(`${k}: ${ev}`);
        return `[${parts.join(", ")}]`;
      }

      if (v instanceof Error || /Error$/.test(ctor)) {
        const err = v as Error & { cause?: unknown };
        const msg = o.maskErrorMessages ? "<masked>" : String(err.message ?? "");
        const extra = ownEntries(v)
          .filter(([k]) => k !== "message" && k !== "stack")
          .map(([k, ev]) => `${k}: ${ev}`);
        const cause = "cause" in err ? [`cause: ${enc(err.cause, depth + 1)}`] : [];
        const all = [...extra, ...cause];
        return `${err.name ?? ctor}(${str(msg)}${all.length > 0 ? ", " + all.join(", ") : ""})`;
      }

      switch (tag) {
        case "[object Date]": {
          const d = v as Date;
          return `Date(${num(Number(Date.prototype.getTime.call(d)))})`;
        }
        case "[object RegExp]": {
          const r = v as RegExp;
          const sourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
          const flagsGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags")?.get;
          const source = sourceGetter !== undefined ? String(sourceGetter.call(r)) : "";
          const flags = flagsGetter !== undefined ? String(flagsGetter.call(r)) : "";
          return `RegExp(${str(source)},${flags})`;
        }
        case "[object Map]": {
          const parts: string[] = [];
          let i = 0;
          for (const [k, val] of v as Map<unknown, unknown>) {
            if (i++ >= o.maxItems) {
              parts.push("…");
              break;
            }
            parts.push(`${enc(k, depth + 1)} => ${enc(val, depth + 1)}`);
          }
          return `Map{${parts.join(", ")}}`;
        }
        case "[object Set]": {
          const parts: string[] = [];
          let i = 0;
          for (const val of v as Set<unknown>) {
            if (i++ >= o.maxItems) {
              parts.push("…");
              break;
            }
            parts.push(enc(val, depth + 1));
          }
          return `Set{${parts.join(", ")}}`;
        }
        case "[object Promise]":
          // Settlement is not synchronously observable; the sandbox emits a
          // separate `settle` record for promises that reach a trace boundary.
          return `Promise#${idOf(v)}`;
        case "[object ArrayBuffer]":
          return `ArrayBuffer(${(v as ArrayBuffer).byteLength})`;
      }
      if (ArrayBuffer.isView(v)) {
        const view = v as unknown as { length?: number; [i: number]: unknown };
        const parts: string[] = [];
        const len = typeof view.length === "number" ? view.length : 0;
        const n = Math.min(len, o.maxItems);
        for (let i = 0; i < n; i++) parts.push(num(Number(view[i])));
        return `${ctor}[${parts.join(", ")}${len > n ? ", …" : ""}]`;
      }

      let entries = ownEntries(v);
      if (o.sortKeys) entries = entries.slice().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const inner = entries.map(([k, ev]) => `${k}: ${ev}`).join(", ");
      const name = ctor === "Object" ? "" : ctor;
      return `${name}{${inner}}`;
    }

    function enc(v: unknown, depth: number): string {
      switch (typeof v) {
        case "undefined":
          return "undefined";
        case "boolean":
          return String(v);
        case "number":
          return num(v);
        case "bigint":
          return `${v}n`;
        case "string":
          return str(v);
        case "symbol":
          return `Symbol(${v.description ?? ""})`;
        case "function": {
          const f = v as (...args: unknown[]) => unknown;
          const nm = o.maskFunctionNames ? "~" : f.name || "<anon>";
          const kind = /^class\b/.test(fnSource(f)) ? "class" : "fn";
          return `[${kind} ${nm}/${f.length}]`;
        }
      }
      if (v === null) return "null";
      // Every other `typeof` outcome returned above; what remains is an
      // object (TS's flow narrowing doesn't collapse an exhaustive
      // `switch (typeof v)` over `unknown` all the way to `object`, so this
      // is asserted, not inferred).
      const obj = v as object;
      if (depth >= o.maxDepth) return `…#${idOf(obj)}`;
      if (seen.has(obj)) return `<circular #${idOf(obj)}>`;
      seen.add(obj);
      try {
        return body(obj, depth);
      } finally {
        seen.delete(obj);
      }
    }

    return enc(root, 0);
  };
}

/** The messages V8 and Hermes use when the *engine's own* resource ceiling
 *  is hit — the call stack, the maximum string length, the maximum array
 *  length. They are not program-level observations: they say "this engine
 *  ran out of room here", exactly the way a `limit` record says "the budget
 *  ran out here" (docs/BUGS.md 2026-09-04, the 30 finds whose candidate
 *  died of an uncaught RangeError under Node while the Hermes VM kept
 *  looping to its timeout).
 *
 *  Deliberately narrow, because `RangeError: Invalid array length` is *also*
 *  what a program-level `new Array(-1)` throws: `isResourceCeilingRecord`
 *  only says "this record is resource-ceiling shaped". Every caller must add
 *  the context that makes it a budget marker rather than an observation —
 *  the *other* side must still be running inside its own budget at that
 *  point (see `compareTraces` and `ladder.ts`'s VM cross-check). */
const RESOURCE_CEILING_MESSAGES: readonly string[] = ["Maximum call stack size exceeded", "Invalid string length", "Invalid array length"];

/** True for an `err`/`unhandled` record carrying one of the engine
 *  resource-ceiling RangeErrors above. See `RESOURCE_CEILING_MESSAGES` for
 *  why this is a shape test, never on its own a verdict. */
export function isResourceCeilingRecord(r: TraceRecord): boolean {
  if (r.k !== "err" && r.k !== "unhandled") return false;
  if (r.name !== "RangeError") return false;
  return RESOURCE_CEILING_MESSAGES.some((m) => r.message.includes(m));
}

// docs/BUGS.md 2026-09-04 family F3: a read of a missing global throws a
// ReferenceError in both engines, at the same point, with the same
// constructor — but Hermes words it `Property 'f2' doesn't exist` and V8
// words it `f2 is not defined`. A program that prints `String(e)` therefore
// carries engine-specific prose inside an ordinary `out` record, where
// `renderRecordMasked`'s err/unhandled masking channel never sees it. Both
// renderings are projected onto one canonical, *name-preserving* form so the
// comparison is symmetric: the identifier is kept (a missing `f2` still
// never matches a missing `f3`), only the engine's wording is dropped.
const HERMES_MISSING_GLOBAL = /Property '([A-Za-z_$][A-Za-z0-9_$]*)' doesn't exist/g;

/** Canonicalises the two engine renderings of a missing-global
 *  ReferenceError onto V8's wording (`X is not defined`), preserving X.
 *  Applied to *both* sides of every comparison, never to one. */
export function normaliseEngineMessages(text: string): string {
  return text.replace(HERMES_MISSING_GLOBAL, "$1 is not defined");
}

/** Canonical single-line rendering of a record, used as the diff unit. */
export function renderRecord(r: TraceRecord): string {
  switch (r.k) {
    case "out":
      return `out ${r.ch} ${JSON.stringify(r.s)} ${JSON.stringify(r.a)}`;
    case "hostset":
      return `hostset ${r.o}.${r.p} = ${r.v}`;
    case "call":
      return `call ${r.fn}(${r.args.join(", ")}) ${r.throws !== undefined ? `throws ${r.throws}` : `-> ${r.ret}`}`;
    case "yield":
      return `yield ${r.fn}#${r.i} done=${r.done} ${r.v}`;
    case "settle":
      return `settle #${r.id} ${r.state} ${r.v}`;
    case "tick":
      return `tick t=${r.t}`;
    case "err":
      return `err ${r.phase} ${r.name}: ${r.message}`;
    case "unhandled":
      return `unhandled ${r.name}: ${r.message}`;
    case "ret":
      return `ret ${r.v}`;
    case "globals":
      return `globals ${r.v}`;
    case "limit":
      return `limit ${r.why}`;
    case "end":
      return "end";
    case "meta":
      return `meta ${r.engine}`;
    default: {
      const _exhaustive: never = r;
      return JSON.stringify(_exhaustive);
    }
  }
}

/** Same as `renderRecord`, except an `err`/`unhandled` record's `.message`
 *  is identifier-masked (`maskIdentifierTokens`) — the constructor name
 *  (`.name`) and thrown-vs-not-thrown shape are unmasked and still exact.
 *  Identical to `renderRecord` for every other record kind, so it can never
 *  turn a real divergence elsewhere in the trace into a match. */
export function renderRecordMasked(r: TraceRecord): string {
  if (r.k === "err") return `err ${r.phase} ${r.name}: ${maskIdentifierTokens(r.message)}`;
  if (r.k === "unhandled") return `unhandled ${r.name}: ${maskIdentifierTokens(r.message)}`;
  return renderRecord(r);
}

/** `meta` is informational (it names the engine, which always differs in
 *  ways that don't matter) and is never part of a comparison. */
export function isComparable(r: TraceRecord): boolean {
  return r.k !== "meta";
}

/** Records that count as *evidence*. A pair of traces containing none of
 *  these proves nothing, so the harness reports INCONCLUSIVE rather than
 *  PASS (docs/EQUIVALENCE.md R3; spec 06 §2's guard). */
export function isEvidence(r: TraceRecord): boolean {
  if (r.k === "out" || r.k === "err" || r.k === "unhandled" || r.k === "call" || r.k === "yield") return true;
  if (r.k === "hostset" || r.k === "settle") return true;
  if (r.k === "ret") return r.v !== "undefined";
  if (r.k === "globals") return r.v !== "{}";
  return false;
}

/** The `print`-channel projection of a full trace's records — what a
 *  print-only Hermes trace can be compared against (§3.2). */
export function printLines(records: readonly TraceRecord[]): readonly string[] {
  return records.filter((r): r is OutRecord => r.k === "out" && (r.ch === "print" || r.ch === "__trace")).map((r) => r.s);
}

/** `printLines` plus the program's terminating error, as `uncaught <Name>`
 *  when the main phase threw — the full-trace side of the D14 Hermes-VM
 *  cross-check, shaped exactly like `hermes-vm.ts`'s `hermesPrintProjection`
 *  of the VM's stdout/stderr. Name only (see `uncaughtErrorName` there for
 *  why the message is never compared across engines). A `parse`-phase error
 *  is the syntax oracle's business and a `drain`-phase one (a throw inside a
 *  microtask/timer the sandbox drove) has no Hermes-side counterpart, so
 *  only `phase === "main"` counts. */
export function printProjection(records: readonly TraceRecord[]): readonly string[] {
  const lines = [...printLines(records)];
  const err = records.find((r): r is ErrRecord => r.k === "err" && r.phase === "main");
  if (err !== undefined) lines.push(`uncaught ${err.name}`);
  return lines;
}
