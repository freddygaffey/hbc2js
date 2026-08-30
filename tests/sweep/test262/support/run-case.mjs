// tests/sweep/test262/support/run-case.mjs — shared execution semantics for a
// harvested test262 case file.
//
// Why not `node <file>`: this repo's package.json sets "type": "module", so a
// plain .js under the repo tree would run as an ES module (implicitly
// strict, module-scope `this` is undefined, `var`/`function` don't leak to
// globalThis) — none of which is what test262's sloppy/strict *Script*
// semantics mean. And even a CommonJS .cjs file run directly has the wrong
// top-level `this` (module.exports, not the global object) and the wrong
// var-hoisting target (the module wrapper's function scope, not globalThis) —
// both of which real test262 cases depend on (e.g. `var global = this;` at
// top level, or checking a leaked `var` on `globalThis`).
//
// `vm.Script` + `vm.createContext` gives a fresh, per-call global Realm whose
// top-level `this` and `var`/function-declaration hoisting match the actual
// ECMAScript "Script" grammar goal, in both sloppy and strict mode (strict
// *script* code's top-level `this` is still the global object — only
// strict *function calls* made without a receiver differ from sloppy ones,
// per the spec's OrdinaryCallBindThis). Compilation and execution are kept
// as two separate try/catches so a `negative: {phase: parse, ...}` test can
// be told apart from a `negative: {phase: runtime, ...}` one.
import vm from "node:vm";

/**
 * @param {string} source
 * @returns {{ phase: "none" | "parse" | "runtime", errorName?: string, errorMessage?: string }}
 */
export function runCase(source) {
  const sandbox = { console };
  vm.createContext(sandbox);
  let script;
  try {
    script = new vm.Script(source, { filename: "test262-case.js" });
  } catch (e) {
    return { phase: "parse", errorName: ctorName(e), errorMessage: message(e) };
  }
  try {
    script.runInContext(sandbox, { timeout: 5000 });
  } catch (e) {
    return { phase: "runtime", errorName: ctorName(e), errorMessage: message(e) };
  }
  return { phase: "none" };
}

/** @param {{negative: {phase: string, type: string} | null}} meta
 *  @param {ReturnType<typeof runCase>} result */
export function matchesExpectation(negative, result) {
  if (!negative) return result.phase === "none";
  if (negative.phase === "parse") return result.phase === "parse" && result.errorName === negative.type;
  // test262 also defines phase "resolution" (module-graph errors only —
  // module: tests are excluded upstream, so this never applies here).
  return result.phase === "runtime" && result.errorName === negative.type;
}

function ctorName(e) {
  return e && e.constructor ? e.constructor.name : typeof e;
}
function message(e) {
  return e && e.message !== undefined ? String(e.message) : String(e);
}
