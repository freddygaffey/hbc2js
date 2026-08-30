// docs/specs/06-harness.md §1 — port of tools/equiv/src/sandbox.mjs, unchanged
// semantics. The deterministic sandbox: a `node:vm` context with every
// observable host API stubbed onto a trace, every nondeterministic source
// pinned, and a virtual event loop so timer-driven programs finish in
// microseconds and in a fixed order.
//
// Everything in here must be a pure function of (source, seed). If you add a
// global, ask: can two runs of the same source disagree about it? If yes it
// must be pinned here, not left to Node.
import vm from "node:vm";
import type { Encoder } from "./trace.ts";
import { errShape } from "./trace.ts";

export type Emit = (rec: Record<string, unknown> & { k: string }) => void;

/** xorshift128+ — small, fast, and identical across engines, so the same
 *  seed gives the same stream under Node and (if ported) under Hermes. */
export function makePrng(seed: number): () => number {
  let s0 = (seed ^ 0x9e3779b9) >>> 0 || 1;
  let s1 = (seed + 0x85ebca6b) >>> 0 || 2;
  let s2 = (seed ^ 0xc2b2ae35) >>> 0 || 3;
  let s3 = (seed + 0x27d4eb2f) >>> 0 || 4;
  return function random(): number {
    const t = (s1 << 9) >>> 0;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = ((s3 << 11) | (s3 >>> 21)) >>> 0;
    const hi = (s0 >>> 5) * 67108864; // 2^26
    const lo = s1 >>> 6; // 2^26 bits
    return (hi + lo) / 9007199254740992; // 2^53
  };
}

export const FROZEN_EPOCH = 1700000000000; // 2023-11-14T22:13:20Z, arbitrary but fixed

export interface SandboxOptions {
  readonly emit: Emit;
  readonly encode: Encoder;
  readonly seed?: number;
  readonly timerBudget?: number;
}

export interface Sandbox {
  readonly ctx: vm.Context;
  readonly global: Record<string, unknown>;
  readonly drain: () => Promise<void>;
  readonly virtualNow: number;
  readonly globalsDelta: () => string;
  readonly exportedFunctions: () => ReadonlyArray<[string, (...args: unknown[]) => unknown]>;
}

interface Timer {
  readonly at: number;
  readonly seq: number;
  readonly fn: (...args: unknown[]) => unknown;
  readonly args: readonly unknown[];
  readonly interval: number | null;
  readonly id: number;
}

