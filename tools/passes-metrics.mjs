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
//
// `measureGlobalAccess` (bottom of file) is
// docs/specs/passes/03-global-access.md §7's corpus metric: the share of
// emitted functions free of a `" in "` global guard, and the `globalThis.`
// occurrence drop, across all five HBC versions, `global-access` off vs on.
// `tests/gate/passes/global-access-metrics.test.ts` imports it.
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

// ---------------------------------------------------------------------------
// docs/specs/passes/03-global-access.md §7's corpus metric: the share of
// emitted functions containing zero `" in "` global guards, and the drop in
// `globalThis.` occurrences, with `global-access` off vs on, across all five
// HBC versions the corpus ships.
// ---------------------------------------------------------------------------

/** Does `stmts` contain a `bin "in"` node anywhere (including nested
 *  statement lists and nested `func` bodies — a guard surviving *anywhere*
 *  in a function still counts against that function for this metric)? */
function containsInGuard(stmts) {
  const visitExpr = (e) => {
    switch (e.k) {
      case "bin":
      case "logical":
        return e.op === "in" || visitExpr(e.left) || visitExpr(e.right);
      case "member":
        return visitExpr(e.obj) || (e.computed && visitExpr(e.prop));
      case "call":
      case "new":
        return visitExpr(e.callee) || e.args.some(visitExpr);
      case "unary":
        return visitExpr(e.arg);
      case "assign":
        return visitExpr(e.target) || visitExpr(e.value);
      case "cond":
        return visitExpr(e.test) || visitExpr(e.then) || visitExpr(e.else);
      case "array":
        return e.elements.some(visitExpr);
      case "object":
        return e.props.some((p) => visitExpr(p.value));
      case "seq":
        return e.exprs.some(visitExpr);
      case "func":
        return visitStmts(e.body);
      default:
        return false;
    }
  };
  const visitStmts = (list) => {
    for (const s of list) {
      switch (s.k) {
        case "expr":
          if (visitExpr(s.expr)) return true;
          break;
        case "init":
          if (visitExpr(s.value)) return true;
          break;
        case "if":
          if (visitExpr(s.test) || visitStmts(s.then) || visitStmts(s.else)) return true;
          break;
        case "while":
          if ((s.test !== undefined && visitExpr(s.test)) || visitStmts(s.body)) return true;
          break;
        case "do-while":
          if (visitExpr(s.test) || visitStmts(s.body)) return true;
          break;
        case "for":
          if ((s.init !== null && visitExpr(s.init)) || visitExpr(s.test) || (s.update !== null && visitExpr(s.update)) || visitStmts(s.body)) return true;
          break;
        case "labeled":
        case "iife":
          if (visitStmts(s.body)) return true;
          break;
        case "return":
          if (s.arg !== null && visitExpr(s.arg)) return true;
          break;
        case "throw":
          if (visitExpr(s.arg)) return true;
          break;
        case "try":
          if (visitStmts(s.block) || visitStmts(s.handler)) return true;
          break;
        case "switch":
          if (visitExpr(s.disc) || s.cases.some((c) => (c.test !== null && visitExpr(c.test)) || visitStmts(c.body))) return true;
          break;
        case "func":
          if (visitStmts(s.body)) return true;
          break;
        default:
          break;
      }
    }
    return false;
  };
  return visitStmts(stmts);
}

/** Every emitted function's body, via the same `astPassHook` tap
 *  `functionStmtCounts` uses above. */
function functionBodies(bytes, moduleName, passesOpt, resolveV98Ambiguity) {
  const { module } = parseForDecompile(bytes, { resolveV98Ambiguity });
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
      if (out.fn.k === "func") bodies.push(out.fn.body);
      return out;
    },
  });
  return bodies;
}

function globalThisOccurrences(code) {
  return (code.match(/globalThis\./g) ?? []).length;
}

const ALL_VERSIONS = [84, 94, 96, 98, 99];

