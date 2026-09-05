// The pass pipeline as src/decompile.ts wires it: runs after the structurer's
// tree IR and before emit (spec 07 §1), for every function.
import type { Diagnostic } from "../errors.ts";
import type { FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import type { LayoutClass } from "../parse/types.ts";
import type { Stmt, StructuredFunction } from "../structure/ir.ts";
import type { Stmt as AstStmt } from "../emit/ast.ts";
import { applyPasses } from "./driver.ts";
import type { ApplyResult } from "./driver.ts";
import { applyAstPasses, identUses, identUsesMany, isRegisterName } from "./ast.ts";
import type { Expr, Param } from "../emit/ast.ts";
import type { AstApplyResult } from "./ast.ts";
import { enabledPasses, REGISTRY } from "./registry.ts";
import type { EnabledPassOptions } from "./registry.ts";
import { buildModuleView } from "./tree.ts";
import type { ModuleView } from "./tree.ts";
import type { Pass } from "./types.ts";

export { applyPasses } from "./driver.ts";
export { applyAstPasses } from "./ast.ts";
export { enabledPasses, REGISTRY } from "./registry.ts";
export { buildModuleView } from "./tree.ts";
export type { ModuleView } from "./tree.ts";
export type { Pass, PassContext, Match, CheckResult, AppliedRecord, AbandonedRecord } from "./types.ts";

export interface PassPipelineOptions extends EnabledPassOptions {
  /** `--passes=none`: run nothing, reproduce the M4 baseline byte for byte. */
  readonly none?: boolean;
}

export type PassHook = (fn: StructuredFunction, cfg: FunctionCfg) => { readonly fn: StructuredFunction; readonly diagnostics: readonly Diagnostic[] };

/** F7: drop rungs this module's (version, layout) hasn't been measured against. */
function filterByVersion<T extends Pass>(passes: readonly T[], hbcVersion: number, layoutClass: LayoutClass, diagnostic: (d: Diagnostic) => void): readonly T[] {
  const out: T[] = [];
  for (const p of passes) {
    if (p.versions !== undefined && !p.versions(hbcVersion, layoutClass)) {
      diagnostic({ severity: "info", code: "W_PASS_VERSION_SKIP", message: `pass ${p.name} skipped(hbc${hbcVersion}/${layoutClass}): not measured for this (version, layout)`, context: {} });
      continue;
    }
    out.push(p);
  }
  return out;
}

export function runPasses(analysis: ModuleAnalysis, fn: StructuredFunction, cfg: FunctionCfg, opts: PassPipelineOptions = {}, moduleView?: ModuleView): ApplyResult {
  const mod = analysis.module;
  const diagnostics: Diagnostic[] = [];
  const base = opts.none === true ? [] : (enabledPasses({ ...opts, stage: "A" }) as readonly Pass<Stmt>[]);
  const passes = filterByVersion(base, mod.header.version, mod.layout.layoutClass, (d) => diagnostics.push(d));
  const result = applyPasses(fn, passes, {
    analysis,
    functionIndex: cfg.functionIndex,
    cfg,
    hbcVersion: mod.header.version,
    layoutClass: mod.layout.layoutClass,
    module: moduleView ?? buildModuleView(analysis),
    diagnostic: (d) => diagnostics.push(d),
  });
  return { ...result, diagnostics: [...diagnostics, ...result.diagnostics] };
}

/** The hook `EmitOptions.passes` takes. Builds `ctx.module` (F6) once per module. */
export function passHook(analysis: ModuleAnalysis, opts: PassPipelineOptions = {}): PassHook {
  const moduleView = buildModuleView(analysis);
  return (fn, cfg) => {
    const r = runPasses(analysis, fn, cfg, opts, moduleView);
    return { fn: r.fn, diagnostics: r.diagnostics };
  };
}

export type AstPassHook = (fn: AstStmt, cfg: FunctionCfg) => { readonly fn: AstStmt; readonly diagnostics: readonly Diagnostic[] };

/**
 * F10: after the stage-B pipeline has fired at least one site in a function,
 * prune that function's leading `decl let r0…rN` down to the `rN` still
 * occurring as an `ident` in its (rewritten) body — a nested `func` body
 * declares its own frame, so a register name occurring only there does not
 * keep this function's decl entry alive (`identUses`'s `nested` count is
 * exactly the thing to exclude). Drop the `decl` entirely when none remain.
 * A finaliser, not an `expr-rebuild` rule, because `global-access`/
 * `call-shape` (batch 2) kill registers *after* `expr-rebuild` reaches its
 * fixed point. Gated on `applied.length > 0` so `--passes=none` — and any
 * function no stage-B rung touched — stays byte-identical.
 *
 * The register decl is recognised as the `let` decl that still declares
 * *some* `rN` — not *every*: `var-naming` (spec 07) renames entries of this
 * very decl in place, so after it runs the decl is mixed (`let r0, arr, r16`)
 * and an `every` test would leave every dead `rN` behind. `some` loses
 * nothing: a name `var-naming` produced always has a write (it was live), so
 * anything this finaliser could prune is still an `rN`, and a decl holding
 * one is found.
 *
 * `params` (F15, docs/specs/passes/15-default-params.md §3): a register can
 * now be live *only* inside a parameter's own default (`default-params`
 * moves its whole guarded body there, deleting every occurrence from
 * `body`) — `identUses(withoutDecl, n)` alone would then see zero uses and
 * prune a `let` a param's `init` still reads, turning that read into an
 * accidental global in non-strict code the moment the function is called
 * (docs/BUGS.md's default-params-prune-leak row). Each `init` is checked
 * the same way `identUses` checks a statement: wrapped as a one-statement
 * `expr` list so the very same reads/writes counter answers it.
 */
export function pruneRegisterDecls(body: readonly AstStmt[], params: readonly Param[] = []): readonly AstStmt[] {
  const idx = body.findIndex((s): s is AstStmt & { readonly k: "decl" } => s.k === "decl" && s.kind === "let" && s.names.length > 0 && s.names.some(isRegisterName));
  if (idx < 0) return body;
  const decl = body[idx] as AstStmt & { readonly k: "decl" };
  const withoutDecl = [...body.slice(0, idx), ...body.slice(idx + 1)];
  const paramInits: AstStmt[] = params.filter((p) => p.init !== undefined).map((p) => ({ k: "expr", expr: p.init! }));
  const live = decl.names.filter((n) => {
    const u = identUses(withoutDecl, n);
    if (u.reads + u.writes > 0) return true;
    return paramInits.length > 0 && identUses(paramInits, n).reads + identUses(paramInits, n).writes > 0;
  });
  if (live.length === decl.names.length) return body;
  if (live.length === 0) return withoutDecl;
  return [...body.slice(0, idx), { ...decl, names: live }, ...body.slice(idx + 1)];
}

/**
 * F26 (docs/BUGS.md 2026-09-01 "register prologue" row): after F10 has
 * pruned the dead names out of the leading `decl let r0…rN`, turn a
 * surviving register's *first* top-level definition into its declaration —
 * `let r3 = e;` in place of the top-level `r3 = e;` — whenever nothing
 * before that statement, anywhere in the body (nested blocks included), so
 * much as reads or writes `r3`. Left in the leading `decl`, uninitialised,
 * otherwise: a register some path reads before writing (the read must still
 * see `undefined`, never a TDZ error) or whose first write is itself nested
 * inside an `if`/loop/`try`/`switch` (hoisting there would either shrink its
 * scope past a later top-level read or, inside a loop, mint a fresh binding
 * every iteration — neither is this finaliser's job; `docs/BUGS.md` names
 * the nearest-common-dominator placement as future work, not a soundness
 * requirement).
 *
 * Why only the top level is safe to rewrite in place: every statement in
 * the function's own top-level list runs in program order whenever it runs
 * at all (no nesting to skip over), so "nothing at an earlier top-level
 * index reads or writes the name" is exactly "this definition dominates
 * every other occurrence" for this list. A register's own initialising
 * value expression is also checked (`identUses([s], name)`, which counts
 * the assign's target and its value separately) — a self-reference
 * (`r3 = r3 + 1`) means this is not a fresh definition and is left alone,
 * matching `expressionOnlyCheck`'s existing "read before its first def" DFA.
 *
 * A register is never referenced from inside a nested `func` body (captures
 * always cross frames through an env slot — `IdentUses.nested`'s doc), so a
 * closure can never observe which representation (hoisted vs. inline) an
 * outer register's declaration took.
 *
 * Gated on `applied.length > 0`, same as `pruneRegisterDecls`, so
 * `--passes=none` (PL-05) and any function no stage-B rung touched are
 * untouched.
 */
export function hoistRegisterInits(body: readonly AstStmt[]): readonly AstStmt[] {
  const idx = body.findIndex((s): s is AstStmt & { readonly k: "decl" } => s.k === "decl" && s.kind === "let" && s.names.length > 0 && s.names.some(isRegisterName));
  if (idx < 0) return body;
  const decl = body[idx] as AstStmt & { readonly k: "decl" };
  // Every entry of *this* decl is register-provenance — `pruneRegisterDecls`
  // (F10) identifies it the same way ("some `rN`", not "every": `var-naming`/
  // the name-overlay (`src/name-overlay/render.ts`) rename entries of this
  // very decl in place before this finaliser ever runs) — so a name here is
  // a hoist candidate whether it still reads as `rN` or already carries a
  // friendly/overlay name. Gating on `isRegisterName` here instead would
  // make hoisting depend on which label a register happens to carry: the
  // overlay's `render is a pure textual alpha-rename` invariant (spec
  // rename-tool-DESIGN-D §11.3) requires naming a register to never move a
  // statement, which a name-keyed hoist decision would violate the moment a
  // renamed register crossed the hoist threshold that its raw `rN` form did
  // not (or vice versa).
  const regNames = decl.names;

  const seen = new Set<string>();
  const hoistAt = new Map<number, string>();
  for (let i = idx + 1; i < body.length; i++) {
    const s = body[i]!;
    const counts = identUsesMany([s], regNames);
    let hoistedHere: string | null = null;
    if (s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" && !seen.has(s.expr.target.name)) {
      const name = s.expr.target.name;
      const u = counts.get(name);
      // Exactly one write (the target itself) and no read anywhere in this
      // statement (including its own value expression) — a fresh, non-self-
      // referential first definition.
      if (u !== undefined && u.reads === 0 && u.writes === 1) {
        hoistAt.set(i, name);
        hoistedHere = name;
      }
    }
    for (const [n, u] of counts) {
      if (seen.has(n) || n === hoistedHere) continue;
      if (u.reads + u.writes > 0) seen.add(n);
    }
    if (hoistedHere !== null) seen.add(hoistedHere);
  }
  if (hoistAt.size === 0) return body;

  const hoistedNames = new Set(hoistAt.values());
  const remaining = decl.names.filter((n) => !hoistedNames.has(n));
  const out: AstStmt[] = [];
  for (let i = 0; i < body.length; i++) {
    if (i === idx) {
      if (remaining.length > 0) out.push({ ...decl, names: remaining });
      continue;
    }
    const name = hoistAt.get(i);
    if (name !== undefined) {
      const s = body[i] as AstStmt & { readonly k: "expr" };
      const value = (s.expr as { readonly k: "assign"; readonly value: Expr }).value;
      out.push(s.origin !== undefined ? { k: "init", kind: "let", name, value, origin: s.origin } : { k: "init", kind: "let", name, value });
      continue;
    }
    out.push(body[i]!);
  }
  return out;
}

/**
 * The hook `EmitOptions.astPasses` takes (F1): stage B, run by `emitOne`
 * right after `emitFunction` returns. `fn` is always the `k:"func"` node
 * `emitFunction` produced; every other kind passes through untouched.
 */
export function astPassHook(analysis: ModuleAnalysis, opts: PassPipelineOptions = {}, onResult?: (functionIndex: number, r: AstApplyResult) => void): AstPassHook {
  const moduleView = buildModuleView(analysis);
  const mod = analysis.module;
  return (fn, cfg) => {
    if (fn.k !== "func" || opts.none === true) return { fn, diagnostics: [] };
    const diagnostics: Diagnostic[] = [];
    const base = enabledPasses({ ...opts, stage: "B" }) as readonly Pass<readonly AstStmt[]>[];
    const passes = filterByVersion(base, mod.header.version, mod.layout.layoutClass, (d) => diagnostics.push(d));
    // F23-1: the emitted parameter list is simple iff no param carries a
    // default (`init`, F15) or is a rest parameter (F17) — `Param` has no
    // destructuring-pattern field, so those two are the whole condition.
    const fnParams = { names: fn.params.map((p) => p.name), simple: fn.params.every((p) => p.init === undefined && p.rest !== true) };
    // F24-4: the function-table name and the `prohibitInvoke` role, which
    // together are the version-native confirmation that a `CreateBaseClass`
    // operand really is a class constructor (spec 24 section 2).
    const functionMeta = (fnIdx: number): { readonly name: string; readonly role: "ctor" | "nc" | "plain" } | null => {
      const header = mod.functions[fnIdx];
      if (header === undefined) return null;
      return { name: header.name, role: header.header.flags.prohibitInvoke === "call" ? "ctor" : header.header.flags.prohibitInvoke === "construct" ? "nc" : "plain" };
    };
    const r: AstApplyResult = applyAstPasses(fn.body, passes, {
      analysis,
      functionIndex: cfg.functionIndex,
      cfg,
      hbcVersion: mod.header.version,
      layoutClass: mod.layout.layoutClass,
      module: moduleView,
      fnParams,
      functionMeta,
      diagnostic: (d) => diagnostics.push(d),
    });
    onResult?.(cfg.functionIndex, r);
    const body = r.applied.length > 0 ? hoistRegisterInits(pruneRegisterDecls(r.body, fn.params)) : r.body;
    return { fn: { ...fn, body }, diagnostics: [...diagnostics, ...r.diagnostics] };
  };
}

/** `--list-passes`. */
export function describePasses(): string {
  return REGISTRY.map((p) => `${p.name}\tstage ${p.stage}\tcatalogue rows ${p.catalogue.join(",")}\tfixtures ${p.targets.join(",")}${p.after ? `\tafter ${p.after.join(",")}` : ""}`).join("\n");
}
