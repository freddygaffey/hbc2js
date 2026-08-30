// Standalone probe spawned as a fresh process by adversarial-ladder.test.ts's
// maxDepth boundary cases. Deliberately isolated: V8's effective call-stack
// margin for a given logical recursion depth depends on JIT warmup state, so
// measuring this in-process (after other tests have already run deep
// recursions) gives a falsely generous boundary — the number that matters is
// what a fresh `hbc2js` CLI invocation (always a cold process) actually
// tolerates. Prints "OK" (exit 0) or "THROW <constructor name>: <message>"
// (exit 1).
import { structure } from "../../../../src/structure/index.ts";
import { insn, reg, synthCfg } from "../synth.ts";

function chain(n: number) {
  const spec: { succs: number[]; insns: ReturnType<typeof insn>[] }[] = [];
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    spec.push({ succs: last ? [] : [i + 1], insns: last ? [insn("Ret", reg(1))] : [insn("Mov", reg(1), reg(1))] });
  }
  return synthCfg(spec);
}

const n = Number(process.argv[2]);
try {
  structure(chain(n));
  process.stdout.write("OK\n");
} catch (e) {
  const ctor = e instanceof Error ? e.constructor.name : typeof e;
  const msg = e instanceof Error ? e.message : String(e);
  process.stdout.write(`THROW ${ctor}: ${msg}\n`);
  process.exit(1);
}
