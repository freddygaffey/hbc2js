// The reuse gate for external names — docs/specs/rename-tool-DESIGN-D-overlay.md
// §6, resolved fork 1. An externally supplied name passes through var-naming's
// EXISTING reuse gate (`classifySite`) rather than a parallel one; `--override`
// forces past a genuine safety refusal, stamped `overridden` + forced low
// confidence, so every override stays visible and searchable.

import type { ModuleAnalysis } from "../cfg/types.ts";
import type { Stmt } from "../emit/ast.ts";
import { identUses, isSafeIdentifier } from "../passes/ast.ts";
import { classifySite, EMITTER_NAME_CLASS_RE, IDENT_RE } from "../passes/var-naming/match.ts";
import type { BindingId } from "./id.ts";
import type { Gate } from "./store.ts";

export type GateRefusal =
  | "unsupported-binding" // env/fn id — deferred to closure-naming/fn-naming (spec §8)
  | "no-function" // no such function index in this bundle
  | "no-binding" // register has no live ident in its frame (property/dead — §8, §11.8)
  | "invalid-name" // reserved word / emitter-name-class / unsafe ident (never overridable)
  | "reuse-conflict" // defs span more than one role (spec §6; overridable)
  | "globalthis-alias"; // the register aliases globalThis (overridable)

export type GateResult = { readonly ok: true; readonly gate: Gate } | { readonly ok: false; readonly reason: GateRefusal; readonly overridable: boolean };

/** Reasons `classifySite` returns that are heuristic-SUPPLY failures, not
 *  safety refusals: the external source exists precisely to supply the name the
 *  heuristic could not invent, so an external name is never blocked by them. */
const SUPPLY_FAILURES = new Set(["no-heuristic", "pool-exhausted", "dedup-exhausted"]);

/** True when register `rN` occurs as a live ident (read or write) in `body`'s
 *  own frame. A `{fn,reg}` with no live occurrence is not a nameable binding —
 *  it was pruned, or (spec §8) resolves to a property/string key the overlay
 *  must never name. */
export function frameHasRegister(body: readonly Stmt[], rN: string): boolean {
  const u = identUses(body, rN);
  return u.reads + u.writes > 0;
}

/** Evaluate the gate for naming `id` `name` against `body` (the raw `rN` frame
 *  body, from `rawFrameBodies`). Pure — no bytecode read here. */
export function gateForFrame(body: readonly Stmt[] | undefined, id: BindingId, name: string, override: boolean): GateResult {
  if (id.kind !== "reg") return { ok: false, reason: "unsupported-binding", overridable: false };
  if (body === undefined) return { ok: false, reason: "no-function", overridable: false };

  // Name validity is unconditional — an override can never emit invalid JS.
  if (!IDENT_RE.test(name) || !isSafeIdentifier(name) || EMITTER_NAME_CLASS_RE.test(name)) {
    return { ok: false, reason: "invalid-name", overridable: false };
  }

  const from = `r${id.reg}`;
  if (!frameHasRegister(body, from)) return { ok: false, reason: "no-binding", overridable: false };

  const verdict = classifySite(body, from);
  if (verdict.ok) return { ok: true, gate: "passed" };
  if (SUPPLY_FAILURES.has(verdict.reason)) return { ok: true, gate: "passed" };
  // A genuine safety refusal (`reuse-conflict` / `globalthis-alias`, plus the
  // name-shape reasons classifySite can also emit which we already covered).
  const reason: GateRefusal = verdict.reason === "globalthis-alias" ? "globalthis-alias" : "reuse-conflict";
  if (override) return { ok: true, gate: "overridden" };
  return { ok: false, reason, overridable: true };
}

/** Convenience for callers holding the analysis and a prebuilt raw-frame map. */
export function gate(bodies: Map<number, readonly Stmt[]>, _analysis: ModuleAnalysis, id: BindingId, name: string, override: boolean): GateResult {
  return gateForFrame(id.kind === "reg" ? bodies.get(id.fn) : undefined, id, name, override);
}
