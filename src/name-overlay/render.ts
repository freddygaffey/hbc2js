// Rendering — docs/specs/rename-tool-DESIGN-D-overlay.md §7. Overlay names are
// applied ONLY here, as a pure frame-local alpha-rename, and ONLY to register
// idents (`{fn,reg}` ⇒ `rN`) — never a property, string key, or dynamic access
// (those are contract, not bindings). Behaviour cannot change by construction:
// every applied rename is the same guarded, func-boundary-stopping rename
// `var-naming` uses (`renameRegistersInFrame`), and any in-frame collision is
// disambiguated with a deterministic suffix rather than emitting a shadow.
//
// The overlay is applied BEFORE the var-naming astPass (feeding "the same slot
// var-naming already fills", spec §2): the external name enters the frame's decl
// and idents, var-naming's `isRegisterName` filter then leaves it untouched, and
// its `taken` set (freeNames ∪ declaredNames) now contains it so no heuristic
// name for another register can collide with it.

import type { FunctionCfg, ModuleAnalysis } from "../cfg/types.ts";
import type { Stmt } from "../emit/ast.ts";
import { emitModule } from "../emit/index.ts";
import { printProgram } from "../emit/print.ts";
import { freeNames } from "../passes/ast.ts";
import { astPassHook, passHook } from "../passes/index.ts";
import type { AstPassHook, PassPipelineOptions } from "../passes/index.ts";
import { classifyAll, declaredNames } from "../passes/var-naming/match.ts";
import { isRegisterName } from "../passes/ast.ts";
import { renameRegistersInFrame } from "../passes/var-naming/rewrite.ts";
import type { RegisterId } from "./id.ts";
import { regId } from "./id.ts";
import { frameHasRegister } from "./gate.ts";
import type { OverlayStore } from "./store.ts";

export interface CollisionFlag {
  readonly id: RegisterId;
  readonly wanted: string;
  readonly rendered: string;
}

export interface RenderResult {
  readonly code: string;
  readonly collisions: readonly CollisionFlag[];
}

export interface RenderOptions {
  /** Restrict output to one function's body (spec `render --fn N`). */
  readonly fn?: number;
  readonly passes?: PassPipelineOptions;
  readonly strictEnv?: boolean;
  readonly indent?: string;
}

/** Pick the final in-frame name for `wanted`, disambiguating deterministically
 *  against `taken` with `_2`, `_3`, … (spec §7). Never returns a name already
 *  in `taken`; the caller adds the result to `taken`. */
function disambiguate(wanted: string, taken: ReadonlySet<string>): string {
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) {
    const cand = `${wanted}_${n}`;
    if (!taken.has(cand)) return cand;
  }
}

/** Apply the store's active register names to one raw frame body, returning the
 *  overlaid body plus any collisions that needed a suffix. Registers are taken
 *  in ascending numeric order so disambiguation is deterministic. */
export type ActiveNames = ReadonlyMap<number, { readonly name: string }>;

/** The overlay applied to one raw frame body, as a pure alpha-rename: the
 *  overlaid body, the collisions that needed a suffix, and the `rN` -> rendered
 *  ident mapping that was actually applied (the UI's identifier -> `reg:F:R`
 *  join needs that mapping, not just the code). Names come from a plain map, so
 *  a caller can feed either an `OverlayStore` (`applyOverlay` below) or the
 *  project DB's accepted `reg:F:R` names (`ArtifactService.renderFn`). */
export function applyOverlayNames(
  fnIndex: number,
  body: readonly Stmt[],
  names: ActiveNames,
): { readonly body: readonly Stmt[]; readonly collisions: CollisionFlag[]; readonly mapping: ReadonlyMap<string, string> } {
  if (names.size === 0) return { body, collisions: [], mapping: new Map() };
  const taken = new Set<string>([...freeNames(body), ...declaredNames(body)]);
  const mapping = new Map<string, string>();
  const collisions: CollisionFlag[] = [];
  for (const reg of [...names.keys()].sort((a, b) => a - b)) {
    const from = `r${reg}`;
    // Only rename a register that is actually a live binding in this frame —
    // never invent an ident for a pruned/absent register (spec §8).
    if (!frameHasRegister(body, from)) continue;
    // The register's own name is in `declaredNames`/`taken`; it must not block
    // its own target, so exclude it before disambiguating.
    taken.delete(from);
    const wanted = names.get(reg)!.name;
    const rendered = disambiguate(wanted, taken);
    mapping.set(from, rendered);
    taken.add(rendered);
    if (rendered !== wanted) collisions.push({ id: regId(fnIndex, reg), wanted, rendered });
  }
  if (mapping.size === 0) return { body, collisions, mapping };
  return { body: renameRegistersInFrame(body, mapping), collisions, mapping };
}