export function createSandbox(options: SandboxOptions): Sandbox {
  const { emit, encode, seed = 0, timerBudget = 10000 } = options;

  // ---- virtual clock -----------------------------------------------------
  let now = 0;
  let timerSeq = 0;
  let timerCount = 0;
  const timers: Timer[] = [];
  const cancelled = new Set<number>();
  let nextTimerId = 1;

  function schedule(fn: (...args: unknown[]) => unknown, delay: unknown, args: readonly unknown[], interval: number | null): number {
    const id = nextTimerId++;
    const at = now + Math.max(0, Number(delay) || 0);
    timers.push({ at, seq: timerSeq++, fn, args, interval, id });
    return id;
  }

  const flushMicrotasks = (): Promise<void> => new Promise((r) => setImmediate(r));

  async function drain(): Promise<void> {
    await flushMicrotasks();
    while (timers.length > 0) {
      if (timerCount++ >= timerBudget) {
        emit({ k: "limit", why: "timer-budget" });
        return;
      }
      let best = -1;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i]!;
        if (cancelled.has(t.id)) continue;
        if (best < 0) {
          best = i;
          continue;
        }
        const b = timers[best]!;
        if (t.at < b.at || (t.at === b.at && t.seq < b.seq)) best = i;
      }
      if (best < 0) break;
      const t = timers.splice(best, 1)[0]!;
      if (now !== t.at) {
        now = t.at;
        emit({ k: "tick", t: now });
      }
      if (t.interval !== null) {
        timers.push({ ...t, at: now + Math.max(1, t.interval), seq: timerSeq++ });
      }
      try {
        t.fn(...t.args);
      } catch (e) {
        emit({ k: "err", phase: "timer", ...errShape(e) });
      }
      await flushMicrotasks();
    }
  }

  // ---- host output stubs -------------------------------------------------
  // Hermes's `print` renders each argument with String() and joins with a
  // single space. Record both the rendered line (comparable against a
  // fixture's expected.txt and a real Hermes run) and the structural
  // encoding of each argument (strictly stronger).
  function hermesRender(args: readonly unknown[]): string {
    return args
      .map((a) => {
        try {
          return typeof a === "symbol" ? String(a) : String(a);
        } catch {
          return "<unstringifiable>";
        }
      })
      .join(" ");
  }

  function out(ch: string): (...args: unknown[]) => undefined {
    return function (...args: unknown[]): undefined {
      emit({ k: "out", ch, s: hermesRender(args), a: args.map((a) => encode(a)) });
      return undefined;
    };
  }

  // A recording stand-in for host objects the program pokes at (`window`,
  // `document`, ...). Property *writes* are observable; reads return further
  // recording stubs so chained access does not throw and does not diverge.
  function recordingHost(path: string, depth = 0): object {
    const backing: Record<PropertyKey, unknown> = Object.create(null);
    return new Proxy(backing, {
      get(t, p): unknown {
        if (p === Symbol.toPrimitive) return () => `[host ${path}]`;
        if (p === Symbol.toStringTag) return "HostObject";
        if (p === "toString") return () => `[host ${path}]`;
        if (p === "then") return undefined; // never look thenable
        if (p in t) return t[p];
        if (typeof p === "symbol") return undefined;
        if (depth >= 4) return undefined;
        const child = recordingHost(`${path}.${String(p)}`, depth + 1);
        t[p] = child;
        return child;
      },
      set(t, p, v): boolean {
        if (typeof p !== "symbol") emit({ k: "hostset", o: path, p: String(p), v: encode(v) });
        t[p] = v;
        return true;
      },
      has(): boolean {
        return true;
      },
    });
  }

  // ---- context -----------------------------------------------------------
  const ctx = vm.createContext(Object.create(null), {
    codeGeneration: { strings: true, wasm: false },
  });

  const g = vm.runInContext("this", ctx) as Record<string, unknown>;

  const random = makePrng(seed);
  vm.runInContext("Math.random", ctx); // ensure Math exists
  (g["Math"] as { random: () => number }).random = random;

  // Freeze the clock. `Date.now()` and `new Date()` both return FROZEN_EPOCH.
  const RealDate = g["Date"] as DateConstructor;
  const FrozenDate = new Proxy(RealDate, {
    construct(target, args, nt): object {
      return args.length === 0 ? Reflect.construct(target, [FROZEN_EPOCH], nt as (...a: unknown[]) => unknown) : Reflect.construct(target, args, nt as (...a: unknown[]) => unknown);
    },
    apply(): string {
      return new RealDate(FROZEN_EPOCH).toString();
    },
  }) as unknown as DateConstructor & { now: () => number };
  FrozenDate.now = () => FROZEN_EPOCH;
  g["Date"] = FrozenDate;

  g["globalThis"] = g;
  g["print"] = out("print");
  g["alert"] = out("alert");
  g["console"] = {
    log: out("console.log"),
    info: out("console.info"),
    warn: out("console.warn"),
    error: out("console.error"),
    debug: out("console.debug"),
    trace: out("console.trace"),
  };
  const window = recordingHost("window");
  g["window"] = window;
  g["self"] = window;
  g["document"] = recordingHost("document");
  g["navigator"] = recordingHost("navigator");
  g["performance"] = { now: () => now };

  g["setTimeout"] = (fn: (...a: unknown[]) => unknown, d: unknown, ...a: unknown[]) => schedule(fn, d, a, null);
  g["setInterval"] = (fn: (...a: unknown[]) => unknown, d: unknown, ...a: unknown[]) => schedule(fn, d, a, Number(d) || 1);
  g["setImmediate"] = (fn: (...a: unknown[]) => unknown, ...a: unknown[]) => schedule(fn, 0, a, null);
  const clear = (id: unknown): void => {
    cancelled.add(Number(id));
  };
  g["clearTimeout"] = clear;
  g["clearInterval"] = clear;
  g["clearImmediate"] = clear;
  g["queueMicrotask"] = (fn: () => unknown): void => {
    void Promise.resolve().then(() => {
      try {
        fn();
      } catch (e) {
        emit({ k: "err", phase: "microtask", ...errShape(e) });
      }
    });
  };

  // A trace hook the harness can inject into instrumented fixtures.
  g["__trace"] = (...args: unknown[]): void => {
    emit({ k: "out", ch: "__trace", s: hermesRender(args), a: args.map(encode) });
  };

  const baseline = new Set(Reflect.ownKeys(g));

  function ownAdded(): string[] {
    return Reflect.ownKeys(g)
      .filter((k): k is string => typeof k === "string" && !baseline.has(k))
      .sort();
  }

  return {
    ctx,
    global: g,
    drain,
    get virtualNow(): number {
      return now;
    },
    // Own properties the program added to the global object, encoded in
    // sorted key order. This is what makes an "outputs nothing" program
    // observable.
    globalsDelta(): string {
      const keys = ownAdded();
      const parts: string[] = [];
      for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(g, k);
        parts.push(`${k}: ${d?.get !== undefined ? "<accessor>" : encode(d?.value)}`);
      }
      return `{${parts.join(", ")}}`;
    },
    exportedFunctions(): ReadonlyArray<[string, (...args: unknown[]) => unknown]> {
      const keys = ownAdded();
      const fns: Array<[string, (...args: unknown[]) => unknown]> = [];
      for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(g, k);
        if (d !== undefined && d.get === undefined && typeof d.value === "function") fns.push([k, d.value as (...args: unknown[]) => unknown]);
      }
      return fns;
    },
  };
}

export { errShape };
