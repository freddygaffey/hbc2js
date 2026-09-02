// src/fuzzgen/generate.ts — docs/specs/09-fuzzing.md §1.1/§1.2.
//
// Seeded, deterministic JS-subset generator. `generate(seed, grammarVersion)`
// interleaves grammar mode and mutation mode 50/50 (§1.2) and always returns
// a program that: (a) is byte-identical for the same (seed, grammarVersion)
// pair, (b) contains no banned token (grammar.ts), (c) drives its own
// execution by calling its declared functions and `print()`-ing results, so
// the trace oracle has something to compare.
import { mutateFromCorpus } from "./mutate.ts";
import { hasNoBannedTokens } from "./grammar.ts";

/** mulberry32 — small, fast, deterministic PRNG. Same algorithm reused
 *  wherever the fuzzer needs seeded randomness (generator, mutator,
 *  minimiser) so a single 64-bit seed reproduces a whole run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[randInt(rng, arr.length)]!;
}

const NUM_LITERALS = ["0", "1", "-1", "2", "3", "-0", "0.5", "-2.5", "100", "1000"];
const STR_LITERALS = ["''", "'a'", "'b'", "'x0'", "''+1", "'0'"];
const BOOL_LITERALS = ["true", "false"];
const BIN_OPS = ["+", "-", "*", "%", "===", "!==", "<", ">", "<=", ">=", "&&", "||", "??"];

function atom(rng: () => number, vars: readonly string[]): string {
  const kind = randInt(rng, vars.length > 0 ? 4 : 3);
  if (kind === 0) return pick(rng, NUM_LITERALS);
  if (kind === 1) return pick(rng, STR_LITERALS);
  if (kind === 2) return pick(rng, BOOL_LITERALS);
  return pick(rng, vars);
}

function expr(rng: () => number, vars: readonly string[], depth: number): string {
  if (depth <= 0 || rng() < 0.4) return atom(rng, vars);
  const kind = randInt(rng, 4);
  if (kind === 0) {
    return `(${expr(rng, vars, depth - 1)} ${pick(rng, BIN_OPS)} ${expr(rng, vars, depth - 1)})`;
  }
  if (kind === 1) {
    return `(${expr(rng, vars, depth - 1)} ? ${expr(rng, vars, depth - 1)} : ${expr(rng, vars, depth - 1)})`;
  }
  if (kind === 2) {
    return `[${expr(rng, vars, depth - 1)}, ${expr(rng, vars, depth - 1)}]`;
  }
  return `\`v-\${${atom(rng, vars)}}\``;
}

interface Ctx {
  readonly rng: () => number;
  readonly vars: string[];
  fnCount: number;
}

function block(ctx: Ctx, depth: number, count: number): string {
  const stmts: string[] = [];
  for (let i = 0; i < count; i++) stmts.push(statement(ctx, depth));
  return stmts.join("\n  ");
}

function statement(ctx: Ctx, depth: number): string {
  const { rng, vars } = ctx;
  if (depth <= 0) return `print(${expr(rng, vars, 1)});`;
  const kind = randInt(rng, 6);
  if (kind === 0) {
    const v = `t${vars.length}`;
    vars.push(v);
    return `let ${v} = ${expr(rng, vars, depth)};\nprint(${v});`;
  }
  if (kind === 1) {
    return `if (${expr(rng, vars, depth)}) {\n  ${statement(ctx, depth - 1)}\n} else {\n  ${statement(ctx, depth - 1)}\n}`;
  }
  if (kind === 2) {
    const n = 1 + randInt(rng, 3);
    return `for (let i = 0; i < ${n}; i++) {\n  print(i, ${expr(rng, vars, depth - 1)});\n}`;
  }
  if (kind === 3) {
    return `try {\n  ${statement(ctx, depth - 1)}\n} catch (e) {\n  print('caught', String(e));\n} finally {\n  print('finally');\n}`;
  }
  if (kind === 4) {
    return `switch (${expr(rng, vars, 1)}) {\n  case 0: print('zero'); break;\n  case 1: print('one'); break;\n  default: print('other', ${expr(rng, vars, depth - 1)});\n}`;
  }
  return `print(${expr(rng, vars, depth)});`;
}

function functionDecl(ctx: Ctx, depth: number): string {
  const name = `f${ctx.fnCount++}`;
  const a = `a${ctx.fnCount}`;
  const b = `b${ctx.fnCount}`;
  const inner: Ctx = { rng: ctx.rng, vars: [...ctx.vars, a, b], fnCount: ctx.fnCount };
  const body = block(inner, depth, 1 + randInt(ctx.rng, 2));
  const isGen = ctx.rng() < 0.15;
  if (isGen) {
    return `function* ${name}(${a}, ${b} = ${pick(ctx.rng, NUM_LITERALS)}) {\n  yield ${expr(ctx.rng, inner.vars, 1)};\n  ${body}\n  return ${expr(ctx.rng, inner.vars, 1)};\n}`;
  }
  return `function ${name}(${a}, ${b} = ${pick(ctx.rng, NUM_LITERALS)}) {\n  ${body}\n  return ${expr(ctx.rng, inner.vars, 1)};\n}`;
}

/** Grammar-mode program: N top-level functions (some generators, some
 *  closures over a shared outer variable) followed by calls that print
 *  their results, per §1.2's determinism and execution-driving rules. */
function generateGrammar(seed: number): string {
  const rng = mulberry32(seed);
  const ctx: Ctx = { rng, vars: ["outer"], fnCount: 0 };
  const nFns = 2 + randInt(rng, 3);
  const parts: string[] = ["let outer = 0;"];
  const names: string[] = [];
  for (let i = 0; i < nFns; i++) {
    const decl = functionDecl(ctx, 2);
    parts.push(decl);
    names.push(`f${i}`);
  }
  for (const name of names) {
    parts.push(`try {\n  const g = ${name}(${pick(rng, NUM_LITERALS)}, ${pick(rng, NUM_LITERALS)});\n  if (typeof g === 'object' && g !== null && typeof g.next === 'function') {\n    for (const x of g) print('${name}', x);\n  } else {\n    print('${name}', g);\n  }\n} catch (e) {\n  print('${name}', 'threw', String(e));\n}`);
  }
  parts.push(`print('outer', outer);`);
  return parts.join("\n\n") + "\n";
}

/** `mode` is derived from the seed, never a free parameter, so `(seed,
 *  grammarVersion)` alone determines output (determinism, T2(a)). `hbcVersion`
 *  (optional, backward-compatible) is the target HBC version mutation mode
 *  will compile the result at — when given, `mutateFromCorpus` never selects
 *  a corpus fixture whose `versions.txt` excludes it (docs/BUGS.md
 *  2026-09-02, mutation version-gating). */
export function generate(seed: number, grammarVersion: string, hbcVersion?: number): string {
  const modeRng = mulberry32(seed ^ 0x9e3779b9);
  const useMutation = modeRng() < 0.5;
  const src = useMutation ? mutateFromCorpus(seed, hbcVersion) : generateGrammar(seed);
  if (hasNoBannedTokens(src)) return `// hbc2js fuzzgen seed=${seed} grammarVersion=${grammarVersion} mode=${useMutation ? "mutation" : "grammar"}\n${src}`;
  // Safety net: never emit a banned token. Grammar mode cannot produce one by
  // construction; if mutation mode ever did (corpus fixtures are free text),
  // fall back to grammar mode deterministically for the same seed.
  return `// hbc2js fuzzgen seed=${seed} grammarVersion=${grammarVersion} mode=grammar-fallback\n${generateGrammar(seed)}`;
}