export function measureGlobalAccess(versions = ALL_VERSIONS) {
  const dirs = readdirSync(CORPUS_DIR).sort();
  let beforeFns = 0;
  let afterFns = 0;
  let beforeCleanFns = 0;
  let afterCleanFns = 0;
  let beforeGT = 0;
  let afterGT = 0;
  const perFixture = [];
  for (const dir of dirs) {
    for (const version of versions) {
      const file = join(CORPUS_DIR, dir, `v${version}.hbc`);
      if (!existsSync(file)) continue;
      const bytes = new Uint8Array(readFileSync(file));
      const before = decompile(bytes, { moduleName: dir, resolveV98Ambiguity: true, passes: { skip: ["global-access"] } });
      const after = decompile(bytes, { moduleName: dir, resolveV98Ambiguity: true });
      beforeGT += globalThisOccurrences(before.code);
      afterGT += globalThisOccurrences(after.code);
      const beforeBodies = functionBodies(bytes, dir, { skip: ["global-access"] }, true);
      const afterBodies = functionBodies(bytes, dir, {}, true);
      beforeFns += beforeBodies.length;
      afterFns += afterBodies.length;
      const cleanBefore = beforeBodies.filter((b) => !containsInGuard(b)).length;
      const cleanAfter = afterBodies.filter((b) => !containsInGuard(b)).length;
      beforeCleanFns += cleanBefore;
      afterCleanFns += cleanAfter;
      perFixture.push({ fixture: dir, version, functions: afterBodies.length, cleanFunctionsBefore: cleanBefore, cleanFunctionsAfter: cleanAfter });
    }
  }
  const cleanFunctionPctBefore = beforeFns === 0 ? 0 : (beforeCleanFns / beforeFns) * 100;
  const cleanFunctionPctAfter = afterFns === 0 ? 0 : (afterCleanFns / afterFns) * 100;
  const globalThisReductionPct = beforeGT === 0 ? 0 : (1 - afterGT / beforeGT) * 100;
  return {
    functionCount: afterFns,
    cleanFunctionPct: cleanFunctionPctAfter,
    cleanFunctionPctBefore,
    globalThisOccurrences: { before: beforeGT, after: afterGT, reductionPct: globalThisReductionPct },
    perFixture,
  };
}

// ---------------------------------------------------------------------------
// docs/specs/passes/04-call-shape.md §7's corpus metric: the share of
// emitted functions containing zero `Reflect.apply`/`Reflect.construct`
// call, with `call-shape` off vs on, across all five HBC versions.
// `tests/gate/passes/call-shape-metrics.test.ts` imports `measureCallShape`;
// `measureCallShapeBundle` (sweep-tier only, real bundles are too large for
// the gate) is the spec's >=90%-on-the-RN-template-bundle half of the same
// metric.
// ---------------------------------------------------------------------------

/** Does `stmts` contain a call to `Reflect.apply`/`Reflect.construct`
 *  anywhere (including nested statement lists and nested `func` bodies — a
 *  surviving call anywhere in a function still counts against that function
 *  for this metric, mirroring `containsInGuard`'s own convention above)? */
