// docs/specs/06-harness.md §1 — port of tools/equiv/src/child.mjs, unchanged.
// Runs one program in the deterministic sandbox and streams its trace as
// NDJSON on stdout.
//
// This runs as its own process for two reasons: a synchronous infinite loop
// in the program under test cannot be interrupted from inside the process (no
// timer will ever fire), so the parent has to SIGKILL it; and per-record
// `fs.writeSync` means the parent still receives everything emitted before
// the kill, which is what makes "diverges then hangs" distinguishable from
// "hangs immediately".
//
// Invoked as: `node child.ts <file> <optsJson>` (see runner.ts).
import fs from "node:fs";
import vm from "node:vm";
import { makeEncoder, errShape } from "./trace.ts";
import { createSandbox } from "./sandbox.ts";
import { makeCaseGenerator, cases } from "./fuzz.ts";
import { makePrng } from "./sandbox.ts";
import type { RunOptions } from "./runner.ts";

const [, , file, optsJson] = process.argv;
const opts: RunOptions = JSON.parse(optsJson ?? "{}") as RunOptions;

const encode = makeEncoder({
  maskFunctionNames: opts.relax?.includes("fn-names") ?? false,
  sortKeys: opts.relax?.includes("key-order") ?? false,
  maskErrorMessages: opts.relax?.includes("error-messages") ?? false,
  maxDepth: opts.maxDepth ?? 6,
});

let emitted = 0;
const maxRecords = opts.maxRecords ?? 20000;
let capped = false;

function emit(rec: Record<string, unknown> & { k: string }): void {
  if (capped) return;
  if (emitted++ >= maxRecords) {
    capped = true;
    fs.writeSync(1, JSON.stringify({ k: "limit", why: "record-cap" }) + "\n");
    return;
  }
  fs.writeSync(1, JSON.stringify(rec) + "\n");
}

const unhandled: Array<ReturnType<typeof errShape>> = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(errShape(reason));
});

const box = createSandbox({ emit, encode, seed: opts.seed ?? 0 });

emit({ k: "meta", v: 1, engine: `node ${process.versions.node}`, seed: opts.seed ?? 0 });

if (file === undefined) {
  process.stderr.write("child.ts: no file given\n");
  process.exit(3);
}

const src = fs.readFileSync(file, "utf8");

let script: vm.Script | undefined;
try {
  script = new vm.Script(src, { filename: "program.js" });
} catch (e) {
  emit({ k: "err", phase: "parse", ...errShape(e) });
  emit({ k: "end" });
  process.exit(0);
}

let mainThrew = false;
try {
  // `timeout` bounds only *synchronous* execution of this call. Callbacks the
  // program schedules are driven later by drain(), outside any vm timeout, so
  // the parent's wall-clock kill is the real backstop.
  const completion: unknown = script.runInContext(box.ctx, { timeout: opts.syncTimeout ?? 4000 });
  emit({ k: "ret", v: encode(completion) });
} catch (e) {
  mainThrew = true;
  // A vm timeout is a *budget*, not a behaviour: two different
  // non-terminating programs both "throw" it, and calling that EQUIVALENT
  // would be a false pass. It gets a `limit` record so compare.ts reports
  // INCONCLUSIVE.
  const err = e as { code?: string; message?: unknown };
  if (err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT" || /execution timed out/i.test(String(err.message))) {
    emit({ k: "limit", why: "sync-timeout" });
  } else {
    emit({ k: "err", phase: "main", ...errShape(e) });
  }
}

try {
  await box.drain();
} catch (e) {
  emit({ k: "err", phase: "drain", ...errShape(e) });
}

// Everything the program left on the global object. This is what gives a
// program with no output something to compare.
emit({ k: "globals", v: box.globalsDelta() });

// Property-based differential pass over exported functions.
if ((opts.fuzz ?? 0) > 0 && !mainThrew) {
  const random = makePrng((opts.seed ?? 0) ^ 0x5bf03635);
  const nextCase = makeCaseGenerator(opts.seed ?? 0, random);
  for (const [name, fn] of box.exportedFunctions()) {
    let i = 0;
    for (const args of cases(fn, opts.fuzz ?? 0, nextCase)) {
      if (capped) break;
      const encArgs = args.map(encode);
      let rec: (Record<string, unknown> & { k: string }) | null;
      try {
        const r: unknown = fn.apply(undefined, args);
        rec = { k: "call", fn: `${name}#${i}`, args: encArgs, ret: encode(r), throws: undefined };
        // Drive generators: an un-iterated generator object tells us nothing.
        if (r !== null && typeof r === "object" && "next" in r && typeof (r as { next: unknown }).next === "function" && typeof (r as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") {
          emit(rec);
          rec = null;
          const gen = r as { next: () => { done?: boolean; value?: unknown } };
          for (let step = 0; step < (opts.generatorSteps ?? 8); step++) {
            let s: { done?: boolean; value?: unknown };
            try {
              s = gen.next();
            } catch (e) {
              emit({ k: "yield", fn: `${name}#${i}`, i: step, done: "throw", v: JSON.stringify(errShape(e)) });
              break;
            }
            emit({ k: "yield", fn: `${name}#${i}`, i: step, done: s.done === true, v: encode(s.value) });
            if (s.done === true) break;
          }
        }
      } catch (e) {
        const s = errShape(e);
        rec = { k: "call", fn: `${name}#${i}`, args: encArgs, ret: undefined, throws: `${s.name}: ${s.message}` };
      }
      if (rec !== null) emit(rec);
      i++;
    }
    // Drain anything the calls scheduled so async functions settle.
    await box.drain();
  }
}

// Unhandled rejections surface at the end of a turn; give the loop one more
// pass before reporting them.
await new Promise<void>((r) => setImmediate(r));
for (const u of unhandled) emit({ k: "unhandled", ...u });

emit({ k: "end" });
process.exit(0);
