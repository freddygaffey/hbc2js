// tools/passes-metrics.mjs — docs/specs/passes/02-expr-rebuild.md §7's corpus
// metric: over `tests/fixtures/constructs/**` at v94, compare the pipeline
// with `expr-rebuild` off vs on, measuring total `rN` identifier occurrences
// in the emitted code and the median statements per emitted function.
//
//   node tools/passes-metrics.mjs [--json]
//
// `tests/gate/passes/expr-rebuild-metrics.test.ts` imports `measure()` and
// asserts the spec's floor (>=50% register-occurrence reduction, >=35%
// median-statement reduction).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyseModule } from "../src/cfg/index.ts";
import { decompile, parseForDecompile } from "../src/decompile.ts";
import { emitModule } from "../src/emit/index.ts";
import { astPassHook, passHook } from "../src/passes/index.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const CORPUS_DIR = join(ROOT, "tests", "fixtures", "constructs");

/** Statements in `list`, recursively — but never descending into a nested
 *  `func`'s own body: that is a separate function, counted on its own when
 *  its turn comes (mirrors `src/passes/ast.ts`'s `stmtLists`). */
function countStmts(list) {
  let n = 0;
  for (const s of list) {
    n++;
    switch (s.k) {
      case "if":
        n += countStmts(s.then) + countStmts(s.else);
        break;
      case "while":
      case "do-while":
      case "for":
      case "labeled":
      case "iife":
        n += countStmts(s.body);
        break;
      case "try":
        n += countStmts(s.block) + countStmts(s.handler);
        break;
      case "switch":
        for (const c of s.cases) n += countStmts(c.body);
        break;
      default:
        break; // "func": a separate function, counted separately
    }
  }
  return n;
}

/** One statement count per emitted function, via the same `astPassHook` tap
 *  `decompileAst` (`src/decompile.ts`) uses to capture each function's body
 *  before it is spliced into its parent. */
function functionStmtCounts(bytes, moduleName, passesOpt) {
  const { module } = parseForDecompile(bytes);
  const analysis = analyseModule(module, { strictEnv: true });
  const bodies = [];
  const hook = astPassHook(analysis, passesOpt);
  emitModule(analysis, {
    moduleName,
    provenanceComments: false,
    strictEnv: true,
    passes: passHook(analysis, passesOpt),
    astPasses: (fn, cfg) => {
      const out = hook(fn, cfg);
      if (out.fn.k === "func") bodies.push(out.fn);
      return out;
    },
  });
  return bodies.map((fn) => countStmts(fn.body));
}

function median(nums) {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function registerOccurrences(code) {
  return (code.match(/\br\d+\b/g) ?? []).length;
}

export function measure() {
  const dirs = readdirSync(CORPUS_DIR)
    .filter((d) => existsSync(join(CORPUS_DIR, d, "v94.hbc")))
    .sort();
  let beforeRegs = 0;
  let afterRegs = 0;
  const beforeStmts = [];
  const afterStmts = [];
  const perFixture = [];
  for (const dir of dirs) {
    const file = join(CORPUS_DIR, dir, "v94.hbc");
    const bytes = new Uint8Array(readFileSync(file));
    const before = decompile(bytes, { moduleName: dir, passes: { skip: ["expr-rebuild"] } });
    const after = decompile(bytes, { moduleName: dir });
    const bRegs = registerOccurrences(before.code);
    const aRegs = registerOccurrences(after.code);
    beforeRegs += bRegs;
    afterRegs += aRegs;
    const bStmts = functionStmtCounts(bytes, dir, { skip: ["expr-rebuild"] });
    const aStmts = functionStmtCounts(bytes, dir, {});
    beforeStmts.push(...bStmts);
    afterStmts.push(...aStmts);
    perFixture.push({ fixture: dir, beforeRegs: bRegs, afterRegs: aRegs });
  }
  const medianBefore = median(beforeStmts);
  const medianAfter = median(afterStmts);
  const regReductionPct = beforeRegs === 0 ? 0 : (1 - afterRegs / beforeRegs) * 100;
  const stmtReductionPct = medianBefore === 0 ? 0 : (1 - medianAfter / medianBefore) * 100;
  return {
    fixtureCount: dirs.length,
    registerOccurrences: { before: beforeRegs, after: afterRegs, reductionPct: regReductionPct },
    medianStatementsPerFunction: { before: medianBefore, after: medianAfter, reductionPct: stmtReductionPct },
    perFixture,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = measure();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`fixtures: ${result.fixtureCount}`);
    console.log(`register occurrences: ${result.registerOccurrences.before} -> ${result.registerOccurrences.after} (${result.registerOccurrences.reductionPct.toFixed(1)}% reduction)`);
    console.log(`median statements/function: ${result.medianStatementsPerFunction.before} -> ${result.medianStatementsPerFunction.after} (${result.medianStatementsPerFunction.reductionPct.toFixed(1)}% reduction)`);
  }
}