function containsReflectCall(stmts) {
  const isReflectCallee = (callee) => callee.k === "member" && !callee.computed && callee.obj.k === "ident" && callee.obj.name === "Reflect" && callee.prop.k === "lit" && (callee.prop.text === "apply" || callee.prop.text === "construct");
  const visitExpr = (e) => {
    switch (e.k) {
      case "call":
        return isReflectCallee(e.callee) || visitExpr(e.callee) || e.args.some(visitExpr);
      case "new":
        return visitExpr(e.callee) || e.args.some(visitExpr);
      case "member":
        return visitExpr(e.obj) || (e.computed && visitExpr(e.prop));
      case "unary":
        return visitExpr(e.arg);
      case "assign":
        return visitExpr(e.target) || visitExpr(e.value);
      case "bin":
      case "logical":
        return visitExpr(e.left) || visitExpr(e.right);
      case "cond":
        return visitExpr(e.test) || visitExpr(e.then) || visitExpr(e.else);
      case "array":
        return e.elements.some(visitExpr);
      case "object":
        return e.props.some((p) => visitExpr(p.value));
      case "seq":
        return e.exprs.some(visitExpr);
      case "func":
        return visitStmts(e.body);
      default:
        return false;
    }
  };
  const visitStmts = (list) => {
    for (const s of list) {
      switch (s.k) {
        case "expr":
          if (visitExpr(s.expr)) return true;
          break;
        case "init":
          if (visitExpr(s.value)) return true;
          break;
        case "if":
          if (visitExpr(s.test) || visitStmts(s.then) || visitStmts(s.else)) return true;
          break;
        case "while":
          if ((s.test !== undefined && visitExpr(s.test)) || visitStmts(s.body)) return true;
          break;
        case "do-while":
          if (visitExpr(s.test) || visitStmts(s.body)) return true;
          break;
        case "for":
          if ((s.init !== null && visitExpr(s.init)) || visitExpr(s.test) || (s.update !== null && visitExpr(s.update)) || visitStmts(s.body)) return true;
          break;
        case "labeled":
        case "iife":
          if (visitStmts(s.body)) return true;
          break;
        case "return":
          if (s.arg !== null && visitExpr(s.arg)) return true;
          break;
        case "throw":
          if (visitExpr(s.arg)) return true;
          break;
        case "try":
          if (visitStmts(s.block) || visitStmts(s.handler)) return true;
          break;
        case "switch":
          if (visitExpr(s.disc) || s.cases.some((c) => (c.test !== null && visitExpr(c.test)) || visitStmts(c.body))) return true;
          break;
        case "func":
          if (visitStmts(s.body)) return true;
          break;
        default:
          break;
      }
    }
    return false;
  };
  return visitStmts(stmts);
}

export function measureCallShape(versions = ALL_VERSIONS) {
  const dirs = readdirSync(CORPUS_DIR).sort();
  let beforeFns = 0;
  let afterFns = 0;
  let beforeCleanFns = 0;
  let afterCleanFns = 0;
  const perFixture = [];
  for (const dir of dirs) {
    for (const version of versions) {
      const file = join(CORPUS_DIR, dir, `v${version}.hbc`);
      if (!existsSync(file)) continue;
      const bytes = new Uint8Array(readFileSync(file));
      const beforeBodies = functionBodies(bytes, dir, { skip: ["call-shape"] }, true);
      const afterBodies = functionBodies(bytes, dir, {}, true);
      beforeFns += beforeBodies.length;
      afterFns += afterBodies.length;
      const cleanBefore = beforeBodies.filter((b) => !containsReflectCall(b)).length;
      const cleanAfter = afterBodies.filter((b) => !containsReflectCall(b)).length;
      beforeCleanFns += cleanBefore;
      afterCleanFns += cleanAfter;
      perFixture.push({ fixture: dir, version, functions: afterBodies.length, cleanFunctionsBefore: cleanBefore, cleanFunctionsAfter: cleanAfter });
    }
  }
  const cleanFunctionPctBefore = beforeFns === 0 ? 0 : (beforeCleanFns / beforeFns) * 100;
  const cleanFunctionPctAfter = afterFns === 0 ? 0 : (afterCleanFns / afterFns) * 100;
  return {
    functionCount: afterFns,
    cleanFunctionPct: cleanFunctionPctAfter,
    cleanFunctionPctBefore,
    perFixture,
  };
}

/** Spec §7's other half: >=90% on the RN template bundle — a single, large
 *  `.hbc` file rather than the small per-construct corpus, so this is kept
 *  as a standalone entry point the sweep tier calls directly instead of
 *  folding into `measureCallShape`'s per-fixture loop above. */