/** Apply the store's active register names to one raw frame body, returning the
 *  overlaid body plus any collisions that needed a suffix. Registers are taken
 *  in ascending numeric order so disambiguation is deterministic. */
function applyOverlay(fnIndex: number, body: readonly Stmt[], store: OverlayStore): { readonly body: readonly Stmt[]; readonly collisions: CollisionFlag[] } {
  return applyOverlayNames(fnIndex, body, store.activeNamesForFn(fnIndex));
}

/** Render ONE function: the same overlay-then-stage-B-passes composition
 *  `render` runs per frame, but for a single function, so a resident server can
 *  answer "source of fn N with the current names" without re-emitting the whole
 *  module (unusable on a 15k-function bundle). `hook` is a prebuilt
 *  `astPassHook(analysis, passes)` — built once by the caller, since it builds a
 *  whole-module view. Behaviour is untouched by construction: the only edit to
 *  the body is `applyOverlayNames`' guarded alpha-rename. */
export function renderFrame(
  hook: AstPassHook,
  node: Stmt,
  cfg: FunctionCfg,
  names: ActiveNames,
  opts: { readonly indent?: string } = {},
): { readonly code: string; readonly collisions: readonly CollisionFlag[]; readonly mapping: ReadonlyMap<string, string> } {
  if (node.k !== "func") return { code: "", collisions: [], mapping: new Map() };
  const applied = applyOverlayNames(cfg.functionIndex, node.body, names);
  const out = hook({ ...node, body: applied.body }, cfg);
  return { code: printProgram([out.fn], { indent: opts.indent ?? "  " }), collisions: applied.collisions, mapping: applied.mapping };
}

/** The ident each nameable register of `body` ends up as in the rendered
 *  source: the overlay's own (collision-suffixed) name where one is set,
 *  otherwise var-naming's heuristic choice when that pass is enabled, otherwise
 *  `rN`. Best effort for the heuristic half — it classifies the same raw frame
 *  body var-naming classifies, so it agrees whenever no earlier stage-B pass
 *  rewrote the register's defs (docs/UI.md). */
export function renderedRegisterNames(fnIndex: number, body: readonly Stmt[], names: ActiveNames, opts: { readonly varNaming?: boolean } = {}): ReadonlyMap<number, string> {
  const applied = applyOverlayNames(fnIndex, body, names);
  const out = new Map<number, string>();
  for (const [from, to] of applied.mapping) out.set(Number(from.slice(1)), to);
  if (opts.varNaming === true) {
    for (const c of classifyAll(applied.body)) {
      if (!c.result.ok || !isRegisterName(c.name)) continue;
      out.set(Number(c.name.slice(1)), c.result.to);
    }
  }
  return out;
}

/** Render the bundle (or one function) with the overlay applied. Composes with
 *  var-naming: overlaid registers keep their external name; the rest are named
 *  by the heuristic as usual. */
export function render(analysis: ModuleAnalysis, store: OverlayStore, opts: RenderOptions = {}): RenderResult {
  const strictEnv = opts.strictEnv ?? true;
  const realHook = astPassHook(analysis, opts.passes);
  const bodies = new Map<number, Stmt>();
  const collisions: CollisionFlag[] = [];
  const result = emitModule(analysis, {
    provenanceComments: false,
    strictEnv,
    ...(opts.indent !== undefined ? { indent: opts.indent } : {}),
    passes: passHook(analysis, opts.passes),
    astPasses: (fn, cfg) => {
      if (fn.k !== "func") return realHook(fn, cfg);
      const applied = applyOverlay(cfg.functionIndex, fn.body, store);
      collisions.push(...applied.collisions);
      const out = realHook({ ...fn, body: applied.body }, cfg);
      if (out.fn.k === "func") bodies.set(cfg.functionIndex, out.fn);
      return out;
    },
  });
  if (opts.fn !== undefined) {
    const body = bodies.get(opts.fn);
    const code = body === undefined ? `// no such function ${opts.fn}\n` : printProgram([body], { indent: opts.indent ?? "  " });
    return { code, collisions: collisions.filter((c) => c.id.fn === opts.fn) };
  }
  return { code: result.code, collisions };
}