export function measureCallShapeBundle(bundlePath) {
  const bytes = new Uint8Array(readFileSync(bundlePath));
  const beforeBodies = functionBodies(bytes, "bundle", { skip: ["call-shape"] }, true);
  const afterBodies = functionBodies(bytes, "bundle", {}, true);
  const cleanBefore = beforeBodies.filter((b) => !containsReflectCall(b)).length;
  const cleanAfter = afterBodies.filter((b) => !containsReflectCall(b)).length;
  return {
    functionCount: afterBodies.length,
    cleanFunctionPct: afterBodies.length === 0 ? 0 : (cleanAfter / afterBodies.length) * 100,
    cleanFunctionPctBefore: beforeBodies.length === 0 ? 0 : (cleanBefore / beforeBodies.length) * 100,
  };
}

// ---------------------------------------------------------------------------
// docs/specs/passes/05-fn-naming.md §7's corpus metric: the share of
// non-global emitted functions whose declaration is no longer `_fnN`, with
// `fn-naming` off vs on, at v94 only (spec §7's own scope — unlike the other
// three rungs' all-five-versions metric).
// ---------------------------------------------------------------------------

// A rename is only visible in the *parent* body that declares the `func`
// statement (fn-naming's site is the declaring list, not the child's own
// top-level `fn` node the `astPassHook` tap in the other `measure*` helpers
// above hands back) — the child's own hook invocation never touches its own
// name. Scanning the fully-assembled emitted text for `function _fnN(`
// declarations sidesteps that entirely: skipping `fn-naming` leaves *every*
// function (global included) `_fnN`-shaped, so the "before" text's count of
// distinct `_fnN(` declarations is the module's total function count, and
// every one no longer present in the "after" text's own count was renamed —
// the one exception (the global function, never renamed either way) is
// exactly the `-1` in `nonGlobalTotal` below.
const FN_DECL_RE = /\bfunction (_fn\d+)\(/g;

function fnDecls(code) {
  return new Set([...code.matchAll(FN_DECL_RE)].map((m) => m[1]));
}

export function measureFnNaming(versions = [94]) {
  const dirs = readdirSync(CORPUS_DIR).sort();
  let nonGlobalTotal = 0;
  let namedAfter = 0;
  const perFixture = [];
  for (const dir of dirs) {
    for (const version of versions) {
      const file = join(CORPUS_DIR, dir, `v${version}.hbc`);
      if (!existsSync(file)) continue;
      const bytes = new Uint8Array(readFileSync(file));
      const before = decompile(bytes, { moduleName: dir, resolveV98Ambiguity: true, passes: { skip: ["fn-naming"] } }).code;
      const after = decompile(bytes, { moduleName: dir, resolveV98Ambiguity: true }).code;
      const beforeDecls = fnDecls(before);
      const afterDecls = fnDecls(after);
      const total = beforeDecls.size;
      if (total === 0) continue; // no functions at all in this fixture/version
      const renamed = total - afterDecls.size; // every declaration that disappeared from the _fnN count
      const fixtureNonGlobal = total - 1; // exactly one global function per module, never renamed
      nonGlobalTotal += fixtureNonGlobal;
      namedAfter += renamed;
      perFixture.push({ fixture: dir, version, functions: fixtureNonGlobal, named: renamed });
    }
  }
  return {
    functionCount: nonGlobalTotal,
    namedPct: nonGlobalTotal === 0 ? 0 : (namedAfter / nonGlobalTotal) * 100,
    namedPctBefore: 0, // skipping fn-naming leaves every function _fnN-shaped, by construction
    perFixture,
  };
}

/** Spec §7's other half: the count of surviving `_fn` tokens on the RN
 *  template bundle — a single, large `.hbc` file, kept as a standalone entry
 *  point (mirrors `measureCallShapeBundle`) rather than folded into the
 *  per-fixture loop above. Reported in `docs/STATUS.md`, not gated (the
 *  bundle is too large for the gate's time budget, same convention as
 *  `measureCallShapeBundle`). */
export function measureFnNamingBundle(bundlePath) {
  const bytes = new Uint8Array(readFileSync(bundlePath));
  const before = decompile(bytes, { moduleName: "bundle", resolveV98Ambiguity: true, passes: { skip: ["fn-naming"] } }).code;
  const after = decompile(bytes, { moduleName: "bundle", resolveV98Ambiguity: true }).code;
  const total = fnDecls(before).size;
  const survivingFnTokens = fnDecls(after).size;
  const namedAfter = total - survivingFnTokens;
  const nonGlobalTotal = total === 0 ? 0 : total - 1;
  return {
    functionCount: nonGlobalTotal,
    namedPct: nonGlobalTotal === 0 ? 0 : (namedAfter / nonGlobalTotal) * 100,
    namedPctBefore: 0,
    survivingFnTokens: survivingFnTokens - (total === 0 ? 0 : 1), // exclude the never-renamed global function itself
  };
}

// ---------------------------------------------------------------------------
// docs/specs/passes/06-label-clean.md §7's corpus metric: the share of
// emitted functions containing zero `L\d+:` labels, over
// `tests/fixtures/constructs/**` at all five HBC versions, `label-clean` off
// vs on. `tests/gate/passes/label-clean-metrics.test.ts` imports
// `measureLabelClean`; `measureLabelCleanBundle` (sweep tier only) is the
// spec's "surviving labels per function on the RN template bundle" half.
// ---------------------------------------------------------------------------

/** Does `stmts` contain a surviving label anywhere (including nested
 *  statement lists and nested `func` bodies, mirroring `containsInGuard`'s
 *  and `containsReflectCall`'s convention above)? A loop's `label` is `null`
 *  once `label-clean`'s L3 rule hides it; a `labeled` node's `label` is
 *  never null by construction, so its mere presence always counts. */
function containsLabel(stmts) {
  const visitStmts = (list) => {
    for (const s of list) {
      switch (s.k) {
        case "if":
          if (visitStmts(s.then) || visitStmts(s.else)) return true;
          break;
        case "while":
        case "do-while":
        case "for":
          if (s.label !== null || visitStmts(s.body)) return true;
          break;
        case "labeled":
          return true;
        case "iife":
          if (visitStmts(s.body)) return true;
          break;
        case "try":
          if (visitStmts(s.block) || visitStmts(s.handler)) return true;
          break;
        case "switch":
          if (s.cases.some((c) => visitStmts(c.body))) return true;
          break;
        case "func":
          if (visitStmts(s.body)) return true;
          break;
        default:
          break;
      }
    }
    return false;
  };
  return visitStmts(stmts);
}

function labelOccurrences(code) {
  return (code.match(/\bL\d+:/g) ?? []).length;
}

export function measureLabelClean(versions = ALL_VERSIONS) {
  const dirs = readdirSync(CORPUS_DIR).sort();
  let beforeFns = 0;
  let afterFns = 0;
  let beforeLabelFreeFns = 0;
  let afterLabelFreeFns = 0;
  let beforeLabels = 0;
  let afterLabels = 0;
  const perFixture = [];
  for (const dir of dirs) {
    for (const version of versions) {
      const file = join(CORPUS_DIR, dir, `v${version}.hbc`);
      if (!existsSync(file)) continue;
      const bytes = new Uint8Array(readFileSync(file));
      const before = decompile(bytes, { moduleName: dir, resolveV98Ambiguity: true, passes: { skip: ["label-clean"] } });
      const after = decompile(bytes, { moduleName: dir, resolveV98Ambiguity: true });
      beforeLabels += labelOccurrences(before.code);
      afterLabels += labelOccurrences(after.code);
      const beforeBodies = functionBodies(bytes, dir, { skip: ["label-clean"] }, true);
      const afterBodies = functionBodies(bytes, dir, {}, true);
      beforeFns += beforeBodies.length;
      afterFns += afterBodies.length;
      const freeBefore = beforeBodies.filter((b) => !containsLabel(b)).length;
      const freeAfter = afterBodies.filter((b) => !containsLabel(b)).length;
      beforeLabelFreeFns += freeBefore;
      afterLabelFreeFns += freeAfter;
      perFixture.push({ fixture: dir, version, functions: afterBodies.length, labelFreeBefore: freeBefore, labelFreeAfter: freeAfter });
    }
  }
  const labelFreeFunctionPctBefore = beforeFns === 0 ? 0 : (beforeLabelFreeFns / beforeFns) * 100;
  const labelFreeFunctionPctAfter = afterFns === 0 ? 0 : (afterLabelFreeFns / afterFns) * 100;
  const labelReductionPct = beforeLabels === 0 ? 0 : (1 - afterLabels / beforeLabels) * 100;
  return {
    functionCount: afterFns,
    labelFreeFunctionPct: labelFreeFunctionPctAfter,
    labelFreeFunctionPctBefore,
    labelOccurrences: { before: beforeLabels, after: afterLabels, reductionPct: labelReductionPct },
    perFixture,
  };
}

/** Spec §7's "surviving labels per function on the RN template bundle" half
 *  — a single, large `.hbc` file rather than the small per-construct corpus,
 *  kept as a standalone entry point the sweep tier calls directly, mirroring
 *  `measureCallShapeBundle`. */
export function measureLabelCleanBundle(bundlePath) {
  const bytes = new Uint8Array(readFileSync(bundlePath));
  const beforeBodies = functionBodies(bytes, "bundle", { skip: ["label-clean"] }, true);
  const afterBodies = functionBodies(bytes, "bundle", {}, true);
  const freeBefore = beforeBodies.filter((b) => !containsLabel(b)).length;
  const freeAfter = afterBodies.filter((b) => !containsLabel(b)).length;
  return {
    functionCount: afterBodies.length,
    labelFreeFunctionPct: afterBodies.length === 0 ? 0 : (freeAfter / afterBodies.length) * 100,
    labelFreeFunctionPctBefore: beforeBodies.length === 0 ? 0 : (freeBefore / beforeBodies.length) * 100,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = measure();
  const ga = measureGlobalAccess();
  const cs = measureCallShape();
  const fn = measureFnNaming();
  const lc = measureLabelClean();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ exprRebuild: result, globalAccess: ga, callShape: cs, fnNaming: fn, labelClean: lc }, null, 2));
  } else {
    console.log(`fixtures: ${result.fixtureCount}`);
    console.log(`register occurrences: ${result.registerOccurrences.before} -> ${result.registerOccurrences.after} (${result.registerOccurrences.reductionPct.toFixed(1)}% reduction)`);
    console.log(`median statements/function: ${result.medianStatementsPerFunction.before} -> ${result.medianStatementsPerFunction.after} (${result.medianStatementsPerFunction.reductionPct.toFixed(1)}% reduction)`);
    console.log(`global-access: ${ga.cleanFunctionPctBefore.toFixed(1)}% -> ${ga.cleanFunctionPct.toFixed(1)}% of ${ga.functionCount} functions free of an "in" guard`);
    console.log(`globalThis. occurrences: ${ga.globalThisOccurrences.before} -> ${ga.globalThisOccurrences.after} (${ga.globalThisOccurrences.reductionPct.toFixed(1)}% reduction)`);
    console.log(`call-shape: ${cs.cleanFunctionPctBefore.toFixed(1)}% -> ${cs.cleanFunctionPct.toFixed(1)}% of ${cs.functionCount} functions free of Reflect.apply/Reflect.construct`);
    console.log(`fn-naming: ${fn.namedPctBefore.toFixed(1)}% -> ${fn.namedPct.toFixed(1)}% of ${fn.functionCount} non-global functions named (v94)`);
    console.log(`label-clean: ${lc.labelFreeFunctionPctBefore.toFixed(1)}% -> ${lc.labelFreeFunctionPct.toFixed(1)}% of ${lc.functionCount} functions free of a label`);
  }
}
